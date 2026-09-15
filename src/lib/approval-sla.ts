import { ApprovalRisk, ApprovalStatus, RunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export interface ApprovalSlaPolicy {
  minutes: number;
  owner: string;
}

export interface ApprovalSlaSweepResult {
  expired: number;
  escalated: number;
}

function taskIdFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const taskId = (payload as Record<string, unknown>).taskId;
  return typeof taskId === "string" && taskId ? taskId : undefined;
}

export function approvalSlaPolicy(risk: ApprovalRisk): ApprovalSlaPolicy {
  switch (risk) {
    case ApprovalRisk.LOW:
      return {
        minutes: env.APPROVAL_SLA_LOW_MINUTES,
        owner: env.APPROVAL_ESCALATION_OWNER_LOW,
      };
    case ApprovalRisk.MEDIUM:
      return {
        minutes: env.APPROVAL_SLA_MEDIUM_MINUTES,
        owner: env.APPROVAL_ESCALATION_OWNER_MEDIUM,
      };
    case ApprovalRisk.CRITICAL:
      return {
        minutes: env.APPROVAL_SLA_CRITICAL_MINUTES,
        owner: env.APPROVAL_ESCALATION_OWNER_CRITICAL,
      };
    case ApprovalRisk.HIGH:
    default:
      return {
        minutes: env.APPROVAL_SLA_HIGH_MINUTES,
        owner: env.APPROVAL_ESCALATION_OWNER_HIGH,
      };
  }
}

export function approvalSlaDueAt(risk: ApprovalRisk, from = new Date()): Date {
  const policy = approvalSlaPolicy(risk);
  return new Date(from.getTime() + policy.minutes * 60_000);
}

async function expireApproval(options: {
  approvalId: string;
  tenantId: string;
  now: Date;
  actorId: string;
  requestId: string;
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const approval = await tx.approval.findFirst({
      where: {
        id: options.approvalId,
        tenantId: options.tenantId,
        status: ApprovalStatus.PENDING,
        expiresAt: { lte: options.now },
      },
      include: { run: true },
    });
    if (!approval) return false;

    const updated = await tx.approval.updateMany({
      where: {
        id: approval.id,
        tenantId: approval.tenantId,
        status: ApprovalStatus.PENDING,
        expiresAt: { lte: options.now },
      },
      data: {
        status: ApprovalStatus.EXPIRED,
        decidedAt: options.now,
        decisionNote: "Approval expired during SLA reconciliation.",
      },
    });
    if (updated.count !== 1) return false;

    const taskId = taskIdFromPayload(approval.payload);
    await tx.workflowRun.updateMany({
      where: { id: approval.runId, tenantId: approval.tenantId },
      data: { status: RunStatus.CANCELLED, finishedAt: options.now },
    });
    await tx.workflow.updateMany({
      where: { id: approval.run.workflowId, tenantId: approval.tenantId },
      data: { status: RunStatus.CANCELLED },
    });
    if (taskId) {
      await tx.agentTask.updateMany({
        where: {
          id: taskId,
          tenantId: approval.tenantId,
          runId: approval.runId,
        },
        data: { status: RunStatus.CANCELLED },
      });
    }
    await tx.auditEvent.create({
      data: {
        tenantId: approval.tenantId,
        runId: approval.runId,
        actor: options.actorId,
        action: "approval.expired",
        metadata: {
          approvalId: approval.id,
          requestId: options.requestId,
          expiresAt: approval.expiresAt?.toISOString() ?? null,
          source: "sla_sweep",
        },
      },
    });
    return true;
  });
}

async function escalateApproval(options: {
  approvalId: string;
  tenantId: string;
  now: Date;
  actorId: string;
  requestId: string;
}): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const approval = await tx.approval.findFirst({
      where: {
        id: options.approvalId,
        tenantId: options.tenantId,
        status: ApprovalStatus.PENDING,
        slaDueAt: { lte: options.now },
        escalatedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: options.now } }],
      },
    });
    if (!approval) return false;

    const policy = approvalSlaPolicy(approval.risk);
    const owner = approval.escalationOwner?.trim() || policy.owner;
    const nextLevel = approval.escalationLevel + 1;
    const updated = await tx.approval.updateMany({
      where: {
        id: approval.id,
        tenantId: approval.tenantId,
        status: ApprovalStatus.PENDING,
        slaDueAt: { lte: options.now },
        escalatedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: options.now } }],
      },
      data: {
        escalationOwner: owner,
        escalationLevel: nextLevel,
        escalatedAt: options.now,
      },
    });
    if (updated.count !== 1) return false;

    await tx.auditEvent.create({
      data: {
        tenantId: approval.tenantId,
        runId: approval.runId,
        actor: options.actorId,
        action: "approval.escalated",
        metadata: {
          approvalId: approval.id,
          requestId: options.requestId,
          risk: approval.risk,
          slaDueAt: approval.slaDueAt?.toISOString() ?? null,
          escalationOwner: owner,
          escalationLevel: nextLevel,
        },
      },
    });
    return true;
  });
}

export async function sweepApprovalEscalations(
  options: {
    tenantId?: string;
    now?: Date;
    actorId?: string;
    requestId?: string;
  } = {},
): Promise<ApprovalSlaSweepResult> {
  const now = options.now ?? new Date();
  const actorId = options.actorId?.trim() || "agentos-sla-controller";
  const requestId =
    options.requestId?.trim() || `sla-sweep-${now.toISOString()}`;
  const tenantWhere = options.tenantId ? { tenantId: options.tenantId } : {};

  const pendingWithoutSla = await db.approval.findMany({
    where: {
      ...tenantWhere,
      status: ApprovalStatus.PENDING,
      OR: [{ slaDueAt: null }, { escalationOwner: null }],
    },
    select: {
      id: true,
      tenantId: true,
      risk: true,
      createdAt: true,
      slaDueAt: true,
      escalationOwner: true,
    },
    take: 500,
  });

  for (const approval of pendingWithoutSla) {
    const policy = approvalSlaPolicy(approval.risk);
    await db.approval.updateMany({
      where: {
        id: approval.id,
        tenantId: approval.tenantId,
        status: ApprovalStatus.PENDING,
      },
      data: {
        ...(approval.slaDueAt
          ? {}
          : { slaDueAt: approvalSlaDueAt(approval.risk, approval.createdAt) }),
        ...(approval.escalationOwner ? {} : { escalationOwner: policy.owner }),
      },
    });
  }

  const expiring = await db.approval.findMany({
    where: {
      ...tenantWhere,
      status: ApprovalStatus.PENDING,
      expiresAt: { lte: now },
    },
    select: { id: true, tenantId: true },
    orderBy: { expiresAt: "asc" },
    take: 500,
  });

  let expired = 0;
  for (const approval of expiring) {
    if (
      await expireApproval({
        approvalId: approval.id,
        tenantId: approval.tenantId,
        now,
        actorId,
        requestId,
      })
    ) {
      expired += 1;
    }
  }

  const escalating = await db.approval.findMany({
    where: {
      ...tenantWhere,
      status: ApprovalStatus.PENDING,
      slaDueAt: { lte: now },
      escalatedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, tenantId: true },
    orderBy: { slaDueAt: "asc" },
    take: 500,
  });

  let escalated = 0;
  for (const approval of escalating) {
    if (
      await escalateApproval({
        approvalId: approval.id,
        tenantId: approval.tenantId,
        now,
        actorId,
        requestId,
      })
    ) {
      escalated += 1;
    }
  }

  return { expired, escalated };
}
