---
name: manage-workflows
description: Create, revise, publish, activate, retire, or diagnose Icarus workflows using the current Task Workspace Personal Workflow lifecycle, Dynamic Workflow Runtime resources, or Collaboration Project Space v3 definitions. Use when a user asks to add or change a workflow, make a completed run reusable, publish or activate a workflow release, retire a collaboration workflow definition, or modify workflow compiler/runtime behavior.
---

# Manage Icarus Workflows

Manage the versioned workflow surface that owns the user's request. Workflow definitions are not a generic mutable configuration map.

## Safety and Scope

- Work only from the current checkout. Do not fetch, merge, compare, or configure another Git repository as part of workflow management.
- Inspect the active API, schema, tests, and persisted lifecycle before changing anything.
- Do not edit SQLite rows, compiled plans, hashes, active release pointers, or published immutable resources by hand.
- Do not load or copy `local/migration-candidates/dev-test-fix-test/` into production code. It is an inert archive and explicitly not executable.
- Treat publish, activate, retire, reset, and commands affecting running workflows as explicit state changes. Show the target and ask for confirmation when the user's request did not already authorize that exact action.
- Preserve running workflow instances. Never mutate a definition in place to change their meaning.

## Choose the Workflow Surface

Identify the surface before planning edits:

| User intent | Surface | Authority |
| --- | --- | --- |
| Turn a successful Task Workspace run into a reusable personal flow | Personal Workflow | `src/task-workspace/service.ts`, `src/task-workspace/web-api.ts`, `src/workflow-runtime/gateway/workspace.ts` |
| Change graph semantics, capabilities, recipes, compiler behavior, waits, effects, cards, or runtime execution | Dynamic Workflow Runtime | `src/workflow-runtime/` contracts, compiler, authoring, gateway, runtime, and store |
| Define a shared multi-user project process in a Git-backed group | Collaboration Project Space Workflow | `src/collaboration/project-space-service.ts`, `src/collaboration/web-api.ts`, v3 contracts |
| Enable Agent skills such as `devops` or `macos` | Container skill assignment | `container/skills/skills.json`; this is not a workflow definition |
| Run something on a cron, interval, or once schedule | Scheduler | Scheduled tasks; this is not a workflow definition |

If the request is ambiguous, explain the distinction and ask one focused question. Do not silently map Collaboration definitions to Dynamic Workflow Runtime resources or vice versa.

## Personal Workflow Lifecycle

Use Personal Workflows when the user wants to reuse a workflow that already ran through Task Workspace.

### Preconditions

- The source workflow/run must be linked to the requesting Task Session.
- The Runtime gateway must be available.
- A Personal Workflow is extracted from the exact source run; arbitrary import/export is not implemented.

### Lifecycle

Follow the current sequence:

1. Create a draft from the Task Session, workflow ID, and run ID.
2. Revise the sanitized `source_json` when needed.
3. Validate the exact revision.
4. Dry-run the exact revision.
5. Review it with explicit approval, display name, and optional description.
6. Publish an immutable release with a stable idempotency key.
7. Activate the exact release with the expected active-pointer row version and a stable idempotency key.

The Host exposes these routes:

```text
POST /api/task-workspace/sessions/:sessionId/personal-workflow-drafts
GET  /api/personal-workflows/drafts/:draftId
POST /api/personal-workflows/drafts/:draftId/revise
POST /api/personal-workflows/drafts/:draftId/validate
POST /api/personal-workflows/drafts/:draftId/dry-run
POST /api/personal-workflows/drafts/:draftId/review
POST /api/personal-workflows/drafts/:draftId/publish
POST /api/personal-workflows/releases/:releaseId/activate
```

Prefer the Web workbench over direct API calls for user-managed flows. When automating through the API, use the exact request keys from `src/task-workspace/web-api.ts` and carry forward each returned `row_version`.

Published releases are immutable. To change a published Personal Workflow, create and review a new draft/release; do not modify the existing release. The current API does not implement import, export, deletion, or a deactivate-without-replacement operation. Do not invent one or edit the store directly.

### Validation

For Personal Workflow service or API changes, run:

