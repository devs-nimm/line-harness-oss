-- SQLite → PostgreSQL compatibility functions.
--
-- The application SQL was written for Cloudflare D1 (SQLite) and uses
-- strftime()/julianday()/datetime()/date() with SQLite semantics. Rather than
-- rewriting every query, these functions reproduce the exact SQLite behavior
-- the codebase relies on (see packages/db/README notes in MIN-257):
--
--   * 'now' means the current time.
--   * A timestamp string with a Z / ±HH:MM suffix is an absolute instant.
--   * A naive timestamp string is interpreted as UTC (SQLite's rule).
--   * Modifiers: interval offsets ('+9 hours', '-30 days', ...) and
--     'start of day/month/year'. Unsupported modifiers raise an error
--     instead of silently returning NULL, so drift is caught in tests.
--   * All text output is rendered as UTC wall-clock time, matching SQLite,
--     which does all datetime math in UTC.

CREATE OR REPLACE FUNCTION sqlite_ts(value text, mods text[] DEFAULT '{}')
RETURNS timestamptz
LANGUAGE plpgsql
AS $$
DECLARE
  ts timestamptz;
  m text;
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;
  IF lower(trim(value)) = 'now' THEN
    ts := now();
  ELSIF trim(value) ~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$' THEN
    ts := trim(value)::timestamptz;
  ELSE
    -- Naive timestamp: SQLite treats it as UTC.
    ts := trim(value)::timestamp AT TIME ZONE 'UTC';
  END IF;

  FOREACH m IN ARRAY mods LOOP
    m := lower(trim(m));
    IF m ~ '^[+-]?[0-9]' THEN
      ts := ts + m::interval;
    ELSIF m = 'start of day' THEN
      ts := date_trunc('day', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    ELSIF m = 'start of month' THEN
      ts := date_trunc('month', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    ELSIF m = 'start of year' THEN
      ts := date_trunc('year', ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    ELSE
      RAISE EXCEPTION 'sqlite_ts: unsupported datetime modifier %', m;
    END IF;
  END LOOP;

  RETURN ts;
END
$$;

-- Translate a SQLite strftime() format string to a to_char() pattern.
-- Non-token characters are double-quoted so to_char() treats them literally.
CREATE OR REPLACE FUNCTION sqlite_strftime_pattern(fmt text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  out text := '';
  i int := 1;
  c text;
  tok text;
BEGIN
  WHILE i <= length(fmt) LOOP
    c := substr(fmt, i, 1);
    IF c = '%' AND i < length(fmt) THEN
      tok := substr(fmt, i + 1, 1);
      out := out || CASE tok
        WHEN 'Y' THEN 'YYYY'
        WHEN 'm' THEN 'MM'
        WHEN 'd' THEN 'DD'
        WHEN 'H' THEN 'HH24'
        WHEN 'M' THEN 'MI'
        WHEN 'S' THEN 'SS'
        WHEN 'f' THEN 'SS.MS'
        WHEN 'j' THEN 'DDD'
        WHEN '%' THEN '"%"'
        ELSE NULL
      END;
      IF out IS NULL THEN
        RAISE EXCEPTION 'sqlite_strftime_pattern: unsupported token %%%', tok;
      END IF;
      i := i + 2;
    ELSE
      out := out || '"' || replace(c, '"', '') || '"';
      i := i + 1;
    END IF;
  END LOOP;
  RETURN out;
END
$$;

CREATE OR REPLACE FUNCTION sqlite_strftime(fmt text, value text, mods text[])
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  ts timestamptz := sqlite_ts(value, mods);
BEGIN
  IF ts IS NULL THEN
    RETURN NULL;
  END IF;
  IF fmt = '%s' THEN
    RETURN floor(extract(epoch FROM ts))::bigint::text;
  END IF;
  RETURN to_char(ts AT TIME ZONE 'UTC', sqlite_strftime_pattern(fmt));
END
$$;

CREATE OR REPLACE FUNCTION strftime(fmt text, value text)
RETURNS text LANGUAGE sql AS $$ SELECT sqlite_strftime(fmt, value, '{}') $$;

CREATE OR REPLACE FUNCTION strftime(fmt text, value text, m1 text)
RETURNS text LANGUAGE sql AS $$ SELECT sqlite_strftime(fmt, value, ARRAY[m1]) $$;

CREATE OR REPLACE FUNCTION strftime(fmt text, value text, m1 text, m2 text)
RETURNS text LANGUAGE sql AS $$ SELECT sqlite_strftime(fmt, value, ARRAY[m1, m2]) $$;

CREATE OR REPLACE FUNCTION julianday(value text)
RETURNS double precision
LANGUAGE sql AS $$
  SELECT extract(epoch FROM sqlite_ts(value, '{}')) / 86400.0 + 2440587.5
$$;

CREATE OR REPLACE FUNCTION julianday(value text, m1 text)
RETURNS double precision
LANGUAGE sql AS $$
  SELECT extract(epoch FROM sqlite_ts(value, ARRAY[m1])) / 86400.0 + 2440587.5
$$;

CREATE OR REPLACE FUNCTION julianday(value text, m1 text, m2 text)
RETURNS double precision
LANGUAGE sql AS $$
  SELECT extract(epoch FROM sqlite_ts(value, ARRAY[m1, m2])) / 86400.0 + 2440587.5
$$;

CREATE OR REPLACE FUNCTION datetime(value text)
RETURNS text LANGUAGE sql AS $$
  SELECT to_char(sqlite_ts(value, '{}') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
$$;

CREATE OR REPLACE FUNCTION datetime(value text, m1 text)
RETURNS text LANGUAGE sql AS $$
  SELECT to_char(sqlite_ts(value, ARRAY[m1]) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
$$;

-- Only the two-argument form is defined: a one-argument date(text) would be
-- ambiguous with pg_catalog's date() cast for unknown-typed literals.
CREATE OR REPLACE FUNCTION date(value text, m1 text)
RETURNS text LANGUAGE sql AS $$
  SELECT to_char(sqlite_ts(value, ARRAY[m1]) AT TIME ZONE 'UTC', 'YYYY-MM-DD')
$$;

-- SQLite JSON functions used by the schema (CHECK constraints) and queries.

CREATE OR REPLACE FUNCTION json_valid(value text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF value IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM value::jsonb;
  RETURN true;
EXCEPTION WHEN others THEN
  RETURN false;
END
$$;

-- SQLite's json_each() over a text column, restricted to the columns the
-- codebase uses (key, value). Handles both JSON arrays and objects.
CREATE OR REPLACE FUNCTION json_each(doc text)
RETURNS TABLE(key text, value text)
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF doc IS NULL OR NOT json_valid(doc) THEN
    RETURN;
  END IF;
  IF jsonb_typeof(doc::jsonb) = 'array' THEN
    RETURN QUERY
      SELECT (t.ord - 1)::text, t.val
      FROM jsonb_array_elements_text(doc::jsonb) WITH ORDINALITY AS t(val, ord);
  ELSIF jsonb_typeof(doc::jsonb) = 'object' THEN
    RETURN QUERY SELECT t.k, t.v FROM jsonb_each_text(doc::jsonb) AS t(k, v);
  END IF;
END
$$;

-- SQLite's json_extract() for simple '$.a.b' object paths (the only form the
-- codebase uses). Scalars come back as unquoted text, like SQLite.
CREATE OR REPLACE FUNCTION json_extract(doc text, path text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF doc IS NULL OR path IS NULL OR NOT json_valid(doc) THEN
    RETURN NULL;
  END IF;
  IF path !~ '^\$\.' THEN
    RAISE EXCEPTION 'json_extract: unsupported path %', path;
  END IF;
  RETURN doc::jsonb #>> string_to_array(substr(path, 3), '.');
END
$$;
