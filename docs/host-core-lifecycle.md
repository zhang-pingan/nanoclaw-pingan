# Host Core Lifecycle

Icarus is an internal, experimental, single-user tool. Host Core lifecycle commands are local maintenance controls for one machine, not a multi-user deployment transaction.

## Frozen Versions

A frozen Host Core version is created only by an explicit user command:

```sh
local/shell/host-core-release.sh publish --version <version> [--skip-validation]
```

Publish requires a clean Git checkout at one exact commit and tree. It builds into isolated staging, inventories and hashes the complete artifact, installs it under its content hash, and exclusively creates one immutable `host-core-versions/<version>.json` record. A version can never be rebound to another artifact. Repeating the exact publication is idempotent; a conflicting or concurrent binding fails closed.

Default validation runs `test:current`, `contracts:check`, `typecheck`, and `format:check`. `--skip-validation` records `SKIPPED_BY_USER`; it does not skip the build, manifest parsing, inventory and entry hashing, artifact verification, or immutable version binding. Publish does not change `active-core` or inspect or modify Workflow Runtime state.

## Active Selection

Selection is a separate explicit command:

```sh
local/shell/host-core-release.sh activate --version <version> [--skip-validation]
```

Activate resolves the exact immutable version record, verifies the complete release, displays current and target identities, and requires confirmation. Unless skipped, it also performs the lightweight readiness check. It then atomically replaces only the `active-core` symlink and verifies the selected result.

Activation does not inspect, migrate, reset, quarantine, or otherwise touch Workflow Runtime state. It creates no deployment, audit, journal, recovery, or lock state. Historical lifecycle files are left untouched and ignored. Formal Host production identity is derived directly from the verified `active-core`. The accepted legacy G8 `1.2.14` active binding remains supported by the verifier and launcher.

## Startup

Host startup always names the code source:

```sh
local/shell/start.sh --mode current
local/shell/start.sh --mode active
```

`current` installs/verifies the managed toolchain, builds the current checkout, checks Workflow Runtime schema compatibility, and launches that build. It does not publish or change selection.

`active` verifies and launches the immutable release selected by `active-core` without rebuilding or changing selection.

Immediately before either launch, startup performs a read-only schema decision for the selected code identity:

- `NO_STATE`, `SAME_SCHEMA`, and `MIGRATION_SUPPORTED` allow startup. Supported migration remains owned by normal Store startup.
- `RESET_REQUIRED` blocks startup with a stable decision.
- `UNKNOWN_BLOCKED` blocks startup. Unverifiable databases, non-regular state files, and broken symlinks are never treated as no state.

## Workflow State Maintenance

State inspection and reset are independent of publish and activation:

```sh
local/shell/workflow-state.sh inspect --mode <current|active>
local/shell/workflow-state.sh reset --mode <current|active>
```

`inspect` is read-only. It reports the selected code identity, current and target schema identities, decision, reason, and the exact database paths.

`reset` is available only for a recognized `RESET_REQUIRED` decision. Unknown identity remains blocked. The command refuses to continue while the launchd service or a direct current/active Host process is running, never stops it implicitly, displays the exact DB/WAL/SHM paths and identities, and requires confirmation.

Reset operates only on:

```text
data/workflow-runtime/workflow-runtime.db
data/workflow-runtime/workflow-runtime.db-wal
data/workflow-runtime/workflow-runtime.db-shm
```

The present unit is moved into an immutable, content-identified `workflow-runtime-state-backups/<hash>/` quarantine with a manifest. Repeating the same quarantine completes or verifies the same recoverable result. Releases, version records, credentials, configuration, Capacity, Registry, container data, and unrelated project data are not reset.
