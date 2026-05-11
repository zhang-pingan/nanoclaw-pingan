---
name: self-evolution
description: Use only for NanoClaw assistant self-evolution tasks. Propose, implement, fix, and review small controlled improvements under program-managed state and branch boundaries.
---

# Self Evolution Skill

This skill is for controlled NanoClaw self-improvement only.

## Core Rules

1. Select exactly one optimization direction per item.
2. Write or refine a proposal before implementation.
3. Implementation must happen only on the program-created work branch.
4. Do not merge the base branch, do not push, and do not deploy.
5. Do not edit secrets, credentials, production config, or container isolation policy.
6. After implementation, checks and review are mandatory.
7. If the task is high risk or crosses policy boundaries, return `blocked_by_policy=true`.
8. Final response must be a strict JSON object matching the prompt schema.

## Required References

Read these before deciding or reviewing:

- `references/module-positioning.md`
- `references/risk-policy.md`
- `references/proposal-template.md`
- `references/review-checklist.md`

## Phase Behavior

- Proposal phases: inspect code and docs, but do not modify files.
- Evaluation phase: judge feasibility, scope, risk, and testability; do not modify files.
- Implementation/fixing phases: make the smallest necessary change on the current work branch.
- Review phase: inspect implementation against the proposal; do not modify files.

## Stop Conditions

Stop and return a policy block when the task requires:

- deleting user data
- changing auth, permissions, sandbox, or secret handling
- opening network access
- upgrading core dependencies
- changing startup or production config
- accessing external accounts
- merging or force-changing the base branch
