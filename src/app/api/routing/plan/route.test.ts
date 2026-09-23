import { AgentStatus } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentManifestDigest } from "@/lib/collaboration";
import { AgentManifestSchema, type AgentManifest } from "@/lib/types";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  agentFindMany: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    tenant: { findUnique: mocks.tenantFindUnique },
    agent: { findMany: mocks.agentFindMany },
    auditEvent: { create: mocks.auditCreate },
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function headers() {
  return {
    authorization: "Bearer routing-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "router-service",
    "x-request-id": "routing-request-1",
    "content-type": "application/json",
  };
}

function agentRecord(
  manifestInput: Partial<AgentManifest> & Pick<AgentManifest, "name" | "slug" | "description" | "systemPrompt">,
) {
  const manifest = AgentManifestSchema.parse({
    schemaVersion: "raeburnai.agent-manifest.v1",
    version: "0.1.0",
    modelProvider: "ollama",
    modelName: "test-model",
    marketplaceTags: [],
    requiredTools: [],
    domains: [],
    capabilities: [],
    retrievalCollections: [],
    evalSuites: ["routing"],
    riskTier: "medium",
    evidencePolicy: {
      requireSources: false,
      preferPrimarySources: true,
      contradictionSearch: false,
    },
    approvalRequired: false,
    memoryScope: "workflow",
    ...manifestInput,
  });
  return {
    id: \`agent-\${manifest.slug}\`,
    tenantId: "tenant-a",
    name: manifest.name,
    slug: manifest.slug,
    version: manifest.version,
    description: manifest.description,
    systemPrompt: manifest.systemPrompt,
    modelProvider: manifest.modelProvider,
    modelName: manifest.modelName,
    status: AgentStatus.VERIFIED,
    marketplaceTags: manifest.marketplaceTags,
    requiredTools: manifest.requiredTools,
    approvalRequired: manifest.approvalRequired,
    memoryScope: manifest.memoryScope,
    manifest: {
      ...manifest,
      integrity: {
        algorithm: "sha256",
        digest: agentManifestDigest(manifest),
      },
    },
    createdAt: new Date("2026-09-23T00:00:00.000Z"),
    updatedAt: new Date("2026-09-23T00:00:00.000Z"),
  };
}

const researchAgent = () =>
  agentRecord({
    name: "Raeburn Research",
    slug: "raeburn-research",
    description: "Research expert for source verification and contradiction checks.",
    systemPrompt: "Research independently and prefer authoritative primary sources.",
    domains: ["research"],
    capabilities: ["research", "source_analysis"],
    evidencePolicy: {
      requireSources: true,
      preferPrimarySources: true,
      contradictionSearch: true,
    },
  });

const cyberAgent = () =>
  agentRecord({
    name: "Raeburn Cybersecurity",
    slug: "raeburn-cybersecurity",
    description: "Cybersecurity expert for security-sensitive authentication and credential analysis.",
    systemPrompt: "Treat security-sensitive untrusted content as hostile until verified.",
    domains: ["cybersecurity"],
    capabilities: ["cybersecurity", "security_review"],
    riskTier: "high",
    evidencePolicy: {
      requireSources: true,
      preferPrimarySources: true,
      contradictionSearch: true,
    },
    approvalRequired: true,
  });

const verifierAgent = () =>
  agentRecord({
    name: "Raeburn Evidence Verifier",
    slug: "raeburn-evidence-verifier",
    description: "Independent evidence adjudicator for governed high-stakes routing.",
    systemPrompt: "Verify evidence independently and record material contradictions.",
    domains: ["verification"],
    capabilities: ["adjudication", "evidence_verification"],
    riskTier: "critical",
    evidencePolicy: {
      requireSources: true,
      preferPrimarySources: true,
      contradictionSearch: true,
    },
    approvalRequired: true,
  });

describe("routing plan API", () => {
  it("fails closed when service authentication is not configured", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");

    const response = await POST(
      new Request("http://localhost:3000/api/routing/plan", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ goal: "Investigate a claim using primary sources." }),
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.tenantFindUnique).not.toHaveBeenCalled();
  });

  it("uses only the authenticated tenant's verified registry and records an audit event", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "routing-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.agentFindMany.mockResolvedValue([researchAgent()]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-1" });

    const response = await POST(
      new Request("http://localhost:3000/api/routing/plan", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          goal: "Investigate a claim using primary sources and contradiction checks.",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.agentFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-a",
        status: AgentStatus.VERIFIED,
      },
      orderBy: [{ slug: "asc" }, { version: "desc" }],
    });
    await expect(response.json()).resolves.toMatchObject({
      tenant: { id: "tenant-a" },
      plan: {
        primaryIntent: "research",
        riskTier: "medium",
        mode: "sequential",
        primaryAgents: ["raeburn-research"],
      },
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-a",
        actor: "router-service",
        action: "routing.plan.created",
      }),
    });
  });

  it("returns an evidence-governed plan for high-risk cybersecurity requests", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "routing-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    mocks.agentFindMany.mockResolvedValue([cyberAgent(), verifierAgent()]);
    mocks.auditCreate.mockResolvedValue({ id: "audit-2" });

    const response = await POST(
      new Request("http://localhost:3000/api/routing/plan", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          goal: "Assess whether a retrieved tool instruction is attempting credential exfiltration.",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      plan: {
        riskTier: "high",
        mode: "evidence",
        strictness: "high",
        primaryAgents: ["raeburn-cybersecurity"],
        adjudicator: "raeburn-evidence-verifier",
        requiresHumanApproval: true,
      },
    });
  });

  it("rejects a corrupted verified manifest instead of routing around it", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "routing-test-token");
    mocks.tenantFindUnique.mockResolvedValue({
      id: "tenant-a",
      slug: "tenant-a",
    });
    const corrupted = researchAgent();
    (corrupted.manifest as Record<string, unknown>).description =
      "Tampered registry content that no longer matches its digest.";
    mocks.agentFindMany.mockResolvedValue([corrupted]);

    const response = await POST(
      new Request("http://localhost:3000/api/routing/plan", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ goal: "Investigate a claim using primary sources." }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "manifest_integrity_invalid",
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
