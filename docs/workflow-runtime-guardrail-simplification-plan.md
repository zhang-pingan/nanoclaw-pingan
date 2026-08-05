# Workflow Runtime Guardrail Simplification Plan

> **Status**: Approved design; implementation has not started
> **Scope**: Workflow Runtime conformance and Golden assets, G9 Production Activation, Host Core snapshots, Workflow Runtime state backup, managed Node identity
> **Project boundary**: Icarus is an internal, experimental, single-user tool. This plan optimizes for local iteration stability and recoverability, not external delivery or production certification.

## 1. Decision Summary

This plan replaces product-grade release governance with the minimum controls needed to:

1. detect likely regressions before they create rework;
2. keep a known-good local runtime available;
3. protect local SQLite state during incompatible changes;
4. preserve credential, host-access, and destructive-action safety.

The release and activation result is explicit:

| Existing mechanism | Result after this plan |
| --- | --- |
| Host Core `publish` | Retained as local snapshot creation, with simpler metadata and validation |
| Host Core `activate` | Retained as atomic local snapshot selection through `active-core` |
| G9 Production Activation | Removed from the active runtime |
| `activation-core` | Removed after one compatibility migration |
| `active-deployment` | Removed after one compatibility migration |
| Activation request/audit/journal/binding/recovery | Removed |
| Capacity genesis activation | Replaced by idempotent first-run Store initialization |
| Feature/Workflow Registry publish and activate | Retained as an internal business capability |
| `archive:verify:v1` / `contracts:archive:check` | Removed; Git history/tag is the historical authority |
| Historical accepted release bundle | Retained only through the legacy compatibility window, then removed from active verification |

The target startup model is:

```text
current checkout
  -> build
  -> schema compatibility decision
  -> Node/native-module compatibility smoke
  -> start

optional local snapshot
  -> create in isolated staging
  -> startup smoke
  -> atomic install
  -> atomic active-core selection
  -> start
```

There is no deployment transaction, production activation journal, independent acceptance role, or Capacity activation ceremony in the target model.

## 2. Current Weight

As measured on 2026-08-04:

- `src/workflow-runtime/contracts/` contains 2,842 files.
- `src/workflow-runtime/contracts/conformance/` contains 2,443 files.
- `sealed/`, `golden-draft/`, and `review-candidate/` account for 1,872 conformance files.
- Contract JSON files occupy about 35 MB in the working tree.
- Golden authoring, review, sealing, repair, and replay support spans about 26 source files and 12,000 lines.
- Host Core release, activation, persistent-state handling, and runtime toolchain scripts span more than 4,000 implementation lines before tests.
- G9 semantics are referenced by certification, Capacity, Compiler inventory, Store identity, runtime toolchain, Registry activation, and generated contracts.

The problem is not only repository size. Every additional generated identity, review state, pointer, and recovery protocol increases the number of files that must change together during ordinary iteration.

The current archive verifier is also over-scoped. It pins the raw SHA-256 of six historical Markdown files, compares broad current Runtime source trees with one accepted commit, and performs reachability/provenance assertions. Editing historical documentation or legitimately evolving current source therefore makes an optional historical audit fail. Git already preserves the exact historical bytes, so this verifier adds maintenance cost without protecting local runtime state.

## 3. Required Boundaries

The simplification must not weaken these controls:

- Containers remain the execution boundary for high-capability Agents.
- Real credentials remain outside containers.
- Mount allowlists and IPC authorization remain enforced.
- Destructive or externally visible actions retain explicit confirmation or policy checks.
- Startup must not silently open an incompatible Workflow Runtime database.
- Reset must never operate outside the exact Workflow Runtime DB/WAL/SHM paths.
- A reset must create a usable backup before removing live state.
- `active-core` changes must remain atomic and preserve the previous selection on failure.
- Persisted-data and independently evolving process boundaries may retain small versioned contracts.

The following are not required boundaries:

- independent approval actors;
- immutable review evidence chains;
- byte-for-byte inventories of every build member;
- deployment journals for one local process;
- multiple activation pointers representing preparation, deployment, and Core selection;
- an exact Node executable hash when the Node ABI and native module are compatible.

## 4. Phase 1: Replace The Golden Lifecycle

### 4.1 Goal

Replace draft, review, semantic-review, seal, and successor-repair stages with one checked-in current corpus and deterministic replay.

### 4.2 Target Layout

