import { createHash } from "node:crypto";
import type {
  BudgetPolicy,
  Prisma,
  SpendReservation,
  UsageEvent,
} from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";

export const USAGE_LEDGER_CONTRACT_VERSION =
  "raeburnai.usage-ledger.v1" as const;
export const BUDGET_POLICY_CONTRACT_VERSION =
  "raeburnai.budget-policy.v1" as const;

const MicrousdSchema = z.number().int().safe().min(0);
const IdempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/);

export const BudgetPolicyInputSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
    monthlyLimitMicrousd: MicrousdSchema.nullable().default(null),
    perRequestLimitMicrousd: MicrousdSchema.nullable().default(null),
    warningRatio: z.number().finite().gt(0).max(1).default(0.8),
    enforcementMode: z.enum(["hard", "monitor"]).default("hard"),
    fallbackMode: z
      .enum(["block", "cheapest_eligible", "local_only"])
      .default("block"),
  })
  .superRefine((value, context) => {
    if (
      value.monthlyLimitMicrousd !== null &&
      value.perRequestLimitMicrousd !== null &&
      value.perRequestLimitMicrousd > value.monthlyLimitMicrousd
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["perRequestLimitMicrousd"],
        message: "per-request limit cannot exceed monthly limit",
      });
    }
  });

export const SpendReservationInputSchema = z.object({
  tenantId: z.string().trim().min(1).max(256),
  actorId: z.string().trim().min(1).max(256),
  requestId: z.string().trim().min(1).max(256),
  idempotencyKey: IdempotencyKeySchema,
  estimatedCostMicrousd: MicrousdSchema,
  ttlSeconds: z.number().int().min(30).max(3600).default(300),
});

export const UsageCommitInputSchema = z.object({
  tenantId: z.string().trim().min(1).max(256),
  reservationId: z.string().uuid(),
  idempotencyKey: IdempotencyKeySchema,
  actorId: z.string().trim().min(1).max(256),
  runId: z.string().trim().min(1).max(256).optional(),
  category: z.enum(["model", "tool", "retrieval", "workflow", "other"]),
  provider: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(256).optional(),
  modelRegistryId: z.string().trim().min(1).max(256).optional(),
  expertSlug: z.string().trim().min(1).max(256).optional(),
  toolName: z.string().trim().min(1).max(256).optional(),
  inputTokens: z.number().int().min(0).max(2_000_000_000).default(0),
  outputTokens: z.number().int().min(0).max(2_000_000_000).default(0),
  latencyMs: z.number().int().min(0).max(2_000_000_000).optional(),
  actualCostMicrousd: MicrousdSchema,
  billableMetric: z.string().trim().min(1).max(128).default("request"),
  billableUnits: z.number().int().min(1).max(2_000_000_000).default(1),
  metadata: z.record(z.unknown()).default({}),
  occurredAt: z.string().datetime({ offset: true }),
});

export class UsageLedgerError extends Error {
  constructor(
    public readonly code:
      | "tenant_not_found"
      | "budget_policy_missing"
      | "budget_exceeded"
      | "idempotency_conflict"
      | "reservation_not_found"
      | "reservation_expired"
      | "reservation_invalid_state"
      | "usage_event_not_found",
    public readonly detail?: string,
  ) {
    super(detail ? code + ": " + detail : code);
    this.name = "UsageLedgerError";
  }
}

type DbClient = Prisma.TransactionClient | typeof db;

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function bigint(value: number): bigint {
  return BigInt(value);
}

function monthBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  return { start, end };
}

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  }
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function budgetPolicyComparable(
  policy: BudgetPolicy,
  input: z.infer<typeof BudgetPolicyInputSchema>,
): boolean {
  return (
    policy.currency === input.currency &&
    policy.monthlyLimitMicrousd ===
      (input.monthlyLimitMicrousd === null
        ? null
        : bigint(input.monthlyLimitMicrousd)) &&
    policy.perRequestLimitMicrousd ===
      (input.perRequestLimitMicrousd === null
        ? null
        : bigint(input.perRequestLimitMicrousd)) &&
    policy.warningRatio === input.warningRatio &&
    policy.enforcementMode === input.enforcementMode &&
    policy.fallbackMode === input.fallbackMode
  );
}

