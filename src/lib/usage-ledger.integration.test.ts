import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  UsageLedgerError,
  commitSpend,
  getBudgetSnapshot,
  getUsageSummary,
  releaseSpend,
  reserveSpend,
  setBudgetPolicy,
} from "@/lib/usage-ledger";

const prefix = "finops-test-";

async function clean() {
  await db.tenant.deleteMany({ where: { id: { startsWith: prefix } } });
}

async function tenant(suffix: string) {
  const id = prefix + suffix;
  await db.tenant.deleteMany({ where: { id } });
  await db.tenant.create({
    data: { id, slug: id, name: "FinOps " + suffix },
  });
  return id;
}

async function policy(
  tenantId: string,
  overrides: Record<string, unknown> = {},
) {
  return setBudgetPolicy({
    tenantId,
    actorId: "finops-admin",
    policy: {
      monthlyLimitMicrousd: 1_000_000,
      perRequestLimitMicrousd: 700_000,
      warningRatio: 0.8,
      enforcementMode: "hard",
      fallbackMode: "block",
      ...overrides,
    },
  });
}

function commitInput(options: {
  tenantId: string;
  reservationId: string;
  idempotencyKey: string;
  cost: number;
  occurredAt?: string;
}) {
  return {
    tenantId: options.tenantId,
    reservationId: options.reservationId,
    idempotencyKey: options.idempotencyKey,
    actorId: "router-service",
    category: "model",
    provider: "ollama",
    model: "llama3.1",
    modelRegistryId: "ollama:llama3.1:configured",
    expertSlug: "raeburn-general-reasoning",
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 1200,
    actualCostMicrousd: options.cost,
    billableMetric: "model_request",
    billableUnits: 1,
    metadata: { test: true },
    occurredAt: options.occurredAt ?? "2026-09-24T12:00:00.000Z",
  };
}

