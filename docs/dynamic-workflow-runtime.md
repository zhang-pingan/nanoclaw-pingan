# Dynamic Workflow Runtime

Dynamic Workflow Runtime v1 is implemented and accepted. Its temporary G0-G9 construction lifecycle is `CONSTRUCTION_ARCHIVED`; normal development does not reopen or maintain the construction ledger.

The accepted production release is:

- candidate commit: `56a78b6dcede075c60d7e5b2049158824050410c`
- release: `sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279`
- independent whole-G9 acceptance: `019fc76d-4aaf-71b1-9839-1d5a6fa21132`

## Current Authority

Start with the machine-contract index in [`src/workflow-runtime/contracts/README.md`](../src/workflow-runtime/contracts/README.md), then read only the affected domain:

- Contracts and schemas: `src/workflow-runtime/contracts/`
- Database authority: `src/workflow-runtime/store/schema/` and `src/workflow-runtime/store/runtime-store/`
- Compiler and sealed replay: `src/workflow-runtime/compiler/` and `src/workflow-runtime/contracts/conformance/current/`
- Runtime behavior: `src/workflow-runtime/runtime/`, `capacity/`, `registry/`, and `projection/`
- Release identity: `src/workflow-runtime/contracts/certification/production-candidate/generated/`
- Stable managed runtime: `scripts/runtime-toolchain.sh` and `scripts/runtime-launcher.sh`
- Current Host Core freeze, selection, startup, and state maintenance: [`host-core-lifecycle.md`](host-core-lifecycle.md)

Use versioned machine Contracts, Schema/DDL/Store constraints, sealed Compiler replay, Runtime tests, and release identity as authority. For semantic changes, add a focused domain document or ADR and a new Contract version. Do not edit the archived construction framework or ledger.

## Validation

Run Node/npm commands through the managed toolchain:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
./scripts/runtime-toolchain.sh exec -- npm run test:current
./scripts/runtime-toolchain.sh exec -- npm run typecheck
./scripts/runtime-toolchain.sh exec -- npm run workflow-runtime:release:check
```

The accepted release verifier checks the immutable manifest and v3 binding, then reads the Git-tracked compressed physical-release archive and verifies every manifest member's exact path, byte length, raw hash, and `0644`/`0755` mode. It does not rebuild, regenerate, rebind, stage, activate, or inspect an installed pointer.

Store and Runtime tests use the explicit `isolated_test` identity mode. This mode keeps the managed Node, distribution, Launcher, native SQLite module, SQLite profile, and active managed-Node checks, but hashes the current test checkout in memory instead of reading a machine `active-core` pointer.

## Historical Archive

The complete v1 construction design, introduction, progress ledger, future-only extended certification plan, and pre-construction handoffs are read-only under [`docs/archive/dynamic-workflow-runtime-v1/`](archive/dynamic-workflow-runtime-v1/README.md).

They are historical provenance, not Runtime input or default development authority. Optional audit is explicit:

```sh
./scripts/runtime-toolchain.sh exec -- npm run archive:verify:v1
```
