import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  evaluateRaeburnBench,
  serializeRaeburnBenchResult,
  verifyRaeburnBenchResultIntegrity,
} from "../src/lib/raeburnbench";

interface CliOptions {
  corpus: string;
  candidate: string;
  baseline?: string;
  out?: string;
  verify?: string;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    corpus: "benchmarks/raeburnbench.seed.v0.json",
    candidate: "benchmarks/candidates/reference.v0.json",
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      ["--corpus", "--candidate", "--baseline", "--out", "--verify"].includes(
        flag,
      )
    ) {
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a path`);
      }
      if (flag === "--corpus") options.corpus = value;
      if (flag === "--candidate") options.candidate = value;
      if (flag === "--baseline") options.baseline = value;
      if (flag === "--out") options.out = value;
      if (flag === "--verify") options.verify = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }

  return options;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const [corpus, candidate, baseline] = await Promise.all([
    readJson(options.corpus),
    readJson(options.candidate),
    options.baseline ? readJson(options.baseline) : Promise.resolve(undefined),
  ]);

  if (baseline !== undefined) {
    verifyRaeburnBenchResultIntegrity(baseline);
  }

  const result = evaluateRaeburnBench(corpus, candidate, baseline);
  const serialized = serializeRaeburnBenchResult(result);

  const outputPath = options.out ? resolve(options.out) : undefined;
  const expectedPath = options.verify ? resolve(options.verify) : undefined;
  if (outputPath && expectedPath && outputPath === expectedPath) {
    throw new Error("--out and --verify must reference different paths");
  }

  if (expectedPath) {
    const expected = await readFile(expectedPath, "utf8");
    verifyRaeburnBenchResultIntegrity(JSON.parse(expected) as unknown);
    if (expected !== serialized) {
      throw new Error(
        `benchmark artifact mismatch: regenerate ${options.verify} from the reviewed corpus/candidate`,
      );
    }
  }

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }

  process.stdout.write(serialized);
  if (result.gate.status !== "pass") {
    process.exitCode = 2;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`raeburnbench_failed: ${message}`);
  process.exitCode = 1;
});
