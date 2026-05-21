# NanoClaw to MixClaw Rename Change List

This document tracks a gradual rename from `nanoclaw` / `NanoClaw` /
`NANOCLAW` to `mixclaw` / `MixClaw` / `MIXCLAW`.

Do not use a blind global replacement. Some occurrences are stable runtime
contracts and must keep backward compatibility during the transition.

## Rename Rules

- Product display name: `NanoClaw` -> `MixClaw`
- Lowercase project name: `nanoclaw` -> `mixclaw`
- Uppercase env prefix: `NANOCLAW_` -> `MIXCLAW_`
- Reverse-DNS identifiers: `com.nanoclaw...` -> `com.mixclaw...`
- Internal protocol names should be migrated last and only with aliases.

## Phase 1: Low-Risk Display Text

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

- Replace natural-language product references from `NanoClaw` to `MixClaw`.
- Keep command examples unchanged if they refer to current service names,
  env vars, image names, MCP tools, or filesystem paths.
- Update screenshots or generated docs only after the UI is rebuilt.

Compatibility requirements:

- No runtime behavior should change in this phase.
- Tests should not require service, env, MCP, or container names to change.

## Phase 2: Environment Variables and Config Paths

Risk: Very high.

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

- Add `MIXCLAW_*` env variables.
- Keep reading `NANOCLAW_*` as fallback.
- Prefer `MIXCLAW_*` when both old and new variables are set.
- Add a clear deprecation warning when old-only variables are used.
- Support `~/.config/mixclaw` first and `~/.config/nanoclaw` as fallback.
- Add migration notes for:
  - `~/.config/nanoclaw/mount-allowlist.json`
  - `~/.config/nanoclaw/mail.json`

Compatibility requirements:

- Existing `.env` files must continue to boot without edits.
- Existing config directories must continue to work.
- Tests should cover new-only, old-only, and both-set cases.

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

- Introduce new service names:
  - macOS: `com.mixclaw`
  - Linux: `mixclaw.service`
- Add setup migration logic that detects and stops old services.
- Unload or disable old service units before starting the new one.
- Decide whether logs should be renamed to `logs/mixclaw.log` or kept as
  stable legacy paths.
- If logs are renamed, keep old log lookup fallback in debug and setup tools.
- Update shell helpers to stop both old and new direct processes.

Compatibility requirements:

- Running old `com.nanoclaw` and new `com.mixclaw` at the same time must be
  prevented.
- Restart and stop scripts must clean up old services and direct processes.
- Debug commands should work during the mixed-name period.

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

Current names:

- Image: `nanoclaw-agent:latest`
- Container prefix: `nanoclaw-*`

Actions:

- Introduce image name `mixclaw-agent:latest`.
- Continue accepting `nanoclaw-agent:latest` through `CONTAINER_IMAGE`.
- Make orphan cleanup recognize both `nanoclaw-*` and `mixclaw-*`.
- Update build scripts to produce the new image.
- Consider tagging both image names during the transition.

Compatibility requirements:

- Existing deployments with only `nanoclaw-agent:latest` must still run.
- Old orphaned containers must still be cleaned up.
- Tests should verify cleanup for both prefixes.

## Phase 5: Package, App Identity, and Repository Automation

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

- Rename npm package names only after deciding package publishing strategy.
- Update lockfiles using the package manager, not manual partial edits.
- Treat `electron-builder.json5` `appId` as a breaking identity change.
- Keep GitHub workflow repository conditions unchanged until the real repo is
  renamed.
- Update external repo URLs only after the upstream repository move is done.

Compatibility requirements:

- CI must continue to run on the current GitHub repository.
- Electron app permissions, user data paths, and update identity must be
  reviewed before changing `appId`.

## Phase 6: Electron and Web Runtime APIs

Risk: Medium to high.

Scope:

- `electron/preload.ts`
- `electron/main.ts`
- `electron/renderer/types/renderer.d.ts`
- `electron/renderer/app.js`
- `src/channels/web.ts`
- `assistant/*`

Current runtime API examples:

- `window.nanoclawApp`
- `--nanoclaw-open-workstation`
- User-facing connection text such as `Connected to NanoClaw`

Actions:

- Change visible UI strings to `MixClaw`.
- Add `window.mixclawApp` while keeping `window.nanoclawApp` as an alias.
- Add `--mixclaw-open-workstation` while keeping the old CLI argument.
- Update TypeScript declarations for both preload APIs.

Compatibility requirements:

