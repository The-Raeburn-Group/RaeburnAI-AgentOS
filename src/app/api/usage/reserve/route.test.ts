import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageLedgerError } from "@/lib/usage-ledger";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  reserveSpend: vi.fn(),
}));

vi.mock("@/lib/usage-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/usage-ledger")>();
  return {
    ...actual,
    reserveSpend: mocks.reserveSpend,
  };
});

function headers() {
  return {
    authorization: "Bearer usage-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "router-a",
    "x-request-id": "request-a",
    "content-type": "application/json",
  };
}

function reservation() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant-a",
    idempotencyKey: "reserve-test-1",
    payloadHash: "a".repeat(64),
    requestId: "request-a",
    actorId: "router-a",
    estimatedCostMicrousd: 250_000n,
    committedCostMicrousd: null,
    status: "RESERVED",
    policyVersion: 3,
    warning: false,
    decisionReasons: [],
    expiresAt: new Date("2026-09-24T13:05:00.000Z"),
    createdAt: new Date("2026-09-24T13:00:00.000Z"),
    updatedAt: new Date("2026-09-24T13:00:00.000Z"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("usage reservation API", () => {
  it("requires configured service authentication", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");
    const response = await POST(
      new Request("http://localhost:3000/api/usage/reserve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          idempotencyKey: "reserve-test-1",
          estimatedCostMicrousd: 250_000,
        }),
      }),
    );
    expect(response.status).toBe(503);
    expect(mocks.reserveSpend).not.toHaveBeenCalled();
  });

  it("derives tenant actor and request identity from authenticated headers", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "usage-test-token");
    mocks.reserveSpend.mockResolvedValue({
      reservation: reservation(),
      idempotent: false,
      warning: false,
      reasons: [],
    });

    const response = await POST(
      new Request("http://localhost:3000/api/usage/reserve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          idempotencyKey: "reserve-test-1",
          estimatedCostMicrousd: 250_000,
          ttlSeconds: 120,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.reserveSpend).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "router-a",
      requestId: "request-a",
      idempotencyKey: "reserve-test-1",
      estimatedCostMicrousd: 250_000,
      ttlSeconds: 120,
    });
    await expect(response.json()).resolves.toMatchObject({
      reservation: {
        id: "11111111-1111-4111-8111-111111111111",
        estimatedCostMicrousd: "250000",
        policyVersion: 3,
      },
      warning: false,
      idempotent: false,
    });
  });

  it("returns a stable conflict when the hard budget rejects a reservation", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "usage-test-token");
    mocks.reserveSpend.mockRejectedValue(
      new UsageLedgerError(
        "budget_exceeded",
        "estimated request cost exceeds remaining monthly budget",
      ),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/usage/reserve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          idempotencyKey: "reserve-test-2",
          estimatedCostMicrousd: 900_000,
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "budget_exceeded",
      detail: "estimated request cost exceeds remaining monthly budget",
    });
  });
});
