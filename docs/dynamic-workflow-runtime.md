# Dynamic Workflow Runtime: Current Internal Baseline

Dynamic Workflow Runtime v1 is the current internal compatibility baseline. Its temporary G0-G9 construction lifecycle is `CONSTRUCTION_ARCHIVED`; normal development does not reopen or maintain the construction ledger, repeat independent acceptance, or treat historical Gate state as a delivery requirement.

The historical v1 regression snapshot is:

- candidate commit: `56a78b6dcede075c60d7e5b2049158824050410c`
- snapshot: `sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279`
- historical whole-G9 review task: `019fc76d-4aaf-71b1-9839-1d5a6fa21132`

The compressed snapshot remains historical bytes for local regression diagnosis. It is not an active release, approval boundary, or Runtime input.

## Current Authority

Start with the machine-contract index in [`src/workflow-runtime/contracts/README.md`](../src/workflow-runtime/contracts/README.md), then read only the affected domain:

- Contracts and schemas: `src/workflow-runtime/contracts/`
- Database authority: `src/workflow-runtime/store/schema/` and `src/workflow-runtime/store/runtime-store/`
- Compiler and deterministic replay: `src/workflow-runtime/compiler/` and `src/workflow-runtime/contracts/conformance/current/`
- Runtime behavior: `src/workflow-runtime/runtime/`, `capacity/`, `registry/`, and `projection/`
- Node compatibility and optional fallback installation: `scripts/runtime-toolchain.sh`
- Current Host Core local snapshot, selection, startup, and state maintenance: [`host-core-lifecycle.md`](host-core-lifecycle.md)

Use versioned machine contracts, Schema/DDL/Store constraints, focused Compiler replay, and Runtime tests for the affected internal boundary. Add a Contract version only when persisted data or independently changing code needs one; an ordinary implementation change does not require a new certification stage, review role, evidence chain, or release ceremony. Do not edit the archived construction framework or ledger.

## Validation

Setup records one compatible absolute Node path. The supported runtime is Node major 26 on the current platform/architecture with the current native ABI; verification also loads `better-sqlite3` and runs an in-memory query. Patch upgrades do not require a release artifact or executable hash update. The optional installer retains a download checksum only to detect archive corruption.

Normal development runs current checks through the configured runtime:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
./scripts/runtime-toolchain.sh exec -- npm run test:current
./scripts/runtime-toolchain.sh exec -- npm run typecheck
```

Run `scripts/runtime-toolchain.sh configure --node "$(node -p 'process.execPath')"` after moving or upgrading Node. `active-core` is the only runtime selection pointer; there is no `active-node` pointer or stable runtime launcher.

Store compatibility is governed by SQLite `PRAGMA user_version`, supported transactional migrations, and focused required table/column/index smoke checks. Store and Runtime tests use test-owned temporary directories and injected adapters; they never select an identity mode or touch the live Workflow database.

## Historical Archive

The complete v1 construction design, introduction, progress ledger, future-only extended certification plan, and pre-construction handoffs are read-only under [`docs/archive/dynamic-workflow-runtime-v1/`](archive/dynamic-workflow-runtime-v1/README.md).

They are historical provenance, not Runtime input or default development authority. Optional audit is explicit:

```sh
git show workflow-runtime-v1-conformance-history
```

See [`internal-experimental-scope.md`](internal-experimental-scope.md) for the project boundary and the prioritized simplification list.
