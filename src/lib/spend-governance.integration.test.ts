import {
  SpendReservationStatus,
  UsageCostBasis,
  UsageOutcome,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  beginModelSpend,
  createSpendBudget,
  getSpendSummary,
  recordFailedModelSpend,
  reserveSpendAgainstBudget,
  settleModelSpend,
  SpendGovernanceError,
  type ModelSpendGuard,
} from "@/lib/spend-governance";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const tenantA = "spend-governance-tenant-a";
const tenantB = "spend-governance-tenant-b";
const periodStart = "2026-09-01T00:00:00.000Z";
const periodEnd = "2026-10-01T00:00:00.000Z";
const now = new Date("2026-09-24T12:00:00.000Z");

async function clean() {
  await db.tenant.deleteMany({
    where: { id: { in: [tenantA, tenantB] } },
  });
}

function guard(options: {
  reservation: Awaited<ReturnType<typeof reserveSpendAgainstBudget>>;
  requestId: string;
  estimatedTokens: number;
  unitCostMicrosPer1k: bigint;
}): ModelSpendGuard {
  return {
    contractVersion: "raeburnai.spend-governance.v1",
    tenantId: tenantA,
    requestId: options.requestId,
    provider: "test-provider",
    model: "test-model",
    estimatedTokens: options.estimatedTokens,
    unitCostMicrosPer1k: options.unitCostMicrosPer1k,
    estimatedCostMicros:
      (BigInt(options.estimatedTokens) * options.unitCostMicrosPer1k + 999n) /
      1_000n,
    reservation: options.reservation,
  };
}

