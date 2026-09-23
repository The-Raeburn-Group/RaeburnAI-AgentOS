import { createHash } from "node:crypto";
import { z } from "zod";
import {
  EVIDENCE_PROTOCOL_VERSION,
  type AdjudicationResult,
  type EvidenceStrictness,
} from "@/lib/collaboration";

export const EVIDENCE_VERIFICATION_VERSION =
  "raeburnai.evidence-verification.v1" as const;

const SourceTypeSchema = z.enum([
  "primary",
  "secondary",
  "internal",
  "unknown",
]);

export const TrustedEvidenceSourceSchema = z.object({
  id: z.string().trim().min(1).max(256),
  uri: z.string().url(),
  title: z.string().trim().min(1).max(500),
  sourceType: SourceTypeSchema,
  retrievedAt: z.string().datetime(),
  documentId: z.string().trim().min(1).max(256),
  documentVersion: z.string().trim().min(1).max(128),
  chunkId: z.string().trim().min(1).max(256),
  excerpt: z
    .string()
    .min(1)
    .max(20_000)
    .refine((value) => value.trim().length > 0, {
      message: "source excerpt cannot be blank",
    }),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type TrustedEvidenceSource = z.infer<typeof TrustedEvidenceSourceSchema>;

export const EvidenceVerificationClaimSchema = z.object({
  id: z.string().trim().min(1).max(256),
  claim: z
    .string()
    .trim()
    .min(1)
    .max(10_000)
    .refine((value) => normalizedText(value).length > 0, {
      message: "claim must contain semantic text",
    }),
  sourceIds: z
    .array(z.string().trim().min(1).max(256))
    .min(1)
    .refine((values) => new Set(values).size === values.length, {
      message: "claim sourceIds must be unique",
    }),
  material: z.boolean().default(true),
});
export type EvidenceVerificationClaim = z.infer<
  typeof EvidenceVerificationClaimSchema
>;

export const CalculationClaimSchema = z.object({
  id: z.string().trim().min(1).max(256),
  expression: z.string().trim().min(1).max(256),
  assertedResult: z.number().finite(),
  absoluteTolerance: z.number().finite().min(0).default(1e-9),
  relativeTolerance: z.number().finite().min(0).max(1).default(1e-9),
  unit: z.string().trim().min(1).max(64).optional(),
  material: z.boolean().default(true),
});
export type CalculationClaim = z.infer<typeof CalculationClaimSchema>;

export const CriticFindingSchema = z.object({
  id: z.string().trim().min(1).max(256),
  category: z.enum([
    "factuality",
    "citation",
    "calculation",
    "instruction_following",
    "completeness",
    "safety",
    "calibration",
  ]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().trim().min(1).max(4_000),
  claimIds: z.array(z.string().trim().min(1).max(256)).default([]),
  sourceIds: z.array(z.string().trim().min(1).max(256)).default([]),
});
export type CriticFinding = z.infer<typeof CriticFindingSchema>;

export const CriticReviewSchema = z.object({
  reviewer: z.object({
    provider: z.string().trim().min(1).max(128),
    model: z.string().trim().min(1).max(256),
    family: z.string().trim().min(1).max(128),
  }),
  primaryModelFamily: z.string().trim().min(1).max(128),
  findings: z.array(CriticFindingSchema).default([]),
});
export type CriticReview = z.infer<typeof CriticReviewSchema>;

export const EvidenceVerificationRequestSchema = z
  .object({
    contractVersion: z
      .literal(EVIDENCE_VERIFICATION_VERSION)
      .default(EVIDENCE_VERIFICATION_VERSION),
    strictness: z.enum(["standard", "high", "regulated"]).default("standard"),
    answer: z.string().max(100_000).default(""),
    sources: z.array(TrustedEvidenceSourceSchema).default([]),
    claims: z.array(EvidenceVerificationClaimSchema).default([]),
    calculations: z.array(CalculationClaimSchema).default([]),
    contradictionSearchPerformed: z.boolean().default(false),
    criticReview: CriticReviewSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.claims.length === 0 && value.calculations.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims"],
        message: "verification requires at least one claim or calculation",
      });
    }
    if (
      !value.claims.some((claim) => claim.material) &&
      !value.calculations.some((calculation) => calculation.material)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["claims"],
        message: "verification requires at least one material assertion",
      });
    }
  });
