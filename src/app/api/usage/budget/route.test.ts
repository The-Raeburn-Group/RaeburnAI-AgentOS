import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HumanAuthError } from "@/lib/admin-auth";
import { GET, PUT } from "./route";

const mocks = vi.hoisted(() => ({
  requireHumanPermission: vi.fn(),
  requireHumanTenant: vi.fn(),
  setBudgetPolicy: vi.fn(),
  getBudgetSnapshot: vi.fn(),
}));

vi.mock("@/lib/admin-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return {
    ...actual,
    requireHumanPermission: mocks.requireHumanPermission,
  };
});

vi.mock("@/lib/human-tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/human-tenant")>();
  return {
    ...actual,
    requireHumanTenant: mocks.requireHumanTenant,
  };
});

vi.mock("@/lib/usage-ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/usage-ledger")>();
  return {
    ...actual,
    setBudgetPolicy: mocks.setBudgetPolicy,
    getBudgetSnapshot: mocks.getBudgetSnapshot,
  };
});

function identity() {
  return {
    actorId: "finops-admin",
    tenantId: "tenant-a",
    roles: ["admin"] as const,
  };
}

function tenant() {
  return { id: "tenant-a", slug: "tenant-a", name: "Tenant A" };
}

function storedPolicy() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant-a",
    currency: "USD",
    monthlyLimitMicrousd: 2_000_000n,
    perRequestLimitMicrousd: 500_000n,
    warningRatio: 0.8,
    enforcementMode: "hard",
    fallbackMode: "block",
    version: 2,
    createdAt: new Date("2026-09-24T12:00:00.000Z"),
    updatedAt: new Date("2026-09-24T12:00:00.000Z"),
  };
}

function snapshot() {
  return {
    contractVersion: "raeburnai.budget-policy.v1" as const,
    policy: storedPolicy(),
    period: {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    },
    eventCount: 2,
    activeReservationCount: 1,
    spentMicrousd: 400_000n,
    reservedMicrousd: 200_000n,
    committedAndReservedMicrousd: 600_000n,
    remainingMicrousd: 1_400_000n,
    utilizationRatio: 0.3,
    warning: false,
    breached: false,
  };
}

beforeEach(() => {
  mocks.requireHumanPermission.mockResolvedValue(identity());
  mocks.requireHumanTenant.mockResolvedValue(tenant());
  mocks.setBudgetPolicy.mockResolvedValue(storedPolicy());
  mocks.getBudgetSnapshot.mockResolvedValue(snapshot());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("usage budget API", () => {
  it("requires metrics permission to read the authenticated tenant budget", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.requireHumanPermission).toHaveBeenCalledWith("metrics.read");
    expect(mocks.requireHumanTenant).toHaveBeenCalledWith(identity());
    expect(mocks.getBudgetSnapshot).toHaveBeenCalledWith("tenant-a");
    await expect(response.json()).resolves.toMatchObject({
      policy: {
        version: 2,
        monthlyLimit: { microusd: "2000000", usd: 2 },
      },
      spent: { microusd: "400000", usd: 0.4 },
    });
  });

  it("binds budget updates to the authenticated tenant and actor", async () => {
    const response = await PUT(
      new Request("http://localhost:3000/api/usage/budget", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currency: "USD",
          monthlyLimitMicrousd: 2_000_000,
          perRequestLimitMicrousd: 500_000,
          warningRatio: 0.8,
          enforcementMode: "hard",
          fallbackMode: "block",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.requireHumanPermission).toHaveBeenCalledWith("settings.write");
    expect(mocks.setBudgetPolicy).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "finops-admin",
      policy: {
        currency: "USD",
        monthlyLimitMicrousd: 2_000_000,
        perRequestLimitMicrousd: 500_000,
        warningRatio: 0.8,
        enforcementMode: "hard",
        fallbackMode: "block",
      },
    });
  });

  it("denies an unauthenticated human before resolving tenant state", async () => {
    mocks.requireHumanPermission.mockRejectedValue(
      new HumanAuthError("unauthenticated"),
    );

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.requireHumanTenant).not.toHaveBeenCalled();
    expect(mocks.getBudgetSnapshot).not.toHaveBeenCalled();
  });
});
