import referenceCandidate from "../benchmarks/candidates/reference.v0.json";
import registryFixture from "../benchmarks/experts/routing-seed.v0.json";
import corpusFixture from "../benchmarks/raeburnbench.seed.v0.json";
import {
  RaeburnBenchCandidateSchema,
  evaluateRaeburnBench,
} from "../src/lib/raeburnbench";
import { planExpertRoute } from "../src/lib/routing-policy";

const candidate = RaeburnBenchCandidateSchema.parse(
  structuredClone(referenceCandidate),
);
candidate.candidateId = "routing-policy-core";
candidate.version = "0.1.0";

for (const benchmarkCase of corpusFixture.cases) {
  if (benchmarkCase.suite !== "routing") continue;
  const output = candidate.outputs.find(
    (item) => item.caseId === benchmarkCase.record.id,
  );
  if (!output) {
    throw new Error(
      `reference candidate is missing routing case: ${benchmarkCase.record.id}`,
    );
  }

  const plan = planExpertRoute(
    {
      goal: benchmarkCase.record.prompt,
      maxExperts: 2,
    },
    registryFixture.experts,
  );

  output.routeExperts = plan.primaryAgents;
  output.riskTier = plan.riskTier;
}

const result = evaluateRaeburnBench(corpusFixture, candidate);
const routingCases = result.caseResults.filter(
  (caseResult) => caseResult.suite === "routing",
);
const failedCases = routingCases.filter((caseResult) => !caseResult.passed);

process.stdout.write(
  `${JSON.stringify(
    {
      candidate: result.candidate,
      corpusDigest: result.corpus.digest,
      routingScore: result.suiteScores.routing,
      cases: routingCases,
    },
    null,
    2,
  )}\n`,
);

if (
  result.suiteScores.routing <
    corpusFixture.thresholds.suites.routing ||
  failedCases.length > 0
) {
  process.exitCode = 2;
}
