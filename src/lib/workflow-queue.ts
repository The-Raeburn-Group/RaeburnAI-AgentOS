import { createHash } from "node:crypto";
import {
  WorkflowJobStatus,
  type Prisma,
  type WorkflowJob,
} from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveTenantReference } from "@/lib/human-tenant";
import {
  runWorkflow,
  type WorkflowExecutionContext,
  type WorkflowModelGenerator,
} from "@/lib/orchestrator";
import {
  WorkflowRunRequestSchema,
  type WorkflowRunRequest,
  type WorkflowRunRequestInput,
} from "@/lib/types";

export const WORKFLOW_QUEUE_CONTRACT_VERSION =
  "raeburnai.workflow-queue.v1" as const;

const QueueContextSchema = z.object({
  tenantReference: z.string().min(1),
  actorId: z.string().min(1),
  requestId: z.string().min(1),
});
export type WorkflowQueueContext = z.infer<typeof QueueContextSchema>;

export class WorkflowQueueError extends Error {
  constructor(
    public readonly code:
      | "tenant_not_found"
      | "idempotency_conflict"
      | "job_not_found"
      | "job_not_cancellable"
      | "job_lease_lost",
  ) {
    super(code);
    this.name = "WorkflowQueueError";
  }
}

export interface EnqueueWorkflowJobOptions {
  maxAttempts?: number;
}

export interface ProcessWorkflowJobOptions {
  workerId: string;
  execute?: (
    request: WorkflowRunRequest,
    context: WorkflowExecutionContext,
    generate?: WorkflowModelGenerator,
  ) => Promise<{ id?: string }>;
  generate?: WorkflowModelGenerator;
}

function canonicalJson(value: unknown): string {
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

function payloadDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

function queueContext(job: WorkflowJob): WorkflowQueueContext {
  return QueueContextSchema.parse(job.context);
}

function queueRequest(job: WorkflowJob): WorkflowRunRequest {
  return WorkflowRunRequestSchema.parse(job.request);
}

function retryDelaySeconds(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(
    env.WORKFLOW_JOB_BACKOFF_MAX_SECONDS,
    env.WORKFLOW_JOB_BACKOFF_SECONDS * 2 ** exponent,
  );
}

async function auditJob(options: {
  job: Pick<WorkflowJob, "id" | "tenantId" | "runId">;
  actor: string;
  action: string;
  metadata?: Record<string, Prisma.InputJsonValue>;
}) {
  await db.auditEvent.create({
    data: {
      tenantId: options.job.tenantId,
      runId: options.job.runId,
      actor: options.actor,
      action: options.action,
      metadata: {
        queueContractVersion: WORKFLOW_QUEUE_CONTRACT_VERSION,
        jobId: options.job.id,
        ...(options.metadata ?? {}),
      },
    },
  });
}

export async function enqueueWorkflowJob(
  requestInput: WorkflowRunRequestInput,
  contextInput: WorkflowQueueContext,
  idempotencyKey: string,
  options: EnqueueWorkflowJobOptions = {},
): Promise<WorkflowJob> {
  const request = WorkflowRunRequestSchema.parse(requestInput);
  const context = QueueContextSchema.parse(contextInput);
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey) throw new WorkflowQueueError("idempotency_conflict");

  const tenant = await resolveTenantReference(context.tenantReference);
  if (!tenant) throw new WorkflowQueueError("tenant_not_found");

  const maxAttempts =
    options.maxAttempts ?? env.WORKFLOW_JOB_MAX_ATTEMPTS;
  const normalizedContext = {
    tenantReference: tenant.id,
    actorId: context.actorId,
    requestId: context.requestId,
  };
  const digest = payloadDigest({
    contractVersion: WORKFLOW_QUEUE_CONTRACT_VERSION,
    tenantId: tenant.id,
    actorId: context.actorId,
    request,
  });

  try {
    const job = await db.workflowJob.create({
      data: {
        tenantId: tenant.id,
        idempotencyKey: normalizedKey,
        payloadHash: digest,
        request: inputJson(request),
        context: inputJson(normalizedContext),
        maxAttempts,
      },
    });
    await auditJob({
      job,
      actor: context.actorId,
      action: "workflow.job.enqueued",
      metadata: {
        idempotencyKey: normalizedKey,
        maxAttempts,
        requestId: context.requestId,
      },
    });
    return job;
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
    const existing = await db.workflowJob.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: tenant.id,
          idempotencyKey: normalizedKey,
        },
      },
    });
    if (!existing || existing.payloadHash !== digest) {
      throw new WorkflowQueueError("idempotency_conflict");
    }
    return existing;
  }
}