export type EvidenceVerificationRequest = z.infer<
  typeof EvidenceVerificationRequestSchema
>;

const SourceEvaluationSchema = z.object({
  sourceId: z.string(),
  integrityValid: z.boolean(),
  relation: z.enum(["supports", "contradicts", "unclear"]),
  quality: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});

const ClaimVerificationResultSchema = z.object({
  id: z.string(),
  verdict: z.enum(["supported", "contradicted", "conflicted", "insufficient"]),
  material: z.boolean(),
  qualityScore: z.number().min(0).max(1),
  sourceEvaluations: z.array(SourceEvaluationSchema),
  reasons: z.array(z.string()),
});

const CalculationVerificationResultSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  material: z.boolean(),
  assertedResult: z.number(),
  computedResult: z.number().nullable(),
  tolerance: z.number().min(0),
  unit: z.string().optional(),
  error: z.string().nullable(),
});

const CriticVerificationResultSchema = z.object({
  independentModelFamily: z.boolean(),
  substantiatedFindingIds: z.array(z.string()),
  ignoredFindingIds: z.array(z.string()),
  reasons: z.array(z.string()),
});

export const EvidenceVerificationResultSchema = z.object({
  contractVersion: z.literal(EVIDENCE_VERIFICATION_VERSION),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum(["pass", "review", "fail"]),
  strictness: z.enum(["standard", "high", "regulated"]),
  claimResults: z.array(ClaimVerificationResultSchema),
  calculationResults: z.array(CalculationVerificationResultSchema),
  critic: CriticVerificationResultSchema,
  scores: z.object({
    correctness: z.number().min(0).max(1),
    evidenceIntegrity: z.number().min(0).max(1),
    citationIntegrity: z.number().min(0).max(1),
    calculationAccuracy: z.number().min(0).max(1),
    contradictionCoverage: z.number().min(0).max(1),
    answerCoverage: z.number().min(0).max(1),
    overall: z.number().min(0).max(1),
  }),
  reasons: z.array(z.string()),
  unresolvedRisks: z.array(z.string()),
});
export type EvidenceVerificationResult = z.infer<
  typeof EvidenceVerificationResultSchema
>;

export class EvidenceVerificationError extends Error {
  constructor(
    public readonly code:
      | "duplicate_source_id"
      | "duplicate_claim_id"
      | "duplicate_calculation_id"
      | "duplicate_critic_finding_id"
      | "unknown_claim_source"
      | "unknown_critic_claim"
      | "unknown_critic_source"
      | "invalid_evidence_protocol",
    public readonly detail?: string,
  ) {
    super(detail ? code + ": " + detail : code);
    this.name = "EvidenceVerificationError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evidenceSourceContentHash(excerpt: string): string {
  return sha256Text(excerpt);
}

export function evidenceVerificationDigest(
  request: EvidenceVerificationRequest,
): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9.%+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
]);

function materialTokens(value: string): string[] {
  return [
    ...new Set(
      normalizedText(value)
        .split(" ")
        .filter(
          (token) =>
            token.length >= 3 &&
            !STOP_WORDS.has(token) &&
            !/^[+-]?\d+(?:\.\d+)?%?$/.test(token),
        ),
    ),
  ];
}

function numbers(value: string): number[] {
  const matches = normalizedText(value).match(/[+-]?\d+(?:\.\d+)?/g) ?? [];
  return matches
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
}

function hasNegation(value: string): boolean {
  return /(?:^|\s)(?:not|no|never|false|incorrect|cannot|wont|doesnt|didnt|isnt|arent)(?:\s|$)/.test(
    normalizedText(value),
  );
}

