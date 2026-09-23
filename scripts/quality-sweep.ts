import { ingestFailureAuditEvents } from "../src/lib/quality-loop";

const limitValue = Number(process.env.QUALITY_SWEEP_BATCH ?? "100");
const result = await ingestFailureAuditEvents({ limit: limitValue });

process.stdout.write(JSON.stringify(result) + "\n");
