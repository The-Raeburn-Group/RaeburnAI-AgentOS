import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const workflowDirectory = path.join(root, '.github', 'workflows');
const immutableRef = /^[0-9a-f]{40}$/i;

function actionReferences(source) {
  const references = [];
  for (const [index, line] of source.split('\n').entries()) {
    const match = line.match(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/);
    if (match?.[1]) references.push({ line: index + 1, value: match[1] });
  }
  return references;
}

function assertPinnedAction(file, reference, failures) {
  if (reference.value.startsWith('./') || reference.value.startsWith('docker://')) return;
  const separator = reference.value.lastIndexOf('@');
  if (separator <= 0) {
    failures.push(`${file}:${reference.line} action has no immutable ref: ${reference.value}`);
    return;
  }
  const ref = reference.value.slice(separator + 1);
  if (!immutableRef.test(ref)) {
    failures.push(`${file}:${reference.line} action must use a full 40-character commit SHA: ${reference.value}`);
  }
}

const workflowFiles = (await readdir(workflowDirectory))
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .sort();
const failures = [];

for (const file of workflowFiles) {
  const source = await readFile(path.join(workflowDirectory, file), 'utf8');
  for (const reference of actionReferences(source)) assertPinnedAction(file, reference, failures);
}

const ciWorkflow = await readFile(path.join(workflowDirectory, 'ci.yml'), 'utf8');
for (const [control, marker] of [
  ['frozen dependency install', 'npm ci'],
  ['High/Critical dependency gate', 'npm audit --audit-level=high'],
  ['supply-chain policy validation', 'npm run validate:supply-chain'],
  ['deterministic image tag', 'raeburnai-agentos:${{ github.sha }}'],
  ['High/Critical container scan', 'aquasecurity/trivy-action@']
]) {
  if (!ciWorkflow.includes(marker)) failures.push(`ci.yml is missing required ${control} marker: ${marker}`);
}

const releaseWorkflow = await readFile(path.join(workflowDirectory, 'release.yml'), 'utf8');
for (const [control, marker] of [
  ['dependency vulnerability gate', 'npm audit --audit-level=high'],
  ['container vulnerability gate', 'aquasecurity/trivy-action@'],
  ['SBOM generation', 'anchore/sbom-action@'],
  ['GitHub provenance/SBOM attestation', 'actions/attest@'],
  ['keyless Sigstore signing', 'sigstore/cosign-installer@'],
  ['release checksums', 'SHA256SUMS'],
  ['Sigstore bundles', '.sigstore']
]) {
  if (!releaseWorkflow.includes(marker)) failures.push(`release.yml is missing required ${control} marker: ${marker}`);
}

if (failures.length > 0) {
  console.error('Software supply-chain policy validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Software supply-chain policy validated: ${workflowFiles.length} workflows use immutable action refs and required CI/release controls are present.`
);