function sourceRelation(
  claim: string,
  source: TrustedEvidenceSource,
): { relation: "supports" | "contradicts" | "unclear"; reasons: string[] } {
  const normalizedClaim = normalizedText(claim);
  if (!normalizedClaim) {
    return {
      relation: "unclear",
      reasons: ["claim normalizes to empty text"],
    };
  }

  const claimTokens = materialTokens(claim);
  const claimNumbers = numbers(claim);
  const statements = source.excerpt
    .split(/(?:\r?\n|;|(?<=[.!?])\s+)/)
    .map((statement) => statement.trim())
    .filter((statement) => normalizedText(statement).length > 0);

  let best:
    | {
        statement: string;
        normalized: string;
        overlap: number;
        numericMismatch: boolean;
        negationMismatch: boolean;
      }
    | undefined;

  for (const statement of statements) {
    const normalized = normalizedText(statement);
    if (normalized.includes(normalizedClaim)) {
      return {
        relation: "supports",
        reasons: ["claim appears directly in a trusted source statement"],
      };
    }

    const statementTokens = new Set(materialTokens(statement));
    const overlap =
      claimTokens.length === 0
        ? 0
        : claimTokens.filter((token) => statementTokens.has(token)).length /
          claimTokens.length;
    const statementNumbers = numbers(statement);
    const numericMismatch =
      claimNumbers.length > 0 &&
      statementNumbers.length > 0 &&
      claimNumbers.some(
        (value) => !statementNumbers.some((candidate) => candidate === value),
      );
    const negationMismatch = hasNegation(claim) !== hasNegation(statement);

    if (!best || overlap > best.overlap) {
      best = {
        statement,
        normalized,
        overlap,
        numericMismatch,
        negationMismatch,
      };
    }
  }

  if (
    best &&
    best.overlap >= 0.8 &&
    (best.negationMismatch || best.numericMismatch)
  ) {
    return {
      relation: "contradicts",
      reasons: [
        best.negationMismatch
          ? "best-matching source statement has opposing negation"
          : "best-matching source statement has conflicting numeric evidence",
      ],
    };
  }

  if (
    best &&
    claimTokens.length >= 2 &&
    best.overlap >= 0.85 &&
    !best.numericMismatch
  ) {
    return {
      relation: "supports",
      reasons: [
        "best-matching trusted source statement has strong material-token coverage",
      ],
    };
  }

  return {
    relation: "unclear",
    reasons: [
      "trusted source excerpt does not independently establish the claim",
    ],
  };
}

function sourceQuality(
  sourceType: TrustedEvidenceSource["sourceType"],
): number {
  if (sourceType === "primary") return 1;
  if (sourceType === "internal") return 0.9;
  if (sourceType === "secondary") return 0.75;
  return 0.25;
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mean(values: number[]): number {
  if (values.length === 0) return 1;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ensureUnique(
  values: string[],
  code:
    | "duplicate_source_id"
    | "duplicate_claim_id"
    | "duplicate_calculation_id"
    | "duplicate_critic_finding_id",
) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new EvidenceVerificationError(code, value);
    seen.add(value);
  }
}

function requiredSupportingSources(strictness: EvidenceStrictness): number {
  return strictness === "regulated" ? 2 : 1;
}

class ArithmeticParser {
  private index = 0;

  constructor(private readonly input: string) {}

  parse(): number {
    if (this.input.length > 256) throw new Error("expression_too_long");
    const value = this.parseExpression();
    this.skipWhitespace();
    if (this.index !== this.input.length) {
      throw new Error("unsupported_expression_token");
    }
    if (!Number.isFinite(value)) throw new Error("non_finite_result");
    return value;
  }

  private skipWhitespace() {
    while (/\s/.test(this.input[this.index] ?? "")) this.index += 1;
  }

  private peek(): string {
    this.skipWhitespace();
    return this.input[this.index] ?? "";
  }

  private consume(value: string): boolean {
    if (this.peek() !== value) return false;
    this.index += 1;
    return true;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      if (this.consume("+")) value += this.parseTerm();
      else if (this.consume("-")) value -= this.parseTerm();
      else break;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (true) {
      if (this.consume("*")) value *= this.parseFactor();
      else if (this.consume("/")) {
        const divisor = this.parseFactor();
        if (divisor === 0) throw new Error("division_by_zero");
        value /= divisor;
      } else {
        break;
      }
    }
    return value;
  }

  private parseFactor(): number {
    let sign = 1;
    while (true) {
      if (this.consume("+")) continue;
      if (this.consume("-")) sign *= -1;
      else break;
    }

    let value: number;
    if (this.consume("(")) {
      value = this.parseExpression();
      if (!this.consume(")")) throw new Error("unclosed_parenthesis");
    } else {
      value = this.parseNumber();
    }

    while (this.consume("%")) value /= 100;
    return sign * value;
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const rest = this.input.slice(this.index);
    const match = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error("number_expected");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("invalid_number");
    return value;
  }
}

