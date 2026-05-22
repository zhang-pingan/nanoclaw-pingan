---
name: self-evolution
description: Use only for Icarus assistant self-evolution tasks. Propose, implement, fix, and review small controlled improvements under program-managed state and branch boundaries.
---

# Self Evolution Skill

This skill is for controlled Icarus self-improvement only.

## Core Rules

1. Select exactly one optimization direction per item.
2. Write or refine a proposal before implementation.
3. Proposal work must actively use online search or web-accessible materials when available to gather current official docs, release notes, issues, discussions, or frontier practices that can improve the optimization direction.
4. Record relevant external findings in the proposal; if online research is unavailable or unnecessary for a purely local issue, state that limitation or reason explicitly.
5. Implementation must happen only on the program-created work branch.
6. Do not merge the base branch, do not push, and do not deploy.
7. Do not edit secrets, credentials, production config, or container isolation policy.
8. After implementation, checks and review are mandatory.
9. If the task is high risk or crosses policy boundaries, return `blocked_by_policy=true`.
10. Final response must be a strict JSON object matching the prompt schema.

## Required References

Read these before deciding or reviewing:

- `references/module-positioning.md`
- `references/risk-policy.md`
- `references/proposal-template.md`
- `references/review-checklist.md`

## Phase Behavior

- Proposal phases: inspect code and docs, research current external materials when available, and do not modify files.
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
