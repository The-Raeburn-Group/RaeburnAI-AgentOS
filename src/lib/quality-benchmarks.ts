import { z } from "zod";
import { sha256 } from "@/lib/raeburnbench";

export const TOOL_BENCHMARK_VERSION = "raeburnai.tool-benchmark.v1" as const;
export const PERFORMANCE_BENCHMARK_VERSION =
  "raeburnai.performance-benchmark.v1" as const;
export const CHALLENGER_GATE_VERSION = "raeburnai.challenger-gate.v1" as const;

const CandidateIdentitySchema = z.object({
  id: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(64),
});

const ToolCallSchema = z.object({
  tool: z.string().trim().min(1).max(128),
  action: z.string().trim().min(1).max(256),
  succeeded: z.boolean(),
});

export const ToolBenchmarkCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,199}$/),
  expectedCalls: z.array(ToolCallSchema).min(1),
  forbiddenTools: z.array(z.string().trim().min(1).max(128)).default([]),
  maxCalls: z.number().int().min(1).max(100),
});

export const ToolBenchmarkSchema = z.object({
  contractVersion: z.literal(TOOL_BENCHMARK_VERSION),
  benchmarkId: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(64),
  minimumScore: z.number().min(0).max(1),
  cases: z.array(ToolBenchmarkCaseSchema).min(3),
});

export const ToolBenchmarkCandidateSchema = z.object({
  candidate: CandidateIdentitySchema,
  traces: z.array(
    z.object({
      caseId: z.string().min(1),
      calls: z.array(ToolCallSchema).max(100),
    }),
  ),
});

function canonicalCalls(
  calls: Array<z.infer<typeof ToolCallSchema>>,
): string[] {
  return calls
    .map((call) => JSON.stringify(call))
    .sort((left, right) => left.localeCompare(right));
}

function exactArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function evaluateToolBenchmark(
  benchmarkInput: unknown,
  candidateInput: unknown,
) {
  const benchmark = ToolBenchmarkSchema.parse(benchmarkInput);
  const candidate = ToolBenchmarkCandidateSchema.parse(candidateInput);
  const knownCases = new Set(benchmark.cases.map((item) => item.id));
  const traces = new Map<string, z.infer<typeof ToolBenchmarkCandidateSchema>["traces"][number]>();

  for (const trace of candidate.traces) {
    if (!knownCases.has(trace.caseId)) {
      throw new Error("tool_benchmark_unknown_case:" + trace.caseId);
    }
    if (traces.has(trace.caseId)) {
      throw new Error("tool_benchmark_duplicate_case:" + trace.caseId);
    }
    traces.set(trace.caseId, trace);
  }

  const caseResults = benchmark.cases.map((benchmarkCase) => {
    const trace = traces.get(benchmarkCase.id);
    const reasons: string[] = [];
    if (!trace) {
      reasons.push("candidate trace missing");
    } else {
      if (trace.calls.length > benchmarkCase.maxCalls) {
        reasons.push("tool call budget exceeded");
      }
      const forbidden = trace.calls.filter((call) =>
        benchmarkCase.forbiddenTools.includes(call.tool),
      );
      if (forbidden.length > 0) reasons.push("forbidden tool invoked");
      if (
        !exactArray(
          canonicalCalls(trace.calls),
          canonicalCalls(benchmarkCase.expectedCalls),
        )
      ) {
        reasons.push("tool trace does not exactly match expected calls");
      }
    }
    return {
      caseId: benchmarkCase.id,
      passed: reasons.length === 0,
      score: reasons.length === 0 ? 1 : 0,
      reasons,
    };
  });

  const score = rounded(
    caseResults.reduce((sum, item) => sum + item.score, 0) /
      caseResults.length,
  );
  const unsigned = {
    contractVersion: TOOL_BENCHMARK_VERSION,
    benchmark: {
      id: benchmark.benchmarkId,
      version: benchmark.version,
      digest: sha256(benchmark),
    },
    candidate: candidate.candidate,
    score,
    caseResults,
    gate: score >= benchmark.minimumScore ? "pass" : "fail",
  } as const;
  return { ...unsigned, artifactDigest: sha256(unsigned) };
}

const PerformanceCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,199}$/),
  maxLatencyMs: z.number().finite().positive(),
  maxCostUsd: z.number().finite().min(0),
});

export const PerformanceBenchmarkSchema = z.object({
  contractVersion: z.literal(PERFORMANCE_BENCHMARK_VERSION),
  benchmarkId: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(64),
  cases: z.array(PerformanceCaseSchema).min(3),
});

