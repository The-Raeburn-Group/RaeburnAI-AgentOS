import { NextResponse } from "next/server";
import { z } from "zod";
import { HumanAuthError, requireHumanPermission } from "@/lib/admin-auth";
import {
  expertCatalogDigest,
  listExpertPackSummaries,
} from "@/lib/expert-catalog";
import {
  ExpertCatalogInstallError,
  installExpertCatalogDraft,
} from "@/lib/expert-catalog-store";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";
import { apiError, rateLimit } from "@/lib/http";

const InstallRequestSchema = z.object({
  slug: z.string().trim().min(1).max(128),
});

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

function installError(error: unknown) {
  if (!(error instanceof ExpertCatalogInstallError)) return undefined;
  if (error.code === "unknown_expert_pack") {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  return NextResponse.json({ error: error.code }, { status: 409 });
}

export async function GET(request: Request) {
  const limited = rateLimit(request, 120, 60_000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("agent.read");
    const tenant = await requireHumanTenant(identity);
    const requestedSlug = new URL(request.url).searchParams.get("slug");
    const summaries = listExpertPackSummaries();
    const packs = requestedSlug
      ? summaries.filter((pack) => pack.slug === requestedSlug)
      : summaries;

    if (requestedSlug && packs.length === 0) {
      return NextResponse.json(
        { error: "unknown_expert_pack" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      contractVersion: "raeburnai.expert-catalog.v1",
      catalogVersion: "0.1.0",
      catalogDigest: expertCatalogDigest(),
      tenant: { id: tenant.id, slug: tenant.slug },
      expertCount: summaries.length,
      totalSeedCases: summaries.reduce(
        (sum, pack) => sum + pack.seedCaseCount,
        0,
      ),
      packs,
    });
  } catch (error) {
    return authError(error) ?? apiError(error, "expert.catalog.list");
  }
}

export async function POST(request: Request) {
  const limited = rateLimit(request, 20, 60_000);
  if (limited) return limited;

  try {
    const identity = await requireHumanPermission("agent.write");
    const tenant = await requireHumanTenant(identity);
    const body = InstallRequestSchema.parse(await request.json());
    const result = await installExpertCatalogDraft({
      tenantId: tenant.id,
      actorId: identity.actorId,
      slug: body.slug,
    });

    return NextResponse.json(
      {
        ...result,
        lifecycle: "development",
        activated: result.agent.status !== "DRAFT",
      },
      { status: result.mode === "created_draft" ? 201 : 200 },
    );
  } catch (error) {
    return (
      authError(error) ??
      installError(error) ??
      apiError(error, "expert.catalog.install")
    );
  }
}
