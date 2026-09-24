import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRegistryError } from "@/lib/model-registry";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  auditCreate: vi.fn(),
  freshness: vi.fn(),
  select: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique },
    auditEvent: { create: mocks.auditCreate },
  },
}));

vi.mock("@/lib/model-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/model-registry")>();
  return {
    ...actual,
    evaluateModelRegistryFreshness: mocks.freshness,
    selectRegistryModel: mocks.select,
  };
});

function headers() {
  return {
    authorization: "Bearer model-registry-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "router-a",
    "x-request-id": "model-request-1",
    "x-roles": "router",
    "content-type": "application/json",
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("model registry API", () => {
  it("requires service authentication", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "model-registry-test-token");
    const response = await GET(
      new Request("http://localhost:3000/api/models/registry"),
    );
    expect(response.status).toBe(401);
  });

  it("returns the integrity-bound registry and freshness findings", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "model-registry-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.freshness.mockReturnValue({
      registryVersion: "0.1.0",
      registryDigest: "a".repeat(64),
      evaluatedAt: "2026-09-24T10:00:00.000Z",
      findings: [
        {
          entryId: "ollama.llama3_1.configured",
          severity: "review",
          code: "technical_review_missing",
          detail: "technical registry review has not been completed",
        },
      ],
    });

    const response = await GET(
      new Request("http://localhost:3000/api/models/registry", {
        headers: headers(),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contractVersion: "raeburnai.model-registry.v1",
      registryDigest: "a".repeat(64),
      freshness: {
        findings: [
          expect.objectContaining({ code: "technical_review_missing" }),
        ],
      },
    });
  });

  it("audits a successful governed model selection", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "model-registry-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.select.mockReturnValue({
      entry: {
        id: "model.active.v1",
        provider: "ollama",
        model: "active-model",
        revision: "1",
      },
      score: 0.9,
      registryDigest: "b".repeat(64),
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });

    const response = await POST(
      new Request("http://localhost:3000/api/models/registry", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          requiredCapabilities: ["general"],
          privacy: "local_only",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-a",
        action: "models.registry.selected",
        metadata: expect.objectContaining({
          modelEntryId: "model.active.v1",
          requestId: "model-request-1",
        }),
      }),
    });
  });

  it("fails closed and audits when no registered model is eligible", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "model-registry-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.select.mockImplementation(() => {
      throw new ModelRegistryError("no_eligible_model");
    });
    mocks.auditCreate.mockResolvedValue({ id: "audit-2" });

    const response = await POST(
      new Request("http://localhost:3000/api/models/registry", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ requiredCapabilities: ["general"] }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "no_eligible_model",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "models.registry.selection_rejected",
        metadata: expect.objectContaining({
          reason: "no_eligible_model",
        }),
      }),
    });
  });

  it("returns 404 rather than selecting against an unknown tenant", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "model-registry-test-token");
    mocks.tenantFindUnique.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost:3000/api/models/registry", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ requiredCapabilities: ["general"] }),
      }),
    );

    expect(response.status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
