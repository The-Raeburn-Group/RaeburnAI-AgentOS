import { NextResponse } from "next/server";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";
import { apiError, rateLimit } from "@/lib/http";
import { AgentManifestSchema } from "@/lib/types";

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
    const agent = await db.agent.upsert({
      where: {
        tenantId_slug_version: {
          tenantId: tenant.id,
          slug: manifest.slug,
          version: manifest.version,
        },
      },
      update: {
        name: manifest.name,
        description: manifest.description,
        systemPrompt: manifest.systemPrompt,
        modelProvider: manifest.modelProvider,
        modelName: manifest.modelName,
        marketplaceTags: manifest.marketplaceTags,
        requiredTools: manifest.requiredTools,
        approvalRequired: manifest.approvalRequired,
        memoryScope: manifest.memoryScope,
        manifest,
      },
      create: {
        tenantId: tenant.id,
        name: manifest.name,
        slug: manifest.slug,
        version: manifest.version,
        description: manifest.description,
        systemPrompt: manifest.systemPrompt,
        modelProvider: manifest.modelProvider,
        modelName: manifest.modelName,
        marketplaceTags: manifest.marketplaceTags,
        requiredTools: manifest.requiredTools,
        approvalRequired: manifest.approvalRequired,
        memoryScope: manifest.memoryScope,
        manifest,
      },
    });
    await db.auditEvent.create({
      data: {
        actor: identity.actorId,
        action: "agent.marketplace.upsert",
        metadata: {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          agentId: agent.id,
          agentSlug: agent.slug,
          agentVersion: agent.version,
          roles: identity.roles,
        },
      },
    });
    return NextResponse.json(
      {
        agent,
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
