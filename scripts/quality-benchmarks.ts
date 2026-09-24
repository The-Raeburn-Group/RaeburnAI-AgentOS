import referenceCandidate from "../benchmarks/candidates/reference.v0.json";
import challengerFixture from "../benchmarks/challengers/reference.v0.json";
import corpusFixture from "../benchmarks/raeburnbench.seed.v0.json";
import {
  evaluateChallengerGate,
  evaluatePerformanceBenchmark,
  evaluateToolBenchmark,
} from "../src/lib/quality-benchmarks";
import { evaluateRaeburnBench } from "../src/lib/raeburnbench";

const raeburnBench = evaluateRaeburnBench(corpusFixture, referenceCandidate);
const toolBenchmark = evaluateToolBenchmark(
  challengerFixture.toolBenchmark,
  challengerFixture.toolCandidate,
);
const performanceBenchmark = evaluatePerformanceBenchmark(
  challengerFixture.performanceBenchmark,
  challengerFixture.performanceCandidate,
);
const challenger = evaluateChallengerGate({
  raeburnBench,
  toolBenchmark,
  performanceBenchmark,
});

process.stdout.write(
  JSON.stringify(
    {
      candidate: challenger.candidate,
      decision: challenger.decision,
      reasons: challenger.reasons,
      raeburnBench: {
        overallScore: raeburnBench.overallScore,
        gate: raeburnBench.gate.status,
        artifactDigest: raeburnBench.artifactDigest,
      },
      toolBenchmark: {
        score: toolBenchmark.score,
        gate: toolBenchmark.gate,
        artifactDigest: toolBenchmark.artifactDigest,
      },
      performanceBenchmark: {
        meanLatencyMs: performanceBenchmark.meanLatencyMs,
        totalCostUsd: performanceBenchmark.totalCostUsd,
        gate: performanceBenchmark.gate,
        artifactDigest: performanceBenchmark.artifactDigest,
      },
      challengerArtifactDigest: challenger.artifactDigest,
    },
    null,
    2,
  ) + "\n",
);

if (challenger.decision !== "promote") process.exitCode = 2;