export async function setBudgetPolicy(options: {
  tenantId: string;
  actorId: string;
  policy: unknown;
}): Promise<BudgetPolicy> {
  const policyInput = BudgetPolicyInputSchema.parse(options.policy);
  const tenant = await db.tenant.findUnique({
    where: { id: options.tenantId },
    select: { id: true },
  });
  if (!tenant) throw new UsageLedgerError("tenant_not_found");

  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "BudgetPolicy" WHERE "tenantId" = $1 FOR UPDATE',
      options.tenantId,
    );

    const existing = await tx.budgetPolicy.findUnique({
      where: { tenantId: options.tenantId },
    });
    if (existing && budgetPolicyComparable(existing, policyInput)) {
      return existing;
    }

    const policy = existing
      ? await tx.budgetPolicy.update({
          where: { id: existing.id },
          data: {
            currency: policyInput.currency,
            monthlyLimitMicrousd:
              policyInput.monthlyLimitMicrousd === null
                ? null
                : bigint(policyInput.monthlyLimitMicrousd),
            perRequestLimitMicrousd:
              policyInput.perRequestLimitMicrousd === null
                ? null
                : bigint(policyInput.perRequestLimitMicrousd),
            warningRatio: policyInput.warningRatio,
            enforcementMode: policyInput.enforcementMode,
            fallbackMode: policyInput.fallbackMode,
            version: { increment: 1 },
          },
        })
      : await tx.budgetPolicy.create({
          data: {
            tenantId: options.tenantId,
            currency: policyInput.currency,
            monthlyLimitMicrousd:
              policyInput.monthlyLimitMicrousd === null
                ? null
                : bigint(policyInput.monthlyLimitMicrousd),
            perRequestLimitMicrousd:
              policyInput.perRequestLimitMicrousd === null
                ? null
                : bigint(policyInput.perRequestLimitMicrousd),
            warningRatio: policyInput.warningRatio,
            enforcementMode: policyInput.enforcementMode,
            fallbackMode: policyInput.fallbackMode,
          },
        });

    await tx.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        actor: options.actorId,
        action: "usage.budget_policy.updated",
        metadata: {
          contractVersion: BUDGET_POLICY_CONTRACT_VERSION,
          policyId: policy.id,
          version: policy.version,
          currency: policy.currency,
          monthlyLimitMicrousd: policy.monthlyLimitMicrousd?.toString() ?? null,
          perRequestLimitMicrousd:
            policy.perRequestLimitMicrousd?.toString() ?? null,
          warningRatio: policy.warningRatio,
          enforcementMode: policy.enforcementMode,
          fallbackMode: policy.fallbackMode,
        },
      },
    });
    return policy;
  });
}

async function budgetSnapshotWithClient(
  client: DbClient,
  tenantId: string,
  now: Date,
) {
  const policy = await client.budgetPolicy.findUnique({ where: { tenantId } });
  if (!policy) throw new UsageLedgerError("budget_policy_missing");

  const { start, end } = monthBounds(now);
  const [usage, reservations] = await Promise.all([
    client.usageEvent.aggregate({
      where: {
        tenantId,
        occurredAt: { gte: start, lt: end },
      },
      _sum: { costMicrousd: true },
      _count: true,
    }),
    client.spendReservation.aggregate({
      where: {
        tenantId,
        status: "RESERVED",
        expiresAt: { gt: now },
      },
      _sum: { estimatedCostMicrousd: true },
      _count: true,
    }),
  ]);

  const spentMicrousd = usage._sum.costMicrousd ?? 0n;
  const reservedMicrousd = reservations._sum.estimatedCostMicrousd ?? 0n;
  const committedAndReserved = spentMicrousd + reservedMicrousd;
  const limit = policy.monthlyLimitMicrousd;
  const utilizationRatio =
    limit && limit > 0n ? Number(committedAndReserved) / Number(limit) : null;
  const remainingMicrousd =
    limit === null ? null : limit - committedAndReserved;
  const warning =
    utilizationRatio !== null && utilizationRatio >= policy.warningRatio;
  const breached = limit !== null && committedAndReserved > limit;

  return {
    contractVersion: BUDGET_POLICY_CONTRACT_VERSION,
    policy,
    period: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
    eventCount: usage._count,
    activeReservationCount: reservations._count,
    spentMicrousd,
    reservedMicrousd,
    committedAndReservedMicrousd: committedAndReserved,
    remainingMicrousd,
    utilizationRatio,
    warning,
    breached,
  };
}

