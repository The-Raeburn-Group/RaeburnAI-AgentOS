import { OptimizationExperimentStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OptimizationControlError,
} from "@/lib/optimization-control";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  createExperiment: vi.fn(),
  reviewExperiment: vi.fn(),
  promoteExperiment: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    optimizationExperiment: {
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("@/lib/optimization-control", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/optimization-control")>();
  return {
    ...actual,
    createOptimizationExperiment: mocks.createExperiment,
    reviewOptimizationExperiment: mocks.reviewExperiment,
    promoteOptimizationExperiment: mocks.promoteExperiment,
  };
});

function headers(roles: string) {
  return {
    authorization: "Bearer optimization-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "reviewer-a",
    "x-request-id": "optimization-request-1",
    "x-roles": roles,
    "content-type": "application/json",
  };
}

function experiment(
  status: OptimizationExperimentStatus = OptimizationExperimentStatus.EVALUATED,
) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "tenant-a",
    baselineAgentId: "22222222-2222-4222-8222-222222222222",
    challengerAgentId: "33333333-3333-4333-8333-333333333333",
    baselineManifestDigest: "a".repeat(64),
    challengerManifestDigest: "b".repeat(64),
    artifactDigest: "c".repeat(64),
    policy: {},
    evidence: {},
    result: { eligible: true },
    status,
    createdBy: "reviewer-a",
    reviewedBy: null,
    reviewNote: null,
    reviewedAt: null,
    promotedAt: null,
    createdAt: new Date("2026-09-24T09:00:00.000Z"),
    updatedAt: new Date("2026-09-24T09:00:00.000Z"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("optimization experiment API", () => {
  it("requires an authorized optimization role to list experiments", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "optimization-test-token");
    const response = await GET(
      new Request("http://localhost:3000/api/optimization/experiments", {
        headers: headers("reader"),
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("lists tenant-scoped experiments and supports a status filter", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "optimization-test-token");
    mocks.findMany.mockResolvedValue([experiment()]);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/optimization/experiments?status=EVALUATED",
        { headers: headers("quality-reviewer") },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: "tenant-a",
          status: OptimizationExperimentStatus.EVALUATED,
        },
        take: 100,
      }),
    );
  });

  it("routes evaluation through the authenticated actor and tenant", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "optimization-test-token");
    mocks.createExperiment.mockResolvedValue(experiment());

    const response = await POST(
      new Request("http://localhost:3000/api/optimization/experiments", {
        method: "POST",
        headers: headers("operator"),
        body: JSON.stringify({
          action: "evaluate",
          baselineAgentId: "22222222-2222-4222-8222-222222222222",
          challengerAgentId: "33333333-3333-4333-8333-333333333333",
          evidence: { baseline: {}, challenger: {} },
        }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.createExperiment).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      baselineAgentId: "22222222-2222-4222-8222-222222222222",
      challengerAgentId: "33333333-3333-4333-8333-333333333333",
      createdBy: "reviewer-a",
      evidence: { baseline: {}, challenger: {} },
    });
  });

  it("requires a review role for approval", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "optimization-test-token");

    const response = await POST(
      new Request("http://localhost:3000/api/optimization/experiments", {
        method: "POST",
        headers: headers("operator"),
        body: JSON.stringify({
          action: "review",
          experimentId: "11111111-1111-4111-8111-111111111111",
          decision: "approve",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.reviewExperiment).not.toHaveBeenCalled();
  });

  it("requires admin or human approver authority for promotion", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "optimization-test-token");

    const response = await POST(
      new Request("http://localhost:3000/api/optimization/experiments", {
        method: "POST",
        headers: headers("quality-reviewer"),
        body: JSON.stringify({
          action: "promote",
          experimentId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.promoteExperiment).not.toHaveBeenCalled();
  });

  it("maps ineligible evidence to a stable 422 response", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "optimization-test-token");
    mocks.reviewExperiment.mockRejectedValue(
      new OptimizationControlError("experiment_not_eligible"),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/optimization/experiments", {
        method: "POST",
        headers: headers("human-approver"),
        body: JSON.stringify({
          action: "review",
          experimentId: "11111111-1111-4111-8111-111111111111",
          decision: "approve",
        }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "experiment_not_eligible",
    });
  });
});
