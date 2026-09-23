import { NextResponse } from "next/server";
import {
  EvaluationCandidateError,
  captureEvaluationCandidate,
} from "@/lib/evaluation-candidates";
import { apiError, rateLimit } from "@/lib/http";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

function candidateError(error: unknown) {
  if (!(error instanceof EvaluationCandidateError)) return undefined;
  if (error.code === "tenant_not_found") {
    return NextResponse.json({ error: error.code }, { status: 404 });
  }
  return NextResponse.json(
    { error: error.code, detail: error.detail ?? null },
    { status: 422 },
  );
}

export async function POST(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;

  const limited = rateLimit(request, 120, 60_000);
  if (limited) return limited;

  if (\n    !(request.headers.get("content-type") ?? "").includes("application/json")\n  ) {
    return NextResponse.json(
      { error: "application_json_required" },
      { status: 415 },
    );
  }

  try {
    const result = await captureEvaluationCandidate(await request.json(), {
      tenantReference: authentication.context.tenantId,
      actorId: authentication.context.actorId,
      requestId: authentication.context.requestId,
    });
    return NextResponse.json(
      { ...result, requestId: authentication.context.requestId },
      { status: result.deduplicated ? 200 : 201 },
    );
  } catch (error) {
    return (\n      candidateError(error) ?? apiError(error, "evaluation.candidates.ingest")\n    );
  }
}
