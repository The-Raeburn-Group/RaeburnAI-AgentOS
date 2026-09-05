import type { Tenant } from "@prisma/client";
import { db } from "@/lib/db";
import type { HumanIdentity } from "@/lib/admin-auth";

export class TenantAccessError extends Error {
  constructor(public readonly code: "tenant_not_found") {
    super(code);
    this.name = "TenantAccessError";
  }
}

export async function requireHumanTenant(identity: HumanIdentity): Promise<Tenant> {
  const tenant = await db.tenant.findFirst({
    where: {
      OR: [{ id: identity.tenantId }, { slug: identity.tenantId }],
    },
  });

  if (!tenant) throw new TenantAccessError("tenant_not_found");
  return tenant;
}
