import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";
import { WorkflowRunRequestSchema } from "@/lib/types";
import {
  WorkflowQueueError,
  enqueueWorkflowJob,
} from "@/lib/workflow-queue";

function queueError(error: WorkflowQueueError) {
  if (error.code === "idempotency_conflict") {
    return NextResponse.json({ error: error.code }, { status: 409 });
  }
  if (error.code === "tenant_not_found") {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  return NextResponse.json({ error: error.code }, { status: 400 });
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request, {
    requireGovernedExecution: true,
  });
  if (!authentication.ok) return authentication.response;

  const { approvalId, idempotencyKey, executionId } = authentication.context;
  if (!approvalId || !idempotencyKey || !executionId) {
    return NextResponse.json(
      { error: "Governed Chain execution context required" },
      { status: 400 },
    );
  }

  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const payload = WorkflowRunRequestSchema.parse(await request.json());
    const job = await enqueueWorkflowJob(
      payload,
      {
        tenantReference: authentication.context.tenantId,
        actorId: authentication.context.actorId,
        requestId: authentication.context.requestId,
      },
      idempotencyKey,
    );

    return NextResponse.json(
      {
        job: {
          id: job.id,
          status: job.status,
          attempts: job.attempts,
          maxAttempts: job.maxAttempts,
          availableAt: job.availableAt,
          runId: job.runId,
        },
        governance: {
          approvalId,
          executionId,
          idempotencyKey,
        },
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof WorkflowQueueError) return queueError(error);
    return apiError(error, "workflow.jobs.enqueue");
  }
}

export async function GET(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 60, 60_000);
  if (limited) return limited;

  const jobId = new URL(request.url).searchParams.get("jobId")?.trim();
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const job = await db.workflowJob.findFirst({
    where: {
      id: jobId,
      tenantId: authentication.context.tenantId,
    },
    select: {
      id: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      availableAt: true,
      lockedAt: true,
      leaseExpiresAt: true,
      lastError: true,
      runId: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!job) {
    return NextResponse.json({ error: "job_not_found" }, { status: 404 });
  }
  return NextResponse.json({ job });
}
