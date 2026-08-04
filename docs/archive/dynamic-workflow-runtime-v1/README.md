# Dynamic Workflow Runtime v1 Construction Archive

This directory is the read-only archive of the completed Runtime v1 construction lifecycle. G0-G9 are accepted and the temporary lifecycle is `CONSTRUCTION_ARCHIVED`.

Accepted boundary:

- candidate commit: `56a78b6dcede075c60d7e5b2049158824050410c`
- release: `sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279`
- independent whole-G9 acceptance: `019fc76d-4aaf-71b1-9839-1d5a6fa21132`

## Archived Documents

| Former path | Archived path |
| --- | --- |
| `local/docs/dynamic-workflow-dag-framework.md` | `docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md` |
| `local/docs/dynamic-workflow-dag-framework-introduction.md` | `docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework-introduction.md` |
| `local/docs/dynamic-workflow-runtime-implementation-progress.md` | `docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-runtime-implementation-progress.md` |
| `local/docs/dynamic-workflow-runtime-extended-certification-plan.md` | `docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-runtime-extended-certification-plan.md` |
| `local/docs/pre-dynamic-workflow-runtime-cleanup-handoff.md` | `docs/archive/dynamic-workflow-runtime-v1/pre-dynamic-workflow-runtime-cleanup-handoff.md` |
| `local/docs/pre-dynamic-workflow-runtime-cleanup-continuation-handoff.md` | `docs/archive/dynamic-workflow-runtime-v1/pre-dynamic-workflow-runtime-cleanup-continuation-handoff.md` |

The archived documents intentionally retain former paths, candidate states, findings, and Gate language where those strings were part of historical evidence. Frozen generated JSON and the accepted `dist/` release may retain the same literals. Those literals are not live links or default inputs and must not be rewritten to relabel history.

The accepted physical release inventory is retained separately as current release identity authority at [`src/workflow-runtime/contracts/certification/accepted-release-v1/`](../../../src/workflow-runtime/contracts/certification/accepted-release-v1/). It is not a rebuilt or successor release. The current release checker validates the archive container and all 9,094 manifest members without consulting an installed Runtime pointer.

Current development starts at [`docs/dynamic-workflow-runtime.md`](../../dynamic-workflow-runtime.md) and the machine Contract README. The archive is excluded from default CI, build, release reconstruction, Runtime, Compiler, Store, Registry, and Launcher reads.

Optional verification is read-only and non-default:

```sh
./scripts/runtime-toolchain.sh exec -- npm run archive:verify:v1
```
