# Risk Policy

## Low Risk

Low-risk work may be proposed and implemented automatically when settings allow it.

- Documentation additions
- Focused tests
- Logs and error-message improvements
- Small UI fixes
- Non-core bug fixes
- Read-only analysis and status display

## Medium Risk

Medium-risk work may be implemented automatically only when checks and review pass.

- Small assistant state-machine changes
- Web console interaction changes
- New DB tables without destructive migration
- New low-permission APIs

## High Risk

High-risk work must be blocked or wait for explicit human approval.

- Data deletion
- Permission model changes
- Container isolation changes
- Opening network ports
- Core dependency upgrades
- Startup changes
- Production config changes
- External account access
- Secrets, credentials, or tokens
- Automatic base-branch merge without full checks

Return `blocked_by_policy=true` and a concrete `blocked_reason` for high-risk work.