export function evaluateArithmeticExpression(expression: string): number {
  if (!/^[0-9eE+\-*/().%\s]+$/.test(expression)) {
    throw new Error("unsupported_expression_token");
  }
  return new ArithmeticParser(expression).parse();
}

function verifyCalculation(
  calculation: CalculationClaim,
): z.infer<typeof CalculationVerificationResultSchema> {
  try {
    const computed = evaluateArithmeticExpression(calculation.expression);
    const tolerance = Math.max(
      calculation.absoluteTolerance,
      Math.abs(calculation.assertedResult) * calculation.relativeTolerance,
    );
    return {
      id: calculation.id,
      passed: Math.abs(computed - calculation.assertedResult) <= tolerance,
      material: calculation.material,
      assertedResult: calculation.assertedResult,
      computedResult: computed,
      tolerance,
      ...(calculation.unit ? { unit: calculation.unit } : {}),
      error: null,
    };
  } catch (error) {
    return {
      id: calculation.id,
      passed: false,
      material: calculation.material,
      assertedResult: calculation.assertedResult,
      computedResult: null,
      tolerance: Math.max(
        calculation.absoluteTolerance,
        Math.abs(calculation.assertedResult) * calculation.relativeTolerance,
      ),
      ...(calculation.unit ? { unit: calculation.unit } : {}),
      error: error instanceof Error ? error.message : "calculation_error",
    };
  }
}

function claimVerdict(options: {
  claim: EvidenceVerificationClaim;
  sources: TrustedEvidenceSource[];
  strictness: EvidenceStrictness;
}) {
  const { claim, sources, strictness } = options;
  const evaluations = sources.map((source) => {
    const integrityValid =
      evidenceSourceContentHash(source.excerpt) === source.contentHash;
    const relation = integrityValid
      ? sourceRelation(claim.claim, source)
      : {
          relation: "unclear" as const,
          reasons: ["source excerpt does not match its declared SHA-256 hash"],
        };
    return {
      sourceId: source.id,
      integrityValid,
      relation: relation.relation,
      quality: integrityValid ? sourceQuality(source.sourceType) : 0,
      reasons: relation.reasons,
    };
  });

  const supports = evaluations.filter(
    (evaluation) => evaluation.relation === "supports",
  );
  const contradicts = evaluations.filter(
    (evaluation) => evaluation.relation === "contradicts",
  );
  const bestSupport = Math.max(0, ...supports.map((item) => item.quality));
  const bestContradiction = Math.max(
    0,
    ...contradicts.map((item) => item.quality),
  );
  const reasons: string[] = [];
  let direction: "support" | "contradiction" | "conflict" | "none" = "none";

  if (supports.length > 0 && contradicts.length > 0) {
    const difference = Math.abs(bestSupport - bestContradiction);
    if (difference < 0.2) {
      direction = "conflict";
      reasons.push(
        "material supporting and contradicting evidence have comparable quality",
      );
    } else if (bestSupport > bestContradiction) {
      direction = "support";
      reasons.push(
        "higher-quality evidence supports the claim despite contradiction",
      );
    } else {
      direction = "contradiction";
      reasons.push("higher-quality evidence contradicts the claim");
    }
  } else if (contradicts.length > 0) {
    direction = "contradiction";
    reasons.push("trusted evidence contradicts the claim");
  } else if (supports.length > 0) {
    direction = "support";
  } else {
    reasons.push("no trusted source independently supports the material claim");
  }

  let verdict: "supported" | "contradicted" | "conflicted" | "insufficient" =
    direction === "contradiction"
      ? "contradicted"
      : direction === "conflict"
        ? "conflicted"
        : "insufficient";

  if (direction === "support") {
    const validSupportingIds = new Set(supports.map((item) => item.sourceId));
    const minimum = requiredSupportingSources(strictness);
    const primaryPresent = sources.some(
      (source) =>
        source.sourceType === "primary" &&
        validSupportingIds.has(source.id) &&
        evidenceSourceContentHash(source.excerpt) === source.contentHash,
    );

    if (
      validSupportingIds.size >= minimum &&
      (strictness !== "regulated" || primaryPresent)
    ) {
      verdict = "supported";
      reasons.push(
        "claim meets the minimum independently verified supporting-source policy",
      );
    } else {
      verdict = "insufficient";
      reasons.push(
        strictness === "regulated" && !primaryPresent
          ? "regulated claim lacks independently verified primary-source support"
          : "claim lacks the required number of distinct independently verified supporting sources",
      );
    }
  }

  return {
    id: claim.id,
    verdict,
    material: claim.material,
    qualityScore: rounded(Math.max(bestSupport, bestContradiction)),
    sourceEvaluations: evaluations,
    reasons,
  };
}

