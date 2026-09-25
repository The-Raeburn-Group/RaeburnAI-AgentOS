import { afterEach, describe, expect, it, vi } from "vitest";

const openAiMock = vi.hoisted(() => ({
  create: vi.fn(),
  constructors: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => ({
  default: class OpenAIMock {
    chat = { completions: { create: openAiMock.create } };

    constructor(options: Record<string, unknown>) {
      openAiMock.constructors.push(options);
    }
  },
}));

vi.mock("@/lib/env", () => ({
  env: {
    DEFAULT_MODEL_PROVIDER: "ollama",
    DEFAULT_MODEL: "llama3.1",
    OLLAMA_BASE_URL: "http://ollama.test",
    OPENAI_API_KEY: "test-openai-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    MODEL_REQUEST_TIMEOUT_MS: 1000,
    MODEL_MAX_OUTPUT_TOKENS: 128,
  },
}));

import {
  generateWithProvider,
  ProviderExecutionError,
  streamWithProvider,
  type ProviderStreamEvent,
} from "@/lib/providers";

const weatherTool = {
  name: "get_weather",
  description: "Look up the current weather.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" },
    },
    required: ["city"],
    additionalProperties: false,
  },
} as const;

async function collect(
  stream: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function ndjsonStream(lines: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
      }
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  openAiMock.constructors.length = 0;
});

describe("shared provider runtime contract", () => {
  it("normalizes Ollama function calls and forwards a bounded tool schema", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "llama3.1",
        stream: false,
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Look up the current weather.",
            },
          },
        ],
      });
      return new Response(
        JSON.stringify({
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "get_weather",
                  arguments: { city: "Southampton" },
                },
              },
            ],
          },
          prompt_eval_count: 8,
          eval_count: 3,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama3.1",
        messages: [{ role: "user", content: "weather" }],
        tools: [weatherTool],
        toolChoice: "required",
      }),
    ).resolves.toEqual({
      text: "",
      provider: "ollama",
      model: "llama3.1",
      promptTokens: 8,
      completionTokens: 3,
      tokens: 11,
      toolCalls: [
        {
          id: "ollama:tool:0:get_weather",
          name: "get_weather",
          arguments: { city: "Southampton" },
        },
      ],
    });
  });

  it.each(["openai", "openrouter"] as const)(
    "normalizes %s function calls and preserves provider identity",
    async (provider) => {
      openAiMock.create.mockResolvedValue({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"Southampton"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 2,
          total_tokens: 11,
        },
      });

      const response = await generateWithProvider({
        provider,
        model: "provider-model",
        messages: [{ role: "user", content: "weather" }],
        tools: [weatherTool],
        toolChoice: "required",
      });

      expect(response).toMatchObject({
        text: "",
        provider,
        model: "provider-model",
        toolCalls: [
          {
            id: "call-1",
            name: "get_weather",
            arguments: { city: "Southampton" },
          },
        ],
      });
      expect(openAiMock.create).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tools: [
            expect.objectContaining({
              type: "function",
              function: expect.objectContaining({ name: "get_weather" }),
            }),
          ],
          tool_choice: "required",
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    },
  );

  it("fails closed on malformed tool arguments instead of emitting an unsafe tool call", async () => {
    openAiMock.create.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: "not-json",
                },
              },
            ],
          },
        },
      ],
    });

    await expect(
      generateWithProvider({
        provider: "openai",
        model: "provider-model",
        messages: [{ role: "user", content: "weather" }],
        tools: [weatherTool],
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "malformed_response",
    });
  });

  it("normalizes Ollama streaming text, tool calls, usage and completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          ndjsonStream([
            { message: { content: "The " }, done: false },
            { message: { content: "answer." }, done: false },
            {
              message: {
                content: "",
                tool_calls: [
                  {
                    function: {
                      name: "get_weather",
                      arguments: { city: "Southampton" },
                    },
                  },
                ],
              },
              done: false,
            },
            {
              done: true,
              prompt_eval_count: 10,
              eval_count: 4,
            },
          ]),
          { status: 200, headers: { "content-type": "application/x-ndjson" } },
        );
      }),
    );

    await expect(
      collect(
        streamWithProvider({
          provider: "ollama",
          model: "llama3.1",
          messages: [{ role: "user", content: "stream" }],
          tools: [weatherTool],
        }),
      ),
    ).resolves.toEqual([
      { type: "text_delta", text: "The " },
      { type: "text_delta", text: "answer." },
      {
        type: "tool_call",
        toolCall: {
          id: "ollama:tool:0:get_weather",
          name: "get_weather",
          arguments: { city: "Southampton" },
        },
      },
      {
        type: "usage",
        promptTokens: 10,
        completionTokens: 4,
        tokens: 14,
      },
      { type: "done" },
    ]);
  });

  it("assembles fragmented OpenAI-compatible streamed tool calls deterministically", async () => {
    openAiMock.create.mockResolvedValue(
      (async function* () {
        yield {
          choices: [
            {
              delta: {
                content: "Checking ",
                tool_calls: [
                  {
                    index: 0,
                    id: "call-",
                    function: {
                      name: "get_",
                      arguments: '{"city":"South',
                    },
                  },
                ],
              },
            },
          ],
        };
        yield {
          choices: [
            {
              delta: {
                content: "weather.",
                tool_calls: [
                  {
                    index: 0,
                    id: "1",
                    function: {
                      name: "weather",
                      arguments: 'ampton"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
          },
        };
      })(),
    );

    await expect(
      collect(
        streamWithProvider({
          provider: "openai",
          model: "provider-model",
          messages: [{ role: "user", content: "stream tool" }],
          tools: [weatherTool],
        }),
      ),
    ).resolves.toEqual([
      { type: "text_delta", text: "Checking " },
      { type: "text_delta", text: "weather." },
      {
        type: "usage",
        promptTokens: 12,
        completionTokens: 6,
        tokens: 18,
      },
      {
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "get_weather",
          arguments: { city: "Southampton" },
        },
      },
      { type: "done" },
    ]);
  });

  it("fails a truncated Ollama stream instead of fabricating completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            ndjsonStream([{ message: { content: "partial" }, done: false }]),
            { status: 200 },
          ),
      ),
    );

    await expect(
      collect(
        streamWithProvider({
          provider: "ollama",
          model: "llama3.1",
          messages: [{ role: "user", content: "stream" }],
        }),
      ),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "malformed_response",
    });
  });

  it("applies timeout semantics across the lifetime of an OpenAI-compatible stream", async () => {
    openAiMock.create.mockImplementation(
      async (
        _request: unknown,
        options: { signal?: AbortSignal } | undefined,
      ) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        },
      }),
    );

    await expect(
      collect(
        streamWithProvider({
          provider: "openai",
          model: "provider-model",
          messages: [{ role: "user", content: "slow stream" }],
          timeoutMs: 10,
        }),
      ),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "timeout",
    });
  });

  it("rejects duplicate or invalid tool definitions before provider dispatch", async () => {
    await expect(
      generateWithProvider({
        provider: "openai",
        model: "provider-model",
        messages: [{ role: "user", content: "test" }],
        tools: [weatherTool, weatherTool],
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "configuration_error",
    });
    expect(openAiMock.create).not.toHaveBeenCalled();
  });
});
