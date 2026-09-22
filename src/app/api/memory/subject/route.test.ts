import { afterEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET } from "./route";

const mocks = vi.hoisted(() => ({
  listSubjectMemories: vi.fn(),
  deleteSubjectMemories: vi.fn(),
}));

vi.mock("@/lib/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory")>();
  return {
    ...actual,
    listSubjectMemories: mocks.listSubjectMemories,
    deleteSubjectMemories: mocks.deleteSubjectMemories,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function headers() {
  return {
    authorization: "Bearer memory-test-token",
    "x-tenant-id": "tenant-a",
    "x-actor-id": "privacy-operator",
    "x-request-id": "dsar-request-1",
    "x-roles": "privacy.admin",
    "content-type": "application/json",
  };
}

describe("subject memory privacy API", () => {
  it("exports subject memory through the authenticated tenant context", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "memory-test-token");
    mocks.listSubjectMemories.mockResolvedValue([
      {
        id: "memory-a",
        scope: "user",
        kind: "user_preference",
        key: "preference:language",
        subjectId: "user-a",
        content: "English",
        metadata: {},
        provenance: {},
        sensitivity: "general",
        policyVersion: "raeburnai.memory-policy.v1",
        expiresAt: null,
        updatedAt: new Date("2026-09-20T00:00:00.000Z"),
      },
    ]);

    const response = await GET(
      new Request("http://localhost:3000/api/memory/subject?subjectId=user-a", {
        headers: headers(),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.listSubjectMemories).toHaveBeenCalledWith(
      { subjectId: "user-a" },
      {
        tenantReference: "tenant-a",
        actorId: "privacy-operator",
        requestId: "dsar-request-1",
        roles: ["privacy.admin"],
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      subjectId: "user-a",
      memories: [{ subjectId: "user-a", content: "English" }],
    });
  });

  it("passes verified subject-delete reason into the service", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "memory-test-token");
    mocks.deleteSubjectMemories.mockResolvedValue(3);

    const response = await DELETE(
      new Request("http://localhost:3000/api/memory/subject", {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({
          subjectId: "user-a",
          reason: "verified DSAR erasure",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteSubjectMemories).toHaveBeenCalledWith(
      { subjectId: "user-a" },
      expect.objectContaining({
        tenantReference: "tenant-a",
        actorId: "privacy-operator",
        roles: ["privacy.admin"],
      }),
      "verified DSAR erasure",
    );
    await expect(response.json()).resolves.toEqual({ deletedCount: 3 });
  });

  it("rejects malformed subject-delete JSON without invoking erasure", async () => {
    vi.stubEnv("RAEBURN_CHAIN_SERVICE_TOKEN", "memory-test-token");

    const response = await DELETE(
      new Request("http://localhost:3000/api/memory/subject", {
        method: "DELETE",
        headers: headers(),
        body: "{not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(mocks.deleteSubjectMemories).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: "Invalid subject request",
    });
  });
});
