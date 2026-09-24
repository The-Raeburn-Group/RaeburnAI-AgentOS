import { AgentStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpertCatalogInstallError } from "@/lib/expert-catalog-store";
import { GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  requireHumanPermission: vi.fn(),
  requireHumanTenant: vi.fn(),
  installExpertCatalogDraft: vi.fn(),
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

vi.mock("@/lib/expert-catalog-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/expert-catalog-store")>();
  return {
    ...actual,
    installExpertCatalogDraft: mocks.installExpertCatalogDraft,
  };
});

beforeEach(() => {
  mocks.requireHumanPermission.mockResolvedValue({
    actorId: "catalog-admin",
    tenantId: "tenant-a",
    roles: ["admin"],
  });
  mocks.requireHumanTenant.mockResolvedValue({
    id: "tenant-a",
    slug: "tenant-a",
    name: "Tenant A",
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("expert catalog API", () => {
  it("returns bounded development summaries for all 20 expert packs", async () => {
    const response = await GET(
      new Request("http://localhost:3000/api/experts/catalog"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.expertCount).toBe(20);
    expect(body.totalSeedCases).toBe(2_000);
    expect(body.catalogDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.packs).toHaveLength(20);
    expect(body.packs[0]).not.toHaveProperty("evaluationSeed");
    expect(body.packs[0].manifest).not.toHaveProperty("systemPrompt");
    expect(
      body.packs.every(
        (pack: {
          card: { lifecycle: string };
          manifest: { modelName: string };
        }) =>
          pack.card.lifecycle === "development" &&
          pack.manifest.modelName === "catalog-unassigned",
      ),
    ).toBe(true);
  });

  it("can select one catalog summary without returning the 2,000 seed records", async () => {
    const response = await GET(
      new Request(
        "http://localhost:3000/api/experts/catalog?slug=raeburn-finance",
      ),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.packs).toHaveLength(1);
    expect(body.packs[0]).toMatchObject({
      slug: "raeburn-finance",
      seedCaseCount: 100,
      card: { lifecycle: "development" },
    });
    expect(body.packs[0]).not.toHaveProperty("evaluationSeed");
  });

  it("installs a selected pack as a DRAFT rather than activating it", async () => {
    mocks.installExpertCatalogDraft.mockResolvedValue({
      agent: {
        id: "agent-finance",
        status: AgentStatus.DRAFT,
        slug: "raeburn-finance",
      },
      mode: "created_draft",
      manifestDigest: "a".repeat(64),
    });

    const response = await POST(
      new Request("http://localhost:3000/api/experts/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "raeburn-finance" }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      lifecycle: "development",
      activated: false,
      mode: "created_draft",
      agent: { status: AgentStatus.DRAFT },
    });
    expect(mocks.installExpertCatalogDraft).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "catalog-admin",
      slug: "raeburn-finance",
    });
  });

  it("maps a catalog conflict to 409 without overwriting an existing version", async () => {
    mocks.installExpertCatalogDraft.mockRejectedValue(
      new ExpertCatalogInstallError("expert_version_conflict"),
    );

    const response = await POST(
      new Request("http://localhost:3000/api/experts/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: "raeburn-finance" }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "expert_version_conflict",
    });
  });
});
