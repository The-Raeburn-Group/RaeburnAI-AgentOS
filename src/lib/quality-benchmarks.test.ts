import { describe, expect, it } from "vitest";
import referenceCandidate from "../../benchmarks/candidates/reference.v0.json";
import corpusFixture from "../../benchmarks/raeburnbench.seed.v0.json";
import {
  evaluateChallengerGate,
  evaluatePerformanceBenchmark,
  evaluateToolBenchmark,
} from "@/lib/quality-benchmarks";
import { evaluateRaeburnBench } from "@/lib/raeburnbench";

const candidate = {
  id: referenceCandidate.candidateId,
  version: referenceCandidate.version,
};

const toolBenchmark = {
  contractVersion: "raeburnai.tool-benchmark.v1",
  benchmarkId: "tool-use-seed",
  version: "0.1.0",
  minimumScore: 1,
  cases: [
    {
      id: "tool.read.001",
      expectedCalls: [{ tool: "knowledge", action: "read", succeeded: true }],
      forbiddenTools: ["payments"],
      maxCalls: 1,
    },
    {
      id: "tool.search.001",
      expectedCalls: [{ tool: "search", action: "query", succeeded: true }],
      forbiddenTools: ["payments"],
      maxCalls: 1,
    },
    {
      id: "tool.no-write.001",
      expectedCalls: [{ tool: "records", action: "read", succeeded: true }],
      forbiddenTools: ["records.write"],
      maxCalls: 1,
    },
  ],
};

const toolCandidate = {
  candidate,
  traces: toolBenchmark.cases.map((item) => ({
    caseId: item.id,
    calls: [...item.expectedCalls],
  })),
};

const performanceBenchmark = {
  contractVersion: "raeburnai.performance-benchmark.v1",
  benchmarkId: "performance-seed",
  version: "0.1.0",
  cases: [
    { id: "perf.simple.001", maxLatencyMs: 1000, maxCostUsd: 0.01 },
    { id: "perf.tool.001", maxLatencyMs: 2500, maxCostUsd: 0.03 },
    { id: "perf.evidence.001", maxLatencyMs: 5000, maxCostUsd: 0.08 },
  ],
};

const performanceCandidate = {
  candidate,
  measurements: [
    { caseId: "perf.simple.001", latencyMs: 400, costUsd: 0.002 },
    { caseId: "perf.tool.001", latencyMs: 1200, costUsd: 0.01 },
    { caseId: "perf.evidence.001", latencyMs: 2400, costUsd: 0.03 },
  ],
};

function raeburnBench() {
  return evaluateRaeburnBench(corpusFixture, referenceCandidate);
}

describe("quality benchmark gates", () => {
  it("passes deterministic expected tool traces and emits integrity evidence", () => {
    const result = evaluateToolBenchmark(toolBenchmark, toolCandidate);
    expect(result.gate).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.absoluteFailures).toEqual([]);
    expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves tool-call order in exact trace grading", () => {
    const benchmark = structuredClone(toolBenchmark);
    benchmark.cases[0] = {
      id: "tool.read.001",
      expectedCalls: [
        { tool: "knowledge", action: "read", succeeded: true },
        { tool: "evidence", action: "verify", succeeded: true },
      ],
      forbiddenTools: ["payments"],
      maxCalls: 2,
    };
    const challenger = structuredClone(toolCandidate);
    challenger.traces[0] = {
      caseId: "tool.read.001",
      calls: [
        { tool: "evidence", action: "verify", succeeded: true },
        { tool: "knowledge", action: "read", succeeded: true },
      ],
    };

    const result = evaluateToolBenchmark(benchmark, challenger);
    expect(result.gate).toBe("fail");
    expect(result.caseResults[0]?.reasons).toContain(
      "tool trace does not exactly match expected calls",
    );
  });

  it("makes forbidden tools and call budgets absolute failures below a permissive score threshold", () => {
    const benchmark = structuredClone(toolBenchmark);
    benchmark.minimumScore = 0.5;
    const challenger = structuredClone(toolCandidate);
    challenger.traces[0]?.calls.push({
      tool: "payments",
      action: "transfer",
      succeeded: true,
    });

    const result = evaluateToolBenchmark(benchmark, challenger);
    expect(result.score).toBeGreaterThanOrEqual(0.5);
    expect(result.gate).toBe("fail");
    expect(result.absoluteFailures).toEqual([
      "tool.read.001: tool call budget exceeded",
      "tool.read.001: forbidden tool invoked",
    ]);
  });

  it("rejects duplicate benchmark case identifiers", () => {
    const duplicateTool = structuredClone(toolBenchmark);
    duplicateTool.cases[1].id = duplicateTool.cases[0].id;
    expect(() => evaluateToolBenchmark(duplicateTool, toolCandidate)).toThrow(
      "duplicate tool benchmark case id",
    );

    const duplicatePerformance = structuredClone(performanceBenchmark);
    duplicatePerformance.cases[1].id = duplicatePerformance.cases[0].id;
    expect(() =>
      evaluatePerformanceBenchmark(duplicatePerformance, performanceCandidate),
    ).toThrow("duplicate performance benchmark case id");
  });

  it("fails performance cases when either latency or cost budget is exceeded", () => {
    const changed = structuredClone(performanceCandidate);
    const measurement = changed.measurements.find(
      (item) => item.caseId === "perf.tool.001",
    );
    if (!measurement) throw new Error("fixture missing");
    measurement.latencyMs = 3000;
    measurement.costUsd = 0.04;

    const result = evaluatePerformanceBenchmark(performanceBenchmark, changed);
    expect(result.gate).toBe("fail");
    expect(result.caseResults[1]?.reasons).toEqual([
      "latency budget exceeded",
      "cost budget exceeded",
    ]);
  });

  it("promotes only the same candidate when every independently verified gate passes", () => {
    const tool = evaluateToolBenchmark(toolBenchmark, toolCandidate);
    const performance = evaluatePerformanceBenchmark(
      performanceBenchmark,
      performanceCandidate,
    );
    const result = evaluateChallengerGate({
      raeburnBench: raeburnBench(),
      toolBenchmark: tool,
      performanceBenchmark: performance,
    });
    expect(result.decision).toBe("promote");
    expect(result.reasons).toEqual([]);
  });

  it("rejects mixed-candidate evidence even when every individual gate passes", () => {
    const tool = evaluateToolBenchmark(toolBenchmark, toolCandidate);
    const performance = evaluatePerformanceBenchmark(performanceBenchmark, {
      ...performanceCandidate,
      candidate: { id: "different", version: "0.1.0" },
    });
    const result = evaluateChallengerGate({
      raeburnBench: raeburnBench(),
      toolBenchmark: tool,
      performanceBenchmark: performance,
    });
    expect(result.decision).toBe("reject");
    expect(result.reasons).toContain(
      "benchmark artifacts refer to different candidates",
    );
  });

  it("refuses tampered benchmark artifacts before a challenger decision", () => {
    const tool = evaluateToolBenchmark(toolBenchmark, toolCandidate);
    const performance = evaluatePerformanceBenchmark(
      performanceBenchmark,
      performanceCandidate,
    );
    const tampered = structuredClone(tool);
    tampered.gate = "fail";

    expect(() =>
      evaluateChallengerGate({
        raeburnBench: raeburnBench(),
        toolBenchmark: tampered,
        performanceBenchmark: performance,
      }),
    ).toThrow("tool_benchmark_integrity_invalid");
  });
});
