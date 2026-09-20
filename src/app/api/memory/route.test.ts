import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "./route";

const mocks = vi.hoisted(() => ({
  writeMemory: vi.fn(),
  readMemory: vi.fn(),
  deleteMemory: vi.fn(),
}));

vi.mock("@/lib/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory")>();
  return {
    ...actual,
    writeMemory: mocks.writeMemory,
    readMemory: mocks.readMemory,
    deleteMemory: mocks.deleteMemory,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function headers(actorId = "user-a") {
  return {
    authorization: "Bearer memory-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": actorId,
    "x-request-id": "memory-request-1",
    "x-roles": "operator",
    "content-type": "application/json",
  };
}

describe("memory API", () => {
  it("fails closed when service authentication is not configured", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "");
    const response = await POST(
      new Request("http://localhost:3000/api/memory", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ scope: "workspace", key: "x", content: "y" }),
      }),
    );

    expect(response.status).toBe(503);
    expect(mocks.writeMemory).not.toHaveBeenCalled();
  });

  it("propagates trusted tenant actor request and roles into writes", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "memory-test-token");
    mocks.writeMemory.mockResolvedValue({
      id: "memory-1",
      scope: "user",
      kind: "user_preference",
      key: "preference:timezone",
      subjectId: "user-a",
      content: "Europe/London",
      metadata: { _memoryPolicy: { version: "raeburnai.memory-policy.v1" } },
      provenance: {},
      sensitivity: "general",
      policyVersion: "raeburnai.memory-policy.v1",
      expiresAt: new Date("2026-10-20T00:00:00.000Z"),
      updatedAt: new Date("2026-09-20T00:00:00.000Z"),
    });

    const payload = {
      scope: "user",
      kind: "user_preference",
      key: "preference:timezone",
      subjectId: "user-a",
      content: "Europe/London",
      explicitConsent: true,
    };
    const response = await POST(
      new Request("http://localhost:3000/api/memory", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(payload),
      }),
    );

    expect(response.status).toBe(201);
    expect(mocks.writeMemory).toHaveBeenCalledWith(payload, {
      tenantReference: "tenant-a",
      actorId: "user-a",
      requestId: "memory-request-1",
      roles: ["operator"],
    });
    await expect(response.json()).resolves.toMatchObject({
      memory: {
        id: "memory-1",
        kind: "user_preference",
        policyVersion: "raeburnai.memory-policy.v1",
      },
    });
  });

  it("does not read a missing memory as an empty success", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "memory-test-token");
    mocks.readMemory.mockResolvedValue(null);

    const response = await GET(
      new Request(
        "http://localhost:3000/api/memory?scope=session&key=session:missing",
        { headers: headers() },
      ),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "memory_not_found",
    });
  });

  it("deletes by scoped key and preserves the caller reason", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "memory-test-token");
    mocks.deleteMemory.mockResolvedValue(true);

    const response = await DELETE(
      new Request("http://localhost:3000/api/memory", {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({
          scope: "user",
          key: "preference:timezone",
          reason: "user corrected preference",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteMemory).toHaveBeenCalledWith(
      { scope: "user", key: "preference:timezone" },
      expect.objectContaining({
        tenantReference: "tenant-a",
        actorId: "user-a",
      }),
      "user corrected preference",
    );
  });
});
