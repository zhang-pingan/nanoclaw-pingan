# Review Checklist

For review phases, verify:

- Proposal coverage: implementation matches the approved proposal.
- Behavior: no obvious logic bug or broken state transition.
- Boundaries: no base branch merge, push, deployment, secret access, or high-risk path.
- Tests: changed behavior has checks appropriate to its risk.
- Regression: startup, build, assistant UI, web API, and container task behavior remain coherent.
- Diff scope: changed files are expected and minimal.

Return `review_complete=false` with concrete `required_fixes` when any item blocks adoption.
