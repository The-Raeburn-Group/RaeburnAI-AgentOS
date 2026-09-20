import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { apiError, rateLimit } from "@/lib/http";
import {
  deleteSubjectMemories,
  listSubjectMemories,
  MemoryServiceError,
} from "@/lib/memory";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

function serviceContext(
  authentication: ReturnType<typeof authenticateChainServiceRequest>,
) {
  if (!authentication.ok) return null;
  return {
    tenantReference: authentication.context.tenantId,
    actorId: authentication.context.actorId,
    requestId: authentication.context.requestId,
    roles: authentication.context.roles,
  };
}

function privacyError(error: unknown) {
  if (error instanceof MemoryServiceError) {
    if (error.code === "tenant_not_found") {
      return NextResponse.json({ error: error.code }, { status: 404 });
    }
    if (error.code === "memory_subject_forbidden") {
      return NextResponse.json({ error: error.code }, { status: 403 });
    }
    return NextResponse.json({ error: error.code }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "Invalid subject request" },
      { status: 400 },
    );
  }
  return null;
}

export async function GET(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;
  const limited = rateLimit(request, 20, 60_000);
  if (limited) return limited;

  try {
    const subjectId = new URL(request.url).searchParams.get("subjectId");
    const memories = await listSubjectMemories(
      { subjectId },
      serviceContext(authentication)!,
    );
    return NextResponse.json({
      subjectId,
      memories: memories.map((memory) => ({
        id: memory.id,
        scope: memory.scope,
        kind: memory.kind,
        key: memory.key,
        content: memory.content,
        metadata: memory.metadata,
        provenance: memory.provenance,
        sensitivity: memory.sensitivity,
        policyVersion: memory.policyVersion,
        expiresAt: memory.expiresAt,
        updatedAt: memory.updatedAt,
      })),
    });
  } catch (error) {
    return privacyError(error) ?? apiError(error, "memory.subject.export");
  }
}

export async function DELETE(request: Request) {
  const authentication = authenticateChainServiceRequest(request);
  if (!authentication.ok) return authentication.response;
  const limited = rateLimit(request, 10, 60_000);
  if (limited) return limited;

  try {
    const body = (await request.json()) as {
      subjectId?: unknown;
      reason?: unknown;
    };
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : "subject_delete";
    const deletedCount = await deleteSubjectMemories(
      { subjectId: body.subjectId },
      serviceContext(authentication)!,
      reason,
    );
    return NextResponse.json({ deletedCount });
  } catch (error) {
    return privacyError(error) ?? apiError(error, "memory.subject.delete");
  }
}
