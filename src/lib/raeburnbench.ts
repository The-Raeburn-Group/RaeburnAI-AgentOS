import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DatasetRecordSchema,
  assertEvaluationRecordAdmissible,
  type DatasetRecord,
} from "@/lib/dataset-provenance";

export const RAEBURNBENCH_CORPUS_VERSION = "raeburnbench.corpus.v1" as const;
export const RAEBURNBENCH_CANDIDATE_VERSION =
  "raeburnbench.candidate.v1" as const;
export const RAEBURNBENCH_RESULT_VERSION = "raeburnbench.result.v1" as const;

export const RaeburnBenchSuiteSchema = z.enum([
  "domain",
  "hallucination",
  "citation",
  "routing",
  "prompt_injection",
]);
export type RaeburnBenchSuite = z.infer<typeof RaeburnBenchSuiteSchema>;

const ScoreSchema = z.number().min(0).max(1);

const ContainsGraderSchema = z.object({
  type: z.literal("contains"),
  required: z.array(z.string().min(1)).min(1),
  forbidden: z.array(z.string().min(1)).default([]),
});

const AbstentionGraderSchema = z.object({
  type: z.literal("abstention"),
  mustAbstain: z.boolean(),
  requiredAnswerContains: z.array(z.string().min(1)).default([]),
});

const CitationGraderSchema = z.object({
  type: z.literal("citation"),
  requiredSourceIds: z.array(z.string().min(1)).min(1),
  requiredAnswerContains: z.array(z.string().min(1)).default([]),
});

const RoutingGraderSchema = z.object({
  type: z.literal("routing"),
  expectedExperts: z.array(z.string().min(1)).min(1),
  expectedRiskTier: z.enum(["low", "medium", "high", "critical"]),
});

const SecurityGraderSchema = z.object({
  type: z.literal("security"),
  expectedDecision: z.enum(["allow", "review", "block"]),
});

export const RaeburnBenchGraderSchema = z.discriminatedUnion("type", [
  ContainsGraderSchema,
  AbstentionGraderSchema,
  CitationGraderSchema,
  RoutingGraderSchema,
  SecurityGraderSchema,
]);
export type RaeburnBenchGrader = z.infer<typeof RaeburnBenchGraderSchema>;

const suiteForGrader: Record<RaeburnBenchGrader["type"], RaeburnBenchSuite> = {
  contains: "domain",
  abstention: "hallucination",
  citation: "citation",
  routing: "routing",
  security: "prompt_injection",
};

export const RaeburnBenchCaseSchema = z
  .object({
    suite: RaeburnBenchSuiteSchema,
    record: DatasetRecordSchema,
    grader: RaeburnBenchGraderSchema,
  })
  .superRefine((value, context) => {
    if (suiteForGrader[value.grader.type] !== value.suite) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grader", "type"],
        message: `${value.grader.type} grader cannot score ${value.suite} suite`,
      });
    }
    if (value.grader.type === "citation") {
      const available = new Set(value.record.evidence.map((item) => item.id));
      for (const [
        index,
        sourceId,
      ] of value.grader.requiredSourceIds.entries()) {
        if (!available.has(sourceId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["grader", "requiredSourceIds", index],
            message: `unknown evidence source: ${sourceId}`,
          });
        }
      }
    }
  });

const SuiteThresholdsSchema = z.object({
  domain: ScoreSchema,
  hallucination: ScoreSchema,
  citation: ScoreSchema,
  routing: ScoreSchema,
  prompt_injection: ScoreSchema,
});

export const RaeburnBenchCorpusSchema = z
  .object({
    contractVersion: z
      .literal(RAEBURNBENCH_CORPUS_VERSION)
      .default(RAEBURNBENCH_CORPUS_VERSION),
    corpusId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/),
    version: z.string().trim().min(1).max(64),
    thresholds: z.object({
      overall: ScoreSchema,
      maxRegression: ScoreSchema.max(0.5),
      suites: SuiteThresholdsSchema,
    }),
    cases: z.array(RaeburnBenchCaseSchema).min(5),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const suites = new Set<RaeburnBenchSuite>();
    for (const [index, item] of value.cases.entries()) {
      if (ids.has(item.record.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", index, "record", "id"],
          message: `duplicate benchmark case id: ${item.record.id}`,
        });
      }
      ids.add(item.record.id);
      suites.add(item.suite);
    }
    for (const suite of RaeburnBenchSuiteSchema.options) {
      if (!suites.has(suite)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases"],
          message: `benchmark corpus is missing suite: ${suite}`,
        });
      }
    }
  });
export type RaeburnBenchCorpus = z.infer<typeof RaeburnBenchCorpusSchema>;

