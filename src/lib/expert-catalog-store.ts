import { AgentStatus, type Agent, type Prisma } from "@prisma/client";
import { agentManifestDigest } from "@/lib/collaboration";
import { db } from "@/lib/db";
import { buildExpertPack } from "@/lib/expert-catalog";
import { AgentManifestSchema, type AgentManifest } from "@/lib/types";

export class ExpertCatalogInstallError extends Error {
  constructor(
    public readonly code:
      | "unknown_expert_pack"
      | "expert_version_conflict"
      | "manifest_integrity_invalid",
  ) {
    super(code);
    this.name = "ExpertCatalogInstallError";
  }
}

export type ExpertCatalogInstallMode =
  | "created_draft"
  | "existing_idempotent";

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function storedManifestDigest(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const integrity = (input as Record<string, unknown>).integrity;
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
    return undefined;
  }
  const algorithm = (integrity as Record<string, unknown>).algorithm;
  const digest = (integrity as Record<string, unknown>).digest;
  return algorithm === "sha256" && typeof digest === "string"
    ? digest
    : undefined;
}

function storedManifestMatches(
  agent: Pick<
    Agent,
    | "name"
    | "slug"
    | "version"
    | "description"
    | "systemPrompt"
    | "modelProvider"
    | "modelName"
    | "marketplaceTags"
    | "requiredTools"
    | "approvalRequired"
    | "memoryScope"
    | "manifest"
  >,
  manifest: AgentManifest,
  digest: string,
): boolean {
  const parsed = AgentManifestSchema.safeParse(agent.manifest);
  if (!parsed.success) return false;
  if (
    storedManifestDigest(agent.manifest) !== digest ||
    agentManifestDigest(parsed.data) !== digest
  ) {
    return false;
  }

  return (
    agent.name === manifest.name &&
    agent.slug === manifest.slug &&
    agent.version === manifest.version &&
    agent.description === manifest.description &&
    agent.systemPrompt === manifest.systemPrompt &&
    agent.modelProvider === manifest.modelProvider &&
    agent.modelName === manifest.modelName &&
    JSON.stringify(agent.marketplaceTags) ===
      JSON.stringify(manifest.marketplaceTags) &&
    JSON.stringify(agent.requiredTools) === JSON.stringify(manifest.requiredTools) &&
    agent.approvalRequired === manifest.approvalRequired &&
    agent.memoryScope === manifest.memoryScope
  );
}

export async function installExpertCatalogDraft(options: {
  tenantId: string;
  actorId: string;
  slug: string;
}): Promise<{ agent: Agent; mode: ExpertCatalogInstallMode; manifestDigest: string }> {
  let pack;
  try {
    pack = buildExpertPack(options.slug);
  } catch {
    throw new ExpertCatalogInstallError("unknown_expert_pack");
  }

  const manifest = pack.manifest;
  const manifestDigest = agentManifestDigest(manifest);
  const storedManifest = inputJson({
    ...manifest,
    integrity: {
      algorithm: "sha256",
      digest: manifestDigest,
    },
  });

  return db.$transaction(async (tx) => {
    const existing = await tx.agent.findUnique({
      where: {
        tenantId_slug_version: {
          tenantId: options.tenantId,
          slug: manifest.slug,
          version: manifest.version,
        },
      },
    });

    if (existing) {
      if (!storedManifestMatches(existing, manifest, manifestDigest)) {
        throw new ExpertCatalogInstallError("expert_version_conflict");
      }
      await tx.auditEvent.create({
        data: {
          tenantId: options.tenantId,
          actor: options.actorId,
          action: "expert.catalog.install_replayed",
          metadata: {
            agentId: existing.id,
            slug: manifest.slug,
            version: manifest.version,
            status: existing.status,
            manifestDigest,
          },
        },
      });
      return {
        agent: existing,
        mode: "existing_idempotent" as const,
        manifestDigest,
      };
    }

    const agent = await tx.agent.create({
      data: {
        tenantId: options.tenantId,
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        description: manifest.description,
        systemPrompt: manifest.systemPrompt,
        modelProvider: manifest.modelProvider,
        modelName: manifest.modelName,
        status: AgentStatus.DRAFT,
        marketplaceTags: manifest.marketplaceTags,
        requiredTools: manifest.requiredTools,
        approvalRequired: manifest.approvalRequired,
        memoryScope: manifest.memoryScope,
        manifest: storedManifest,
      },
    });

    await tx.auditEvent.create({
      data: {
        tenantId: options.tenantId,
        actor: options.actorId,
        action: "expert.catalog.installed",
        metadata: {
          agentId: agent.id,
          slug: manifest.slug,
          version: manifest.version,
          status: AgentStatus.DRAFT,
          manifestDigest,
          seedCaseCount: pack.evaluationSeed.length,
          taskCount: pack.taskTaxonomy.length,
        },
      },
    });

    return {
      agent,
      mode: "created_draft" as const,
      manifestDigest,
    };
  });
}
