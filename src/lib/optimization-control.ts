import {
  AgentStatus,
  OptimizationExperimentStatus,
  type Agent,
  type OptimizationExperiment,
  type Prisma,
} from "@prisma/client";
import { z } from "zod";
import { agentManifestDigest } from "@/lib/collaboration";
import { db } from "@/lib/db";
import {
  verifyPerformanceBenchmarkResultIntegrity,
  verifyToolBenchmarkResultIntegrity,
} from "@/lib/quality-benchmarks";
import {
  sha256,
  verifyRaeburnBenchResultIntegrity,
} from "@/lib/raeburnbench";
import {
  RoutingPolicyError,
  verifyStoredAgentManifest,
} from "@/lib/routing-policy";

export const OPTIMIZATION_EXPERIMENT_VERSION =
  "raeburnai.optimization-experiment.v1" as const;

export const OptimizationPolicySchema = z.object({
  maxQualityRegression: z.number().min(0).max(0.5).default(0),
  maxToolRegression: z.number().min(0).max(0.5).default(0),
  maxP95LatencyIncreaseRatio: z.number().min(0).max(5).default(0.1),
  maxCostIncreaseRatio: z.number().min(0).max(5).default(0.1),
});
export type OptimizationPolicy = z.infer<typeof OptimizationPolicySchema>;

const BenchmarkBundleSchema = z.object({
  raeburnBench: z.unknown(),
  toolBenchmark: z.unknown(),
  performanceBenchmark: z.unknown(),
});

export const OptimizationEvidenceSchema = z.object({
  baseline: BenchmarkBundleSchema,
  challenger: BenchmarkBundleSchema,
});
export type OptimizationEvidence = z.infer<typeof OptimizationEvidenceSchema>;

