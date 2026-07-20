import { jstNow } from '@line-crm/db';
import type { FlexContainer, FlexMessage, TextMessage } from '@line-crm/line-sdk';
import { extractFlexAltText } from '../utils/flex-alt-text.js';
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
// LINE template-message hard limits (exceeding any rejects the whole send):
// confirm text 240, buttons text 160 (no image/title variant), altText 400,
// buttons actions max 4.
const CONFIRM_TEMPLATE_MAX_TEXT_CHARS = 240;
const BUTTONS_TEMPLATE_MAX_TEXT_CHARS = 160;
const TEMPLATE_MAX_ALT_TEXT_CHARS = 400;
const BUTTONS_TEMPLATE_MAX_ACTIONS = 4;
// v1: hardcoded confirm labels (localize later via settings if needed).
const CONFIRM_LABELS = ['Yes', 'No'];
// LINE Flex hard limits: altText 400 chars, carousel max 12 bubbles, flex
// container JSON max 50KB.
const FLEX_MAX_ALT_TEXT_CHARS = 400;
const FLEX_CAROUSEL_MAX_BUBBLES = 12;
const FLEX_MAX_JSON_BYTES = 50 * 1024;
// LINE allows at most 5 messages per reply/push; keep 1 slot free for the
// notePrefix deliverTextReply may prepend.
const MAX_AI_MESSAGES_PER_SEND = 4;

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

