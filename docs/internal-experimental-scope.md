# Icarus Internal Experimental Scope

## Positioning

Icarus is an internal, experimental, single-user tool. It is developed for the current user's real local workflows, but it is not a product that must be delivered to external users with formal service guarantees.

The project does not promise:

- SLA, availability, support response time, or uninterrupted upgrades;
- public API stability or indefinite backward compatibility;
- release certification, independent approval, compliance evidence, or customer auditability;
- support for arbitrary installations, operators, tenants, or deployment environments.

Development controls have only three legitimate goals:

1. Detect likely regressions early enough to reduce rework.
2. Protect local data, credentials, and a known-good way to keep using the project.
3. Make failures diagnosable and recovery actions understandable.

A mechanism that does not materially serve one of these goals should not block normal development.

This boundary overrides stronger product-release wording in active design notes and `local/docs/` plans. Historical archives remain unchanged as provenance. Security requirements and descriptions of behavior that already protects live local state are not overridden.

## Terminology

Some existing paths and serialized formats retain stronger historical wording. Renaming every identifier would create more risk than value, so the compatibility names remain while their project meaning is narrowed.

| Existing term | Meaning in this project | Does not mean |
| --- | --- | --- |
| contract | Internal machine interface or regression fixture | Customer contract or permanent public API |
| freeze / frozen | Known-good local snapshot or immutable test fixture | Organization-wide change freeze |
| publish / release | Create a local rollback snapshot or retained regression baseline | Ship a supported product |
| activate | Select which local snapshot starts | Deploy to customer production |
| production | Legacy identifier for the previously accepted local path | SLA-backed environment |
| certification / readiness | Optional exhaustive compatibility check | Formal release certification |
| audit / evidence | Diagnostic trace or reproducibility material | Compliance evidence |
| approval | Protection against an accidental local action | Separation-of-duties process |

New code and documentation should use the narrower wording unless it must preserve an existing machine identifier.

## Engineering Weight Review

Snapshot on 2026-08-04: `src/workflow-runtime/contracts/` contains 2,842 files, including 2,443 conformance files; its JSON files total about 35 MB. The prior default test chain also included current contracts, a complete physical snapshot verifier, certification, production activation, and Host Core lifecycle tests. This is materially heavier than the current project positioning requires.

### Keep In The Normal Path

These controls directly protect local use or catch high-probability regressions:

- Type checking, focused unit/integration tests, and schema validation for the changed domain.
- Read-only startup compatibility checks for the live SQLite database.
- Supported migrations, exact reset path scoping, backup before reset, and a clear recovery location.
- Atomic `active-core` selection and preservation of the previous selection on failure.
- Container isolation, mount allowlists, credential proxying, IPC authorization, and confirmation for destructive or externally visible actions.
- Small, versioned contracts at persisted-data and process boundaries that can change independently.

Schema compatibility is based on one authoritative integer version, preferably
SQLite `PRAGMA user_version`. Fresh databases write the current version,
supported older versions migrate transactionally, and newer or unknown versions
fail with an actionable diagnostic. A current-version database receives focused
table, column, and index smoke checks. A legacy database without `user_version`
may derive it once from explicit old metadata and persist it transactionally;
normal startup does not continue reading historical schema hashes afterward.

Functional identities remain where the runtime consumes them: Workflow, Run,
Node, Delegation, Registry resource, and database record IDs; idempotency keys;
payload or object hashes used for content addressing or deduplication; backup
copy size/checksum verification; and download checksums used while installing an
archive.

Internal positioning does not justify weakening credential, host-access, privacy, or destructive-action safety. A single-user tool can still damage valuable local or external state.

### Removed From The Default Path

The following checks remain explicit but no longer run as part of normal `contracts:check` or `test:current`:

- Byte-for-byte verification of the retained v1 physical release archive.
- Workflow Runtime certification tests.
- Legacy G9 production activation tests.

Cross-module Identity governance is removed entirely, rather than retained as
an optional gate. This includes Runtime identity modes/evidence, formal Host and
G8/G9 release identities, frozen logical/migration/physical Schema hash chains,
and Compiler source/toolchain/package-lock/dependency/parser-wrapper/Node or
implementation identity manifests. A behavior-preserving refactor must not
require an identity hash update.

The pull-request CI also no longer runs the retained physical snapshot verifier for unrelated changes.

Use `npm run contracts:check:full` or `npm run test:full` only when changing these compatibility surfaces or investigating their historical artifacts.

### Next Simplification Candidates

The executable migration design is documented in [`workflow-runtime-guardrail-simplification-plan.md`](workflow-runtime-guardrail-simplification-plan.md).

1. Remove G9 production activation from active source. Keep only an explicit, temporary reader for inspecting and migrating an existing local legacy pointer; nothing new may depend on deployment activation requests, activation audit records, journal events, capacity genesis evidence, or independent G8/G9 approval semantics.
2. Collapse conformance history. Keep one current positive/negative fixture set per active boundary and move superseded Golden Draft, review-candidate, sealed, repair, and Gate-era generations out of the active source tree.
3. Replace multi-stage Golden Draft/review/semantic-review/seal workflows with a checked-in fixture plus a focused replay test. Git review already supplies change history for this single-user project.
4. Reduce Host Core snapshot verification to the entry artifact, integer Workflow schema version and supported migration range, Node major/ABI/platform/arch compatibility, and atomic pointer. Do not record Runtime, Compiler, release, or physical-schema identity hashes.
5. Simplify workflow-state reset recovery to a timestamped backup directory plus manifest and atomic move where the platform permits. Record observed/target schema versions and ordinary copied-file checksums, not old/target schema identities or content-derived backup IDs. Retain confirmation, process-running detection, path scoping, and backup verification.
6. Replace exact managed-Node identity with supported major, platform/arch, native ABI, and a `better-sqlite3` in-memory query smoke. A download checksum may protect installation bytes, but it is not runtime or snapshot identity.
7. Review artifact contracts and stage gates by observed failure rate. Fields or approvals that have not prevented a real defect should become warnings or be removed.
8. Remove raw-hash verification of archived Markdown and accepted-commit diffs over current source. Git history/tag is the historical authority; documentation corrections must not fail a runtime archive gate.

### Preserve History Without Active Governance

Git history and the historical accepted bundle preserve old G0-G9 construction
bytes. Active source does not retain Identity readers, hashes, or compatibility
exports merely to validate that history. Functional persisted IDs and hashes are
not renamed or removed unless their live consumer has also been removed.

## Decision Rule For New Mechanisms

Before adding a gate, contract version, approval state, snapshot layer, or audit artifact, record:

- the concrete local failure it prevents;
- the smallest cheaper control considered;
- whether it blocks normal development or runs only on demand;
- how it will be removed if the failure does not recur.

Default to a focused test, recoverable operation, or warning. Use a blocking gate only when failure would corrupt valuable local state, expose credentials, perform an unintended external action, or make the known-good local runtime unavailable.