export async function reapExhaustedWorkflowJobs(): Promise<number> {
  const exhausted = await db.$queryRaw<WorkflowJob[]>`
    UPDATE "WorkflowJob"
    SET
      "status" = 'FAILED'::"WorkflowJobStatus",
      "lastError" = COALESCE("lastError", 'worker lease expired after final attempt'),
      "lockedAt" = NULL,
      "leaseExpiresAt" = NULL,
      "lockedBy" = NULL,
      "updatedAt" = NOW()
    WHERE
      "status" = 'RUNNING'::"WorkflowJobStatus"
      AND "leaseExpiresAt" IS NOT NULL
      AND "leaseExpiresAt" <= NOW()
      AND "attempts" >= "maxAttempts"
    RETURNING *
  `;

  await Promise.all(
    exhausted.map((job) =>
      auditJob({
        job,
        actor: "workflow-queue",
        action: "workflow.job.dead_lettered",
        metadata: {
          attempts: job.attempts,
          reason: job.lastError ?? "lease_expired",
        },
      }),
    ),
  );
  return exhausted.length;
}

export async function claimWorkflowJob(
  workerId: string,
): Promise<WorkflowJob | null> {
  const normalizedWorkerId = workerId.trim();
  if (!normalizedWorkerId) throw new Error("workerId is required");

  await reapExhaustedWorkflowJobs();
  const leaseSeconds = env.WORKFLOW_JOB_LEASE_SECONDS;
  const rows = await db.$queryRaw<WorkflowJob[]>`
    WITH candidate AS (
      SELECT "id"
      FROM "WorkflowJob"
      WHERE
        "attempts" < "maxAttempts"
        AND (
          (
            "status" = 'QUEUED'::"WorkflowJobStatus"
            AND "availableAt" <= NOW()
          )
          OR
          (
            "status" = 'RUNNING'::"WorkflowJobStatus"
            AND "leaseExpiresAt" IS NOT NULL
            AND "leaseExpiresAt" <= NOW()
          )
        )
      ORDER BY "availableAt" ASC, "createdAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "WorkflowJob" AS job
    SET
      "status" = 'RUNNING'::"WorkflowJobStatus",
      "attempts" = job."attempts" + 1,
      "lockedAt" = NOW(),
      "leaseExpiresAt" = NOW() + (${leaseSeconds} * INTERVAL '1 second'),
      "lockedBy" = ${normalizedWorkerId},
      "updatedAt" = NOW()
    FROM candidate
    WHERE job."id" = candidate."id"
    RETURNING job.*
  `;
  const job = rows[0] ?? null;
  if (job) {
    await auditJob({
      job,
      actor: normalizedWorkerId,
      action: "workflow.job.claimed",
      metadata: {
        attempt: job.attempts,
        leaseSeconds,
      },
    });
  }
  return job;
}

export async function renewWorkflowJobLease(
  jobId: string,
  workerId: string,
): Promise<boolean> {
  const leaseSeconds = env.WORKFLOW_JOB_LEASE_SECONDS;
  const result = await db.workflowJob.updateMany({
    where: {
      id: jobId,
      status: WorkflowJobStatus.RUNNING,
      lockedBy: workerId,
    },
    data: {
      leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000),
    },
  });
  return result.count === 1;
}

export async function cancelWorkflowJob(options: {
  jobId: string;
  tenantReference: string;
  actorId: string;
  reason?: string;
}): Promise<WorkflowJob> {
  const tenant = await resolveTenantReference(options.tenantReference);
  if (!tenant) throw new WorkflowQueueError("tenant_not_found");
  const job = await db.workflowJob.findFirst({
    where: { id: options.jobId, tenantId: tenant.id },
  });
  if (!job) throw new WorkflowQueueError("job_not_found");
  if (
    job.status === WorkflowJobStatus.SUCCEEDED ||
    job.status === WorkflowJobStatus.FAILED
  ) {
    throw new WorkflowQueueError("job_not_cancellable");
  }
  if (job.status === WorkflowJobStatus.CANCELLED) return job;

  const transition = await db.workflowJob.updateMany({
    where: {
      id: job.id,
      status: {
        in: [WorkflowJobStatus.QUEUED, WorkflowJobStatus.RUNNING],
      },
    },
    data: {
      status: WorkflowJobStatus.CANCELLED,
      lockedAt: null,
      leaseExpiresAt: null,
      lockedBy: null,
      lastError: options.reason ?? "cancelled",
    },
  });
  const latest = await db.workflowJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  if (transition.count !== 1) {
    if (latest.status === WorkflowJobStatus.CANCELLED) return latest;
    throw new WorkflowQueueError("job_not_cancellable");
  }
  await auditJob({
    job: latest,
    actor: options.actorId,
    action: "workflow.job.cancelled",
    metadata: {
      reason: options.reason ?? "cancelled",
    },
  });
  return latest;
}

