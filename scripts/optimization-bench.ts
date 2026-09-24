import referenceCandidate from "../benchmarks/candidates/reference.v0.json";
import challengerFixture from "../benchmarks/challengers/reference.v0.json";
import corpusFixture from "../benchmarks/raeburnbench.seed.v0.json";
import { evaluateOptimizationEvidence } from "../src/lib/optimization-control";
import {
  evaluatePerformanceBenchmark,
  evaluateToolBenchmark,
} from "../src/lib/quality-benchmarks";
import { evaluateRaeburnBench } from "../src/lib/raeburnbench";

function bundle(version: string) {
  const candidateId = "agent:reference-configuration";
  return {
    raeburnBench: evaluateRaeburnBench(corpusFixture, {
      ...referenceCandidate,
      candidateId,
      version,
    }),
    toolBenchmark: evaluateToolBenchmark(challengerFixture.toolBenchmark, {
      ...challengerFixture.toolCandidate,
      candidate: { id: candidateId, version },
    }),
    performanceBenchmark: evaluatePerformanceBenchmark(
      challengerFixture.performanceBenchmark,
      {
        ...challengerFixture.performanceCandidate,
        candidate: { id: candidateId, version },
      },
    ),
  };
}

const result = evaluateOptimizationEvidence({
  slug: "reference-configuration",
  baselineVersion: "1.0.0",
  challengerVersion: "1.1.0",
  baselineManifestDigest: "a".repeat(64),
  challengerManifestDigest: "b".repeat(64),
  evidence: {
    baseline: bundle("1.0.0"),
    challenger: bundle("1.1.0"),
  },
});

process.stdout.write(
  JSON.stringify(
    {
      contractVersion: result.contractVersion,
      eligible: result.eligible,
      reasons: result.reasons,
      baseline: {
        version: result.baseline.version,
        qualityScore: result.baseline.qualityScore,
        toolScore: result.baseline.toolScore,
        p95LatencyMs: result.baseline.p95LatencyMs,
        totalCostUsd: result.baseline.totalCostUsd,
      },
      challenger: {
        version: result.challenger.version,
        qualityScore: result.challenger.qualityScore,
        toolScore: result.challenger.toolScore,
        p95LatencyMs: result.challenger.p95LatencyMs,
        totalCostUsd: result.challenger.totalCostUsd,
      },
      evidenceDigests: result.evidenceDigests,
    },
    null,
    2,
  ) + "\n",
);

if (!result.eligible) process.exitCode = 2;
