import { NextResponse } from "next/server";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { apiError, rateLimit } from "@/lib/http";
import { ensureDefaultTenant } from "@/lib/orchestrator";
import { AgentManifestSchema } from "@/lib/types";

function authError(error: unknown) {
  if (!(error instanceof HumanAuthError)) return undefined;
  if (error.code === "auth_unconfigured") {
    return NextResponse.json({ error: "human_auth_unconfigured" }, { status: 503 });
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
    await requireHumanPermission("agent.read");
    const tenant = await ensureDefaultTenant();
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
    const tenant = await ensureDefaultTenant();
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
    return NextResponse.json(
      {
        agent,
        actor: { actorId: identity.actorId, tenantId: identity.tenantId, roles: identity.roles },
      },
      { status: 201 },
    );
  } catch (error) {
    return authError(error) ?? apiError(error, "marketplace.upsert");
  }
}
