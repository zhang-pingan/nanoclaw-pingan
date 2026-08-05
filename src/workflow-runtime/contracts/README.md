# Dynamic Workflow Runtime Internal Machine Contracts

This directory contains internal machine interfaces and regression fixtures for Dynamic Workflow Runtime v1. These contracts keep the current checkout internally consistent; they are not customer contracts and do not promise public compatibility, production readiness, SLA, certification, or long-term support. A contract should remain on the normal development path only when it protects local state or prevents likely rework.

The G0-G9 construction lifecycle is complete and archived. Its accepted commit `56a78b6dcede075c60d7e5b2049158824050410c` and snapshot `sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279` are retained only as regression provenance. The former independent acceptance task and production terminology do not create a current approval or delivery requirement.

Legacy identifiers such as `production`, `release`, `activation`, `certification`, `gate`, `frozen`, and `audit` remain in paths and serialized formats to avoid a high-churn compatibility rewrite. In current project language they mean local snapshot, local selection, optional exhaustive verification, historical milestone, immutable fixture, and diagnostic record respectively.

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
| Local startup and rollback identity | current Launcher, Host Core, Store compatibility, and startup tests |
| Legacy release/activation compatibility (non-default) | `certification/`, `production-activation/`, and explicit certification/activation tests |

Historical G0/R-016/R-020/R-021/R-022 coverage, Working/Draft review artifacts, superseded Compiler authorities, Gate ownership/readiness assertions, and milestone candidate tests remain immutable under `conformance/`, explicit package entrypoints, or Git history. They are not default inputs and are not regenerated or executed by the current aggregate.

## Development Validation

Normal development uses the smallest relevant contract check and focused tests. The aggregate current checks are:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
./scripts/runtime-toolchain.sh exec -- npm run test:current
./scripts/runtime-toolchain.sh exec -- npm run typecheck
```

`contracts:check` verifies current foundation/schema artifacts, current Compiler and sealed replay, Registry authority, and static absence. `test:current` exercises the current Store, Registry, authoring, Runtime, and Host Core behavior against test-owned temporary state. Neither command treats certification, G9 production activation, the accepted physical snapshot, archived construction Markdown, or retired Gate-state assertions as a default development gate.

The former exhaustive checks remain available for work that directly changes those compatibility surfaces:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check:full
./scripts/runtime-toolchain.sh exec -- npm run test:full
```

The physical snapshot verifier checks a Git-tracked compressed copy of every accepted inventory member, including exact paths, lengths, hashes, and modes. That is historical reproducibility evidence, not a prerequisite for unrelated local development.

Current Store tests use `identityMode: 'isolated_test'`. That explicit internal mode verifies the pinned managed Node/distribution, active managed-Node installation, Launcher, `better-sqlite3` native module, and SQLite profile while deriving the non-production checkout binding in memory. It never reads or writes `active-core`; release-validation and Production modes retain their existing pointer and installed-release checks.

Domain-specific generate commands remain implementation tools for versioned changes. They must not rewrite the retained v1 snapshot or historical fixtures in place. A future internal baseline should add only the minimum versioned boundary required by the affected data or runtime interface; it does not need to repeat G0-G9 certification.

The engineering-weight review and further archive candidates are documented in [`docs/internal-experimental-scope.md`](../../../docs/internal-experimental-scope.md).

## Archive

The read-only construction archive is indexed at [`docs/archive/dynamic-workflow-runtime-v1/`](../../../docs/archive/dynamic-workflow-runtime-v1/README.md). It is not part of default CI, build, release inventory, Runtime, Compiler, Store, Registry, or Launcher reads.

Explicit non-default audit:

```sh
./scripts/runtime-toolchain.sh exec -- npm run archive:verify:v1
```

The archive checker preserves former-path literals only in archived Markdown, frozen generated JSON provenance, and accepted `dist/` bytes. Any former-path reference in live source, current documentation, package defaults, or CI fails.