```text
src/workflow-runtime/compiler/golden/
  cases@1.json
  manifest@1.json
```

The manifest contains only:

- format and corpus version;
- Compiler semantic version;
- case count;
- corpus hash calculated by the tool;
- optional short change reason.

It does not contain approver identities, review timestamps, approval decisions, predecessor seals, or manually supplied report hashes.

### 4.3 Target Commands

```text
golden:update   generate into a temporary directory, validate, replay, then update the corpus
golden:check    generate into a temporary directory and compare with the committed corpus
golden:replay   run deterministic replay against the committed corpus
```

Git diff and the normal code review/commit history become the review record.

### 4.4 Migration

1. Build the new corpus from the current accepted cases without changing expected behavior.
2. Run old and new replay paths against the same Compiler output.
3. Require identical case IDs, expected results, and replay decisions for one transition change.
4. Change `contracts:check` and `test:current` to call only the new `golden:check` and `golden:replay` paths.
5. Remove old authoring commands after parity is established.

### 4.5 Delete Candidates

- `current-g2-golden-draft-*`
- `current-g2-golden-review-*`
- `current-g2-golden-semantic-review-*`
- `current-g2-golden-seal-*`
- superseded replay-repair successor authoring/sealing paths
- hard-coded `--authorized-by`, decision, review hash, and reviewed-at arguments in `package.json`

Historical accepted bytes remain available through Git history and the existing accepted release bundle.

### 4.6 Exit Criteria

- One corpus is authoritative for the current Compiler.
- `golden:check` detects generated drift.
- `golden:replay` preserves all current semantic decisions.
- No default script reaches draft/review/seal code.
- At least 70% of Golden lifecycle implementation code is removed from HEAD.

### 4.7 Rollback

The old commands remain callable but non-default during the parity change. Revert the package-script switch if the two replay paths disagree.

## 5. Phase 2: Collapse Conformance History

### 5.1 Goal

Keep only cases that validate active behavior. Remove historical construction-state copies from the active source tree.

### 5.2 Target Fixture Policy

Each active domain may keep:

- its current schema or contract pack;
- one representative positive fixture set;
- one negative fixture for each stable public/internal error code;
- focused boundary and recovery cases;
- explicitly named regression cases for defects that previously escaped tests.

Repeated copies of the same case across draft, candidate, review, sealed, and repair directories are not allowed.

### 5.3 Target Layout

```text
src/workflow-runtime/contracts/conformance/current/
  <domain>/
    positive-cases.json
    negative-cases.json
    regression-cases.json       # optional
```

A small catalog may list the active domain roots. The catalog must not recursively hash every historical file or introduce another approval lifecycle.

### 5.4 Migration

1. Generate a read-reachability report from current production source and default tests.
2. Classify fixtures as active, duplicate, or historical-only.
3. Copy unique historical regression cases into the matching current domain set.
4. Point active tests and generators at the new current roots.
5. Tag the last commit containing the complete historical tree.
6. Delete historical-only directories from HEAD rather than moving them under another tracked archive directory.

Recommended tag:

```text
workflow-runtime-v1-conformance-history
```

Deleting files from HEAD reduces working-tree and package weight. It does not reduce existing Git history size. History rewriting is a separate, optional operation and is not part of this plan.

### 5.5 Delete Candidates

- `conformance/sealed/`
- `conformance/golden-draft/`
- `conformance/review-candidate/`
- `conformance/draft/`
- `conformance/candidate/`
- `conformance/golden-review/`
- `conformance/golden-semantic-review/`
- superseded repair and milestone-specific copies that are no longer imported

### 5.6 Retire The Historical Archive Verifier

`archive:verify:v1` and `contracts:archive:check` are removed during this phase.

Delete:

- `scripts/verify-dynamic-workflow-runtime-v1-archive.mjs`;
- the two package scripts;
- command references from current documentation;
- raw Markdown hash constants;
- accepted-commit diffs over current Runtime source;
- retired-script reachability and historical-literal counts maintained only for archive proof.

Historical authority becomes:

1. the Git commit/tag containing the accepted v1 state;
2. ordinary Git history for later documentation corrections;
3. the temporary legacy release bundle only while an installed legacy binding still needs migration.

If a lightweight boundary is still useful, `contracts:static:check` may contain a simple rule that active runtime source must not read `docs/archive/`. That rule must not hash Markdown, compare current source with an old commit, or walk package-script dependency graphs.

