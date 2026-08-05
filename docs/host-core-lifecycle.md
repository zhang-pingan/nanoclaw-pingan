# Host Core Lifecycle

Icarus is an internal, experimental, single-user tool. Host Core lifecycle commands are optional local rollback and state-protection controls for one machine, not a multi-user deployment transaction, production release system, or availability guarantee. Normal development should use `current`; create or select a snapshot only when a risky change makes a known-good local fallback valuable.

Legacy command and serialized names retain `release`, `publish`, `activate`, `production`, and `frozen` for compatibility. In current project language these mean local snapshot and local selection. New work must not extend them with approval chains, deployment journals, certification stages, independent sign-off, or other product-release governance unless a concrete local failure mode first justifies the cost.

## Local Stable Snapshots

A local Host Core snapshot is created only by an explicit user command:

```sh
local/shell/host-core-release.sh publish --version <version> [--skip-validation]
```

`publish` currently requires a clean Git checkout at one exact commit and tree. It builds into isolated staging, inventories and hashes the complete artifact, installs it under its content hash, and creates one immutable `host-core-versions/<version>.json` record. These checks make local rollback deterministic, but the complete inventory and immutable version binding are stronger than the project's minimum requirement and are candidates for later simplification. They are not a release-quality promise.

Default validation runs `test:current`, `contracts:check`, `typecheck`, and `format:check`. `--skip-validation` records `SKIPPED_BY_USER`; it does not skip the build, manifest parsing, inventory and entry hashing, artifact verification, or immutable version binding. Publish does not change `active-core` or inspect or modify Workflow Runtime state.

## Local Snapshot Selection

Selection is a separate explicit command:

```sh
local/shell/host-core-release.sh activate --version <version> [--skip-validation]
```

`activate` resolves the requested local snapshot, verifies it, displays current and target identities, and requires confirmation. It atomically replaces `active-core` only after target checks pass; a failure keeps or restores the prior selection. Atomic selection and rollback protect normal local use. Full artifact/toolchain identity verification is compatibility behavior that may be reduced if it becomes a material iteration cost.

Selection does not inspect, migrate, reset, quarantine, or otherwise touch Workflow Runtime state. It creates no deployment, audit, journal, recovery, or lock state. Historical lifecycle files are left untouched and ignored. Legacy Host identity fields are derived directly from the verified `active-core`; their former production wording has no external meaning. The legacy G8 `1.2.14` active binding remains supported only for compatibility with existing local state.

## Startup

Host startup always names the code source:

```sh
local/shell/start.sh --mode current
local/shell/start.sh --mode active
```

`current` installs/verifies the managed toolchain, builds the current checkout, checks Workflow Runtime schema compatibility, and launches that build. It does not publish or change selection.

`active` verifies and launches the local snapshot selected by `active-core` without rebuilding or changing selection.

Immediately before either launch, startup performs a read-only schema decision for the selected code identity. This is a retained local-state safeguard:

- `NO_STATE`, `SAME_SCHEMA`, and `MIGRATION_SUPPORTED` allow startup. Supported migration remains owned by normal Store startup. Current mode uses current-checkout migration authority; active mode uses the selected release's frozen, integrity-checked compatibility descriptor and never inherits migration support from the current checkout. A legacy release without frozen migration authority can still launch with no state or the same verified schema, but any migration decision fails closed.
- `RESET_REQUIRED` blocks startup with a stable decision.
- `UNKNOWN_BLOCKED` blocks startup. Unverifiable databases, non-regular state files, and broken symlinks are never treated as no state.

## Workflow State Maintenance

State inspection and reset are independent of publish and activation:

```sh
local/shell/workflow-state.sh inspect --mode <current|active>
local/shell/workflow-state.sh reset --mode <current|active>
```

`inspect` is read-only. It reports the selected code identity, current and target schema identities, decision, reason, and the exact database paths.

`reset` is available only for a recognized `RESET_REQUIRED` decision or to finish one unambiguous incomplete quarantine previously created by this command. Unknown identity remains blocked. The command refuses to continue while the launchd service or a direct current/active Host process is running, never stops it implicitly, displays the exact DB/WAL/SHM paths, recorded identities, and recovery path, and requires confirmation.

Reset operates only on:

```text
data/workflow-runtime/workflow-runtime.db
data/workflow-runtime/workflow-runtime.db-wal
data/workflow-runtime/workflow-runtime.db-shm
```

The present unit is moved into `workflow-runtime-state-backups/` before reset so the user has a recovery path. The current implementation also uses content identities, durable manifests, resumable interruption handling, strict collision/tamper checks, and hardened immutable backups. Backup-before-reset, exact path scoping, confirmation, and refusal while the Host is running are required local safety behavior. Content-addressed quarantine identities and exhaustive recovery proof are candidates for simplification if maintenance cost exceeds the real interruption risk. Snapshots, version records, credentials, configuration, Capacity, Registry, container data, and unrelated project data are not reset.

The broader engineering-weight decision is recorded in [`internal-experimental-scope.md`](internal-experimental-scope.md).
