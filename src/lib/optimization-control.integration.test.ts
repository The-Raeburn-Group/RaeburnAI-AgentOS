import {
  AgentStatus,
  OptimizationExperimentStatus,
} from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import referenceCandidate from "../../benchmarks/candidates/reference.v0.json";
import challengerFixture from "../../benchmarks/challengers/reference.v0.json";
import corpusFixture from "../../benchmarks/raeburnbench.seed.v0.json";
import { agentManifestDigest } from "@/lib/collaboration";
import { db } from "@/lib/db";
import {
  OptimizationControlError,
  createOptimizationExperiment,
  promoteOptimizationExperiment,
  reviewOptimizationExperiment,
} from "@/lib/optimization-control";
import {
  evaluatePerformanceBenchmark,
  evaluateToolBenchmark,
} from "@/lib/quality-benchmarks";
import { evaluateRaeburnBench } from "@/lib/raeburnbench";
import { AgentManifestSchema } from "@/lib/types";

const describeWithDatabase = process.env.DATABASE_URL ? describe : describe.skip;
const tenantPrefix = "optimization-control-";

function manifest(version: string, systemPrompt: string) {
  return AgentManifestSchema.parse({
    schemaVersion: "raeburnai.agent-manifest.v1",
    name: "Research Expert",
    slug: "research-expert",
    version,
    description: "Evidence-led research expert for optimization tests.",
    systemPrompt,
    modelProvider: "ollama",
    modelName: "llama3.1",
    marketplaceTags: ["research"],
    requiredTools: [],
    domains: ["research"],
    capabilities: ["research", "source_analysis"],
    retrievalCollections: [],
    evalSuites: ["routing"],
    riskTier: "medium",
    evidencePolicy: {
      requireSources: true,
      preferPrimarySources: true,
      contradictionSearch: true,
    },
    approvalRequired: false,
    memoryScope: "workflow",
  });
}

function storedManifest(value: ReturnType<typeof manifest>) {
  return {
    ...value,
    integrity: {
      algorithm: "sha256",
      digest: agentManifestDigest(value),
    },
  };
}

async function seedPair(tenantId: string) {
  await db.optimizationExperiment.deleteMany({ where: { tenantId } });
  await db.tenant.deleteMany({ where: { id: tenantId } });
  await db.tenant.create({
    data: { id: tenantId, slug: tenantId, name: "Optimization Test Tenant" },
  });
  const baselineManifest = manifest(
    "1.0.0",
    "Use primary sources and abstain when evidence is missing.",
  );
  const challengerManifest = manifest(
    "1.1.0",
    "Use primary sources, seek contradictions and abstain when evidence is missing.",
  );
  const baseline = await db.agent.create({
    data: {
      id: tenantId + "-baseline",
      tenantId,
      name: baselineManifest.name,
      slug: baselineManifest.slug,
      version: baselineManifest.version,
      description: baselineManifest.description,
      systemPrompt: baselineManifest.systemPrompt,
      modelProvider: baselineManifest.modelProvider,
      modelName: baselineManifest.modelName,
      status: AgentStatus.VERIFIED,
      marketplaceTags: baselineManifest.marketplaceTags,
      requiredTools: baselineManifest.requiredTools,
      approvalRequired: baselineManifest.approvalRequired,
      memoryScope: baselineManifest.memoryScope,
      manifest: storedManifest(baselineManifest),
    },
  });
  const challenger = await db.agent.create({
    data: {
      id: tenantId + "-challenger",
      tenantId,
      name: challengerManifest.name,
      slug: challengerManifest.slug,
      version: challengerManifest.version,
      description: challengerManifest.description,
      systemPrompt: challengerManifest.systemPrompt,
      modelProvider: challengerManifest.modelProvider,
      modelName: challengerManifest.modelName,
      status: AgentStatus.DRAFT,
      marketplaceTags: challengerManifest.marketplaceTags,
      requiredTools: challengerManifest.requiredTools,
      approvalRequired: challengerManifest.approvalRequired,
      memoryScope: challengerManifest.memoryScope,
      manifest: storedManifest(challengerManifest),
    },
  });
  return { baseline, challenger };
}

