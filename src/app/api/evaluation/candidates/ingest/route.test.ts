import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  captureEvaluationCandidate: vi.fn(),
}));

vi.mock("@/lib/evaluation-candidates", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/evaluation-candidates")>();
  return {
    ...actual,
    captureEvaluationCandidate: mocks.captureEvaluationCandidate,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function headers(contentType = "application/json") {
  return {
    authorization: "Bearer evaluation-ingest-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "chain-quality-capture",
    "x-request-id": "ingest-request-1",
    "content-type": contentType,
  };
}

describe("evaluation candidate service ingest API", () => {
  it("fails closed when service authentication is unconfigured", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");

    const response = await POST(
      new Request("http://localhost:3000/api/evaluation/candidates/ingest", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ trigger: "manual" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.captureEvaluationCandidate).not.toHaveBeenCalled();
  });

  it("requires JSON after trusted service authentication", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evaluation-ingest-token");

    const response = await POST(
      new Request("http://localhost:3000/api/evaluation/candidates/ingest", {
        method: "POST",
        headers: headers("text/plain"),
        body: "{}",
      }),
    );

    expect(response.status).toBe(415);
    expect(mocks.captureEvaluationCandidate).not.toHaveBeenCalled();
  });

  it("binds automated capture to authenticated service tenant and actor context", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "evaluation-ingest-token");
    mocks.captureEvaluationCandidate.mockResolvedValue({
      candidate: { id: "candidate-1", tenantId: "tenant-a" },
      deduplicated: false,
    });

    const response = await POST(
      new Request("http://localhost:3000/api/evaluation/candidates/ingest", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ trigger: "benchmark_failure" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.captureEvaluationCandidate).toHaveBeenCalledWith(
      { trigger: "benchmark_failure" },
      {
        tenantReference: "tenant-a",
        actorId: "chain-quality-capture",
        requestId: "ingest-request-1",
      },
    );
  });
});
