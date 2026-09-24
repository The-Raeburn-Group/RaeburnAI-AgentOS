import { env } from "@/lib/env";
import {
  normalizeToolCall,
  parseRetryAfterMs,
  parseStructuredProviderText,
  ProviderExecutionError,
  type ProviderToolDefinition,
  type StructuredOutputSchema,
  validateStructuredOutputSchema,
  validateToolDefinitions,
} from "@/lib/provider-contract";
import type {
  ProviderMessage,
  ProviderResponse,
  ProviderStreamEvent,
} from "@/lib/types";

export type ModelProviderName = "openai" | "openrouter" | "ollama";

type FetchImplementation = typeof fetch;

export interface ProviderExecutionOptions {
  provider?: ModelProviderName | string;
  model?: string;
  messages: ProviderMessage[];
  outputSchema?: StructuredOutputSchema;
  tools?: ProviderToolDefinition[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: FetchImplementation;
}

interface AbortScope {
  signal: AbortSignal;
  timedOut: () => boolean;
  externallyCancelled: () => boolean;
  cleanup: () => void;
}

function modelProviderName(input: string): ModelProviderName {
  if (input === "openai" || input === "openrouter" || input === "ollama") {
    return input;
  }
  throw new ProviderExecutionError("unsupported_provider", {
    provider: input,
  });
}

function createAbortScope(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortScope {
  const controller = new AbortController();
  let timeoutTriggered = false;
  let externalTriggered = false;

  const onExternalAbort = () => {
    externalTriggered = true;
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timeoutTriggered = true;
    controller.abort(new DOMException("Provider request timed out", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    externallyCancelled: () => externalTriggered,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new ProviderExecutionError("provider_rejected");
  }
  return candidate;
}

function credentials(provider: ModelProviderName): {
  url: string;
  headers: Record<string, string>;
} {
  if (provider === "ollama") {
    return {
      url: `${env.OLLAMA_BASE_URL.replace(/\/+$/, "")}/api/chat`,
      headers: { "content-type": "application/json" },
    };
  }

  const apiKey =
    provider === "openrouter" ? env.OPENROUTER_API_KEY : env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new ProviderExecutionError("provider_not_configured", { provider });
  }

  return {
    url:
      provider === "openrouter"
        ? "https://openrouter.ai/api/v1/chat/completions"
        : "https://api.openai.com/v1/chat/completions",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
  };
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The original provider error remains authoritative.
  }
}

async function assertSuccessfulResponse(
  response: Response,
  provider: ModelProviderName,
): Promise<void> {
  if (response.ok) return;

  const status = response.status;
  await cancelBody(response);
  if (status === 429) {
    throw new ProviderExecutionError("provider_rate_limited", {
      provider,
      status,
      retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
    });
  }
  if (status >= 500 || status === 408) {
    throw new ProviderExecutionError("provider_unavailable", {
      provider,
      status,
    });
  }
  throw new ProviderExecutionError("provider_rejected", {
    provider,
    status,
  });
}

async function* boundedResponseTextChunks(
  response: Response,
  maximumBytes: number,
): AsyncGenerator<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > maximumBytes) {
      await cancelBody(response);
      throw new ProviderExecutionError("provider_response_too_large");
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new ProviderExecutionError("provider_response_too_large");
    }
    if (text) yield text;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new ProviderExecutionError("provider_response_too_large");
      }
      const decoded = decoder.decode(result.value, { stream: true });
      if (decoded) yield decoded;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Reader cleanup must not replace the provider outcome.
    }
  }
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  let text = "";
  for await (const chunk of boundedResponseTextChunks(response, maximumBytes)) {
    text += chunk;
  }
  return text;
}

function parseJson(text: string, provider: ModelProviderName): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

