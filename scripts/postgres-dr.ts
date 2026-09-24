import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AgentStatus,
  ApprovalStatus,
  EvaluationCandidateStatus,
  OptimizationExperimentStatus,
  PrismaClient,
  RunStatus,
  WorkflowJobStatus,
} from "@prisma/client";

const MANIFEST_SCHEMA = "agentos.postgres.backup-manifest.v1";
const FIXTURE_TENANTS = [
  "00000000-0000-4000-8000-00000000a001",
  "00000000-0000-4000-8000-00000000b001",
] as const;

interface TableFingerprint {
  rows: number;
  sha256: string;
}

interface DatabaseSnapshot {
  migrations: TableFingerprint;
  tables: Record<string, TableFingerprint>;
}

interface BackupManifest {
  schema: typeof MANIFEST_SCHEMA;
  createdAt: string;
  dumpSha256: string;
  snapshot: DatabaseSnapshot;
}

interface CliOptions {
  command: "seed" | "backup" | "restore" | "verify";
  dumpPath: string;
  manifestPath: string;
  allowDestructiveRestore: boolean;
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required.");
  }
  if (
    !databaseUrl.startsWith("postgresql://") &&
    !databaseUrl.startsWith("postgres://")
  ) {
    throw new Error(
      "AgentOS disaster recovery supports PostgreSQL DATABASE_URL values only.",
    );
  }
  return databaseUrl;
}

