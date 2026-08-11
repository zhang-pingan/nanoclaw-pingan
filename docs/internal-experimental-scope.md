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
2. Protect local files, credentials, current working state, and a known-good way to keep using the project.
3. Make failures diagnosable and recovery actions understandable.

A mechanism that does not materially serve one of these goals should not block normal development.

This boundary overrides stronger product-release wording in active design notes and `local/docs/` plans. Git history and tags preserve historical provenance; historical construction copies do not need to remain in the active source tree. Security requirements and descriptions of behavior that already protects live local state are not overridden.

## Development Version Policy

Icarus is still in active development and has no real historical business dataset, signed protocol history, or external client population that requires backward compatibility. The project therefore uses a project-wide **latest-only** policy until that premise changes:

- each new protocol, JSON schema, API, event, Git layout, or SQLite schema becomes the only current version when it lands;
- replace and remove superseded readers, writers, reducers, endpoints, migrations, feature flags, fixtures, and compatibility tests;
- do not dual-write old and new formats, replay obsolete events into the current model, or negotiate with stale clients;
- keep explicit format and version identifiers so stale or future input can be detected and rejected fail closed; version fields are not compatibility promises;
- handle an old development store or fixture through an explicit, narrowly scoped reset, reinitialization, or fresh checkout rather than a migration chain;
- keep active documentation and examples aligned with the current version; Git history retains superseded designs.

Latest-only removes compatibility work; it does not authorize silent or broadly scoped deletion. Source files, configuration, credentials, user-authored artifacts, and any current local state outside the replaced store remain protected. A reset must identify its exact targets, explain the recovery path, and use a backup when loss would be difficult to reverse.

Before the first real group, irreplaceable business record, signed history, or external client dependency is created, the project must declare a compatibility freeze point and replace this policy with an explicit version-support, migration, and replay policy. Backward compatibility does not arise implicitly.

The current Collaboration boundary is Project Space protocol v4 with local SQLite schema v12. The earlier Agent Group v1/v2 Role/Claim and single-Machine documents are historical design baselines only. Current code, API examples, tests, backups, and replay must reject those formats rather than migrate, dual-write, or reinterpret them. Before a real signed Group history exists, any further incompatible Collaboration change must replace v4 explicitly and update the active plan and root documentation in the same change.

## Supported Runtime Topology

The Icarus Host runs from one local Git checkout. Dependency setup, builds, service-manager entries, configuration, local data paths, and optional Host Core snapshots are resolved from or for that checkout. Browser access and Electron clients are interfaces to the same checkout-owned Host.

The project does not maintain a standalone `.app`, DMG/PKG installer, Host embedded in an application bundle, packaged-install state migration, signing/notarization pipeline, or automatic product updater. `dev:electron`, `build:electron`, `dev:assistant`, and `build:assistant` remain checkout development commands, not distribution commands.

This topology decision does not narrow the existing macOS/Linux/WSL service implementations and does not remove the optional managed Node fallback. Those are separate environment-compatibility concerns.

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

## Engineering Weight Baseline

Before simplification, the 2026-08-04 snapshot of `src/workflow-runtime/contracts/` contained 2,842 files, including 2,443 conformance files; its JSON files totaled about 35 MB. The default test chain also included current contracts, a complete physical snapshot verifier, certification, production activation, and Host Core lifecycle tests. This was materially heavier than the current project positioning required.

Construction-stage governance also remained in source and package scripts: frozen Gate ownership, G0 exit evidence, G5-G7 readiness audits, sealed/successor compatibility checks, and a formatting baseline that grandfathered 48 of 530 TypeScript files by individual hash. The six-phase simplification removed these mechanisms from the current development path.

### Keep In The Normal Path

These controls directly protect local use or catch high-probability regressions:

