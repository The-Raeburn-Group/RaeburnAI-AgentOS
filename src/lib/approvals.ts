import { ApprovalRisk, ApprovalStatus, RunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import {
  resumeApprovedWorkflow,
  type WorkflowModelGenerator,
} from "@/lib/orchestrator";

export type ApprovalDecision = "approve" | "reject";

export class ApprovalDecisionError extends Error {
  constructor(
    public readonly code:
      | "approval_not_found"
      | "approval_already_decided"
      | "approval_self_decision_forbidden"
      | "approval_expired",
  ) {
    super(code);
    this.name = "ApprovalDecisionError";
  }
}

function taskIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const taskId = (payload as Record<string, unknown>).taskId;
  return typeof taskId === "string" && taskId ? taskId : undefined;
}

async function cancelApprovalRun(options: {
  runId: string;
  workflowId: string;
  taskId?: string;
}) {
  await db.$transaction(async (tx) => {
    await tx.workflowRun.update({
      where: { id: options.runId },
      data: { status: RunStatus.CANCELLED, finishedAt: new Date() },
    });
    await tx.workflow.update({
      where: { id: options.workflowId },
      data: { status: RunStatus.CANCELLED },
    });
    if (options.taskId) {
      await tx.agentTask.update({
        where: { id: options.taskId },
        data: { status: RunStatus.CANCELLED },
      });
    }
  });
}

export async function decideWorkflowApproval(options: {
  approvalId: string;
  tenantId: string;
  actorId: string;
  requestId: string;
  decision: ApprovalDecision;
  note?: string;
  generate?: WorkflowModelGenerator;
}) {
  const approval = await db.approval.findFirst({
    where: { id: options.approvalId, tenantId: options.tenantId },
    include: { run: { include: { workflow: true } } },
  });
  if (!approval) throw new ApprovalDecisionError("approval_not_found");
  if (approval.status !== ApprovalStatus.PENDING) {
    throw new ApprovalDecisionError("approval_already_decided");
  }

  const now = new Date();
  const taskId = taskIdFromPayload(approval.payload);
  if (approval.expiresAt && approval.expiresAt <= now) {
    const expired = await db.approval.updateMany({
      where: {
        id: approval.id,
        tenantId: approval.tenantId,
        status: ApprovalStatus.PENDING,
      },
      data: {
        status: ApprovalStatus.EXPIRED,
        decidedAt: now,
        decisionNote: "Approval expired before decision.",
      },
    });
    if (expired.count === 1) {
      await cancelApprovalRun({
        runId: approval.runId,
        workflowId: approval.run.workflowId,
        ...(taskId ? { taskId } : {}),
      });
      await db.auditEvent.create({
        data: {
          tenantId: approval.tenantId,
          runId: approval.runId,
          actor: options.actorId,
          action: "approval.expired",
          metadata: {
            approvalId: approval.id,
            requestId: options.requestId,
            expiresAt: approval.expiresAt.toISOString(),
          },
        },
      });
    }
    throw new ApprovalDecisionError("approval_expired");
  }

  if (
    (approval.risk === ApprovalRisk.HIGH ||
      approval.risk === ApprovalRisk.CRITICAL) &&
    approval.requestedBy === options.actorId
  ) {
    throw new ApprovalDecisionError("approval_self_decision_forbidden");
  }

  const status =
    options.decision === "approve"
      ? ApprovalStatus.APPROVED
      : ApprovalStatus.REJECTED;
  const updated = await db.approval.updateMany({
    where: {
      id: approval.id,
      tenantId: approval.tenantId,
      status: ApprovalStatus.PENDING,
    },
    data: {
      status,
      decidedBy: options.actorId,
      decisionNote: options.note?.trim() || null,
      decidedAt: now,
    },
  });
  if (updated.count !== 1) {
    throw new ApprovalDecisionError("approval_already_decided");
  }

  await db.auditEvent.create({
    data: {
      tenantId: approval.tenantId,
      runId: approval.runId,
      actor: options.actorId,
      action:
        status === ApprovalStatus.APPROVED
          ? "approval.approved"
          : "approval.rejected",
      metadata: {
        approvalId: approval.id,
        requestId: options.requestId,
        risk: approval.risk,
        note: options.note?.trim() || null,
      },
    },
  });

  if (status === ApprovalStatus.REJECTED) {
    await cancelApprovalRun({
      runId: approval.runId,
      workflowId: approval.run.workflowId,
      ...(taskId ? { taskId } : {}),
    });
  } else {
    await resumeApprovedWorkflow(
      approval.id,
      options.actorId,
      options.requestId,
      options.generate,
    );
  }

  return db.approval.findUniqueOrThrow({ where: { id: approval.id } });
}