// Parse + re-validate one send_line_flex arguments string (same trust boundary
// as parseAsk — the plugin validates, we clamp again server-side).
function parseFlex(rawArguments: unknown): FlexMessage | null {
  if (typeof rawArguments !== 'string') return null;
  let args: unknown;
  try {
    args = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  if (typeof args !== 'object' || args === null) return null;
  const { alt_text: altRaw, contents } = args as Record<string, unknown>;
  if (typeof contents !== 'object' || contents === null) return null;

  const container = contents as { type?: unknown; contents?: unknown };
  if (container.type === 'carousel') {
    if (!Array.isArray(container.contents) || container.contents.length === 0) return null;
    // Clamp rather than drop: deliver the first 12 bubbles.
    container.contents = container.contents.slice(0, FLEX_CAROUSEL_MAX_BUBBLES);
  } else if (container.type !== 'bubble') {
    return null;
  }
  if (JSON.stringify(contents).length > FLEX_MAX_JSON_BYTES) return null;

  const altSource =
    typeof altRaw === 'string' && altRaw.trim() !== '' ? altRaw : extractFlexAltText(contents);
  const altText = truncateSafe(altSource, FLEX_MAX_ALT_TEXT_CHARS);
  if (altText === '') return null;
  return { type: 'flex', altText, contents: contents as FlexContainer };
}

// Collect every valid send_line_flex function_call, in call order. Unlike the
// ask (one question per turn), each flex call is its own outgoing message.
function extractFlexMessages(payload: ResponsesApiResponse): FlexMessage[] {
  if (!Array.isArray(payload.output)) return [];
  const flex: FlexMessage[] = [];
  for (const item of payload.output) {
    if (item?.type !== 'function_call' || item.name !== 'send_line_flex') continue;
    const parsed = parseFlex(item.arguments);
    if (parsed) flex.push(parsed);
  }
  return flex;
}

export async function generateOpenAIReply(
  settings: Pick<EffectiveOpenAISettings, 'baseUrl' | 'apiKey' | 'model'>,
  incomingText: string,
  previousResponseId: string | null,
): Promise<{ text: string | null; ask: AskUserLine | null; flex: FlexMessage[]; responseId: string | null } | null> {
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
  const flex = extractFlexMessages(payload);
  if (!text && !ask && flex.length === 0) return null;
  return {
    text: text ? text.slice(0, MAX_OUTPUT_CHARS) : null,
    ask,
    flex,
    responseId: typeof payload.id === 'string' && payload.id !== '' ? payload.id : null,
  };
}

// message action: the tapped label arrives as a normal text webhook event,
// so the resume leg reuses the existing session chain as-is.
type MessageAction = { type: 'message'; label: string; text: string };

type ConfirmTemplateMessage = {
  type: 'template';
  altText: string; // shown in push notifications / chat list
  template: { type: 'confirm'; text: string; actions: [MessageAction, MessageAction] };
};

type ButtonsTemplateMessage = {
  type: 'template';
  altText: string;
  template: { type: 'buttons'; text: string; actions: MessageAction[] }; // 1–4
};

type OutgoingMessage = TextMessage | ConfirmTemplateMessage | ButtonsTemplateMessage | FlexMessage;

interface ReplyCapableLineClient {
  replyMessage(replyToken: string, messages: OutgoingMessage[]): Promise<unknown>;
  pushMessage(userId: string, messages: OutgoingMessage[]): Promise<unknown>;
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

// Render the ask by kind: confirm → confirm template; choice with ≤4 options
// → buttons template; choice with 5–13 → quick-reply chips (buttons template
// caps at 4 actions); freetext → plain text. The question is always LAST —
// only quickReply is last-message sensitive, but templates keep the same
// ordering for consistency.
function buildAskMessages(ask: AskUserLine): OutgoingMessage[] {
  const messages: OutgoingMessage[] = [];
  const options = ask.options ?? [];
  if (ask.kind === 'confirm' || (ask.kind === 'choice' && options.length <= BUTTONS_TEMPLATE_MAX_ACTIONS)) {
    const textMax =
      ask.kind === 'confirm' ? CONFIRM_TEMPLATE_MAX_TEXT_CHARS : BUTTONS_TEMPLATE_MAX_TEXT_CHARS;
    if (ask.message.length > textMax) {
      // Template text would truncate the question — deliver it in full as a
      // plain text message first; the template carries a short stub.
      messages.push({ type: 'text', text: ask.message });
    }
    const actions = (ask.kind === 'confirm' ? CONFIRM_LABELS : options).map((raw) => {
      const label = truncateSafe(raw, QUICK_REPLY_MAX_LABEL_CHARS);
      return { type: 'message' as const, label, text: label };
    });
    const text = truncateSafe(ask.message, textMax);
    const altText = truncateSafe(ask.message, TEMPLATE_MAX_ALT_TEXT_CHARS);
    messages.push(
      ask.kind === 'confirm'
        ? {
            type: 'template',
            altText,
            template: { type: 'confirm', text, actions: actions as [MessageAction, MessageAction] },
          }
        : { type: 'template', altText, template: { type: 'buttons', text, actions } },
    );
    return messages;
  }

  // freetext, or choice with 5+ options.
  const question: TextMessage = { type: 'text', text: ask.message };
  const labels = ask.kind === 'choice' ? options : [];
  if (labels.length > 0) {
    question.quickReply = {
      items: labels.map((label) => ({
        type: 'action' as const,
        action: { type: 'message' as const, label, text: label },
      })),
    };
  }
  messages.push(question);
  return messages;
}

function buildAiMessages(result: {
  text: string | null;
  ask: AskUserLine | null;
  flex: FlexMessage[];
}): OutgoingMessage[] {
  const messages: OutgoingMessage[] = [];
  if (result.text) {
    messages.push({ type: 'text', text: result.text });
  }
  const askMessages = result.ask ? buildAskMessages(result.ask) : [];
  // Flex cards sit between narration and the ask. Clamp flex (not the ask) to
  // LINE's per-send message cap — the question must stay present and LAST.
  const room = MAX_AI_MESSAGES_PER_SEND - messages.length - askMessages.length;
  messages.push(...result.flex.slice(0, Math.max(0, room)), ...askMessages);
  return messages;
}

async function deliverTextReply(args: AutoReplyArgs, aiMessages: OutgoingMessage[]): Promise<'reply' | 'push'> {
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
  // chips/buttons are ephemeral UI, the question text is the durable content;
  // apps/web chats renders unknown message_type as an opaque placeholder, so
  // templates stay 'text' with altText — the clamped question — as content).
  // Flex is logged as message_type 'flex' with the raw container JSON, same as
  // manual flex sends from chats.ts.
  for (const message of aiMessages) {
    const isFlex = message.type === 'flex';
    const content =
      message.type === 'text'
        ? message.text
        : isFlex
          ? JSON.stringify(message.contents)
          : message.altText;
    await args.db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
         VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, ?, 'auto_reply', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        args.friendId,
        isFlex ? 'flex' : 'text',
        content,
        deliveryType,
        args.lineAccountId,
        jstNow(),
      )
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