export const OptimizationResultSchema = z.object({
  contractVersion: z.literal(OPTIMIZATION_EXPERIMENT_VERSION),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  baseline: z.object({
    candidateId: z.string(),
    version: z.string(),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    qualityScore: z.number().min(0).max(1),
    toolScore: z.number().min(0).max(1),
    p95LatencyMs: z.number().min(0),
    totalCostUsd: z.number().min(0),
  }),
  challenger: z.object({
    candidateId: z.string(),
    version: z.string(),
    manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    qualityScore: z.number().min(0).max(1),
    toolScore: z.number().min(0).max(1),
    p95LatencyMs: z.number().min(0),
    totalCostUsd: z.number().min(0),
  }),
  evidenceDigests: z.object({
    baseline: z.object({
      raeburnBench: z.string().regex(/^[a-f0-9]{64}$/),
      toolBenchmark: z.string().regex(/^[a-f0-9]{64}$/),
      performanceBenchmark: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    challenger: z.object({
      raeburnBench: z.string().regex(/^[a-f0-9]{64}$/),
      toolBenchmark: z.string().regex(/^[a-f0-9]{64}$/),
      performanceBenchmark: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  }),
});
export type OptimizationResult = z.infer<typeof OptimizationResultSchema>;

export class OptimizationControlError extends Error {
  constructor(
    public readonly code:
      | "agent_not_found"
      | "tenant_mismatch"
      | "expert_slug_mismatch"
      | "baseline_not_verified"
      | "challenger_not_draft"
      | "evidence_candidate_mismatch"
      | "benchmark_definition_mismatch"
      | "experiment_not_found"
      | "experiment_not_eligible"
      | "invalid_transition"
      | "stale_state"
      | "baseline_not_current"
      | "manifest_integrity_invalid",
  ) {
    super(code);
    this.name = "OptimizationControlError";
  }
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function expectedCandidate(slug: string, version: string) {
  return { id: "agent:" + slug, version };
}

function sameCandidate(
  actual: { id: string; version: string },
  expected: { id: string; version: string },
) {
  return actual.id === expected.id && actual.version === expected.version;
}

function ratioExceeded(
  challenger: number,
  baseline: number,
  maxIncreaseRatio: number,
): boolean {
  if (baseline === 0) return challenger > 0;
  return challenger > baseline * (1 + maxIncreaseRatio);
}

function verifiedAgent(agent: Agent) {
  try {
    const manifest = verifyStoredAgentManifest(agent.manifest, {
      slug: agent.slug,
      version: agent.version,
      systemPrompt: agent.systemPrompt,
      modelProvider: agent.modelProvider,
      modelName: agent.modelName,
      approvalRequired: agent.approvalRequired,
    });
    return {
      manifest,
      digest: agentManifestDigest(manifest),
    };
  } catch (error) {
    if (error instanceof RoutingPolicyError) {
      throw new OptimizationControlError("manifest_integrity_invalid");
    }
    throw error;
  }
}

function verifyBundle(
  bundle: z.infer<typeof BenchmarkBundleSchema>,
  expected: { id: string; version: string },
) {
  const raeburnBench = verifyRaeburnBenchResultIntegrity(bundle.raeburnBench);
  const toolBenchmark = verifyToolBenchmarkResultIntegrity(bundle.toolBenchmark);
  const performanceBenchmark = verifyPerformanceBenchmarkResultIntegrity(
    bundle.performanceBenchmark,
  );

  if (
    !sameCandidate(raeburnBench.candidate, expected) ||
    !sameCandidate(toolBenchmark.candidate, expected) ||
    !sameCandidate(performanceBenchmark.candidate, expected)
  ) {
    throw new OptimizationControlError("evidence_candidate_mismatch");
  }

  return { raeburnBench, toolBenchmark, performanceBenchmark };
}

export function evaluateOptimizationEvidence(options: {
  slug: string;
  baselineVersion: string;
  challengerVersion: string;
  baselineManifestDigest: string;
  challengerManifestDigest: string;
  evidence: unknown;
  policy?: unknown;
}): OptimizationResult {
  const evidence = OptimizationEvidenceSchema.parse(options.evidence);
  const policy = OptimizationPolicySchema.parse(options.policy ?? {});
  const baselineExpected = expectedCandidate(options.slug, options.baselineVersion);
  const challengerExpected = expectedCandidate(
    options.slug,
    options.challengerVersion,
  );
  const baseline = verifyBundle(evidence.baseline, baselineExpected);
  const challenger = verifyBundle(evidence.challenger, challengerExpected);

  if (
    baseline.raeburnBench.corpus.digest !==
      challenger.raeburnBench.corpus.digest ||
    baseline.raeburnBench.corpus.id !== challenger.raeburnBench.corpus.id ||
    baseline.raeburnBench.corpus.version !==
      challenger.raeburnBench.corpus.version ||
    baseline.toolBenchmark.benchmark.digest !==
      challenger.toolBenchmark.benchmark.digest ||
    baseline.toolBenchmark.benchmark.id !==
      challenger.toolBenchmark.benchmark.id ||
    baseline.toolBenchmark.benchmark.version !==
      challenger.toolBenchmark.benchmark.version ||
    baseline.performanceBenchmark.benchmark.digest !==
      challenger.performanceBenchmark.benchmark.digest ||
    baseline.performanceBenchmark.benchmark.id !==
      challenger.performanceBenchmark.benchmark.id ||
    baseline.performanceBenchmark.benchmark.version !==
      challenger.performanceBenchmark.benchmark.version
  ) {
    throw new OptimizationControlError("benchmark_definition_mismatch");
  }

  const reasons: string[] = [];
  for (const [name, bundle] of [
    ["baseline", baseline],
    ["challenger", challenger],
  ] as const) {
    if (bundle.raeburnBench.gate.status !== "pass") {
      reasons.push(name + " RaeburnBench gate failed");
    }
    if (bundle.toolBenchmark.gate !== "pass") {
      reasons.push(name + " tool-use gate failed");
    }
    if (bundle.performanceBenchmark.gate !== "pass") {
      reasons.push(name + " performance gate failed");
    }
  }

  if (
    challenger.raeburnBench.overallScore <
    baseline.raeburnBench.overallScore - policy.maxQualityRegression
  ) {
    reasons.push("challenger quality regression exceeds policy");
  }
  if (
    challenger.toolBenchmark.score <
    baseline.toolBenchmark.score - policy.maxToolRegression
  ) {
    reasons.push("challenger tool-use regression exceeds policy");
  }
  if (
    ratioExceeded(
      challenger.performanceBenchmark.p95LatencyMs,
      baseline.performanceBenchmark.p95LatencyMs,
      policy.maxP95LatencyIncreaseRatio,
    )
  ) {
    reasons.push("challenger p95 latency increase exceeds policy");
  }
  if (
    ratioExceeded(
      challenger.performanceBenchmark.totalCostUsd,
      baseline.performanceBenchmark.totalCostUsd,
      policy.maxCostIncreaseRatio,
    )
  ) {
    reasons.push("challenger cost increase exceeds policy");
  }

  return OptimizationResultSchema.parse({
    contractVersion: OPTIMIZATION_EXPERIMENT_VERSION,
    eligible: reasons.length === 0,
    reasons,
    baseline: {
      candidateId: baselineExpected.id,
      version: baselineExpected.version,
      manifestDigest: options.baselineManifestDigest,
      qualityScore: baseline.raeburnBench.overallScore,
      toolScore: baseline.toolBenchmark.score,
      p95LatencyMs: baseline.performanceBenchmark.p95LatencyMs,
      totalCostUsd: baseline.performanceBenchmark.totalCostUsd,
    },
    challenger: {
      candidateId: challengerExpected.id,
      version: challengerExpected.version,
      manifestDigest: options.challengerManifestDigest,
      qualityScore: challenger.raeburnBench.overallScore,
      toolScore: challenger.toolBenchmark.score,
      p95LatencyMs: challenger.performanceBenchmark.p95LatencyMs,
      totalCostUsd: challenger.performanceBenchmark.totalCostUsd,
    },
    evidenceDigests: {
      baseline: {
        raeburnBench: baseline.raeburnBench.artifactDigest,
        toolBenchmark: baseline.toolBenchmark.artifactDigest,
        performanceBenchmark: baseline.performanceBenchmark.artifactDigest,
      },
      challenger: {
        raeburnBench: challenger.raeburnBench.artifactDigest,
        toolBenchmark: challenger.toolBenchmark.artifactDigest,
        performanceBenchmark: challenger.performanceBenchmark.artifactDigest,
      },
    },
  });
}

function experimentArtifact(options: {
  baselineAgentId: string;
  challengerAgentId: string;
  policy: OptimizationPolicy;
  evidence: OptimizationEvidence;
  result: OptimizationResult;
}) {
  const unsigned = {
    contractVersion: OPTIMIZATION_EXPERIMENT_VERSION,
    baselineAgentId: options.baselineAgentId,
    challengerAgentId: options.challengerAgentId,
    policy: options.policy,
    evidence: options.evidence,
    result: options.result,
  };
  return { unsigned, digest: sha256(unsigned) };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

export async function createOptimizationExperiment(options: {
  tenantId: string;
  baselineAgentId: string;
  challengerAgentId: string;
  createdBy: string;
  evidence: unknown;
  policy?: unknown;
}): Promise<OptimizationExperiment> {
  if (options.baselineAgentId === options.challengerAgentId) {
    throw new OptimizationControlError("expert_slug_mismatch");
  }

  const [baseline, challenger] = await Promise.all([
    db.agent.findUnique({ where: { id: options.baselineAgentId } }),
    db.agent.findUnique({ where: { id: options.challengerAgentId } }),
  ]);
  if (!baseline || !challenger) {
    throw new OptimizationControlError("agent_not_found");
  }
  if (
    baseline.tenantId !== options.tenantId ||
    challenger.tenantId !== options.tenantId
  ) {
    throw new OptimizationControlError("tenant_mismatch");
  }
  if (baseline.slug !== challenger.slug) {
    throw new OptimizationControlError("expert_slug_mismatch");
  }
  if (baseline.status !== AgentStatus.VERIFIED) {
    throw new OptimizationControlError("baseline_not_verified");
  }
  if (challenger.status !== AgentStatus.DRAFT) {
    throw new OptimizationControlError("challenger_not_draft");
  }

  const baselineManifest = verifiedAgent(baseline);
  const challengerManifest = verifiedAgent(challenger);
  const policy = OptimizationPolicySchema.parse(options.policy ?? {});
  const evidence = OptimizationEvidenceSchema.parse(options.evidence);
  const result = evaluateOptimizationEvidence({
    slug: baseline.slug,
    baselineVersion: baseline.version,
    challengerVersion: challenger.version,
    baselineManifestDigest: baselineManifest.digest,
    challengerManifestDigest: challengerManifest.digest,
    evidence,
    policy,
  });
  const artifact = experimentArtifact({
    baselineAgentId: baseline.id,
    challengerAgentId: challenger.id,
    policy,
    evidence,
    result,
  });

  const existing = await db.optimizationExperiment.findUnique({
    where: {
      tenantId_artifactDigest: {
        tenantId: options.tenantId,
        artifactDigest: artifact.digest,
      },
    },
  });
  if (existing) return existing;

  try {
    return await db.$transaction(async (tx) => {
      const experiment = await tx.optimizationExperiment.create({
        data: {
          tenantId: options.tenantId,
          baselineAgentId: baseline.id,
          challengerAgentId: challenger.id,
          baselineManifestDigest: baselineManifest.digest,
          challengerManifestDigest: challengerManifest.digest,
          artifactDigest: artifact.digest,
          policy: jsonValue(policy),
          evidence: jsonValue(evidence),
          result: jsonValue(result),
          createdBy: options.createdBy,
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: options.tenantId,
          actor: options.createdBy,
          action: "optimization.experiment.evaluated",
          metadata: {
            experimentId: experiment.id,
            artifactDigest: artifact.digest,
            baselineAgentId: baseline.id,
            challengerAgentId: challenger.id,
            eligible: result.eligible,
            reasons: result.reasons,
          },
        },
      });
      return experiment;
    });
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    const raced = await db.optimizationExperiment.findUnique({
      where: {
        tenantId_artifactDigest: {
          tenantId: options.tenantId,
          artifactDigest: artifact.digest,
        },
      },
    });
    if (raced) return raced;
    throw error;
  }
}

export async function reviewOptimizationExperiment(options: {
  tenantId: string;
  experimentId: string;
  reviewer: string;
  decision: "approve" | "reject";
  note?: string;
}): Promise<OptimizationExperiment> {
  const experiment = await db.optimizationExperiment.findFirst({
    where: { id: options.experimentId, tenantId: options.tenantId },
  });
  if (!experiment) {
    throw new OptimizationControlError("experiment_not_found");
  }
  const result = OptimizationResultSchema.parse(experiment.result);
  if (options.decision === "approve" && !result.eligible) {
    throw new OptimizationControlError("experiment_not_eligible");
  }

  const target =
    options.decision === "approve"
      ? OptimizationExperimentStatus.APPROVED
      : OptimizationExperimentStatus.REJECTED;
  if (experiment.status === target) return experiment;
  if (experiment.status !== OptimizationExperimentStatus.EVALUATED) {
    throw new OptimizationControlError("invalid_transition");
  }

  return db.$transaction(async (tx) => {
    const updated = await tx.optimizationExperiment.updateMany({
      where: {
        id: experiment.id,
        tenantId: options.tenantId,
        status: OptimizationExperimentStatus.EVALUATED,
      },
      data: {
        status: target,
        reviewedBy: options.reviewer,
        reviewNote: options.note ?? null,
        reviewedAt: new Date(),
      },
    });
    const current = await tx.optimizationExperiment.findUniqueOrThrow({
      where: { id: experiment.id },
    });
    if (updated.count !== 1) {
      if (current.status === target) return current;
      throw new OptimizationControlError("invalid_transition");
    }
    await tx.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        actor: options.reviewer,
        action: "optimization.experiment.reviewed",
        metadata: {
          experimentId: experiment.id,
          decision: options.decision,
          artifactDigest: experiment.artifactDigest,
        },
      },
    });
    return current;
  });
}

export async function promoteOptimizationExperiment(options: {
  tenantId: string;
  experimentId: string;
  reviewer: string;
}): Promise<OptimizationExperiment> {
  const initial = await db.optimizationExperiment.findFirst({
    where: { id: options.experimentId, tenantId: options.tenantId },
    include: { baselineAgent: true, challengerAgent: true },
  });
  if (!initial) {
    throw new OptimizationControlError("experiment_not_found");
  }
  if (initial.status !== OptimizationExperimentStatus.APPROVED) {
    throw new OptimizationControlError("invalid_transition");
  }

  return db.$transaction(async (tx) => {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Agent"
      WHERE "tenantId" = ${options.tenantId}
        AND "slug" = ${initial.challengerAgent.slug}
      ORDER BY "id"
      FOR UPDATE
    `;

    const experiment = await tx.optimizationExperiment.findUnique({
      where: { id: initial.id },
      include: { baselineAgent: true, challengerAgent: true },
    });
    if (!experiment || experiment.tenantId !== options.tenantId) {
      throw new OptimizationControlError("experiment_not_found");
    }
    if (experiment.status !== OptimizationExperimentStatus.APPROVED) {
      throw new OptimizationControlError("invalid_transition");
    }

    const { baselineAgent: baseline, challengerAgent: challenger } = experiment;
    if (baseline.status !== AgentStatus.VERIFIED) {
      throw new OptimizationControlError("baseline_not_verified");
    }
    if (challenger.status !== AgentStatus.DRAFT) {
      throw new OptimizationControlError("challenger_not_draft");
    }
    if (baseline.slug !== challenger.slug) {
      throw new OptimizationControlError("expert_slug_mismatch");
    }
    if (
      verifiedAgent(baseline).digest !== experiment.baselineManifestDigest ||
      verifiedAgent(challenger).digest !== experiment.challengerManifestDigest
    ) {
      throw new OptimizationControlError("stale_state");
    }

    const currentVerified = await tx.agent.findMany({
      where: {
        tenantId: options.tenantId,
        slug: challenger.slug,
        status: AgentStatus.VERIFIED,
      },
      select: { id: true },
    });
    if (
      currentVerified.length !== 1 ||
      currentVerified[0]?.id !== baseline.id
    ) {
      throw new OptimizationControlError("baseline_not_current");
    }

    const challengerTransition = await tx.agent.updateMany({
      where: {
        id: challenger.id,
        tenantId: options.tenantId,
        status: AgentStatus.DRAFT,
        updatedAt: challenger.updatedAt,
      },
      data: { status: AgentStatus.VERIFIED },
    });
    if (challengerTransition.count !== 1) {
      throw new OptimizationControlError("stale_state");
    }

    await tx.agent.updateMany({
      where: {
        tenantId: options.tenantId,
        slug: challenger.slug,
        status: AgentStatus.VERIFIED,
        id: { not: challenger.id },
      },
      data: { status: AgentStatus.DEPRECATED },
    });

    const promoted = await tx.optimizationExperiment.updateMany({
      where: {
        id: experiment.id,
        tenantId: options.tenantId,
        status: OptimizationExperimentStatus.APPROVED,
      },
      data: {
        status: OptimizationExperimentStatus.PROMOTED,
        promotedAt: new Date(),
      },
    });
    if (promoted.count !== 1) {
      throw new OptimizationControlError("invalid_transition");
    }

    await tx.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        actor: options.reviewer,
        action: "optimization.experiment.promoted",
        metadata: {
          experimentId: experiment.id,
          artifactDigest: experiment.artifactDigest,
          baselineAgentId: baseline.id,
          challengerAgentId: challenger.id,
          challengerVersion: challenger.version,
        },
      },
    });

    return tx.optimizationExperiment.findUniqueOrThrow({
      where: { id: experiment.id },
    });
  });
}
