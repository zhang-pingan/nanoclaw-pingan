---
name: debug
description: Diagnose and repair the current Icarus checkout, including Host Core startup, Docker agent execution, credential proxying, channels, per-Agent sessions, IPC, mounts, Feature resources, Task Workspace, and Dynamic Workflow Runtime. Use when Icarus fails to start, a channel or desktop client is unhealthy, an Agent query fails or hangs, a container exits, a session loses continuity, or a workflow is blocked.
---

# Debug Icarus

Diagnose the current checkout from evidence. Do not fetch, merge, reset, or configure Git remotes as part of debugging.

## Safety

- Start with read-only checks and preserve the failing logs, Trace, query ID, run ID, container name, and timestamps.
- Never print values from `.env`, credentials, tokens, private keys, or request authorization headers. Report only whether required keys are configured.
- Do not delete `store/`, `data/`, Agent sessions, Workflow Runtime state, Docker caches, or logs during diagnosis.
- Use `local/shell/workflow-state.sh` for Workflow Runtime backup, reset, or restore. Never remove its DB/WAL/SHM files manually.
- Ask before installing software, restarting a live service, resetting a session, rebuilding an image used by active work, or changing persisted state.

## Current Execution Model

Use these facts when interpreting failures:

- `local/shell/launch-host.sh --mode current` starts the checkout through the configured Node 26 toolchain.
- The Host owns channels, HTTP APIs, SQLite state, scheduling, Workflow Runtime, the Agent queue, IPC, and credential proxies.
- `src/container-runtime.ts` selects Docker. Containers run `container/agent-runner` as user `node`.
- Real model credentials remain on the Host. Containers receive placeholder authentication and call the Host credential proxy; project `.env` is shadowed in container mounts.
- Per-Agent Claude state lives at `data/sessions/<agent-folder>/.claude/` and mounts at `/home/node/.claude`.
- Per-Agent IPC lives at `data/ipc/<agent-folder>/` and mounts at `/workspace/ipc`.
- Core and enabled Feature skills are synchronized into the Agent session before container startup.

Read `docs/startup-flow.md`, `docs/SECURITY.md`, and `docs/host-core-lifecycle.md` only when the corresponding layer is involved.

## Diagnostic Workflow

### 1. Bound the failure

Record:

- affected surface: Host, Web, Assistant, Feishu, WeCom, container Agent, Task Workspace, Collaboration, or Dynamic Workflow Runtime;
- first failing time and whether the failure is reproducible;
- affected Agent JID/folder, query ID, run ID, workflow ID, and container name when available;
- whether the failure started after a source, `.env`, Feature, Agent registration, Docker, or persisted-schema change.

Check `git status --short` before changing files. Preserve unrelated worktree changes.

### 2. Run the common preflight

Run from the repository root:

```bash
./scripts/runtime-toolchain.sh verify
docker info
docker image inspect icarus-agent:latest
./local/shell/workflow-state.sh inspect --mode current
./scripts/runtime-toolchain.sh exec -- npx tsx setup/index.ts --step verify
```

The final two commands may exit non-zero to report an unhealthy or incompatible state. Read their structured output instead of treating the exit code alone as the diagnosis.

### 3. Inspect the relevant evidence

Use the narrowest relevant source:

| Layer | Evidence |
| --- | --- |
| Host/service | `logs/icarus.log`, `logs/icarus.error.log` |
| Setup/toolchain | `logs/setup.log`, `scripts/runtime-toolchain.sh verify` |
| macOS launchd | `launchctl print gui/$(id -u)/com.icarus` |
| Linux systemd | `systemctl --user status icarus.service` or system-level status when running as root |
| Agent query | Web Trace view; `agent_queries`, `agent_query_steps`, and `agent_query_events` in `store/messages.db` |
| Container run | newest `agents/<folder>/logs/container-*.log` |
| Docker | `docker ps -a --filter name=icarus-`, `docker inspect <exact-name>` |
| IPC | `data/ipc/<folder>/messages/`, `tasks/`, `input/`, and `errors/` |
| Electron workbench | `local/shell/electron/.runtime/electron.log` |
| Desktop assistant | `local/shell/assistant/.runtime/assistant.log` |
| Workflow state | Runtime Center/Task Workspace plus `data/workflow-runtime/workflow-runtime.db` through supported code or tests |