function parseCli(argv: string[]): CliOptions {
  const command = argv[0];
  if (!["seed", "backup", "restore", "verify"].includes(command ?? "")) {
    throw new Error(
      "Usage: postgres-dr.ts <seed|backup|restore|verify> [options]",
    );
  }

  const valueFor = (flag: string, fallback: string): string => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value.`);
    }
    return value;
  };

  return {
    command: command as CliOptions["command"],
    dumpPath: valueFor("--dump", "build/backups/agentos.dump"),
    manifestPath: valueFor("--manifest", "build/backups/agentos.manifest.json"),
    allowDestructiveRestore: argv.includes("--allow-destructive-restore"),
  };
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function fingerprintRows(rows: unknown[]): TableFingerprint {
  const canonical = JSON.stringify(canonicalize(rows));
  return {
    rows: rows.length,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  };
}

async function snapshotDatabase(): Promise<DatabaseSnapshot> {
  const prisma = new PrismaClient();
  try {
    const [
      tenants,
      agents,
      workflows,
      runs,
      tasks,
      memories,
      mcpServers,
      approvals,
      auditEvents,
      workflowJobs,
      evaluationCandidates,
      evaluationCandidateOccurrences,
      optimizationExperiments,
      budgetPolicies,
      spendReservations,
      usageEvents,
      migrations,
    ] = await Promise.all([
      prisma.tenant.findMany({ orderBy: { id: "asc" } }),
      prisma.agent.findMany({ orderBy: { id: "asc" } }),
      prisma.workflow.findMany({ orderBy: { id: "asc" } }),
      prisma.workflowRun.findMany({ orderBy: { id: "asc" } }),
      prisma.agentTask.findMany({ orderBy: { id: "asc" } }),
      prisma.memory.findMany({ orderBy: { id: "asc" } }),
      prisma.mcpServer.findMany({ orderBy: { id: "asc" } }),
      prisma.approval.findMany({ orderBy: { id: "asc" } }),
      prisma.auditEvent.findMany({ orderBy: { id: "asc" } }),
      prisma.workflowJob.findMany({ orderBy: { id: "asc" } }),
      prisma.evaluationCandidate.findMany({ orderBy: { id: "asc" } }),
      prisma.evaluationCandidateOccurrence.findMany({
        orderBy: { id: "asc" },
      }),
      prisma.optimizationExperiment.findMany({ orderBy: { id: "asc" } }),
      prisma.budgetPolicy.findMany({ orderBy: { id: "asc" } }),
      prisma.spendReservation.findMany({ orderBy: { id: "asc" } }),
      prisma.usageEvent.findMany({ orderBy: { id: "asc" } }),
      prisma.$queryRaw<
        Array<{
          migration_name: string;
          checksum: string;
          finished_at: Date | null;
          rolled_back_at: Date | null;
          applied_steps_count: number;
        }>
      >`
        SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count
        FROM "_prisma_migrations"
        ORDER BY migration_name
      `,
    ]);

    return {
      migrations: fingerprintRows(migrations),
      tables: {
        Tenant: fingerprintRows(tenants),
        Agent: fingerprintRows(agents),
        Workflow: fingerprintRows(workflows),
        WorkflowRun: fingerprintRows(runs),
        AgentTask: fingerprintRows(tasks),
        Memory: fingerprintRows(memories),
        McpServer: fingerprintRows(mcpServers),
        Approval: fingerprintRows(approvals),
        AuditEvent: fingerprintRows(auditEvents),
        WorkflowJob: fingerprintRows(workflowJobs),
        EvaluationCandidate: fingerprintRows(evaluationCandidates),
        EvaluationCandidateOccurrence: fingerprintRows(
          evaluationCandidateOccurrences,
        ),
        OptimizationExperiment: fingerprintRows(optimizationExperiments),
        BudgetPolicy: fingerprintRows(budgetPolicies),
        SpendReservation: fingerprintRows(spendReservations),
        UsageEvent: fingerprintRows(usageEvents),
      },
    };
  } finally {
    await prisma.$disconnect();
  }
}

function libpqTarget(databaseUrl: string): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const parsed = new URL(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!database) throw new Error("DATABASE_URL must include a database name.");

  const args: string[] = [];
  if (parsed.hostname) args.push("--host", parsed.hostname);
  if (parsed.port) args.push("--port", parsed.port);
  if (parsed.username)
    args.push("--username", decodeURIComponent(parsed.username));
  args.push("--dbname", database);

  const env = { ...process.env };
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode) env.PGSSLMODE = sslMode;
  return { args, env };
}

function runPgTool(tool: "pg_dump" | "pg_restore", extraArgs: string[]): void {
  const databaseUrl = requireDatabaseUrl();
  const target = libpqTarget(databaseUrl);
  const result = spawnSync(tool, [...target.args, ...extraArgs], {
    env: target.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(`${tool} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${tool} failed: ${detail}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function readManifest(path: string): Promise<BackupManifest> {
  const parsed = JSON.parse(
    await readFile(path, "utf8"),
  ) as Partial<BackupManifest>;
  if (
    parsed.schema !== MANIFEST_SCHEMA ||
    typeof parsed.dumpSha256 !== "string" ||
    !parsed.snapshot ||
    !parsed.snapshot.tables
  ) {
    throw new Error("Backup manifest is missing required integrity fields.");
  }
  return parsed as BackupManifest;
}

async function createBackup(
  dumpPath: string,
  manifestPath: string,
): Promise<void> {
  await mkdir(dirname(dumpPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });

  const before = await snapshotDatabase();
  runPgTool("pg_dump", [
    "--format=custom",
    "--schema=public",
    "--no-owner",
    "--no-acl",
    "--compress=6",
    `--file=${dumpPath}`,
  ]);
  const after = await snapshotDatabase();

  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await rm(dumpPath, { force: true });
    throw new Error(
      "Source database changed during logical backup; retry from a quiesced/read-only window.",
    );
  }

  const manifest: BackupManifest = {
    schema: MANIFEST_SCHEMA,
    createdAt: new Date().toISOString(),
    dumpSha256: await sha256File(dumpPath),
    snapshot: before,
  };
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function restoreBackup(
  dumpPath: string,
  manifestPath: string,
  allowDestructiveRestore: boolean,
): Promise<void> {
  if (!allowDestructiveRestore) {
    throw new Error(
      "Restore is destructive; pass --allow-destructive-restore explicitly.",
    );
  }
  const manifest = await readManifest(manifestPath);
  if ((await sha256File(dumpPath)) !== manifest.dumpSha256) {
    throw new Error(
      "Backup dump hash does not match its manifest; restore aborted.",
    );
  }

  runPgTool("pg_restore", [
    "--clean",
    "--if-exists",
    "--exit-on-error",
    "--single-transaction",
    "--no-owner",
    "--no-acl",
    dumpPath,
  ]);
}

async function verifyRestore(
  dumpPath: string,
  manifestPath: string,
): Promise<void> {
  const manifest = await readManifest(manifestPath);
  if ((await sha256File(dumpPath)) !== manifest.dumpSha256) {
    throw new Error("Backup dump hash does not match its manifest.");
  }

  const restored = await snapshotDatabase();
  if (JSON.stringify(restored) !== JSON.stringify(manifest.snapshot)) {
    throw new Error(
      "Restored AgentOS database does not match the source backup manifest.",
    );
  }
}

async function seedRecoveryFixture(): Promise<void> {
  const prisma = new PrismaClient();
  const createdAt = new Date("2026-09-15T00:00:00.000Z");
  const tenantA = FIXTURE_TENANTS[0];
  const tenantB = FIXTURE_TENANTS[1];

  try {
    await prisma.optimizationExperiment.deleteMany({
      where: { tenantId: { in: [...FIXTURE_TENANTS] } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: [...FIXTURE_TENANTS] } },
    });

    await prisma.tenant.createMany({
      data: [
        {
          id: tenantA,
          name: "DR Tenant A",
          slug: "dr-tenant-a",
          createdAt,
          updatedAt: createdAt,
        },
        {
          id: tenantB,
          name: "DR Tenant B",
          slug: "dr-tenant-b",
          createdAt,
          updatedAt: createdAt,
        },
      ],
    });

    for (const [index, tenantId] of FIXTURE_TENANTS.entries()) {
      const suffix = index === 0 ? "a" : "b";
      const agentId = `00000000-0000-4000-8000-00000000${suffix}101`;
      const challengerAgentId = `00000000-0000-4000-8000-00000000${suffix}102`;
      const workflowId = `00000000-0000-4000-8000-00000000${suffix}201`;
      const runId = `00000000-0000-4000-8000-00000000${suffix}301`;

      await prisma.agent.create({
        data: {
          id: agentId,
          tenantId,
          name: `DR Agent ${suffix.toUpperCase()}`,
          slug: "dr-agent",
          version: "1.0.0",
          description: "Disaster-recovery integrity fixture.",
          systemPrompt: "Return deterministic recovery evidence only.",
          status: AgentStatus.VERIFIED,
          marketplaceTags: ["dr", "integrity"],
          requiredTools: ["memory.search"],
          approvalRequired: true,
          memoryScope: "workspace",
          manifest: { fixture: "postgres-dr", tenant: suffix },
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.agent.create({
        data: {
          id: challengerAgentId,
          tenantId,
          name: `DR Agent Challenger ${suffix.toUpperCase()}`,
          slug: "dr-agent",
          version: "1.1.0",
          description: "Disaster-recovery optimization challenger fixture.",
          systemPrompt: "Return deterministic recovery evidence with review.",
          status: AgentStatus.DRAFT,
          marketplaceTags: ["dr", "integrity"],
          requiredTools: ["memory.search"],
          approvalRequired: true,
          memoryScope: "workspace",
          manifest: {
            fixture: "postgres-dr",
            tenant: suffix,
            optimizationChallenger: true,
          },
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.workflow.create({
        data: {
          id: workflowId,
          tenantId,
          name: `DR Workflow ${suffix.toUpperCase()}`,
          goal: "Preserve tenant-scoped operational state across restore.",
          status: RunStatus.SUCCEEDED,
          graph: { nodes: [{ agentId }], edges: [] },
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.workflowRun.create({
        data: {
          id: runId,
          tenantId,
          workflowId,
          status: RunStatus.SUCCEEDED,
          input: { tenant: suffix, request: "recovery-fixture" },
          output: { tenant: suffix, restored: true },
          startedAt: createdAt,
          finishedAt: new Date(createdAt.getTime() + 1000),
          createdAt,
        },
      });

      await prisma.agentTask.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}401`,
          tenantId,
          runId,
          agentId,
          name: "DR integrity task",
          status: RunStatus.SUCCEEDED,
          input: { tenant: suffix },
          output: { result: "preserved" },
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.memory.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}501`,
          tenantId,
          scope: "tenant",
          kind: "tenant_context",
          key: "dr-recovery-fixture",
          content: `tenant-${suffix}-memory`,
          metadata: {
            fixture: true,
            _memoryPolicy: {
              version: "raeburnai.memory-policy.v1",
              classification: "general",
              findingTypes: [],
              redactionCount: 0,
              sensitivityLabels: [],
            },
          },
          provenance: {
            sourceType: "system",
            sourceId: `dr-fixture-${suffix}`,
            recordedAt: createdAt.toISOString(),
          },
          sensitivity: "general",
          policyVersion: "raeburnai.memory-policy.v1",
          embedding: [],
          createdAt,
          updatedAt: createdAt,
          expiresAt: new Date("2026-10-15T00:00:00.000Z"),
        },
      });

      await prisma.mcpServer.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}601`,
          tenantId,
          name: "dr-mcp",
          url: `https://mcp-${suffix}.invalid`,
          capabilities: ["read.fixture"],
          enabled: false,
          policy: { tenantBound: true, fixture: true },
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.approval.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}701`,
          tenantId,
          runId,
          actionType: "dr.verify",
          summary: "Preserve governed approval evidence across recovery.",
          payload: { tenant: suffix, fixture: true },
          status: ApprovalStatus.APPROVED,
          requestedBy: `requester-${suffix}`,
          decidedBy: `approver-${suffix}`,
          decisionNote: "Recovery fixture approved.",
          createdAt,
          decidedAt: new Date(createdAt.getTime() + 500),
        },
      });

      await prisma.auditEvent.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}801`,
          tenantId,
          runId,
          actor: `actor-${suffix}`,
          action: "dr.fixture.created",
          metadata: { tenantId, fixture: true, approvalPreserved: true },
          createdAt,
        },
      });

      await prisma.workflowJob.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}901`,
          tenantId,
          idempotencyKey: `dr-queue-${suffix}-0001`,
          payloadHash:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          request: {
            tenantSlug: "ignored",
            name: `DR queued workflow ${suffix.toUpperCase()}`,
            goal: "Survive logical backup and restore as durable queued work.",
            agents: ["dr-agent"],
            mode: "sequential",
            strictness: "standard",
            input: { tenant: suffix, fixture: true },
          },
          context: {
            tenantReference: tenantId,
            actorId: `queue-actor-${suffix}`,
            requestId: `dr-queue-request-${suffix}`,
          },
          status: WorkflowJobStatus.QUEUED,
          attempts: 0,
          maxAttempts: 3,
          availableAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        },
      });

      const evaluationCandidateId = `00000000-0000-4000-8000-00000000${suffix}a01`;
      await prisma.evaluationCandidate.create({
        data: {
          id: evaluationCandidateId,
          tenantId,
          fingerprint: suffix.repeat(64),
          failureKind: "execution",
          severity: "high",
          summary: `tenant-${suffix} recovery evaluation candidate`,
          reasonLabels: ["dr_fixture", "execution"],
          metadata: {
            qualityContractVersion: "raeburnai.quality-loop.v1",
            sourceEventId: `00000000-0000-4000-8000-00000000${suffix}801`,
            sourceAction: "dr.fixture.created",
            redactionCount: 0,
          },
          occurrenceCount: 1,
          firstSeenAt: createdAt,
          lastSeenAt: createdAt,
          status: EvaluationCandidateStatus.PENDING_REVIEW,
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.evaluationCandidateOccurrence.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}a02`,
          candidateId: evaluationCandidateId,
          sourceEventId: `00000000-0000-4000-8000-00000000${suffix}801`,
          createdAt,
        },
      });

      await prisma.optimizationExperiment.create({
        data: {
          id: `00000000-0000-4000-8000-00000000${suffix}b01`,
          tenantId,
          baselineAgentId: agentId,
          challengerAgentId,
          baselineManifestDigest: suffix.repeat(64),
          challengerManifestDigest: (suffix === "a" ? "b" : "a").repeat(64),
          artifactDigest: (suffix === "a" ? "c" : "d").repeat(64),
          policy: {
            maxQualityRegression: 0,
            maxToolRegression: 0,
            maxP95LatencyIncreaseRatio: 0.1,
            maxCostIncreaseRatio: 0.1,
          },
          evidence: {
            fixture: true,
            contractVersion: "raeburnai.optimization-experiment.v1",
          },
          result: {
            contractVersion: "raeburnai.optimization-experiment.v1",
            eligible: true,
            reasons: [],
          },
          status: OptimizationExperimentStatus.APPROVED,
          createdBy: `evaluator-${suffix}`,
          reviewedBy: `reviewer-${suffix}`,
          reviewNote: "Recovery fixture approval.",
          reviewedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.budgetPolicy.create({
        data: {
          id: "00000000-0000-4000-8000-00000000" + suffix + "c01",
          tenantId,
          currency: "USD",
          monthlyLimitMicrousd: 5_000_000n,
          perRequestLimitMicrousd: 1_000_000n,
          warningRatio: 0.8,
          enforcementMode: "hard",
          fallbackMode: "block",
          version: 1,
          createdAt,
          updatedAt: createdAt,
        },
      });

      const reservationId =
        "00000000-0000-4000-8000-00000000" + suffix + "c02";
      await prisma.spendReservation.create({
        data: {
          id: reservationId,
          tenantId,
          idempotencyKey: "dr-reservation-" + suffix + "-0001",
          payloadHash: (suffix === "a" ? "e" : "f").repeat(64),
          requestId: "dr-usage-request-" + suffix,
          actorId: "dr-router-" + suffix,
          estimatedCostMicrousd: 250_000n,
          committedCostMicrousd: 200_000n,
          status: "COMMITTED",
          policyVersion: 1,
          expiresAt: new Date("2026-09-15T00:05:00.000Z"),
          createdAt,
          updatedAt: createdAt,
        },
      });

      await prisma.usageEvent.create({
        data: {
          id: "00000000-0000-4000-8000-00000000" + suffix + "c03",
          tenantId,
          reservationId,
          idempotencyKey: "dr-usage-" + suffix + "-0001",
          requestId: "dr-usage-request-" + suffix,
          runId,
          actorId: "dr-router-" + suffix,
          category: "model",
          provider: "ollama",
          model: "dr-model",
          modelRegistryId: "dr-model-registry-" + suffix,
          expertSlug: "dr-agent",
          inputTokens: 100,
          outputTokens: 50,
          latencyMs: 750,
          costMicrousd: 200_000n,
          billableMetric: "model_request",
          billableUnits: 1,
          metadata: { fixture: true, tenant: suffix },
          eventDigest: (suffix === "a" ? "1" : "2").repeat(64),
          occurredAt: createdAt,
          createdAt,
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  requireDatabaseUrl();
  const options = parseCli(process.argv.slice(2));

  if (options.command === "seed") {
    await seedRecoveryFixture();
    return;
  }
  if (options.command === "backup") {
    await createBackup(options.dumpPath, options.manifestPath);
    return;
  }
  if (options.command === "restore") {
    await restoreBackup(
      options.dumpPath,
      options.manifestPath,
      options.allowDestructiveRestore,
    );
    return;
  }
  await verifyRestore(options.dumpPath, options.manifestPath);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`agentos_postgres_dr_failed: ${message}`);
  process.exitCode = 1;
});
