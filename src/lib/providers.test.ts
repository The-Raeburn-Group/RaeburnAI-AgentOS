import { describe, expect, it, vi } from "vitest";

import {
  generateWithProvider,
  streamWithProvider,
} from "@/lib/providers";
import {
  ProviderExecutionError,
  type ProviderToolDefinition,
} from "@/lib/provider-contract";

function mockFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return vi.fn(implementation) as unknown as typeof fetch;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

const messages = [{ role: "user" as const, content: "Return a safe result." }];

const outputSchema = {
  type: "object" as const,
  properties: {
    answer: { type: "string" as const, minLength: 1 },
    confidence: {
      type: "number" as const,
      minimum: 0,
      maximum: 1,
    },
  },
  required: ["answer", "confidence"],
  additionalProperties: false,
};

const tools: ProviderToolDefinition[] = [
  {
    name: "lookup_record",
    description: "Look up a record by stable identifier.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1 },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

describe("provider execution boundary", () => {
  it("normalizes OpenAI text and usage without exposing provider internals", async () => {
    const fetchImpl = mockFetch(async (input, init) => {
      expect(String(input)).toBe("https://api.openai.com/v1/chat/completions");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer test-openai-key",
      });
      return jsonResponse({
        model: "gpt-test",
        choices: [{ message: { content: "hello" } }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
        },
      });
    });

    const result = await generateWithProvider({
      provider: "openai",
      model: "gpt-test",
      messages,
      fetchImpl,
    });

    expect(result).toMatchObject({
      text: "hello",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 3,
      outputTokens: 2,
      tokens: 5,
    });
    expect(result.latencyMs).toBeTypeOf("number");
  });

  it("sends and independently validates structured output", async () => {
    const fetchImpl = mockFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        response_format?: {
          json_schema?: {
            strict?: boolean;
            schema?: unknown;
          };
        };
      };
      expect(body.response_format?.json_schema?.strict).toBe(true);
      expect(body.response_format?.json_schema?.schema).toEqual(outputSchema);
      return jsonResponse({
        choices: [
          {
            message: {
              content: '{"answer":"verified","confidence":0.8}',
            },
          },
        ],
      });
    });

    const result = await generateWithProvider({
      provider: "openrouter",
      model: "router-test",
      messages,
      outputSchema,
      fetchImpl,
    });
    expect(result.structured).toEqual({
      answer: "verified",
      confidence: 0.8,
    });

    const invalidFetch = mockFetch(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: '{"answer":"missing confidence"}',
            },
          },
        ],
      }),
    );
    await expect(
      generateWithProvider({
        provider: "openai",
        model: "gpt-test",
        messages,
        outputSchema,
        fetchImpl: invalidFetch,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "invalid_structured_output",
    });
  });

  it("normalizes schema-valid OpenAI tool calls and rejects undeclared tools", async () => {
    const validFetch = mockFetch(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "lookup_record",
                    arguments: '{"id":"record-1"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const result = await generateWithProvider({
      provider: "openai",
      model: "gpt-test",
      messages,
      tools,
      fetchImpl: validFetch,
    });
    expect(result.toolCalls).toEqual([
      {
        id: "call-1",
        name: "lookup_record",
        arguments: { id: "record-1" },
      },
    ]);

    const hostileFetch = mockFetch(async () =>
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: "delete_everything",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    await expect(
      generateWithProvider({
        provider: "openai",
        model: "gpt-test",
        messages,
        tools,
        fetchImpl: hostileFetch,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "unexpected_tool_call",
    });
  });

  it("normalizes Ollama content, tool arguments and token counts", async () => {
    const fetchImpl = mockFetch(async (input, init) => {
      expect(String(input)).toBe("http://localhost:11434/api/chat");
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        tools?: unknown[];
      };
      expect(body.stream).toBe(false);
      expect(body.tools).toHaveLength(1);
      return jsonResponse({
        model: "llama-test",
        message: {
          content: "",
          tool_calls: [
            {
              function: {
                name: "lookup_record",
                arguments: { id: "ollama-1" },
              },
            },
          ],
        },
        prompt_eval_count: 10,
        eval_count: 4,
      });
    });

    const result = await generateWithProvider({
      provider: "ollama",
      model: "llama-test",
      messages,
      tools,
      fetchImpl,
    });
    expect(result.tokens).toBe(14);
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "lookup_record",
      arguments: { id: "ollama-1" },
    });
  });

  it("maps rate limits, upstream outages and unknown providers to stable errors", async () => {
    const limited = mockFetch(
      async () =>
        new Response(null, {
          status: 429,
          headers: { "retry-after": "2" },
        }),
    );
    await expect(
      generateWithProvider({
        provider: "openai",
        model: "gpt-test",
        messages,
        fetchImpl: limited,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "provider_rate_limited",
      details: expect.objectContaining({ retryAfterMs: 2_000 }),
    });

    const unavailable = mockFetch(
      async () => new Response(null, { status: 503 }),
    );
    await expect(
      generateWithProvider({
        provider: "openrouter",
        model: "router-test",
        messages,
        fetchImpl: unavailable,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "provider_unavailable",
    });

    await expect(
      generateWithProvider({
        provider: "not-a-real-provider",
        model: "x",
        messages,
        fetchImpl: unavailable,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "unsupported_provider",
    });
  });

  it("fails closed on malformed and oversized responses", async () => {
    const malformed = mockFetch(
      async () =>
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama-test",
        messages,
        fetchImpl: malformed,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "provider_malformed_response",
    });

    const oversized = mockFetch(
      async () =>
        new Response("0123456789", {
          status: 200,
          headers: { "content-length": "10" },
        }),
    );
    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama-test",
        messages,
        maxResponseBytes: 5,
        fetchImpl: oversized,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "provider_response_too_large",
    });
  });

  it("distinguishes request timeout from caller cancellation", async () => {
    const waitingFetch = mockFetch(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );

    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama-test",
        messages,
        timeoutMs: 5,
        fetchImpl: waitingFetch,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "provider_timeout",
    });

    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama-test",
        messages,
        signal: controller.signal,
        fetchImpl: waitingFetch,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "provider_cancelled",
    });
  });

  it("streams OpenAI-compatible SSE text and requires an explicit terminal frame", async () => {
    const fetchImpl = mockFetch(
      async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"hel"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"lo"}}]}',
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
    );

    const events = [];
    for await (const event of streamWithProvider({
      provider: "openai",
      model: "gpt-test",
      messages,
      fetchImpl,
    })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text_delta", delta: "hel" },
      { type: "text_delta", delta: "lo" },
      { type: "done", provider: "openai", model: "gpt-test" },
    ]);

    const truncated = mockFetch(
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n', {
          status: 200,
        }),
    );
    await expect(async () => {
      for await (const event of streamWithProvider({
        provider: "openai",
        model: "gpt-test",
        messages,
        fetchImpl: truncated,
      })) {
        void event;
      }
    }).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "provider_malformed_response",
    });
  });

  it("streams Ollama NDJSON and rejects tool/structured streaming combinations", async () => {
    const fetchImpl = mockFetch(
      async () =>
        new Response(
          [
            '{"message":{"content":"one"},"done":false}',
            '{"message":{"content":" two"},"done":false}',
            '{"message":{"content":""},"done":true}',
            "",
          ].join("\n"),
          { status: 200 },
        ),
    );

    const text: string[] = [];
    for await (const event of streamWithProvider({
      provider: "ollama",
      model: "llama-test",
      messages,
      fetchImpl,
    })) {
      if (event.type === "text_delta") text.push(event.delta);
    }
    expect(text.join("")).toBe("one two");

    await expect(async () => {
      for await (const event of streamWithProvider({
        provider: "ollama",
        model: "llama-test",
        messages,
        tools,
        fetchImpl,
      })) {
        void event;
      }
    }).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "unsupported_streaming_combination",
    });
  });

  it("does not include provider response bodies in public errors", async () => {
    const fetchImpl = mockFetch(
      async () => new Response("secret-provider-debug-body", { status: 400 }),
    );
    let caught: unknown;
    try {
      await generateWithProvider({
        provider: "ollama",
        model: "llama-test",
        messages,
        fetchImpl,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderExecutionError);
    expect(String((caught as Error).message)).not.toContain("secret-provider");
  });
});