describe("durable usage metering and budgets", () => {
  afterAll(clean);

  it("reserves and commits spend idempotently with immutable event evidence", async () => {
    const tenantId = await tenant("idempotency");
    await policy(tenantId);
    const now = new Date("2026-09-24T11:59:00.000Z");

    const first = await reserveSpend(
      {
        tenantId,
        actorId: "router-service",
        requestId: "request-1",
        idempotencyKey: "reserve-request-1",
        estimatedCostMicrousd: 400_000,
        ttlSeconds: 300,
      },
      now,
    );
    const replay = await reserveSpend(
      {
        tenantId,
        actorId: "router-service",
        requestId: "request-1",
        idempotencyKey: "reserve-request-1",
        estimatedCostMicrousd: 400_000,
        ttlSeconds: 300,
      },
      now,
    );
    expect(replay.idempotent).toBe(true);
    expect(replay.reservation.id).toBe(first.reservation.id);

    await expect(
      reserveSpend(
        {
          tenantId,
          actorId: "router-service",
          requestId: "request-1",
          idempotencyKey: "reserve-request-1",
          estimatedCostMicrousd: 450_000,
          ttlSeconds: 300,
        },
        now,
      ),
    ).rejects.toMatchObject<Partial<UsageLedgerError>>({
      code: "idempotency_conflict",
    });

    const committed = await commitSpend(
      commitInput({
        tenantId,
        reservationId: first.reservation.id,
        idempotencyKey: "usage-request-1",
        cost: 350_000,
      }),
      new Date("2026-09-24T12:00:01.000Z"),
    );
    expect(committed).toMatchObject({
      idempotent: false,
      budgetBreached: false,
      overReservation: false,
    });
    expect(committed.event.eventDigest).toMatch(/^[a-f0-9]{64}$/);

    const repeated = await commitSpend(
      commitInput({
        tenantId,
        reservationId: first.reservation.id,
        idempotencyKey: "usage-request-1",
        cost: 350_000,
      }),
      new Date("2026-09-24T12:00:02.000Z"),
    );
    expect(repeated.idempotent).toBe(true);
    expect(repeated.event.id).toBe(committed.event.id);

    await expect(
      commitSpend(
        commitInput({
          tenantId,
          reservationId: first.reservation.id,
          idempotencyKey: "usage-request-1",
          cost: 360_000,
        }),
      ),
    ).rejects.toMatchObject<Partial<UsageLedgerError>>({
      code: "idempotency_conflict",
    });

    const snapshot = await getBudgetSnapshot(
      tenantId,
      new Date("2026-09-24T12:01:00.000Z"),
    );
    expect(snapshot.spentMicrousd).toBe(350_000n);
    expect(snapshot.reservedMicrousd).toBe(0n);

    const summary = await getUsageSummary({
      tenantId,
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(summary.totals).toMatchObject({
      events: 1,
      inputTokens: 100,
      outputTokens: 50,
      billableUnits: 1,
    });
    expect(summary.totals.cost?.microusd).toBe("350000");
    expect(summary.byProviderModel[0]).toMatchObject({
      key: "ollama/llama3.1",
      events: 1,
    });
  });

  it("serializes concurrent reservations so a hard monthly budget cannot be oversubscribed", async () => {
    const tenantId = await tenant("concurrency");
    await policy(tenantId);
    const now = new Date("2026-09-24T12:00:00.000Z");

    const outcomes = await Promise.allSettled([
      reserveSpend(
        {
          tenantId,
          actorId: "router-a",
          requestId: "request-a",
          idempotencyKey: "reserve-concurrent-a",
          estimatedCostMicrousd: 600_000,
        },
        now,
      ),
      reserveSpend(
        {
          tenantId,
          actorId: "router-b",
          requestId: "request-b",
          idempotencyKey: "reserve-concurrent-b",
          estimatedCostMicrousd: 600_000,
        },
        now,
      ),
    ]);

    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(
      1,
    );
    const rejected = outcomes.find((item) => item.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "budget_exceeded" },
    });

    const deniedAudit = await db.auditEvent.count({
      where: {
        tenantId,
        action: "usage.spend_reservation.denied",
      },
    });
    expect(deniedAudit).toBe(1);
  });

  it("releases unused reservations so capacity becomes available again", async () => {
    const tenantId = await tenant("release");
    await policy(tenantId);
    const now = new Date("2026-09-24T12:00:00.000Z");
    const first = await reserveSpend(
      {
        tenantId,
        actorId: "router",
        requestId: "request-a",
        idempotencyKey: "reserve-release-a",
        estimatedCostMicrousd: 600_000,
      },
      now,
    );

    await expect(
      reserveSpend(
        {
          tenantId,
          actorId: "router",
          requestId: "request-b",
          idempotencyKey: "reserve-release-b",
          estimatedCostMicrousd: 500_000,
        },
        now,
      ),
    ).rejects.toMatchObject({ code: "budget_exceeded" });

    await releaseSpend({
      tenantId,
      reservationId: first.reservation.id,
      actorId: "router",
      reason: "provider call cancelled before dispatch",
    });

    const second = await reserveSpend(
      {
        tenantId,
        actorId: "router",
        requestId: "request-b",
        idempotencyKey: "reserve-release-b",
        estimatedCostMicrousd: 500_000,
      },
      now,
    );
    expect(second.reservation.status).toBe("RESERVED");
  });

  it("persists expiry state before rejecting a stale reservation", async () => {
    const tenantId = await tenant("expiry");
    await policy(tenantId);
    const start = new Date("2026-09-24T12:00:00.000Z");
    const reservation = await reserveSpend(
      {
        tenantId,
        actorId: "router",
        requestId: "request-expired",
        idempotencyKey: "reserve-expired-1",
        estimatedCostMicrousd: 100_000,
        ttlSeconds: 30,
      },
      start,
    );

    await expect(
      commitSpend(
        commitInput({
          tenantId,
          reservationId: reservation.reservation.id,
          idempotencyKey: "usage-expired-1",
          cost: 90_000,
          occurredAt: "2026-09-24T12:00:31.000Z",
        }),
        new Date("2026-09-24T12:00:31.000Z"),
      ),
    ).rejects.toMatchObject({ code: "reservation_expired" });

    const stored = await db.spendReservation.findUniqueOrThrow({
      where: { id: reservation.reservation.id },
    });
    expect(stored.status).toBe("EXPIRED");
  });

  it("persists and rejects an idempotent reservation replay after expiry", async () => {
    const tenantId = await tenant("expired-replay");
    await policy(tenantId);
    const start = new Date("2026-09-24T12:00:00.000Z");
    const first = await reserveSpend(
      {
        tenantId,
        actorId: "router",
        requestId: "request-expired-replay",
        idempotencyKey: "reserve-expired-replay",
        estimatedCostMicrousd: 100_000,
        ttlSeconds: 30,
      },
      start,
    );

    await expect(
      reserveSpend(
        {
          tenantId,
          actorId: "router",
          requestId: "request-expired-replay",
          idempotencyKey: "reserve-expired-replay",
          estimatedCostMicrousd: 100_000,
          ttlSeconds: 30,
        },
        new Date("2026-09-24T12:00:31.000Z"),
      ),
    ).rejects.toMatchObject({ code: "reservation_expired" });

    const stored = await db.spendReservation.findUniqueOrThrow({
      where: { id: first.reservation.id },
    });
    expect(stored.status).toBe("EXPIRED");
  });

  it("records actual overage truthfully even when the reservation estimate was too low", async () => {
    const tenantId = await tenant("overage");
    await policy(tenantId);
    const reservation = await reserveSpend(
      {
        tenantId,
        actorId: "router",
        requestId: "request-overage",
        idempotencyKey: "reserve-overage-1",
        estimatedCostMicrousd: 400_000,
      },
      new Date("2026-09-24T12:00:00.000Z"),
    );

    const result = await commitSpend(
      commitInput({
        tenantId,
        reservationId: reservation.reservation.id,
        idempotencyKey: "usage-overage-1",
        cost: 1_100_000,
      }),
      new Date("2026-09-24T12:00:01.000Z"),
    );
    expect(result.overReservation).toBe(true);
    expect(result.budgetBreached).toBe(true);

    const audit = await db.auditEvent.findFirstOrThrow({
      where: {
        tenantId,
        action: "usage.event.committed",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.metadata).toMatchObject({
      overReservation: true,
      budgetBreached: true,
    });
  });

  it("allows monitor-only budget overruns but returns an explicit warning", async () => {
    const tenantId = await tenant("monitor");
    await policy(tenantId, {
      enforcementMode: "monitor",
      monthlyLimitMicrousd: 500_000,
      perRequestLimitMicrousd: 500_000,
    });

    const reservation = await reserveSpend(
      {
        tenantId,
        actorId: "router",
        requestId: "request-monitor",
        idempotencyKey: "reserve-monitor-1",
        estimatedCostMicrousd: 600_000,
      },
      new Date("2026-09-24T12:00:00.000Z"),
    );
    expect(reservation.warning).toBe(true);
    expect(reservation.reasons).toContain(
      "estimated request cost exceeds per-request budget",
    );
  });

  it("keeps budgets and usage strictly tenant-scoped", async () => {
    const tenantA = await tenant("tenant-a");
    const tenantB = await tenant("tenant-b");
    await policy(tenantA);
    await policy(tenantB);

    const reservation = await reserveSpend(
      {
        tenantId: tenantA,
        actorId: "router",
        requestId: "request-a",
        idempotencyKey: "reserve-tenant-a",
        estimatedCostMicrousd: 250_000,
      },
      new Date("2026-09-24T12:00:00.000Z"),
    );
    await commitSpend(
      commitInput({
        tenantId: tenantA,
        reservationId: reservation.reservation.id,
        idempotencyKey: "usage-tenant-a",
        cost: 200_000,
      }),
    );

    const snapshotA = await getBudgetSnapshot(
      tenantA,
      new Date("2026-09-24T12:01:00.000Z"),
    );
    const snapshotB = await getBudgetSnapshot(
      tenantB,
      new Date("2026-09-24T12:01:00.000Z"),
    );
    expect(snapshotA.spentMicrousd).toBe(200_000n);
    expect(snapshotB.spentMicrousd).toBe(0n);
  });
});
