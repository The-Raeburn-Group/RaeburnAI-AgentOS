import { AgentStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import { agentManifestDigest } from "@/lib/collaboration";
import { db } from "@/lib/db";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";
import { apiError, rateLimit } from "@/lib/http";
import { AgentManifestSchema, type AgentManifest } from "@/lib/types";

function authError(error: unknown) {
  if (error instanceof TenantAccessError) {
    return NextResponse.json(
      { error: "tenant_access_denied" },
      { status: 403 },
    );
  }
  if (!(error instanceof HumanAuthError)) return undefined;
  if (error.code === "auth_unconfigured") {
    return NextResponse.json(
      { error: "human_auth_unconfigured" },
      { status: 503 },
    );
  }
  if (error.code === "unauthenticated") {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

interface StoredAgentRecord {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  version: string;
  description: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  status: AgentStatus;
  marketplaceTags: string[];
  requiredTools: string[];
  approvalRequired: boolean;
  memoryScope: string;
  manifest: unknown;
  updatedAt: Date;
}

function exactArray(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function manifestEnvelopeDigest(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const integrity = (input as Record<string, unknown>).integrity;
  if (!integrity || typeof integrity !== "object" || Array.isArray(integrity)) {
    return undefined;
  }
  const digest = (integrity as Record<string, unknown>).digest;
  const algorithm = (integrity as Record<string, unknown>).algorithm;
  return algorithm === "sha256" && typeof digest === "string"
    ? digest
    : undefined;
}

function verifiedVersionMatches(
  agent: StoredAgentRecord,
  manifest: AgentManifest,
  manifestDigest: string,
): boolean {
  const parsed = AgentManifestSchema.safeParse(agent.manifest);
  if (!parsed.success) return false;
  const storedDigest = manifestEnvelopeDigest(agent.manifest);
  if (
    storedDigest !== manifestDigest ||
    agentManifestDigest(parsed.data) !== storedDigest
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
    exactArray(agent.marketplaceTags, manifest.marketplaceTags) &&
    exactArray(agent.requiredTools, manifest.requiredTools) &&
    agent.approvalRequired === manifest.approvalRequired &&
    agent.memoryScope === manifest.memoryScope
  );
}

export async function GET(request: Request) {
  const limited = rateLimit(request, 120, 60000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("agent.read");
    const tenant = await requireHumanTenant(identity);
    const agents = await db.agent.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ status: "asc" }, { name: "asc" }],
    });
    return NextResponse.json({ agents });
  } catch (error) {
    return authError(error) ?? apiError(error, "marketplace.list");
  }
}

export async function POST(request: Request) {
  const limited = rateLimit(request, 20, 60000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("agent.write");
    const tenant = await requireHumanTenant(identity);
    const manifest = AgentManifestSchema.parse(await request.json());
    const manifestDigest = agentManifestDigest(manifest);
    const storedManifest = {
      ...manifest,
      integrity: {
        algorithm: "sha256",
        digest: manifestDigest,
      },
    };
    const key = {
      tenantId_slug_version: {
        tenantId: tenant.id,
        slug: manifest.slug,
        version: manifest.version,
      },
    };
    const data = {
      name: manifest.name,
      description: manifest.description,
      systemPrompt: manifest.systemPrompt,
      modelProvider: manifest.modelProvider,
      modelName: manifest.modelName,
      marketplaceTags: manifest.marketplaceTags,
      requiredTools: manifest.requiredTools,
      approvalRequired: manifest.approvalRequired,
      memoryScope: manifest.memoryScope,
      manifest: storedManifest,
    };

    const rejectConflict = async (
      code: "verified_agent_version_immutable" | "agent_version_conflict",
      existingId: string | null,
    ) => {
      await db.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actor: identity.actorId,
          action: "agent.marketplace.write_rejected",
          metadata: {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            agentId: existingId,
            agentSlug: manifest.slug,
            agentVersion: manifest.version,
            manifestDigest,
            reason: code,
            roles: identity.roles,
          },
        },
      });
      return NextResponse.json({ error: code }, { status: 409 });
    };

    let existing = await db.agent.findUnique({ where: key });
    let agent: StoredAgentRecord;
    let writeMode: "created" | "updated" | "verified_idempotent";

    if (existing?.status === AgentStatus.VERIFIED) {
      if (!verifiedVersionMatches(existing, manifest, manifestDigest)) {
        return rejectConflict("verified_agent_version_immutable", existing.id);
      }
      agent = existing;
      writeMode = "verified_idempotent";
    } else if (existing) {
      const updated = await db.agent.updateMany({
        where: {
          id: existing.id,
          updatedAt: existing.updatedAt,
          status: { not: AgentStatus.VERIFIED },
        },
        data,
      });

      if (updated.count !== 1) {
        existing = await db.agent.findUnique({ where: key });
        if (
          existing?.status === AgentStatus.VERIFIED &&
          verifiedVersionMatches(existing, manifest, manifestDigest)
        ) {
          agent = existing;
          writeMode = "verified_idempotent";
        } else {
          return rejectConflict("agent_version_conflict", existing?.id ?? null);
        }
      } else {
        const updatedAgent = await db.agent.findUnique({ where: key });
        if (!updatedAgent) {
          throw new Error("marketplace_update_lost");
        }
        agent = updatedAgent;
        writeMode = "updated";
      }
    } else {
      try {
        agent = await db.agent.create({
          data: {
            tenantId: tenant.id,
            slug: manifest.slug,
            version: manifest.version,
            ...data,
          },
        });
        writeMode = "created";
      } catch (error) {
        existing = await db.agent.findUnique({ where: key });
        if (
          existing?.status === AgentStatus.VERIFIED &&
          verifiedVersionMatches(existing, manifest, manifestDigest)
        ) {
          agent = existing;
          writeMode = "verified_idempotent";
        } else if (existing) {
          return rejectConflict("agent_version_conflict", existing.id);
        } else {
          throw error;
        }
      }
    }

    await db.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actor: identity.actorId,
        action: "agent.marketplace.upsert",
        metadata: {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          agentId: agent.id,
          agentSlug: agent.slug,
          agentVersion: agent.version,
          manifestContractVersion: manifest.schemaVersion,
          manifestDigest,
          writeMode,
          roles: identity.roles,
        },
      },
    });
    return NextResponse.json(
      {
        agent,
        manifestDigest,
        writeMode,
        actor: {
          actorId: identity.actorId,
          tenantId: tenant.id,
          roles: identity.roles,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return authError(error) ?? apiError(error, "marketplace.upsert");
  }
}
