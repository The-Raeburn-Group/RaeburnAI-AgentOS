import {
  SpendReservationStatus,
  UsageCostBasis,
  UsageOutcome,
  type Prisma,
  type SpendBudget,
  type SpendReservation,
  type UsageLedgerEntry,
} from "@prisma/client";
import { z } from "zod";

import modelRegistryInput from "../../config/model-registry.v1.json";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { parseModelRegistry } from "@/lib/model-registry";

export const SPEND_GOVERNANCE_CONTRACT_VERSION =
  "raeburnai.spend-governance.v1" as const;

const moneySchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(?:\.\d{1,6})?$/, "USD amount must have at most six decimals");

export const SpendBudgetInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    periodStart: z.string().datetime({ offset: true }),
    periodEnd: z.string().datetime({ offset: true }),
    softLimitUsd: moneySchema.optional(),
    hardLimitUsd: moneySchema,
  })
  .superRefine((value, context) => {
    const start = new Date(value.periodStart);
    const end = new Date(value.periodEnd);
    if (end.getTime() <= start.getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["periodEnd"],
        message: "periodEnd must be after periodStart",
      });
    }
    const soft = value.softLimitUsd
      ? parseUsdToMicros(value.softLimitUsd)
      : undefined;
    const hard = parseUsdToMicros(value.hardLimitUsd);
    if (hard <= 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hardLimitUsd"],
        message: "hardLimitUsd must be positive",
      });
    }
    if (soft !== undefined && (soft <= 0n || soft > hard)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["softLimitUsd"],
        message: "softLimitUsd must be positive and no greater than hardLimitUsd",
      });
    }
  });

export type SpendBudgetInput = z.infer<typeof SpendBudgetInputSchema>;

export class SpendGovernanceError extends Error {
  constructor(
    public readonly code:
      | "tenant_not_found"
      | "overlapping_budget"
      | "ambiguous_budget"
      | "budget_not_active"
      | "cost_evidence_missing"
      | "hard_budget_exceeded"
      | "reservation_conflict"
      | "reservation_not_found"
      | "settlement_conflict"
      | "hard_budget_overrun"
      | "invalid_usage_range",
  ) {
    super(code);
    this.name = "SpendGovernanceError";
  }
}

export interface ModelSpendGuard {
  contractVersion: typeof SPEND_GOVERNANCE_CONTRACT_VERSION;
  tenantId: string;
  runId?: string;
  taskId?: string;
  requestId: string;
  provider: string;
  model: string;
  estimatedTokens: number;
  unitCostMicrosPer1k: bigint | null;
  estimatedCostMicros: bigint | null;
  reservation: SpendReservation | null;
}

function assertSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