export async function getBudgetSnapshot(tenantId: string, now = new Date()) {
  return budgetSnapshotWithClient(db, tenantId, now);
}

function reservationPayloadHash(
  input: z.infer<typeof SpendReservationInputSchema>,
): string {
  return digest({
    contractVersion: BUDGET_POLICY_CONTRACT_VERSION,
    tenantId: input.tenantId,
    requestId: input.requestId,
    actorId: input.actorId,
    estimatedCostMicrousd: input.estimatedCostMicrousd,
    ttlSeconds: input.ttlSeconds,
  });
}

function reservationDecision(options: {
  policy: BudgetPolicy;
  snapshot: Awaited<ReturnType<typeof budgetSnapshotWithClient>>;
  estimatedCostMicrousd: bigint;
}) {
  const { policy, snapshot, estimatedCostMicrousd } = options;
  const reasons: string[] = [];
  if (
    policy.perRequestLimitMicrousd !== null &&
    estimatedCostMicrousd > policy.perRequestLimitMicrousd
  ) {
    reasons.push("estimated request cost exceeds per-request budget");
  }
  if (
    policy.monthlyLimitMicrousd !== null &&
    snapshot.committedAndReservedMicrousd + estimatedCostMicrousd >
      policy.monthlyLimitMicrousd
  ) {
    reasons.push("estimated request cost exceeds remaining monthly budget");
  }

  return {
    allowed: reasons.length === 0 || policy.enforcementMode === "monitor",
    warning: reasons.length > 0,
    reasons,
  };
}

export async function reserveSpend(
  input: unknown,
  now = new Date(),
): Promise<{
  reservation: SpendReservation;
  idempotent: boolean;
  warning: boolean;
  reasons: string[];
}> {
  const parsed = SpendReservationInputSchema.parse(input);
  const payloadHash = reservationPayloadHash(parsed);

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "BudgetPolicy" WHERE "tenantId" = $1 FOR UPDATE',
        parsed.tenantId,
      );
      const policy = await tx.budgetPolicy.findUnique({
        where: { tenantId: parsed.tenantId },
      });
      if (!policy) throw new UsageLedgerError("budget_policy_missing");

      const existing = await tx.spendReservation.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: parsed.tenantId,
            idempotencyKey: parsed.idempotencyKey,
          },
        },
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new UsageLedgerError("idempotency_conflict");
        }
        return {
          reservation: existing,
          idempotent: true,
          warning: false,
          reasons: [],
        };
      }

      const snapshot = await budgetSnapshotWithClient(
        tx,
        parsed.tenantId,
        now,
      );
      const decision = reservationDecision({
        policy,
        snapshot,
        estimatedCostMicrousd: bigint(parsed.estimatedCostMicrousd),
      });
      if (!decision.allowed) {
        throw new UsageLedgerError(
          "budget_exceeded",
          decision.reasons.join("; "),
        );
      }

      const reservation = await tx.spendReservation.create({
        data: {
          tenantId: parsed.tenantId,
          idempotencyKey: parsed.idempotencyKey,
          payloadHash,
          requestId: parsed.requestId,
          actorId: parsed.actorId,
          estimatedCostMicrousd: bigint(parsed.estimatedCostMicrousd),
          policyVersion: policy.version,
          expiresAt: new Date(now.getTime() + parsed.ttlSeconds * 1000),
        },
      });
      await tx.auditEvent.create({
        data: {
          tenantId: parsed.tenantId,
          actor: parsed.actorId,
          action: "usage.spend_reservation.created",
          metadata: {
            contractVersion: BUDGET_POLICY_CONTRACT_VERSION,
            reservationId: reservation.id,
            requestId: reservation.requestId,
            estimatedCostMicrousd: reservation.estimatedCostMicrousd.toString(),
            policyVersion: reservation.policyVersion,
            warning: decision.warning,
            reasons: decision.reasons,
          },
        },
      });

      return {
        reservation,
        idempotent: false,
        warning: decision.warning,
        reasons: decision.reasons,
      };
    });
  } catch (error) {
    if (error instanceof UsageLedgerError && error.code === "budget_exceeded") {
      const policy = await db.budgetPolicy.findUnique({
        where: { tenantId: parsed.tenantId },
      });
      await db.auditEvent.create({
        data: {
          tenantId: parsed.tenantId,
          actor: parsed.actorId,
          action: "usage.spend_reservation.denied",
          metadata: {
            contractVersion: BUDGET_POLICY_CONTRACT_VERSION,
            requestId: parsed.requestId,
            idempotencyKey: parsed.idempotencyKey,
            estimatedCostMicrousd: String(parsed.estimatedCostMicrousd),
            policyVersion: policy?.version ?? null,
            fallbackMode: policy?.fallbackMode ?? null,
            reason: error.detail ?? error.code,
          },
        },
      });
    }
    throw error;
  }
}

