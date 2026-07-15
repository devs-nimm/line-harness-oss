import { jstNow } from '@line-crm/db';
import type { TextMessage } from '@line-crm/line-sdk';
import {
  getEffectiveOpenAISettings,
  type EffectiveOpenAISettings,
  type OpenAIEnvSettings,
} from '../lib/openai-settings.js';
import { isReplyTokenExpiredError, logSystemNote } from './chat-sessions.js';

const MAX_INPUT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 5000;

// LINE quick-reply hard limits (Messaging API): max 13 items, label max
// 20 chars, and quickReply is only honored on the LAST message of a send.
const QUICK_REPLY_MAX_ITEMS = 13;
const QUICK_REPLY_MAX_LABEL_CHARS = 20;
// v1: hardcoded confirm labels (localize later via settings if needed).
const CONFIRM_LABELS = ['Yes', 'No'];

// Responses API session settings: the provider keeps conversation state
// server-side; we only chain response ids. After AI_SESSION_MAX_TURNS user
// messages the next message silently starts a fresh session.
// "/new" is handled at the webhook level (chat-sessions.ts, MIN-267) so it
// archives the conversation session even when no AI is configured.
const AI_SESSION_MAX_TURNS = 30;

type ResponsesOutputItem = {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  // function_call items (e.g. the ask_user_line plugin tool)
  name?: string;
  arguments?: string;
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

// Truncate without splitting a surrogate pair (a cut mid-emoji yields a lone
// surrogate, which LINE rejects as invalid UTF-8).
function truncateSafe(raw: string, max: number): string {
  let out = raw.trim().slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

export type AskUserLine = {
  message: string;
  kind: 'choice' | 'confirm' | 'freetext';
  options?: string[];
};

// Parse + re-validate one ask_user_line arguments string. This is the trust
// boundary — the plugin validates what the model produced, but we clamp
// everything again server-side (never trust model output).
function parseAsk(rawArguments: unknown): AskUserLine | null {
  if (typeof rawArguments !== 'string') return null;
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (typeof args !== 'object' || args === null) return null;
  const { message, kind, options } = args as Record<string, unknown>;
  if (typeof message !== 'string' || message.trim() === '') return null;
  if (kind !== 'choice' && kind !== 'confirm' && kind !== 'freetext') return null;

  const ask: AskUserLine = { message: truncateSafe(message, MAX_OUTPUT_CHARS), kind };
  if (kind === 'choice') {
    const labels = (Array.isArray(options) ? options : [])
      .filter((opt): opt is string => typeof opt === 'string')
      .map((opt) => truncateSafe(opt, QUICK_REPLY_MAX_LABEL_CHARS))
      .filter((opt) => opt !== '');
    const deduped = [...new Set(labels)].slice(0, QUICK_REPLY_MAX_ITEMS);
    if (deduped.length < 2) {
      // Not enough chips to render a choice — degrade to a plain question.
      ask.kind = 'freetext';
    } else {
      ask.options = deduped;
    }
  }
  return ask;
}

// The ask_user_line Hermes plugin delivers its question IN-BAND: as a
// function_call item whose `arguments` is the question spec.
function extractAskUserLine(payload: ResponsesApiResponse): AskUserLine | null {
  if (!Array.isArray(payload.output)) return null;
  // The plugin returns validation errors as the tool result (no stop sentinel)
  // so the model can retry within the same turn — the output array may then
  // hold several ask_user_line calls. The last valid one is the question the
  // model settled on; earlier rejected attempts must not shadow it.
  for (let i = payload.output.length - 1; i >= 0; i--) {
    const item = payload.output[i];
    if (item?.type !== 'function_call' || item.name !== 'ask_user_line') continue;
    const ask = parseAsk(item.arguments);
    if (ask) return ask;
  }
  return null;
}

export async function generateOpenAIReply(
  settings: Pick<EffectiveOpenAISettings, 'baseUrl' | 'apiKey' | 'model'>,
  incomingText: string,
  previousResponseId: string | null,
): Promise<{ text: string | null; ask: AskUserLine | null; responseId: string | null } | null> {
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
  // A response may contain BOTH narration text and an ask (the model may emit
  // a short "waiting for your reply" message alongside the ask_user_line call).
  const text = extractOutputText(payload);
  const ask = extractAskUserLine(payload);
  if (!text && !ask) return null;
  return {
    text: text ? text.slice(0, MAX_OUTPUT_CHARS) : null,
    ask,
    responseId: typeof payload.id === 'string' && payload.id !== '' ? payload.id : null,
  };
}

interface ReplyCapableLineClient {
  replyMessage(replyToken: string, messages: TextMessage[]): Promise<unknown>;
  pushMessage(userId: string, messages: TextMessage[]): Promise<unknown>;
}

interface AutoReplyArgs {
  db: D1Database;
  env: OpenAIEnvSettings;
  lineClient: ReplyCapableLineClient;
  friendId: string;
  lineUserId: string;
  incomingText: string;
  replyToken: string;
  lineAccountId: string | null;
  createdAt: string;
  // System note to prepend to the reply (same reply call = zero quota cost,
  // guaranteed to arrive before the AI text). Logged as source='system_note'
  // so it never enters any LLM input (MIN-267).
  notePrefix?: string | null;
}

// Turn the AI result into the outgoing LINE messages (notePrefix excluded —
// deliverTextReply prepends it). The ask question is always LAST because LINE
// ignores quickReply on any message that isn't the last one in the array.
function buildAiMessages(result: { text: string | null; ask: AskUserLine | null }): TextMessage[] {
  const messages: TextMessage[] = [];
  if (result.text) {
    messages.push({ type: 'text', text: result.text });
  }
  if (result.ask) {
    const question: TextMessage = { type: 'text', text: result.ask.message };
    const labels =
      result.ask.kind === 'choice'
        ? result.ask.options ?? []
        : result.ask.kind === 'confirm'
          ? CONFIRM_LABELS
          : [];
    if (labels.length > 0) {
      question.quickReply = {
        items: labels.map((label) => ({
          type: 'action' as const,
          // message action: the tapped label arrives as a normal text webhook
          // event, so the resume leg reuses the existing session chain as-is.
          action: { type: 'message' as const, label, text: label },
        })),
      };
    }
    messages.push(question);
  }
  return messages;
}

async function deliverTextReply(args: AutoReplyArgs, aiMessages: TextMessage[]): Promise<'reply' | 'push'> {
  let deliveryType: 'reply' | 'push' = 'reply';
  const messages = [
    ...(args.notePrefix ? [{ type: 'text' as const, text: args.notePrefix }] : []),
    ...aiMessages,
  ];
  try {
    await args.lineClient.replyMessage(args.replyToken, messages);
  } catch (err: unknown) {
    if (!isReplyTokenExpiredError(err)) throw err;
    await args.lineClient.pushMessage(args.lineUserId, messages);
    deliveryType = 'push';
  }

  if (args.notePrefix) {
    // Note logged at the incoming timestamp, the AI reply at delivery time
    // (jstNow below) — strictly later, so the note always sorts first.
    await logSystemNote(args.db, {
      friendId: args.friendId,
      text: args.notePrefix,
      deliveryType,
      lineAccountId: args.lineAccountId,
      createdAt: args.createdAt,
    });
  }

  // One log row per AI message (an ask question is logged as plain text —
  // the chips are ephemeral UI, the question text is the durable content).
  for (const message of aiMessages) {
    await args.db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, ?, 'auto_reply', ?, ?)`,
      )
      .bind(crypto.randomUUID(), args.friendId, message.text, deliveryType, args.lineAccountId, jstNow())
      .run();
  }

  return deliveryType;
}

export async function maybeSendOpenAIAutoReply(
  args: AutoReplyArgs,
): Promise<{ matched: boolean; replyTokenConsumed: boolean }> {
  const settings = await getEffectiveOpenAISettings(args.db, args.env);
  if (!settings.baseUrl || !settings.model) {
    return { matched: false, replyTokenConsumed: false };
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

  const deliveryType = await deliverTextReply(args, buildAiMessages(result));
  return { matched: true, replyTokenConsumed: deliveryType === 'reply' };
}
