import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const sweepApprovalEscalations = vi.hoisted(() => vi.fn());

vi.mock("@/lib/approval-sla", () => ({ sweepApprovalEscalations }));

afterEach(() => {
  vi.unstubAllEnvs();
  sweepApprovalEscalations.mockReset();
});

function request(token = "0123456789abcdefghijklmnop") {
  return new Request("http://localhost:3000/api/approvals/sweep", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": "tenant-a",
      "x-actor-id": "chain-scheduler",
      "x-request-id": "sweep-request-1",
    },
  });
}

describe("approval SLA sweep route", () => {
  it("fails closed when Chain service authentication is not configured", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(sweepApprovalEscalations).not.toHaveBeenCalled();
  });

  it("rejects an invalid Chain service token", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "0123456789abcdefghijklmnop");
    const response = await POST(request("definitely-wrong-token-value"));
    expect(response.status).toBe(401);
    expect(sweepApprovalEscalations).not.toHaveBeenCalled();
  });

  it("sweeps only the authenticated Chain tenant", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "0123456789abcdefghijklmnop");
    sweepApprovalEscalations.mockResolvedValue({ expired: 2, escalated: 3 });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(sweepApprovalEscalations).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "chain-scheduler",
      requestId: "sweep-request-1",
    });
    await expect(response.json()).resolves.toEqual({
      tenantId: "tenant-a",
      expired: 2,
      escalated: 3,
    });
  });
});
