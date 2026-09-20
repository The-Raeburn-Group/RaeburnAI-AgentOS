import { WorkflowJobStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  WorkflowQueueError,
  cancelWorkflowJob,
  claimWorkflowJob,
  enqueueWorkflowJob,
  processNextWorkflowJob,
} from "@/lib/workflow-queue";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tenantId = "workflow-queue-tenant";

async function cleanFixtures() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

async function seedTenant() {
  await cleanFixtures();
  await db.tenant.create({
    data: {
      id: tenantId,
      slug: "workflow-queue-tenant",
      name: "Workflow Queue Tenant",
    },
  });
}

function request(goal = "Execute a durable workflow") {
  return {
    tenantSlug: "ignored",
    name: "Durable workflow",
    goal,
    agents: ["expert-a"],
    input: { caseId: "queue-1" },
  };
}

function context(requestId = "queue-request-1") {
  return {
    tenantReference: tenantId,
    actorId: "chain-service",
    requestId,
  };
}

describeWithDatabase("durable workflow queue", () => {
  beforeEach(seedTenant);
  afterAll(cleanFixtures);

  it("deduplicates identical tenant-scoped submissions and rejects key reuse with changed payload", async () => {
    const first = await enqueueWorkflowJob(
      request(),
      context(),
      "queue-key-0001",
    );
    const duplicate = await enqueueWorkflowJob(
      request(),
      context("queue-request-retry"),
      "queue-key-0001",
    );

    expect(duplicate.id).toBe(first.id);
    expect(await db.workflowJob.count({ where: { tenantId } })).toBe(1);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId,
          action: "workflow.job.enqueued",
        },
      }),
    ).toBe(1);

    await expect(
      enqueueWorkflowJob(
        request("A materially different durable workflow"),
        context(),
        "queue-key-0001",
      ),
    ).rejects.toMatchObject<Partial<WorkflowQueueError>>({
      code: "idempotency_conflict",
    });
  });

  it("lets only one worker claim a queued job", async () => {
    const queued = await enqueueWorkflowJob(
      request(),
      context(),
      "queue-key-0002",
    );

    const claims = await Promise.all([
      claimWorkflowJob("worker-a"),
      claimWorkflowJob("worker-b"),
    ]);
    const claimed = claims.filter((job) => job !== null);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(queued.id);
    expect(claimed[0]?.status).toBe(WorkflowJobStatus.RUNNING);
    expect(claimed[0]?.attempts).toBe(1);
  });

  it("reclaims an expired lease without duplicating the durable job", async () => {
    const queued = await enqueueWorkflowJob(
      request(),
      context(),
      "queue-key-0003",
      { maxAttempts: 2 },
    );
    const firstClaim = await claimWorkflowJob("worker-a");
    expect(firstClaim?.id).toBe(queued.id);

    await db.workflowJob.update({
      where: { id: queued.id },
      data: {
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

    const secondClaim = await claimWorkflowJob("worker-b");
    expect(secondClaim?.id).toBe(queued.id);
    expect(secondClaim?.attempts).toBe(2);
    expect(secondClaim?.lockedBy).toBe("worker-b");
    expect(await db.workflowJob.count({ where: { id: queued.id } })).toBe(1);
  });

  it("retries failures then dead-letters after the configured maximum attempts", async () => {
    const queued = await enqueueWorkflowJob(
      request(),
      context(),
      "queue-key-0004",
      { maxAttempts: 2 },
    );
    const execute = vi.fn(async () => {
      throw new Error("transient provider failure");
    });

    const retry = await processNextWorkflowJob({
      workerId: "worker-a",
      execute,
    });
    expect(retry?.id).toBe(queued.id);
    expect(retry?.status).toBe(WorkflowJobStatus.QUEUED);
    expect(retry?.attempts).toBe(1);
    expect(retry?.lastError).toBe("transient provider failure");

    await db.workflowJob.update({
      where: { id: queued.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });

    const deadLetter = await processNextWorkflowJob({
      workerId: "worker-b",
      execute,
    });
    expect(deadLetter?.status).toBe(WorkflowJobStatus.FAILED);
    expect(deadLetter?.attempts).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId,
          action: "workflow.job.retry_scheduled",
        },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId,
          action: "workflow.job.dead_lettered",
        },
      }),
    ).toBe(1);
  });

  it("dead-letters a final expired lease instead of executing it a second time", async () => {
    const queued = await enqueueWorkflowJob(
      request(),
      context(),
      "queue-key-0005",
      { maxAttempts: 1 },
    );
    await claimWorkflowJob("worker-a");
    await db.workflowJob.update({
      where: { id: queued.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await claimWorkflowJob("worker-b")).toBeNull();
    const failed = await db.workflowJob.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(failed.status).toBe(WorkflowJobStatus.FAILED);
    expect(failed.attempts).toBe(1);
  });

  it("keeps cancellation terminal when it races with a finishing worker", async () => {
    const queued = await enqueueWorkflowJob(
      request(),
      context(),
      "queue-key-0006",
    );

    let releaseExecution: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let unblock: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const processing = processNextWorkflowJob({
      workerId: "worker-a",
      execute: async () => {
        releaseExecution?.();
        await blocked;
        return { id: "synthetic-run-id" };
      },
    });
    await started;

    const cancelled = await cancelWorkflowJob({
      jobId: queued.id,
      tenantReference: tenantId,
      actorId: "operator",
      reason: "operator cancellation",
    });
    expect(cancelled.status).toBe(WorkflowJobStatus.CANCELLED);

    unblock?.();
    await expect(processing).rejects.toMatchObject<Partial<WorkflowQueueError>>({
      code: "job_lease_lost",
    });

    const final = await db.workflowJob.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(final.status).toBe(WorkflowJobStatus.CANCELLED);
    expect(final.lastError).toBe("operator cancellation");
  });
});
