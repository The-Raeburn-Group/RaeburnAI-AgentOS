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

import { generateWithProvider, ProviderExecutionError } from "@/lib/providers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  openAiMock.constructors.length = 0;
});

describe("provider execution contract", () => {
  it("normalizes Ollama text, token usage and bounded generation", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "llama3.1",
        stream: false,
        options: { num_predict: 64 },
      });
      expect(body.format).toBeUndefined();
      return new Response(
        JSON.stringify({
          message: { content: "hello" },
          prompt_eval_count: 7,
          eval_count: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama3.1",
        messages: [{ role: "user", content: "hello" }],
        maxOutputTokens: 64,
      }),
    ).resolves.toEqual({
      text: "hello",
      provider: "ollama",
      model: "llama3.1",
      promptTokens: 7,
      completionTokens: 5,
      tokens: 12,
    });
  });

  it("requests provider-native JSON mode for governed structured output", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.format).toBe("json");
      return new Response(
        JSON.stringify({ message: { content: '{"ok":true}' } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama3.1",
        messages: [{ role: "user", content: "return json" }],
        responseFormat: "json",
      }),
    ).resolves.toMatchObject({ text: '{"ok":true}' });
  });

  it("normalizes OpenAI and OpenRouter usage without leaking SDK differences", async () => {
    openAiMock.create.mockResolvedValue({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 4,
        total_tokens: 15,
      },
    });

    const openai = await generateWithProvider({
      provider: "openai",
      model: "gpt-test",
      messages: [{ role: "user", content: "test" }],
      responseFormat: "json",
      maxOutputTokens: 77,
    });
    expect(openai).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      promptTokens: 11,
      completionTokens: 4,
      tokens: 15,
    });
    expect(openAiMock.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: "gpt-test",
        max_tokens: 77,
        response_format: { type: "json_object" },
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    const openrouter = await generateWithProvider({
      provider: "openrouter",
      model: "router-test",
      messages: [{ role: "user", content: "test" }],
    });
    expect(openrouter.provider).toBe("openrouter");
    expect(openAiMock.constructors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ apiKey: "test-openai-key" }),
        expect.objectContaining({
          apiKey: "test-openrouter-key",
          baseURL: "https://openrouter.ai/api/v1",
        }),
      ]),
    );
  });

  it("fails closed on malformed successful responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama3.1",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "malformed_response",
    });
  });

  it("turns HTTP 429 into a bounded rate-limit error with retry guidance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", {
            status: 429,
            headers: { "retry-after": "3" },
          }),
      ),
    );

    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama3.1",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "rate_limited",
      options: expect.objectContaining({
        provider: "ollama",
        status: 429,
        retryAfterSeconds: 3,
      }),
    });
  });

  it("propagates caller cancellation distinctly from provider timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const pending = generateWithProvider({
      provider: "ollama",
      model: "llama3.1",
      messages: [{ role: "user", content: "cancel" }],
      signal: controller.signal,
      timeoutMs: 1000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject<
      Partial<ProviderExecutionError>
    >({
      code: "cancelled",
    });
  });

  it("enforces provider timeouts even when upstream never returns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );

    await expect(
      generateWithProvider({
        provider: "ollama",
        model: "llama3.1",
        messages: [{ role: "user", content: "timeout" }],
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "timeout",
    });
  });

  it("rejects unknown providers and missing configured credentials", async () => {
    await expect(
      generateWithProvider({
        provider: "unsupported",
        model: "x",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toMatchObject<Partial<ProviderExecutionError>>({
      code: "configuration_error",
    });
  });
});
