import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { apiError, rateLimit } from "@/lib/http";
import {
  deleteMemory,
  MemoryPolicyError,
  MemoryServiceError,
  readMemory,
  writeMemory,
} from "@/lib/memory";
import { authenticateChainServiceRequest } from "@/lib/service-auth";

function contextFrom(request: Request) {
  return authenticateChainServiceRequest(request);
}

function memoryError(error: unknown) {
  if (error instanceof MemoryPolicyError) {
    return NextResponse.json({ error: error.code }, { status: 400 });
  }
  if (error instanceof MemoryServiceError) {
    switch (error.code) {
      case "tenant_not_found":
        return NextResponse.json({ error: error.code }, { status: 404 });
      case "memory_subject_forbidden":
        return NextResponse.json({ error: error.code }, { status: 403 });
      default:
        return NextResponse.json({ error: error.code }, { status: 400 });
    }
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return NextResponse.json(
      { error: "Invalid memory payload" },
      { status: 400 },
    );
  }
  return null;
}

function executionContext(authentication: ReturnType<typeof contextFrom>) {
  if (!authentication.ok) return null;
  return {
    tenantReference: authentication.context.tenantId,
    actorId: authentication.context.actorId,
    requestId: authentication.context.requestId,
    roles: authentication.context.roles,
  };
}

export async function POST(request: Request) {
  const authentication = contextFrom(request);
  if (!authentication.ok) return authentication.response;
  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const memory = await writeMemory(
      await request.json(),
      executionContext(authentication)!,
    );
    return NextResponse.json(
      {
        memory: {
          id: memory.id,
          scope: memory.scope,
          kind: memory.kind,
          key: memory.key,
          subjectId: memory.subjectId,
          content: memory.content,
          metadata: memory.metadata,
          provenance: memory.provenance,
          sensitivity: memory.sensitivity,
          policyVersion: memory.policyVersion,
          expiresAt: memory.expiresAt,
          updatedAt: memory.updatedAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return memoryError(error) ?? apiError(error, "memory.write");
  }
}

export async function GET(request: Request) {
  const authentication = contextFrom(request);
  if (!authentication.ok) return authentication.response;
  const limited = rateLimit(request, 60, 60_000);
  if (limited) return limited;

  const url = new URL(request.url);
  try {
    const memory = await readMemory(
      {
        scope: url.searchParams.get("scope"),
        key: url.searchParams.get("key"),
      },
      executionContext(authentication)!,
    );
    if (!memory) {
      return NextResponse.json({ error: "memory_not_found" }, { status: 404 });
    }
    return NextResponse.json({
      memory: {
        id: memory.id,
        scope: memory.scope,
        kind: memory.kind,
        key: memory.key,
        subjectId: memory.subjectId,
        content: memory.content,
        metadata: memory.metadata,
        provenance: memory.provenance,
        sensitivity: memory.sensitivity,
        policyVersion: memory.policyVersion,
        expiresAt: memory.expiresAt,
        updatedAt: memory.updatedAt,
      },
    });
  } catch (error) {
    return memoryError(error) ?? apiError(error, "memory.read");
  }
}

export async function DELETE(request: Request) {
  const authentication = contextFrom(request);
  if (!authentication.ok) return authentication.response;
  const limited = rateLimit(request, 30, 60_000);
  if (limited) return limited;

  try {
    const body = (await request.json()) as {
      scope?: unknown;
      key?: unknown;
      reason?: unknown;
    };
    const reason =
      typeof body.reason === "string" && body.reason.trim()
        ? body.reason.trim().slice(0, 200)
        : "explicit_delete";
    const deleted = await deleteMemory(
      { scope: body.scope, key: body.key },
      executionContext(authentication)!,
      reason,
    );
    if (!deleted) {
      return NextResponse.json({ error: "memory_not_found" }, { status: 404 });
    }
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return memoryError(error) ?? apiError(error, "memory.delete");
  }
}