function usageEventDigest(
  input: z.infer<typeof UsageCommitInputSchema>,
  reservation: SpendReservation,
): string {
  return digest({
    contractVersion: USAGE_LEDGER_CONTRACT_VERSION,
    tenantId: input.tenantId,
    reservationId: reservation.id,
    requestId: reservation.requestId,
    runId: input.runId ?? null,
    actorId: input.actorId,
    category: input.category,
    provider: input.provider ?? null,
    model: input.model ?? null,
    modelRegistryId: input.modelRegistryId ?? null,
    expertSlug: input.expertSlug ?? null,
    toolName: input.toolName ?? null,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    latencyMs: input.latencyMs ?? null,
    costMicrousd: input.actualCostMicrousd,
    billableMetric: input.billableMetric,
    billableUnits: input.billableUnits,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
  });
}

export async function commitSpend(
  input: unknown,
  now = new Date(),
): Promise<{
  event: UsageEvent;
  reservation: SpendReservation;
  idempotent: boolean;
  budgetBreached: boolean;
  overReservation: boolean;
}> {
  const parsed = UsageCommitInputSchema.parse(input);

  try {
    return await db.$transaction(async (tx) => {
      await tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "SpendReservation" WHERE "id" = $1 AND "tenantId" = $2 FOR UPDATE',
        parsed.reservationId,
        parsed.tenantId,
      );
      const reservation = await tx.spendReservation.findUnique({
        where: { id: parsed.reservationId },
      });
      if (!reservation || reservation.tenantId !== parsed.tenantId) {
        throw new UsageLedgerError("reservation_not_found");
      }

      const eventDigest = usageEventDigest(parsed, reservation);
      if (reservation.status === "COMMITTED") {
        const existing = await tx.usageEvent.findUnique({
          where: { reservationId: reservation.id },
        });
        if (!existing) throw new UsageLedgerError("usage_event_not_found");
        if (
          existing.eventDigest !== eventDigest ||
          existing.idempotencyKey !== parsed.idempotencyKey
        ) {
          throw new UsageLedgerError("idempotency_conflict");
        }
        const snapshot = await budgetSnapshotWithClient(
          tx,
          parsed.tenantId,
          new Date(parsed.occurredAt),
        );
        return {
          event: existing,
          reservation,
          idempotent: true,
          budgetBreached: snapshot.breached,
          overReservation:
            existing.costMicrousd > reservation.estimatedCostMicrousd,
        };
      }

      if (reservation.status !== "RESERVED") {
        throw new UsageLedgerError(
          "reservation_invalid_state",
          reservation.status,
        );
      }
      if (reservation.expiresAt.getTime() <= now.getTime()) {
        await tx.spendReservation.update({
          where: { id: reservation.id },
          data: { status: "EXPIRED" },
        });
        throw new UsageLedgerError("reservation_expired");
      }

      const occurredAt = new Date(parsed.occurredAt);
      const event = await tx.usageEvent.create({
        data: {
          tenantId: parsed.tenantId,
          reservationId: reservation.id,
          idempotencyKey: parsed.idempotencyKey,
          requestId: reservation.requestId,
          runId: parsed.runId ?? null,
          actorId: parsed.actorId,
          category: parsed.category,
          provider: parsed.provider ?? null,
          model: parsed.model ?? null,
          modelRegistryId: parsed.modelRegistryId ?? null,
          expertSlug: parsed.expertSlug ?? null,
          toolName: parsed.toolName ?? null,
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          latencyMs: parsed.latencyMs ?? null,
          costMicrousd: bigint(parsed.actualCostMicrousd),
          billableMetric: parsed.billableMetric,
          billableUnits: parsed.billableUnits,
          metadata: inputJson(parsed.metadata),
          eventDigest,
          occurredAt,
        },
      });

      const committed = await tx.spendReservation.update({
        where: { id: reservation.id },
        data: {
          status: "COMMITTED",
          committedCostMicrousd: bigint(parsed.actualCostMicrousd),
        },
      });
      const snapshot = await budgetSnapshotWithClient(
        tx,
        parsed.tenantId,
        occurredAt,
      );
      const overReservation =
        event.costMicrousd > reservation.estimatedCostMicrousd;

      await tx.auditEvent.create({
        data: {
          tenantId: parsed.tenantId,
          runId: parsed.runId ?? null,
          actor: parsed.actorId,
          action: "usage.event.committed",
          metadata: {
            contractVersion: USAGE_LEDGER_CONTRACT_VERSION,
            usageEventId: event.id,
            reservationId: reservation.id,
            requestId: reservation.requestId,
            category: event.category,
            costMicrousd: event.costMicrousd.toString(),
            billableMetric: event.billableMetric,
            billableUnits: event.billableUnits,
            eventDigest,
            overReservation,
            budgetBreached: snapshot.breached,
          },
        },
      });

      return {
        event,
        reservation: committed,
        idempotent: false,
        budgetBreached: snapshot.breached,
        overReservation,
      };
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      throw new UsageLedgerError("idempotency_conflict");
    }
    throw error;
  }
}

