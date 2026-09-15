import { ApprovalRisk, ApprovalStatus, type Tenant } from "@prisma/client";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  hasPermission,
  HumanAuthError,
  requireHumanPermission,
  type HumanIdentity,
} from "@/lib/admin-auth";
import { db } from "@/lib/db";
import { TenantAccessError, requireHumanTenant } from "@/lib/human-tenant";

export const dynamic = "force-dynamic";

const riskRank: Record<ApprovalRisk, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function formatDate(value: Date | null) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(value);
}

function expiryLabel(value: Date | null) {
  if (!value) return "No expiry";
  const remainingMs = value.getTime() - Date.now();
  if (remainingMs <= 0) return "Expired";
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes < 60) return `${minutes} min remaining`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} h remaining`;
  return `${Math.ceil(hours / 24)} d remaining`;
}

function AuthConfigurationRequired() {
  return (
    <main className="shell">
      <section className="section card">
        <h1>Administrator authentication is not configured.</h1>
        <p>
          Configure the AgentOS OIDC issuer, client credentials, tenant claim,
          role claim and NextAuth secret before using the approval inbox.
        </p>
      </section>
    </main>
  );
}

function TenantDenied() {
  return (
    <main className="shell">
      <section className="section card">
        <h1>Tenant access denied.</h1>
        <p>
          The verified identity is not mapped to an existing AgentOS tenant.
        </p>
      </section>
    </main>
  );
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ decided?: string }>;
}) {
  let identity: HumanIdentity;
  try {
    identity = await requireHumanPermission("approval.read");
  } catch (error) {
    if (error instanceof HumanAuthError && error.code === "unauthenticated") {
      redirect("/api/auth/signin");
    }
    if (error instanceof HumanAuthError && error.code === "auth_unconfigured") {
      return <AuthConfigurationRequired />;
    }
    throw error;
  }

  let tenant: Tenant;
  try {
    tenant = await requireHumanTenant(identity);
  } catch (error) {
    if (error instanceof TenantAccessError) return <TenantDenied />;
    throw error;
  }

  const canDecide = hasPermission(identity, "approval.decide");
  const [{ decided }, pending, recent] = await Promise.all([
    searchParams,
    db.approval.findMany({
      where: { tenantId: tenant.id, status: ApprovalStatus.PENDING },
      include: { run: { include: { workflow: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    db.approval.findMany({
      where: {
        tenantId: tenant.id,
        status: { not: ApprovalStatus.PENDING },
      },
      include: { run: { include: { workflow: true } } },
      orderBy: { decidedAt: "desc" },
      take: 50,
    }),
  ]);

  pending.sort((left, right) => {
    const risk = riskRank[left.risk] - riskRank[right.risk];
    return risk || left.createdAt.getTime() - right.createdAt.getTime();
  });

  return (
    <main className="shell">
      <section className="section card approval-header">
        <div>
          <div className="eyebrow">Governed execution</div>
          <h1>Approval &amp; exception inbox</h1>
          <p>
            Tenant <strong>{tenant.slug}</strong> · signed in as{" "}
            <strong>
              {identity.name ?? identity.email ?? identity.actorId}
            </strong>
            . Pending work cannot continue past an approval checkpoint until an
            authorised decision is recorded.
          </p>
        </div>
        <div className="approval-header-actions">
          <span className="metric compact-metric">
            <strong>{pending.length}</strong>
            <span>Pending decisions</span>
          </span>
          <Link className="secondary-button" href="/">
            Back to dashboard
          </Link>
        </div>
      </section>

      {decided ? (
        <section className="notice" role="status">
          Decision recorded: <strong>{decided}</strong>.
        </section>
      ) : null}

      <section className="section card">
        <div className="section-heading">
          <div>
            <h2>Needs attention</h2>
            <p>
              High and critical requests prevent self-approval by the original
              requester. Rejections require an audit note.
            </p>
          </div>
          <span className="pill">
            {canDecide ? "Decision access" : "Read only"}
          </span>
        </div>

        <div className="approval-list">
          {pending.length === 0 ? (
            <p>No pending approval requests for this tenant.</p>
          ) : null}
          {pending.map((approval) => {
            const expired = Boolean(
              approval.expiresAt && approval.expiresAt.getTime() <= Date.now(),
            );
            const selfDecisionBlocked =
              (approval.risk === ApprovalRisk.HIGH ||
                approval.risk === ApprovalRisk.CRITICAL) &&
              approval.requestedBy === identity.actorId;
            const decisionAllowed =
              canDecide && !expired && !selfDecisionBlocked;

            return (
              <article className="approval-card" key={approval.id}>
                <div className="approval-card-topline">
                  <div>
                    <span
                      className={`risk-badge risk-${approval.risk.toLowerCase()}`}
                    >
                      {approval.risk}
                    </span>
                    <span className="status-badge status-pending">PENDING</span>
                  </div>
                  <strong className={expired ? "deadline expired" : "deadline"}>
                    {expiryLabel(approval.expiresAt)}
                  </strong>
                </div>

                <h3>{approval.summary}</h3>
                <p>
                  Workflow: <strong>{approval.run.workflow.name}</strong> ·{" "}
                  {approval.run.workflow.goal}
                </p>
                <div className="approval-meta">
                  <span>Action: {approval.actionType}</span>
                  <span>Requested by: {approval.requestedBy}</span>
                  <span>Requested: {formatDate(approval.createdAt)}</span>
                  <span>Expires: {formatDate(approval.expiresAt)}</span>
                </div>

                <details>
                  <summary>Evidence / action payload</summary>
                  <pre>{JSON.stringify(approval.payload, null, 2)}</pre>
                </details>

                {expired ? (
                  <p className="decision-warning">
                    This approval has passed its deadline. Any decision attempt
                    will expire and cancel the waiting workflow.
                  </p>
                ) : null}
                {selfDecisionBlocked ? (
                  <p className="decision-warning">
                    Separation of duties: you requested this high-risk action
                    and cannot approve or reject it yourself.
                  </p>
                ) : null}

                {decisionAllowed ? (
                  <form
                    className="decision-form"
                    action={`/api/approvals/${approval.id}/decision`}
                    method="post"
                  >
                    <label htmlFor={`note-${approval.id}`}>
                      Decision note
                      <textarea
                        id={`note-${approval.id}`}
                        name="note"
                        maxLength={2000}
                        placeholder="Record the reason, evidence checked, or conditions attached to this decision."
                      />
                    </label>
                    <div className="decision-actions">
                      <button
                        className="decision-button approve-button"
                        name="decision"
                        value="approve"
                        type="submit"
                      >
                        Approve &amp; resume
                      </button>
                      <button
                        className="decision-button reject-button"
                        name="decision"
                        value="reject"
                        type="submit"
                      >
                        Reject &amp; cancel
                      </button>
                    </div>
                  </form>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="section card">
        <h2>Recent decisions</h2>
        <div className="approval-list compact-list">
          {recent.length === 0 ? <p>No previous decisions yet.</p> : null}
          {recent.map((approval) => (
            <article className="approval-card compact" key={approval.id}>
              <div className="approval-card-topline">
                <div>
                  <span
                    className={`risk-badge risk-${approval.risk.toLowerCase()}`}
                  >
                    {approval.risk}
                  </span>
                  <span
                    className={`status-badge status-${approval.status.toLowerCase()}`}
                  >
                    {approval.status}
                  </span>
                </div>
                <span>{formatDate(approval.decidedAt)}</span>
              </div>
              <h3>{approval.summary}</h3>
              <p>
                {approval.run.workflow.name} · decided by{" "}
                {approval.decidedBy ?? "system"}
              </p>
              {approval.decisionNote ? (
                <p className="decision-note">{approval.decisionNote}</p>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
