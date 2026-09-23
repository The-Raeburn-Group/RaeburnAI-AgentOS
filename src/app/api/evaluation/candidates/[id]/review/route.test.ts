import { afterEach, describe, expect, it, vi } from "vitest";
import { EvaluationCandidateError } from "@/lib/evaluation-candidates";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireHumanPermission: vi.fn(),
  requireHumanTenant: vi.fn(),
  reviewEvaluationCandidate: vi.fn(),
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

vi.mock("@/lib/evaluation-candidates", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/evaluation-candidates")>();
  return {
    ...actual,
    reviewEvaluationCandidate: mocks.reviewEvaluationCandidate,
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("evaluation candidate review API", () => {
  it("requires evaluation.review and forwards tenant-bound reviewer context", async () => {
    mocks.requireHumanPermission.mockResolvedValue({
      actorId: "reviewer-1",
      tenantId: "tenant-a",
      roles: ["approver"],
    });
    mocks.requireHumanTenant.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
      name: "Tenant A",
    });
    mocks.reviewEvaluationCandidate.mockResolvedValue({
      id: "candidate-1",
      status: "REJECTED",
    });

    const response = await POST(
      new Request(
        "http://localhost:3000/api/evaluation/candidates/candidate-1/review",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": "review-request",
          },
          body: JSON.stringify({
            decision: "reject",
            note: "Reviewed and rejected.",
          }),
        },
      ),
      { params: Promise.resolve({ id: "candidate-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.requireHumanPermission).toHaveBeenCalledWith(
      "evaluation.review",
    );
    expect(mocks.reviewEvaluationCandidate).toHaveBeenCalledWith(
      "candidate-1",
      { decision: "reject", note: "Reviewed and rejected." },
      {
        tenantReference: "tenant-a",
        actorId: "reviewer-1",
        requestId: "review-request",
      },
    );
  });

  it("maps stale concurrent review conflicts to HTTP 409", async () => {
    mocks.requireHumanPermission.mockResolvedValue({
      actorId: "reviewer-1",
      tenantId: "tenant-a",
      roles: ["approver"],
    });
    mocks.requireHumanTenant.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
      name: "Tenant A",
    });
    mocks.reviewEvaluationCandidate.mockRejectedValue(
      new EvaluationCandidateError("candidate_review_conflict"),
    );

    const response = await POST(
      new Request(
        "http://localhost:3000/api/evaluation/candidates/candidate-1/review",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            decision: "reject",
            note: "Concurrent decision.",
          }),
        },
      ),
      { params: Promise.resolve({ id: "candidate-1" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "candidate_review_conflict",
    });
  });
});
