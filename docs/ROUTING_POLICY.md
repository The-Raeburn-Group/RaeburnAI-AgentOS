# Governed Expert Routing Policy

AgentOS exposes a versioned routing-plan contract:

- \`raeburnai.routing-plan.v1\`
- API: \`POST /api/routing/plan\`
- Input: goal, optional required capabilities/tools, and a bounded expert limit
- Source of truth: VERIFIED tenant-scoped \`raeburnai.agent-manifest.v1\` marketplace records

The planner is deliberately deterministic. It is an executable policy/classification layer, not a claim that a learned semantic router has been trained.

## Routing flow

1. Authenticate the trusted Chain service context.
2. Resolve only the authenticated tenant.
3. Load only VERIFIED expert records for that tenant.
4. Verify every selected marketplace manifest's SHA-256 envelope.
5. Verify manifest slug/version and executable model/prompt/approval fields still match the database record.
6. Classify one or more specialist intents from the goal.
7. Classify risk independently of expert scoring.
8. Apply required capability/tool constraints before ranking.
9. Select one expert for each classified domain up to the governed limit.
10. For high/critical work, require an independent evidence-capable adjudicator.
11. Return the collaboration mode, strictness and human-approval requirement.
12. Persist a tenant-bound \`routing.plan.created\` audit event.

## Fail-closed behavior

The planner rejects rather than silently downgrading when:

- a VERIFIED manifest has a missing or invalid digest;
- manifest identity/executable fields differ from the stored Agent record;
- two VERIFIED registry entries expose the same expert slug;
- no expert satisfies a classified domain;
- a high-stakes multi-domain request sets \`maxExperts\` too low to preserve every classified domain;
- an evidence/adjudicated route has no independent eligible adjudicator;
- required capabilities or tools are unavailable.

High/critical risk plans never reduce to a general expert simply to produce an answer.

## Risk and collaboration policy

Current v1 behavior is conservative:

- general reasoning -> low;
- specialist research/software/data/strategy/procurement/AI work -> medium;
- cybersecurity, legal, health, finance and tax -> high unless an explicit critical action marker applies;
- irreversible/action markers such as fund transfer, trade execution, production deployment/deletion, court filing or tax submission -> critical.

Collaboration mode is derived from risk and domain count:

- one low/medium specialist -> sequential;
- multiple low-risk specialists -> parallel;
- multiple medium-risk specialists -> adjudicated;
- high/critical -> evidence mode with an independent evidence verifier.

High/critical plans require human approval regardless of individual manifest defaults.

## RaeburnBench integration

\`npm run bench:routing\` executes the real routing policy against the five routing cases in the public RaeburnBench seed corpus:

- research;
- software engineering;
- cybersecurity;
- low-risk general reasoning;
- multi-domain software + cybersecurity.

The benchmark candidate is generated at runtime from the planner. Expected expert sets and risk tiers remain defined in the benchmark corpus; the script exits non-zero if the executable policy misses the routing threshold or any routing case.

The seed expert registry is stored in:

\`benchmarks/experts/routing-seed.v0.json\`

It is synthetic benchmark data, not a production expert catalogue.

## Known limits

This implementation does not claim:

- a learned embedding/LLM semantic classifier;
- production Router integration;
- calibrated routing confidence;
- comprehensive domain taxonomy coverage;
- private held-out routing evaluation;
- latency/cost-optimal model selection;
- that an expert manifest represents a trained/fine-tuned specialist.

Those remain separate delivery gates. The next integration step is to consume this versioned plan from the core LLM Router/Chain path, run protected held-out routing suites, and compare routing quality/cost/latency against alternative classifiers.
