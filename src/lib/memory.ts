import type { Memory, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { resolveTenantReference } from "@/lib/human-tenant";
import {
  MEMORY_POLICY_VERSION,
  sanitizeMemoryCandidate,
  type MemoryClassification,
  type MemoryFindingType,
} from "@/lib/memory-policy";
import { JsonValueSchema, type JsonValue } from "@/lib/types";

export const MemoryWriteRequestSchema = z.object({
  scope: z.enum(["session", "workflow", "agent", "workspace", "tenant"]),
  key: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  content: z.string().min(1).max(50_000),
  metadata: z.record(JsonValueSchema).default({}),
  sensitivityLabels: z
    .array(z.string().trim().min(1).max(64))
    .max(20)
    .default([]),
  ttlSeconds: z.number().int().min(60).max(31_536_000).optional(),
});
export type MemoryWriteRequest = z.infer<typeof MemoryWriteRequestSchema>;

const MemoryKeySchema = z.object({
  scope: z.enum(["session", "workflow", "agent", "workspace", "tenant"]),
  key: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
});
export type MemoryKey = z.infer<typeof MemoryKeySchema>;

export interface MemoryExecutionContext {
  tenantReference: string;
  actorId: string;
  requestId: string;
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
    public readonly code: "tenant_not_found" | "memory_ttl_exceeds_policy",
  ) {
    super(code);
    this.name = "MemoryServiceError";
  }
}

function inputJson(value: JsonValue): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
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

function policyMetadata(summary: MemoryPolicySummary): JsonValue {
  return {
    version: summary.version,
    classification: summary.classification,
    findingTypes: summary.findingTypes,
    redactionCount: summary.redactionCount,
    sensitivityLabels: summary.sensitivityLabels,
  };
}

export async function writeMemory(
  requestInput: unknown,
  context: MemoryExecutionContext,
): Promise<Memory> {
  const request = MemoryWriteRequestSchema.parse(requestInput);
  const tenantId = await tenantIdFor(context.tenantReference);
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
        content: sanitized.content,
        metadata: inputJson(metadata),
        embedding: [],
        expiresAt,
      },
      create: {
        tenantId,
        scope: request.scope,
        key: request.key,
        content: sanitized.content,
        metadata: inputJson(metadata),
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
          key: stored.key,
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
  return memory;
}

export async function readMemory(
  keyInput: unknown,
  context: MemoryExecutionContext,
): Promise<Memory | null> {
  const key = MemoryKeySchema.parse(keyInput);
  const tenantId = await tenantIdFor(context.tenantReference);
  return db.memory.findFirst({
    where: {
      tenantId,
      scope: key.scope,
      key: key.key,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
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
      select: { id: true },
    });
    if (!existing) return false;

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
          key: key.key,
          reason: reason.slice(0, 200),
        },
      },
    });
    return true;
  });
}

export async function purgeExpiredMemories(
  tenantReference: string,
): Promise<number> {
  const tenantId = await tenantIdFor(tenantReference);
  const deleted = await db.memory.deleteMany({
    where: {
      tenantId,
      expiresAt: { lte: new Date() },
    },
  });
  return deleted.count;
}
