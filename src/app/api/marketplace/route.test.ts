import { AgentStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentManifestDigest } from "@/lib/collaboration";
import { AgentManifestSchema, type AgentManifest } from "@/lib/types";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireHumanPermission: vi.fn(),
  requireHumanTenant: vi.fn(),
  agentFindUnique: vi.fn(),
  agentUpdateMany: vi.fn(),
  agentCreate: vi.fn(),
  agentFindMany: vi.fn(),
  auditCreate: vi.fn(),
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

vi.mock("@/lib/db", () => ({
  db: {
    agent: {
      findUnique: mocks.agentFindUnique,
      updateMany: mocks.agentUpdateMany,
      create: mocks.agentCreate,
      findMany: mocks.agentFindMany,
    },
    auditEvent: { create: mocks.auditCreate },
  },
}));

function manifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return AgentManifestSchema.parse({
    schemaVersion: "raeburnai.agent-manifest.v1",
    name: "Raeburn Research",
    slug: "raeburn-research",
    version: "1.0.0",
    description: "Evidence-led research expert.",
    systemPrompt: "Prefer authoritative primary evidence.",
    modelProvider: "ollama",
    modelName: "test-model",
    marketplaceTags: ["research"],
    requiredTools: [],
    domains: ["research"],
    capabilities: ["research", "source_analysis"],
    retrievalCollections: [],
    evalSuites: ["routing"],
    riskTier: "medium",
    evidencePolicy: {
      requireSources: true,
      preferPrimarySources: true,
      contradictionSearch: true,
    },
    approvalRequired: false,
    memoryScope: "workflow",
    ...overrides,
  });
}

function storedAgent(
  value: AgentManifest,
  status: AgentStatus,
  updatedAt = new Date("2026-09-23T11:00:00.000Z"),
) {
  return {
    id: "agent-research-v1",
    tenantId: "tenant-a",
    name: value.name,
    slug: value.slug,
    version: value.version,
    description: value.description,
    systemPrompt: value.systemPrompt,
    modelProvider: value.modelProvider,
    modelName: value.modelName,
    status,
    marketplaceTags: value.marketplaceTags,
    requiredTools: value.requiredTools,
    approvalRequired: value.approvalRequired,
    memoryScope: value.memoryScope,
    manifest: {
      ...value,
      integrity: {
        algorithm: "sha256",
        digest: agentManifestDigest(value),
      },
    },
    createdAt: new Date("2026-09-23T10:00:00.000Z"),
    updatedAt,
  };
}

function postManifest(value: AgentManifest) {
  return POST(
    new Request("http://localhost:3000/api/marketplace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    }),
  );
}

beforeEach(() => {
  mocks.requireHumanPermission.mockResolvedValue({
    actorId: "registry-admin",
    tenantId: "tenant-a",
    roles: ["admin"],
  });
  mocks.requireHumanTenant.mockResolvedValue({
    id: "tenant-a",
    slug: "tenant-a",
    name: "Tenant A",
  });
  mocks.auditCreate.mockResolvedValue({ id: "audit-1" });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("marketplace verified-version immutability", () => {
  it("rejects mutation of an already VERIFIED version and audits the attempt", async () => {
    const approved = manifest();
    const changed = manifest({
      systemPrompt: "A changed prompt that has not been re-verified.",
    });
    mocks.agentFindUnique.mockResolvedValue(
      storedAgent(approved, AgentStatus.VERIFIED),
    );

    const response = await postManifest(changed);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "verified_agent_version_immutable",
    });
    expect(mocks.agentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "agent.marketplace.write_rejected",
        metadata: expect.objectContaining({
          reason: "verified_agent_version_immutable",
          agentSlug: approved.slug,
          agentVersion: approved.version,
        }),
      }),
    });
  });

  it("allows an identical VERIFIED resubmission without mutating the registry", async () => {
    const approved = manifest();
    const existing = storedAgent(approved, AgentStatus.VERIFIED);
    mocks.agentFindUnique.mockResolvedValue(existing);

    const response = await postManifest(approved);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      agent: { id: existing.id, status: AgentStatus.VERIFIED },
      writeMode: "verified_idempotent",
    });
    expect(mocks.agentUpdateMany).not.toHaveBeenCalled();
    expect(mocks.agentCreate).not.toHaveBeenCalled();
  });

  it("updates a non-verified version with optimistic status and stale-state guards", async () => {
    const draft = manifest();
    const changed = manifest({ description: "Reviewed draft description." });
    const before = storedAgent(draft, AgentStatus.DRAFT);
    const after = storedAgent(
      changed,
      AgentStatus.DRAFT,
      new Date("2026-09-23T11:01:00.000Z"),
    );
    mocks.agentFindUnique
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    mocks.agentUpdateMany.mockResolvedValue({ count: 1 });

    const response = await postManifest(changed);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      agent: { description: changed.description },
      writeMode: "updated",
    });
    expect(mocks.agentUpdateMany).toHaveBeenCalledWith({
      where: {
        id: before.id,
        updatedAt: before.updatedAt,
        status: { not: AgentStatus.VERIFIED },
      },
      data: expect.objectContaining({
        description: changed.description,
        manifest: expect.objectContaining({
          integrity: expect.objectContaining({ algorithm: "sha256" }),
        }),
      }),
    });
  });

  it("fails closed when a draft becomes VERIFIED during an attempted edit", async () => {
    const approved = manifest();
    const changed = manifest({ description: "Concurrent unreviewed change." });
    const draft = storedAgent(approved, AgentStatus.DRAFT);
    const verified = storedAgent(
      approved,
      AgentStatus.VERIFIED,
      new Date("2026-09-23T11:02:00.000Z"),
    );
    mocks.agentFindUnique
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce(verified);
    mocks.agentUpdateMany.mockResolvedValue({ count: 0 });

    const response = await postManifest(changed);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "agent_version_conflict",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "agent.marketplace.write_rejected",
        metadata: expect.objectContaining({
          reason: "agent_version_conflict",
        }),
      }),
    });
  });
});