export async function releaseSpend(options: {
  tenantId: string;
  reservationId: string;
  actorId: string;
  reason?: string;
}): Promise<SpendReservation> {
  return db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT "id" FROM "SpendReservation" WHERE "id" = $1 AND "tenantId" = $2 FOR UPDATE',
      options.reservationId,
      options.tenantId,
    );
    const reservation = await tx.spendReservation.findUnique({
      where: { id: options.reservationId },
    });
    if (!reservation || reservation.tenantId !== options.tenantId) {
      throw new UsageLedgerError("reservation_not_found");
    }
    if (reservation.status === "RELEASED") return reservation;
    if (reservation.status !== "RESERVED") {
      throw new UsageLedgerError(
        "reservation_invalid_state",
        reservation.status,
      );
    }

    const released = await tx.spendReservation.update({
      where: { id: reservation.id },
      data: { status: "RELEASED" },
    });
    await tx.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        actor: options.actorId,
        action: "usage.spend_reservation.released",
        metadata: {
          contractVersion: BUDGET_POLICY_CONTRACT_VERSION,
          reservationId: reservation.id,
          requestId: reservation.requestId,
          reason: options.reason?.slice(0, 500) ?? null,
        },
      },
    });
    return released;
  });
}

export async function expireSpendReservations(
  tenantId: string,
  now = new Date(),
): Promise<number> {
  const updated = await db.spendReservation.updateMany({
    where: {
      tenantId,
      status: "RESERVED",
      expiresAt: { lte: now },
    },
    data: { status: "EXPIRED" },
  });
  return updated.count;
}

function amountObject(value: bigint | null) {
  return value === null
    ? null
    : {
        microusd: value.toString(),
        usd: Number(value) / 1_000_000,
      };
}

export function serializeBudgetSnapshot(
  snapshot: Awaited<ReturnType<typeof getBudgetSnapshot>>,
) {
  return {
    contractVersion: snapshot.contractVersion,
    policy: {
      id: snapshot.policy.id,
      version: snapshot.policy.version,
      currency: snapshot.policy.currency,
      monthlyLimit: amountObject(snapshot.policy.monthlyLimitMicrousd),
      perRequestLimit: amountObject(snapshot.policy.perRequestLimitMicrousd),
      warningRatio: snapshot.policy.warningRatio,
      enforcementMode: snapshot.policy.enforcementMode,
      fallbackMode: snapshot.policy.fallbackMode,
    },
    period: snapshot.period,
    eventCount: snapshot.eventCount,
    activeReservationCount: snapshot.activeReservationCount,
    spent: amountObject(snapshot.spentMicrousd),
    reserved: amountObject(snapshot.reservedMicrousd),
    committedAndReserved: amountObject(snapshot.committedAndReservedMicrousd),
    remaining: amountObject(snapshot.remainingMicrousd),
    utilizationRatio: snapshot.utilizationRatio,
    warning: snapshot.warning,
    breached: snapshot.breached,
  };
}

