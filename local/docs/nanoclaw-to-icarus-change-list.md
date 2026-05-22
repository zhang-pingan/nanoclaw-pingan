# NanoClaw to Icarus Breaking Rename Change List

This document tracks a development-stage breaking rename from `nanoclaw` /
`NanoClaw` / `NANOCLAW` to `icarus` / `Icarus` / `ICARUS`.

This is not a gradual compatibility migration. The project is currently used
only by the developer, so the preferred strategy is:

1. Do a one-time cleanup and migration of local external state before changing
   runtime code.
2. Rename the codebase directly to the new Icarus names.
3. Do not keep old-name fallback, aliases, or cleanup branches in production
   runtime code.

Do not use a blind global replacement. Some occurrences are historical data,
generated output, local artifacts, or external repository names that should be
handled intentionally.

## Rename Rules

- Product display name: `NanoClaw` -> `Icarus`
- Lowercase project name: `nanoclaw` -> `icarus`
- Uppercase env prefix: `NANOCLAW_` -> `ICARUS_`
- Reverse-DNS identifiers: `com.nanoclaw...` -> `com.icarus...`
- MCP and protocol names should be renamed in the same breaking change, not
  kept as aliases.

## Runtime Compatibility Policy

- Do not read `NANOCLAW_*` env variables after the rename.
- Do not fall back to `~/.config/nanoclaw`.
- Do not expose `window.nanoclawApp`.
- Do not accept old `--nanoclaw-*` CLI arguments.
- Do not build, tag, or run `nanoclaw-agent:latest`.
- Do not keep `mcp__nanoclaw__*` tool aliases.
- Do not parse old `NANOCLAW` protocol markers unless a specific still-needed
  historical workflow is identified before implementation.
- Do not add runtime code that detects or cleans old local state.

Old local state must be handled once before the code change lands.

## Phase 0: One-Time Local Environment Cleanup

Risk: High, but limited to the developer machine.

Timing: Complete this phase before runtime code is renamed.

Scope:

- macOS launchd service: `com.nanoclaw`
- Linux systemd service: `nanoclaw.service`
- Old direct process scripts and pid files
- Old containers and images:
  - `nanoclaw-*`
  - `nanoclaw-agent:latest`
- External config paths outside the project root:
  - `~/.config/nanoclaw`
- Local ignored project files:
  - `.env`
  - `logs/nanoclaw*.log`
  - `nanoclaw.pid`

Actions:

- Stop and unload the old macOS service if present:
  - `com.nanoclaw`
- Stop and disable the old Linux service if present:
  - `nanoclaw.service`
- Delete old service unit or plist files that can auto-start NanoClaw again.
- Stop old direct processes and remove stale pid files.
- Stop and remove old `nanoclaw-*` containers.
- Remove the old `nanoclaw-agent:latest` image after confirming it is no longer
  needed.
- Copy external config from `~/.config/nanoclaw` to `~/.config/icarus`.
- Verify copied config files, especially:
  - `mount-allowlist.json`
  - `mail.json`
- Delete `~/.config/nanoclaw` only after the copied files are verified.
- Update local `.env` manually so it contains only `ICARUS_*` variables.
- Rename or delete old local log and pid files if they are not needed for
  debugging.
- Confirm there are no remaining old processes, old services, old containers,
  or old config paths before changing runtime code.

Required result:

- The local machine has no active `nanoclaw` service, process, container, or
  config source.
- The runtime code does not need to know how to clean or migrate old names.

## Phase 1: Display Text, Docs, and Visible Names

Risk: Low.

Scope:

- `README.md`
- `CLAUDE.md`
- `TECHNOLOGY.md`
- `docs/*.md`
- `groups/*/CLAUDE.md`
- Electron menu labels, window titles, notification titles
- Web and assistant visible strings

Actions:

- Replace natural-language product references from `NanoClaw` to `Icarus`.
- Update command examples to the new service names, env vars, image names, MCP
  tools, and filesystem paths.
- Update screenshots or generated docs only after the UI is rebuilt.

Required result:

- User-visible product language consistently says `Icarus`.
- Docs no longer describe old NanoClaw runtime names as supported commands.

## Phase 2: Environment Variables and Config Paths

Risk: High.

Scope:

- `.env.example`
- `src/config.ts`
- `src/types.ts`
- `src/mail.ts`
- `src/model-selector.ts`
- `src/agent-api.ts`
- `src/wiki.ts`
- `setup/mounts.ts`
- Any references to `~/.config/nanoclaw`
- Any references to `NANOCLAW_*`

Actions:

