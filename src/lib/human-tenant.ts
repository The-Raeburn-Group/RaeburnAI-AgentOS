import type { Tenant } from "@prisma/client";
import type { HumanIdentity } from "@/lib/admin-auth";
import { db } from "@/lib/db";

export type TenantReferenceMode = "id" | "slug";
type Environment = Readonly<Record<string, string | undefined>>;

export class TenantAccessError extends Error {
  constructor(
    public readonly code: "tenant_not_found" | "invalid_tenant_reference_mode",
  ) {
    super(code);
    this.name = "TenantAccessError";
  }
}

export function tenantReferenceMode(
  env: Environment = process.env,
): TenantReferenceMode {
  const raw = (env.AGENTOS_TENANT_REFERENCE_MODE ?? "id").trim().toLowerCase();
  if (raw !== "id" && raw !== "slug") {
    throw new TenantAccessError("invalid_tenant_reference_mode");
  }
  return raw;
}

export async function resolveTenantReference(
  reference: string,
  mode: TenantReferenceMode = tenantReferenceMode(),
): Promise<Tenant | null> {
  const normalized = reference.trim();
  if (!normalized) return null;
  return mode === "id"
    ? db.tenant.findUnique({ where: { id: normalized } })
    : db.tenant.findUnique({ where: { slug: normalized } });
}

export async function requireHumanTenant(
  identity: HumanIdentity,
): Promise<Tenant> {
  const tenant = await resolveTenantReference(identity.tenantId);
  if (!tenant) throw new TenantAccessError("tenant_not_found");
  return tenant;
}
