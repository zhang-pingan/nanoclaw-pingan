# Dynamic Workflow Runtime Internal Machine Contracts

This directory contains internal machine interfaces and regression fixtures for Dynamic Workflow Runtime v1. These contracts keep the current checkout internally consistent; they are not customer contracts and do not promise public compatibility, production readiness, SLA, certification, or long-term support. A contract should remain on the normal development path only when it protects local state or prevents likely rework.

The G0-G9 construction lifecycle is complete and archived. Its accepted commit `56a78b6dcede075c60d7e5b2049158824050410c` and snapshot `sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279` are retained only as regression provenance. The former independent acceptance task and production terminology do not create a current approval or delivery requirement.

Legacy identifiers such as `production`, `release`, `activation`, `gate`, and `audit` can remain in persisted formats where a rewrite would create migration risk. They do not create a current approval or delivery process.

## Active Authority

Use the smallest affected authority and its tests:

| Area                                                               | Current authority                                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Common artifact serialization and functional hashes               | `artifact.ts`, `versioned-ref.ts`, `strict-json.ts`, `hash.ts`                          |
| Definition, Recipe, Command, Feature, Card, Source and Compiled IR | `schemas/`, `closed-schema-pack.ts`, `catalogs/`                                        |
| Safety, Capacity baseline, Retention and SQLite profile            | `safety/`, `capacity/`, `sqlite/`                                                       |
| Current Logical Schema                                             | `logical-schema/` plus `../store/schema/`                                               |
| Compiler authority                                                 | `../compiler/`, `conformance/current/`, and deterministic replay                        |
| Registry and authoring                                             | G3 contract packs and `../authoring/` tests                                             |
| Runtime behavior                                                   | G5-G7 contract packs plus `../runtime/`, `../capacity/`, and `../projection/` tests     |
| Local startup and rollback compatibility                           | configured Node resolver, Host Core, Store compatibility, and startup tests              |

Historical construction coverage, review artifacts, superseded Compiler authorities, ownership/readiness assertions, and milestone candidate tests remain in Git history and the documentation archive. They are not current inputs and are not regenerated or executed by the current aggregate.

## Development Validation

Normal development uses the smallest relevant contract check and focused tests. The aggregate current checks are:

```sh
./scripts/runtime-toolchain.sh exec -- npm run contracts:check
./scripts/runtime-toolchain.sh exec -- npm run test:current
./scripts/runtime-toolchain.sh exec -- npm run typecheck
```

`contracts:check` verifies current foundation/schema artifacts, current Compiler replay, Registry authority, and static boundaries. `test:current` exercises the current Store, Registry, authoring, Runtime, and Host Core behavior against test-owned temporary state. Neither command treats the accepted physical snapshot, archived construction Markdown, or retired Gate-state assertions as a development gate.

Current Store tests create isolated databases under the OS temporary directory and inject test adapters and clocks explicitly. Store compatibility uses `PRAGMA user_version`, supported transactional migrations, and focused required-structure smoke checks; tests do not select a Runtime identity mode or read local Runtime pointers.

Domain-specific generate commands remain implementation tools for versioned changes. They must not rewrite the retained v1 snapshot or historical fixtures in place. A future internal baseline should add only the minimum versioned boundary required by the affected data or runtime interface; it does not need to repeat G0-G9 certification.

The engineering-weight review and further archive candidates are documented in [`docs/internal-experimental-scope.md`](../../../docs/internal-experimental-scope.md).

## Archive

The read-only construction archive is indexed at [`docs/archive/dynamic-workflow-runtime-v1/`](../../../docs/archive/dynamic-workflow-runtime-v1/README.md). It is not part of default CI, build, release inventory, Runtime, Compiler, Store, Registry, or startup reads.

Explicit non-default audit:

```sh
git show workflow-runtime-v1-conformance-history
```

The archive checker preserves former-path literals only in archived Markdown, frozen generated JSON provenance, and accepted `dist/` bytes. Any former-path reference in live source, current documentation, package defaults, or CI fails.
