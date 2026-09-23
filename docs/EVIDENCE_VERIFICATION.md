# Evidence Verification Core

AgentOS implements \`raeburnai.evidence-verification.v1\` as the deterministic verification layer that sits after the existing \`raeburnai.evidence-protocol.v1\` adjudication contract.

The purpose of this layer is to stop a model from being the authority for its own citations, calculations or critic findings. It consumes a trusted source catalog supplied by the retrieval/tool boundary and independently evaluates the evidence bundle before a high-value response can be treated as verified.

## What v1 verifies

The verifier checks five separate dimensions:

1. **Source integrity** — every trusted source carries URI, document/version/chunk identifiers, retrieval time, source type, excerpt and a SHA-256 hash of that excerpt. A changed excerpt fails closed.
2. **Claim support** — material claims are re-evaluated against trusted excerpts. The verifier does not trust the model's \`supports\` / \`contradicts\` label from the adjudication response.
3. **Citation provenance** — claim source IDs must exist in the trusted source catalog and must retain valid content hashes.
4. **Calculations** — arithmetic expressions are recomputed by a bounded parser that supports numbers, parentheses, unary signs, \`+\`, \`-\`, \`\*\`, \`/\` and postfix \`%\`. It never calls JavaScript \`eval\`.
5. **Independent critic evidence** — a critic review records provider/model/family and the primary model family. High/regulated verification requires a different model family. High-severity critic findings affect the verification result only when they cite integrity-verified evidence; unsupported critic findings are retained as unresolved risk rather than automatically overriding verified evidence.

The output contains per-claim/per-calculation results, explicit reasons, unresolved risks and independent scores for correctness, evidence integrity, citation integrity, calculation accuracy and contradiction-search coverage.

## Fail-closed policy

\`standard\`, \`high\` and \`regulated\` are distinct assurance tiers.

For all tiers, a material contradicted claim, unresolved same-quality evidence conflict, failed source hash or failed material calculation produces \`fail\`.

For \`high\` and \`regulated\` verification:

- contradiction search must have been completed;
- an independent critic model family is required;
- \`unknown\` source types are rejected;
- insufficient material claim support fails rather than returning \`review\`.

For \`regulated\` verification:

- every supported material claim requires at least two independently verified sources; and
- at least one of those supporting sources must be \`primary\`.

A standard bundle with insufficient evidence or an unsubstantiated critic finding can return \`review\`, but never \`pass\`.

## Evidence Protocol bridge

\`buildVerificationRequestFromAdjudication()\` converts an existing \`raeburnai.evidence-protocol.v1\` adjudication result into the verification contract.

Only the adjudicator's claim text and source IDs are reused. Source metadata and source content come from the trusted source catalog. This is deliberate: a model-supplied citation title, URI or support label is not treated as evidence.

The bridge therefore allows the existing evidence-mode workflow to retain its orchestration contract while moving the final trust decision into a separate verifier.

## Calculation safety

The arithmetic parser accepts only a deliberately small grammar. Identifiers, property access, functions and other executable syntax are rejected. Division by zero and non-finite results fail verification.

The v1 parser is intended for deterministic arithmetic assertions. It does not yet replace Python/SQL/statistical tools for complex finance or analytics work, nor does it perform unit conversion.

## API

\`POST /api/evidence/verify\` uses the existing Chain service-authentication boundary.

The API:

- binds verification to the authenticated tenant;
- returns the complete verification result to the caller;
- writes only summary metadata, scores, decision and the evidence-bundle digest to \`AuditEvent\`; and
- deliberately does not persist raw source excerpts in audit metadata.

This endpoint verifies a supplied trusted evidence bundle. It does not fetch external sources itself.

## Executable benchmark

\`npm run bench:evidence\` executes deterministic positive and failure-path cases for:

- supported primary evidence;
- contradicted claims;
- correct and incorrect calculations;
- regulated two-source/primary-source policy; and
- unsubstantiated critic behavior.

CI runs this benchmark in addition to the normal unit/integration suite and the existing RaeburnBench routing gate.

## Explicit limits

This v1 implementation is not a semantic natural-language inference model. Claim-to-excerpt support uses a transparent lexical/numeric/negation verifier intended as a fail-closed deterministic first layer.

It does **not** yet provide:

- live Knowledge Graph/MCP source retrieval;
- a production second-model invocation;
- learned semantic entailment;
- legal or clinical truth determination;
- Python/SQL/statistical calculation execution;
- unit conversion;
- private held-out evidence-quality benchmarks; or
- production deployment evidence.

Those remain separate tracked delivery items and must not be inferred from this implementation.
