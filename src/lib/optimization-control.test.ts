import { describe, expect, it } from "vitest";
import referenceCandidate from "../../benchmarks/candidates/reference.v0.json";
import challengerFixture from "../../benchmarks/challengers/reference.v0.json";
import corpusFixture from "../../benchmarks/raeburnbench.seed.v0.json";
import {
  OptimizationControlError,
  evaluateOptimizationEvidence,
} from "@/lib/optimization-control";
import {
  evaluatePerformanceBenchmark,
  evaluateToolBenchmark,
} from "@/lib/quality-benchmarks";
import { evaluateRaeburnBench } from "@/lib/raeburnbench";

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function bundle(candidateId: string, version: string) {
  const raeburnBench = evaluateRaeburnBench(corpusFixture, {
    ...referenceCandidate,
    candidateId,
    version,
  });
  const toolBenchmark = evaluateToolBenchmark(challengerFixture.toolBenchmark, {
    ...challengerFixture.toolCandidate,
    candidate: { id: candidateId, version },
  });
  const performanceBenchmark = evaluatePerformanceBenchmark(
    challengerFixture.performanceBenchmark,
    {
      ...challengerFixture.performanceCandidate,
      candidate: { id: candidateId, version },
    },
  );
  return { raeburnBench, toolBenchmark, performanceBenchmark };
}

describe("optimization evidence", () => {
  it("accepts a same-definition challenger with non-regressing verified evidence", () => {
    const result = evaluateOptimizationEvidence({
      slug: "research-expert",
      baselineVersion: "1.0.0",
      challengerVersion: "1.1.0",
      baselineManifestDigest: "a".repeat(64),
      challengerManifestDigest: "b".repeat(64),
      evidence: {
        baseline: bundle("agent:research-expert", "1.0.0"),
        challenger: bundle("agent:research-expert", "1.1.0"),
      },
    });

    expect(result.eligible).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.baseline.qualityScore).toBe(1);
    expect(result.challenger.toolScore).toBe(1);
  });

  it("binds every benchmark artifact to the exact expert slug and version", () => {
    expect(captureError(() =>
      evaluateOptimizationEvidence({
        slug: "research-expert",
        baselineVersion: "1.0.0",
        challengerVersion: "1.1.0",
        baselineManifestDigest: "a".repeat(64),
        challengerManifestDigest: "b".repeat(64),
        evidence: {
          baseline: bundle("agent:research-expert", "1.0.0"),
          challenger: bundle("agent:different-expert", "1.1.0"),
        },
      }),
    )).toMatchObject<Partial<OptimizationControlError>>({
      code: "evidence_candidate_mismatch",
    });
  });

  it("rejects comparisons produced from different benchmark definitions", () => {
    const baseline = bundle("agent:research-expert", "1.0.0");
    const changedDefinition = structuredClone(
      challengerFixture.performanceBenchmark,
    );
    changedDefinition.version = "0.2.0";
    const challenger = bundle("agent:research-expert", "1.1.0");
    challenger.performanceBenchmark = evaluatePerformanceBenchmark(
      changedDefinition,
      {
        ...challengerFixture.performanceCandidate,
        candidate: { id: "agent:research-expert", version: "1.1.0" },
      },
    );

    expect(captureError(() =>
      evaluateOptimizationEvidence({
        slug: "research-expert",
        baselineVersion: "1.0.0",
        challengerVersion: "1.1.0",
        baselineManifestDigest: "a".repeat(64),
        challengerManifestDigest: "b".repeat(64),
        evidence: { baseline, challenger },
      }),
    )).toMatchObject<Partial<OptimizationControlError>>({
      code: "benchmark_definition_mismatch",
    });
  });

  it("fails the optimization decision when challenger quality regresses", () => {
    const baseline = bundle("agent:research-expert", "1.0.0");
    const degradedCandidate = {
      ...referenceCandidate,
      candidateId: "agent:research-expert",
      version: "1.1.0",
      outputs: referenceCandidate.outputs.map((output) => ({
        caseId: output.caseId,
        answer: "",
        abstained: false,
        citations: [],
        routeExperts: [],
      })),
    };
    const challenger = bundle("agent:research-expert", "1.1.0");
    challenger.raeburnBench = evaluateRaeburnBench(
      corpusFixture,
      degradedCandidate,
    );

    const result = evaluateOptimizationEvidence({
      slug: "research-expert",
      baselineVersion: "1.0.0",
      challengerVersion: "1.1.0",
      baselineManifestDigest: "a".repeat(64),
      challengerManifestDigest: "b".repeat(64),
      evidence: { baseline, challenger },
    });

    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain("challenger RaeburnBench gate failed");
    expect(result.reasons).toContain(
      "challenger quality regression exceeds policy",
    );
  });

  it("detects tampered benchmark artifacts before evaluating policy", () => {
    const baseline = bundle("agent:research-expert", "1.0.0");
    const challenger = bundle("agent:research-expert", "1.1.0");
    challenger.toolBenchmark.gate = "fail";

    expect(
      captureError(() =>
        evaluateOptimizationEvidence({
          slug: "research-expert",
          baselineVersion: "1.0.0",
          challengerVersion: "1.1.0",
          baselineManifestDigest: "a".repeat(64),
          challengerManifestDigest: "b".repeat(64),
          evidence: { baseline, challenger },
        }),
      ),
    ).toMatchObject({
      message: "tool_benchmark_integrity_invalid",
    });
  });
});