- Rename env variables from `NANOCLAW_*` to `ICARUS_*`.
- Remove old-name env fallback logic.
- Use `ICARUS_*` as the only accepted runtime env prefix.
- Use `~/.config/icarus` as the only config directory.
- Remove code and tests that expect `~/.config/nanoclaw` fallback behavior.
- Update local setup documentation to say external config must be copied before
  the breaking rename is applied.

Required result:

- Old `.env` files using `NANOCLAW_*` fail clearly or are already updated before
  launch.
- Runtime code only reads Icarus env variables and Icarus config paths.

## Phase 3: Service, Process, PID, and Logs

Risk: High.

Scope:

- `launchd/com.nanoclaw.plist`
- `setup/service.ts`
- `setup/launchd.ts`
- `setup/status.ts`
- `setup/verify.ts`
- `local/shell/*.sh`
- Service names:
  - `com.nanoclaw`
  - `nanoclaw.service`
- Runtime files:
  - `start-nanoclaw.sh`
  - `nanoclaw.pid`
  - `logs/nanoclaw.log`
  - `logs/nanoclaw.error.log`

Actions:

- Rename macOS service identity to `com.icarus`.
- Rename Linux service identity to `icarus.service`.
- Rename startup scripts, pid files, and log files to Icarus names.
- Remove setup code that stops, unloads, disables, or cleans old NanoClaw
  services.
- Update status and verify commands to inspect only Icarus services and files.
- Keep old logs only as historical ignored artifacts if needed; do not read
  them from runtime code.

Required result:

- Setup, status, restart, and verify flows only know about Icarus services.
- Old service cleanup remains a Phase 0 manual or one-time-script task, not a
  runtime behavior.

## Phase 4: Container Image and Container Names

Risk: High.

Scope:

- `setup/container.ts`
- `container/Dockerfile`
- `container/build.sh`
- `src/container-runtime.ts`
- `src/container-runner.ts`
- `local/shell/restart-no-cache.sh`
- Tests for container image and name handling

Old names:

- Image: `nanoclaw-agent:latest`
- Container prefix: `nanoclaw-*`

Actions:

- Rename image to `icarus-agent:latest`.
- Rename container prefix to `icarus-*`.
- Remove support for `nanoclaw-agent:latest` in runtime config.
- Remove orphan cleanup for `nanoclaw-*` from runtime code.
- Update build scripts to produce only the new image tag.
- Update tests to assert only the new image and prefix behavior.

Required result:

- The container stack only builds, starts, and cleans Icarus containers.
- Old NanoClaw containers are removed before this phase through Phase 0 cleanup.

## Phase 5: Electron and Web Runtime APIs

Risk: Medium to high.

Scope:

- `electron/preload.ts`
- `electron/main.ts`
- `electron/renderer/types/renderer.d.ts`
- `electron/renderer/app.js`
- `src/channels/web.ts`
- `assistant/*`

Old runtime API examples:

- `window.nanoclawApp`
- `--nanoclaw-open-workstation`
- User-facing connection text such as `Connected to NanoClaw`

Actions:

- Rename preload API to `window.icarusApp`.
- Remove `window.nanoclawApp`.
- Rename CLI arguments to `--icarus-*`.
- Remove old `--nanoclaw-*` argument handling.
- Update TypeScript declarations to expose only Icarus APIs.
- Update renderer and assistant code to call only Icarus APIs.

Required result:

- Electron and web runtime APIs no longer expose old NanoClaw names.
- Local shortcuts or scripts must be updated before launch.

## Phase 6: MCP and Agent Protocol Names

Risk: Critical.

Scope:

- `src/index.ts`
- `src/workflow.ts`
- `src/workflow-llm-judge.ts`
- `src/delegation-policy.ts`
- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- Skills that reference MCP tools

Old protocol names:

- MCP server name: `nanoclaw`
- Tool prefix: `mcp__nanoclaw__*`
- Output markers:
  - `---NANOCLAW_OUTPUT_START---`
  - `---NANOCLAW_OUTPUT_END---`
- Internal URL segment: `__nanoclaw__`

Actions:

- Rename MCP server name to `icarus`.
- Rename tool prefix to `mcp__icarus__*`.
- Rename output markers to Icarus names.
- Rename internal URL segment to `__icarus__`.
- Remove old MCP tool aliases and protocol marker parsing.
- Update skills, prompts, scheduled tasks, and examples in the same change so
  they refer only to Icarus names.

Required result:

- New agent sessions use only Icarus protocol names.
- Historical NanoClaw sessions are not guaranteed to replay after this breaking
  rename.

## Phase 7: Package, App Identity, and Repository Automation

Risk: Medium to high.

Scope:

