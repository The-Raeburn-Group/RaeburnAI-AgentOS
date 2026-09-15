import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const listApprovalExceptions = vi.hoisted(() => vi.fn());

vi.mock("@/lib/approval-exceptions", () => ({ listApprovalExceptions }));

afterEach(() => {
  vi.unstubAllEnvs();
  listApprovalExceptions.mockReset();
});

function request(options: { token?: string; limit?: string } = {}) {
  const token = options.token ?? "0123456789abcdefghijklmnop";
  const url = new URL("http://localhost:3000/api/approvals/exceptions");
  if (options.limit !== undefined) url.searchParams.set("limit", options.limit);
  return new Request(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-tenant-id": "tenant-a",
      "x-actor-id": "chain-operations",
      "x-request-id": "exception-feed-request-1",
    },
  });
}

describe("approval exception feed route", () => {
  it("fails closed when Chain service authentication is not configured", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");
    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(listApprovalExceptions).not.toHaveBeenCalled();
  });

  it("rejects an invalid Chain service token", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "0123456789abcdefghijklmnop");
    const response = await GET(request({ token: "definitely-wrong-token-value" }));

    expect(response.status).toBe(401);
    expect(listApprovalExceptions).not.toHaveBeenCalled();
  });

  it("rejects invalid limits before reading approval data", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "0123456789abcdefghijklmnop");
    const response = await GET(request({ limit: "201" }));

    expect(response.status).toBe(400);
    expect(listApprovalExceptions).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Invalid exception limit",
    });
  });

  it("lists only the authenticated tenant and propagates trusted correlation", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "0123456789abcdefghijklmnop");
    listApprovalExceptions.mockResolvedValue([
      {
        id: "approval-a",
        tenantId: "tenant-a",
        runId: "run-a",
        workflowId: "workflow-a",
        workflowName: "Governed workflow",
        workflowGoal: "Review an exception",
        actionType: "agent_step",
        summary: "Review high-risk work",
        risk: "HIGH",
        status: "PENDING",
        requestedBy: "operator-a",
        payload: {},
        createdAt: "2026-09-15T16:00:00.000Z",
        escalationLevel: 1,
        escalationOwner: "approver",
        escalatedAt: "2026-09-15T16:30:00.000Z",
      },
    ]);

    const response = await GET(request({ limit: "25" }));

    expect(response.status).toBe(200);
    expect(listApprovalExceptions).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "chain-operations",
      requestId: "exception-feed-request-1",
      limit: 25,
    });
    await expect(response.json()).resolves.toMatchObject({
      tenantId: "tenant-a",
      exceptions: [{ id: "approval-a", tenantId: "tenant-a" }],
    });
  });
});