function normalizeOpenAiCompatibleResponse(options: {
  payload: unknown;
  provider: "openai" | "openrouter";
  requestedModel: string;
  outputSchema?: StructuredOutputSchema;
  tools: ProviderToolDefinition[];
  latencyMs: number;
}): ProviderResponse {
  if (!isRecord(options.payload) || !Array.isArray(options.payload.choices)) {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider: options.provider,
    });
  }
  const choice = options.payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider: options.provider,
    });
  }

  const content = choice.message.content;
  if (content !== null && content !== undefined && typeof content !== "string") {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider: options.provider,
    });
  }

  const rawToolCalls = choice.message.tool_calls;
  const toolCalls =
    rawToolCalls === undefined
      ? []
      : Array.isArray(rawToolCalls)
        ? rawToolCalls.map((item) => {
            if (
              !isRecord(item) ||
              !isRecord(item.function) ||
              typeof item.function.name !== "string"
            ) {
              throw new ProviderExecutionError("provider_malformed_response", {
                provider: options.provider,
              });
            }
            return normalizeToolCall(
              {
                id: item.id,
                name: item.function.name,
                arguments: item.function.arguments,
              },
              options.tools,
            );
          })
        : (() => {
            throw new ProviderExecutionError("provider_malformed_response", {
              provider: options.provider,
            });
          })();

  const text = content ?? "";
  if (!text && toolCalls.length === 0) {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider: options.provider,
    });
  }

  const usage = isRecord(options.payload.usage) ? options.payload.usage : {};
  const inputTokens = safeTokenCount(usage.prompt_tokens);
  const outputTokens = safeTokenCount(usage.completion_tokens);
  const totalTokens = safeTokenCount(usage.total_tokens);
  const structured = options.outputSchema
    ? parseStructuredProviderText(text, options.outputSchema)
    : undefined;

  return {
    text,
    provider: options.provider,
    model:
      typeof options.payload.model === "string"
        ? options.payload.model
        : options.requestedModel,
    ...(totalTokens !== undefined ? { tokens: totalTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    latencyMs: options.latencyMs,
    ...(structured !== undefined ? { structured } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function normalizeOllamaResponse(options: {
  payload: unknown;
  requestedModel: string;
  outputSchema?: StructuredOutputSchema;
  tools: ProviderToolDefinition[];
  latencyMs: number;
}): ProviderResponse {
  if (!isRecord(options.payload) || !isRecord(options.payload.message)) {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider: "ollama",
    });
  }
  const content = options.payload.message.content;
  if (content !== undefined && typeof content !== "string") {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider: "ollama",
    });
  }

  const rawToolCalls = options.payload.message.tool_calls;
  const toolCalls =
    rawToolCalls === undefined
      ? []
      : Array.isArray(rawToolCalls)
        ? rawToolCalls.map((item) => {
            if (!isRecord(item) || !isRecord(item.function)) {
              throw new ProviderExecutionError("provider_malformed_response", {
                provider: "ollama",
              });
            }
            return normalizeToolCall(
              {
                name: item.function.name,
                arguments: item.function.arguments,
              },
              options.tools,
            );
          })
        : (() => {
            throw new ProviderExecutionError("provider_malformed_response", {
              provider: "ollama",
            });
          })();

  const text = content ?? "";
  if (!text && toolCalls.length === 0) {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider: "ollama",
    });
  }

  const inputTokens = safeTokenCount(options.payload.prompt_eval_count);
  const outputTokens = safeTokenCount(options.payload.eval_count);
  const tokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  const structured = options.outputSchema
    ? parseStructuredProviderText(text, options.outputSchema)
    : undefined;

  return {
    text,
    provider: "ollama",
    model:
      typeof options.payload.model === "string"
        ? options.payload.model
        : options.requestedModel,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    latencyMs: options.latencyMs,
    ...(structured !== undefined ? { structured } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function openAiCompatibleBody(options: {
  model: string;
  messages: ProviderMessage[];
  stream: boolean;
  outputSchema?: StructuredOutputSchema;
  tools: ProviderToolDefinition[];
}) {
  return {
    model: options.model,
    messages: options.messages,
    stream: options.stream,
    ...(options.outputSchema
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "raeburn_structured_output",
              strict: true,
              schema: options.outputSchema,
            },
          },
        }
      : {}),
    ...(options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
              strict: true,
            },
          })),
          tool_choice: "auto",
        }
      : {}),
  };
}

