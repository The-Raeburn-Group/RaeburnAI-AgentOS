# Provider Runtime Contract

AgentOS uses a shared runtime contract for supported model providers so that provider-specific SDK or HTTP differences cannot leak into workflow behavior.

## Supported providers

The current contract covers:

- Ollama;
- OpenAI-compatible OpenAI; and
- OpenRouter through the OpenAI-compatible API surface.

This contract is an application/runtime abstraction. It is not evidence that every provider/model is legally approved, production-enabled or benchmark-qualified. Model eligibility remains governed by \`raeburnai.model-registry.v1\`.

## Non-streaming contract

\`generateWithProvider()\` normalizes:

- provider/model identity;
- text;
- prompt/completion/total token counts when supplied;
- provider-native JSON response mode;
- function/tool calls;
- caller cancellation;
- provider timeout;
- HTTP rate limits including Retry-After;
- upstream errors; and
- malformed successful responses.

A successful response must contain non-empty text, at least one valid tool call, or both. Empty successful responses fail closed.

Tool calls use the normalized shape:

- \`id\`;
- \`name\`; and
- JSON-object \`arguments\`.

Malformed JSON arguments, invalid tool names and unsupported tool-call structures fail as \`malformed_response\` rather than reaching workflow execution.

## Streaming contract

\`streamWithProvider()\` emits normalized events:

- \`text_delta\`;
- \`tool_call\`;
- \`usage\`; and
- \`done\`.

Ollama NDJSON streams must terminate with an explicit \`done\` marker. Truncated/malformed streams fail rather than being treated as completed output.

OpenAI-compatible streaming assembles fragmented function-call name/argument deltas before emitting a normalized tool call. The same timeout/cancellation classification applies across the full stream lifetime rather than only the initial HTTP connection.

## Structured output

Provider-native JSON mode is only the transport hint. The governed model path can additionally receive an AgentOS output contract.

For a JSON output contract:

1. the provider is asked for JSON mode;
2. the returned JSON is parsed and checked for required fields, property types, additional-property policy and byte limits;
3. parsed structured output is attached to the normalized provider response; and
4. invalid output is rejected before the workflow can consume it.

Provider usage remains financially truthful when output validation fails. If the upstream provider returned a metered response, actual usage/cost is committed with \`output_validation=failed\` before the structured-output error is surfaced. Reservations are released only when dispatch fails before a metered response is available.

## Tool execution boundary

Provider tool-call normalization does **not** grant tool execution authority.

The current workflow orchestrator fails when a model returns a tool call because governed workflow tool dispatch is a separate security boundary. This prevents a provider tool call from silently becoming an empty successful workflow output. Future tool execution must pass the existing MCP/tool policy, approval, tenancy, idempotency and audit controls.

## Contract testing

\`npm run provider:contract\` executes the deterministic provider contract suite. It covers:

- Ollama text/JSON behavior;
- OpenAI/OpenRouter compatible response normalization;
- tool schema forwarding;
- tool-call normalization;
- malformed tool arguments;
- Ollama streaming;
- OpenAI-compatible streamed function-call assembly;
- truncated streams;
- stream-lifetime timeouts;
- provider cancellation/rate-limit/malformed-response behavior; and
- structured-output validation.

The ordinary full test suite separately proves the PostgreSQL usage/reservation behavior and governed workflow failure paths.

The dedicated provider contract step is mandatory in CI so provider-runtime drift is visible as its own release gate.

## Current limits

This implementation does not yet claim:

- live provider smoke tests in CI;
- provider-specific image/audio/video request contracts;
- governed automatic execution of normalized tool calls;
- cross-provider streaming usage parity for every model;
- production endpoint/licensing approval;
- provider retry orchestration beyond the existing higher-level workflow behavior; or
- that current registry entries are production-qualified.

Those remain separate tracked delivery items.
