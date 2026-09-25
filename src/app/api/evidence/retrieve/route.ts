import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { db } from "@/lib/db";
import {
  KgEvidenceClientError,
  retrieveKnowledgeEvidence,
} from "@/lib/kg-evidence-client";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

const RetrievalRequestSchema = z.object({
  query: z.string().trim().min(1).max(8_000),
  limit: z.number().int().min(1).max(50).default(10),
  retrievalMode: z.enum(["vector", "lexical", "hybrid"]).default("hybrid"),
  candidateMultiplier: z.number().int().min(1).max(10).default(4),
  rerank: z.boolean().default(true),
  includeGraph: z.boolean().default(false),
  graphDepth: z.number().int().min(0).max(3).default(0),
});

function retrievalError(error: unknown) {
  if (error instanceof KgEvidenceClientError) {
    const status =
      error.code === "unconfigured" || error.code === "insecure_base_url"
        ? 503
        : error.code === "invalid_request"
          ? 400
          : 502;
    return NextResponse.json(
      { error: error.code, detail: error.detail ?? null },
      { status },
    );
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "invalid_evidence_retrieval_request" },
      { status: 400 },
    );
  }
  return null;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const payload = RetrievalRequestSchema.parse(await request.json());
    const tenantId = authentication.context.tenantId;
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true },
    });
    if (!tenant) {
      return NextResponse.json({ error: "tenant_not_found" }, { status: 404 });
    }

    const result = await retrieveKnowledgeEvidence({
      workspaceId: tenantId,
      actorId: authentication.context.actorId,
      roles: authentication.context.roles,
      query: payload.query,
      limit: payload.limit,
      retrievalMode: payload.retrievalMode,
      candidateMultiplier: payload.candidateMultiplier,
      rerank: payload.rerank,
      includeGraph: payload.includeGraph,
      graphDepth: payload.graphDepth,
      signal: request.signal,
    });

    await db.auditEvent.create({
      data: {
        tenantId,
        actor: authentication.context.actorId,
        action: "evidence.retrieval.completed",
        metadata: {
          requestId: authentication.context.requestId,
          contractVersion: result.bundle.contract_version,
          bundleDigest: result.bundle.bundle_sha256,
          queryDigest: sha256Text(payload.query),
          sourceCount: result.trustedSources.length,
          retrievalMode: payload.retrievalMode,
          rerank: payload.rerank,
          includeGraph: payload.includeGraph,
          graphDepth: payload.includeGraph ? payload.graphDepth : 0,
        },
      },
    });

    return NextResponse.json({
      evidence: result.bundle,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
      },
    });
  } catch (error) {
    return retrievalError(error) ?? apiError(error, "evidence.retrieval");
  }
}