The correct response to an edited historical document is not to update a frozen hash. Either accept the documentation correction in Git or retrieve the original bytes from the historical tag.

### 5.7 Exit Criteria

- Active conformance contains no more than 350 files and 5 MB unless a documented exception is approved by the local owner.
- Every default conformance test reads only `current/` or a directly owned domain fixture.
- No current runtime or build reads historical construction paths.
- No package script verifies raw historical Markdown hashes or diffs current source against the accepted construction commit.
- All retained error codes and known regression cases remain covered.

### 5.8 Rollback

Restore the removed paths from the history tag if an active case was missed. Do not regenerate the historical tree or restore raw-hash enforcement for Markdown.

## 6. Phase 3: Remove G9 Production Activation

### 6.1 Goal

Remove the product-grade deployment transaction while preserving local startup, local snapshot selection, existing Registry state, and existing Capacity state.

### 6.2 Target Behavior

```text
Store startup
  -> open or create Store
  -> apply supported schema migrations
  -> ensure local Capacity defaults if no Capacity head exists
  -> preserve an existing Capacity head byte-for-byte

Host startup
  -> select current checkout or active-core snapshot
  -> validate schema compatibility
  -> start
```

There is no `active-deployment`, staging activation pointer, activation journal, activation audit authority, or multi-participant roll-forward/recovery operation.

### 6.3 Capacity Migration

Replace `system:production-activation` genesis with an idempotent Store operation:

```text
ensureCapacityDefaults()
```

Rules:

- If no Capacity head exists, insert revision 1 in the same Store transaction using checked-in local defaults.
- If a Capacity head exists, do not replace, repair, or re-seed it.
- Normal Capacity administration continues through the existing admin gateway.
- The initialization result is a normal diagnostic log/event, not certification evidence.

### 6.4 Pointer Migration

`active-core` becomes the only authoritative runtime selection.

Provide one explicit compatibility command:

```text
host-core legacy-activation inspect
host-core legacy-activation migrate
```

The migration command:

- performs a read-only inspection first;
- derives the selected Core snapshot from the legacy binding;
- verifies that the target snapshot exists and can start;
- atomically writes `active-core`;
- renames old pointers/metadata to a `.legacy` area or leaves them ignored;
- never replays an activation journal.

No automatic mutation occurs during normal startup.

### 6.5 Source Removal

Remove active dependencies in this order:

1. Store identity modes and reads of `activation-core`/`active-deployment`.
2. Capacity genesis actor and evidence requirements.
3. Compiler source allowlists for G9 activation entries.
4. Release manifest requirements for activation entries and Capacity genesis bundles.
5. Runtime toolchain selectors and `stage-production-release` behavior.
6. Registry activation entry/runtime/transaction modules.
7. G9 contract generators, schemas, package scripts, and default/full tests.

Expected removal roots include:

- `src/workflow-runtime/registry/production-activation*.ts`
- `src/workflow-runtime/registry/capacity-genesis-bootstrap-runtime.ts`
- `src/workflow-runtime/contracts/g9-production-activation*.ts`
- `src/workflow-runtime/contracts/g9-capacity-genesis-bootstrap.ts`
- `src/workflow-runtime/contracts/production-activation/`
- `src/workflow-runtime/certification/g9-production-release-cli.ts`

The accepted physical release bundle is not changed during G9 removal. Its internal G9 files remain historical bytes until the legacy compatibility window closes.

### 6.6 Feature Activation Boundary

Workflow and Feature Registry publish/activate remains supported. It selects an internal versioned resource and is not the G9 deployment transaction.

Feature activation must not acquire G9 audit, deployment journal, Capacity genesis, or independent certification dependencies.

### 6.7 Exit Criteria

- Non-test active source contains no reference to `active-deployment`.
- Non-compatibility active source contains no reference to `activation-core`.
- No current source requires `system:production-activation`.
- Existing Capacity heads are preserved in migration tests.
- Fresh Store startup creates usable default Capacity exactly once.
- Current and snapshot Host startup work without G9 assets.
- Feature release activation tests continue to pass independently.

### 6.8 Rollback

Keep the legacy activation reader and old G9 code in separate commits. Revert the source-removal commit if existing local bindings cannot be migrated. Never rewrite the accepted release bundle.

## 7. Phase 4: Simplify Host Core Snapshots

### 7.1 Goal

Retain a reliable known-good local runtime without maintaining a product-grade content-addressed release inventory.

