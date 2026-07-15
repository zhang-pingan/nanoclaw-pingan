# Dynamic Workflow Contract Pack

This directory is the machine-readable authority for Dynamic Workflow Runtime contracts. G0.2 provides the common artifact envelope, exact `VersionedRef`, strict JSON, canonical/domain-separated SHA-256, foundation fixtures, and the conformance entry point. G0.3 adds closed Definition, Recipe, Runtime Command, Transition, Feature Manifest vNext, Card Presentation, Source IR, and Compiled IR schemas with TypeScript key/union conformance and positive/negative fixtures.

`protocols/`, `safety/`, `sqlite/`, and the Golden draft/sealed roots remain reserved for later G0 slices. Their presence is not evidence that those contracts, DDL, Golden artifacts, or certification exist. G0.3 fixtures live under `conformance/closed-schemas/`; they are schema conformance data, not Golden Draft or Sealed Golden artifacts.

Use the managed toolchain for both commands:

```bash
./scripts/runtime-toolchain.sh exec -- npm run contracts:generate
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
```

`contracts:generate` refreshes the deterministic G0.2 foundation and G0.3 closed-schema artifacts/manifests. CI runs `contracts:check`, which performs no writes and fails on byte drift, malformed fixtures, hash drift, Schema/TypeScript drift, missing reserved directories, or toolchain-input mismatch. The G0.2 foundation manifest remains byte-identical and is pinned by the G0.3 manifest.