- Existing renderer code must not break if it still calls `nanoclawApp`.
- Existing shortcuts or scripts using old CLI args must still work.

## Phase 7: MCP and Agent Protocol Names

Risk: Critical.

Scope:

- `src/index.ts`
- `src/workflow.ts`
- `src/workflow-llm-judge.ts`
- `src/delegation-policy.ts`
- `container/agent-runner/src/index.ts`
- `container/agent-runner/src/ipc-mcp-stdio.ts`
- Skills that reference MCP tools

Current protocol names:

- MCP server name: `nanoclaw`
- Tool prefix: `mcp__nanoclaw__*`
- Output markers:
  - `---NANOCLAW_OUTPUT_START---`
  - `---NANOCLAW_OUTPUT_END---`
- Internal URL segment: `__nanoclaw__`

Actions:

- Do not rename these in early phases.
- Add `mixclaw` protocol aliases only after display, config, service, and
  container names are stable.
- Keep old `mcp__nanoclaw__*` tools available for historical prompts,
  scheduled tasks, skills, and saved sessions.
- If output markers are renamed, parse both marker pairs.
- If `__nanoclaw__` is renamed, route both URL segments.

Compatibility requirements:

- Existing agents and skills must continue to call `mcp__nanoclaw__*`.
- Historical sessions and scheduled tasks must remain replayable.
- Container-host output parsing must accept both old and new markers before
  any writer changes.

## Phase 8: Skills and Setup Instructions

Risk: High.

Scope:

- `.claude/skills/*/SKILL.md`
- `container/skills/*/SKILL.md`

Actions:

- Split changes into two groups:
  - Natural-language product references: can become `MixClaw`.
  - Executable commands and protocol names: only update after the owning
    runtime migration is complete.
- Keep old commands documented during the compatibility period.
- Do not rename external skill repository names until those repositories exist.

Compatibility requirements:

- Skills must not instruct users to run commands that the code does not yet
  support.
- MCP examples must keep working with the current exposed tool names.

## Phase 9: Tests and Fixtures

Risk: Medium.

Scope:

- `src/**/*.test.ts`
- `setup/**/*.test.ts`
- `container/agent-runner` tests, if added

Actions:

- Update tests in the same phase as the runtime behavior they cover.
- Add compatibility tests for old and new names where aliases exist.
- Keep fixture changes scoped; avoid rewriting unrelated snapshots.

Compatibility requirements:

- Tests should prove both new-name behavior and old-name fallback behavior.
- Test temp paths may move from `/tmp/nanoclaw-*` to `/tmp/mixclaw-*` after
  the implementation supports it.

## Phase 10: Ignored Runtime Artifacts

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
- If persisted runtime data needs a new name, write a migration script or
  compatibility reader.
- Keep old historical conversation content unchanged.

Compatibility requirements:

- Existing local data should remain readable.
- Rebuild output should be generated from source instead of hand-edited.

## Suggested Order

1. Display-only docs and UI copy.
2. Add `MIXCLAW_*` and `~/.config/mixclaw` compatibility layer.
3. Add service migration support while still cleaning up old `nanoclaw`
   services and processes.
4. Add container image and prefix compatibility.
5. Add Electron preload and CLI aliases.
6. Update package and app identity after release strategy is clear.
7. Add MCP/protocol aliases.
8. Update skills and command docs after each owning runtime change lands.
9. Rebuild generated output.
10. Leave historical logs, sessions, and databases untouched unless a specific
    migration is required.

## Pre-Change Checklist

- Confirm whether the GitHub repository will be renamed.
- Decide whether Electron `appId` should change or remain stable.
- Decide whether logs should be renamed or kept as legacy paths.
- Decide whether both container image tags should be built during transition.
- Decide how long `NANOCLAW_*` env fallbacks will be supported.
- Decide whether `mcp__nanoclaw__*` will remain permanent aliases.

## Verification Checklist

- `npm test`
- `npm run build`
- Setup flow starts from old `.env` using only `NANOCLAW_*`.
- Setup flow starts from new `.env` using only `MIXCLAW_*`.
- macOS service migration stops old `com.nanoclaw` before starting
  `com.mixclaw`.
- Linux service migration stops old `nanoclaw.service` before starting
  `mixclaw.service`.
- Container cleanup handles both `nanoclaw-*` and `mixclaw-*`.
- Electron renderer works through both `nanoclawApp` and `mixclawApp`.
- Existing MCP tools under `mcp__nanoclaw__*` still work.
- New docs do not advertise commands that are not yet implemented.