### 7.2 Target Commands

```text
host-core snapshot create [--label <label>] [--full-check]
host-core snapshot list
host-core snapshot select --id <snapshot-id>
host-core snapshot verify --id <snapshot-id>
host-core snapshot remove --id <snapshot-id>
```

The existing `publish` and `activate` commands remain aliases for one stable snapshot cycle, then may be removed.

### 7.3 Target Layout

```text
host-core-snapshots/
  <timestamp>-<short-commit>-<suffix>/
    dist/
    snapshot.json
active-core -> host-core-snapshots/<snapshot-id>
```

`snapshot.json` contains:

- format and snapshot ID;
- creation time;
- Git commit and `dirty` flag;
- Core entry relative path;
- Workflow Runtime target schema identity and compatibility descriptor;
- Node major and native-module ABI expectations;
- build-complete marker or a single snapshot/entry checksum;
- validation result: `smoke_passed`, `full_passed`, or `skipped_by_user`.

It does not contain a hash and mode for every file, an immutable human version binding, certification evidence, or a G9 activation entry.

### 7.4 Snapshot Creation

1. Build in an isolated staging directory.
2. Validate the entry, schema descriptor, and Node/native-module smoke.
3. Run focused startup smoke by default.
4. Run `test:current`, `contracts:check`, typecheck, and format only with `--full-check`.
5. Write `snapshot.json` last.
6. Atomically rename the staging directory into `host-core-snapshots/`.

A dirty checkout is recorded and warned about, not universally blocked. The local owner may still create a diagnostic snapshot.

### 7.5 Snapshot Selection

1. Resolve and contain the snapshot path under `host-core-snapshots/`.
2. Validate `snapshot.json`, the Core entry, schema compatibility, and Node ABI.
3. Run lightweight startup smoke.
4. Atomically replace `active-core`.
5. Verify the resulting pointer.
6. Restore the previous pointer if post-switch verification fails.

### 7.6 Remove From Current Host Core

- complete file inventory generation and parsing;
- per-file mode and raw hash validation;
- content-addressed release directory naming;
- immutable version-name binding;
- separate release, production release, and activation bindings;
- G8/G9 release entry selectors;
- clean-checkout hard blocking for ordinary local snapshots.

### 7.7 Exit Criteria

- Creating and selecting a known-good snapshot works from one command each.
- A broken entry, incompatible schema, or incompatible Node ABI cannot become active.
- Pointer failure preserves the previous `active-core` bytes.
- Snapshot implementation and toolchain code is reduced by at least 50% without reducing these behaviors.

### 7.8 Rollback

During one stable snapshot cycle, readers accept both legacy Host Core version records and `snapshot.json`. New writes use only the new snapshot format.

After the legacy binding has been migrated and one new snapshot has completed create/select/start/rollback validation, remove `workflow-runtime:release:check` and its physical bundle from active package scripts. The historical commit/tag remains sufficient if the old bytes are ever needed again.

## 8. Phase 5: Simplify Workflow State Backup And Reset

### 8.1 Goal

Keep backup-before-reset and explicit recovery while removing content-addressed quarantine, immutable hardening, deduplication, and proof-heavy interrupted recovery.

### 8.2 Target Commands

```text
workflow-state inspect --mode <current|active>
workflow-state backup
workflow-state reset --mode <current|active>
workflow-state backups
workflow-state restore --backup <backup-id>
workflow-state gc --keep <count>
```

### 8.3 Target Layout

```text
workflow-runtime-state-backups/
  <timestamp>-<random-suffix>/
    backup.json
    workflow-runtime.db
    workflow-runtime.db-wal       # only when present
    workflow-runtime.db-shm       # only when present
    .incomplete                   # present only during backup/reset
```

`backup.json` contains:

- backup ID and creation time;
- source paths;
- observed schema identity when readable;
- target schema identity for reset;
- file names, sizes, and ordinary checksums;
- operation status and completion time.

The backup ID is not derived from content. Identical backups do not deduplicate.

### 8.4 Reset Flow

1. Refuse while launchd or a direct Host process is running.
2. Inspect exact DB/WAL/SHM paths and reject symlinks/non-regular files.
3. Display source paths and destination backup ID.
4. Require confirmation.
5. Create the backup directory and `.incomplete` marker.
6. Copy or move the exact DB unit and verify size/checksum.
7. Write the completed manifest.
8. Remove `.incomplete`.
9. Remove the live unit only after backup verification succeeds.

