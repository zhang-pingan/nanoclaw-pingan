# Dynamic Workflow Runtime: Current Internal Baseline

Dynamic Workflow Runtime v1 is the current internal compatibility baseline. Its temporary G0-G9 construction lifecycle is `CONSTRUCTION_ARCHIVED`; normal development does not reopen or maintain the construction ledger, repeat independent acceptance, or treat historical Gate state as a delivery requirement.

The retained regression snapshot is:

- candidate commit: `56a78b6dcede075c60d7e5b2049158824050410c`
- snapshot: `sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279`
- historical whole-G9 review task: `019fc76d-4aaf-71b1-9839-1d5a6fa21132`

This snapshot protects local regression diagnosis; it is not a production release, external support boundary, or promise that all historical contracts remain active. Legacy serialized names keep their old `production`/`release` wording only to avoid a high-churn rewrite.

## Current Authority

Start with the machine-contract index in [`src/workflow-runtime/contracts/README.md`](../src/workflow-runtime/contracts/README.md), then read only the affected domain:

- Contracts and schemas: `src/workflow-runtime/contracts/`
- Database authority: `src/workflow-runtime/store/schema/` and `src/workflow-runtime/store/runtime-store/`
- Compiler and sealed replay: `src/workflow-runtime/compiler/` and `src/workflow-runtime/contracts/conformance/current/`
- Runtime behavior: `src/workflow-runtime/runtime/`, `capacity/`, `registry/`, and `projection/`
- Retained snapshot identity: `src/workflow-runtime/contracts/certification/production-candidate/generated/`
- Stable managed runtime: `scripts/runtime-toolchain.sh` and `scripts/runtime-launcher.sh`
- Current Host Core local snapshot, selection, startup, and state maintenance: [`host-core-lifecycle.md`](host-core-lifecycle.md)

Use versioned machine contracts, Schema/DDL/Store constraints, focused Compiler replay, and Runtime tests for the affected internal boundary. Add a Contract version only when persisted data or independently changing code needs one; an ordinary implementation change does not require a new certification stage, review role, evidence chain, or release ceremony. Do not edit the archived construction framework or ledger.

## Validation

Normal development runs current checks through the managed toolchain:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
./scripts/runtime-toolchain.sh exec -- npm run test:current
./scripts/runtime-toolchain.sh exec -- npm run typecheck
```

Certification, legacy production activation, and the accepted physical snapshot are explicit compatibility checks rather than default gates:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check:full
./scripts/runtime-toolchain.sh exec -- npm run test:full
```

The physical snapshot verifier checks the immutable manifest and v3 binding, then reads the Git-tracked compressed archive and verifies every manifest member's exact path, byte length, raw hash, and mode. This remains useful only when changing snapshot verification or diagnosing historical reproducibility.

Store and Runtime tests use the explicit `isolated_test` identity mode. This mode keeps the managed Node, distribution, Launcher, native SQLite module, SQLite profile, and active managed-Node checks, but hashes the current test checkout in memory instead of reading a machine `active-core` pointer.

## Historical Archive

The complete v1 construction design, introduction, progress ledger, future-only extended certification plan, and pre-construction handoffs are read-only under [`docs/archive/dynamic-workflow-runtime-v1/`](archive/dynamic-workflow-runtime-v1/README.md).

They are historical provenance, not Runtime input or default development authority. Optional audit is explicit:

```sh
./scripts/runtime-toolchain.sh exec -- npm run archive:verify:v1
```

See [`internal-experimental-scope.md`](internal-experimental-scope.md) for the project boundary and the prioritized simplification list.
