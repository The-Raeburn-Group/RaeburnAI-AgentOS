import OpenAI from "openai";

import { env } from "@/lib/env";
import type { ProviderMessage, ProviderResponse } from "@/lib/types";

export type ModelProviderName = "openai" | "openrouter" | "ollama";
export type ProviderResponseFormat = "text" | "json";

export class ProviderExecutionError extends Error {
  constructor(
    public readonly code:
      | "configuration_error"
      | "timeout"
      | "cancelled"
      | "rate_limited"
      | "upstream_error"
      | "malformed_response",
    public readonly options: {
      provider: string;
      status?: number;
      retryAfterSeconds?: number;
    },
  ) {
    super(code);
    this.name = "ProviderExecutionError";
  }
}

export interface ProviderGenerationOptions {
  provider?: ModelProviderName | string;
  model?: string;
  messages: ProviderMessage[];
  responseFormat?: ProviderResponseFormat;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function safePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function retryAfterSeconds(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function externalStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" ? value : undefined;
}

function externalHeaders(error: unknown): Headers | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { headers?: unknown }).headers;
  if (value instanceof Headers) return value;
  if (
    value &&
    typeof value === "object" &&
    "get" in value &&
    typeof (value as { get?: unknown }).get === "function"
  ) {
    return value as Headers;
  }
  return undefined;
}

function normalizeProviderError(options: {
  error: unknown;
  provider: string;
  externalSignal?: AbortSignal;
  timedOut: boolean;
}): ProviderExecutionError {
  if (options.error instanceof ProviderExecutionError) return options.error;
  if (options.externalSignal?.aborted) {
    return new ProviderExecutionError("cancelled", {
      provider: options.provider,
    });
  }
  if (options.timedOut) {
    return new ProviderExecutionError("timeout", {
      provider: options.provider,
    });
  }

  const status = externalStatus(options.error);
  if (status === 429) {
    return new ProviderExecutionError("rate_limited", {
      provider: options.provider,
      status,
      retryAfterSeconds: retryAfterSeconds(externalHeaders(options.error)),
    });
  }
  return new ProviderExecutionError("upstream_error", {
    provider: options.provider,
    ...(status === undefined ? {} : { status }),
  });
}

async function withProviderSignal<T>(
  options: {
    provider: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    safePositiveInteger(options.timeoutMs, "provider_timeout_ms"),
  );

  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  if (options.signal?.aborted) controller.abort();

  try {
    return await execute(controller.signal);
  } catch (error) {
    throw normalizeProviderError({
      error,
      provider: options.provider,
      externalSignal: options.signal,
      timedOut,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function requireText(value: unknown, provider: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderExecutionError("malformed_response", { provider });
  }
  return value;
}

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export async function generateWithProvider(
  options: ProviderGenerationOptions,
): Promise<ProviderResponse> {
  const provider = (options.provider ??
    env.DEFAULT_MODEL_PROVIDER) as ModelProviderName;
  const model = options.model ?? env.DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? env.MODEL_REQUEST_TIMEOUT_MS;
  const maxOutputTokens = safePositiveInteger(
    options.maxOutputTokens ?? env.MODEL_MAX_OUTPUT_TOKENS,
    "max_output_tokens",
  );
  const responseFormat = options.responseFormat ?? "text";

  if (provider === "ollama") {
    return withProviderSignal(
      { provider, timeoutMs, signal: options.signal },
      async (signal) => {
        const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            model,
            messages: options.messages,
            stream: false,
            ...(responseFormat === "json" ? { format: "json" } : {}),
            options: { num_predict: maxOutputTokens },
          }),
        });

        if (!response.ok) {
          throw new ProviderExecutionError(
            response.status === 429 ? "rate_limited" : "upstream_error",
            {
              provider,
              status: response.status,
              retryAfterSeconds:
                response.status === 429
                  ? retryAfterSeconds(response.headers)
                  : undefined,
            },
          );
        }

        let data: {
          message?: { content?: unknown };
          prompt_eval_count?: unknown;
          eval_count?: unknown;
        };
        try {
          data = (await response.json()) as typeof data;
        } catch {
          throw new ProviderExecutionError("malformed_response", { provider });
        }

        const promptTokens = usageNumber(data.prompt_eval_count);
        const completionTokens = usageNumber(data.eval_count);
        const tokens =
          promptTokens !== undefined && completionTokens !== undefined
            ? promptTokens + completionTokens
            : undefined;
        return {
          text: requireText(data.message?.content, provider),
          provider,
          model,
          ...(promptTokens === undefined ? {} : { promptTokens }),
          ...(completionTokens === undefined ? {} : { completionTokens }),
          ...(tokens === undefined ? {} : { tokens }),
        };
      },
    );
  }

  if (provider !== "openai" && provider !== "openrouter") {
    throw new ProviderExecutionError("configuration_error", { provider });
  }

  const apiKey =
    provider === "openrouter" ? env.OPENROUTER_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderExecutionError("configuration_error", { provider });
  }

  const client = new OpenAI({
    apiKey,
    ...(provider === "openrouter"
      ? { baseURL: "https://openrouter.ai/api/v1" }
      : {}),
  });

  return withProviderSignal(
    { provider, timeoutMs, signal: options.signal },
    async (signal) => {
      const completion = await client.chat.completions.create(
        {
          model,
          messages: options.messages,
          max_tokens: maxOutputTokens,
          ...(responseFormat === "json"
            ? { response_format: { type: "json_object" as const } }
            : {}),
        },
        { signal },
      );
      const promptTokens = usageNumber(completion.usage?.prompt_tokens);
      const completionTokens = usageNumber(completion.usage?.completion_tokens);
      const totalTokens =
        usageNumber(completion.usage?.total_tokens) ??
        (promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined);

      return {
        text: requireText(completion.choices[0]?.message?.content, provider),
        provider,
        model,
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
        ...(totalTokens === undefined ? {} : { tokens: totalTokens }),
      };
    },
  );
}
