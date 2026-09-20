import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireHumanPermission: vi.fn(),
  requireHumanTenant: vi.fn(),
  decideWorkflowApproval: vi.fn(),
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

vi.mock("@/lib/approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/approvals")>();
  return {
    ...actual,
    decideWorkflowApproval: mocks.decideWorkflowApproval,
  };
});

function routeContext(id = "approval-1") {
  return { params: Promise.resolve({ id }) };
}

function identity() {
  return {
    actorId: "approver-a",
    tenantId: "tenant-a",
    roles: ["approver"] as const,
  };
}

beforeEach(() => {
  mocks.requireHumanPermission.mockResolvedValue(identity());
  mocks.requireHumanTenant.mockResolvedValue({
    id: "tenant-a",
    slug: "tenant-a",
    name: "Tenant A",
  });
  mocks.decideWorkflowApproval.mockResolvedValue({
    id: "approval-1",
    status: "APPROVED",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("approval decision route", () => {
  it("propagates authenticated tenant, actor and request correlation into an approval", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/approvals/approval-1/decision", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": "decision-request-1",
        },
        body: JSON.stringify({
          decision: "approve",
          note: "Evidence reviewed.",
        }),
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(mocks.requireHumanPermission).toHaveBeenCalledWith(
      "approval.decide",
    );
    expect(mocks.decideWorkflowApproval).toHaveBeenCalledWith({
      approvalId: "approval-1",
      tenantId: "tenant-a",
      actorId: "approver-a",
      requestId: "decision-request-1",
      decision: "approve",
      note: "Evidence reviewed.",
    });
    await expect(response.json()).resolves.toMatchObject({
      approval: { id: "approval-1", status: "APPROVED" },
      requestId: "decision-request-1",
    });
  });

  it("rejects a rejection without an audit reason before calling the service", async () => {
    const response = await POST(
      new Request("http://localhost:3000/api/approvals/approval-1/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(mocks.decideWorkflowApproval).not.toHaveBeenCalled();
  });

  it("supports the approval inbox form flow and redirects after a rejection", async () => {
    mocks.decideWorkflowApproval.mockResolvedValue({
      id: "approval-1",
      status: "REJECTED",
    });
    const form = new FormData();
    form.set("decision", "reject");
    form.set("note", "Outside the approved operating scope.");

    const response = await POST(
      new Request("http://localhost:3000/api/approvals/approval-1/decision", {
        method: "POST",
        body: form,
      }),
      routeContext(),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/approvals?decided=rejected",
    );
    expect(mocks.decideWorkflowApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "reject",
        note: "Outside the approved operating scope.",
      }),
    );
  });

  it("maps unauthenticated humans to 401 without reading tenant or approval state", async () => {
    const { HumanAuthError } = await import("@/lib/admin-auth");
    mocks.requireHumanPermission.mockRejectedValue(
      new HumanAuthError("unauthenticated"),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/approvals/approval-1/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      routeContext(),
    );

    expect(response.status).toBe(401);
    expect(mocks.requireHumanTenant).not.toHaveBeenCalled();
    expect(mocks.decideWorkflowApproval).not.toHaveBeenCalled();
  });

  it("maps a concurrent already-decided result to conflict", async () => {
    const { ApprovalDecisionError } = await import("@/lib/approvals");
    mocks.decideWorkflowApproval.mockRejectedValue(
      new ApprovalDecisionError("approval_already_decided"),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/approvals/approval-1/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }),
      routeContext(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "approval_already_decided",
    });
  });
});
