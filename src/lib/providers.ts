import OpenAI from 'openai';
import { env } from '@/lib/env';
import type { ProviderMessage, ProviderResponse } from '@/lib/types';

export type ModelProviderName = 'openai' | 'openrouter' | 'ollama';

export async function generateWithProvider(options: {
  provider?: ModelProviderName | string;
  model?: string;
  messages: ProviderMessage[];
}): Promise<ProviderResponse> {
  const provider = (options.provider ?? env.DEFAULT_MODEL_PROVIDER) as ModelProviderName;
  const model = options.model ?? env.DEFAULT_MODEL;

  if (provider === 'ollama') {
    const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: options.messages, stream: false })
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as { message?: { content?: string } };
    return { text: data.message?.content ?? '', provider, model };
  }

  if (provider === 'openrouter') {
    if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not configured');
    const client = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1'
    });
    const completion = await client.chat.completions.create({ model, messages: options.messages });
    return {
      text: completion.choices[0]?.message?.content ?? '',
      provider,
      model,
      tokens: completion.usage?.total_tokens
    };
  }

  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const completion = await client.chat.completions.create({ model, messages: options.messages });
  return {
    text: completion.choices[0]?.message?.content ?? '',
    provider,
    model,
    tokens: completion.usage?.total_tokens
  };
}
