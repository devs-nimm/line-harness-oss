import { Hono } from 'hono';
import {
  getLinkBaseUrl,
  setLinkBaseUrl,
  getOpenAIConnectionSettings,
  setOpenAIConnectionSettings,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { getEffectiveOpenAISettings } from '../lib/openai-settings.js';

const accountSettings = new Hono<Env>();
const GLOBAL_ACCOUNT_ID = '__global__';

// GET /api/account-settings/test-recipients?accountId=xxx
accountSettings.get('/api/account-settings/test-recipients', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const row = await c.env.DB.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'test_recipients'`
  ).bind(accountId).first<{ value: string }>();

  const friendIds: string[] = row ? JSON.parse(row.value) : [];

  if (friendIds.length === 0) {
    return c.json({ success: true, data: [] });
  }
  const placeholders = friendIds.map(() => '?').join(',');
  const friends = await c.env.DB.prepare(
    `SELECT id, display_name, picture_url FROM friends WHERE id IN (${placeholders})`
  ).bind(...friendIds).all<{ id: string; display_name: string; picture_url: string | null }>();

  return c.json({
    success: true,
    data: friends.results.map(f => ({
      id: f.id,
      displayName: f.display_name,
      pictureUrl: f.picture_url,
    })),
  });
});

// PUT /api/account-settings/test-recipients
accountSettings.put('/api/account-settings/test-recipients', async (c) => {
  const body = await c.req.json<{ accountId: string; friendIds: string[] }>();
  if (!body.accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const id = crypto.randomUUID();
  const now = new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');

  await c.env.DB.prepare(
    `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
     VALUES (?, ?, 'test_recipients', ?, ?, ?)
     ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`
  ).bind(
    id, body.accountId, JSON.stringify(body.friendIds), now, now,
    JSON.stringify(body.friendIds), now,
  ).run();

  return c.json({ success: true });
});

// ── link_base_url (global setting, stored under sentinel '__global__') ─────────

/**
 * GET /api/account-settings/link-base-url
 * Returns the configured short-link base URL (or null if not set).
 */
accountSettings.get('/api/account-settings/link-base-url', async (c) => {
  const value = await getLinkBaseUrl(c.env.DB, GLOBAL_ACCOUNT_ID);
  return c.json({ success: true, data: value });
});

/**
 * PUT /api/account-settings/link-base-url
 * Body: { value: string }
 * - Empty string clears the setting.
 * - Must start with https:// (if non-empty).
 * - Trailing slash is stripped before saving.
 */
accountSettings.put('/api/account-settings/link-base-url', async (c) => {
  const body = await c.req
    .json<{ value?: string }>()
    .catch((): { value?: string } => ({}));
  const value = typeof body.value === 'string' ? body.value : '';

  try {
    await setLinkBaseUrl(c.env.DB, GLOBAL_ACCOUNT_ID, value);
    return c.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Validation error';
    return c.json({ success: false, error: message }, 400);
  }
});

type NormalizedBaseUrl =
  | { success: true; value: string | null }
  | { success: false; error: string };

function validateAndNormalizeBaseUrl(input: string): NormalizedBaseUrl {
  const trimmed = input.trim();
  if (trimmed === '') return { success: true, value: null };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { success: false, error: 'OPENAI_BASE_URL must be a valid URL (https://...)' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { success: false, error: 'OPENAI_BASE_URL must start with http:// or https://' };
  }
  return { success: true, value: parsed.toString().replace(/\/$/, '') };
}

function normalizeModel(input: string): string | null {
  const trimmed = input.trim();
  return trimmed === '' ? null : trimmed;
}

type OpenAISettingsBody = {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
};

accountSettings.get('/api/account-settings/openai', async (c) => {
  const persisted = await getOpenAIConnectionSettings(c.env.DB, GLOBAL_ACCOUNT_ID);
  const effective = await getEffectiveOpenAISettings(c.env.DB, c.env);
  return c.json({
    success: true,
    data: {
      baseUrl: persisted.baseUrl,
      model: persisted.model,
      hasApiKey: Boolean((persisted.apiKey ?? '').trim()),
      effectiveBaseUrl: effective.baseUrl,
      effectiveModel: effective.model,
      hasEffectiveApiKey: Boolean((effective.apiKey ?? '').trim()),
    },
  });
});

accountSettings.put('/api/account-settings/openai', async (c) => {
  const body: OpenAISettingsBody = await c.req
    .json<OpenAISettingsBody>()
    .catch((): OpenAISettingsBody => ({}));

  const normalizedBaseUrl = validateAndNormalizeBaseUrl(typeof body.baseUrl === 'string' ? body.baseUrl : '');
  if (!normalizedBaseUrl.success) {
    return c.json({ success: false, error: normalizedBaseUrl.error }, 400);
  }
  const normalizedModel = normalizeModel(typeof body.model === 'string' ? body.model : '');

  const effectiveBaseUrl = normalizedBaseUrl.value ?? (c.env.OPENAI_BASE_URL?.trim() || null);
  const effectiveModel = normalizedModel ?? (c.env.OPENAI_MODEL?.trim() || null);
  if (!effectiveBaseUrl) {
    return c.json({ success: false, error: 'OPENAI_BASE_URL is required (set in Admin or env).' }, 400);
  }
  if (!effectiveModel) {
    return c.json({ success: false, error: 'OPENAI_MODEL is required (set in Admin or env).' }, 400);
  }

  const update: { baseUrl: string | null; model: string | null; apiKey?: string | null } = {
    baseUrl: normalizedBaseUrl.value,
    model: normalizedModel,
  };

  if (body.clearApiKey) {
    update.apiKey = null;
  } else if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') {
    update.apiKey = body.apiKey.trim();
  }

  await setOpenAIConnectionSettings(c.env.DB, GLOBAL_ACCOUNT_ID, update);
  return c.json({ success: true });
});

export { accountSettings };
