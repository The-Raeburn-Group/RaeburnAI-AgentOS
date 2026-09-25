import OpenAI from "openai";

import { env } from "@/lib/env";
import type {
  JsonValue,
  ProviderMessage,
  ProviderResponse,
  ProviderToolCall,
} from "@/lib/types";

export type ModelProviderName = "openai" | "openrouter" | "ollama";
export type ProviderResponseFormat = "text" | "json";
export type ProviderToolChoice = "auto" | "none" | "required";

export interface ProviderToolDefinition {
  name: string;
  description?: string;
  parameters: Record<string, JsonValue>;
}

export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: ProviderToolCall }
  | {
      type: "usage";
      promptTokens?: number;
      completionTokens?: number;
      tokens?: number;
    }
  | { type: "done" };

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
      detail?: string;
    },
  ) {
    super(options.detail ? `${code}: ${options.detail}` : code);
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
  tools?: ProviderToolDefinition[];
  toolChoice?: ProviderToolChoice;
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

function streamAbortContext(options: {
  provider: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
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

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromCaller);
    },
  };
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

function plainJsonObject(
  value: unknown,
  provider: string,
): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderExecutionError("malformed_response", {
      provider,
      detail: "tool arguments must be a JSON object",
    });
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new ProviderExecutionError("malformed_response", {
      provider,
      detail: "tool arguments are not JSON serializable",
    });
  }
  return value as Record<string, JsonValue>;
}

function parseToolArguments(
  value: unknown,
  provider: string,
): Record<string, JsonValue> {
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ProviderExecutionError("malformed_response", {
        provider,
        detail: "tool arguments are not valid JSON",
      });
    }
    return plainJsonObject(parsed, provider);
  }
  return plainJsonObject(value, provider);
}

function toolName(value: unknown, provider: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new ProviderExecutionError("malformed_response", {
      provider,
      detail: "invalid tool name",
    });
  }
  return value;
}

function normalizeOpenAiToolCalls(
  input: unknown,
  provider: string,
): ProviderToolCall[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new ProviderExecutionError("malformed_response", {
      provider,
      detail: "tool_calls must be an array",
    });
  }
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new ProviderExecutionError("malformed_response", { provider });
    }
    const item = raw as {
      id?: unknown;
      type?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    if (item.type !== undefined && item.type !== "function") {
      throw new ProviderExecutionError("malformed_response", {
        provider,
        detail: "unsupported tool call type",
      });
    }
    const name = toolName(item.function?.name, provider);
    return {
      id:
        typeof item.id === "string" && item.id.trim()
          ? item.id
          : `${provider}:tool:${index}:${name}`,
      name,
      arguments: parseToolArguments(item.function?.arguments, provider),
    };
  });
}

function normalizeOllamaToolCalls(
  input: unknown,
  provider: string,
): ProviderToolCall[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new ProviderExecutionError("malformed_response", {
      provider,
      detail: "tool_calls must be an array",
    });
  }
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new ProviderExecutionError("malformed_response", { provider });
    }
    const item = raw as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = toolName(item.function?.name, provider);
    return {
      id:
        typeof item.id === "string" && item.id.trim()
          ? item.id
          : `${provider}:tool:${index}:${name}`,
      name,
      arguments: parseToolArguments(item.function?.arguments, provider),
    };
  });
}

function normalizedTextAndTools(options: {
  provider: string;
  text: unknown;
  toolCalls: ProviderToolCall[];
}): { text: string; toolCalls?: ProviderToolCall[] } {
  const text = typeof options.text === "string" ? options.text : "";
  if (text.trim().length === 0 && options.toolCalls.length === 0) {
    throw new ProviderExecutionError("malformed_response", {
      provider: options.provider,
      detail: "response contains neither text nor tool calls",
    });
  }
  return {
    text,
    ...(options.toolCalls.length === 0 ? {} : { toolCalls: options.toolCalls }),
  };
}

