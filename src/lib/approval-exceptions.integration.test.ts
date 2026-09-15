import { ApprovalRisk, ApprovalStatus, RunStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listApprovalExceptions } from "@/lib/approval-exceptions";
import { db } from "@/lib/db";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const tenantAId = "exception-feed-tenant-a";
const tenantBId = "exception-feed-tenant-b";

async function cleanFixtures() {
  await db.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
}

async function createWorkflowFixture(tenantId: string, suffix: string) {
  const workflow = await db.workflow.create({
    data: {
      tenantId,
      name: `Exception workflow ${suffix}`,
      goal: `Review exception ${suffix}`,
      status: RunStatus.WAITING_FOR_APPROVAL,
      graph: { agents: ["governed-agent"] },
    },
  });
  const run = await db.workflowRun.create({
    data: {
      tenantId,
      workflowId: workflow.id,
      status: RunStatus.WAITING_FOR_APPROVAL,
      input: { suffix },
      startedAt: new Date("2026-09-15T15:00:00.000Z"),
    },
  });
  return { workflow, run };
}

async function seedFixtures() {
  await cleanFixtures();
  await db.tenant.createMany({
    data: [
      { id: tenantAId, slug: "exception-feed-a", name: "Exception Feed A" },
      { id: tenantBId, slug: "exception-feed-b", name: "Exception Feed B" },
    ],
  });

  const tenantAFirst = await createWorkflowFixture(tenantAId, "A-critical");
  const tenantASecond = await createWorkflowFixture(tenantAId, "A-high");
  const tenantB = await createWorkflowFixture(tenantBId, "B-critical");
  const createdAt = new Date("2026-09-15T15:15:00.000Z");
  const slaDueAt = new Date("2026-09-15T15:30:00.000Z");
  const expiresAt = new Date("2026-09-15T17:00:00.000Z");

  await db.approval.createMany({
    data: [
      {
        id: "exception-feed-a-critical",
        tenantId: tenantAId,
        runId: tenantAFirst.run.id,
        actionType: "agent_step",
        summary: "Escalated critical approval",
        payload: { evidence: "critical" },
        status: ApprovalStatus.PENDING,
        risk: ApprovalRisk.CRITICAL,
        requestedBy: "operator-a",
        createdAt,
        expiresAt,
        slaDueAt,
        escalationOwner: "admin",
        escalationLevel: 1,
        escalatedAt: new Date("2026-09-15T15:31:00.000Z"),
      },
      {
        id: "exception-feed-a-high",
        tenantId: tenantAId,
        runId: tenantASecond.run.id,
        actionType: "agent_step",
        summary: "Pending high approval",
        payload: { evidence: "high" },
        status: ApprovalStatus.PENDING,
        risk: ApprovalRisk.HIGH,
        requestedBy: "operator-a",
        createdAt: new Date("2026-09-15T15:16:00.000Z"),
        expiresAt,
        slaDueAt: new Date("2026-09-15T16:00:00.000Z"),
        escalationOwner: "approver",
      },
      {
        id: "exception-feed-b-critical",
        tenantId: tenantBId,
        runId: tenantB.run.id,
        actionType: "agent_step",
        summary: "Other tenant critical approval",
        payload: { evidence: "other-tenant" },
        status: ApprovalStatus.PENDING,
        risk: ApprovalRisk.CRITICAL,
        requestedBy: "operator-b",
        createdAt,
        expiresAt,
        slaDueAt,
        escalationOwner: "admin",
        escalationLevel: 1,
        escalatedAt: new Date("2026-09-15T15:31:00.000Z"),
      },
    ],
  });
}

describeWithDatabase("approval exception feed", () => {
  beforeEach(seedFixtures);
  afterAll(cleanFixtures);

  it("returns only the requested tenant and prioritises escalated exceptions", async () => {
    const exceptions = await listApprovalExceptions({
      tenantId: tenantAId,
      reconcile: false,
      limit: 50,
    });

    expect(exceptions.map((item) => item.id)).toEqual([
      "exception-feed-a-critical",
      "exception-feed-a-high",
    ]);
    expect(exceptions.every((item) => item.tenantId === tenantAId)).toBe(true);
    expect(exceptions[0]).toMatchObject({
      risk: ApprovalRisk.CRITICAL,
      escalationLevel: 1,
      escalationOwner: "admin",
      workflowName: "Exception workflow A-critical",
    });
    expect(exceptions.map((item) => item.id)).not.toContain(
      "exception-feed-b-critical",
    );
  });

  it("rejects invalid limits before querying the queue", async () => {
    await expect(
      listApprovalExceptions({ tenantId: tenantAId, reconcile: false, limit: 0 }),
    ).rejects.toThrow("invalid_exception_limit");
    await expect(
      listApprovalExceptions({
        tenantId: tenantAId,
        reconcile: false,
        limit: 201,
      }),
    ).rejects.toThrow("invalid_exception_limit");
  });
});
