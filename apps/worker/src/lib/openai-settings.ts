import { getOpenAIConnectionSettings } from '@line-crm/db';

export interface OpenAIEnvFallback {
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

export interface EffectiveOpenAISettings {
  baseUrl: string | null;
  apiKey: string | null;
  model: string | null;
}

const GLOBAL_ACCOUNT_ID = '__global__';

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  return trimmed === '' ? null : trimmed;
}

export async function getEffectiveOpenAISettings(
  db: D1Database,
  env: OpenAIEnvFallback,
): Promise<EffectiveOpenAISettings> {
  const persisted = await getOpenAIConnectionSettings(db, GLOBAL_ACCOUNT_ID);
  return {
    baseUrl: trimOrNull(persisted.baseUrl) ?? trimOrNull(env.OPENAI_BASE_URL),
    apiKey: trimOrNull(persisted.apiKey) ?? trimOrNull(env.OPENAI_API_KEY),
    model: trimOrNull(persisted.model) ?? trimOrNull(env.OPENAI_MODEL),
  };
}
