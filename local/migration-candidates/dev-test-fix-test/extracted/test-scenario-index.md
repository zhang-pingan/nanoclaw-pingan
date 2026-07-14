# Legacy behavior scenario index

This index preserves product-relevant scenarios formerly covered by legacy
tests. It is not an executable test suite.

## Creation and inputs

- Create `dev_test` from plan, development, and pre-test entrypoints.
- Require `plan.md` for the development entrypoint.
- Require `dev.md` and optionally accept `plan.md` for pre-test entry.
- Materialize uploaded requirement and test-case files.
- Create `fix_test` without requiring an existing work branch.
- Carry a work branch returned by bug fix into deployment.
- Reject unsafe deliverable paths and cross-deliverable evidence.

## Handoff, artifact, and evaluation

- Render requirement, attachment, service, and branch context into tasks.
- Require structured verdict, summary, findings, and evidence.
- Require traceability for primary plan and development results.
- Validate plan/dev/test payloads against Artifact Contracts.
- Force test failure when the structured failed count is non-zero.
- Keep a stage pending when required evaluation evidence is missing.
- Route review and test `needs_revision` outcomes without confusing transport
  success with business success.

## Wait and action behavior

- Re-entering an interrupt creates a fresh pending instance.
- Duplicate same-action/same-payload resume is idempotent.
- Same action with different payload conflicts.
- Resume payloads are normalized and schema-validated.
- Transition and delegation creation fail atomically.
- Pending interrupt expiration is durable.

## Development flow

- Plan success enters plan review.
- Plan review can approve continuation or request plan revision.
- Development success enters code review.
- Development review can approve deployment or request correction.
- Deployment failure terminates at `ops_failed`.
- Configured test token bypasses token confirmation; missing token requires
  explicit submit or skip.
- Testing failure increments the round and enters fixing.
- Fixing success returns to deployment.

## Bug-fix flow

- Bug fix success enters deployment.
- Bug test success terminates at `passed`.
- Bug test failure increments the round and enters refix.
- Refix success returns to deployment.
- Missing final branch metadata keeps the relevant legacy stage pending.

## Explicit non-migration cases

- Old system-step execution and inline transition delegation.
- Passive self-loop delegation behavior.
- Arbitrary stage return/reopen.
- Workflow-state-based pause.
- Raw access-token persistence in Workflow context.

If migration is approved later, scenarios must be reviewed rather than copied
blindly; only still-valid product behavior becomes new fixtures.