export const PerformanceCandidateSchema = z.object({
  candidate: CandidateIdentitySchema,
  measurements: z.array(
    z.object({
      caseId: z.string().min(1),
      latencyMs: z.number().finite().min(0),
      costUsd: z.number().finite().min(0),
      inputTokens: z.number().int().min(0).optional(),
      outputTokens: z.number().int().min(0).optional(),
    }),
  ),
});

export function evaluatePerformanceBenchmark(
  benchmarkInput: unknown,
  candidateInput: unknown,
) {
  const benchmark = PerformanceBenchmarkSchema.parse(benchmarkInput);
  const candidate = PerformanceCandidateSchema.parse(candidateInput);
  const knownCases = new Set(benchmark.cases.map((item) => item.id));
  const measurements = new Map<string, z.infer<typeof PerformanceCandidateSchema>["measurements"][number]>();

  for (const measurement of candidate.measurements) {
    if (!knownCases.has(measurement.caseId)) {
      throw new Error("performance_benchmark_unknown_case:" + measurement.caseId);
    }
    if (measurements.has(measurement.caseId)) {
      throw new Error("performance_benchmark_duplicate_case:" + measurement.caseId);
    }
    measurements.set(measurement.caseId, measurement);
  }

  const caseResults = benchmark.cases.map((benchmarkCase) => {
    const measurement = measurements.get(benchmarkCase.id);
    const reasons: string[] = [];
    if (!measurement) reasons.push("candidate measurement missing");
    if (measurement && measurement.latencyMs > benchmarkCase.maxLatencyMs) {
      reasons.push("latency budget exceeded");
    }
    if (measurement && measurement.costUsd > benchmarkCase.maxCostUsd) {
      reasons.push("cost budget exceeded");
    }
    return {
      caseId: benchmarkCase.id,
      passed: reasons.length === 0,
      latencyMs: measurement?.latencyMs ?? null,
      costUsd: measurement?.costUsd ?? null,
      reasons,
    };
  });

  const completeMeasurements = benchmark.cases
    .map((item) => measurements.get(item.id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const meanLatencyMs = rounded(
    completeMeasurements.length === 0
      ? 0
      : completeMeasurements.reduce((sum, item) => sum + item.latencyMs, 0) /
          completeMeasurements.length,
  );
  const totalCostUsd = rounded(
    completeMeasurements.reduce((sum, item) => sum + item.costUsd, 0),
  );
  const gate = caseResults.every((item) => item.passed) ? "pass" : "fail";
  const unsigned = {
    contractVersion: PERFORMANCE_BENCHMARK_VERSION,
    benchmark: {
      id: benchmark.benchmarkId,
      version: benchmark.version,
      digest: sha256(benchmark),
    },
    candidate: candidate.candidate,
    meanLatencyMs,
    totalCostUsd,
    caseResults,
    gate,
  } as const;
  return { ...unsigned, artifactDigest: sha256(unsigned) };
}

const GateResultSchema = z.object({
  candidate: CandidateIdentitySchema,
  gate: z.enum(["pass", "fail"]),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

export function evaluateChallengerGate(options: {
  raeburnBench: { candidate: { id: string; version: string }; gate: { status: "pass" | "fail" }; artifactDigest: string };
  toolBenchmark: unknown;
  performanceBenchmark: unknown;
}) {
  const tool = GateResultSchema.parse(options.toolBenchmark);
  const performance = GateResultSchema.parse(options.performanceBenchmark);
  const identity = CandidateIdentitySchema.parse(options.raeburnBench.candidate);
  const sameCandidate =
    tool.candidate.id === identity.id &&
    tool.candidate.version === identity.version &&
    performance.candidate.id === identity.id &&
    performance.candidate.version === identity.version;
  const reasons: string[] = [];
  if (!sameCandidate) reasons.push("benchmark artifacts refer to different candidates");
  if (options.raeburnBench.gate.status !== "pass") reasons.push("RaeburnBench failed");
  if (tool.gate !== "pass") reasons.push("tool-use benchmark failed");
  if (performance.gate !== "pass") reasons.push("performance benchmark failed");

  const unsigned = {
    contractVersion: CHALLENGER_GATE_VERSION,
    candidate: identity,
    decision: reasons.length === 0 ? ("promote" as const) : ("reject" as const),
    reasons,
    evidence: {
      raeburnBench: options.raeburnBench.artifactDigest,
      toolBenchmark: tool.artifactDigest,
      performanceBenchmark: performance.artifactDigest,
    },
  };
  return { ...unsigned, artifactDigest: sha256(unsigned) };
}
