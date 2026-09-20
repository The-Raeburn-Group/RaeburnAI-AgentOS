import { db } from "@/lib/db";
import { purgeExpiredMemories } from "@/lib/memory";

async function main(): Promise<void> {
  const tenants = await db.tenant.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });

  let deletedCount = 0;
  for (const tenant of tenants) {
    deletedCount += await purgeExpiredMemories(tenant.id);
  }

  process.stdout.write(
    `${JSON.stringify({
      event: "memory_retention_complete",
      tenants: tenants.length,
      deletedCount,
    })}\n`,
  );
}

void main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`memory_retention_failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