### 8.5 Interrupted Operations

If `.incomplete` exists, the next command reports it and offers only explicit `resume`, `restore`, or `discard-incomplete` actions. It does not infer a globally authoritative content identity, merge duplicate generations, or automatically finish an ambiguous operation.

### 8.6 Retention

Keep the most recent three to five backups by default. Cleanup is explicit through `gc`; reset never deletes an older complete backup automatically.

### 8.7 Retain

- exact path containment;
- process-running refusal;
- confirmation;
- backup before deletion;
- DB/WAL/SHM unit handling;
- checksum verification;
- explicit restore;
- fault-injection tests around each state-changing step.

### 8.8 Remove

- content-derived backup identity;
- immutable chmod hardening;
- identical-generation deduplication;
- collision proof between live and historical generations;
- automatic completion based on distributed source/backup member evidence;
- unrelated historical backup verification during a new reset.

### 8.9 Exit Criteria

- Reset cannot touch paths outside the Workflow Runtime DB unit.
- Fault injection before copy, during copy, after manifest write, and before live deletion always leaves either live state or a restorable backup.
- Restore recreates a DB that passes schema identity inspection.
- The command never mutates state without confirmation.

### 8.10 Rollback

The legacy backup reader remains available for existing content-addressed backups. New backup writes use only the timestamp format. The legacy reader is removable after all backups the owner cares about have been restored or explicitly retained outside the runtime directory.

## 9. Phase 6: Replace Exact Node Distribution Identity

### 9.1 Goal

Verify runtime compatibility rather than the identity of one downloaded Node executable.

### 9.2 Conservative Compatibility Model

The first simplified version should accept the current Node major rather than every version allowed by `engines`:

```text
Node major: current supported major
platform/arch: current host
native ABI: process.versions.modules
better-sqlite3: load plus in-memory query smoke
```

Supported majors can be expanded only after the normal test suite passes on them.

### 9.3 Runtime Resolution

1. Setup resolves the selected Node absolute path.
2. It verifies the supported major and architecture.
3. It loads `better-sqlite3` and runs an in-memory SQLite query.
4. It records the Node path, major, and ABI in local runtime configuration.
5. The stable launcher reads this local configuration and invokes the resolved binary.
6. A setup rerun refreshes the path after Node is upgraded or moved.

The launcher does not need to hash the Node executable, distribution manifest, npm binary, native module file, or every compile option.

### 9.4 Optional Managed Installer

Keep an optional managed Node installation command for machines without a compatible Node. Download checksums protect the download itself, but the installed distribution hash does not become part of every Core snapshot or Store identity.

Remove `active-node`; a single configured compatible Node path is sufficient for this local tool.

### 9.5 Snapshot Compatibility

Host Core snapshots record:

- supported Node major;
- expected native module ABI;
- platform and architecture.

Selection runs the actual native-module smoke. A matching executable hash is not required.

### 9.6 Exit Criteria

- Patch upgrades inside the supported Node major do not require rebuilding release identity artifacts.
- An ABI-incompatible `better-sqlite3` installation blocks startup with an actionable error.
- Fresh setup, current startup, snapshot startup, and launchd startup use the same resolver.
- `active-node`, exact executable hash binding, and production distribution identity are absent from active runtime code.
- `scripts/runtime-toolchain.sh` is reduced to installation convenience and compatibility checks rather than release authority.

### 9.7 Rollback

Keep the exact managed runtime installer as an optional fallback during one stable snapshot cycle. The fallback must not recreate G8/G9 release identity dependencies.

## 10. Delivery Sequence

Each phase should be an independently reviewable and revertible change. Do not combine G9 removal, Host Core snapshot changes, and state backup changes in one commit.

| Change | Scope | Risk | Required predecessor |
| --- | --- | --- | --- |
| 1. Golden single baseline | Compiler contracts and scripts | Medium | None |
| 2. Conformance and archive collapse | Fixtures, generators, archive verifier, package scripts | Medium | Golden single baseline |
| 3. G9 removal | Store, Capacity, Compiler, certification, toolchain, Registry | High | Current baseline tests stable |
| 4. Host Core snapshot v2 | Host Core release/activation and shell commands | High | G9 removed from release identity |
| 5. State backup v2 | Persistent state and reset CLI | High | Snapshot/startup identity stable |
| 6. Node compatibility model | Setup, launcher, runtime toolchain | High | Snapshot v2 metadata defined |

