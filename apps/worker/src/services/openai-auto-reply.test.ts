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

/** Responses payload containing an ask_user_line function_call (and optional narration). */
function askPayload(args: unknown, opts: { narration?: string; id?: string; rawArguments?: string } = {}) {
  const output: unknown[] = [];
  if (opts.narration) {
    output.push({ type: 'message', content: [{ type: 'output_text', text: opts.narration }] });
  }
  output.push({
    type: 'function_call',
    name: 'ask_user_line',
    call_id: 'chatcmpl-tool-1',
    arguments: opts.rawArguments ?? JSON.stringify(args),
  });
  return new Response(JSON.stringify({ id: opts.id ?? 'resp_ask', output }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function messageChip(label: string) {
  return { type: 'action', action: { type: 'message', label, text: label } };
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
      ask: null,
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
      ask: null,
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

  test('extracts an ask_user_line function_call alongside narration text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(
        { message: 'Which branch?', kind: 'choice', options: ['main', 'develop'] },
        { narration: 'One quick question.', id: 'resp_q' },
      ),
    );

    await expect(generateOpenAIReply(SETTINGS, 'deploy it', null)).resolves.toEqual({
      text: 'One quick question.',
      ask: { message: 'Which branch?', kind: 'choice', options: ['main', 'develop'] },
      responseId: 'resp_q',
    });
  });

  test('clamps choice options server-side: truncates labels to 20 chars, drops empties/dupes, caps at 13', async () => {
    const options = [
      'a-really-long-label-way-over-twenty-chars', // truncated to 20
      '  ', // empty after trim → dropped
      'dup',
      'dup', // duplicate → dropped
      ...Array.from({ length: 15 }, (_, i) => `opt-${i}`), // overflow → capped
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick one', kind: 'choice', options }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask?.options).toHaveLength(13);
    expect(result?.ask?.options?.[0]).toBe('a-really-long-label-');
    expect(result?.ask?.options?.[0]).toHaveLength(20);
    expect(result?.ask?.options?.filter((o) => o === 'dup')).toHaveLength(1);
  });

  test('label truncation never splits a surrogate pair (emoji at the 20-char cut)', async () => {
    // 19 ascii chars + an emoji (2 UTF-16 units) straddling the cut point.
    const straddling = 'x'.repeat(19) + '🚀 extra';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick', kind: 'choice', options: [straddling, 'other'] }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask?.options?.[0]).toBe('x'.repeat(19)); // lone surrogate dropped
  });

  test('choice with fewer than 2 usable options degrades to freetext', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Pick one', kind: 'choice', options: ['only', '  '] }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask).toEqual({ message: 'Pick one', kind: 'freetext' });
  });

  test('malformed ask arguments fall back to narration text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(null, { narration: 'Working on it.', rawArguments: '{not json' }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toEqual({
      text: 'Working on it.',
      ask: null,
      responseId: 'resp_ask',
    });
  });

  test('malformed ask arguments with no narration returns null (nothing AI-generated to send)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(null, { rawArguments: '{not json' }),
    );

    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toBeNull();
  });

  test('a rejected first ask attempt does not shadow the corrected retry in the same turn', async () => {
    // Plugin validation errors let the model retry within one turn, so the
    // output array can hold several ask_user_line calls. The last valid one wins.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'resp_retry',
        output: [
          { type: 'function_call', name: 'ask_user_line', arguments: JSON.stringify({ kind: 'choice', options: ['only'] }) }, // missing message → invalid
          { type: 'function_call', name: 'ask_user_line', arguments: JSON.stringify({ message: 'Pick', kind: 'choice', options: ['A', 'B'] }) },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await generateOpenAIReply(SETTINGS, 'hi', null);
    expect(result?.ask).toEqual({ message: 'Pick', kind: 'choice', options: ['A', 'B'] });
  });

  test('ask with unknown kind or missing message is rejected', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(askPayload({ message: 'When?', kind: 'datetime' }))
      .mockResolvedValueOnce(askPayload({ kind: 'freetext' }));

    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toBeNull();
    await expect(generateOpenAIReply(SETTINGS, 'hi', null)).resolves.toBeNull();
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

  test('notePrefix is prepended to the same reply call and logged as system_note', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(responsesPayload('AI reply'));
    const { db, runs } = makeDb(null);
    const args = baseArgs(db, { notePrefix: '新しい会話を開始しました。以前の会話内容は引き継がれません。' });

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: '新しい会話を開始しました。以前の会話内容は引き継がれません。' },
      { type: 'text', text: 'AI reply' },
    ]);
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(2);
    expect(logs[0].sql).toContain("'system_note'");
    expect(logs[0].params).toContain('新しい会話を開始しました。以前の会話内容は引き継がれません。');
    expect(logs[1].sql).toContain("'auto_reply'");
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

  test('choice ask renders as a text message with quick-reply chips', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Which branch?', kind: 'choice', options: ['main', 'develop'] }),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: true,
      replyTokenConsumed: true,
    });
    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      {
        type: 'text',
        text: 'Which branch?',
        quickReply: { items: [messageChip('main'), messageChip('develop')] },
      },
    ]);
    // The ask turn still advances the session chain.
    const sessionUpsert = runs.find((r) => r.sql.includes('ai_chat_sessions'));
    expect(sessionUpsert?.params[2]).toBe('resp_ask');
    // The ask is logged as a plain text message (chips are ephemeral UI).
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(1);
    expect(logs[0].params).toContain('Which branch?');
  });

  test('narration + ask sends two messages with quickReply on the LAST one', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(
        { message: 'Proceed?', kind: 'confirm' },
        { narration: 'I found 3 stale branches.' },
      ),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: 'I found 3 stale branches.' },
      {
        type: 'text',
        text: 'Proceed?',
        quickReply: { items: [messageChip('Yes'), messageChip('No')] },
      },
    ]);
    // Both AI messages are logged.
    const logs = runs.filter((r) => r.sql.includes('messages_log'));
    expect(logs).toHaveLength(2);
    expect(logs[0].params).toContain('I found 3 stale branches.');
    expect(logs[1].params).toContain('Proceed?');
  });

  test('freetext ask sends a plain question without quickReply', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'What name should I use?', kind: 'freetext' }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db);

    await maybeSendOpenAIAutoReply(args);

    expect(args.lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: 'What name should I use?' },
    ]);
  });

  test('notePrefix stays first and quickReply stays on the last message', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload({ message: 'Which one?', kind: 'choice', options: ['A', 'B'] }),
    );
    const { db } = makeDb(null);
    const args = baseArgs(db, { notePrefix: '新しい会話を開始しました。' });

    await maybeSendOpenAIAutoReply(args);

    const messages = (args.lineClient.replyMessage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: 'text', text: '新しい会話を開始しました。' });
    expect(messages[1].quickReply.items).toEqual([messageChip('A'), messageChip('B')]);
  });

  test('malformed ask arguments without narration sends nothing and does not crash the webhook path', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      askPayload(null, { rawArguments: '{not json' }),
    );
    const { db, runs } = makeDb(null);
    const args = baseArgs(db);

    await expect(maybeSendOpenAIAutoReply(args)).resolves.toEqual({
      matched: false,
      replyTokenConsumed: false,
    });
    expect(args.lineClient.replyMessage).not.toHaveBeenCalled();
    expect(runs).toHaveLength(0);
  });

  test('resume leg: tapped chip label flows as plain input with previous_response_id', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue(SETTINGS);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      responsesPayload('Deploying develop now.', 'resp_after'),
    );
    // Session persisted by the ask turn; the user then taps the "develop" chip,
    // which arrives as a NORMAL text webhook event.
    const { db } = makeDb({ last_response_id: 'resp_ask', turn_count: 2 });
    const args = baseArgs(db, { incomingText: 'develop' });

    await maybeSendOpenAIAutoReply(args);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(body.input).toBe('develop');
    expect(body.previous_response_id).toBe('resp_ask');
  });
});
