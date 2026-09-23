import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("RaeburnBench CLI artifact safety", () => {
  it("rejects using the reviewed verification artifact as the output path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "raeburnbench-cli-"));
    const artifact = join(directory, "reviewed.json");
    const sentinel = "reviewed-artifact-must-not-be-overwritten\n";
    await writeFile(artifact, sentinel, "utf8");

    const result = spawnSync(
      resolve("node_modules/.bin/tsx"),
      ["scripts/raeburnbench.ts", "--verify", artifact, "--out", artifact],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--out and --verify must reference different paths",
    );
    await expect(readFile(artifact, "utf8")).resolves.toBe(sentinel);
  });
});
