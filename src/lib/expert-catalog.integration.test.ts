import { AgentStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { agentManifestDigest } from "@/lib/collaboration";
import { db } from "@/lib/db";
import {
  ExpertCatalogInstallError,
  installExpertCatalogDraft,
} from "@/lib/expert-catalog-store";
import { AgentManifestSchema } from "@/lib/types";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tenantId = "expert-catalog-integration-tenant";

async function clean() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

describeWithDatabase("expert catalog installation", () => {
  beforeEach(async () => {
    await clean();
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: tenantId,
        name: "Expert Catalog Integration Tenant",
      },
    });
  });

  afterAll(clean);

  it("creates a catalog expert as DRAFT and keeps exact replay idempotent", async () => {
    const first = await installExpertCatalogDraft({
      tenantId,
      actorId: "catalog-admin",
      slug: "raeburn-finance",
    });

    expect(first.mode).toBe("created_draft");
    expect(first.agent.status).toBe(AgentStatus.DRAFT);
    expect(first.agent.modelName).toBe("catalog-unassigned");

    const parsed = AgentManifestSchema.parse(first.agent.manifest);
    expect(agentManifestDigest(parsed)).toBe(first.manifestDigest);

    const second = await installExpertCatalogDraft({
      tenantId,
      actorId: "catalog-admin",
      slug: "raeburn-finance",
    });

    expect(second.mode).toBe("existing_idempotent");
    expect(second.agent.id).toBe(first.agent.id);
    expect(
      await db.agent.count({
        where: { tenantId, slug: "raeburn-finance", version: "0.1.0" },
      }),
    ).toBe(1);
  });

  it("keeps concurrent installation idempotent with one durable agent version", async () => {
    const [left, right] = await Promise.all([
      installExpertCatalogDraft({
        tenantId,
        actorId: "catalog-admin-left",
        slug: "raeburn-software-engineering",
      }),
      installExpertCatalogDraft({
        tenantId,
        actorId: "catalog-admin-right",
        slug: "raeburn-software-engineering",
      }),
    ]);

    expect(new Set([left.agent.id, right.agent.id]).size).toBe(1);
    expect(new Set([left.mode, right.mode])).toEqual(
      new Set(["created_draft", "existing_idempotent"]),
    );
    expect(
      await db.agent.count({
        where: {
          tenantId,
          slug: "raeburn-software-engineering",
          version: "0.1.0",
        },
      }),
    ).toBe(1);
  });

  it("fails closed rather than overwriting a locally changed DRAFT version", async () => {
    const installed = await installExpertCatalogDraft({
      tenantId,
      actorId: "catalog-admin",
      slug: "raeburn-research",
    });

    await db.agent.update({
      where: { id: installed.agent.id },
      data: { systemPrompt: "Locally edited prompt awaiting separate review." },
    });

    await expect(
      installExpertCatalogDraft({
        tenantId,
        actorId: "catalog-admin",
        slug: "raeburn-research",
      }),
    ).rejects.toMatchObject<Partial<ExpertCatalogInstallError>>({
      code: "expert_version_conflict",
    });

    const unchanged = await db.agent.findUniqueOrThrow({
      where: { id: installed.agent.id },
    });
    expect(unchanged.systemPrompt).toBe(
      "Locally edited prompt awaiting separate review.",
    );
    expect(unchanged.status).toBe(AgentStatus.DRAFT);
  });

  it("never downgrades or rewrites an identical VERIFIED version on replay", async () => {
    const installed = await installExpertCatalogDraft({
      tenantId,
      actorId: "catalog-admin",
      slug: "raeburn-compliance",
    });

    await db.agent.update({
      where: { id: installed.agent.id },
      data: { status: AgentStatus.VERIFIED },
    });

    const replay = await installExpertCatalogDraft({
      tenantId,
      actorId: "catalog-admin",
      slug: "raeburn-compliance",
    });

    expect(replay.mode).toBe("existing_idempotent");
    expect(replay.agent.status).toBe(AgentStatus.VERIFIED);
    const persisted = await db.agent.findUniqueOrThrow({
      where: { id: installed.agent.id },
    });
    expect(persisted.status).toBe(AgentStatus.VERIFIED);
  });
});
