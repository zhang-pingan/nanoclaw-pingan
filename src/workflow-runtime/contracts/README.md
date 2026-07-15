# Dynamic Workflow Contract Pack

This directory is the machine-readable authority for Dynamic Workflow Runtime contracts. G0.2 provides the common artifact envelope, exact `VersionedRef`, strict JSON, canonical/domain-separated SHA-256, foundation fixtures, and the conformance entry point. G0.3 adds closed Definition, Recipe, Runtime Command, Transition, Feature Manifest vNext, Card Presentation, Source IR, and Compiled IR schemas with TypeScript key/union conformance and positive/negative fixtures. G0.4 adds closed Compiler Error, Runtime Fact/Event, Permission, Command Reason/Denial catalogs; runtime state transition tables; the command authorization table; and the declarative T0-T8/T6e transaction protocol table. G0.5 adds the immutable `local_single_user_safety@1`, closed hot-reload Capacity baseline, Product Floor, Retention policy, complete per-field Enforcement Matrix, and the explicitly uncertified `local_single_user_sqlite@1` candidate.

`safety/` and `sqlite/` contain G0.5 contracts only. The SQLite candidate has null release/native/SQLite observation fields and is not certification evidence; no executable DDL, Schema Manifest, query catalog, Supported Limits, Store, or connection factory exists yet. The Golden draft/sealed roots remain reserved. G0.3 fixtures live under `conformance/closed-schemas/`, G0.4 fixtures under `conformance/catalog-protocols/`, and G0.5 fixtures under `conformance/safety-sqlite/`; none is Golden Draft or Sealed Golden data. The protocol and profile artifacts are declarative contracts only and do not implement Store, Registry, Compiler, or Runtime semantics.

Use the managed toolchain for both commands:

```bash
./scripts/runtime-toolchain.sh exec -- npm run contracts:generate
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
```

`contracts:generate` refreshes the deterministic G0.2 foundation, G0.3 closed schemas, G0.4 catalog/protocol artifacts, and G0.5 Safety/Retention/SQLite artifacts plus the repository Capacity baseline. CI runs `contracts:check`, which performs no writes and fails on byte drift, malformed fixtures, hash drift, Schema/TypeScript/catalog/protocol/profile drift, incomplete per-field enforcement, candidate certification spoofing, missing reserved directories, or toolchain-input mismatch. The G0.2, G0.3, and G0.4 manifests remain byte-identical and are pinned by the G0.5 manifest.