async function markWorkflowJobSucceeded(options: {
  job: WorkflowJob;
  workerId: string;
  runId?: string;
}): Promise<WorkflowJob> {
  const result = await db.workflowJob.updateMany({
    where: {
      id: options.job.id,
      status: WorkflowJobStatus.RUNNING,
      lockedBy: options.workerId,
    },
    data: {
      status: WorkflowJobStatus.SUCCEEDED,
      ...(options.runId ? { runId: options.runId } : {}),
      lockedAt: null,
      leaseExpiresAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
  if (result.count !== 1) throw new WorkflowQueueError("job_lease_lost");
  const completed = await db.workflowJob.findUniqueOrThrow({
    where: { id: options.job.id },
  });
  await auditJob({
    job: completed,
    actor: options.workerId,
    action: "workflow.job.succeeded",
    metadata: {
      attempt: completed.attempts,
      ...(options.runId ? { runId: options.runId } : {}),
    },
  });
  return completed;
}

async function markWorkflowJobFailed(
  job: WorkflowJob,
  workerId: string,
  error: unknown,
): Promise<WorkflowJob> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const availableAt = new Date(
    Date.now() + retryDelaySeconds(job.attempts) * 1000,
  );

  const result = await db.workflowJob.updateMany({
    where: {
      id: job.id,
      status: WorkflowJobStatus.RUNNING,
      lockedBy: workerId,
    },
    data: exhausted
      ? {
          status: WorkflowJobStatus.FAILED,
          lockedAt: null,
          leaseExpiresAt: null,
          lockedBy: null,
          lastError: message,
        }
      : {
          status: WorkflowJobStatus.QUEUED,
          availableAt,
          lockedAt: null,
          leaseExpiresAt: null,
          lockedBy: null,
          lastError: message,
        },
  });
  if (result.count !== 1) throw new WorkflowQueueError("job_lease_lost");

  const updated = await db.workflowJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  await auditJob({
    job: updated,
    actor: workerId,
    action: exhausted
      ? "workflow.job.dead_lettered"
      : "workflow.job.retry_scheduled",
    metadata: {
      attempt: updated.attempts,
      maxAttempts: updated.maxAttempts,
      error: message,
      ...(exhausted
        ? {}
        : { availableAt: updated.availableAt.toISOString() }),
    },
  });
  return updated;
}

export async function processNextWorkflowJob(
  options: ProcessWorkflowJobOptions,
): Promise<WorkflowJob | null> {
  const job = await claimWorkflowJob(options.workerId);
  if (!job) return null;

  const intervalMs = Math.max(
    1_000,
    Math.floor((env.WORKFLOW_JOB_LEASE_SECONDS * 1000) / 3),
  );
  const heartbeat = setInterval(() => {
    void renewWorkflowJobLease(job.id, options.workerId);
  }, intervalMs);
  heartbeat.unref?.();

  try {
    const request = queueRequest(job);
    const context = queueContext(job);
    const execute =
      options.execute ??
      (async (
        workflowRequest: WorkflowRunRequest,
        executionContext: WorkflowExecutionContext,
        generate?: WorkflowModelGenerator,
      ) =>
        runWorkflow(
          workflowRequest,
          executionContext,
          generate,
        ));
    const result = await execute(
      request,
      {
        tenantReference: context.tenantReference,
        actorId: context.actorId,
        requestId: context.requestId,
      },
      options.generate,
    );
    return await markWorkflowJobSucceeded({
      job,
      workerId: options.workerId,
      ...(result.id ? { runId: result.id } : {}),
    });
  } catch (error) {
    if (error instanceof WorkflowQueueError && error.code === "job_lease_lost") {
      throw error;
    }
    return markWorkflowJobFailed(job, options.workerId, error);
  } finally {
    clearInterval(heartbeat);
  }
}
