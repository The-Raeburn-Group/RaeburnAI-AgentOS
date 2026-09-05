import { describe, expect, it } from "vitest";
import {
  hasPermission,
  humanAuthConfigured,
  humanSessionMaxAgeSeconds,
  identityFromOidcClaims,
  normalizeRoles,
  type HumanIdentity,
} from "@/lib/admin-auth";

function identity(roles: HumanIdentity["roles"]): HumanIdentity {
  return {
    actorId: "user-1",
    tenantId: "tenant-a",
    roles,
  };
}

describe("human RBAC", () => {
  it("normalizes only recognized roles", () => {
    expect(normalizeRoles(["admin", "operator", "root", 42])).toEqual([
      "admin",
      "operator",
    ]);
    expect(normalizeRoles("viewer auditor unknown viewer")).toEqual([
      "viewer",
      "auditor",
    ]);
  });

  it("keeps administrator writes separate from operator and viewer access", () => {
    expect(hasPermission(identity(["admin"]), "agent.write")).toBe(true);
    expect(hasPermission(identity(["operator"]), "agent.write")).toBe(false);
    expect(hasPermission(identity(["viewer"]), "workflow.run")).toBe(false);
    expect(hasPermission(identity(["operator"]), "workflow.run")).toBe(true);
  });

  it("gives approvers decision rights without configuration rights", () => {
    expect(hasPermission(identity(["approver"]), "approval.decide")).toBe(true);
    expect(hasPermission(identity(["approver"]), "agent.write")).toBe(false);
    expect(hasPermission(identity(["auditor"]), "approval.decide")).toBe(false);
    expect(hasPermission(identity(["auditor"]), "audit.read")).toBe(true);
  });

  it("requires all production OIDC session inputs", () => {
    expect(
      humanAuthConfigured({
        NEXTAUTH_URL: "https://agentos.example.test",
        NEXTAUTH_SECRET: "session-secret",
        AGENTOS_OIDC_ISSUER: "https://identity.example.test",
        AGENTOS_OIDC_CLIENT_ID: "agentos",
        AGENTOS_OIDC_CLIENT_SECRET: "secret",
      }),
    ).toBe(true);

    expect(
      humanAuthConfigured({
        NEXTAUTH_URL: "https://agentos.example.test",
        NEXTAUTH_SECRET: "session-secret",
        AGENTOS_OIDC_ISSUER: "https://identity.example.test",
        AGENTOS_OIDC_CLIENT_ID: "agentos",
      }),
    ).toBe(false);
  });

  it("rejects OIDC identities without a tenant or recognized role", () => {
    expect(
      identityFromOidcClaims(
        { sub: "user-1", tenant_id: "tenant-a", roles: ["admin", "root"] },
        "tenant_id",
        "roles",
      ),
    ).toMatchObject({
      actorId: "user-1",
      tenantId: "tenant-a",
      roles: ["admin"],
    });

    expect(
      identityFromOidcClaims(
        { sub: "user-1", roles: ["admin"] },
        "tenant_id",
        "roles",
      ),
    ).toBeUndefined();
    expect(
      identityFromOidcClaims(
        { sub: "user-1", tenant_id: "tenant-a", roles: ["root"] },
        "tenant_id",
        "roles",
      ),
    ).toBeUndefined();
  });

  it("uses a bounded configurable administrator session lifetime", () => {
    expect(humanSessionMaxAgeSeconds({})).toBe(3600);
    expect(
      humanSessionMaxAgeSeconds({ AGENTOS_SESSION_MAX_AGE_SECONDS: "900" }),
    ).toBe(900);
    expect(() =>
      humanSessionMaxAgeSeconds({ AGENTOS_SESSION_MAX_AGE_SECONDS: "120" }),
    ).toThrow("invalid_human_session_max_age");
    expect(() =>
      humanSessionMaxAgeSeconds({ AGENTOS_SESSION_MAX_AGE_SECONDS: "90000" }),
    ).toThrow("invalid_human_session_max_age");
  });
});
