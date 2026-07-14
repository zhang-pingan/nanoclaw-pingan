# dev_test / fix_test migration candidate

This directory is an inert archive of the former `dev_test` and `fix_test`
workflow resources. It is intentionally outside every container, feature,
registry, compiler, fixture-discovery, and application build path.

- Status: `deferred`
- Migration approved: `no`
- Required by Dynamic Workflow Graph Runtime v1: `no`
- Executable by Icarus: `no`

See `MIGRATION-CANDIDATE.md` for the behavior inventory and future decision
gate. `SHA256SUMS` records the exact archived source bytes.

Production code, tests, manifests, and build scripts must not import, copy, or
load anything below this directory.
