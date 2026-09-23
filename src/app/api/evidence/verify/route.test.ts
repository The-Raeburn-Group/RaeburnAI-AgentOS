import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceSourceContentHash } from "@/lib/evidence-verification";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique },
    auditEvent: { create: mocks.auditCreate },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function headers() {
  return {
    authorization: "Bearer evidence-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "chain-service",
    "x-request-id": "evidence-request-1",
    "content-type": "application/json",
  };
}

function trustedSource() {
  const excerpt = "The approved limit is 50.";
  return {
    id: "s1",
    uri: "https://example.com/source",
    title: "Approved policy",
    sourceType: "primary",
    retrievedAt: "2026-09-23T12:00:00.000Z",
    documentId: "policy-1",
    documentVersion: "v3",
    chunkId: "chunk-7",
    excerpt,
    contentHash: evidenceSourceContentHash(excerpt),
  };
}

describe("evidence verification API", () => {
  it("fails closed when service authentication is not configured", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/verify", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("does not verify evidence for an unknown tenant", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-test-token");
    mocks.tenantFindUnique.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/verify", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(404);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("verifies trusted evidence and audits only summary metadata", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/verify", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          strictness: "standard",
          sources: [trustedSource()],
          claims: [
            {
              id: "c1",
              claim: "The approved limit is 50.",
              sourceIds: ["s1"],
            },
          ],
          calculations: [
            {
              id: "calc-1",
              expression: "100 * 50%",
              assertedResult: 50,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      tenant: { id: "tenant-a", slug: "tenant-a" },
      verification: {
        decision: "pass",
        scores: {
          correctness: 1,
          evidenceIntegrity: 1,
          citationIntegrity: 1,
          calculationAccuracy: 1,
        },
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-a",
        actor: "chain-service",
        action: "evidence.verification.completed",
        metadata: expect.objectContaining({
          requestId: "evidence-request-1",
          decision: "pass",
          claimCount: 1,
          calculationCount: 1,
        }),
      }),
    });
    const audit = mocks.auditCreate.mock.calls[0]?.[0];
    expect(JSON.stringify(audit)).not.toContain("The approved limit is 50.");
  });

  it("returns a valid fail decision for a material calculation mismatch and records it", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-2" });

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/verify", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          strictness: "standard",
          calculations: [
            {
              id: "calc-1",
              expression: "100 * 15%",
              assertedResult: 20,
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      verification: {
        decision: "fail",
        calculationResults: [
          {
            id: "calc-1",
            passed: false,
            computedResult: 15,
          },
        ],
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ decision: "fail" }),
      }),
    });
  });

  it("rejects structurally invalid citation references without writing verification audit evidence", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/verify", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          sources: [trustedSource()],
          claims: [
            {
              id: "c1",
              claim: "The approved limit is 50.",
              sourceIds: ["missing"],
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "unknown_claim_source",
      detail: "missing",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
