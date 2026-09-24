# Provider Execution Contract

AgentOS uses `raeburnai.provider-execution.v1` as the normalized boundary between governed workflows and model-provider HTTP APIs.

## Scope

The current adapter contract covers OpenAI-compatible OpenAI/OpenRouter chat endpoints and Ollama chat. It provides:

- explicit provider allow-listing; unknown provider names fail closed;
- configured credential checks before cloud dispatch;
- hard request timeouts and caller cancellation propagation;
- bounded response bytes for both normal and streaming calls;
- stable rate-limit, rejection, outage, timeout, cancellation, malformed-response and oversize error classes;
- normalized text and token usage;
- optional structured output with provider-native schema hints plus independent local post-response validation;
- declared tool/function schemas with local argument validation and rejection of unexpected tool names;
- OpenAI-compatible SSE text streaming and Ollama NDJSON text streaming;
- no provider response-body echoing in public errors.

## Structured output

A caller may supply the bounded `StructuredOutputSchema` subset. The schema itself is validated before dispatch. Returned JSON is parsed and checked again locally; provider claims that a response matches the requested schema are not trusted.

Undeclared object fields are rejected unless `additionalProperties: true` is explicitly requested. Schema depth, property counts, enum sizes, array/string bounds and numeric bounds are constrained.

Structured output is an execution-format guarantee only. It does not establish factual correctness; factual/evidence assurance remains the responsibility of the Evidence Protocol and independent verifier.

## Tools

Tool definitions are capped, named through a restricted identifier grammar and must carry a validated input schema. Returned tool calls are accepted only when the tool name was declared for the request and arguments pass the same local schema validation.

This layer **does not execute tools** and does not replace tenant, MCP, approval, prompt-injection or egress controls.

## Streaming and cancellation

`streamWithProvider` supports text-only streaming. Structured-output or tool-call streaming currently fails closed with `unsupported_streaming_combination` rather than exposing a partially validated stream.

The request timeout remains active for the full stream. OpenAI-compatible streams require valid SSE data frames and an explicit `[DONE]` terminal marker; Ollama requires valid NDJSON frames and `done: true`. Truncated streams fail rather than being silently accepted as complete.

## Failure handling

Provider HTTP bodies are deliberately not surfaced through `ProviderExecutionError`. Stable codes are intended for retry/fallback policy:

| Condition | Error |
| --- | --- |
| Unknown provider | `unsupported_provider` |
| Missing cloud credential | `provider_not_configured` |
| HTTP 429 | `provider_rate_limited` |
| HTTP 408 / 5xx | `provider_unavailable` |
| Other non-2xx | `provider_rejected` |
| Local timeout | `provider_timeout` |
| Caller abort | `provider_cancelled` |
| Invalid JSON/shape/truncated stream | `provider_malformed_response` |
| Response byte cap exceeded | `provider_response_too_large` |

## Verification

`npm run providers:verify` is a deterministic mocked-provider gate. It exercises all three adapter families without external credentials or network calls, including structured output, tool calls, 429 handling, provider outages, timeout/cancellation, malformed/oversized responses, SSE, NDJSON and error-body non-disclosure.

The normal CI suite also runs the same tests as part of `npm test`.

## Explicit limits

This implementation is not evidence that any external provider is commercially enabled, currently available, licensed for a specific use, resident in an approved geography or deployed in production. No live-provider smoke run is claimed by the mocked contract suite.

Streaming is not yet wired through the complete AgentOS/Chain user-facing lifecycle, and tool-call streaming remains intentionally unsupported until partial-tool-call assembly can be validated safely. Provider-specific image/audio/video request contracts remain separate future work.
