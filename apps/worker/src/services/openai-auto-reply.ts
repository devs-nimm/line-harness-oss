import {
  getEffectiveOpenAISettings,
  type EffectiveOpenAISettings,
  type OpenAIEnvFallback,
} from '../lib/openai-settings.js';

const MAX_INPUT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 5000;

// Responses API session settings: the provider keeps conversation state
// server-side; we only chain response ids. After AI_SESSION_MAX_TURNS user
// messages the next message silently starts a fresh session.
const AI_SESSION_MAX_TURNS = 30;
const NEW_SESSION_COMMAND = '/new';
const NEW_SESSION_REPLY = '新しい会話を開始しました。';

type ResponsesOutputItem = {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
};

type ResponsesApiResponse = {
  id?: string;
  output_text?: string;
  output?: ResponsesOutputItem[];
};

function buildResponsesUrl(baseUrl: string): string {
  return new URL('responses', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function extractOutputText(payload: ResponsesApiResponse): string | null {
  // output_text is the SDK-style convenience field some servers include;
  // the canonical shape is output[] → message → content[] → output_text.
  if (typeof payload.output_text === 'string' && payload.output_text.trim() !== '') {
    return payload.output_text.trim();
  }
  if (!Array.isArray(payload.output)) return null;

  const joined = payload.output
    .filter((item) => item?.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content!)
    .map((part) => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();

  return joined === '' ? null : joined;
}

function isReplyTokenExpiredError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err && err.status === 400) {
    return true;
  }

  const errMsg = err instanceof Error ? err.message : String(err);
  const statusMatch = /^LINE API error: (\d+)/.exec(errMsg);
  if (statusMatch) {
    return statusMatch[1] === '400';
  }

  return errMsg.includes('Invalid reply token');
}

export async function generateOpenAIReply(
  settings: EffectiveOpenAISettings,
  incomingText: string,
  previousResponseId: string | null,
): Promise<{ text: string; responseId: string | null } | null> {
  if (!settings.baseUrl || !settings.model) return null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (settings.apiKey) {
    headers.Authorization = 'Bearer ' + settings.apiKey;
  }

  const response = await fetch(buildResponsesUrl(settings.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      input: incomingText.slice(0, MAX_INPUT_CHARS),
      store: true,
      ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    }),
  });

  if (!response.ok) {
    console.error('[openai-auto-reply] upstream request failed', {
      status: response.status,
      statusText: response.statusText,
    });
    return null;
  }

  let payload: ResponsesApiResponse;
  try {
    payload = await response.json() as ResponsesApiResponse;
  } catch (err) {
    console.error('[openai-auto-reply] failed to parse upstream JSON', err);
    return null;
  }
  const text = extractOutputText(payload);
  if (!text) return null;
  return {
    text: text.slice(0, MAX_OUTPUT_CHARS),
    responseId: typeof payload.id === 'string' && payload.id !== '' ? payload.id : null,
  };
}

interface ReplyCapableLineClient {
  replyMessage(replyToken: string, messages: Array<{ type: 'text'; text: string }>): Promise<unknown>;
  pushMessage(userId: string, messages: Array<{ type: 'text'; text: string }>): Promise<unknown>;
}

interface AutoReplyArgs {
  db: D1Database;
  env: OpenAIEnvFallback;
  lineClient: ReplyCapableLineClient;
  friendId: string;
  lineUserId: string;
  incomingText: string;
  replyToken: string;
  lineAccountId: string | null;
  createdAt: string;
}

async function deliverTextReply(args: AutoReplyArgs, text: string): Promise<'reply' | 'push'> {
  let deliveryType: 'reply' | 'push' = 'reply';
  try {
    await args.lineClient.replyMessage(args.replyToken, [{ type: 'text', text }]);
  } catch (err: unknown) {
    if (!isReplyTokenExpiredError(err)) throw err;
    await args.lineClient.pushMessage(args.lineUserId, [{ type: 'text', text }]);
    deliveryType = 'push';
  }

  await args.db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, ?, 'auto_reply', ?, ?)`,
    )
    .bind(crypto.randomUUID(), args.friendId, text, deliveryType, args.lineAccountId, args.createdAt)
    .run();

  return deliveryType;
}

export async function maybeSendOpenAIAutoReply(
  args: AutoReplyArgs,
): Promise<{ matched: boolean; replyTokenConsumed: boolean }> {
  const settings = await getEffectiveOpenAISettings(args.db, args.env);
  if (!settings.baseUrl || !settings.model) {
    return { matched: false, replyTokenConsumed: false };
  }

  // /new: reset the friend's session; the command itself never reaches the LLM.
  if (args.incomingText.trim() === NEW_SESSION_COMMAND) {
    await args.db
      .prepare('DELETE FROM ai_chat_sessions WHERE friend_id = ?')
      .bind(args.friendId)
      .run();
    const deliveryType = await deliverTextReply(args, NEW_SESSION_REPLY);
    return { matched: true, replyTokenConsumed: deliveryType === 'reply' };
  }

  const session = await args.db
    .prepare('SELECT last_response_id, turn_count FROM ai_chat_sessions WHERE friend_id = ?')
    .bind(args.friendId)
    .first<{ last_response_id: string; turn_count: number }>();
  const continuing = session != null && session.turn_count < AI_SESSION_MAX_TURNS;

  const result = await generateOpenAIReply(
    settings,
    args.incomingText,
    continuing ? session.last_response_id : null,
  );
  if (!result) {
    return { matched: false, replyTokenConsumed: false };
  }

  // Persist before delivery: the response exists server-side either way, so
  // the chain must advance even if the LINE send below fails.
  if (result.responseId) {
    await args.db
      .prepare(
        `INSERT INTO ai_chat_sessions (friend_id, line_account_id, last_response_id, turn_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(friend_id) DO UPDATE SET
           line_account_id = excluded.line_account_id,
           last_response_id = excluded.last_response_id,
           turn_count = excluded.turn_count,
           updated_at = excluded.updated_at`,
      )
      .bind(
        args.friendId,
        args.lineAccountId,
        result.responseId,
        continuing ? session.turn_count + 1 : 1,
        args.createdAt,
      )
      .run();
  }

  const deliveryType = await deliverTextReply(args, result.text);
  return { matched: true, replyTokenConsumed: deliveryType === 'reply' };
}
