import { describe, expect, it } from "vitest";
import {
  evaluateChallengerGate,
  evaluatePerformanceBenchmark,
  evaluateToolBenchmark,
} from "@/lib/quality-benchmarks";

const candidate = { id: "reference-quality", version: "0.1.0" };

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
} as const;

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
} as const;

const performanceCandidate = {
  candidate,
  measurements: [
    { caseId: "perf.simple.001", latencyMs: 400, costUsd: 0.002 },
    { caseId: "perf.tool.001", latencyMs: 1200, costUsd: 0.01 },
    { caseId: "perf.evidence.001", latencyMs: 2400, costUsd: 0.03 },
  ],
};

describe("quality benchmark gates", () => {
  it("passes deterministic expected tool traces and emits integrity evidence", () => {
    const result = evaluateToolBenchmark(toolBenchmark, toolCandidate);
    expect(result.gate).toBe("pass");
    expect(result.score).toBe(1);
    expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on extra or forbidden tool calls", () => {
    const changed = structuredClone(toolCandidate);
    changed.traces[0]?.calls.push({
      tool: "payments",
      action: "transfer",
      succeeded: true,
    });

    const result = evaluateToolBenchmark(toolBenchmark, changed);
    expect(result.gate).toBe("fail");
    expect(result.caseResults[0]?.reasons).toContain("tool call budget exceeded");
    expect(result.caseResults[0]?.reasons).toContain("forbidden tool invoked");
  });

  it("fails performance cases when either latency or cost budget is exceeded", () => {
    const changed = structuredClone(performanceCandidate);
    const measurement = changed.measurements.find(
      (item) => item.caseId === "perf.tool.001",
    );
    if (!measurement) throw new Error("fixture missing");
    measurement.latencyMs = 3000;
    measurement.costUsd = 0.04;

    const result = evaluatePerformanceBenchmark(
      performanceBenchmark,
      changed,
    );
    expect(result.gate).toBe("fail");
    expect(result.caseResults[1]?.reasons).toEqual([
      "latency budget exceeded",
      "cost budget exceeded",
    ]);
  });

  it("promotes only the same candidate when every independent gate passes", () => {
    const tool = evaluateToolBenchmark(toolBenchmark, toolCandidate);
    const performance = evaluatePerformanceBenchmark(
      performanceBenchmark,
      performanceCandidate,
    );
    const result = evaluateChallengerGate({
      raeburnBench: {
        candidate,
        gate: { status: "pass" },
        artifactDigest: "a".repeat(64),
      },
      toolBenchmark: tool,
      performanceBenchmark: performance,
    });
    expect(result.decision).toBe("promote");
    expect(result.reasons).toEqual([]);
  });

  it("rejects mixed-candidate evidence even when every individual gate passes", () => {
    const tool = evaluateToolBenchmark(toolBenchmark, toolCandidate);
    const performance = evaluatePerformanceBenchmark(
      performanceBenchmark,
      {
        ...performanceCandidate,
        candidate: { id: "different", version: "0.1.0" },
      },
    );
    const result = evaluateChallengerGate({
      raeburnBench: {
        candidate,
        gate: { status: "pass" },
        artifactDigest: "b".repeat(64),
      },
      toolBenchmark: tool,
      performanceBenchmark: performance,
    });
    expect(result.decision).toBe("reject");
    expect(result.reasons).toContain(
      "benchmark artifacts refer to different candidates",
    );
  });
});