type SummaryEvent = {
  category: string;
  provider: string | null;
  model: string | null;
  expertSlug: string | null;
  toolName: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number | null;
  costMicrousd: bigint;
  billableMetric: string;
  billableUnits: number;
};

function aggregateRows(
  rows: SummaryEvent[],
  key: (row: SummaryEvent) => string,
) {
  const groups = new Map<
    string,
    {
      key: string;
      events: number;
      inputTokens: number;
      outputTokens: number;
      billableUnits: number;
      costMicrousd: bigint;
      totalLatencyMs: number;
      latencySamples: number;
    }
  >();

  for (const row of rows) {
    const groupKey = key(row);
    const current = groups.get(groupKey) ?? {
      key: groupKey,
      events: 0,
      inputTokens: 0,
      outputTokens: 0,
      billableUnits: 0,
      costMicrousd: 0n,
      totalLatencyMs: 0,
      latencySamples: 0,
    };
    current.events += 1;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.billableUnits += row.billableUnits;
    current.costMicrousd += row.costMicrousd;
    if (row.latencyMs !== null) {
      current.totalLatencyMs += row.latencyMs;
      current.latencySamples += 1;
    }
    groups.set(groupKey, current);
  }

  return [...groups.values()]
    .sort((left, right) => {
      if (left.costMicrousd !== right.costMicrousd) {
        return left.costMicrousd > right.costMicrousd ? -1 : 1;
      }
      return left.key.localeCompare(right.key);
    })
    .map((group) => {
      const totalTokens = group.inputTokens + group.outputTokens;
      return {
        key: group.key,
        events: group.events,
        inputTokens: group.inputTokens,
        outputTokens: group.outputTokens,
        billableUnits: group.billableUnits,
        cost: amountObject(group.costMicrousd),
        averageLatencyMs:
          group.latencySamples === 0
            ? null
            : Math.round(
                (group.totalLatencyMs / group.latencySamples) * 1000,
              ) / 1000,
        costPer1kTokensUsd:
          totalTokens === 0
            ? null
            : (Number(group.costMicrousd) / 1_000_000 / totalTokens) * 1000,
      };
    });
}

export async function getUsageSummary(options: {
  tenantId: string;
  from: Date;
  to: Date;
}) {
  if (options.from.getTime() >= options.to.getTime()) {
    throw new Error("summary end must be after start");
  }
  const events: SummaryEvent[] = await db.usageEvent.findMany({
    where: {
      tenantId: options.tenantId,
      occurredAt: { gte: options.from, lt: options.to },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    select: {
      category: true,
      provider: true,
      model: true,
      expertSlug: true,
      toolName: true,
      inputTokens: true,
      outputTokens: true,
      latencyMs: true,
      costMicrousd: true,
      billableMetric: true,
      billableUnits: true,
    },
  });

  const totalCost = events.reduce(
    (sum, event) => sum + event.costMicrousd,
    0n,
  );
  const inputTokens = events.reduce((sum, event) => sum + event.inputTokens, 0);
  const outputTokens = events.reduce(
    (sum, event) => sum + event.outputTokens,
    0,
  );
  const billableUnits = events.reduce(
    (sum, event) => sum + event.billableUnits,
    0,
  );

  return {
    contractVersion: USAGE_LEDGER_CONTRACT_VERSION,
    period: {
      from: options.from.toISOString(),
      to: options.to.toISOString(),
    },
    totals: {
      events: events.length,
      inputTokens,
      outputTokens,
      billableUnits,
      cost: amountObject(totalCost),
      costPer1kTokensUsd:
        inputTokens + outputTokens === 0
          ? null
          : (Number(totalCost) /
              1_000_000 /
              (inputTokens + outputTokens)) *
            1000,
    },
    byCategory: aggregateRows(events, (event) => event.category),
    byProviderModel: aggregateRows(
      events,
      (event) =>
        (event.provider ?? "unknown-provider") +
        "/" +
        (event.model ?? "unknown-model"),
    ),
    byExpert: aggregateRows(
      events,
      (event) => event.expertSlug ?? "unattributed",
    ),
    byTool: aggregateRows(events, (event) => event.toolName ?? "none"),
    byBillableMetric: aggregateRows(events, (event) => event.billableMetric),
  };
}
