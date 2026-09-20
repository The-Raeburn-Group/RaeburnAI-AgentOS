import { RunStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLABORATION_CONTRACT_VERSION,
  EVIDENCE_PROTOCOL_VERSION,
} from "@/lib/collaboration";
import { db } from "@/lib/db";
import { runWorkflow, type WorkflowModelGenerator } from "@/lib/orchestrator";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const tenantId = "collaboration-tenant";

async function cleanFixtures() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

async function seedAgent(options: {
  id: string;
  slug: string;
  name: string;
  prompt: string;
  approvalRequired?: boolean;
}) {
  return db.agent.create({
    data: {
      id: options.id,
      tenantId,
      name: options.name,
      slug: options.slug,
      description: `${options.name} integration-test agent.`,
      systemPrompt: options.prompt,
      modelProvider: "ollama",
      modelName: "test-model",
      approvalRequired: options.approvalRequired ?? false,
      manifest: {
        schemaVersion: "raeburnai.agent-manifest.v1",
        slug: options.slug,
      },
    },
  });
}

async function seedFixtures() {
  await cleanFixtures();
  await db.tenant.create({
    data: {
      id: tenantId,
      slug: "collaboration-tenant",
      name: "Collaboration Tenant",
    },
  });
  await seedAgent({
    id: "expert-a-id",
    slug: "expert-a",
    name: "Expert A",
    prompt: "SYSTEM_EXPERT_A",
  });
  await seedAgent({
    id: "expert-b-id",
    slug: "expert-b",
    name: "Expert B",
    prompt: "SYSTEM_EXPERT_B",
  });
  await seedAgent({
    id: "verifier-id",
    slug: "verifier",
    name: "Verifier",
    prompt: "SYSTEM_VERIFIER",
  });
}

function validEvidenceJson() {
  return JSON.stringify({
    contractVersion: COLLABORATION_CONTRACT_VERSION,
    evidenceProtocolVersion: EVIDENCE_PROTOCOL_VERSION,
    decision: "Evidence-backed synthesis",
    confidence: 0.84,
    agreements: ["Experts agree on the central finding."],
    conflicts: [
      {
        topic: "Residual uncertainty",
        positions: [
          { agent: "expert-a", position: "Lower uncertainty" },
          { agent: "expert-b", position: "Higher uncertainty" },
        ],
      },
    ],
    sources: [
      {
        id: "primary-1",
        title: "Primary record one",
        sourceType: "primary",
      },
      {
        id: "primary-2",
        title: "Primary record two",
        sourceType: "primary",
      },
    ],
    claims: [
      {
        claim: "The synthesis is supported by both primary records.",
        sourceIds: ["primary-1", "primary-2"],
        support: "supports",
      },
    ],
    contradictionSearchPerformed: true,
    unresolvedRisks: ["One material uncertainty remains."],
  });
}

function generator(adjudicationText = validEvidenceJson()): WorkflowModelGenerator {
  return vi.fn(async ({ messages }) => {
    const system = messages.find((message) => message.role === "system")?.content;
    if (system === "SYSTEM_EXPERT_A") {
      return {
        text: "Expert A independent finding",
        provider: "test",
        model: "test-model",
      };
    }
    if (system === "SYSTEM_EXPERT_B") {
      return {
        text: "Expert B independent finding",
        provider: "test",
        model: "test-model",
      };
    }
    if (system === "SYSTEM_VERIFIER") {
      return {
        text: adjudicationText,
        provider: "test",
        model: "test-model",
      };
    }
    throw new Error("Unexpected test agent");
  });
}

describeWithDatabase("collaborative workflow execution", () => {
  beforeEach(seedFixtures);
  afterAll(cleanFixtures);

  it("runs independent experts and a regulated evidence adjudicator with persisted audit evidence", async () => {
    const generate = generator();
    const run = await runWorkflow(
      {
        tenantSlug: "ignored",
        name: "Evidence synthesis",
        goal: "Produce a source-aware adjudicated conclusion",
        agents: ["expert-a", "expert-b"],
        mode: "evidence",
        adjudicator: "verifier",
        strictness: "regulated",
        input: { caseId: "evidence-1" },
      },
      {
        tenantReference: tenantId,
        actorId: "requester",
        requestId: "collaboration-request-1",
      },
      generate,
    );

    expect(run.status).toBe(RunStatus.SUCCEEDED);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(run.output).toMatchObject({
      "expert-a": "Expert A independent finding",
      "expert-b": "Expert B independent finding",
      verifier: validEvidenceJson(),
    });

    const [workflow, tasks, completedAudit] = await Promise.all([
      db.workflow.findUniqueOrThrow({ where: { id: run.workflowId } }),
      db.agentTask.findMany({
        where: { tenantId, runId: run.id },
        orderBy: { createdAt: "asc" },
      }),
      db.auditEvent.findFirstOrThrow({
        where: {
          tenantId,
          runId: run.id,
          action: "workflow.adjudication.completed",
        },
      }),
    ]);

    expect(workflow.graph).toMatchObject({
      contractVersion: COLLABORATION_CONTRACT_VERSION,
      mode: "evidence",
      strictness: "regulated",
      agents: ["expert-a", "expert-b"],
      adjudicator: "verifier",
    });
    expect(tasks).toHaveLength(3);
    expect(tasks.every((task) => task.status === RunStatus.SUCCEEDED)).toBe(
      true,
    );
    expect(completedAudit.metadata).toMatchObject({
      mode: "evidence",
      strictness: "regulated",
      adjudicator: "verifier",
      confidence: 0.84,
      conflicts: 1,
      claims: 1,
      sources: 2,
      contradictionSearchPerformed: true,
    });
  });

  it("persists a terminal failure when the adjudicator violates the contract", async () => {
    const generate = generator('{"decision":"missing contract fields"}');

    await expect(
      runWorkflow(
        {
          tenantSlug: "ignored",
          goal: "Reject malformed adjudication output",
          agents: ["expert-a", "expert-b"],
          mode: "adjudicated",
          adjudicator: "verifier",
        },
        {
          tenantReference: tenantId,
          actorId: "requester",
          requestId: "collaboration-request-2",
        },
        generate,
      ),
    ).rejects.toThrow();

    const failedRun = await db.workflowRun.findFirstOrThrow({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    expect(failedRun.status).toBe(RunStatus.FAILED);
    expect(failedRun.finishedAt).not.toBeNull();
    expect(
      await db.auditEvent.count({
        where: {
          tenantId,
          runId: failedRun.id,
          action: "workflow.adjudication.rejected",
        },
      }),
    ).toBe(1);
  });

  it("fails before workflow persistence rather than bypassing an approval-bound collaborator", async () => {
    await seedAgent({
      id: "approval-bound-id",
      slug: "approval-bound",
      name: "Approval Bound",
      prompt: "SYSTEM_APPROVAL_BOUND",
      approvalRequired: true,
    });
    const before = await db.workflow.count({ where: { tenantId } });

    await expect(
      runWorkflow(
        {
          tenantSlug: "ignored",
          goal: "Do not bypass approval policy",
          agents: ["expert-a", "approval-bound"],
          mode: "parallel",
        },
        {
          tenantReference: tenantId,
          actorId: "requester",
          requestId: "collaboration-request-3",
        },
        generator(),
      ),
    ).rejects.toThrow("cannot bypass approval-required agents");

    expect(await db.workflow.count({ where: { tenantId } })).toBe(before);
  });
});
