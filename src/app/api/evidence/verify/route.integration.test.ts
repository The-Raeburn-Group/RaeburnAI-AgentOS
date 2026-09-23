import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import { evidenceSourceContentHash } from "@/lib/evidence-verification";
import { POST } from "./route";

const databaseUrl = process.env.DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const tenantId = "evidence-verification-tenant";

async function clean() {
  await db.tenant.deleteMany({ where: { id: tenantId } });
}

function verificationRequest() {
  const excerpt = "The approved control threshold is 75 percent.";
  return new Request("http://localhost:3000/api/evidence/verify", {
    method: "POST",
    headers: {
      authorization: "Bearer evidence-integration-token",
      "x-tenant-id": tenantId,
      "x-actor-id": "chain-evidence",
      "x-request-id": "evidence-integration-request",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      strictness: "standard",
      sources: [
        {
          id: "source-1",
          uri: "https://example.com/policy",
          title: "Policy source",
          sourceType: "primary",
          retrievedAt: "2026-09-23T12:00:00.000Z",
          documentId: "policy-1",
          documentVersion: "v4",
          chunkId: "chunk-1",
          excerpt,
          contentHash: evidenceSourceContentHash(excerpt),
        },
      ],
      claims: [
        {
          id: "claim-1",
          claim: "The approved control threshold is 75 percent.",
          sourceIds: ["source-1"],
        },
      ],
      calculations: [
        {
          id: "calc-1",
          expression: "300 * 25%",
          assertedResult: 75,
        },
      ],
    }),
  });
}

describeWithDatabase("evidence verification API integration", () => {
  beforeEach(async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evidence-integration-token");
    await clean();
    await db.tenant.create({
      data: {
        id: tenantId,
        slug: tenantId,
        name: "Evidence Verification Tenant",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(clean);

  it("persists tenant-bound summary evidence without storing raw source excerpts", async () => {
    const response = await POST(verificationRequest());

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      tenant: { id: tenantId },
      verification: {
        decision: "pass",
        scores: {
          correctness: 1,
          evidenceIntegrity: 1,
          citationIntegrity: 1,
          calculationAccuracy: 1,
        },
      },
    });

    const audit = await db.auditEvent.findFirst({
      where: {
        tenantId,
        action: "evidence.verification.completed",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actor).toBe("chain-evidence");
    expect(audit?.metadata).toMatchObject({
      requestId: "evidence-integration-request",
      decision: "pass",
      claimCount: 1,
      calculationCount: 1,
    });
    expect(JSON.stringify(audit?.metadata)).not.toContain(
      "The approved control threshold is 75 percent.",
    );
  });
});