function bundle(candidateId: string, version: string) {
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

function evidence() {
  return {
    baseline: bundle("agent:research-expert", "1.0.0"),
    challenger: bundle("agent:research-expert", "1.1.0"),
  };
}

async function cleanFixtures() {
  await db.optimizationExperiment.deleteMany({
    where: { tenantId: { startsWith: tenantPrefix } },
  });
  await db.tenant.deleteMany({
    where: { id: { startsWith: tenantPrefix } },
  });
}

describeWithDatabase("governed configuration optimization", () => {
  afterAll(cleanFixtures);

  it("persists idempotent evaluation evidence and promotes only after review", async () => {
    const tenantId = tenantPrefix + "promotion";
    const { baseline, challenger } = await seedPair(tenantId);

    const first = await createOptimizationExperiment({
      tenantId,
      baselineAgentId: baseline.id,
      challengerAgentId: challenger.id,
      createdBy: "evaluator-a",
      evidence: evidence(),
    });
    const replay = await createOptimizationExperiment({
      tenantId,
      baselineAgentId: baseline.id,
      challengerAgentId: challenger.id,
      createdBy: "evaluator-a",
      evidence: evidence(),
    });

    expect(replay.id).toBe(first.id);
    expect(first.status).toBe(OptimizationExperimentStatus.EVALUATED);

    await expect(
      promoteOptimizationExperiment({
        tenantId,
        experimentId: first.id,
        reviewer: "reviewer-a",
      }),
    ).rejects.toMatchObject<Partial<OptimizationControlError>>({
      code: "invalid_transition",
    });

    const approved = await reviewOptimizationExperiment({
      tenantId,
      experimentId: first.id,
      reviewer: "reviewer-a",
      decision: "approve",
      note: "Benchmark evidence satisfies the offline promotion policy.",
    });
    expect(approved.status).toBe(OptimizationExperimentStatus.APPROVED);

    const promoted = await promoteOptimizationExperiment({
      tenantId,
      experimentId: first.id,
      reviewer: "reviewer-a",
    });
    expect(promoted.status).toBe(OptimizationExperimentStatus.PROMOTED);

    const [baselineAfter, challengerAfter] = await Promise.all([
      db.agent.findUniqueOrThrow({ where: { id: baseline.id } }),
      db.agent.findUniqueOrThrow({ where: { id: challenger.id } }),
    ]);
    expect(baselineAfter.status).toBe(AgentStatus.DEPRECATED);
    expect(challengerAfter.status).toBe(AgentStatus.VERIFIED);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId,
          action: "optimization.experiment.promoted",
        },
      }),
    ).toBe(1);
  });

  it("does not permit approval when the challenger fails evaluation policy", async () => {
    const tenantId = tenantPrefix + "rejected";
    const { baseline, challenger } = await seedPair(tenantId);
    const degraded = evidence();
    const degradedCandidate = structuredClone(referenceCandidate);
    degradedCandidate.candidateId = "agent:research-expert";
    degradedCandidate.version = "1.1.0";
    degradedCandidate.outputs = degradedCandidate.outputs.map((output) => ({
      ...output,
      answer: "",
      citations: [],
      routeExperts: [],
      abstained: false,
    }));
    degraded.challenger.raeburnBench = evaluateRaeburnBench(
      corpusFixture,
      degradedCandidate,
    );

    const experiment = await createOptimizationExperiment({
      tenantId,
      baselineAgentId: baseline.id,
      challengerAgentId: challenger.id,
      createdBy: "evaluator-a",
      evidence: degraded,
    });

    await expect(
      reviewOptimizationExperiment({
        tenantId,
        experimentId: experiment.id,
        reviewer: "reviewer-a",
        decision: "approve",
      }),
    ).rejects.toMatchObject<Partial<OptimizationControlError>>({
      code: "experiment_not_eligible",
    });

    const rejected = await reviewOptimizationExperiment({
      tenantId,
      experimentId: experiment.id,
      reviewer: "reviewer-a",
      decision: "reject",
    });
    expect(rejected.status).toBe(OptimizationExperimentStatus.REJECTED);
  });

  it("fails closed if a challenger changes after its evaluation", async () => {
    const tenantId = tenantPrefix + "stale";
    const { baseline, challenger } = await seedPair(tenantId);
    const experiment = await createOptimizationExperiment({
      tenantId,
      baselineAgentId: baseline.id,
      challengerAgentId: challenger.id,
      createdBy: "evaluator-a",
      evidence: evidence(),
    });
    await reviewOptimizationExperiment({
      tenantId,
      experimentId: experiment.id,
      reviewer: "reviewer-a",
      decision: "approve",
    });

    const changedManifest = manifest(
      "1.1.0",
      "A changed prompt introduced after benchmark evaluation.",
    );
    await db.agent.update({
      where: { id: challenger.id },
      data: {
        systemPrompt: changedManifest.systemPrompt,
        manifest: storedManifest(changedManifest),
      },
    });

    await expect(
      promoteOptimizationExperiment({
        tenantId,
        experimentId: experiment.id,
        reviewer: "reviewer-a",
      }),
    ).rejects.toMatchObject<Partial<OptimizationControlError>>({
      code: "stale_state",
    });
  });

  it("requires the evaluated baseline to remain the only current verified version", async () => {
    const tenantId = tenantPrefix + "baseline";
    const { baseline, challenger } = await seedPair(tenantId);
    const experiment = await createOptimizationExperiment({
      tenantId,
      baselineAgentId: baseline.id,
      challengerAgentId: challenger.id,
      createdBy: "evaluator-a",
      evidence: evidence(),
    });
    await reviewOptimizationExperiment({
      tenantId,
      experimentId: experiment.id,
      reviewer: "reviewer-a",
      decision: "approve",
    });

    const other = manifest(
      "0.9.0",
      "An older verified configuration that should make current-state selection ambiguous.",
    );
    await db.agent.create({
      data: {
        id: tenantId + "-other",
        tenantId,
        name: other.name,
        slug: other.slug,
        version: other.version,
        description: other.description,
        systemPrompt: other.systemPrompt,
        modelProvider: other.modelProvider,
        modelName: other.modelName,
        status: AgentStatus.VERIFIED,
        marketplaceTags: other.marketplaceTags,
        requiredTools: other.requiredTools,
        approvalRequired: other.approvalRequired,
        memoryScope: other.memoryScope,
        manifest: storedManifest(other),
      },
    });

    await expect(
      promoteOptimizationExperiment({
        tenantId,
        experimentId: experiment.id,
        reviewer: "reviewer-a",
      }),
    ).rejects.toMatchObject<Partial<OptimizationControlError>>({
      code: "baseline_not_current",
    });
  });
});
