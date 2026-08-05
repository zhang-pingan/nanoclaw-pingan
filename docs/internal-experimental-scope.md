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

Internal positioning does not justify weakening credential, host-access, privacy, or destructive-action safety. A single-user tool can still damage valuable local or external state.

### Removed From The Default Path

The following checks remain explicit but no longer run as part of normal `contracts:check` or `test:current`:

- Byte-for-byte verification of the retained v1 physical release archive.
- Workflow Runtime certification tests.
- Legacy G9 production activation tests.

The pull-request CI also no longer runs the retained physical snapshot verifier for unrelated changes.

Use `npm run contracts:check:full` or `npm run test:full` only when changing these compatibility surfaces or investigating their historical artifacts.

### Next Simplification Candidates

The executable migration design is documented in [`workflow-runtime-guardrail-simplification-plan.md`](workflow-runtime-guardrail-simplification-plan.md).

1. Archive G9 production activation as a compatibility module. Nothing new should depend on deployment activation requests, activation audit records, journal events, capacity genesis evidence, or independent G8/G9 approval semantics.
2. Collapse conformance history. Keep one current positive/negative fixture set per active boundary and move superseded Golden Draft, review-candidate, sealed, repair, and Gate-era generations out of the active source tree.
3. Replace multi-stage Golden Draft/review/semantic-review/seal workflows with a checked-in fixture plus a focused replay test. Git review already supplies change history for this single-user project.
4. Reduce Host Core snapshot verification to the entry artifact, runtime/schema compatibility descriptor, and atomic pointer. A complete file inventory, per-file mode hash, immutable version-name binding, and duplicate legacy production binding are not all necessary for local rollback.
5. Simplify workflow-state reset recovery to a timestamped backup directory plus manifest and atomic move where the platform permits. Retain confirmation, process-running detection, path scoping, and backup verification.
6. Relax exact managed-Node identity only after checking the `better-sqlite3` native ABI constraint. Pinning a compatible Node major/ABI may be enough; downloading and hashing one exact distribution is stronger than ordinary local development needs.
7. Review artifact contracts and stage gates by observed failure rate. Fields or approvals that have not prevented a real defect should become warnings or be removed.
8. Remove raw-hash verification of archived Markdown and accepted-commit diffs over current source. Git history/tag is the historical authority; documentation corrections must not fail a runtime archive gate.

### Archive Rather Than Rewrite

Historical G0-G9 artifacts, frozen Gate ownership, independent acceptance metadata, and serialized `production` names should be archived or isolated, not mass-renamed. They contain internal hashes and cross-references; rewriting them would create churn without improving runtime behavior.

## Decision Rule For New Mechanisms

Before adding a gate, contract version, approval state, snapshot layer, or audit artifact, record:

- the concrete local failure it prevents;
- the smallest cheaper control considered;
- whether it blocks normal development or runs only on demand;
- how it will be removed if the failure does not recur.

Default to a focused test, recoverable operation, or warning. Use a blocking gate only when failure would corrupt valuable local state, expose credentials, perform an unintended external action, or make the known-good local runtime unavailable.
