import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  AgentStatus,
  ApprovalStatus,
  PrismaClient,
  RunStatus,
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
          scope: "workspace",
          key: "dr-recovery-fixture",
          content: `tenant-${suffix}-memory`,
          metadata: { classification: "restricted", fixture: true },
          embedding: [0.125, 0.25, 0.5],
          createdAt,
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
