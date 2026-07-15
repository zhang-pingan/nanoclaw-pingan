# Dynamic Workflow Contract Pack

This directory is the machine-readable authority for Dynamic Workflow Runtime contracts. G0.2 provides the common artifact envelope, exact `VersionedRef`, strict JSON, canonical/domain-separated SHA-256, foundation fixtures, and the conformance entry point. G0.3 adds closed Definition, Recipe, Runtime Command, Transition, Feature Manifest vNext, Card Presentation, Source IR, and Compiled IR schemas with TypeScript key/union conformance and positive/negative fixtures. G0.4 adds closed Compiler Error, Runtime Fact/Event, Permission, Command Reason/Denial catalogs; runtime state transition tables; the command authorization table; and the declarative T0-T8/T6e transaction protocol table.

`safety/`, `sqlite/`, and the Golden draft/sealed roots remain reserved for later G0 slices. Their presence is not evidence that those contracts, DDL, Golden artifacts, or certification exist. G0.3 fixtures live under `conformance/closed-schemas/`; G0.4 fixtures live under `conformance/catalog-protocols/`. Neither is Golden Draft or Sealed Golden data. The protocol tables are declarative contracts only; they do not implement Store, Registry, Compiler, or Runtime semantics.

Use the managed toolchain for both commands:

```bash
./scripts/runtime-toolchain.sh exec -- npm run contracts:generate
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
```

`contracts:generate` refreshes the deterministic G0.2 foundation, G0.3 closed schemas, and G0.4 catalog/protocol artifacts and manifests. CI runs `contracts:check`, which performs no writes and fails on byte drift, malformed fixtures, hash drift, Schema/TypeScript/catalog/protocol drift, missing reserved directories, or toolchain-input mismatch. The G0.2 and G0.3 manifests remain byte-identical and are pinned by the G0.4 manifest.
