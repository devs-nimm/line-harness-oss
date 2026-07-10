import { beforeEach, describe, expect, test, vi } from 'vitest';

const openAISettingsMocks = vi.hoisted(() => ({
  getEffectiveOpenAISettings: vi.fn(),
}));

vi.mock('../lib/openai-settings.js', () => ({
  getEffectiveOpenAISettings: openAISettingsMocks.getEffectiveOpenAISettings,
}));

import { generateOpenAIReply, maybeSendOpenAIAutoReply } from './openai-auto-reply.js';

describe('generateOpenAIReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns null when required OpenAI settings are missing', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: null,
      apiKey: null,
      model: null,
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(generateOpenAIReply({} as D1Database, {}, 'hello')).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('calls chat completions endpoint and returns text content', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'Hello from OpenAI',
            },
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply({} as D1Database, {}, 'hello')).resolves.toBe('Hello from OpenAI');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer ' + 'sk-test',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  test('extracts text from array-based content payloads', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: null,
      model: 'gpt-4o-mini',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: 'Hello ' },
                { type: 'text', text: { value: 'world' } },
              ],
            },
          },
        ],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply({} as D1Database, {}, 'hello')).resolves.toBe('Hello world');
  });

  test('returns null when upstream returns malformed JSON', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not-json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(generateOpenAIReply({} as D1Database, {}, 'hello')).resolves.toBeNull();
  });
});

describe('maybeSendOpenAIAutoReply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns unmatched when OpenAI does not produce a reply', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: null,
      apiKey: null,
      model: null,
    });
    const lineClient = {
      replyMessage: vi.fn(),
      pushMessage: vi.fn(),
    };
    const stmt = {
      bind: vi.fn(),
      run: vi.fn(),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    await expect(maybeSendOpenAIAutoReply({
      db,
      env: {},
      lineClient,
      friendId: 'friend-1',
      lineUserId: 'U1',
      incomingText: 'hello',
      replyToken: 'reply-token',
      lineAccountId: null,
      createdAt: '2026-07-10T00:00:00.000+09:00',
    })).resolves.toEqual({ matched: false, replyTokenConsumed: false });
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  test('replies via replyMessage and logs the outgoing message', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'AI reply' } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const lineClient = {
      replyMessage: vi.fn().mockResolvedValue(undefined),
      pushMessage: vi.fn(),
    };
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    await expect(maybeSendOpenAIAutoReply({
      db,
      env: {},
      lineClient,
      friendId: 'friend-1',
      lineUserId: 'U1',
      incomingText: 'hello',
      replyToken: 'reply-token',
      lineAccountId: 'acc-1',
      createdAt: '2026-07-10T00:00:00.000+09:00',
    })).resolves.toEqual({ matched: true, replyTokenConsumed: true });
    expect(lineClient.replyMessage).toHaveBeenCalledWith('reply-token', [{ type: 'text', text: 'AI reply' }]);
    expect(lineClient.pushMessage).not.toHaveBeenCalled();
    expect(stmt.run).toHaveBeenCalled();
  });

  test('falls back to pushMessage when reply token is invalid', async () => {
    openAISettingsMocks.getEffectiveOpenAISettings.mockResolvedValue({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ message: { content: 'AI reply' } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const lineClient = {
      replyMessage: vi.fn().mockRejectedValue(new Error('Invalid reply token')),
      pushMessage: vi.fn().mockResolvedValue(undefined),
    };
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    await expect(maybeSendOpenAIAutoReply({
      db,
      env: {},
      lineClient,
      friendId: 'friend-1',
      lineUserId: 'U1',
      incomingText: 'hello',
      replyToken: 'reply-token',
      lineAccountId: 'acc-1',
      createdAt: '2026-07-10T00:00:00.000+09:00',
    })).resolves.toEqual({ matched: true, replyTokenConsumed: false });
    expect(lineClient.pushMessage).toHaveBeenCalledWith('U1', [{ type: 'text', text: 'AI reply' }]);
    expect(stmt.run).toHaveBeenCalled();
  });
});
