import { getEffectiveOpenAISettings, type OpenAIEnvFallback } from '../lib/openai-settings.js';

const MAX_INPUT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 5000;

type ChatCompletionContentPart =
  | { type?: string; text?: string }
  | { type?: string; text?: { value?: string } };

type ChatCompletionsResponse = {
  choices?: Array<{
    message?: {
      content?: string | ChatCompletionContentPart[];
    };
  }>;
};

function buildChatCompletionsUrl(baseUrl: string): string {
  return new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

function extractText(content: string | ChatCompletionContentPart[] | undefined): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (!Array.isArray(content)) return null;

  const joined = content
    .map((part) => {
      if (!part || part.type !== 'text') return '';
      if (typeof part.text === 'string') return part.text;
      return typeof part.text?.value === 'string' ? part.text.value : '';
    })
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
  db: D1Database,
  env: OpenAIEnvFallback,
  incomingText: string,
): Promise<string | null> {
  const settings = await getEffectiveOpenAISettings(db, env);
  if (!settings.baseUrl || !settings.model) return null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (settings.apiKey) {
    headers.Authorization = 'Bearer ' + settings.apiKey;
  }

  const response = await fetch(buildChatCompletionsUrl(settings.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      messages: [
        {
          role: 'user',
          content: incomingText.slice(0, MAX_INPUT_CHARS),
        },
      ],
    }),
  });

  if (!response.ok) {
    console.error('[openai-auto-reply] upstream request failed', {
      status: response.status,
      statusText: response.statusText,
    });
    return null;
  }

  let payload: ChatCompletionsResponse;
  try {
    payload = await response.json() as ChatCompletionsResponse;
  } catch (err) {
    console.error('[openai-auto-reply] failed to parse upstream JSON', err);
    return null;
  }
  const text = extractText(payload.choices?.[0]?.message?.content);
  return text ? text.slice(0, MAX_OUTPUT_CHARS) : null;
}

interface ReplyCapableLineClient {
  replyMessage(replyToken: string, messages: Array<{ type: 'text'; text: string }>): Promise<unknown>;
  pushMessage(userId: string, messages: Array<{ type: 'text'; text: string }>): Promise<unknown>;
}

export async function maybeSendOpenAIAutoReply(args: {
  db: D1Database;
  env: OpenAIEnvFallback;
  lineClient: ReplyCapableLineClient;
  friendId: string;
  lineUserId: string;
  incomingText: string;
  replyToken: string;
  lineAccountId: string | null;
  createdAt: string;
}): Promise<{ matched: boolean; replyTokenConsumed: boolean }> {
  const aiReply = await generateOpenAIReply(args.db, args.env, args.incomingText);
  if (!aiReply) {
    return { matched: false, replyTokenConsumed: false };
  }

  let deliveryType: 'reply' | 'push' = 'reply';
  try {
    await args.lineClient.replyMessage(args.replyToken, [{ type: 'text', text: aiReply }]);
  } catch (err: unknown) {
    if (!isReplyTokenExpiredError(err)) throw err;
    await args.lineClient.pushMessage(args.lineUserId, [{ type: 'text', text: aiReply }]);
    deliveryType = 'push';
  }

  await args.db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, ?, 'auto_reply', ?, ?)`,
    )
    .bind(crypto.randomUUID(), args.friendId, aiReply, deliveryType, args.lineAccountId, args.createdAt)
    .run();

  return { matched: true, replyTokenConsumed: deliveryType === 'reply' };
}
