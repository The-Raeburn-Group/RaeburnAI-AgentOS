import { afterEach, describe, expect, it } from "vitest";
import { requireChainServiceToken } from "@/lib/service-auth";

const originalToken = process.env.RAEBURN_CHAIN_SERVICE_TOKEN;

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.RAEBURN_CHAIN_SERVICE_TOKEN;
  } else {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = originalToken;
  }
});

describe("requireChainServiceToken", () => {
  it("fails closed when the service credential is not configured", async () => {
    delete process.env.RAEBURN_CHAIN_SERVICE_TOKEN;

    const response = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run"),
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toEqual({
      error: "Chain service authentication is not configured",
    });
  });

  it("rejects a missing or incorrect bearer credential", () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const missing = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run"),
    );
    const incorrect = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    );

    expect(missing?.status).toBe(401);
    expect(incorrect?.status).toBe(401);
  });

  it("accepts the configured bearer credential", () => {
    process.env.RAEBURN_CHAIN_SERVICE_TOKEN = "expected-token";

    const response = requireChainServiceToken(
      new Request("http://localhost/api/workflows/run", {
        headers: { authorization: "Bearer expected-token" },
      }),
    );

    expect(response).toBeNull();
  });
});