function ollamaBody(options: {
  model: string;
  messages: ProviderMessage[];
  stream: boolean;
  outputSchema?: StructuredOutputSchema;
  tools: ProviderToolDefinition[];
}) {
  return {
    model: options.model,
    messages: options.messages,
    stream: options.stream,
    ...(options.outputSchema ? { format: options.outputSchema } : {}),
    ...(options.tools.length > 0
      ? {
          tools: options.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }
      : {}),
  };
}

function mapTransportError(
  error: unknown,
  provider: ModelProviderName,
  scope: AbortScope,
): never {
  if (error instanceof ProviderExecutionError) throw error;
  if (scope.timedOut()) {
    throw new ProviderExecutionError("provider_timeout", { provider });
  }
  if (scope.externallyCancelled()) {
    throw new ProviderExecutionError("provider_cancelled", { provider });
  }
  throw new ProviderExecutionError("provider_unavailable", { provider });
}

function executionInputs(options: ProviderExecutionOptions) {
  const provider = modelProviderName(
    options.provider ?? env.DEFAULT_MODEL_PROVIDER,
  );
  const model = options.model ?? env.DEFAULT_MODEL;
  const tools = validateToolDefinitions(options.tools);
  const outputSchema = options.outputSchema
    ? validateStructuredOutputSchema(options.outputSchema)
    : undefined;
  const timeoutMs = normalizePositiveInteger(
    options.timeoutMs,
    env.PROVIDER_REQUEST_TIMEOUT_MS,
    300_000,
  );
  const maxResponseBytes = normalizePositiveInteger(
    options.maxResponseBytes,
    env.PROVIDER_MAX_RESPONSE_BYTES,
    16_777_216,
  );
  return {
    provider,
    model,
    tools,
    outputSchema,
    timeoutMs,
    maxResponseBytes,
    fetchImpl: options.fetchImpl ?? fetch,
  };
}

export async function generateWithProvider(
  options: ProviderExecutionOptions,
): Promise<ProviderResponse> {
  const execution = executionInputs(options);
  const endpoint = credentials(execution.provider);
  const scope = createAbortScope(options.signal, execution.timeoutMs);
  const startedAt = Date.now();

  try {
    const body =
      execution.provider === "ollama"
        ? ollamaBody({
            model: execution.model,
            messages: options.messages,
            stream: false,
            outputSchema: execution.outputSchema,
            tools: execution.tools,
          })
        : openAiCompatibleBody({
            model: execution.model,
            messages: options.messages,
            stream: false,
            outputSchema: execution.outputSchema,
            tools: execution.tools,
          });

    const response = await execution.fetchImpl(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify(body),
      signal: scope.signal,
    });
    await assertSuccessfulResponse(response, execution.provider);
    const text = await readBoundedResponseText(
      response,
      execution.maxResponseBytes,
    );
    const payload = parseJson(text, execution.provider);
    const latencyMs = Math.max(0, Date.now() - startedAt);

    return execution.provider === "ollama"
      ? normalizeOllamaResponse({
          payload,
          requestedModel: execution.model,
          outputSchema: execution.outputSchema,
          tools: execution.tools,
          latencyMs,
        })
      : normalizeOpenAiCompatibleResponse({
          payload,
          provider: execution.provider,
          requestedModel: execution.model,
          outputSchema: execution.outputSchema,
          tools: execution.tools,
          latencyMs,
        });
  } catch (error) {
    return mapTransportError(error, execution.provider, scope);
  } finally {
    scope.cleanup();
  }
}

