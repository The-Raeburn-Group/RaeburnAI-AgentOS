import type { Memory, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveTenantReference } from "@/lib/human-tenant";
import {
  MEMORY_POLICY_VERSION,
  MemoryPolicyError,
  sanitizeMemoryCandidate,
  type MemoryClassification,
  type MemoryFindingType,
} from "@/lib/memory-policy";
import { JsonValueSchema, type JsonValue } from "@/lib/types";

const MemoryScopeSchema = z.enum([
  "session",
  "workflow",
  "agent",
  "workspace",
  "tenant",
  "user",
]);
const MemoryKindSchema = z.enum([
  "context",
  "session_state",
  "user_preference",
  "tenant_context",
  "episode",
]);

const MemoryProvenanceSchema = z.object({
  sourceType: z.enum(["user", "workflow", "audit", "tool", "system"]),
  sourceId: z.string().trim().min(1).max(256),
  runId: z.string().trim().min(1).max(256).optional(),
  recordedAt: z.string().datetime().optional(),
});

export const MemoryWriteRequestSchema = z
  .object({
    scope: MemoryScopeSchema,
    kind: MemoryKindSchema.default("context"),
    key: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
    subjectId: z.string().trim().min(1).max(256).optional(),
    content: z.string().min(1).max(50_000),
    metadata: z.record(JsonValueSchema).default({}),
    provenance: MemoryProvenanceSchema.optional(),
    sensitivityLabels: z
      .array(z.string().trim().min(1).max(64))
      .max(20)
      .default([]),
    explicitConsent: z.boolean().default(false),
    ttlSeconds: z.number().int().min(60).max(31_536_000).optional(),
  })
  .superRefine((value, context) => {
    if (value.scope === "user" && !value.subjectId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subjectId"],
        message: "user-scoped memory requires subjectId",
      });
    }
    if (value.kind === "user_preference") {
      if (value.scope !== "user") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scope"],
          message: "user preference memory must use user scope",
        });
      }
      if (!value.explicitConsent) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["explicitConsent"],
          message: "user preference memory requires explicit consent",
        });
      }
    }
    if (value.kind === "tenant_context" && value.scope !== "tenant") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "tenant context memory must use tenant scope",
      });
    }
    if (
      (value.kind === "episode" || value.kind === "session_state") &&
      !value.provenance
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance"],
        message: `${value.kind} memory requires provenance`,
      });
    }
  });
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequestSchema>;

export const MemoryKeySchema = z.object({
  scope: MemoryScopeSchema,
  key: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
});
export type MemoryKey = z.infer<typeof MemoryKeySchema>;

const SubjectRequestSchema = z.object({
  subjectId: z.string().trim().min(1).max(256),
});
export type SubjectRequest = z.infer<typeof SubjectRequestSchema>;

export interface MemoryExecutionContext {
  tenantReference: string;
  actorId: string;
  requestId: string;
  roles?: string[];
}

export interface MemoryPolicySummary {
  version: typeof MEMORY_POLICY_VERSION;
  classification: MemoryClassification;
  findingTypes: MemoryFindingType[];
  redactionCount: number;
  sensitivityLabels: string[];
}

export class MemoryServiceError extends Error {
  constructor(
    public readonly code:
      | "tenant_not_found"
      | "memory_ttl_exceeds_policy"
      | "memory_subject_forbidden"
      | "memory_subject_required"
      | "memory_not_found",
  ) {
    super(code);
    this.name = "MemoryServiceError";
  }
}

function inputJson(value: JsonValue): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function tenantIdFor(reference: string): Promise<string> {
  const tenant = await resolveTenantReference(reference);
  if (!tenant) throw new MemoryServiceError("tenant_not_found");
  return tenant.id;
}

function ttlSecondsFor(request: MemoryWriteRequest): number {
  const ttlSeconds = request.ttlSeconds ?? env.MEMORY_DEFAULT_TTL_SECONDS;
  if (ttlSeconds > env.MEMORY_MAX_TTL_SECONDS) {
    throw new MemoryServiceError("memory_ttl_exceeds_policy");
  }
  return ttlSeconds;
}

function privileged(context: MemoryExecutionContext): boolean {
  return (context.roles ?? []).some((role) =>
    ["admin", "memory.admin", "privacy.admin"].includes(role),
  );
}

function enforceSubjectAccess(
  subjectId: string | null | undefined,
  context: MemoryExecutionContext,
): void {
  if (!subjectId) return;
  if (subjectId === context.actorId || privileged(context)) return;
  throw new MemoryServiceError("memory_subject_forbidden");
}

function policyMetadata(summary: MemoryPolicySummary): JsonValue {
  return {
    version: summary.version,
    classification: summary.classification,
    findingTypes: summary.findingTypes,
    redactionCount: summary.redactionCount,
    sensitivityLabels: summary.sensitivityLabels,
  };
}

function publicMemory(memory: Memory): Memory {
  return memory;
}