Prefer the structured failure fields `failure_type`, `failure_subtype`, `failure_origin`, and `failure_retryable` over guessing from the final message.

### 4. Follow the failing layer

#### Host does not start

1. Verify the Node toolchain and native `better-sqlite3` smoke.
2. Inspect Workflow state compatibility. If it reports `RESET_REQUIRED`, stop Icarus and use the guarded reset command only after showing the exact paths and backup location.
3. Check the Host logs for port conflicts, invalid Feature manifests, invalid configuration, database errors, or Docker startup failure.
4. Run `npm run typecheck` and the focused failing tests through the configured toolchain.

#### Authentication or model requests fail

1. Confirm that `.env` contains one supported Host credential key without displaying its value: `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`.
2. If OpenAI compatibility is enabled, also confirm its required base URL, model, API key, protocol, and timeout settings.
3. Check Host proxy logs and query Trace events. Do not test by mounting `.env` or passing the real credential into a container.
4. Distinguish provider HTTP errors, invalid model output, proxy reachability, and container authentication bootstrap failures.

#### Container Agent fails or hangs

1. Inspect the exact container log and Trace before restarting anything.
2. Check Docker health, image existence, exit code, timeout, and whether streaming output was produced.
3. Treat exit 137 as an external stop, runtime cleanup, or memory-pressure signal; confirm with Docker inspection rather than assuming OOM.
4. For mount errors, inspect `~/.config/icarus/mount-allowlist.json` and Host rejection logs. Additional mounts must remain under an allowed root and outside blocked credential paths.
5. For MCP or Feature resource errors, inspect the synchronized session directories under `data/sessions/<folder>/` and the enabled Feature configuration.

#### Session continuity fails

1. Correlate consecutive queries for the same Agent folder in Trace and logs.
2. Verify `data/sessions/<folder>/.claude/` exists and is mounted at `/home/node/.claude`.
3. Check for explicit isolated-session or one-shot execution before calling the behavior a bug.
4. Use the product session reset path only when the user requests a reset. Do not delete session directories or edit the session table manually.

#### IPC or outbound delivery fails

1. Inspect the affected Agent namespace, not a global `data/ipc/messages` directory.
2. Validate the JSON shape, source Agent identity, target JID ownership, and allowed container file prefix.
3. Check `data/ipc/errors/` and Host authorization logs.
4. Preserve failed IPC files until the cause is understood.

#### Workflow execution is blocked

1. Determine whether the request belongs to Task Workspace Personal Workflows, Dynamic Workflow Runtime, or Collaboration Project Space; they have different stores and lifecycles.
2. Inspect Runtime Center events, pending waits/interactions, execution adapter status, and operational blockers.
3. Run `npm run schema:check` and the focused Workflow Runtime test for the failing domain.
4. Use `local/shell/workflow-state.sh backup|reset|restore` only for explicit state maintenance. Do not edit Runtime rows directly.

### 5. Repair and verify

Make the smallest fix at the layer that owns the failure. Then:

```bash
./scripts/runtime-toolchain.sh exec -- npm run typecheck
./scripts/runtime-toolchain.sh exec -- npm run build
```

Run focused tests before broad suites. If Host or container code changed, rebuild and restart through the maintained platform path.

On macOS:

```bash
./local/shell/restart.sh --mode current
```

On Linux, rebuild the image and restart the installed service:

```bash
./container/build.sh
systemctl --user restart icarus.service
```

Use system-level `systemctl` instead when Icarus was installed as root, or the generated `start-icarus.sh` on a no-systemd setup.

Reproduce the original request and confirm the Host health check, query Trace, container exit, and user-visible result. Report the root cause, evidence, files changed, commands run, and any remaining risk.
