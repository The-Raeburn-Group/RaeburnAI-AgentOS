import { afterEach, describe, expect, it, vi } from "vitest";

const requireHumanPermission = vi.hoisted(() => vi.fn());
const requireHumanTenant = vi.hoisted(() => vi.fn());
const decideWorkflowApproval = vi.hoisted(() => vi.fn());

vi.mock("@/lib/admin-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-auth")>();
  return { ...actual, requireHumanPermission };
});
vi.mock("@/lib/human-tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/human-tenant")>();
  return { ...actual, requireHumanTenant };
});
vi.mock("@/lib/approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/approvals")>();
  return { ...actual, decideWorkflowApproval };
});

import { HumanAuthError } from "@/lib/admin-auth";
import { ApprovalDecisionError } from "@/lib/approvals";
import { TenantAccessError } from "@/lib/human-tenant";
import { POST } from "./route";

const identity = {
  actorId: "approver-a",
  tenantId: "tenant-a",
  roles: ["approver"] as const,
  email: "approver@example.test",
};

const tenant = {
  id: "tenant-a",
  slug: "tenant-a",
  name: "Tenant A",
  createdAt: new Date("2026-09-20T00:00:00.000Z"),
  updatedAt: new Date("2026-09-20T00:00:00.000Z"),
};

function context(id = "approval-a") {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(
  body: unknown,
  requestId = "approval-decision-request-1",
) {
  return new Request(
    "http://localhost:3000/api/approvals/approval-a/decision",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
      },
      body: JSON.stringify(body),
    },
  );
}

afterEach(() => {
  requireHumanPermission.mockReset();
  requireHumanTenant.mockReset();
  decideWorkflowApproval.mockReset();
});

describe("human approval decision route", () => {
  it("fails closed when human authentication is not configured", async () => {
    requireHumanPermission.mockRejectedValue(
      new HumanAuthError("auth_unconfigured"),
    );

    const response = await POST(
      jsonRequest({ decision: "approve" }),
      context(),
    );

    expect(response.status).toBe(503);
    expect(requireHumanTenant).not.toHaveBeenCalled();
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
  });

  it("requires an authenticated identity with approval.decide permission", async () => {
    requireHumanPermission.mockRejectedValue(
      new HumanAuthError("unauthenticated"),
    );

    const unauthenticated = await POST(
      jsonRequest({ decision: "approve" }),
      context(),
    );
    expect(unauthenticated.status).toBe(401);

    requireHumanPermission.mockRejectedValue(new HumanAuthError("forbidden"));
    const forbidden = await POST(
      jsonRequest({ decision: "approve" }),
      context(),
    );
    expect(forbidden.status).toBe(403);
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
  });

  it("rejects an identity that is not mapped to an AgentOS tenant", async () => {
    requireHumanPermission.mockResolvedValue(identity);
    requireHumanTenant.mockRejectedValue(
      new TenantAccessError("tenant_not_found"),
    );

    const response = await POST(
      jsonRequest({ decision: "approve" }),
      context(),
    );

    expect(response.status).toBe(403);
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
  });

  it("requires a rejection reason before invoking decision logic", async () => {
    requireHumanPermission.mockResolvedValue(identity);
    requireHumanTenant.mockResolvedValue(tenant);

    const response = await POST(
      jsonRequest({ decision: "reject", note: "" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(decideWorkflowApproval).not.toHaveBeenCalled();
  });

  it("passes only trusted identity, tenant and correlation context to the decision engine", async () => {
    requireHumanPermission.mockResolvedValue(identity);
    requireHumanTenant.mockResolvedValue(tenant);
    decideWorkflowApproval.mockResolvedValue({
      id: "approval-a",
      status: "APPROVED",
      decidedBy: identity.actorId,
    });

    const response = await POST(
      jsonRequest(
        {
          decision: "approve",
          note: "Evidence independently reviewed.",
          tenantId: "attacker-selected-tenant",
          actorId: "attacker-selected-actor",
        },
        "trusted-request-42",
      ),
      context(),
    );

    expect(response.status).toBe(200);
    expect(requireHumanPermission).toHaveBeenCalledWith("approval.decide");
    expect(requireHumanTenant).toHaveBeenCalledWith(identity);
    expect(decideWorkflowApproval).toHaveBeenCalledWith({
      approvalId: "approval-a",
      tenantId: tenant.id,
      actorId: identity.actorId,
      requestId: "trusted-request-42",
      decision: "approve",
      note: "Evidence independently reviewed.",
    });
    await expect(response.json()).resolves.toMatchObject({
      approval: {
        id: "approval-a",
        status: "APPROVED",
        decidedBy: identity.actorId,
      },
      requestId: "trusted-request-42",
    });
  });

  it("surfaces stale concurrent decisions as a conflict", async () => {
    requireHumanPermission.mockResolvedValue(identity);
    requireHumanTenant.mockResolvedValue(tenant);
    decideWorkflowApproval.mockRejectedValue(
      new ApprovalDecisionError("approval_already_decided"),
    );

    const response = await POST(
      jsonRequest({ decision: "approve" }),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "approval_already_decided",
    });
  });

  it("surfaces expired approvals as gone rather than executing them", async () => {
    requireHumanPermission.mockResolvedValue(identity);
    requireHumanTenant.mockResolvedValue(tenant);
    decideWorkflowApproval.mockRejectedValue(
      new ApprovalDecisionError("approval_expired"),
    );

    const response = await POST(
      jsonRequest({ decision: "approve" }),
      context(),
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "approval_expired",
    });
  });
});