- Type checking, focused unit/integration tests, and schema validation for the changed domain.
- Read-only startup checks that accept only the current SQLite schema and fail closed on stale versions.
- Exact reset path scoping, explicit reinitialization, backup when needed, and a clear recovery location; migration chains are not maintained during latest-only development.
- Atomic `active-core` selection and preservation of the previous selection on failure.
- Container isolation, mount allowlists, credential proxying, IPC authorization, and confirmation for destructive or externally visible actions.
- Small, versioned contracts at persisted-data and process boundaries that can change independently.

Internal positioning does not justify weakening credential, host-access, privacy, or destructive-action safety. A single-user tool can still damage valuable local or external state.

### Removed From The Engineering Path

The implementation removed the following mechanisms as active blocking or optional certification commands:

- Byte-for-byte verification of the retained v1 physical release archive.
- Workflow Runtime certification tests.
- Legacy G9 production activation tests.
- Frozen Gate ownership and Gate ownership contract generation.
- G0 exit evidence and G5-G7 readiness authorities.
- Fixed cross-era tests that only prove a completed construction milestone.
- Per-file format-debt hash allowances.

Current runtime invariants extracted from these wrappers remain as focused unit, integration, current-schema boundary, or startup tests. Historical construction state remains available from Git. A retained compressed snapshot is non-active diagnostic material: no default command verifies it or uses it as a runtime input.

### Implemented Simplification Baseline

The executable design in [`workflow-runtime-guardrail-simplification-plan.md`](workflow-runtime-guardrail-simplification-plan.md) has been implemented. The current baseline is:

- G9 production activation, its journal/audit/genesis chain, and cross-cutting Runtime, Compiler, Schema, Host, and Node Identity governance are absent from active runtime paths.
- Conformance contains focused current domain fixtures rather than construction-era draft, candidate, sealed, repair, and Gate copies.
- Compiler validation uses one checked-in Golden corpus plus deterministic `golden:check` and `golden:replay` paths.
- Host Core rollback uses optional local snapshots, minimal compatibility metadata, atomic `active-core` selection, and a real entry-module startup smoke.
- Workflow state maintenance uses timestamped backup directories, a small manifest, exact DB/WAL/SHM path scoping, explicit restore, and process exclusion.
- Node selection uses one configured executable path, supported major/platform/architecture, native ABI compatibility, and a `better-sqlite3` query smoke.
- Archived Markdown hashes, accepted-commit source comparisons, Gate/readiness authorities, generated import-absence proofs, and per-file format hashes do not block current development.
- Runtime gateway ownership is enforced by one direct static import-boundary test.

The continuing rule is to review any new artifact contract or stage gate against an observed local failure. A field, approval, or blocking step that does not prevent a concrete failure should remain a warning or be omitted.

### Historical Cleanup Rule

Historical G0-G9 artifacts, frozen Gate ownership, and independent acceptance metadata were removed from the active development path when they no longer protected current behavior. Future cleanup should not mass-rename or regenerate internal hashes; preserve historical state with Git history or a tag. Serialized `production` names may remain only when the current schema still defines them, not solely to read an obsolete version.

Runtime database command/event/value history, payload retention, and GC are a separate operational-data concern. They are outside this engineering-governance cleanup unless measurement shows that they materially slow development, tests, startup, or normal local use.

At this decision point there is no historical Workflow Run or persisted Compiler Plan that must be resumed. Compiler Identity removal may therefore use a clean new Plan/Run serialization boundary without a legacy reader or migration. This does not permit resetting unrelated Registry, Capacity, Workflow-definition, user-artifact, or other local state.

## Decision Rule For New Mechanisms

Before adding a gate, contract version, approval state, snapshot layer, or audit artifact, record:

- the concrete local failure it prevents;
- the smallest cheaper control considered;
- whether it blocks normal development or runs only on demand;
- how it will be removed if the failure does not recur.

Default to a focused test, recoverable operation, or warning. Use a blocking gate only when failure would corrupt valuable local state, expose credentials, perform an unintended external action, or make the known-good local runtime unavailable.
