import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  resolveTenantReference,
  tenantReferenceMode,
} from "@/lib/human-tenant";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const tenantAId = "tenant-isolation-id-a";
const tenantBId = "tenant-isolation-id-b";

async function cleanTenants() {
  await db.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
}

describeWithDatabase("tenant isolation", () => {
  beforeAll(async () => {
    await cleanTenants();
    await db.tenant.createMany({
      data: [
        {
          id: tenantAId,
          slug: "tenant-isolation-a",
          name: "Tenant isolation A",
        },
        {
          id: tenantBId,
          // Deliberately collides with tenant A's ID to prove references are
          // interpreted in one configured namespace rather than with an OR query.
          slug: tenantAId,
          name: "Tenant isolation B",
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanTenants();
  });

  it("resolves tenant references in an explicit namespace", async () => {
    expect(tenantReferenceMode({})).toBe("id");
    expect(
      tenantReferenceMode({ AGENTOS_TENANT_REFERENCE_MODE: "slug" }),
    ).toBe("slug");
    expect(() =>
      tenantReferenceMode({ AGENTOS_TENANT_REFERENCE_MODE: "both" }),
    ).toThrow("invalid_tenant_reference_mode");

    const byId = await resolveTenantReference(tenantAId, "id");
    const bySlug = await resolveTenantReference(tenantAId, "slug");

    expect(byId?.id).toBe(tenantAId);
    expect(bySlug?.id).toBe(tenantBId);
  });

  it("keeps operational data tenant-scoped with direct ownership keys", async () => {
    const [workflowA, workflowB] = await Promise.all([
      db.workflow.create({
        data: {
          tenantId: tenantAId,
          name: "Workflow A",
          goal: "Tenant A only",
          graph: {},
        },
      }),
      db.workflow.create({
        data: {
          tenantId: tenantBId,
          name: "Workflow B",
          goal: "Tenant B only",
          graph: {},
        },
      }),
    ]);

    const [runA, runB] = await Promise.all([
      db.workflowRun.create({
        data: {
          tenantId: tenantAId,
          workflowId: workflowA.id,
          input: { secret: "alpha" },
        },
      }),
      db.workflowRun.create({
        data: {
          tenantId: tenantBId,
          workflowId: workflowB.id,
          input: { secret: "bravo" },
        },
      }),
    ]);

    const [agentA, agentB] = await Promise.all([
      db.agent.create({
        data: {
          tenantId: tenantAId,
          name: "Agent A",
          slug: "agent-a",
          description: "Tenant A agent",
          systemPrompt: "A",
          manifest: {},
        },
      }),
      db.agent.create({
        data: {
          tenantId: tenantBId,
          name: "Agent B",
          slug: "agent-b",
          description: "Tenant B agent",
          systemPrompt: "B",
          manifest: {},
        },
      }),
    ]);

    await Promise.all([
      db.agentTask.create({
        data: {
          tenantId: tenantAId,
          runId: runA.id,
          agentId: agentA.id,
          name: "Task A",
          input: {},
        },
      }),
      db.agentTask.create({
        data: {
          tenantId: tenantBId,
          runId: runB.id,
          agentId: agentB.id,
          name: "Task B",
          input: {},
        },
      }),
      db.approval.create({
        data: {
          tenantId: tenantAId,
          runId: runA.id,
          actionType: "test",
          summary: "Approval A",
          payload: { secret: "alpha" },
          requestedBy: "actor-a",
        },
      }),
      db.approval.create({
        data: {
          tenantId: tenantBId,
          runId: runB.id,
          actionType: "test",
          summary: "Approval B",
          payload: { secret: "bravo" },
          requestedBy: "actor-b",
        },
      }),
      db.auditEvent.create({
        data: {
          tenantId: tenantAId,
          runId: runA.id,
          actor: "actor-a",
          action: "tenant.test",
          metadata: { secret: "alpha" },
        },
      }),
      db.auditEvent.create({
        data: {
          tenantId: tenantBId,
          runId: runB.id,
          actor: "actor-b",
          action: "tenant.test",
          metadata: { secret: "bravo" },
        },
      }),
    ]);

    const [runsA, tasksA, approvalsA, auditA] = await Promise.all([
      db.workflowRun.findMany({ where: { tenantId: tenantAId } }),
      db.agentTask.findMany({ where: { tenantId: tenantAId } }),
      db.approval.findMany({ where: { tenantId: tenantAId } }),
      db.auditEvent.findMany({ where: { tenantId: tenantAId } }),
    ]);

    expect(runsA).toHaveLength(1);
    expect(runsA[0]?.id).toBe(runA.id);
    expect(tasksA).toHaveLength(1);
    expect(tasksA[0]?.agentId).toBe(agentA.id);
    expect(approvalsA).toHaveLength(1);
    expect(approvalsA[0]?.runId).toBe(runA.id);
    expect(auditA).toHaveLength(1);
    expect(auditA[0]?.runId).toBe(runA.id);
  });

  it("rejects cross-tenant ownership mismatches at the database boundary", async () => {
    const workflowA = await db.workflow.findFirstOrThrow({
      where: { tenantId: tenantAId },
    });
    const runA = await db.workflowRun.findFirstOrThrow({
      where: { tenantId: tenantAId },
    });
    const agentB = await db.agent.findFirstOrThrow({
      where: { tenantId: tenantBId },
    });

    await expect(
      db.workflowRun.create({
        data: {
          tenantId: tenantBId,
          workflowId: workflowA.id,
          input: {},
        },
      }),
    ).rejects.toThrow();

    await expect(
      db.agentTask.create({
        data: {
          tenantId: tenantAId,
          runId: runA.id,
          agentId: agentB.id,
          name: "Cross-tenant task",
          input: {},
        },
      }),
    ).rejects.toThrow();

    await expect(
      db.approval.create({
        data: {
          tenantId: tenantBId,
          runId: runA.id,
          actionType: "cross-tenant",
          summary: "Must be rejected",
          payload: {},
          requestedBy: "actor-b",
        },
      }),
    ).rejects.toThrow();

    await expect(
      db.auditEvent.create({
        data: {
          tenantId: tenantBId,
          runId: runA.id,
          actor: "actor-b",
          action: "cross-tenant.audit",
          metadata: {},
        },
      }),
    ).rejects.toThrow();
  });
});
