import { describe, expect, it } from "vitest";
import { projectFailureAuditEvent } from "@/lib/quality-loop";

describe("quality loop failure projection", () => {
  it("classifies failures and redacts personal identifiers", () => {
    const projected = projectFailureAuditEvent({
      id: "event-1",
      tenantId: "tenant-1",
      runId: "run-1",
      action: "workflow.job.dead_lettered",
      metadata: {
        error: "Provider failed while contacting alex@example.com",
        attempts: 3,
      },
      createdAt: new Date("2026-09-23T12:00:00.000Z"),
    });

    expect(projected.failureKind).toBe("provider");
    expect(projected.severity).toBe("high");
    expect(projected.summary).toContain("[REDACTED:EMAIL]");
    expect(projected.metadata).toMatchObject({
      redactionCount: 2,
      sourceEventId: "event-1",
    });
    expect(projected.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deduplicates equivalent failure signatures independently of event ids", () => {
    const base = {
      tenantId: "tenant-1",
      runId: "run-1",
      action: "agent.failed",
      metadata: { error: "schema validation failed" },
      createdAt: new Date("2026-09-23T12:00:00.000Z"),
    };
    const first = projectFailureAuditEvent({ ...base, id: "event-1" });
    const second = projectFailureAuditEvent({ ...base, id: "event-2" });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.failureKind).toBe("validation");
  });

  it("keeps adjudication rejection as its own failure class", () => {
    const projected = projectFailureAuditEvent({
      id: "event-3",
      tenantId: "tenant-1",
      runId: "run-2",
      action: "workflow.adjudication.rejected",
      metadata: { error: "invalid adjudication result" },
      createdAt: new Date("2026-09-23T12:00:00.000Z"),
    });
    expect(projected.failureKind).toBe("adjudication");
  });

  it("rejects non-failure audit actions", () => {
    expect(() =>
      projectFailureAuditEvent({
        id: "event-4",
        tenantId: "tenant-1",
        runId: null,
        action: "workflow.completed",
        metadata: {},
        createdAt: new Date(),
      }),
    ).toThrow("unsupported quality failure action");
  });
});
