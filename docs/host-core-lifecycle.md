# Host Core Lifecycle

Icarus is an internal, experimental, single-user tool. Host Core snapshots are optional local rollback controls, not product releases, deployment transactions, or availability guarantees. Normal development uses `current`; create a snapshot only when a risky change makes a known-good local fallback useful.

## Local Snapshots

The primary commands are:

```sh
local/shell/host-core-release.sh snapshot create [--label <label>] [--full-check]
local/shell/host-core-release.sh snapshot list
local/shell/host-core-release.sh snapshot select --id <snapshot-id>
local/shell/host-core-release.sh snapshot verify --id <snapshot-id>
local/shell/host-core-release.sh snapshot remove --id <snapshot-id>
```

`publish --version <label>` and `activate --version <label>` remain one-cycle aliases for create and select. New code should use the snapshot commands.

Creation builds in an isolated staging directory and installs the result under `host-core-snapshots/<snapshot-id>/`. The ID combines a timestamp, short Git commit, and random suffix; it is not content-addressed. A dirty checkout is recorded and warned about rather than rejected.

The `snapshot.json` file records only creation time, optional label, Git commit and dirty flag, entry path and checksum, Workflow Runtime integer schema version and supported migration range, Node major/native ABI/platform/arch, and validation status. It does not contain a complete inventory, per-file hashes, immutable version binding, certification evidence, or Runtime, Compiler, release, logical-schema, migration-file, or physical-schema identity hashes.

Default creation performs entry syntax and `better-sqlite3` smoke checks. `--full-check` additionally runs `test:current`, `contracts:check`, `typecheck`, and `format:check` before installation.

## Selection And Startup

Selection verifies the snapshot manifest, entry checksum, schema range, Node compatibility, and native-module smoke before atomically replacing `active-core`. It verifies the resulting pointer and restores the prior pointer if a post-switch check fails. An active snapshot cannot be removed.

Host startup always names the code source:

```sh
local/shell/start.sh --mode current
local/shell/start.sh --mode active
```

`current` builds and launches the checkout. `active` verifies and launches the snapshot selected by `active-core` without rebuilding or changing selection. Host Core reaches Workflow Runtime schema behavior through `gateway/host-core.ts`; it does not import certification, Store implementation, or execution internals.

Immediately before launch, startup reads `PRAGMA user_version`. `NO_STATE`, `SAME_SCHEMA`, and `MIGRATION_SUPPORTED` allow startup. `RESET_REQUIRED` and `UNKNOWN_BLOCKED` stop it. Current-version databases also run focused required table, column, and index checks. Supported older versions are migrated by normal Store startup.

## Workflow State Maintenance

State inspection and reset remain separate from snapshot selection:

```sh
local/shell/workflow-state.sh inspect --mode <current|active>
local/shell/workflow-state.sh reset --mode <current|active>
```

Inspection reports integer schema versions and the exact DB/WAL/SHM paths. Reset is available only for `RESET_REQUIRED`, refuses while launchd or a direct Host process is running, shows the exact paths and recovery location, and requires confirmation. It operates only on:

```text
data/workflow-runtime/workflow-runtime.db
data/workflow-runtime/workflow-runtime.db-wal
data/workflow-runtime/workflow-runtime.db-shm
```

The current quarantine implementation preserves these files under `workflow-runtime-state-backups/` before removing live state. Snapshot directories, credentials, configuration, Capacity, Registry, container data, and unrelated project data are never reset.

The broader engineering-weight decision is recorded in [`internal-experimental-scope.md`](internal-experimental-scope.md).
