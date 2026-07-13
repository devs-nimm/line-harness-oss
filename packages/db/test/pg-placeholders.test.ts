import { describe, expect, it } from 'vitest';
import { convertPlaceholders } from '../src/pg/adapter';

describe('convertPlaceholders', () => {
  it('rewrites ? to $1..$n in order', () => {
    expect(convertPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe(
      'SELECT * FROM t WHERE a = $1 AND b = $2',
    );
  });

  it('leaves ? inside single-quoted strings untouched', () => {
    expect(convertPlaceholders(`SELECT * FROM t WHERE url = 'http://x?y=1' AND id = ?`)).toBe(
      `SELECT * FROM t WHERE url = 'http://x?y=1' AND id = $1`,
    );
  });

  it('handles escaped quotes inside strings', () => {
    expect(convertPlaceholders(`SELECT 'it''s?' , ?`)).toBe(`SELECT 'it''s?' , $1`);
  });

  it('leaves ? inside double-quoted identifiers untouched', () => {
    expect(convertPlaceholders(`SELECT "weird?col" FROM t WHERE id = ?`)).toBe(
      `SELECT "weird?col" FROM t WHERE id = $1`,
    );
  });

  it('ignores ? in line comments and block comments', () => {
    expect(convertPlaceholders('SELECT ? -- what?\nFROM t /* really? */ WHERE b = ?')).toBe(
      'SELECT $1 -- what?\nFROM t /* really? */ WHERE b = $2',
    );
  });

  it('handles a realistic multi-line statement', () => {
    const sql = `INSERT INTO chats (id, friend_id, status)
       VALUES (?, ?, 'open') ON CONFLICT DO NOTHING`;
    expect(convertPlaceholders(sql)).toBe(`INSERT INTO chats (id, friend_id, status)
       VALUES ($1, $2, 'open') ON CONFLICT DO NOTHING`);
  });
});