function verifyCritic(options: {
  review: CriticReview | undefined;
  strictness: EvidenceStrictness;
  claimIds: Set<string>;
  sourceMap: Map<string, TrustedEvidenceSource>;
  validSourceIds: Set<string>;
}) {
  const { review, strictness, claimIds, sourceMap, validSourceIds } = options;
  const sourceIds = new Set(sourceMap.keys());
  if (!review) {
    return {
      independentModelFamily: false,
      substantiatedFindingIds: [] as string[],
      ignoredFindingIds: [] as string[],
      reasons:
        strictness === "standard"
          ? ["critic review was not supplied"]
          : [
              "high-assurance verification requires an independent critic review",
            ],
    };
  }

  const independent =
    review.reviewer.family.trim().toLowerCase() !==
    review.primaryModelFamily.trim().toLowerCase();
  ensureUnique(
    review.findings.map((finding) => finding.id),
    "duplicate_critic_finding_id",
  );

  const substantiated: string[] = [];
  const ignored: string[] = [];
  const reasons: string[] = [];

  for (const finding of review.findings) {
    for (const claimId of finding.claimIds) {
      if (!claimIds.has(claimId)) {
        throw new EvidenceVerificationError("unknown_critic_claim", claimId);
      }
    }
    for (const sourceId of finding.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new EvidenceVerificationError("unknown_critic_source", sourceId);
      }
    }

    const evidenceGrounded =
      finding.sourceIds.length > 0 &&
      finding.sourceIds.every((sourceId) => validSourceIds.has(sourceId)) &&
      finding.sourceIds.some((sourceId) => {
        const source = sourceMap.get(sourceId);
        if (!source) return false;
        return sourceRelation(finding.summary, source).relation === "supports";
      });
    if (evidenceGrounded) substantiated.push(finding.id);
    else ignored.push(finding.id);
  }

  if (!independent) {
    reasons.push("critic model family matches the primary model family");
  }
  if (ignored.length > 0) {
    reasons.push(
      "critic findings without independently integrity-verified evidence were not allowed to override the evidence result",
    );
  }

  return {
    independentModelFamily: independent,
    substantiatedFindingIds: substantiated,
    ignoredFindingIds: ignored,
    reasons,
  };
}

function deduplicatedReasons(values: string[]): string[] {
  return [...new Set(values)];
}

function answerStatements(answer: string): string[] {
  return answer
    .split(/(?:\r?\n|;|(?<=[.!?])\s+)/)
    .map((statement) => statement.trim())
    .filter((statement) => normalizedText(statement).length > 0);
}

function claimCoversAnswerStatement(
  statement: string,
  claim: EvidenceVerificationClaim,
): boolean {
  if (!claim.material) return false;
  const statementTokens = materialTokens(statement);
  const claimTokens = new Set(materialTokens(claim.claim));
  const statementNumbers = numbers(statement);
  const claimNumbers = numbers(claim.claim);
  const tokenCoverage =
    statementTokens.length === 0
      ? normalizedText(statement) === normalizedText(claim.claim)
        ? 1
        : 0
      : statementTokens.filter((token) => claimTokens.has(token)).length /
        statementTokens.length;
  const numbersCovered = statementNumbers.every((value) =>
    claimNumbers.some((candidate) => candidate === value),
  );
  return tokenCoverage >= 0.8 && numbersCovered;
}

function calculationCoversAnswerStatement(
  statement: string,
  calculation: CalculationClaim,
): boolean {
  if (!calculation.material) return false;
  const genericCalculationWords = new Set([
    "amount",
    "calculation",
    "result",
    "total",
    "value",
  ]);
  const statementTokens = materialTokens(statement);
  const statementNumbers = numbers(statement);
  const tolerance = Math.max(
    calculation.absoluteTolerance,
    Math.abs(calculation.assertedResult) * calculation.relativeTolerance,
  );
  const resultPresent = statementNumbers.some(
    (value) => Math.abs(value - calculation.assertedResult) <= tolerance,
  );
  return (
    resultPresent &&
    statementTokens.every((token) => genericCalculationWords.has(token))
  );
}

