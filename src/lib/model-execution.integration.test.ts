import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "@/lib/db";
import {
  estimateModelCostMicrousd,
  estimateTokenUpperBound,
  executeGovernedModelCall,
} from "@/lib/model-execution";
import { setBudgetPolicy, UsageLedgerError } from "@/lib/usage-ledger";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tenantId = "governed-model-execution-tenant";

async function clean() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

async function seedTenant() {
  await clean();
  await db.tenant.create({
    data: {
      id: tenantId,
      slug: tenantId,
      name: "Governed model execution tenant",
    },
  });
}

describeWithDatabase("governed model execution", () => {
  beforeEach(seedTenant);
  afterAll(clean);

  it("records model usage even when no budget policy is configured", async () => {
    const generate = vi.fn(async () => ({
      text: "ok",
      provider: "ollama",
      model: "test-model",
      promptTokens: 10,
      completionTokens: 5,
      tokens: 15,
    }));

    const result = await executeGovernedModelCall({
      tenantId,
      actorId: "requester",
      requestId: "model-request-0001",
      runId: "run-unreserved",
      taskId: "task-unreserved",
      expertSlug: "expert-a",
      provider: "ollama",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      generate,
      costResolver: () => ({
        modelRegistryId: "test.registry.model",
        unitCostMicrousdPer1k: 1_000,
      }),
    });

    expect(result.costMicrousd).toBe(15);
    expect(result.budgetBreached).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);

    const event = await db.usageEvent.findUniqueOrThrow({
      where: { id: result.usageEventId },
    });
    expect(event.reservationId).toBeNull();
    expect(event.requestId).toBe("model-request-0001");
    expect(event.runId).toBe("run-unreserved");
    expect(event.expertSlug).toBe("expert-a");
    expect(event.inputTokens).toBe(10);
    expect(event.outputTokens).toBe(5);
    expect(event.costMicrousd).toBe(15n);
    expect(event.modelRegistryId).toBe("test.registry.model");
  });

  it("reserves before dispatch and commits actual metered cost under hard budgets", async () => {
    await setBudgetPolicy({
      tenantId,
      actorId: "finance",
      policy: {
        monthlyLimitMicrousd: 10_000,
        perRequestLimitMicrousd: 5_000,
        warningRatio: 0.8,
        enforcementMode: "hard",
        fallbackMode: "block",
      },
    });
    const generate = vi.fn(async () => ({
      text: '{"decision":"ok"}',
      provider: "ollama",
      model: "test-model",
      promptTokens: 12,
      completionTokens: 8,
      tokens: 20,
    }));

    const result = await executeGovernedModelCall({
      tenantId,
      actorId: "requester",
      requestId: "model-request-0002",
      runId: "run-budgeted",
      taskId: "task-budgeted",
      expertSlug: "expert-a",
      provider: "ollama",
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      responseFormat: "json",
      generate,
      costResolver: () => ({
        modelRegistryId: "test.registry.model",
        unitCostMicrousdPer1k: 1_000,
      }),
    });

    expect(result.costMicrousd).toBe(20);
    const reservation = await db.spendReservation.findFirstOrThrow({
      where: { tenantId, requestId: "model-request-0002" },
    });
    expect(reservation.status).toBe("COMMITTED");
    expect(reservation.estimatedCostMicrousd).toBeGreaterThan(
      reservation.committedCostMicrousd ?? 0n,
    );
    expect(reservation.committedCostMicrousd).toBe(20n);
    expect(
      await db.usageEvent.count({
        where: {
          tenantId,
          reservationId: reservation.id,
          id: result.usageEventId,
        },
      }),
    ).toBe(1);
  });

  it("blocks before provider dispatch when a hard budget lacks trusted price evidence", async () => {
    await setBudgetPolicy({
      tenantId,
      actorId: "finance",
      policy: {
        monthlyLimitMicrousd: 10_000,
        perRequestLimitMicrousd: 5_000,
        enforcementMode: "hard",
        fallbackMode: "block",
      },
    });
    const generate = vi.fn(async () => ({
      text: "must not run",
      provider: "ollama",
      model: "unknown-model",
    }));

    await expect(
      executeGovernedModelCall({
        tenantId,
        actorId: "requester",
        requestId: "model-request-0003",
        taskId: "task-no-price",
        provider: "ollama",
        model: "unknown-model",
        messages: [{ role: "user", content: "hello" }],
        generate,
        costResolver: () => null,
      }),
    ).rejects.toMatchObject<Partial<UsageLedgerError>>({
      code: "cost_evidence_missing",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(
      await db.spendReservation.count({ where: { tenantId } }),
    ).toBe(0);
  });

  it("releases a reservation when provider execution fails", async () => {
    await setBudgetPolicy({
      tenantId,
      actorId: "finance",
      policy: {
        monthlyLimitMicrousd: 10_000,
        perRequestLimitMicrousd: 5_000,
        enforcementMode: "hard",
        fallbackMode: "block",
      },
    });

    await expect(
      executeGovernedModelCall({
        tenantId,
        actorId: "requester",
        requestId: "model-request-0004",
        taskId: "task-provider-failure",
        provider: "ollama",
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        generate: vi.fn(async () => {
          throw new Error("synthetic provider failure");
        }),
        costResolver: () => ({
          modelRegistryId: "test.registry.model",
          unitCostMicrousdPer1k: 1_000,
        }),
      }),
    ).rejects.toThrow("synthetic provider failure");

    const reservation = await db.spendReservation.findFirstOrThrow({
      where: { tenantId, requestId: "model-request-0004" },
    });
    expect(reservation.status).toBe("RELEASED");
    expect(
      await db.usageEvent.count({ where: { tenantId } }),
    ).toBe(0);
  });

  it("uses UTF-8 bytes as a conservative input-token upper bound and exact rounded-up cost", () => {
    expect(
      estimateTokenUpperBound(
        [{ role: "user", content: "£" }],
        10,
      ),
    ).toBe(12);
    expect(estimateModelCostMicrousd(1, 1)).toBe(1);
    expect(estimateModelCostMicrousd(1_001, 1_000)).toBe(1_001);
  });
});
