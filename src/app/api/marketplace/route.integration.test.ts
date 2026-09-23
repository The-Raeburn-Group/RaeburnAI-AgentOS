import { AgentStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agentManifestDigest } from "@/lib/collaboration";
import { db } from "@/lib/db";
import { AgentManifestSchema, type AgentManifest } from "@/lib/types";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireHumanPermission: vi.fn(),
  requireHumanTenant: vi.fn(),
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

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tenantId = "marketplace-integrity-tenant";

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

function storedManifest(value: AgentManifest) {
  return {
    ...value,
    integrity: {
      algorithm: "sha256",
      digest: agentManifestDigest(value),
    },
  };
}

async function clean() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

function request(value: AgentManifest) {
  return new Request("http://localhost:3000/api/marketplace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describeWithDatabase("marketplace registry integration", () => {
  beforeEach(async () => {
    await clean();
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: tenantId,
        name: "Marketplace Integrity Tenant",
      },
    });
    mocks.requireHumanPermission.mockResolvedValue({
      actorId: "registry-admin",
      tenantId,
      roles: ["admin"],
    });
    mocks.requireHumanTenant.mockResolvedValue({
      id: tenantId,
      slug: tenantId,
      name: "Marketplace Integrity Tenant",
    });
  });

  afterAll(clean);

  it("keeps a VERIFIED expert version byte-for-byte immutable when a changed manifest is submitted", async () => {
    const approved = manifest();
    await db.agent.create({
      data: {
        tenantId,
        name: approved.name,
        slug: approved.slug,
        version: approved.version,
        description: approved.description,
        systemPrompt: approved.systemPrompt,
        modelProvider: approved.modelProvider,
        modelName: approved.modelName,
        status: AgentStatus.VERIFIED,
        marketplaceTags: approved.marketplaceTags,
        requiredTools: approved.requiredTools,
        approvalRequired: approved.approvalRequired,
        memoryScope: approved.memoryScope,
        manifest: storedManifest(approved),
      },
    });

    const changed = manifest({
      systemPrompt: "Unreviewed replacement system prompt.",
    });
    const response = await POST(request(changed));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "verified_agent_version_immutable",
    });

    const persisted = await db.agent.findUniqueOrThrow({
      where: {
        tenantId_slug_version: {
          tenantId,
          slug: approved.slug,
          version: approved.version,
        },
      },
    });
    expect(persisted.status).toBe(AgentStatus.VERIFIED);
    expect(persisted.systemPrompt).toBe(approved.systemPrompt);
    expect(persisted.manifest).toEqual(storedManifest(approved));
    expect(
      await db.auditEvent.count({
        where: {
          tenantId,
          action: "agent.marketplace.write_rejected",
        },
      }),
    ).toBe(1);
  });

  it("allows a DRAFT version to change without promoting it to VERIFIED", async () => {
    const draft = manifest();
    await db.agent.create({
      data: {
        tenantId,
        name: draft.name,
        slug: draft.slug,
        version: draft.version,
        description: draft.description,
        systemPrompt: draft.systemPrompt,
        modelProvider: draft.modelProvider,
        modelName: draft.modelName,
        status: AgentStatus.DRAFT,
        marketplaceTags: draft.marketplaceTags,
        requiredTools: draft.requiredTools,
        approvalRequired: draft.approvalRequired,
        memoryScope: draft.memoryScope,
        manifest: storedManifest(draft),
      },
    });

    const changed = manifest({
      description: "Updated draft awaiting verification.",
    });
    const response = await POST(request(changed));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      writeMode: "updated",
      agent: {
        status: AgentStatus.DRAFT,
        description: changed.description,
      },
    });

    const persisted = await db.agent.findUniqueOrThrow({
      where: {
        tenantId_slug_version: {
          tenantId,
          slug: changed.slug,
          version: changed.version,
        },
      },
    });
    expect(persisted.status).toBe(AgentStatus.DRAFT);
    expect(persisted.description).toBe(changed.description);
    expect(persisted.manifest).toEqual(storedManifest(changed));
  });
});
