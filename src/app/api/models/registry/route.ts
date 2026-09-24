import { NextResponse } from "next/server";
import { ZodError } from "zod";
import registryFixture from "../../../../../config/model-registry.v1.json";
import { db } from "@/lib/db";
import { apiError, rateLimit } from "@/lib/http";
import {
  ModelRegistryError,
  ModelSelectionRequestSchema,
  evaluateModelRegistryFreshness,
  parseModelRegistry,
  selectRegistryModel,
} from "@/lib/model-registry";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

const registry = parseModelRegistry(registryFixture);

function registryError(error: unknown) {
  if (error instanceof ModelRegistryError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.code === "no_eligible_model" ? 422 : 400 },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_model_selection_request" },
      { status: 400 },
    );
  }
  return null;
}

async function requireTenant(tenantId: string) {
  return db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, slug: true },
  });
}

export async function GET(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 120, 60_000);
  if (limited) return limited;

  try {
    const tenant = await requireTenant(authentication.context.tenantId);
    if (!tenant) {
      return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
    }
    const freshness = evaluateModelRegistryFreshness(registry);
    return NextResponse.json({
      contractVersion: registry.contractVersion,
      registryVersion: registry.registryVersion,
      registryDigest: freshness.registryDigest,
      generatedAt: registry.generatedAt,
      entries: registry.entries,
      freshness: {
        evaluatedAt: freshness.evaluatedAt,
        findings: freshness.findings,
      },
    });
  } catch (error) {
    return registryError(error) ?? apiError(error, "models.registry");
  }
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 60, 60_000);
  if (limited) return limited;

  try {
    const tenant = await requireTenant(authentication.context.tenantId);
    if (!tenant) {
      return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
    }
    const selectionRequest = ModelSelectionRequestSchema.parse(
      await request.json(),
    );

    try {
      const selection = selectRegistryModel(registry, selectionRequest);
      await db.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actor: authentication.context.actorId,
          action: "models.registry.selected",
          metadata: {
            requestId: authentication.context.requestId,
            registryDigest: selection.registryDigest,
            modelEntryId: selection.entry.id,
            provider: selection.entry.provider,
            model: selection.entry.model,
            revision: selection.entry.revision,
            score: selection.score,
          },
        },
      });
      return NextResponse.json({ selection });
    } catch (error) {
      if (
        error instanceof ModelRegistryError &&
        error.code === "no_eligible_model"
      ) {
        await db.auditEvent.create({
          data: {
            tenantId: tenant.id,
            actor: authentication.context.actorId,
            action: "models.registry.selection_rejected",
            metadata: {
              requestId: authentication.context.requestId,
              reason: error.code,
            },
          },
        });
      }
      throw error;
    }
  } catch (error) {
    return registryError(error) ?? apiError(error, "models.select");
  }
}
