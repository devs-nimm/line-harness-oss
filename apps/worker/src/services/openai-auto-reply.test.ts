import { beforeEach, describe, expect, test, vi } from 'vitest';

const openAISettingsMocks = vi.hoisted(() => ({
  getEffectiveOpenAISettings: vi.fn(),
}));

vi.mock('../lib/openai-settings.js', () => ({
  getEffectiveOpenAISettings: openAISettingsMocks.getEffectiveOpenAISettings,
}));

import { generateOpenAIReply, maybeSendOpenAIAutoReply } from './openai-auto-reply.js';

const SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
};

function responsesPayload(text: string, id = 'resp_1') {
  return new Response(JSON.stringify({
    id,
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text }],
      },
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Fake D1: `prepare` returns a statement whose `first()` resolves to
 * `sessionRow` for the session SELECT. `runs` records every bound
 * INSERT/UPDATE/DELETE so tests can assert on SQL + params.
 */
function makeDb(sessionRow: { last_response_id: string; turn_count: number } | null = null) {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      let bound: unknown[] = [];
      const stmt = {
        bind(...params: unknown[]) {
          bound = params;
          return stmt;
        },
        first: vi.fn(async () => (sql.trimStart().startsWith('SELECT') ? sessionRow : null)),
        run: vi.fn(async () => {
          runs.push({ sql, params: bound });
          return {};
        }),
      };
      return stmt;
    }),
  } as unknown as D1Database;
  return { db, runs };
}

describe('generateOpenAIReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns null when required OpenAI settings are missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      generateOpenAIReply({ baseUrl: null, apiKey: null, model: null }, 'hello', null),
    ).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('calls the responses endpoint with store: true and returns text + response id', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('Hello from OpenAI', 'resp_abc'),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', null)).resolves.toEqual({
      text: 'Hello from OpenAI',
      responseId: 'resp_abc',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ' + 'sk-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      input: 'hello',
      store: true,
    });
  });

  test('sends previous_response_id when continuing a session', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('continued'),
    );

    await generateOpenAIReply(SETTINGS, 'hello again', 'resp_prev');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBe('resp_prev');
  });

  test('falls back to the output_text convenience field', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1', output_text: 'Hello world' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', null)).resolves.toEqual({
      text: 'Hello world',
      responseId: 'resp_1',
    });
  });

  test('returns null when upstream returns malformed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hello', null)).resolves.toBeNull();
  });
});

describe('maybeSendOpenAIAutoReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function baseArgs(db: D1Database, overrides: Partial<Parameters<typeof maybeSendOpenAIAutoReply>[0]> = {}) {
    return {
      db,
      env: {},
      lineClient: {
        replyMessage: vi.fn().mockResolvedValue(undefined),
        pushMessage: vi.fn().mockResolvedValue(undefined),
      },
      friendId: 'friend-1',
      lineUserId: 'U1',
      incomingText: 'hello',
      replyToken: 'reply-token',
      lineAccountId: 'acc-1',
      createdAt: '2026-07-10T00:00:00.000+09:00',
      ...overrides,
    };
  }

  test('returns unmatched when OpenAI settings are missing', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: null,
      apiKey: null,
      model: null,
    });
    const { db } = makeDb();
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: false,
      replyTokenConsumed: false,
    });
    expect(args.lineClient.replyMessage).not.toHaveBeenCalled();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('first message starts a session: no previous_response_id, turn_count 1', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('AI reply', 'resp_new'),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBeUndefined();
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [{ type: 'text', text: 'AI reply' }]);

    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params).toEqual(['friend-1', 'acc-1', 'resp_new', 1, '2026-07-10T00:00:00.000+09:00']);
    expect(runs.some((r) => r.sql.includes('messages_log'))).toBe(true);
  });

  test('existing session chains previous_response_id and increments turn_count', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('AI reply', 'resp_6'),
    );
    const { db, runs } = makeDb({ last_response_id: 'resp_5', turn_count: 5 });
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBe('resp_5');
    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params[2]).toBe('resp_6');
    expect(sessionUpsert?.params[3]).toBe(6);
  });

  test('session at max turns starts fresh: previous_response_id omitted, turn_count resets to 1', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('fresh start', 'resp_fresh'),
    );
    const { db, runs } = makeDb({ last_response_id: 'resp_30', turn_count: 30 });
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.previous_response_id).toBeUndefined();
    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params[2]).toBe('resp_fresh');
    expect(sessionUpsert?.params[3]).toBe(1);
  });

  test('/new clears the session and confirms without calling the LLM', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { db, runs } = makeDb({ last_response_id: 'resp_5', turn_count: 5 });
    const args = baseArgs(db, { incomingText: ' /new ' });

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(runs.some((r) => r.sql.includes('DELETE FROM ai_chat_sessions'))).toBe(true);
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith(
      'reply-token',
      [{ type: 'text', text: expect.any(String) }],
    );
    expect(runs.some((r) => r.sql.includes('messages_log'))).toBe(true);
  });

  test('falls back to pushMessage when reply token is invalid', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responsesPayload('AI reply'));
    const { db, runs } = makeDb(null);
    const args = baseArgs(db, {
      lineClient: {
        replyMessage: vi.fn().mockRejectedValue(new Error('Invalid reply token')),
        pushMessage: vi.fn().mockResolvedValue(undefined),
      },
    });

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: false,
    });
    expect(args.lineClient.pushMessage).toHaveBeenCalledWith('U1', [{ type: 'text', text: 'AI reply' }]);
    expect(runs.some((r) => r.sql.includes('messages_log'))).toBe(true);
  });
});