function verifyAnswerCoverage(request: EvidenceVerificationRequest): {
  score: number;
  uncoveredStatements: string[];
} {
  const statements = answerStatements(request.answer);
  if (statements.length === 0) {
    return { score: 0, uncoveredStatements: ["answer is blank"] };
  }

  const uncoveredStatements = statements.filter(
    (statement) =>
      !request.claims.some((claim) =>
        claimCoversAnswerStatement(statement, claim),
      ) &&
      !request.calculations.some((calculation) =>
        calculationCoversAnswerStatement(statement, calculation),
      ),
  );
  return {
    score: rounded(
      (statements.length - uncoveredStatements.length) / statements.length,
    ),
    uncoveredStatements,
  };
}

export function verifyEvidenceBundle(
  input: unknown,
): EvidenceVerificationResult {
  const request = EvidenceVerificationRequestSchema.parse(input);
  ensureUnique(
    request.sources.map((source) => source.id),
    "duplicate_source_id",
  );
  ensureUnique(
    request.claims.map((claim) => claim.id),
    "duplicate_claim_id",
  );
  ensureUnique(
    request.calculations.map((calculation) => calculation.id),
    "duplicate_calculation_id",
  );

  const sourceMap = new Map(
    request.sources.map((source) => [source.id, source]),
  );
  const sourceIds = new Set(sourceMap.keys());
  for (const claim of request.claims) {
    for (const sourceId of claim.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new EvidenceVerificationError("unknown_claim_source", sourceId);
      }
    }
  }

  const validSourceIds = new Set(
    request.sources
      .filter(
        (source) =>
          evidenceSourceContentHash(source.excerpt) === source.contentHash,
      )
      .map((source) => source.id),
  );

  const claimResults = request.claims.map((claim) =>
    claimVerdict({
      claim,
      sources: claim.sourceIds.map((sourceId) => sourceMap.get(sourceId)!),
      strictness: request.strictness,
    }),
  );
  const calculationResults = request.calculations.map(verifyCalculation);
  const answerCoverage = verifyAnswerCoverage(request);
  const critic = verifyCritic({
    review: request.criticReview,
    strictness: request.strictness,
    claimIds: new Set(request.claims.map((claim) => claim.id)),
    sourceMap,
    validSourceIds,
  });

  const materialClaims = claimResults.filter((claim) => claim.material);
  const materialCalculations = calculationResults.filter(
    (calculation) => calculation.material,
  );
  const highCriticFindings = (request.criticReview?.findings ?? []).filter(
    (finding) =>
      (finding.severity === "high" || finding.severity === "critical") &&
      critic.substantiatedFindingIds.includes(finding.id),
  );

  const hardFailures: string[] = [];
  const reviewReasons: string[] = [];
  const unresolvedRisks: string[] = [];

  for (const statement of answerCoverage.uncoveredStatements) {
    hardFailures.push(
      "answer assertion is not covered by the claim inventory: " + statement,
    );
  }

  if (
    (request.strictness === "high" || request.strictness === "regulated") &&
    !request.contradictionSearchPerformed
  ) {
    hardFailures.push(
      "high-assurance verification requires a completed contradiction search",
    );
  }
  if (
    (request.strictness === "high" || request.strictness === "regulated") &&
    !critic.independentModelFamily
  ) {
    hardFailures.push(
      "high-assurance verification requires a critic from an independent model family",
    );
  }

  for (const source of request.sources) {
    if (!validSourceIds.has(source.id)) {
      hardFailures.push(
        "source integrity failure for evidence source " + source.id,
      );
    }
    if (
      (request.strictness === "high" || request.strictness === "regulated") &&
      source.sourceType === "unknown"
    ) {
      hardFailures.push(
        "high-assurance verification cannot rely on unknown source type " +
          source.id,
      );
    }
  }

  for (const claim of materialClaims) {
    if (claim.verdict === "contradicted") {
      hardFailures.push("material claim is contradicted: " + claim.id);
    } else if (claim.verdict === "conflicted") {
      hardFailures.push(
        "material claim has unresolved evidence conflict: " + claim.id,
      );
    } else if (claim.verdict === "insufficient") {
      if (request.strictness === "standard") {
        reviewReasons.push(
          "material claim lacks sufficient evidence: " + claim.id,
        );
      } else {
        hardFailures.push(
          "material claim lacks sufficient evidence: " + claim.id,
        );
      }
    }
  }

  for (const calculation of materialCalculations) {
    if (!calculation.passed) {
      hardFailures.push(
        "material calculation failed verification: " + calculation.id,
      );
    }
  }

  for (const finding of highCriticFindings) {
    if (request.strictness === "standard") {
      reviewReasons.push(
        "substantiated high-severity critic finding: " + finding.id,
      );
    } else {
      hardFailures.push(
        "substantiated high-severity critic finding: " + finding.id,
      );
    }
  }

  if (critic.ignoredFindingIds.length > 0) {
    unresolvedRisks.push(
      "unsubstantiated critic findings were retained as unresolved risks and did not override verified evidence",
    );
  }

  const correctness = rounded(
    mean(
      materialClaims.map((claim) => (claim.verdict === "supported" ? 1 : 0)),
    ),
  );
  const evidenceIntegrity = rounded(
    mean(
      request.sources.map((source) => (validSourceIds.has(source.id) ? 1 : 0)),
    ),
  );
  const citationIntegrity = rounded(
    mean(
      request.claims.map((claim) =>
        claim.sourceIds.every((sourceId) => validSourceIds.has(sourceId))
          ? 1
          : 0,
      ),
    ),
  );
  const calculationAccuracy = rounded(
    mean(
      materialCalculations.map((calculation) => (calculation.passed ? 1 : 0)),
    ),
  );
  const contradictionCoverage =
    request.strictness === "standard"
      ? 1
      : request.contradictionSearchPerformed
        ? 1
        : 0;
  const overall = rounded(
    mean([
      correctness,
      evidenceIntegrity,
      citationIntegrity,
      calculationAccuracy,
      contradictionCoverage,
      answerCoverage.score,
    ]),
  );

  const decision =
    hardFailures.length > 0
      ? ("fail" as const)
      : reviewReasons.length > 0 || unresolvedRisks.length > 0
        ? ("review" as const)
        : ("pass" as const);

  return EvidenceVerificationResultSchema.parse({
    contractVersion: EVIDENCE_VERIFICATION_VERSION,
    bundleDigest: evidenceVerificationDigest(request),
    decision,
    strictness: request.strictness,
    claimResults,
    calculationResults,
    critic,
    scores: {
      correctness,
      evidenceIntegrity,
      citationIntegrity,
      calculationAccuracy,
      contradictionCoverage,
      answerCoverage: answerCoverage.score,
      overall,
    },
    reasons: deduplicatedReasons([...hardFailures, ...reviewReasons]),
    unresolvedRisks: deduplicatedReasons(unresolvedRisks),
  });
}