function normalizedTools(
  tools: ProviderToolDefinition[] | undefined,
  provider: string,
): ProviderToolDefinition[] {
  if (!tools) return [];
  const names = new Set<string>();
  return tools.map((tool) => {
    const name = toolName(tool.name, provider);
    if (names.has(name)) {
      throw new ProviderExecutionError("configuration_error", {
        provider,
        detail: "duplicate tool name",
      });
    }
    names.add(name);
    if (
      !tool.parameters ||
      typeof tool.parameters !== "object" ||
      Array.isArray(tool.parameters)
    ) {
      throw new ProviderExecutionError("configuration_error", {
        provider,
        detail: "tool parameters must be a JSON schema object",
      });
    }
    return {
      name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    };
  });
}

function openAiTools(tools: ProviderToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  }));
}

function ollamaTools(tools: ProviderToolDefinition[]) {
  return openAiTools(tools);
}

function toolChoiceForOpenAi(choice: ProviderToolChoice | undefined) {
  if (!choice || choice === "auto") return "auto";
  if (choice === "none") return "none";
  return "required";
}

function ollamaRequestBody(options: {
  model: string;
  messages: ProviderMessage[];
  responseFormat: ProviderResponseFormat;
  maxOutputTokens: number;
  stream: boolean;
  tools: ProviderToolDefinition[];
}) {
  return {
    model: options.model,
    messages: options.messages,
    stream: options.stream,
    ...(options.responseFormat === "json" ? { format: "json" } : {}),
    ...(options.tools.length > 0 ? { tools: ollamaTools(options.tools) } : {}),
    options: { num_predict: options.maxOutputTokens },
  };
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
  const tools = normalizedTools(options.tools, provider);

  if (provider === "ollama") {
    if (options.toolChoice === "required" && tools.length === 0) {
      throw new ProviderExecutionError("configuration_error", {
        provider,
        detail: "required tool choice needs at least one tool",
      });
    }
    return withProviderSignal(
      { provider, timeoutMs, signal: options.signal },
      async (signal) => {
        const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify(
            ollamaRequestBody({
              model,
              messages: options.messages,
              responseFormat,
              maxOutputTokens,
              stream: false,
              tools,
            }),
          ),
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
          message?: { content?: unknown; tool_calls?: unknown };
          prompt_eval_count?: unknown;
          eval_count?: unknown;
        };
        try {
          data = (await response.json()) as typeof data;
        } catch {
          throw new ProviderExecutionError("malformed_response", { provider });
        }

        const toolCalls = normalizeOllamaToolCalls(
          data.message?.tool_calls,
          provider,
        );
        const normalized = normalizedTextAndTools({
          provider,
          text: data.message?.content,
          toolCalls,
        });
        const promptTokens = usageNumber(data.prompt_eval_count);
        const completionTokens = usageNumber(data.eval_count);
        const tokens =
          promptTokens !== undefined && completionTokens !== undefined
            ? promptTokens + completionTokens
            : undefined;
        return {
          ...normalized,
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

  if (options.toolChoice === "required" && tools.length === 0) {
    throw new ProviderExecutionError("configuration_error", {
      provider,
      detail: "required tool choice needs at least one tool",
    });
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
      const request = {
        model,
        messages: options.messages,
        max_tokens: maxOutputTokens,
        ...(responseFormat === "json"
          ? { response_format: { type: "json_object" as const } }
          : {}),
        ...(tools.length > 0
          ? {
              tools: openAiTools(tools),
              tool_choice: toolChoiceForOpenAi(options.toolChoice),
            }
          : {}),
      };
      const completion = (await client.chat.completions.create(request, {
        signal,
      })) as unknown as {
        choices?: Array<{
          message?: { content?: unknown; tool_calls?: unknown };
        }>;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
          total_tokens?: unknown;
        };
      };
      const promptTokens = usageNumber(completion.usage?.prompt_tokens);
      const completionTokens = usageNumber(completion.usage?.completion_tokens);
      const totalTokens =
        usageNumber(completion.usage?.total_tokens) ??
        (promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined);
      const message = completion.choices?.[0]?.message;
      const toolCalls = normalizeOpenAiToolCalls(message?.tool_calls, provider);
      const normalized = normalizedTextAndTools({
        provider,
        text: message?.content,
        toolCalls,
      });

      return {
        ...normalized,
        provider,
        model,
        ...(promptTokens === undefined ? {} : { promptTokens }),
        ...(completionTokens === undefined ? {} : { completionTokens }),
        ...(totalTokens === undefined ? {} : { tokens: totalTokens }),
      };
    },
  );
}

function streamUsageEvent(options: {
  promptTokens?: unknown;
  completionTokens?: unknown;
  tokens?: unknown;
}): ProviderStreamEvent | undefined {
  const promptTokens = usageNumber(options.promptTokens);
  const completionTokens = usageNumber(options.completionTokens);
  const tokens =
    usageNumber(options.tokens) ??
    (promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : undefined);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    tokens === undefined
  ) {
    return undefined;
  }
  return {
    type: "usage",
    ...(promptTokens === undefined ? {} : { promptTokens }),
    ...(completionTokens === undefined ? {} : { completionTokens }),
    ...(tokens === undefined ? {} : { tokens }),
  };
}

