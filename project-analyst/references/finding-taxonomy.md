# Finding Taxonomy

Categories are fixed to: `delivery_risk`, `schedule_risk`, `dependency_risk`, `workflow_stall`, `assignment_gap`, `quality_gap`, `missing_evidence`, `collaboration_gap`, `information_conflict`, `capacity_risk`, `identity_risk`, `protocol_risk`, and `question`.

Severity:

- `critical`: verified integrity, identity, circular dependency, or delivery failure requiring immediate attention.
- `high`: an overdue, blocked, timed-out, or concentrated risk likely to affect delivery.
- `medium`: a material gap that should be planned or confirmed.
- `low`: a localized cleanup or weak signal.
- `info`: context without an immediate risk.

Confidence is a number from 0 through 1. Confidence measures support for the conclusion, not impact.
