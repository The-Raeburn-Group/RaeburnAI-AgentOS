import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluateModelRegistryFreshness,
  parseModelRegistry,
} from "../src/lib/model-registry";

const registryPath =
  process.env.MODEL_REGISTRY_PATH ??
  path.join(process.cwd(), "config/model-registry.v1.json");
const registry = parseModelRegistry(
  JSON.parse(await readFile(registryPath, "utf8")),
);
const nowValue = process.env.MODEL_REGISTRY_NOW;
const now = nowValue ? new Date(nowValue) : new Date();
if (Number.isNaN(now.getTime())) {
  throw new Error("MODEL_REGISTRY_NOW must be an ISO date-time");
}

const configuredProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "ollama";
const configuredModel = process.env.DEFAULT_MODEL ?? "llama3.1";
if (
  !registry.entries.some(
    (entry) =>
      entry.provider === configuredProvider && entry.model === configuredModel,
  )
) {
  throw new Error(
    `configured default model is not registered: ${configuredProvider}/${configuredModel}`,
  );
}

const report = evaluateModelRegistryFreshness(registry, now);
const format = process.argv.includes("--markdown") ? "markdown" : "json";

if (format === "markdown") {
  const lines = [
    "# Model registry freshness review",
    "",
    `Registry version: ${report.registryVersion}`,
    `Registry digest: \`${report.registryDigest}\``,
    `Evaluated: ${report.evaluatedAt}`,
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("No freshness or registry-governance findings.");
  } else {
    lines.push("| Severity | Entry | Finding | Detail |");
    lines.push("| --- | --- | --- | --- |");
    for (const finding of report.findings) {
      lines.push(
        `| ${finding.severity} | ${finding.entryId} | ${finding.code} | ${finding.detail.replaceAll("|", "\\|")} |`,
      );
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
} else {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (
  process.argv.includes("--strict") &&
  report.findings.some((finding) => finding.severity === "block")
) {
  process.exitCode = 2;
}