- `package.json`
- `package-lock.json`
- `container/agent-runner/package.json`
- `container/agent-runner/package-lock.json`
- `electron-builder.json5`
- `.github/workflows/*.yml`
- `repo-tokens/*`

Actions:

- Rename npm package names if package publishing is not currently constrained.
- Update lockfiles using the package manager, not manual partial edits.
- Decide and apply Electron `appId` rename as a breaking identity change if
  desired.
- Keep GitHub workflow repository conditions unchanged until the real repo is
  renamed.
- Update external repo URLs only after the upstream repository move is done.

Required result:

- Local package metadata matches Icarus.
- Repository automation is not broken by assuming a repo rename that has not
  happened yet.

## Phase 8: Skills and Setup Instructions

Risk: High.

Scope:

- `.claude/skills/*/SKILL.md`
- `container/skills/*/SKILL.md`
- Setup and local operation docs

Actions:

- Replace natural-language product references with `Icarus`.
- Update executable commands to use Icarus service, env, config, container, and
  MCP names.
- Remove NanoClaw command examples unless they are clearly labeled as pre-change
  cleanup commands in Phase 0.
- Do not rename external skill repository names until those repositories exist.

Required result:

- Skills and setup docs do not tell users to call removed NanoClaw commands or
  MCP tools.

## Phase 9: Tests and Fixtures

Risk: Medium.

Scope:

- `src/**/*.test.ts`
- `setup/**/*.test.ts`
- `container/agent-runner` tests, if added

Actions:

- Update tests in the same phase as the runtime behavior they cover.
- Remove old-name compatibility tests.
- Add tests for Icarus-only env variables, config paths, services, containers,
  Electron APIs, and MCP names.
- Keep fixture changes scoped; avoid rewriting unrelated snapshots.

Required result:

- Tests prove the new Icarus behavior.
- Tests do not preserve old NanoClaw fallback behavior.

## Phase 10: Generated and Ignored Runtime Artifacts

Risk: Do not bulk edit.

Scope:

- `dist/`
- `dist-electron/`
- `dist-assistant/`
- `logs/`
- `data/`
- `groups/`
- `store/`
- `.env`
- `.idea/`

Actions:

- Rebuild generated `dist*` output after source changes.
- Do not search-and-replace logs, SQLite DBs, archived sessions, or local IDE
  state.
- Do not add compatibility readers for old persisted runtime data unless a
  specific still-needed dataset is identified before the rename.
- Keep old historical conversation content unchanged unless it is an executable
  skill, prompt, or setup command that must work after the rename.

Required result:

- Generated output comes from source rebuilds.
- Historical artifacts are either left alone or manually migrated before code
  changes; runtime code does not support both eras.

## Suggested Order

1. Complete Phase 0 local cleanup and external config migration.
2. Update local `.env` to `ICARUS_*` only.
3. Rename docs, visible UI text, and setup instructions.
4. Rename env variables and config paths in runtime code.
5. Rename service, pid, script, and log identities.
6. Rename container image and container prefixes.
7. Rename Electron and web runtime APIs.
8. Rename MCP and agent protocol names.
9. Rename package metadata and app identity where appropriate.
10. Update tests and fixtures.
11. Rebuild generated output.
12. Run full verification.

## Pre-Change Checklist

- Confirm the project is still developer-only and can accept a breaking rename.
- Confirm no historical NanoClaw sessions need to replay after the rename.
- Confirm whether the GitHub repository will be renamed now or later.
- Decide whether Electron `appId` should change or remain stable.
- Decide whether old logs should be archived or deleted.
- Stop and remove old NanoClaw services, processes, containers, and pid files.
- Copy `~/.config/nanoclaw` to `~/.config/icarus`.
- Verify migrated config files, then delete `~/.config/nanoclaw`.
- Update local `.env` so it contains only `ICARUS_*`.
- Confirm no old `nanoclaw` process, service, container, env source, or config
  path remains active.

## Verification Checklist

- `npm test`
- `npm run build`
- Setup flow starts from `.env` using only `ICARUS_*`.
- Runtime reads config only from `~/.config/icarus`.
- macOS service installs and starts as `com.icarus`.
- Linux service installs and starts as `icarus.service`.
- Status, restart, and verify commands reference only Icarus names.
- Container build produces `icarus-agent:latest`.
- Container runtime uses only `icarus-*` container names.
- Electron renderer works through `window.icarusApp`.
- New CLI shortcuts use only `--icarus-*` arguments.
- MCP tools are exposed under `mcp__icarus__*`.
- Agent protocol output uses Icarus markers.
- New docs do not advertise removed NanoClaw runtime commands.
