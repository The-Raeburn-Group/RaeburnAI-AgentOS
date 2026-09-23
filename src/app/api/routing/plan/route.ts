import { AgentStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { db } from "@/lib/db";
import { apiError, rateLimit } from "@/lib/http";
import {
  RoutingPolicyError,
  RoutingPlanRequestSchema,
  planExpertRoute,
  verifyStoredAgentManifest,
} from "@/lib/routing-policy";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

function routingError(error: unknown) {
  if (error instanceof RoutingPolicyError) {
    const integrityErrors = new Set([
      "duplicate_expert_slug",
      "manifest_integrity_invalid",
      "manifest_identity_mismatch",
    ]);
    return NextResponse.json(
      { error: error.code, detail: error.detail ?? null },
      { status: integrityErrors.has(error.code) ? 409 : 422 },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_routing_request" },
      { status: 400 },
    );
  }
  return null;
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 60, 60_000);
  if (limited) return limited;

  try {
    const routingRequest = RoutingPlanRequestSchema.parse(await request.json());
    const tenantId = authentication.context.tenantId;
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) {
      return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
    }

    const agents = await db.agent.findMany({
      where: {
        tenantId,
        status: AgentStatus.VERIFIED,
      },
      orderBy: [{ slug: "asc" }, { version: "desc" }],
    });

    const manifests = agents.map((agent) =>
      verifyStoredAgentManifest(agent.manifest, {
        slug: agent.slug,
        version: agent.version,
        systemPrompt: agent.systemPrompt,
        modelProvider: agent.modelProvider,
        modelName: agent.modelName,
        approvalRequired: agent.approvalRequired,
      }),
    );
    const plan = planExpertRoute(routingRequest, manifests);

    await db.auditEvent.create({
      data: {
        tenantId,
        actor: authentication.context.actorId,
        action: "routing.plan.created",
        metadata: {
          requestId: authentication.context.requestId,
          contractVersion: plan.contractVersion,
          primaryIntent: plan.primaryIntent,
          intents: plan.intents,
          riskTier: plan.riskTier,
          mode: plan.mode,
          strictness: plan.strictness,
          primaryAgents: plan.primaryAgents,
          adjudicator: plan.adjudicator ?? null,
          requiresHumanApproval: plan.requiresHumanApproval,
        },
      },
    });

    return NextResponse.json({
      plan,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
      },
    });
  } catch (error) {
    return routingError(error) ?? apiError(error, "routing.plan");
  }
}