Recommended compatibility window: one successfully created, selected, started, and rolled-back local snapshot. This project does not need a calendar-based deprecation period.

## 11. Validation Matrix

Every phase runs focused tests plus the relevant rows below:

| Scenario | Required result |
| --- | --- |
| Current checkout startup with no Workflow DB | Starts and initializes local defaults |
| Current checkout startup with same schema | Starts without state rewrite |
| Supported schema migration | Migrates through Store authority |
| Unsupported schema | Blocks with stable diagnostic |
| Existing Capacity head | Preserved byte-for-byte by first-run initialization |
| New local snapshot | Builds and passes startup smoke |
| Broken snapshot entry | Cannot become active |
| Snapshot pointer switch failure | Previous `active-core` preserved |
| State reset | Complete backup exists before live deletion |
| Interrupted state backup/reset | Explicit resume or restore remains possible |
| State restore | Restored DB passes identity inspection |
| Node patch upgrade in supported major | Starts after ABI smoke |
| Native ABI mismatch | Blocks with rebuild/reinstall guidance |
| Feature Registry publish/activate | Continues to work without G9 |
| Golden drift | `golden:check` fails |
| Compiler semantic regression | `golden:replay` fails |

During the legacy compatibility window, the historical physical release verifier remains explicit and non-default and must pass without regeneration. After Host Core snapshot v2 has successfully replaced the legacy binding, remove the verifier and bundle from active package scripts rather than updating their hashes.

## 12. Repository Budgets

These budgets prevent the same governance weight from growing back:

- Active conformance: at most 350 files and 5 MB without a documented exception.
- Golden lifecycle: one current corpus and one replay path.
- Historical documentation: Git history/tag only; no raw-hash gate.
- Runtime selection: one authoritative pointer, `active-core`.
- State reset: one backup manifest format for new writes.
- Node selection: one configured Node path; no active distribution pointer.
- New blocking gate: must name the concrete local failure, cheaper alternatives considered, and removal condition.

Budget checks should be simple file/count checks. They must not introduce hashed evidence, approval actors, or another certification stage.

## 13. Known Risks

### 13.1 Static And Generated Closure

Current static-absence and Compiler source inventories reference several G9 and historical paths. Their active generators and tests must be updated in the same phase as source removal. Historical accepted artifacts are not regenerated.

### 13.2 Existing Local Pointers

Deleting G9 readers before inspecting `activation-core` and `active-deployment` could make an existing local selection unclear. The explicit legacy inspection/migration command is mandatory before removal.

### 13.3 Existing Capacity State

Capacity initialization must distinguish a truly empty Store from an existing head. Tests must prove that existing revisions and files receive zero writes.

### 13.4 SQLite Backup Consistency

DB/WAL/SHM handling is a real data-safety boundary. The simplified backup protocol still needs process exclusion, unit handling, checksums, restore tests, and fault injection.

### 13.5 Native Node Modules

`better-sqlite3` prevents unrestricted Node version fallback. Node simplification must land only after the ABI smoke is shared by setup, current startup, snapshot selection, and launchd.

### 13.6 Dirty Working Tree

Snapshot creation may allow a dirty checkout, but must record it visibly. A dirty snapshot is a local diagnostic convenience, not a reproducible baseline.

## 14. Definition Of Done

The full simplification is complete when:

- default Golden validation has one corpus and one replay path;
- active conformance is within the repository budget;
- G9 production activation has no active runtime entrypoint;
- `active-core` is the only runtime selection pointer;
- Host Core snapshots use minimal metadata and atomic selection;
- new state backups use the timestamp manifest format and support explicit restore;
- Node compatibility is based on supported major plus actual ABI smoke;
- Feature/Workflow publish and activate still work;
- credential, mount, IPC, destructive-action, schema, backup, and rollback safeguards remain intact;
- current tests, typecheck, schema checks, Golden replay, startup smoke, snapshot rollback, and state restore tests pass;
- no active command hashes archived Markdown or compares current source with the accepted construction commit;
- the historical release verifier and bundle have been removed after the legacy binding compatibility window.

This plan intentionally changes the release/activation mechanism: it removes G9 deployment activation and simplifies Host Core release/activation into local snapshot creation and selection. It does not remove the ability to maintain a known-good local runtime or activate internal Feature/Workflow versions.
