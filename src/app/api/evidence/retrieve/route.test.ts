import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  retrieveKnowledgeEvidence: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique },
    auditEvent: { create: mocks.auditCreate },
  },
}));

vi.mock("@/lib/kg-evidence-client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/kg-evidence-client")
  >("@/lib/kg-evidence-client");
  return {
    ...actual,
    retrieveKnowledgeEvidence: mocks.retrieveKnowledgeEvidence,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function headers() {
  return {
    authorization: "Bearer evidence-retrieval-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "analyst-a",
    "x-request-id": "request-123",
    "x-roles": "researcher,auditor",
    "x-groups": "team-alpha,finance",
    "content-type": "application/json",
  };
}

describe("evidence retrieval API", () => {
  it("fails closed when service authentication is not configured", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/retrieve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ query: "approved control threshold" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.retrieveKnowledgeEvidence).not.toHaveBeenCalled();
  });

  it("binds Knowledge Graph retrieval to the authenticated tenant and actor", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-retrieval-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.retrieveKnowledgeEvidence.mockResolvedValue({
      bundle: {
        contract_version: "raeburnai.kg-evidence-export.v1",
        workspace_id: "tenant-a",
        query: "approved control threshold",
        retrieved_at: "2026-09-25T18:00:00Z",
        sources: [],
        bundle_sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      trustedSources: [],
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/retrieve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          query: "approved control threshold",
          retrievalMode: "hybrid",
          rerank: true,
          includeGraph: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.retrieveKnowledgeEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "tenant-a",
        actorId: "analyst-a",
        roles: ["researcher", "auditor"],
        groups: ["team-alpha", "finance"],
        query: "approved control threshold",
        retrievalMode: "hybrid",
        rerank: true,
        includeGraph: false,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      tenant: { id: "tenant-a", slug: "tenant-a" },
      evidence: {
        contract_version: "raeburnai.kg-evidence-export.v1",
        workspace_id: "tenant-a",
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-a",
        actor: "analyst-a",
        action: "evidence.retrieval.completed",
        metadata: expect.objectContaining({
          requestId: "request-123",
          sourceCount: 0,
          retrievalMode: "hybrid",
        }),
      }),
    });
    const auditPayload = JSON.stringify(mocks.auditCreate.mock.calls[0]?.[0]);
    expect(auditPayload).not.toContain("approved control threshold");
  });

  it("does not permit callers to select an arbitrary Knowledge Graph workspace", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-retrieval-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.retrieveKnowledgeEvidence.mockResolvedValue({
      bundle: {
        contract_version: "raeburnai.kg-evidence-export.v1",
        workspace_id: "tenant-a",
        query: "test",
        retrieved_at: "2026-09-25T18:00:00Z",
        sources: [],
        bundle_sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      trustedSources: [],
    });

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/retrieve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          query: "test",
          workspaceId: "tenant-b",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.retrieveKnowledgeEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "tenant-a" }),
    );
  });

  it("resolves slug-mode tenant references to the canonical database id", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-retrieval-token");
    vi.stubEnv("AGENTOS_TENANT_REFERENCE_MODE", "slug");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-canonical-id",
      slug: "tenant-a",
    });
    mocks.retrieveKnowledgeEvidence.mockResolvedValue({
      bundle: {
        contract_version: "raeburnai.kg-evidence-export.v1",
        workspace_id: "tenant-canonical-id",
        query: "approved control threshold",
        retrieved_at: "2026-09-25T18:00:00Z",
        sources: [],
        bundle_sha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      },
      trustedSources: [],
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-slug" });

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/retrieve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ query: "approved control threshold" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.tenantFindUnique).toHaveBeenCalledWith({
      where: { slug: "tenant-a" },
    });
    expect(mocks.retrieveKnowledgeEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "tenant-canonical-id" }),
    );
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: "tenant-canonical-id" }),
    });
  });

  it("returns no evidence when the tenant does not exist locally", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-retrieval-token");
    mocks.tenantFindUnique.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost:3000/api/evidence/retrieve", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ query: "approved control threshold" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(mocks.retrieveKnowledgeEvidence).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
