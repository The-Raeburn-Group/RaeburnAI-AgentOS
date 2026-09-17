# Software supply-chain policy

## Purpose

RaeburnAI AgentOS treats workflow integrity, dependency provenance, container security and release provenance as production security controls.

## Required controls

All third-party GitHub Actions must be pinned to full 40-character commit SHAs. Mutable tags or branches are rejected by `npm run validate:supply-chain`.

Pull-request and main CI must use `npm ci`, execute the supply-chain validator, fail on High/Critical dependency findings, preserve the PostgreSQL migration and recovery verification path, build the production container under the exact Git commit SHA, and fail on High/Critical container findings.

Version-tag releases must repeat the quality, dependency, build and image-security gates before publishing a trust package containing:

- a version-tag source/build archive;
- SHA-256 checksums;
- SPDX and CycloneDX SBOMs;
- keyless Sigstore signature bundles;
- GitHub provenance and SBOM attestations; and
- verification instructions.

## Remediation expectations

Critical and High findings block release unless a separately governed, explicit and time-bounded security exception is approved. CI/release gates must not be weakened merely to obtain a green build. Medium and lower findings are tracked according to exploitability, exposure and upstream remediation availability.

## Verification

The repository-level checks can be exercised with:

```sh
npm ci
npm run validate:supply-chain
npm audit --audit-level=high
npm run verify
```

Container scanning runs against the commit-SHA image in CI. Release signing and GitHub attestations use GitHub OIDC from version-tag workflows, avoiding long-lived repository signing keys.
