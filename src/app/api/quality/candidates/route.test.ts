import { afterEach, describe, expect, it, vi } from "vitest";
import { DatasetAdmissibilityError } from "@/lib/dataset-provenance";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  review: vi.fn(),
  promote: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { evaluationCandidate: { findMany: mocks.findMany } },
}));

vi.mock("@/lib/quality-loop", () => ({
  QualityLoopError: class QualityLoopError extends Error {
    constructor(public readonly code: string) {
      super(code);
    }
  },
  reviewEvaluationCandidate: mocks.review,
  promoteEvaluationCandidate: mocks.promote,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function headers(roles = "quality-reviewer") {
  return {
    authorization: "Bearer quality-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "reviewer-a",
    "x-request-id": "quality-request-1",
    "x-roles": roles,
    "content-type": "application/json",
  };
}

describe("quality candidate API", () => {
  it("requires an explicit quality operations role", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "quality-test-token");
    const response = await GET(
      new Request("http://localhost:3000/api/quality/candidates", {
        headers: headers("reader"),
      }),
    );
    expect(response.status).toBe(403);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("lists only tenant-scoped pending candidates", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "quality-test-token");
    mocks.findMany.mockResolvedValue([
      { id: "candidate-1", status: "PENDING_REVIEW" },
    ]);

    const response = await GET(
      new Request("http://localhost:3000/api/quality/candidates", {
        headers: headers(),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-a",
          status: "PENDING_REVIEW",
        }),
        take: 100,
      }),
    );
  });

  it("allows accepted candidates to be rediscovered explicitly", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "quality-test-token");
    mocks.findMany.mockResolvedValue([
      { id: "candidate-accepted", status: "ACCEPTED" },
    ]);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/quality/candidates?status=ACCEPTED",
        { headers: headers() },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: "tenant-a",
          status: "ACCEPTED",
        },
      }),
    );
  });

  it("maps inadmissible promotion records to a stable client error", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "quality-test-token");
    mocks.promote.mockRejectedValue(
      new DatasetAdmissibilityError("purpose_not_permitted"),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/quality/candidates", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          action: "promote",
          candidateId: "11111111-1111-4111-8111-111111111111",
          record: {},
        }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "purpose_not_permitted",
    });
  });

  it("routes review commands through the authenticated reviewer identity", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "quality-test-token");
    mocks.review.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      status: "ACCEPTED",
      reviewedAt: new Date("2026-09-23T12:00:00.000Z"),
      promotedAt: null,
    });

    const response = await POST(
      new Request("http://localhost:3000/api/quality/candidates", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          action: "review",
          candidateId: "11111111-1111-4111-8111-111111111111",
          decision: "accept",
          note: "good regression candidate",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.review).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      candidateId: "11111111-1111-4111-8111-111111111111",
      reviewer: "reviewer-a",
      decision: "accept",
      note: "good regression candidate",
    });
  });
});