export async function writeMemory(
  requestInput: unknown,
  context: MemoryExecutionContext,
): Promise<Memory> {
  const request = MemoryWriteRequestSchema.parse(requestInput);
  const tenantId = await tenantIdFor(context.tenantReference);
  enforceSubjectAccess(request.subjectId, context);

  const ttlSeconds = ttlSecondsFor(request);
  const sanitized = sanitizeMemoryCandidate({
    content: request.content,
    metadata: request.metadata,
    sensitivityLabels: request.sensitivityLabels,
  });
  const summary: MemoryPolicySummary = {
    version: MEMORY_POLICY_VERSION,
    classification: sanitized.classification,
    findingTypes: sanitized.findingTypes,
    redactionCount: sanitized.redactionCount,
    sensitivityLabels: sanitized.sensitivityLabels,
  };
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const metadata: JsonValue = {
    ...sanitized.metadata,
    _memoryPolicy: policyMetadata(summary),
  };
  const provenance: JsonValue = request.provenance
    ? {
        ...request.provenance,
        recordedAt: request.provenance.recordedAt ?? new Date().toISOString(),
      }
    : {};

  const memory = await db.$transaction(async (tx) => {
    const stored = await tx.memory.upsert({
      where: {
        tenantId_scope_key: {
          tenantId,
          scope: request.scope,
          key: request.key,
        },
      },
      update: {
        kind: request.kind,
        subjectId: request.subjectId ?? null,
        content: sanitized.content,
        metadata: inputJson(metadata),
        provenance: inputJson(provenance),
        sensitivity: sanitized.classification,
        policyVersion: MEMORY_POLICY_VERSION,
        embedding: [],
        expiresAt,
      },
      create: {
        tenantId,
        scope: request.scope,
        kind: request.kind,
        key: request.key,
        subjectId: request.subjectId ?? null,
        content: sanitized.content,
        metadata: inputJson(metadata),
        provenance: inputJson(provenance),
        sensitivity: sanitized.classification,
        policyVersion: MEMORY_POLICY_VERSION,
        embedding: [],
        expiresAt,
      },
    });

    await tx.auditEvent.create({
      data: {
        tenantId,
        actor: context.actorId,
        action: "memory.written",
        metadata: {
          requestId: context.requestId,
          memoryId: stored.id,
          scope: stored.scope,
          kind: stored.kind,
          key: stored.key,
          subjectId: stored.subjectId,
          expiresAt: expiresAt.toISOString(),
          policyVersion: MEMORY_POLICY_VERSION,
          classification: sanitized.classification,
          findingTypes: sanitized.findingTypes,
          redactionCount: sanitized.redactionCount,
        },
      },
    });
    return stored;
  });

  return publicMemory(memory);
}

export async function readMemory(
  keyInput: unknown,
  context: MemoryExecutionContext,
): Promise<Memory | null> {
  const key = MemoryKeySchema.parse(keyInput);
  const tenantId = await tenantIdFor(context.tenantReference);
  const memory = await db.memory.findFirst({
    where: {
      tenantId,
      scope: key.scope,
      key: key.key,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  if (!memory) return null;
  enforceSubjectAccess(memory.subjectId, context);
  return publicMemory(memory);
}

export async function deleteMemory(
  keyInput: unknown,
  context: MemoryExecutionContext,
  reason = "explicit_delete",
): Promise<boolean> {
  const key = MemoryKeySchema.parse(keyInput);
  const tenantId = await tenantIdFor(context.tenantReference);

  return db.$transaction(async (tx) => {
    const existing = await tx.memory.findUnique({
      where: {
        tenantId_scope_key: {
          tenantId,
          scope: key.scope,
          key: key.key,
        },
      },
    });
    if (!existing) return false;
    enforceSubjectAccess(existing.subjectId, context);

    await tx.memory.delete({ where: { id: existing.id } });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actor: context.actorId,
        action: "memory.deleted",
        metadata: {
          requestId: context.requestId,
          memoryId: existing.id,
          scope: key.scope,
          kind: existing.kind,
          key: key.key,
          subjectId: existing.subjectId,
          reason: reason.slice(0, 200),
        },
      },
    });
    return true;
  });
}

export async function listSubjectMemories(
  subjectInput: unknown,
  context: MemoryExecutionContext,
): Promise<Memory[]> {
  const { subjectId } = SubjectRequestSchema.parse(subjectInput);
  enforceSubjectAccess(subjectId, context);
  const tenantId = await tenantIdFor(context.tenantReference);
  return db.memory.findMany({
    where: {
      tenantId,
      subjectId,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ kind: "asc" }, { key: "asc" }],
  });
}

export async function deleteSubjectMemories(
  subjectInput: unknown,
  context: MemoryExecutionContext,
  reason = "subject_delete",
): Promise<number> {
  const { subjectId } = SubjectRequestSchema.parse(subjectInput);
  enforceSubjectAccess(subjectId, context);
  const tenantId = await tenantIdFor(context.tenantReference);

  return db.$transaction(async (tx) => {
    const rows = await tx.memory.findMany({
      where: { tenantId, subjectId },
      select: { id: true },
    });
    if (rows.length === 0) return 0;

    const deleted = await tx.memory.deleteMany({
      where: { tenantId, subjectId },
    });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actor: context.actorId,
        action: "memory.subject_deleted",
        metadata: {
          requestId: context.requestId,
          subjectId,
          reason: reason.slice(0, 200),
          deletedCount: deleted.count,
        },
      },
    });
    return deleted.count;
  });
}

export async function purgeExpiredMemories(
  tenantReference: string,
  actorId = "memory-retention-worker",
): Promise<number> {
  const tenantId = await tenantIdFor(tenantReference);
  const now = new Date();

  return db.$transaction(async (tx) => {
    const expired = await tx.memory.findMany({
      where: {
        tenantId,
        expiresAt: { lte: now },
      },
      select: { id: true },
    });
    if (expired.length === 0) return 0;

    const deleted = await tx.memory.deleteMany({
      where: {
        tenantId,
        expiresAt: { lte: now },
      },
    });
    await tx.auditEvent.create({
      data: {
        tenantId,
        actor: actorId,
        action: "memory.retention_purged",
        metadata: {
          policyVersion: MEMORY_POLICY_VERSION,
          deletedCount: deleted.count,
          purgedAt: now.toISOString(),
        },
      },
    });
    return deleted.count;
  });
}

export { MemoryPolicyError };
