# Dynamic Workflow Runtime Machine Contracts

This directory is the active machine-readable contract authority for Dynamic Workflow Runtime v1. The G0-G9 construction lifecycle is complete and archived. Normal development does not derive semantics from the archived framework or progress ledger and does not maintain Gate milestone state.

The accepted v1 boundary is commit `56a78b6dcede075c60d7e5b2049158824050410c`, release `sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279`, accepted by independent whole-G9 task `019fc76d-4aaf-71b1-9839-1d5a6fa21132`.

## Active Authority

Use the smallest affected authority and its tests:

| Area | Current authority |
| --- | --- |
| Common artifact identity | `artifact.ts`, `versioned-ref.ts`, `strict-json.ts`, `hash.ts` |
| Definition, Recipe, Command, Feature, Card, Source and Compiled IR | `schemas/`, `closed-schema-pack.ts`, `catalogs/` |
| Safety, Capacity baseline, Retention and SQLite profile | `safety/`, `capacity/`, `sqlite/` |
| Current Logical Schema | `logical-schema/` plus `../store/schema/` |
| Compiler authority | `../compiler/`, `conformance/current/`, and sealed replay inputs |
| Registry and authoring | G3 contract packs and `../authoring/` tests |
| Runtime behavior | G5-G7 contract packs plus `../runtime/`, `../capacity/`, and `../projection/` tests |
| Release and startup identity | `certification/`, production-candidate generated manifest/binding, stable Launcher tests |
| Production activation | `production-activation/` plus `../registry/production-activation.test.ts` |

Historical G0/R-016/R-020/R-021/R-022 coverage, Working/Draft review artifacts, superseded Compiler authorities, Gate ownership/readiness assertions, and milestone candidate tests remain immutable under `conformance/`, explicit package entrypoints, or Git history. They are not default inputs and are not regenerated or executed by the current aggregate.

## Current Validation

All local Node/npm commands use the managed toolchain:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
./scripts/runtime-toolchain.sh exec -- npm run test:current
./scripts/runtime-toolchain.sh exec -- npm run typecheck
./scripts/runtime-toolchain.sh exec -- npm run workflow-runtime:release:check
```

`contracts:check` verifies current foundation/schema artifacts, current Compiler and sealed replay, Registry authority, static absence, and the immutable accepted release. The release check validates a Git-tracked compressed copy of every accepted physical inventory member, including exact paths, lengths, hashes, and modes. `test:current` exercises current Store, Registry, authoring, Runtime, certification, and activation behavior against test-owned temporary state. Neither command reads archived construction Markdown, recomputes historical Markdown coverage, or executes retired Gate-state assertions.

Current Store tests use `identityMode: 'isolated_test'`. That explicit internal mode verifies the pinned managed Node/distribution, active managed-Node installation, Launcher, `better-sqlite3` native module, and SQLite profile while deriving the non-production checkout binding in memory. It never reads or writes `active-core`; release-validation and Production modes retain their existing pointer and installed-release checks.

Domain-specific generate commands remain implementation tools for future versioned changes. They must not be used to rewrite the accepted v1 release or frozen historical artifacts. A future release follows a new versioned construction/release boundary.

## Archive

The read-only construction archive is indexed at [`docs/archive/dynamic-workflow-runtime-v1/`](../../../docs/archive/dynamic-workflow-runtime-v1/README.md). It is not part of default CI, build, release inventory, Runtime, Compiler, Store, Registry, or Launcher reads.

Explicit non-default audit:

```sh
./scripts/runtime-toolchain.sh exec -- npm run archive:verify:v1
```

The archive checker preserves former-path literals only in archived Markdown, frozen generated JSON provenance, and accepted `dist/` bytes. Any former-path reference in live source, current documentation, package defaults, or CI fails.