export function parseUsdToMicros(value: string): bigint {
  if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("invalid_usd_amount");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export function formatMicrosAsUsd(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${
    fraction ? `.${fraction}` : ""
  }`;
}

export function estimateModelTokens(
  messages: Array<{ content: string }>,
  maxOutputTokens = env.SPEND_DEFAULT_MAX_OUTPUT_TOKENS,
): number {
  const characters = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  const estimatedInput = Math.max(1, Math.ceil(characters / 4));
  return assertSafeInteger(
    estimatedInput + maxOutputTokens,
    "estimated_token_count",
  );
}

export function costMicrosForTokens(
  tokens: number,
  unitCostMicrosPer1k: bigint,
): bigint {
  assertSafeInteger(tokens, "token_count");
  if (unitCostMicrosPer1k < 0n) throw new Error("invalid_unit_cost");
  return (BigInt(tokens) * unitCostMicrosPer1k + 999n) / 1_000n;
}

export function registryModelCostMicrosPer1k(
  provider: string,
  model: string,
): bigint | null {
  const registry = parseModelRegistry(modelRegistryInput);
  const entries = registry.entries.filter(
    (entry) => entry.provider === provider && entry.model === model,
  );
  if (entries.length !== 1) return null;
  const cost = entries[0]?.benchmark.costPer1kTokensUsd;
  if (cost === null || cost === undefined || !Number.isFinite(cost) || cost < 0) {
    return null;
  }
  return parseUsdToMicros(cost.toFixed(6));
}

async function lockTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Tenant"
    WHERE "id" = ${tenantId}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new SpendGovernanceError("tenant_not_found");
}

async function lockBudget(
  tx: Prisma.TransactionClient,
  budgetId: string,
  tenantId: string,
): Promise<SpendBudget> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "SpendBudget"
    WHERE "id" = ${budgetId}
      AND "tenantId" = ${tenantId}
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new SpendGovernanceError("budget_not_active");
  return tx.spendBudget.findUniqueOrThrow({ where: { id: budgetId } });
}

function budgetActiveAt(budget: SpendBudget, now: Date): boolean {
  return (
    budget.enabled &&
    budget.periodStart.getTime() <= now.getTime() &&
    budget.periodEnd.getTime() > now.getTime()
  );
}

async function activeBudgetAt(
  tenantId: string,
  now: Date,
): Promise<SpendBudget | null> {
  const budgets = await db.spendBudget.findMany({
    where: {
      tenantId,
      enabled: true,
      periodStart: { lte: now },
      periodEnd: { gt: now },
    },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (budgets.length > 1) throw new SpendGovernanceError("ambiguous_budget");
  return budgets[0] ?? null;
}

function reservationCommittedMicros(
  reservation: Pick<
    SpendReservation,
    "status" | "reservedMicros" | "settledMicros"
  >,
): bigint {
  if (reservation.status === SpendReservationStatus.RELEASED) return 0n;
  if (reservation.status === SpendReservationStatus.SETTLED) {
    return reservation.settledMicros ?? reservation.reservedMicros;
  }
  return reservation.reservedMicros;
}

async function committedBudgetMicros(
  tx: Prisma.TransactionClient,
  budgetId: string,
  excludeReservationId?: string,
): Promise<bigint> {
  const rows = await tx.spendReservation.findMany({
    where: {
      budgetId,
      ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
      status: {
        in: [
          SpendReservationStatus.RESERVED,
          SpendReservationStatus.SETTLED,
        ],
      },
    },
    select: {
      status: true,
      reservedMicros: true,
      settledMicros: true,
    },
  });
  return rows.reduce(
    (total, reservation) =>
      total + reservationCommittedMicros(reservation),
    0n,
  );
}

export async function createSpendBudget(options: {
  tenantId: string;
  actorId: string;
  input: unknown;
}): Promise<SpendBudget> {
  const parsed = SpendBudgetInputSchema.parse(options.input);
  const periodStart = new Date(parsed.periodStart);
  const periodEnd = new Date(parsed.periodEnd);
  const softLimitMicros = parsed.softLimitUsd
    ? parseUsdToMicros(parsed.softLimitUsd)
    : null;
  const hardLimitMicros = parseUsdToMicros(parsed.hardLimitUsd);

  return db.$transaction(async (tx) => {
    await lockTenant(tx, options.tenantId);

    const exact = await tx.spendBudget.findUnique({
      where: {
        tenantId_name_periodStart_periodEnd: {
          tenantId: options.tenantId,
          name: parsed.name,
          periodStart,
          periodEnd,
        },
      },
    });
    if (exact) {
      if (
        exact.hardLimitMicros !== hardLimitMicros ||
        exact.softLimitMicros !== softLimitMicros
      ) {
        throw new SpendGovernanceError("overlapping_budget");
      }
      return exact;
    }

    const overlap = await tx.spendBudget.findFirst({
      where: {
        tenantId: options.tenantId,
        enabled: true,
        periodStart: { lt: periodEnd },
        periodEnd: { gt: periodStart },
      },
    });
    if (overlap) throw new SpendGovernanceError("overlapping_budget");

    const created = await tx.spendBudget.create({
      data: {
        tenantId: options.tenantId,
        name: parsed.name,
        periodStart,
        periodEnd,
        softLimitMicros,
        hardLimitMicros,
        createdBy: options.actorId,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        actor: options.actorId,
        action: "spend.budget.created",
        metadata: {
          contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
          budgetId: created.id,
          name: created.name,
          periodStart: created.periodStart.toISOString(),
          periodEnd: created.periodEnd.toISOString(),
          softLimitMicros: created.softLimitMicros?.toString() ?? null,
          hardLimitMicros: created.hardLimitMicros.toString(),
          currency: created.currency,
        },
      },
    });
    return created;
  });
}

function sameReservation(
  existing: SpendReservation,
  expected: {
    budgetId: string;
    provider: string;
    model: string;
    estimatedTokens: number;
    unitCostMicrosPer1k: bigint;
    reservedMicros: bigint;
  },
): boolean {
  return (
    existing.budgetId === expected.budgetId &&
    existing.provider === expected.provider &&
    existing.model === expected.model &&
    existing.estimatedTokens === expected.estimatedTokens &&
    existing.unitCostMicrosPer1k === expected.unitCostMicrosPer1k &&
    existing.reservedMicros === expected.reservedMicros
  );
}

export async function reserveSpendAgainstBudget(options: {
  tenantId: string;
  budgetId: string;
  runId?: string;
  taskId?: string;
  requestId: string;
  actorId: string;
  provider: string;
  model: string;
  estimatedTokens: number;
  unitCostMicrosPer1k: bigint;
  now?: Date;
}): Promise<SpendReservation> {
  const now = options.now ?? new Date();
  const estimatedTokens = assertSafeInteger(
    options.estimatedTokens,
    "estimated_token_count",
  );
  const estimatedCostMicros = costMicrosForTokens(
    estimatedTokens,
    options.unitCostMicrosPer1k,
  );
  const idempotencyKey = `model-reservation:${options.taskId ?? options.requestId}:v1`;

  return db.$transaction(async (tx) => {
    const lockedBudget = await lockBudget(
      tx,
      options.budgetId,
      options.tenantId,
    );
    if (!budgetActiveAt(lockedBudget, now)) {
      throw new SpendGovernanceError("budget_not_active");
    }

    const existing = await tx.spendReservation.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: options.tenantId,
          idempotencyKey,
        },
      },
    });
    if (existing) {
      if (
        !sameReservation(existing, {
          budgetId: lockedBudget.id,
          provider: options.provider,
          model: options.model,
          estimatedTokens,
          unitCostMicrosPer1k: options.unitCostMicrosPer1k,
          reservedMicros: estimatedCostMicros,
        })
      ) {
        throw new SpendGovernanceError("reservation_conflict");
      }
      return existing;
    }

    const committed = await committedBudgetMicros(tx, lockedBudget.id);
    const projected = committed + estimatedCostMicros;
    if (projected > lockedBudget.hardLimitMicros) {
      await tx.auditEvent.create({
        data: {
          tenantId: options.tenantId,
          runId: options.runId,
          actor: options.actorId,
          action: "spend.hard_limit_blocked",
          metadata: {
            contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
            budgetId: lockedBudget.id,
            requestId: options.requestId,
            taskId: options.taskId ?? null,
            committedMicros: committed.toString(),
            requestedMicros: estimatedCostMicros.toString(),
            hardLimitMicros: lockedBudget.hardLimitMicros.toString(),
          },
        },
      });
      throw new SpendGovernanceError("hard_budget_exceeded");
    }

    const created = await tx.spendReservation.create({
      data: {
        tenantId: options.tenantId,
        budgetId: lockedBudget.id,
        runId: options.runId,
        taskId: options.taskId,
        idempotencyKey,
        provider: options.provider,
        model: options.model,
        estimatedTokens,
        unitCostMicrosPer1k: options.unitCostMicrosPer1k,
        reservedMicros: estimatedCostMicros,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        runId: options.runId,
        actor: options.actorId,
        action: "spend.reserved",
        metadata: {
          contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
          budgetId: lockedBudget.id,
          reservationId: created.id,
          requestId: options.requestId,
          taskId: options.taskId ?? null,
          reservedMicros: estimatedCostMicros.toString(),
          projectedMicros: projected.toString(),
        },
      },
    });
    if (
      lockedBudget.softLimitMicros !== null &&
      projected > lockedBudget.softLimitMicros
    ) {
      await tx.auditEvent.create({
        data: {
          tenantId: options.tenantId,
          runId: options.runId,
          actor: options.actorId,
          action: "spend.soft_limit_exceeded",
          metadata: {
            contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
            budgetId: lockedBudget.id,
            reservationId: created.id,
            projectedMicros: projected.toString(),
            softLimitMicros: lockedBudget.softLimitMicros.toString(),
          },
        },
      });
    }
    return created;
  });
}

export async function beginModelSpend(options: {
  tenantId: string;
  runId?: string;
  taskId?: string;
  requestId: string;
  actorId: string;
  provider: string;
  model: string;
  messages: Array<{ content: string }>;
  now?: Date;
}): Promise<ModelSpendGuard> {
  const now = options.now ?? new Date();
  const estimatedTokens = estimateModelTokens(options.messages);
  const unitCostMicrosPer1k = registryModelCostMicrosPer1k(
    options.provider,
    options.model,
  );
  const estimatedCostMicros =
    unitCostMicrosPer1k === null
      ? null
      : costMicrosForTokens(estimatedTokens, unitCostMicrosPer1k);
  const budget = await activeBudgetAt(options.tenantId, now);

  if (!budget) {
    return {
      contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
      tenantId: options.tenantId,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      requestId: options.requestId,
      provider: options.provider,
      model: options.model,
      estimatedTokens,
      unitCostMicrosPer1k,
      estimatedCostMicros,
      reservation: null,
    };
  }

  if (unitCostMicrosPer1k === null || estimatedCostMicros === null) {
    throw new SpendGovernanceError("cost_evidence_missing");
  }

  const reservation = await reserveSpendAgainstBudget({
    tenantId: options.tenantId,
    budgetId: budget.id,
    runId: options.runId,
    taskId: options.taskId,
    requestId: options.requestId,
    actorId: options.actorId,
    provider: options.provider,
    model: options.model,
    estimatedTokens,
    unitCostMicrosPer1k,
    now,
  });

  return {
    contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
    tenantId: options.tenantId,
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
    requestId: options.requestId,
    provider: options.provider,
    model: options.model,
    estimatedTokens,
    unitCostMicrosPer1k,
    estimatedCostMicros,
    reservation,
  };
}

function sameLedgerIdentity(
  entry: UsageLedgerEntry,
  options: {
    provider: string;
    model: string;
    requestId: string;
    estimatedTokens: number;
  },
): boolean {
  return (
    entry.provider === options.provider &&
    entry.model === options.model &&
    entry.requestId === options.requestId &&
    entry.estimatedTokens === options.estimatedTokens
  );
}

async function createUsageLedgerEntry(
  tx: Prisma.TransactionClient,
  options: {
    tenantId: string;
    reservationId?: string;
    idempotencyKey: string;
    runId?: string;
    taskId?: string;
    requestId: string;
    provider: string;
    model: string;
    estimatedTokens: number;
    totalTokens: number | null;
    latencyMs: number;
    unitCostMicrosPer1k: bigint | null;
    estimatedCostMicros: bigint | null;
    actualCostMicros: bigint | null;
    costBasis: UsageCostBasis;
    outcome: UsageOutcome;
    occurredAt: Date;
  },
): Promise<UsageLedgerEntry> {
  const existing = await tx.usageLedgerEntry.findUnique({
    where: {
      tenantId_idempotencyKey: {
        tenantId: options.tenantId,
        idempotencyKey: options.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (!sameLedgerIdentity(existing, options)) {
      throw new SpendGovernanceError("settlement_conflict");
    }
    return existing;
  }

  return tx.usageLedgerEntry.create({
    data: {
      tenantId: options.tenantId,
      reservationId: options.reservationId,
      idempotencyKey: options.idempotencyKey,
      runId: options.runId,
      taskId: options.taskId,
      requestId: options.requestId,
      provider: options.provider,
      model: options.model,
      estimatedTokens: options.estimatedTokens,
      totalTokens: options.totalTokens,
      latencyMs: options.latencyMs,
      unitCostMicrosPer1k: options.unitCostMicrosPer1k,
      estimatedCostMicros: options.estimatedCostMicros,
      actualCostMicros: options.actualCostMicros,
      costBasis: options.costBasis,
      outcome: options.outcome,
      occurredAt: options.occurredAt,
    },
  });
}

export async function settleModelSpend(options: {
  guard: ModelSpendGuard;
  actorId: string;
  totalTokens?: number;
  latencyMs: number;
  occurredAt?: Date;
}): Promise<{
  ledger: UsageLedgerEntry;
  hardLimitOverrun: boolean;
  softLimitExceeded: boolean;
}> {
  const occurredAt = options.occurredAt ?? new Date();
  const totalTokens =
    options.totalTokens === undefined
      ? null
      : assertSafeInteger(options.totalTokens, "total_tokens");
  const latencyMs = assertSafeInteger(options.latencyMs, "latency_ms");
  const guard = options.guard;

  if (!guard.reservation) {
    const actualCostMicros =
      guard.unitCostMicrosPer1k !== null && totalTokens !== null
        ? costMicrosForTokens(totalTokens, guard.unitCostMicrosPer1k)
        : null;
    const costBasis =
      actualCostMicros !== null
        ? UsageCostBasis.REGISTRY_ACTUAL_TOKENS
        : guard.unitCostMicrosPer1k !== null
          ? UsageCostBasis.REGISTRY_ESTIMATE_ONLY
          : UsageCostBasis.UNKNOWN;
    const ledger = await db.$transaction(async (tx) => {
      const created = await createUsageLedgerEntry(tx, {
        tenantId: guard.tenantId,
        idempotencyKey: `model-usage:${guard.taskId ?? guard.requestId}:v1`,
        runId: guard.runId,
        taskId: guard.taskId,
        requestId: guard.requestId,
        provider: guard.provider,
        model: guard.model,
        estimatedTokens: guard.estimatedTokens,
        totalTokens,
        latencyMs,
        unitCostMicrosPer1k: guard.unitCostMicrosPer1k,
        estimatedCostMicros: guard.estimatedCostMicros,
        actualCostMicros,
        costBasis,
        outcome: UsageOutcome.SUCCEEDED,
        occurredAt,
      });
      await tx.auditEvent.create({
        data: {
          tenantId: guard.tenantId,
          runId: guard.runId,
          actor: options.actorId,
          action: "usage.metered",
          metadata: {
            contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
            usageId: created.id,
            requestId: guard.requestId,
            taskId: guard.taskId ?? null,
            provider: guard.provider,
            model: guard.model,
            totalTokens,
            latencyMs,
            estimatedCostMicros: guard.estimatedCostMicros?.toString() ?? null,
            actualCostMicros: actualCostMicros?.toString() ?? null,
            costBasis,
          },
        },
      });
      return created;
    });
    return {
      ledger,
      hardLimitOverrun: false,
      softLimitExceeded: false,
    };
  }

  return db.$transaction(async (tx) => {
    const reservation = await tx.spendReservation.findUnique({
      where: { id: guard.reservation?.id },
    });
    if (!reservation || reservation.tenantId !== guard.tenantId) {
      throw new SpendGovernanceError("reservation_not_found");
    }
    const budget = await lockBudget(tx, reservation.budgetId, guard.tenantId);

    const settledMicros =
      totalTokens !== null
        ? costMicrosForTokens(totalTokens, reservation.unitCostMicrosPer1k)
        : reservation.reservedMicros;
    const costBasis =
      totalTokens !== null
        ? UsageCostBasis.REGISTRY_ACTUAL_TOKENS
        : UsageCostBasis.REGISTRY_RESERVED_ESTIMATE;

    if (reservation.status === SpendReservationStatus.RELEASED) {
      throw new SpendGovernanceError("settlement_conflict");
    }
    if (reservation.status === SpendReservationStatus.SETTLED) {
      if (
        reservation.settledMicros !== settledMicros ||
        reservation.actualTokens !== totalTokens
      ) {
        throw new SpendGovernanceError("settlement_conflict");
      }
      const ledger = await tx.usageLedgerEntry.findUnique({
        where: { reservationId: reservation.id },
      });
      if (!ledger) throw new SpendGovernanceError("settlement_conflict");
      const committed = await committedBudgetMicros(tx, budget.id);
      return {
        ledger,
        hardLimitOverrun: committed > budget.hardLimitMicros,
        softLimitExceeded:
          budget.softLimitMicros !== null &&
          committed > budget.softLimitMicros,
      };
    }

    const otherCommitted = await committedBudgetMicros(
      tx,
      budget.id,
      reservation.id,
    );
    const projected = otherCommitted + settledMicros;
    const hardLimitOverrun = projected > budget.hardLimitMicros;
    const softLimitExceeded =
      budget.softLimitMicros !== null && projected > budget.softLimitMicros;

    await tx.spendReservation.update({
      where: { id: reservation.id },
      data: {
        status: SpendReservationStatus.SETTLED,
        settledMicros,
        actualTokens: totalTokens,
        settledAt: occurredAt,
      },
    });

    const ledger = await createUsageLedgerEntry(tx, {
      tenantId: guard.tenantId,
      reservationId: reservation.id,
      idempotencyKey: `model-usage:${guard.taskId ?? guard.requestId}:v1`,
      runId: guard.runId,
      taskId: guard.taskId,
      requestId: guard.requestId,
      provider: guard.provider,
      model: guard.model,
      estimatedTokens: guard.estimatedTokens,
      totalTokens,
      latencyMs,
      unitCostMicrosPer1k: reservation.unitCostMicrosPer1k,
      estimatedCostMicros: reservation.reservedMicros,
      actualCostMicros: totalTokens !== null ? settledMicros : null,
      costBasis,
      outcome: UsageOutcome.SUCCEEDED,
      occurredAt,
    });

    await tx.auditEvent.create({
      data: {
        tenantId: guard.tenantId,
        runId: guard.runId,
        actor: options.actorId,
        action: hardLimitOverrun
          ? "spend.hard_limit_overrun"
          : "spend.settled",
        metadata: {
          contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
          budgetId: budget.id,
          reservationId: reservation.id,
          usageId: ledger.id,
          requestId: guard.requestId,
          taskId: guard.taskId ?? null,
          reservedMicros: reservation.reservedMicros.toString(),
          settledMicros: settledMicros.toString(),
          projectedMicros: projected.toString(),
          hardLimitMicros: budget.hardLimitMicros.toString(),
          totalTokens,
          latencyMs,
          costBasis,
        },
      },
    });

    return { ledger, hardLimitOverrun, softLimitExceeded };
  });
}

export async function recordFailedModelSpend(options: {
  guard: ModelSpendGuard;
  actorId: string;
  latencyMs: number;
  reason: string;
  occurredAt?: Date;
}): Promise<UsageLedgerEntry> {
  const occurredAt = options.occurredAt ?? new Date();
  const latencyMs = assertSafeInteger(options.latencyMs, "latency_ms");
  const guard = options.guard;
  const reservation = guard.reservation;

  if (!reservation) {
    return db.$transaction(async (tx) => {
      const ledger = await createUsageLedgerEntry(tx, {
        tenantId: guard.tenantId,
        idempotencyKey: `model-usage:${guard.taskId ?? guard.requestId}:v1`,
        runId: guard.runId,
        taskId: guard.taskId,
        requestId: guard.requestId,
        provider: guard.provider,
        model: guard.model,
        estimatedTokens: guard.estimatedTokens,
        totalTokens: null,
        latencyMs,
        unitCostMicrosPer1k: guard.unitCostMicrosPer1k,
        estimatedCostMicros: guard.estimatedCostMicros,
        actualCostMicros: null,
        costBasis:
          guard.unitCostMicrosPer1k === null
            ? UsageCostBasis.UNKNOWN
            : UsageCostBasis.REGISTRY_ESTIMATE_ONLY,
        outcome: UsageOutcome.FAILED,
        occurredAt,
      });
      await tx.auditEvent.create({
        data: {
          tenantId: guard.tenantId,
          runId: guard.runId,
          actor: options.actorId,
          action: "usage.failed_call_metered",
          metadata: {
            contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
            usageId: ledger.id,
            requestId: guard.requestId,
            taskId: guard.taskId ?? null,
            provider: guard.provider,
            model: guard.model,
            estimatedCostMicros: guard.estimatedCostMicros?.toString() ?? null,
            latencyMs,
            reason: options.reason.slice(0, 500),
          },
        },
      });
      return ledger;
    });
  }

  return db.$transaction(async (tx) => {
    const current = await tx.spendReservation.findUnique({
      where: { id: reservation.id },
    });
    if (!current || current.tenantId !== guard.tenantId) {
      throw new SpendGovernanceError("reservation_not_found");
    }
    await lockBudget(tx, current.budgetId, guard.tenantId);

    if (current.status === SpendReservationStatus.RELEASED) {
      throw new SpendGovernanceError("settlement_conflict");
    }

    const existingLedger = await tx.usageLedgerEntry.findUnique({
      where: { reservationId: current.id },
    });
    if (current.status === SpendReservationStatus.SETTLED) {
      if (!existingLedger || existingLedger.outcome !== UsageOutcome.FAILED) {
        throw new SpendGovernanceError("settlement_conflict");
      }
      return existingLedger;
    }

    await tx.spendReservation.update({
      where: { id: current.id },
      data: {
        status: SpendReservationStatus.SETTLED,
        settledMicros: current.reservedMicros,
        actualTokens: null,
        settledAt: occurredAt,
      },
    });
    const ledger = await createUsageLedgerEntry(tx, {
      tenantId: guard.tenantId,
      reservationId: current.id,
      idempotencyKey: `model-usage:${guard.taskId ?? guard.requestId}:v1`,
      runId: guard.runId,
      taskId: guard.taskId,
      requestId: guard.requestId,
      provider: guard.provider,
      model: guard.model,
      estimatedTokens: guard.estimatedTokens,
      totalTokens: null,
      latencyMs,
      unitCostMicrosPer1k: current.unitCostMicrosPer1k,
      estimatedCostMicros: current.reservedMicros,
      actualCostMicros: null,
      costBasis: UsageCostBasis.REGISTRY_RESERVED_ESTIMATE,
      outcome: UsageOutcome.FAILED,
      occurredAt,
    });
    await tx.auditEvent.create({
      data: {
        tenantId: guard.tenantId,
        runId: guard.runId,
        actor: options.actorId,
        action: "spend.failed_call_settled",
        metadata: {
          contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
          budgetId: current.budgetId,
          reservationId: current.id,
          usageId: ledger.id,
          requestId: guard.requestId,
          reservedMicros: current.reservedMicros.toString(),
          latencyMs,
          reason: options.reason.slice(0, 500),
        },
      },
    });
    return ledger;
  });
}

export async function releaseModelSpend(options: {
  guard: ModelSpendGuard;
  actorId: string;
  reason: string;
  releasedAt?: Date;
}): Promise<void> {
  const reservationId = options.guard.reservation?.id;
  if (!reservationId) return;
  const releasedAt = options.releasedAt ?? new Date();

  await db.$transaction(async (tx) => {
    const reservation = await tx.spendReservation.findUnique({
      where: { id: reservationId },
    });
    if (!reservation || reservation.tenantId !== options.guard.tenantId) {
      throw new SpendGovernanceError("reservation_not_found");
    }
    await lockBudget(tx, reservation.budgetId, options.guard.tenantId);
    if (reservation.status === SpendReservationStatus.RELEASED) return;
    if (reservation.status === SpendReservationStatus.SETTLED) return;

    await tx.spendReservation.update({
      where: { id: reservation.id },
      data: {
        status: SpendReservationStatus.RELEASED,
        settledAt: releasedAt,
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: options.guard.tenantId,
        runId: options.guard.runId,
        actor: options.actorId,
        action: "spend.reservation.released",
        metadata: {
          contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
          budgetId: reservation.budgetId,
          reservationId: reservation.id,
          requestId: options.guard.requestId,
          reason: options.reason.slice(0, 500),
        },
      },
    });
  });
}

export async function listSpendBudgets(
  tenantId: string,
): Promise<SpendBudget[]> {
  return db.spendBudget.findMany({
    where: { tenantId },
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
  });
}

export async function getSpendSummary(options: {
  tenantId: string;
  from: Date;
  to: Date;
}): Promise<{
  contractVersion: typeof SPEND_GOVERNANCE_CONTRACT_VERSION;
  from: string;
  to: string;
  calls: number;
  meteredTokenCalls: number;
  totalTokens: number;
  estimatedCostMicros: string;
  actualCostMicros: string;
  unknownActualCostCalls: number;
  estimatedCostUsd: string;
  actualCostUsd: string;
  byModel: Array<{
    provider: string;
    model: string;
    calls: number;
    totalTokens: number;
    actualCostMicros: string;
  }>;
}> {
  if (
    !Number.isFinite(options.from.getTime()) ||
    !Number.isFinite(options.to.getTime()) ||
    options.to.getTime() <= options.from.getTime()
  ) {
    throw new SpendGovernanceError("invalid_usage_range");
  }

  const entries = await db.usageLedgerEntry.findMany({
    where: {
      tenantId: options.tenantId,
      occurredAt: { gte: options.from, lt: options.to },
    },
    orderBy: [{ provider: "asc" }, { model: "asc" }, { occurredAt: "asc" }],
  });

  let estimatedCostMicros = 0n;
  let actualCostMicros = 0n;
  let totalTokens = 0;
  let meteredTokenCalls = 0;
  let unknownActualCostCalls = 0;
  const groups = new Map<
    string,
    {
      provider: string;
      model: string;
      calls: number;
      totalTokens: number;
      actualCostMicros: bigint;
    }
  >();

  for (const entry of entries) {
    estimatedCostMicros += entry.estimatedCostMicros ?? 0n;
    actualCostMicros += entry.actualCostMicros ?? 0n;
    if (entry.totalTokens !== null) {
      totalTokens += entry.totalTokens;
      meteredTokenCalls += 1;
    }
    if (entry.actualCostMicros === null) unknownActualCostCalls += 1;

    const key = `${entry.provider}\0${entry.model}`;
    const group = groups.get(key) ?? {
      provider: entry.provider,
      model: entry.model,
      calls: 0,
      totalTokens: 0,
      actualCostMicros: 0n,
    };
    group.calls += 1;
    group.totalTokens += entry.totalTokens ?? 0;
    group.actualCostMicros += entry.actualCostMicros ?? 0n;
    groups.set(key, group);
  }

  return {
    contractVersion: SPEND_GOVERNANCE_CONTRACT_VERSION,
    from: options.from.toISOString(),
    to: options.to.toISOString(),
    calls: entries.length,
    meteredTokenCalls,
    totalTokens,
    estimatedCostMicros: estimatedCostMicros.toString(),
    actualCostMicros: actualCostMicros.toString(),
    unknownActualCostCalls,
    estimatedCostUsd: formatMicrosAsUsd(estimatedCostMicros),
    actualCostUsd: formatMicrosAsUsd(actualCostMicros),
    byModel: [...groups.values()].map((group) => ({
      provider: group.provider,
      model: group.model,
      calls: group.calls,
      totalTokens: group.totalTokens,
      actualCostMicros: group.actualCostMicros.toString(),
    })),
  };
}