```bash
./scripts/runtime-toolchain.sh exec -- npx vitest run \
  src/task-workspace/personal-workflow-service.test.ts \
  src/task-workspace/web-api.test.ts \
  src/workflow-runtime/gateway/workspace.test.ts
```

## Dynamic Workflow Runtime Changes

Use this path for code-level changes to built-in workflow behavior or authoring infrastructure.

### Read the current authority

Start with the smallest relevant files:

- source graph schema: `src/workflow-runtime/contracts/schemas/graph-scope-source-schema.json`;
- Workflow Definition and Recipe schemas: `src/workflow-runtime/contracts/schemas/workflow-definition-schema.json` and `workflow-recipe-schema.json`;
- card/input presentation: `src/workflow-runtime/contracts/schemas/card-presentation-schema.json`;
- compiler: `src/workflow-runtime/compiler/`;
- staged publication and activation: `src/workflow-runtime/authoring/`;
- Task Workspace boundary: `src/workflow-runtime/gateway/workspace.ts`;
- execution and recovery: `src/workflow-runtime/runtime/`, `src/workflow-execution/`;
- current schema/store: `src/workflow-runtime/store/`.

Read `docs/internal-experimental-scope.md` before changing a serialized contract or persisted schema. The project is latest-only: replace superseded active formats and tests rather than adding compatibility readers, dual writes, or migration chains for unused development history.

### Model the change

Define the exact current-version resources needed by the flow:

- Recipe and input contract;
- Workflow Definition and graph scope;
- versioned capability and executor references;
- typed input/output schemas and artifacts;
- control/data edges, routing, completion, and bounded limits;
- durable waits/signals for human input;
- effects, outbox policy, idempotency, cancellation, and compensation;
- card presentation as a rebuildable projection, not runtime authority;
- policy claims and risk ceiling.

Use exact versioned refs. Never use aliases such as `latest`, `main`, `head`, wildcard versions, or mutable identity.

If the workflow ships as an optional Feature, place it under `features/<feature-id>/` with a validated `feature.json` and declare only the resources and permissions it actually needs. `container/skills/skills.json` controls core Agent skill synchronization; it does not publish workflow resources.

### Implement and validate

Keep source, schema, compiler expectations, runtime behavior, UI/API, and tests in the same change. Run the narrow tests first, then the relevant contract gates:

```bash
./scripts/runtime-toolchain.sh exec -- npm run typecheck
./scripts/runtime-toolchain.sh exec -- npm run schema:check
./scripts/runtime-toolchain.sh exec -- npm run golden:check
./scripts/runtime-toolchain.sh exec -- npm run golden:replay
./scripts/runtime-toolchain.sh exec -- npm run test:g2
```

When publication or activation changes, also run `npm run test:g3.7`, `npm run test:g3.9`, and the focused authoring tests. Run `npm run contracts:check` before handoff for cross-contract changes. Use `npm run golden:update` only when the requested semantic change intentionally changes the Golden corpus, and review that diff.

Restart the Host through `./local/shell/restart.sh --mode current` only when executable code or startup-loaded resources changed.

## Collaboration Project Space Workflows

Use this surface only for Git-backed multi-user project collaboration.

Follow the v3 lifecycle exposed by `src/collaboration/project-space-service.ts`:

1. Propose the next sequential version of a Workflow Definition.
2. Publish the exact proposed definition and layout.
3. Start instances from the immutable published snapshot.
4. Retire a definition with the expected group revision and a reason when it should no longer be selected for new instances.

Definition and layout are separate: moving nodes changes layout, not machine semantics. Running instances keep their selected definition snapshot. Retiring a definition must not rewrite existing instances.

Prefer the Project Space UI/API. Preserve Git event signing, permissions, expected-revision concurrency, and reducer validation. Never bypass the service by writing collaboration Git control files directly.

For Collaboration workflow changes, run:

```bash
./scripts/runtime-toolchain.sh exec -- npm run test:collaboration
```

## Completion Report

State which workflow surface was changed, the exact definition/draft/release and version, whether any publish/activate/retire action occurred, how running instances are protected, validation commands and results, and any unsupported lifecycle operation that remains.
