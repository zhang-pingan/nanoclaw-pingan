# Legacy source special cases

These behaviors were implemented outside the archived resource JSON. They are
recorded for possible future product analysis, not as requirements for the new
Runtime.

## service.test_token

The archived source is `../raw/legacy-code/service-test-token.ts.txt`.

- Reads `groups/global/services.json`.
- Looks for `service.testToken`, then `service.staging.testToken`.
- Writes the raw token into legacy Workflow context under `access_token`.
- Writes `test_token_configured` for routing.
- Treats missing service, missing token, file errors, and parse errors as a
  successful action with `found=false`.
- Keeps the token out of the action output, but not out of Workflow context.

Any future design must use Credential Ref semantics and must not copy the raw
token behavior.

## Handoff traceability rule

`src/workflow-handoff.ts` contained an explicit conditional for
`dev_test.plan.v1` and `dev_test.dev.v1`. For the primary plan/development
skills, a result was invalid unless it contained `traceability_path` or a
`traceability` object.

This must become a versioned schema/artifact contract if the feature is ever
rebuilt; it must not return as a code special case.

## Database default

The legacy database schema and row mapper defaulted `workflow_type` to
`dev_test`. This was an implementation shortcut, not domain behavior, and must
not be migrated.

## Runtime-only semantics

- Definition transitions could embed a delegation in addition to targeting a
  state.
- Several failure routes self-looped and relied on mutable stage state.
- `paused` was represented as a Workflow state.
- Card actions directly invoked legacy pause/cancel/resume behavior.
- Retry and return APIs could reopen or move legacy stages.

These mechanisms conflict with the Dynamic Workflow Graph Runtime contracts.
Future migration must express any still-valid business behavior using new
Activation, Graph, Wait, Effect, Rework, and Runtime Command contracts.
