import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateChainServiceRequest,
  requireChainServiceToken,
} from "@/lib/service-auth";

const originalToken = process.env.RAEBURN_CHAIN_SERVICE_TOKEN;

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.RAEBURN_CHAIN_SERVICE_TOKEN;
  } else {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = originalToken;
  }
});

describe("requireChainServiceToken", () => {
  it("fails closed when the service credential is not configured", async () => {
    delete process.env.RAEBURN_CHAIN_SERVICE_TOKEN;

    const response = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run"),
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: "Chain service authentication is not configured",
    });
  });

  it("rejects a missing or incorrect bearer credential", () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const missing = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run"),
    );
    const incorrect = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    );

    expect(missing?.status).toBe(401);
    expect(incorrect?.status).toBe(401);
  });

  it("accepts the configured bearer credential", () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const response = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run", {
        headers: { authorization: "Bearer expected-token" },
      }),
    );

    expect(response).toBeNull();
  });
});

describe("authenticateChainServiceRequest", () => {
  it("rejects an authenticated service request without trusted tenant context", async () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const result = authenticateChainServiceRequest(
      new Request("http://localhost/api/workflows/run", {
        headers: { authorization: "Bearer expected-token" },
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        error: "Invalid Chain service context",
      });
    }
  });

  it("accepts ordinary authenticated Chain context when governance is not required", () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const result = authenticateChainServiceRequest(
      new Request("http://localhost/api/workflows/run", {
        headers: {
          authorization: "Bearer expected-token",
          "x-tenant-id": "tenant-a",
          "x-actor-id": "user-123",
          "x-request-id": "request-456",
          "x-roles": "operator,auditor",
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      context: {
        tenantId: "tenant-a",
        actorId: "user-123",
        requestId: "request-456",
        roles: ["operator", "auditor"],
      },
    });
  });

  it("fails closed when a governed endpoint receives no governed execution context", async () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const result = authenticateChainServiceRequest(
      new Request("http://localhost/api/workflows/run", {
        headers: {
          authorization: "Bearer expected-token",
          "x-tenant-id": "tenant-a",
          "x-actor-id": "user-123",
          "x-request-id": "request-456",
        },
      }),
      { requireGovernedExecution: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        error: "Governed Chain execution context required",
      });
    }
  });

  it("rejects partial governed execution provenance", async () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const result = authenticateChainServiceRequest(
      new Request("http://localhost/api/workflows/run", {
        headers: {
          authorization: "Bearer expected-token",
          "x-tenant-id": "tenant-a",
          "x-actor-id": "user-123",
          "x-request-id": "request-456",
          "x-raeburn-approval-id": "11111111-1111-4111-8111-111111111111",
        },
      }),
      { requireGovernedExecution: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        error: "Incomplete governed Chain execution context",
      });
    }
  });

  it("accepts complete validated governed execution provenance", () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const result = authenticateChainServiceRequest(
      new Request("http://localhost/api/workflows/run", {
        headers: {
          authorization: "Bearer expected-token",
          "x-tenant-id": "tenant-a",
          "x-actor-id": "user-123",
          "x-request-id": "request-456",
          "x-roles": "operator,auditor",
          "x-raeburn-approval-id": "11111111-1111-4111-8111-111111111111",
          "idempotency-key": "idem-agentos-workflow-001",
          "x-raeburn-execution-id": "22222222-2222-4222-8222-222222222222",
        },
      }),
      { requireGovernedExecution: true },
    );

    expect(result).toEqual({
      ok: true,
      context: {
        tenantId: "tenant-a",
        actorId: "user-123",
        requestId: "request-456",
        roles: ["operator", "auditor"],
        approvalId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "idem-agentos-workflow-001",
        executionId: "22222222-2222-4222-8222-222222222222",
      },
    });
  });

  it("rejects malformed governed identifiers", async () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const result = authenticateChainServiceRequest(
      new Request("http://localhost/api/workflows/run", {
        headers: {
          authorization: "Bearer expected-token",
          "x-tenant-id": "tenant-a",
          "x-actor-id": "user-123",
          "x-request-id": "request-456",
          "x-raeburn-approval-id": "not-a-uuid",
          "idempotency-key": "idem-agentos-workflow-001",
          "x-raeburn-execution-id": "22222222-2222-4222-8222-222222222222",
        },
      }),
      { requireGovernedExecution: true },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      await expect(result.response.json()).resolves.toEqual({
        error: "Invalid Chain approval ID",
      });
    }
  });
});
