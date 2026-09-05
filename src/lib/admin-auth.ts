import {
  getServerSession,
  type NextAuthOptions,
  type Session,
} from "next-auth";
import type { JWT } from "next-auth/jwt";

export const humanRoles = [
  "admin",
  "operator",
  "approver",
  "auditor",
  "viewer",
] as const;
export type HumanRole = (typeof humanRoles)[number];

export type HumanPermission =
  | "agent.read"
  | "agent.write"
  | "workflow.read"
  | "workflow.run"
  | "approval.read"
  | "approval.decide"
  | "audit.read"
  | "metrics.read"
  | "settings.write";

const rolePermissions: Record<HumanRole, readonly HumanPermission[]> = {
  admin: [
    "agent.read",
    "agent.write",
    "workflow.read",
    "workflow.run",
    "approval.read",
    "approval.decide",
    "audit.read",
    "metrics.read",
    "settings.write",
  ],
  operator: [
    "agent.read",
    "workflow.read",
    "workflow.run",
    "approval.read",
    "metrics.read",
  ],
  approver: [
    "agent.read",
    "workflow.read",
    "approval.read",
    "approval.decide",
    "audit.read",
  ],
  auditor: [
    "agent.read",
    "workflow.read",
    "approval.read",
    "audit.read",
    "metrics.read",
  ],
  viewer: ["agent.read", "workflow.read"],
};

interface OidcProfile extends Record<string, unknown> {
  sub?: string;
  name?: string;
  email?: string;
  picture?: string;
}

export interface HumanIdentity {
  actorId: string;
  tenantId: string;
  roles: HumanRole[];
  email?: string;
  name?: string;
}

export class HumanAuthError extends Error {
  constructor(
    public readonly code: "unauthenticated" | "forbidden" | "auth_unconfigured",
    message = code,
  ) {
    super(message);
    this.name = "HumanAuthError";
  }
}

function configured(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function humanAuthConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    configured(env.NEXTAUTH_URL) &&
      configured(env.NEXTAUTH_SECRET) &&
      configured(env.AGENTOS_OIDC_ISSUER) &&
      configured(env.AGENTOS_OIDC_CLIENT_ID) &&
      configured(env.AGENTOS_OIDC_CLIENT_SECRET),
  );
}

function claim(profile: OidcProfile | undefined, name: string): unknown {
  return profile?.[name];
}

export function normalizeRoles(value: unknown): HumanRole[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[ ,]+/)
      : [];
  const roles = values.filter(
    (role): role is HumanRole =>
      typeof role === "string" && humanRoles.includes(role as HumanRole),
  );
  return [...new Set(roles)];
}

function identityFromToken(token: JWT): HumanIdentity | undefined {
  const actorId = typeof token.sub === "string" ? token.sub : undefined;
  const tenantId =
    typeof token.tenantId === "string" ? token.tenantId : undefined;
  const roles = normalizeRoles(token.roles);
  if (!actorId || !tenantId || roles.length === 0) return undefined;
  return {
    actorId,
    tenantId,
    roles,
    ...(typeof token.email === "string" ? { email: token.email } : {}),
    ...(typeof token.name === "string" ? { name: token.name } : {}),
  };
}

function identityFromSession(session: Session): HumanIdentity | undefined {
  const candidate = session as Session & {
    identity?: HumanIdentity;
  };
  return candidate.identity;
}

export function hasPermission(
  identity: HumanIdentity,
  permission: HumanPermission,
): boolean {
  return identity.roles.some((role) =>
    rolePermissions[role].includes(permission),
  );
}

export async function requireHumanPermission(
  permission: HumanPermission,
): Promise<HumanIdentity> {
  if (!humanAuthConfigured()) throw new HumanAuthError("auth_unconfigured");
  const session = await getServerSession(humanAuthOptions);
  if (!session) throw new HumanAuthError("unauthenticated");
  const identity = identityFromSession(session);
  if (!identity) throw new HumanAuthError("unauthenticated");
  if (!hasPermission(identity, permission))
    throw new HumanAuthError("forbidden");
  return identity;
}

const issuer =
  configured(process.env.AGENTOS_OIDC_ISSUER) ?? "https://oidc.invalid";
const clientId =
  configured(process.env.AGENTOS_OIDC_CLIENT_ID) ?? "unconfigured";
const clientSecret =
  configured(process.env.AGENTOS_OIDC_CLIENT_SECRET) ?? "unconfigured";
const rolesClaim = configured(process.env.AGENTOS_OIDC_ROLES_CLAIM) ?? "roles";
const tenantClaim =
  configured(process.env.AGENTOS_OIDC_TENANT_CLAIM) ?? "tenant_id";

export const humanAuthOptions: NextAuthOptions = {
  secret:
    configured(process.env.NEXTAUTH_SECRET) ??
    "unconfigured-development-secret",
  session: { strategy: "jwt" },
  providers: [
    {
      id: "raeburn-oidc",
      name: "Organisation SSO",
      type: "oauth",
      wellKnown: `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
      idToken: true,
      checks: ["pkce", "state"],
      clientId,
      clientSecret,
      authorization: { params: { scope: "openid profile email" } },
      profile(profile: OidcProfile) {
        return {
          id: String(profile.sub ?? ""),
          name: typeof profile.name === "string" ? profile.name : null,
          email: typeof profile.email === "string" ? profile.email : null,
          image: typeof profile.picture === "string" ? profile.picture : null,
        };
      },
    },
  ],
  callbacks: {
    async jwt({ token, profile }) {
      if (profile) {
        const oidcProfile = profile as OidcProfile;
        token.tenantId = claim(oidcProfile, tenantClaim);
        token.roles = normalizeRoles(claim(oidcProfile, rolesClaim));
      }
      return token;
    },
    async session({ session, token }) {
      const identity = identityFromToken(token);
      if (identity) {
        (session as Session & { identity?: HumanIdentity }).identity = identity;
      }
      return session;
    },
  },
};