describeWithDatabase("durable spend governance", () => {
  beforeAll(async () => {
    await clean();
    await db.tenant.createMany({
      data: [
        { id: tenantA, slug: tenantA, name: "Spend tenant A" },
        { id: tenantB, slug: tenantB, name: "Spend tenant B" },
      ],
    });
  });

  afterAll(async () => {
    await clean();
  });

  it("serializes overlapping budget creation and keeps exactly one active period", async () => {
    const attempts = await Promise.allSettled([
      createSpendBudget({
        tenantId: tenantA,
        actorId: "finance-a",
        input: {
          name: "monthly-a",
          periodStart,
          periodEnd,
          softLimitUsd: "0.50",
          hardLimitUsd: "1.00",
        },
      }),
      createSpendBudget({
        tenantId: tenantA,
        actorId: "finance-b",
        input: {
          name: "monthly-b",
          periodStart,
          periodEnd,
          softLimitUsd: "0.50",
          hardLimitUsd: "1.00",
        },
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining<Partial<SpendGovernanceError>>({
        code: "overlapping_budget",
      }),
    });
    expect(
      await db.spendBudget.count({
        where: { tenantId: tenantA, enabled: true },
      }),
    ).toBe(1);
  });

  it("blocks governed execution when the active model has no trusted price evidence", async () => {
    await expect(
      beginModelSpend({
        tenantId: tenantA,
        requestId: "price-evidence-missing",
        actorId: "operator-a",
        provider: "ollama",
        model: "llama3.1",
        messages: [{ content: "test governed execution" }],
        now,
      }),
    ).rejects.toMatchObject<Partial<SpendGovernanceError>>({
      code: "cost_evidence_missing",
    });
  });

  it("serializes concurrent reservations so the hard budget cannot be oversubscribed", async () => {
    const budget = await db.spendBudget.findFirstOrThrow({
      where: { tenantId: tenantA, enabled: true },
    });
    const unitCostMicrosPer1k = 1_000_000n;

    const results = await Promise.allSettled([
      reserveSpendAgainstBudget({
        tenantId: tenantA,
        budgetId: budget.id,
        requestId: "race-a",
        actorId: "operator-a",
        provider: "test-provider",
        model: "test-model",
        estimatedTokens: 600,
        unitCostMicrosPer1k,
        now,
      }),
      reserveSpendAgainstBudget({
        tenantId: tenantA,
        budgetId: budget.id,
        requestId: "race-b",
        actorId: "operator-b",
        provider: "test-provider",
        model: "test-model",
        estimatedTokens: 600,
        unitCostMicrosPer1k,
        now,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof reserveSpendAgainstBudget>>
      > => result.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.objectContaining<Partial<SpendGovernanceError>>({
        code: "hard_budget_exceeded",
      }),
    });
    expect(
      await db.spendReservation.count({
        where: { tenantId: tenantA, status: SpendReservationStatus.RESERVED },
      }),
    ).toBe(1);

    const winningRequestId =
      fulfilled[0]!.value.idempotencyKey.includes("race-a")
        ? "race-a"
        : "race-b";
    const firstGuard = guard({
      reservation: fulfilled[0]!.value,
      requestId: winningRequestId,
      estimatedTokens: 600,
      unitCostMicrosPer1k,
    });
    const settled = await settleModelSpend({
      guard: firstGuard,
      actorId: "operator-a",
      totalTokens: 400,
      latencyMs: 125,
      occurredAt: new Date("2026-09-24T12:01:00.000Z"),
    });
    expect(settled.hardLimitOverrun).toBe(false);
    expect(settled.softLimitExceeded).toBe(false);
    expect(settled.ledger.actualCostMicros).toBe(400_000n);
    expect(settled.ledger.costBasis).toBe(
      UsageCostBasis.REGISTRY_ACTUAL_TOKENS,
    );
    expect(settled.ledger.outcome).toBe(UsageOutcome.SUCCEEDED);

    const replay = await settleModelSpend({
      guard: firstGuard,
      actorId: "operator-a",
      totalTokens: 400,
      latencyMs: 999,
      occurredAt: new Date("2026-09-24T12:02:00.000Z"),
    });
    expect(replay.ledger.id).toBe(settled.ledger.id);
    expect(await db.usageLedgerEntry.count({ where: { tenantId: tenantA } })).toBe(
      1,
    );

    const failedReservation = await reserveSpendAgainstBudget({
      tenantId: tenantA,
      budgetId: budget.id,
      requestId: "failed-call",
      actorId: "operator-a",
      provider: "test-provider",
      model: "test-model",
      estimatedTokens: 500,
      unitCostMicrosPer1k,
      now,
    });
    const failedLedger = await recordFailedModelSpend({
      guard: guard({
        reservation: failedReservation,
        requestId: "failed-call",
        estimatedTokens: 500,
        unitCostMicrosPer1k,
      }),
      actorId: "operator-a",
      latencyMs: 77,
      reason: "synthetic upstream timeout",
      occurredAt: new Date("2026-09-24T12:03:00.000Z"),
    });
    expect(failedLedger.outcome).toBe(UsageOutcome.FAILED);
    expect(failedLedger.actualCostMicros).toBeNull();
    expect(failedLedger.estimatedCostMicros).toBe(500_000n);
    expect(failedLedger.costBasis).toBe(
      UsageCostBasis.REGISTRY_RESERVED_ESTIMATE,
    );

    const summary = await getSpendSummary({
      tenantId: tenantA,
      from: new Date(periodStart),
      to: new Date(periodEnd),
    });
    expect(summary.calls).toBe(2);
    expect(summary.meteredTokenCalls).toBe(1);
    expect(summary.totalTokens).toBe(400);
    expect(summary.actualCostMicros).toBe("400000");
    expect(summary.estimatedCostMicros).toBe("1100000");
    expect(summary.unknownActualCostCalls).toBe(1);
  });

  it("records a post-call hard-limit overrun instead of silently hiding it", async () => {
    const budget = await createSpendBudget({
      tenantId: tenantB,
      actorId: "finance-b",
      input: {
        name: "monthly",
        periodStart,
        periodEnd,
        softLimitUsd: "0.50",
        hardLimitUsd: "1.00",
      },
    });
    const unitCostMicrosPer1k = 1_000_000n;
    const reservation = await reserveSpendAgainstBudget({
      tenantId: tenantB,
      budgetId: budget.id,
      requestId: "overrun",
      actorId: "operator-b",
      provider: "test-provider",
      model: "test-model",
      estimatedTokens: 400,
      unitCostMicrosPer1k,
      now,
    });
    const overrunGuard: ModelSpendGuard = {
      contractVersion: "raeburnai.spend-governance.v1",
      tenantId: tenantB,
      requestId: "overrun",
      provider: "test-provider",
      model: "test-model",
      estimatedTokens: 400,
      unitCostMicrosPer1k,
      estimatedCostMicros: 400_000n,
      reservation,
    };
    const result = await settleModelSpend({
      guard: overrunGuard,
      actorId: "operator-b",
      totalTokens: 1_200,
      latencyMs: 200,
      occurredAt: new Date("2026-09-24T12:04:00.000Z"),
    });
    expect(result.hardLimitOverrun).toBe(true);
    expect(result.ledger.actualCostMicros).toBe(1_200_000n);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: tenantB,
          action: "spend.hard_limit_overrun",
        },
      }),
    ).toBe(1);
  });

  it("rejects cross-tenant budget and usage references at the database boundary", async () => {
    const budgetA = await db.spendBudget.findFirstOrThrow({
      where: { tenantId: tenantA },
    });
    await expect(
      db.spendReservation.create({
        data: {
          tenantId: tenantB,
          budgetId: budgetA.id,
          idempotencyKey: "cross-tenant-reservation",
          provider: "test-provider",
          model: "test-model",
          estimatedTokens: 10,
          unitCostMicrosPer1k: 1n,
          reservedMicros: 1n,
        },
      }),
    ).rejects.toThrow();

    const reservationA = await db.spendReservation.findFirstOrThrow({
      where: { tenantId: tenantA },
    });
    await expect(
      db.usageLedgerEntry.create({
        data: {
          tenantId: tenantB,
          reservationId: reservationA.id,
          idempotencyKey: "cross-tenant-ledger",
          requestId: "cross-tenant-ledger",
          provider: "test-provider",
          model: "test-model",
          estimatedTokens: 10,
          totalTokens: 10,
          latencyMs: 1,
          unitCostMicrosPer1k: 1n,
          estimatedCostMicros: 1n,
          actualCostMicros: 1n,
          costBasis: UsageCostBasis.REGISTRY_ACTUAL_TOKENS,
          outcome: UsageOutcome.SUCCEEDED,
        },
      }),
    ).rejects.toThrow();
  });
});
