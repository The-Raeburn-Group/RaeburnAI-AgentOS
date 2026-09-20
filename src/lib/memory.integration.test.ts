import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  deleteSubjectMemories,
  listSubjectMemories,
  MemoryServiceError,
  purgeExpiredMemories,
  readMemory,
  writeMemory,
} from "@/lib/memory";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const tenantAId = "memory-policy-tenant-a";
const tenantBId = "memory-policy-tenant-b";

function context(
  tenantReference = tenantAId,
  actorId = "user-a",
  roles: string[] = [],
) {
  return {
    tenantReference,
    actorId,
    requestId: `memory-request-${tenantReference}-${actorId}`,
    roles,
  };
}

async function clean() {
  await db.tenant.deleteMany({
    where: { id: { in: [tenantAId, tenantBId] } },
  });
}

describeWithDatabase("durable memory policy", () => {
  beforeAll(async () => {
    await clean();
    await db.tenant.createMany({
      data: [
        { id: tenantAId, slug: tenantAId, name: "Memory tenant A" },
        { id: tenantBId, slug: tenantBId, name: "Memory tenant B" },
      ],
    });
  });

  afterAll(async () => {
    await clean();
  });

  it("redacts before persistence and keeps audit evidence free of raw sensitive values", async () => {
    const memory = await writeMemory(
      {
        scope: "session",
        kind: "session_state",
        key: "session:alpha",
        content:
          "Contact alice@example.com on +44 7700 900123; api_key=super-secret-key-123.",
        metadata: {
          email: "alice@example.com",
          nested: { token: "raw-token-value" },
        },
        provenance: {
          sourceType: "workflow",
          sourceId: "workflow-run-1",
          runId: "workflow-run-1",
        },
        ttlSeconds: 3600,
      },
      context(),
    );

    expect(memory.content).not.toContain("alice@example.com");
    expect(memory.content).not.toContain("super-secret-key-123");
    expect(JSON.stringify(memory.metadata)).not.toContain("raw-token-value");
    expect(memory.sensitivity).toBe("sensitive");
    expect(memory.policyVersion).toBe("raeburnai.memory-policy.v1");
    expect(memory.expiresAt).toBeInstanceOf(Date);

    const persisted = await db.memory.findUniqueOrThrow({
      where: {
        tenantId_scope_ownerKey_key: {
          tenantId: tenantAId,
          scope: "session",
          ownerKey: "__shared__",
          key: "session:alpha",
        },
      },
    });
    expect(persisted.content).toBe(memory.content);

    const audit = await db.auditEvent.findFirstOrThrow({
      where: {
        tenantId: tenantAId,
        action: "memory.written",
      },
      orderBy: { createdAt: "desc" },
    });
    const auditText = JSON.stringify(audit.metadata);
    expect(auditText).toContain("redactionCount");
    expect(auditText).not.toContain("alice@example.com");
    expect(auditText).not.toContain("super-secret-key-123");
    expect(auditText).not.toContain("raw-token-value");
  });

  it("requires explicit consent and self ownership for user preference memory", async () => {
    await expect(
      writeMemory(
        {
          scope: "user",
          kind: "user_preference",
          key: "preference:timezone",
          subjectId: "user-a",
          content: "Europe/London",
          explicitConsent: false,
        },
        context(),
      ),
    ).rejects.toThrow("user preference memory requires explicit consent");

    await expect(
      writeMemory(
        {
          scope: "user",
          kind: "user_preference",
          key: "preference:timezone",
          subjectId: "user-b",
          content: "Europe/London",
          explicitConsent: true,
        },
        context(),
      ),
    ).rejects.toMatchObject({
      code: "memory_subject_forbidden",
    });

    const saved = await writeMemory(
      {
        scope: "user",
        kind: "user_preference",
        key: "preference:timezone",
        subjectId: "user-a",
        content: "Europe/London",
        explicitConsent: true,
      },
      context(),
    );
    expect(saved.subjectId).toBe("user-a");
    expect(saved.kind).toBe("user_preference");

    const secondUser = await writeMemory(
      {
        scope: "user",
        kind: "user_preference",
        key: "preference:timezone",
        subjectId: "user-b",
        content: "Europe/Paris",
        explicitConsent: true,
      },
      context(tenantAId, "user-b"),
    );
    expect(secondUser.subjectId).toBe("user-b");
    expect(
      await db.memory.count({
        where: {
          tenantId: tenantAId,
          scope: "user",
          key: "preference:timezone",
        },
      }),
    ).toBe(2);
  });

  it("upserts deterministically and keeps same keys isolated between tenants", async () => {
    await writeMemory(
      {
        scope: "tenant",
        kind: "tenant_context",
        key: "policy:release",
        content: "Tenant A release policy v1",
      },
      context(),
    );
    const updated = await writeMemory(
      {
        scope: "tenant",
        kind: "tenant_context",
        key: "policy:release",
        content: "Tenant A release policy v2",
      },
      context(),
    );
    await writeMemory(
      {
        scope: "tenant",
        kind: "tenant_context",
        key: "policy:release",
        content: "Tenant B release policy",
      },
      context(tenantBId, "user-b"),
    );

    expect(updated.content).toBe("Tenant A release policy v2");
    expect(
      await db.memory.count({
        where: {
          tenantId: tenantAId,
          scope: "tenant",
          key: "policy:release",
        },
      }),
    ).toBe(1);

    const a = await readMemory(
      { scope: "tenant", key: "policy:release" },
      context(),
    );
    const b = await readMemory(
      { scope: "tenant", key: "policy:release" },
      context(tenantBId, "user-b"),
    );
    expect(a?.content).toBe("Tenant A release policy v2");
    expect(b?.content).toBe("Tenant B release policy");
  });

  it("requires provenance for episodic memory and preserves the minimum audit link", async () => {
    await expect(
      writeMemory(
        {
          scope: "workflow",
          kind: "episode",
          key: "episode:missing-provenance",
          content: "Completed a governed action.",
        },
        context(),
      ),
    ).rejects.toThrow("episode memory requires provenance");

    const episode = await writeMemory(
      {
        scope: "workflow",
        kind: "episode",
        key: "episode:approved-release",
        content: "Release approval was completed successfully.",
        provenance: {
          sourceType: "audit",
          sourceId: "audit-event-123",
          runId: "run-123",
        },
      },
      context(),
    );

    expect(episode.kind).toBe("episode");
    expect(episode.provenance).toMatchObject({
      sourceType: "audit",
      sourceId: "audit-event-123",
      runId: "run-123",
    });
  });

  it("hides expired memory and purges it with an audit event", async () => {
    const memory = await writeMemory(
      {
        scope: "session",
        kind: "session_state",
        key: "session:expired",
        content: "Transient state.",
        provenance: { sourceType: "system", sourceId: "test-expiry" },
        ttlSeconds: 60,
      },
      context(),
    );
    await db.memory.update({
      where: { id: memory.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(
      await readMemory({ scope: "session", key: "session:expired" }, context()),
    ).toBeNull();

    const purged = await purgeExpiredMemories(tenantAId);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(
      await db.auditEvent.findFirst({
        where: {
          tenantId: tenantAId,
          action: "memory.retention_purged",
        },
      }),
    ).not.toBeNull();
  });

  it("exports and deletes only the authenticated subject unless a privacy admin acts", async () => {
    await writeMemory(
      {
        scope: "user",
        kind: "user_preference",
        key: "preference:language",
        subjectId: "user-a",
        content: "English",
        explicitConsent: true,
      },
      context(),
    );
    await writeMemory(
      {
        scope: "user",
        kind: "user_preference",
        key: "preference:language",
        subjectId: "user-b",
        content: "French",
        explicitConsent: true,
      },
      context(tenantAId, "user-b"),
    );

    const own = await listSubjectMemories({ subjectId: "user-a" }, context());
    expect(own.every((memory) => memory.subjectId === "user-a")).toBe(true);

    await expect(
      listSubjectMemories({ subjectId: "user-b" }, context()),
    ).rejects.toBeInstanceOf(MemoryServiceError);

    const deleted = await deleteSubjectMemories(
      { subjectId: "user-b" },
      context(tenantAId, "privacy-operator", ["privacy.admin"]),
      "verified_dsar_delete",
    );
    expect(deleted).toBe(1);
    expect(
      await db.memory.count({
        where: { tenantId: tenantAId, subjectId: "user-b" },
      }),
    ).toBe(0);
    expect(
      await db.memory.count({
        where: { tenantId: tenantAId, subjectId: "user-a" },
      }),
    ).toBeGreaterThan(0);
  });
});
