import { ApprovalRisk, ApprovalStatus, type Prisma } from "@prisma/client";
import { sweepApprovalEscalations } from "@/lib/approval-sla";
import { db } from "@/lib/db";

const riskRank: Record<ApprovalRisk, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

export interface ApprovalExceptionRecord {
  id: string;
  tenantId: string;
  runId: string;
  workflowId: string;
  workflowName: string;
  workflowGoal: string;
  actionType: string;
  summary: string;
  risk: ApprovalRisk;
  status: ApprovalStatus.PENDING;
  requestedBy: string;
  payload: Prisma.JsonValue;
  createdAt: string;
  expiresAt?: string;
  slaDueAt?: string;
  escalationOwner?: string;
  escalationLevel: number;
  escalatedAt?: string;
}

export interface ListApprovalExceptionsOptions {
  tenantId: string;
  actorId?: string;
  requestId?: string;
  limit?: number;
  reconcile?: boolean;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("invalid_exception_limit");
  }
  return value;
}

export async function listApprovalExceptions(
  options: ListApprovalExceptionsOptions,
): Promise<ApprovalExceptionRecord[]> {
  const tenantId = options.tenantId.trim();
  if (!tenantId) throw new Error("tenant_required");
  const limit = boundedLimit(options.limit);

  if (options.reconcile !== false) {
    await sweepApprovalEscalations({
      tenantId,
      ...(options.actorId ? { actorId: options.actorId } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
  }

  const approvals = await db.approval.findMany({
    where: { tenantId, status: ApprovalStatus.PENDING },
    include: { run: { include: { workflow: true } } },
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  approvals.sort((left, right) => {
    const escalation =
      Number(Boolean(right.escalatedAt)) - Number(Boolean(left.escalatedAt));
    if (escalation) return escalation;
    const risk = riskRank[left.risk] - riskRank[right.risk];
    if (risk) return risk;
    const leftSla = left.slaDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const rightSla = right.slaDueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    return leftSla - rightSla || left.createdAt.getTime() - right.createdAt.getTime();
  });

  return approvals.map((approval) => ({
    id: approval.id,
    tenantId: approval.tenantId,
    runId: approval.runId,
    workflowId: approval.run.workflowId,
    workflowName: approval.run.workflow.name,
    workflowGoal: approval.run.workflow.goal,
    actionType: approval.actionType,
    summary: approval.summary,
    risk: approval.risk,
    status: ApprovalStatus.PENDING,
    requestedBy: approval.requestedBy,
    payload: approval.payload,
    createdAt: approval.createdAt.toISOString(),
    ...(approval.expiresAt ? { expiresAt: approval.expiresAt.toISOString() } : {}),
    ...(approval.slaDueAt ? { slaDueAt: approval.slaDueAt.toISOString() } : {}),
    ...(approval.escalationOwner
      ? { escalationOwner: approval.escalationOwner }
      : {}),
    escalationLevel: approval.escalationLevel,
    ...(approval.escalatedAt
      ? { escalatedAt: approval.escalatedAt.toISOString() }
      : {}),
  }));
}
