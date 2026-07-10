/**
 * account_settings table helpers.
 *
 * The table stores arbitrary key/value pairs keyed by (line_account_id, key).
 * Each setting is a JSON-encoded string so the column type never changes.
 */

/**
 * Retrieve a raw setting value (JSON string) for an account.
 * Returns null when the key is not set.
 */
export async function getAccountSetting(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = ?`)
    .bind(accountId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Upsert a raw setting value (JSON string) for an account.
 */
export async function setAccountSetting(
  db: D1Database,
  accountId: string,
  key: string,
  value: string,
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000)
    .toISOString()
    .replace('Z', '+09:00');

  await db
    .prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .bind(id, accountId, key, value, now, now, value, now)
    .run();
}

// ── link_base_url ─────────────────────────────────────────────────────────────

const LINK_BASE_URL_KEY = 'link_base_url';
const OPENAI_BASE_URL_KEY = 'openai_base_url';
const OPENAI_API_KEY_KEY = 'openai_api_key';
const OPENAI_MODEL_KEY = 'openai_model';

/**
 * Get the configured short-link base URL for an account.
 * Returns null when not set (caller should fall back to WORKER_URL/r).
 * The stored value has no trailing slash.
 */
export async function getLinkBaseUrl(
  db: D1Database,
  accountId: string,
): Promise<string | null> {
  const raw = await getAccountSetting(db, accountId, LINK_BASE_URL_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return null;
  }
}

/**
 * Validate and persist a link_base_url value for an account.
 *
 * Rules:
 *  - Empty string clears the setting (returns without storing).
 *  - Must start with "https://".
 *  - Trailing slash is stripped before saving.
 *
 * Throws a descriptive Error on validation failure.
 */
export async function setLinkBaseUrl(
  db: D1Database,
  accountId: string,
  value: string,
): Promise<void> {
  const trimmed = value.trim();

  if (trimmed === '') {
    // Clear the setting.
    await db
      .prepare(
        `DELETE FROM account_settings WHERE line_account_id = ? AND key = ?`,
      )
      .bind(accountId, LINK_BASE_URL_KEY)
      .run();
    return;
  }

  if (!trimmed.startsWith('https://')) {
    throw new Error('link_base_url must start with https://');
  }

  const normalized = trimmed.replace(/\/$/, '');
  await setAccountSetting(db, accountId, LINK_BASE_URL_KEY, JSON.stringify(normalized));
}

async function getStringSetting(
  db: D1Database,
  accountId: string,
  key: string,
): Promise<string | null> {
  const raw = await getAccountSetting(db, accountId, key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

async function setOrDeleteStringSetting(
  db: D1Database,
  accountId: string,
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await db
      .prepare(
        `DELETE FROM account_settings WHERE line_account_id = ? AND key = ?`,
      )
      .bind(accountId, key)
      .run();
    return;
  }
  await setAccountSetting(db, accountId, key, JSON.stringify(value));
}

export interface OpenAIConnectionSettings {
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
}

export async function getOpenAIConnectionSettings(
  db: D1Database,
  accountId: string,
): Promise<OpenAIConnectionSettings> {
  const [baseUrl, model, apiKey] = await Promise.all([
    getStringSetting(db, accountId, OPENAI_BASE_URL_KEY),
    getStringSetting(db, accountId, OPENAI_MODEL_KEY),
    getStringSetting(db, accountId, OPENAI_API_KEY_KEY),
  ]);
  return { baseUrl, model, apiKey };
}

export async function setOpenAIConnectionSettings(
  db: D1Database,
  accountId: string,
  input: {
    baseUrl?: string | null;
    model?: string | null;
    apiKey?: string | null;
  },
): Promise<void> {
  const tasks: Promise<void>[] = [];
  if ('baseUrl' in input) {
    tasks.push(setOrDeleteStringSetting(db, accountId, OPENAI_BASE_URL_KEY, input.baseUrl ?? null));
  }
  if ('model' in input) {
    tasks.push(setOrDeleteStringSetting(db, accountId, OPENAI_MODEL_KEY, input.model ?? null));
  }
  if ('apiKey' in input) {
    tasks.push(setOrDeleteStringSetting(db, accountId, OPENAI_API_KEY_KEY, input.apiKey ?? null));
  }
  await Promise.all(tasks);
}
