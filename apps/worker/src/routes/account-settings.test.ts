import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getLinkBaseUrl: vi.fn(),
  setLinkBaseUrl: vi.fn(),
  getOpenAIConnectionSettings: vi.fn(),
  setOpenAIConnectionSettings: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

const { accountSettings } = await import('./account-settings.js');

type TestEnv = {
  Bindings: {
    DB: D1Database;
    OPENAI_BASE_URL?: string;
    OPENAI_MODEL?: string;
    OPENAI_API_KEY?: string;
  };
};

function setupApp(bindings?: TestEnv['Bindings']) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = {
      DB: {} as D1Database,
      ...(bindings ?? {}),
    };
    await next();
  });
  app.route('/', accountSettings);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
});

describe('GET /api/account-settings/openai', () => {
  it('returns masked API key state only (never raw key)', async () => {
    dbMocks.getOpenAIConnectionSettings.mockResolvedValue({
      baseUrl: 'https://example.com/v1',
      model: 'gpt-test',
      apiKey: 'sk-secret',
    });

    const app = setupApp();
    const res = await app.request('/api/account-settings/openai');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.data.hasApiKey).toBe(true);
    expect(body.data.apiKey).toBeUndefined();
  });
});

describe('PUT /api/account-settings/openai', () => {
  it('rejects invalid base URL', async () => {
    const app = setupApp();
    const res = await app.request('/api/account-settings/openai', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'not-a-url', model: 'gpt-4o-mini' }),
    });
    expect(res.status).toBe(400);
    expect(dbMocks.setOpenAIConnectionSettings).not.toHaveBeenCalled();
  });

  it('rejects blank model when env fallback is also unset', async () => {
    const app = setupApp();
    const res = await app.request('/api/account-settings/openai', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.openai.com/v1', model: '' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('OPENAI_MODEL');
    expect(dbMocks.setOpenAIConnectionSettings).not.toHaveBeenCalled();
  });

  it('allows blank persisted baseUrl/model when env fallback exists', async () => {
    const app = setupApp({
      DB: {} as D1Database,
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o-mini',
    });
    const res = await app.request('/api/account-settings/openai', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: '', model: '', clearApiKey: true }),
    });
    expect(res.status).toBe(200);
    expect(dbMocks.setOpenAIConnectionSettings).toHaveBeenCalledWith(
      expect.anything(),
      '__global__',
      { baseUrl: null, model: null, apiKey: null },
    );
  });
});