function extractOpenAiStreamDelta(
  payload: unknown,
  provider: "openai" | "openrouter",
): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider,
    });
  }
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.delta)) {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider,
    });
  }
  const content = choice.delta.content;
  if (content === null || content === undefined) return "";
  if (typeof content !== "string") {
    throw new ProviderExecutionError("provider_malformed_response", {
      provider,
    });
  }
  return content;
}

export async function* streamWithProvider(
  options: ProviderExecutionOptions,
): AsyncGenerator<ProviderStreamEvent> {
  const execution = executionInputs(options);
  if (execution.outputSchema || execution.tools.length > 0) {
    throw new ProviderExecutionError("unsupported_streaming_combination", {
      provider: execution.provider,
    });
  }
  const endpoint = credentials(execution.provider);
  const scope = createAbortScope(options.signal, execution.timeoutMs);

  try {
    const body =
      execution.provider === "ollama"
        ? ollamaBody({
            model: execution.model,
            messages: options.messages,
            stream: true,
            tools: [],
          })
        : openAiCompatibleBody({
            model: execution.model,
            messages: options.messages,
            stream: true,
            tools: [],
          });
    const response = await execution.fetchImpl(endpoint.url, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify(body),
      signal: scope.signal,
    });
    await assertSuccessfulResponse(response, execution.provider);

    let buffer = "";
    let sawFrame = false;
    let sawDone = false;

    for await (const chunk of boundedResponseTextChunks(
      response,
      execution.maxResponseBytes,
    )) {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = rawLine.endsWith("\r")
          ? rawLine.slice(0, -1)
          : rawLine;
        if (!line.trim()) continue;

        if (execution.provider === "ollama") {
          const payload = parseJson(line, "ollama");
          if (!isRecord(payload)) {
            throw new ProviderExecutionError("provider_malformed_response", {
              provider: "ollama",
            });
          }
          sawFrame = true;
          if (isRecord(payload.message)) {
            const delta = payload.message.content;
            if (delta !== undefined && typeof delta !== "string") {
              throw new ProviderExecutionError("provider_malformed_response", {
                provider: "ollama",
              });
            }
            if (delta) yield { type: "text_delta", delta };
          }
          if (payload.done === true) sawDone = true;
          continue;
        }

        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          sawDone = true;
          continue;
        }
        const payload = parseJson(data, execution.provider);
        sawFrame = true;
        const delta = extractOpenAiStreamDelta(payload, execution.provider);
        if (delta) yield { type: "text_delta", delta };
      }
    }

    if (buffer.trim()) {
      if (execution.provider === "ollama") {
        const payload = parseJson(buffer.trim(), "ollama");
        if (!isRecord(payload)) {
          throw new ProviderExecutionError("provider_malformed_response", {
            provider: "ollama",
          });
        }
        sawFrame = true;
        if (isRecord(payload.message)) {
          const delta = payload.message.content;
          if (delta !== undefined && typeof delta !== "string") {
            throw new ProviderExecutionError("provider_malformed_response", {
              provider: "ollama",
            });
          }
          if (delta) yield { type: "text_delta", delta };
        }
        if (payload.done === true) sawDone = true;
      } else {
        const line = buffer.trim();
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            sawDone = true;
          } else if (data) {
            const payload = parseJson(data, execution.provider);
            sawFrame = true;
            const delta = extractOpenAiStreamDelta(
              payload,
              execution.provider,
            );
            if (delta) yield { type: "text_delta", delta };
          }
        }
      }
    }

    if (!sawFrame || !sawDone) {
      throw new ProviderExecutionError("provider_malformed_response", {
        provider: execution.provider,
      });
    }
    yield {
      type: "done",
      provider: execution.provider,
      model: execution.model,
    };
  } catch (error) {
    return mapTransportError(error, execution.provider, scope);
  } finally {
    scope.cleanup();
  }
}
