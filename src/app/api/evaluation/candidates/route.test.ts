import { EvaluationCandidateStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireHumanPermission: vi.fn(),
  requireHumanTenant: vi.fn(),
  listEvaluationCandidates: vi.fn(),
  captureEvaluationCandidate: vi.fn(),
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
    listEvaluationCandidates: mocks.listEvaluationCandidates,
    captureEvaluationCandidate: mocks.captureEvaluationCandidate,
  };
});

function identity() {
  return {
    actorId: "quality-user",
    tenantId: "tenant-a",
    roles: ["operator"] as const,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("evaluation candidate API", () => {
  it("lists only through evaluation.read in the authenticated tenant", async () => {
    mocks.requireHumanPermission.mockResolvedValue(identity());
    mocks.requireHumanTenant.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
      name: "Tenant A",
    });
    mocks.listEvaluationCandidates.mockResolvedValue([
      {
        id: "candidate-1",
        tenantId: "tenant-a",
        status: EvaluationCandidateStatus.QUARANTINED,
      },
    ]);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/evaluation/candidates?status=quarantined&limit=25",
        { headers: { "x-request-id": "list-request" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.requireHumanPermission).toHaveBeenCalledWith(
      "evaluation.read",
    );
    expect(mocks.listEvaluationCandidates).toHaveBeenCalledWith(
      {
        tenantReference: "tenant-a",
        actorId: "quality-user",
        requestId: "list-request",
      },
      expect.objectContaining({
        status: EvaluationCandidateStatus.QUARANTINED,
        limit: 25,
      }),
    );
  });

  it("captures through evaluation.capture and preserves dedupe response semantics", async () => {
    mocks.requireHumanPermission.mockResolvedValue(identity());
    mocks.requireHumanTenant.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
      name: "Tenant A",
    });
    mocks.captureEvaluationCandidate.mockResolvedValue({
      candidate: { id: "candidate-1", tenantId: "tenant-a" },
      deduplicated: false,
    });

    const response = await POST(
      new Request("http://localhost:3000/api/evaluation/candidates", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "capture-request",
        },
        body: JSON.stringify({ trigger: "manual" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.requireHumanPermission).toHaveBeenCalledWith(
      "evaluation.capture",
    );
    expect(mocks.captureEvaluationCandidate).toHaveBeenCalledWith(
      { trigger: "manual" },
      {
        tenantReference: "tenant-a",
        actorId: "quality-user",
        requestId: "capture-request",
      },
    );
  });
});
