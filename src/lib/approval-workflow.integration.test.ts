import { ApprovalRisk, ApprovalStatus, RunStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decideWorkflowApproval } from "@/lib/approvals";
import { db } from "@/lib/db";
import { runWorkflow, type WorkflowModelGenerator } from "@/lib/orchestrator";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const tenantAId = "approval-governance-tenant-a";
const tenantBId = "approval-governance-tenant-b";
const agentId = "approval-governance-agent-a";

async function cleanFixtures() {
  await db.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
}

async function seedFixtures() {
  await cleanFixtures();
  await db.tenant.createMany({
    data: [
      { id: tenantAId, slug: "approval-tenant-a", name: "Approval Tenant A" },
      { id: tenantBId, slug: "approval-tenant-b", name: "Approval Tenant B" },
    ],
  });
  await db.agent.create({
    data: {
      id: agentId,
      tenantId: tenantAId,
      name: "Governed Agent",
      slug: "governed-agent",
      description: "Approval-gated integration-test agent.",
      systemPrompt: "Return a deterministic test response only.",
      modelProvider: "ollama",
      modelName: "test-model",
      approvalRequired: true,
      manifest: {},
    },
  });
}

async function createWaitingRun(generate: WorkflowModelGenerator) {
  const run = await runWorkflow(
    {
      tenantSlug: "ignored-by-trusted-context",
      name: "Governed workflow",
      goal: "Prove approval gates actual model execution",
      agents: ["governed-agent"],
      input: { case: "approval-gate" },
    },
    {
      tenantReference: tenantAId,
      actorId: "requester-a",
      requestId: "request-start",
    },
    generate,
  );
  const approval = await db.approval.findFirstOrThrow({
    where: { tenantId: tenantAId, runId: run.id },
  });
  return { run, approval };
}

describeWithDatabase("approval-gated workflow execution", () => {
  beforeEach(seedFixtures);
  afterAll(cleanFixtures);

  it("pauses before model execution and resumes only after a separate approver", async () => {
    const generate = vi.fn(async () => ({
      text: "approved output",
      provider: "test",
      model: "test-model",
      tokens: 7,
    }));

    const { run, approval } = await createWaitingRun(generate);

    expect(run.status).toBe(RunStatus.WAITING_FOR_APPROVAL);
    expect(generate).not.toHaveBeenCalled();
    expect(approval.status).toBe(ApprovalStatus.PENDING);
    expect(approval.risk).toBe(ApprovalRisk.HIGH);
    expect(approval.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    const waitingTask = await db.agentTask.findFirstOrThrow({
      where: { tenantId: tenantAId, runId: run.id },
    });
    expect(waitingTask.status).toBe(RunStatus.WAITING_FOR_APPROVAL);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: tenantAId,
          runId: run.id,
          action: "approval.requested",
        },
      }),
    ).toBe(1);

    await expect(
      decideWorkflowApproval({
        approvalId: approval.id,
        tenantId: tenantBId,
        actorId: "approver-b",
        requestId: "wrong-tenant",
        decision: "approve",
        generate,
      }),
    ).rejects.toMatchObject({ code: "approval_not_found" });

    await expect(
      decideWorkflowApproval({
        approvalId: approval.id,
        tenantId: tenantAId,
        actorId: "requester-a",
        requestId: "self-decision",
        decision: "approve",
        generate,
      }),
    ).rejects.toMatchObject({ code: "approval_self_decision_forbidden" });
    expect(generate).not.toHaveBeenCalled();

    const decided = await decideWorkflowApproval({
      approvalId: approval.id,
      tenantId: tenantAId,
      actorId: "approver-a",
      requestId: "decision-approve",
      decision: "approve",
      note: "Evidence reviewed and approved.",
      generate,
    });

    expect(decided.status).toBe(ApprovalStatus.APPROVED);
    expect(decided.decidedBy).toBe("approver-a");
    expect(generate).toHaveBeenCalledTimes(1);

    const [completedRun, completedTask, completedWorkflow, auditEvents] =
      await Promise.all([
        db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
        db.agentTask.findUniqueOrThrow({ where: { id: waitingTask.id } }),
        db.workflow.findUniqueOrThrow({ where: { id: run.workflowId } }),
        db.auditEvent.findMany({
          where: { tenantId: tenantAId, runId: run.id },
          orderBy: { createdAt: "asc" },
        }),
      ]);

    expect(completedRun.status).toBe(RunStatus.SUCCEEDED);
    expect(completedRun.output).toMatchObject({
      "governed-agent": "approved output",
    });
    expect(completedTask.status).toBe(RunStatus.SUCCEEDED);
    expect(completedWorkflow.status).toBe(RunStatus.SUCCEEDED);
    expect(auditEvents.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.approved",
        "workflow.resumed",
        "agent.completed",
        "workflow.completed",
      ]),
    );
  });

  it("cancels the waiting workflow when an approver rejects it", async () => {
    const generate = vi.fn(async () => ({
      text: "must not execute",
      provider: "test",
      model: "test-model",
    }));
    const { run, approval } = await createWaitingRun(generate);

    const rejected = await decideWorkflowApproval({
      approvalId: approval.id,
      tenantId: tenantAId,
      actorId: "approver-a",
      requestId: "decision-reject",
      decision: "reject",
      note: "Requested action is outside approved operating scope.",
      generate,
    });

    expect(rejected.status).toBe(ApprovalStatus.REJECTED);
    expect(generate).not.toHaveBeenCalled();

    const [cancelledRun, cancelledWorkflow, cancelledTask] = await Promise.all([
      db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
      db.workflow.findUniqueOrThrow({ where: { id: run.workflowId } }),
      db.agentTask.findFirstOrThrow({
        where: { tenantId: tenantAId, runId: run.id },
      }),
    ]);
    expect(cancelledRun.status).toBe(RunStatus.CANCELLED);
    expect(cancelledWorkflow.status).toBe(RunStatus.CANCELLED);
    expect(cancelledTask.status).toBe(RunStatus.CANCELLED);
  });

  it("expires overdue requests and never executes the gated action", async () => {
    const generate = vi.fn(async () => ({
      text: "must not execute",
      provider: "test",
      model: "test-model",
    }));
    const { run, approval } = await createWaitingRun(generate);
    await db.approval.update({
      where: { id: approval.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(
      decideWorkflowApproval({
        approvalId: approval.id,
        tenantId: tenantAId,
        actorId: "approver-a",
        requestId: "decision-expired",
        decision: "approve",
        generate,
      }),
    ).rejects.toMatchObject({ code: "approval_expired" });

    expect(generate).not.toHaveBeenCalled();
    const [expired, cancelledRun] = await Promise.all([
      db.approval.findUniqueOrThrow({ where: { id: approval.id } }),
      db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ]);
    expect(expired.status).toBe(ApprovalStatus.EXPIRED);
    expect(cancelledRun.status).toBe(RunStatus.CANCELLED);
  });
});
