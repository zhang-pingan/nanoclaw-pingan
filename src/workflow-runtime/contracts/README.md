# Dynamic Workflow Contract Pack

This directory is the machine-readable authority for Dynamic Workflow Runtime contracts. G0.2 provides only the common artifact envelope, exact `VersionedRef`, strict JSON, canonical/domain-separated SHA-256, foundation fixtures, and the conformance entry point.

`schemas/`, `protocols/`, `safety/`, `sqlite/`, and the Golden draft/sealed roots are reserved for their later G0 slices. Their presence is not evidence that those contracts, DDL, Golden artifacts, or certification exist.

Use the managed toolchain for both commands:

```bash
./scripts/runtime-toolchain.sh exec -- npm run contracts:generate
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
```

`contracts:generate` refreshes only deterministic foundation hashes and `contract-pack-foundation.json`. CI runs `contracts:check`, which performs no writes and fails on byte drift, malformed fixtures, hash drift, missing reserved directories, or toolchain-input mismatch.