export function buildVerificationRequestFromAdjudication(options: {
  adjudication: AdjudicationResult;
  strictness: EvidenceStrictness;
  trustedSources: TrustedEvidenceSource[];
  calculations?: CalculationClaim[];
  criticReview?: CriticReview;
}): EvidenceVerificationRequest {
  const {
    adjudication,
    strictness,
    trustedSources,
    calculations = [],
    criticReview,
  } = options;
  if (adjudication.evidenceProtocolVersion !== EVIDENCE_PROTOCOL_VERSION) {
    throw new EvidenceVerificationError(
      "invalid_evidence_protocol",
      String(adjudication.evidenceProtocolVersion ?? "missing"),
    );
  }

  const trustedIds = new Set(trustedSources.map((source) => source.id));
  for (const claim of adjudication.claims) {
    for (const sourceId of claim.sourceIds) {
      if (!trustedIds.has(sourceId)) {
        throw new EvidenceVerificationError("unknown_claim_source", sourceId);
      }
    }
  }

  return EvidenceVerificationRequestSchema.parse({
    contractVersion: EVIDENCE_VERIFICATION_VERSION,
    strictness,
    answer: adjudication.decision,
    sources: trustedSources,
    claims: adjudication.claims.map((claim, index) => ({
      id: "claim-" + (index + 1),
      claim: claim.claim,
      sourceIds: claim.sourceIds,
      material: true,
    })),
    calculations,
    contradictionSearchPerformed: adjudication.contradictionSearchPerformed,
    ...(criticReview ? { criticReview } : {}),
  });
}