export const RaeburnBenchCandidateOutputSchema = z.object({
  caseId: z.string().min(1),
  answer: z.string().max(100_000).default(""),
  abstained: z.boolean().default(false),
  citations: z.array(z.string().min(1)).default([]),
  routeExperts: z.array(z.string().min(1)).default([]),
  riskTier: z.enum(["low", "medium", "high", "critical"]).optional(),
  securityDecision: z.enum(["allow", "review", "block"]).optional(),
});

export const RaeburnBenchCandidateSchema = z
  .object({
    contractVersion: z
      .literal(RAEBURNBENCH_CANDIDATE_VERSION)
      .default(RAEBURNBENCH_CANDIDATE_VERSION),
    candidateId: z.string().trim().min(1).max(128),
    version: z.string().trim().min(1).max(64),
    outputs: z.array(RaeburnBenchCandidateOutputSchema),
  })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const [index, output] of value.outputs.entries()) {
      if (ids.has(output.caseId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outputs", index, "caseId"],
          message: `duplicate candidate output: ${output.caseId}`,
        });
      }
      ids.add(output.caseId);
    }
  });
export type RaeburnBenchCandidate = z.infer<typeof RaeburnBenchCandidateSchema>;

const CaseResultSchema = z.object({
  caseId: z.string(),
  suite: RaeburnBenchSuiteSchema,
  score: ScoreSchema,
  passed: z.boolean(),
  reasons: z.array(z.string()),
});

const GateSchema = z.object({
  status: z.enum(["pass", "fail"]),
  absoluteFailures: z.array(z.string()),
  regressionFailures: z.array(z.string()),
});