async function* streamOllama(
  options: ProviderGenerationOptions & {
    provider: "ollama";
    model: string;
    responseFormat: ProviderResponseFormat;
    maxOutputTokens: number;
    timeoutMs: number;
    tools: ProviderToolDefinition[];
  },
): AsyncGenerator<ProviderStreamEvent> {
  const context = streamAbortContext(options);
  try {
    const response = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: context.signal,
      body: JSON.stringify(
        ollamaRequestBody({
          model: options.model,
          messages: options.messages,
          responseFormat: options.responseFormat,
          maxOutputTokens: options.maxOutputTokens,
          stream: true,
          tools: options.tools,
        }),
      ),
    });
    if (!response.ok) {
      throw new ProviderExecutionError(
        response.status === 429 ? "rate_limited" : "upstream_error",
        {
          provider: options.provider,
          status: response.status,
          retryAfterSeconds:
            response.status === 429
              ? retryAfterSeconds(response.headers)
              : undefined,
        },
      );
    }
    if (!response.body) {
      throw new ProviderExecutionError("malformed_response", {
        provider: options.provider,
        detail: "stream response body is missing",
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let doneSeen = false;

    const consumeLine = function* (
      line: string,
    ): Generator<ProviderStreamEvent> {
      const trimmed = line.trim();
      if (!trimmed) return;
      let chunk: {
        message?: { content?: unknown; tool_calls?: unknown };
        done?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      try {
        chunk = JSON.parse(trimmed) as typeof chunk;
      } catch {
        throw new ProviderExecutionError("malformed_response", {
          provider: options.provider,
          detail: "invalid Ollama stream JSON",
        });
      }
      const content = chunk.message?.content;
      if (typeof content === "string" && content.length > 0) {
        yield { type: "text_delta", text: content };
      } else if (content !== undefined && content !== null) {
        throw new ProviderExecutionError("malformed_response", {
          provider: options.provider,
          detail: "stream content delta is not text",
        });
      }
      const calls = normalizeOllamaToolCalls(
        chunk.message?.tool_calls,
        options.provider,
      );
      for (const toolCall of calls) {
        yield { type: "tool_call", toolCall };
      }
      if (chunk.done === true) {
        const usage = streamUsageEvent({
          promptTokens: chunk.prompt_eval_count,
          completionTokens: chunk.eval_count,
        });
        if (usage) yield usage;
        doneSeen = true;
        yield { type: "done" };
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        yield* consumeLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield* consumeLine(buffer);
    if (!doneSeen) {
      throw new ProviderExecutionError("malformed_response", {
        provider: options.provider,
        detail: "stream ended without done marker",
      });
    }
  } catch (error) {
    throw normalizeProviderError({
      error,
      provider: options.provider,
      externalSignal: options.signal,
      timedOut: context.timedOut(),
    });
  } finally {
    context.cleanup();
  }
}

async function* streamOpenAiCompatible(
  options: ProviderGenerationOptions & {
    provider: "openai" | "openrouter";
    model: string;
    responseFormat: ProviderResponseFormat;
    maxOutputTokens: number;
    timeoutMs: number;
    tools: ProviderToolDefinition[];
  },
): AsyncGenerator<ProviderStreamEvent> {
  const apiKey =
    options.provider === "openrouter"
      ? env.OPENROUTER_API_KEY
      : env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderExecutionError("configuration_error", {
      provider: options.provider,
    });
  }
  const client = new OpenAI({
    apiKey,
    ...(options.provider === "openrouter"
      ? { baseURL: "https://openrouter.ai/api/v1" }
      : {}),
  });
  const context = streamAbortContext(options);
  const toolAccumulators = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  try {
    const request = {
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.responseFormat === "json"
        ? { response_format: { type: "json_object" as const } }
        : {}),
      ...(options.tools.length > 0
        ? {
            tools: openAiTools(options.tools),
            tool_choice: toolChoiceForOpenAi(options.toolChoice),
          }
        : {}),
    };
    const stream = (await client.chat.completions.create(request, {
      signal: context.signal,
    })) as unknown as AsyncIterable<{
      choices?: Array<{
        delta?: {
          content?: unknown;
          tool_calls?: Array<{
            index?: unknown;
            id?: unknown;
            function?: { name?: unknown; arguments?: unknown };
          }>;
        };
      }>;
      usage?: {
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
        total_tokens?: unknown;
      };
    }>;

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        yield { type: "text_delta", text: delta.content };
      } else if (delta?.content !== undefined && delta.content !== null) {
        throw new ProviderExecutionError("malformed_response", {
          provider: options.provider,
          detail: "stream content delta is not text",
        });
      }

      for (const raw of delta?.tool_calls ?? []) {
        const index =
          typeof raw.index === "number" &&
          Number.isSafeInteger(raw.index) &&
          raw.index >= 0
            ? raw.index
            : 0;
        const current = toolAccumulators.get(index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (typeof raw.id === "string") current.id += raw.id;
        if (typeof raw.function?.name === "string") {
          current.name += raw.function.name;
        }
        if (typeof raw.function?.arguments === "string") {
          current.arguments += raw.function.arguments;
        }
        toolAccumulators.set(index, current);
      }

      const usage = streamUsageEvent({
        promptTokens: chunk.usage?.prompt_tokens,
        completionTokens: chunk.usage?.completion_tokens,
        tokens: chunk.usage?.total_tokens,
      });
      if (usage) yield usage;
    }

    for (const [index, raw] of [...toolAccumulators.entries()].sort(
      ([left], [right]) => left - right,
    )) {
      const name = toolName(raw.name, options.provider);
      yield {
        type: "tool_call",
        toolCall: {
          id: raw.id || `${options.provider}:tool:${index}:${name}`,
          name,
          arguments: parseToolArguments(raw.arguments, options.provider),
        },
      };
    }
    yield { type: "done" };
  } catch (error) {
    throw normalizeProviderError({
      error,
      provider: options.provider,
      externalSignal: options.signal,
      timedOut: context.timedOut(),
    });
  } finally {
    context.cleanup();
  }
}

export async function* streamWithProvider(
  options: ProviderGenerationOptions,
): AsyncGenerator<ProviderStreamEvent> {
  const provider = (options.provider ??
    env.DEFAULT_MODEL_PROVIDER) as ModelProviderName;
  const model = options.model ?? env.DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? env.MODEL_REQUEST_TIMEOUT_MS;
  const maxOutputTokens = safePositiveInteger(
    options.maxOutputTokens ?? env.MODEL_MAX_OUTPUT_TOKENS,
    "max_output_tokens",
  );
  const responseFormat = options.responseFormat ?? "text";
  const tools = normalizedTools(options.tools, provider);

  if (options.toolChoice === "required" && tools.length === 0) {
    throw new ProviderExecutionError("configuration_error", {
      provider,
      detail: "required tool choice needs at least one tool",
    });
  }

  if (provider === "ollama") {
    yield* streamOllama({
      ...options,
      provider,
      model,
      responseFormat,
      maxOutputTokens,
      timeoutMs,
      tools,
    });
    return;
  }
  if (provider === "openai" || provider === "openrouter") {
    yield* streamOpenAiCompatible({
      ...options,
      provider,
      model,
      responseFormat,
      maxOutputTokens,
      timeoutMs,
      tools,
    });
    return;
  }
  throw new ProviderExecutionError("configuration_error", { provider });
}
