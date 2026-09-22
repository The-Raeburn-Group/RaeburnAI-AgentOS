# RaeburnBench

RaeburnBench is the versioned evaluation contract used to compare RaeburnAI model, router and
expert candidates before release. The implementation in AgentOS is deliberately deterministic:
candidate outputs are supplied as data, graders do not call a model, and every result is bound to a
SHA-256 digest of the parsed corpus.

## v0 scope

The committed seed corpus contains 25 synthetic, redistributable cases across five suites:

| Suite | What v0 measures |
| --- | --- |
| `domain` | Deterministic domain/task contract checks across reasoning, research, software, security and legal-research behavior |
| `hallucination` | Supported-answer versus required-abstention behavior |
| `citation` | Required evidence identifiers independently from answer wording |
| `routing` | Expected expert set and risk tier, including a multi-expert case |
| `prompt_injection` | Block/review/allow behavior including a benign quoted-instruction false-positive control |

This public seed corpus is **not** the private held-out release corpus envisaged for mature
RaeburnBench. It proves the framework, schemas, result integrity and regression gate. Private
holdouts, larger domain sets, model/tool execution and benchmark-backed product claims remain
separate delivery work.

## Dataset provenance

Every case embeds `raeburnai.dataset-record.v1` and
`raeburnai.dataset-provenance.v1`. A record carries task/domain/jurisdiction/date/difficulty,
prompt, ideal answer, evidence, optional bad-answer/critique/tool trace, confidence and explicit
source/license/privacy metadata.

Automated v1 evaluation fails closed when:

- evaluation is not an allowed purpose;
- the declared license does not permit evaluation;
- personal data lacks a documented lawful basis; or
- special-category personal data is present.

The same library exposes a training-admissibility check, but a technical flag is not legal advice or
proof of licence. Provider/source review and the platform IP policy remain required before real
training data is admitted.

## Candidate contract

A candidate file uses `raeburnbench.candidate.v1` and supplies one output per benchmark case. The
common output contract supports answer text, explicit abstention, evidence IDs, routed experts/risk
tier and prompt-injection security decision. Unknown or duplicate case IDs are rejected.

The runner is intentionally adapter-neutral. Router, Chain, a model harness or a human-reviewed
gold fixture can all produce this same contract without changing graders.

## Result integrity and gates

A result uses `raeburnbench.result.v1` and contains:

- corpus ID, version and canonical SHA-256 digest;
- candidate ID/version;
- per-case scores and failure reasons;
- suite and overall scores;
- absolute threshold failures;
- baseline-regression failures; and
- an artifact SHA-256 digest over the complete unsigned result.

Baselines are accepted only when their own digest is valid and their corpus digest exactly matches
the current corpus. A corpus change therefore cannot silently reuse a stale release baseline.

The seed thresholds currently require 0.90 overall, 0.80 domain, 1.00 hallucination, 0.90 citation,
0.90 routing and 1.00 prompt-injection. The maximum tolerated regression from a supplied baseline
is 0.05. These are engineering seed thresholds, not production assurance claims.

## CLI

Run the reference fixture:

```bash
npm run bench:run
```

Evaluate another candidate:

```bash
npm run bench:run -- \
  --candidate path/to/candidate.json \
  --baseline benchmarks/results/reference.v0.json \
  --out artifacts/raeburnbench/candidate.json
```

Once the reviewed reference artifact is committed, CI uses `npm run bench:verify` to recompute it
byte-for-byte. Any corpus, candidate, grader or threshold drift without an intentional baseline
update fails the release gate.

## Extending RaeburnBench

New suites or cases must preserve the provenance contract, add failure-path tests and intentionally
review threshold changes. Do not weaken a threshold merely to make a candidate pass. Private
held-out cases should be supplied to the same CLI from a protected CI source rather than committed
to this public repository.