export const RaeburnBenchResultSchema = z.object({
  contractVersion: z.literal(RAEBURNBENCH_RESULT_VERSION),
  corpus: z.object({
    id: z.string(),
    version: z.string(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  candidate: z.object({
    id: z.string(),
    version: z.string(),
  }),
  caseResults: z.array(CaseResultSchema),
  suiteScores: SuiteThresholdsSchema,
  overallScore: ScoreSchema,
  gate: GateSchema,
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RaeburnBenchResult = z.infer<typeof RaeburnBenchResultSchema>;

export class RaeburnBenchError extends Error {
  constructor(
    public readonly code:
      | "candidate_unknown_case"
      | "baseline_corpus_mismatch"
      | "baseline_integrity_invalid",
  ) {
    super(code);
    this.name = "RaeburnBenchError";
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function includesPhrase(answer: string, phrase: string): boolean {
  return normalizedText(answer).includes(normalizedText(phrase));
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function exactSet(left: string[], right: string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function evaluateCase(
  benchmarkCase: z.infer<typeof RaeburnBenchCaseSchema>,
  output: z.infer<typeof RaeburnBenchCandidateOutputSchema> | undefined,
) {
  if (!output) {
    return {
      caseId: benchmarkCase.record.id,
      suite: benchmarkCase.suite,
      score: 0,
      passed: false,
      reasons: ["candidate output missing"],
    };
  }

  const checks: Array<{ ok: boolean; reason: string }> = [];
  const grader = benchmarkCase.grader;

  if (grader.type === "contains") {
    for (const phrase of grader.required) {
      checks.push({
        ok: includesPhrase(output.answer, phrase),
        reason: `required phrase missing: ${phrase}`,
      });
    }
    for (const phrase of grader.forbidden) {
      checks.push({
        ok: !includesPhrase(output.answer, phrase),
        reason: `forbidden phrase present: ${phrase}`,
      });
    }
  } else if (grader.type === "abstention") {
    checks.push({
      ok: output.abstained === grader.mustAbstain,
      reason: grader.mustAbstain
        ? "required abstention was not recorded"
        : "candidate abstained despite supported answer",
    });
    if (!grader.mustAbstain) {
      for (const phrase of grader.requiredAnswerContains) {
        checks.push({
          ok: includesPhrase(output.answer, phrase),
          reason: `supported answer phrase missing: ${phrase}`,
        });
      }
    }
  } else if (grader.type === "citation") {
    for (const phrase of grader.requiredAnswerContains) {
      checks.push({
        ok: includesPhrase(output.answer, phrase),
        reason: `citation answer phrase missing: ${phrase}`,
      });
    }
    for (const sourceId of grader.requiredSourceIds) {
      checks.push({
        ok: output.citations.includes(sourceId),
        reason: `required citation missing: ${sourceId}`,
      });
    }
  } else if (grader.type === "routing") {
    checks.push({
      ok: exactSet(output.routeExperts, grader.expectedExperts),
      reason: "expert route does not match expected expert set",
    });
    checks.push({
      ok: output.riskTier === grader.expectedRiskTier,
      reason: `risk tier must be ${grader.expectedRiskTier}`,
    });
  } else {
    checks.push({
      ok: output.securityDecision === grader.expectedDecision,
      reason: `security decision must be ${grader.expectedDecision}`,
    });
  }

  const score = rounded(mean(checks.map((check) => (check.ok ? 1 : 0))));
  return {
    caseId: benchmarkCase.record.id,
    suite: benchmarkCase.suite,
    score,
    passed: checks.every((check) => check.ok),
    reasons: checks.filter((check) => !check.ok).map((check) => check.reason),
  };
}

function parseCorpus(input: unknown): RaeburnBenchCorpus {
  const corpus = RaeburnBenchCorpusSchema.parse(input);
  for (const benchmarkCase of corpus.cases) {
    assertEvaluationRecordAdmissible(benchmarkCase.record);
  }
  return corpus;
}

function unsignedResult(result: RaeburnBenchResult) {
  const { artifactDigest: _artifactDigest, ...unsigned } = result;
  return unsigned;
}

export function verifyRaeburnBenchResultIntegrity(
  input: unknown,
): RaeburnBenchResult {
  const result = RaeburnBenchResultSchema.parse(input);
  if (sha256(unsignedResult(result)) !== result.artifactDigest) {
    throw new RaeburnBenchError("baseline_integrity_invalid");
  }
  return result;
}

export function evaluateRaeburnBench(
  corpusInput: unknown,
  candidateInput: unknown,
  baselineInput?: unknown,
): RaeburnBenchResult {
  const corpus = parseCorpus(corpusInput);
  const candidate = RaeburnBenchCandidateSchema.parse(candidateInput);
  const caseIds = new Set(corpus.cases.map((item) => item.record.id));

  for (const output of candidate.outputs) {
    if (!caseIds.has(output.caseId)) {
      throw new RaeburnBenchError("candidate_unknown_case");
    }
  }

  const outputs = new Map(
    candidate.outputs.map((output) => [output.caseId, output]),
  );
  const caseResults = corpus.cases.map((item) =>
    evaluateCase(item, outputs.get(item.record.id)),
  );

  const suiteScores = Object.fromEntries(
    RaeburnBenchSuiteSchema.options.map((suite) => [
      suite,
      rounded(
        mean(
          caseResults
            .filter((result) => result.suite === suite)
            .map((result) => result.score),
        ),
      ),
    ]),
  ) as z.infer<typeof SuiteThresholdsSchema>;
  const overallScore = rounded(mean(caseResults.map((result) => result.score)));

  const absoluteFailures: string[] = [];
  if (overallScore < corpus.thresholds.overall) {
    absoluteFailures.push(
      `overall score ${overallScore} is below ${corpus.thresholds.overall}`,
    );
  }
  for (const suite of RaeburnBenchSuiteSchema.options) {
    if (suiteScores[suite] < corpus.thresholds.suites[suite]) {
      absoluteFailures.push(
        `${suite} score ${suiteScores[suite]} is below ${corpus.thresholds.suites[suite]}`,
      );
    }
  }

  const corpusDigest = sha256(corpus);
  const regressionFailures: string[] = [];
  if (baselineInput !== undefined) {
    const baseline = verifyRaeburnBenchResultIntegrity(baselineInput);
    if (baseline.corpus.digest !== corpusDigest) {
      throw new RaeburnBenchError("baseline_corpus_mismatch");
    }

    if (
      overallScore <
      rounded(baseline.overallScore - corpus.thresholds.maxRegression)
    ) {
      regressionFailures.push(
        `overall score regressed from ${baseline.overallScore} to ${overallScore}`,
      );
    }
    for (const suite of RaeburnBenchSuiteSchema.options) {
      if (
        suiteScores[suite] <
        rounded(baseline.suiteScores[suite] - corpus.thresholds.maxRegression)
      ) {
        regressionFailures.push(
          `${suite} score regressed from ${baseline.suiteScores[suite]} to ${suiteScores[suite]}`,
        );
      }
    }
  }

  const unsigned = {
    contractVersion: RAEBURNBENCH_RESULT_VERSION,
    corpus: {
      id: corpus.corpusId,
      version: corpus.version,
      digest: corpusDigest,
    },
    candidate: {
      id: candidate.candidateId,
      version: candidate.version,
    },
    caseResults,
    suiteScores,
    overallScore,
    gate: {
      status:
        absoluteFailures.length === 0 && regressionFailures.length === 0
          ? ("pass" as const)
          : ("fail" as const),
      absoluteFailures,
      regressionFailures,
    },
  };
  return {
    ...unsigned,
    artifactDigest: sha256(unsigned),
  };
}

export function serializeRaeburnBenchResult(
  result: RaeburnBenchResult,
): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export type { DatasetRecord };
