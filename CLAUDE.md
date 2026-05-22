# Icarus Project Context

Icarus is a personal Agent work system. It combines a user-driven Web workbench, a proactive desktop personal assistant, a mobile channel currently implemented through Feishu, a WeCom employee private channel, a trusted host service, and isolated container agents.

The most important product boundary:

- **Web workbench client**: user-initiated. The user opens the workbench, creates tasks, reviews progress, adds context, approves actions, and inspects traces. Agent is a passive tool in this surface.
- **Personal assistant client**: agent-initiated. The assistant proactively notices missing plans, stuck tasks, failed agent runs, scheduler failures, and online errors. It reminds the user and may investigate or prepare fixes under policy.
- **Mobile channel**: currently Feishu. This is a lightweight fallback for when the user is away from the computer: task lookup, approval handling, reminder delivery, simple task creation, and short follow-up instructions. It is not a full mobile workbench.
- **WeCom employee private channel**: one-to-one private customer-service surface between Icarus and WeCom employees. It gathers information from employees through private chat when Icarus needs details to resolve runtime problems, and it can also act as Icarus's private support agent to answer or handle employee requests and issues.
- **Host service**: trusted orchestration layer. It owns routing, workflow state, SQLite, scheduling, IPC authorization, credential proxying, workbench APIs, proactive scans, and container lifecycle.
- **Container agent**: isolated high-capability executor. It performs real agent work inside Docker or Apple Container, with explicit mounts and no real API secrets.

## Current Architecture

```text
Web Workbench / Electron     Personal Assistant / tray     Mobile / Feishu     WeCom employee private chat
          |                              |                    |                         |
          | HTTP, WebSocket              | HTTP, IPC           | Webhook, API             | Webhook, API
          v                              v                    v                         v
        Host Node.js process: src/index.ts
        - channel registry and message loop
        - workflow engine and workbench store
        - proactive assistant and evolution engine
        - scheduler, queue, IPC watcher
        - SQLite, trace manager, credential proxy
              |
              | spawn/reuse container, file IPC
              v
        container/agent-runner
        - Claude Agent SDK
        - Bash/file tools/browser/search
        - /workspace/group, /workspace/project(ro), /workspace/ipc
```

## Key Files

| File | Purpose |
| --- | --- |
| `README.md` | Human-facing project introduction and architecture |
| `src/index.ts` | Host orchestrator: startup, channels, message loop, agent invocation |
| `src/channels/registry.ts` | Channel factory registry and self-registration mechanism |
| `src/channels/index.ts` | Barrel imports that activate installed channels |
| `src/channels/web.ts` | Local web workbench HTTP/WebSocket channel and API routes |
| `src/channels/assistant.ts` | Personal assistant channel bridge into host routing |
| `src/channels/feishu.ts` | Current mobile channel: Feishu bot, webhook, message sending, and interactive cards |
| `src/channels/wecom.ts` | WeCom employee private channel: one-to-one employee DMs, webhook handling, message sending, and attachment exchange |
| `src/workbench.ts` | Workbench API/view model for tasks, actions, artifacts, comments |
| `src/workflow.ts` | Configuration-driven workflow engine |
| `src/workflow-config.ts` | Loads workflow definitions and card config |
| `src/assistant/proactive-engine.ts` | Proactive assistant scan loop |
| `src/assistant/assistant-api.ts` | API facade for assistant state, inbox, chat, evolution |
| `src/assistant/evolution-engine.ts` | Self-evolution state machine and adoption flow |
| `src/assistant/types.ts` | Assistant settings, inbox, trigger rules |
| `src/container-runner.ts` | Host-side container launch, mount config, output parsing |
| `container/agent-runner/src/index.ts` | Container-side Agent SDK runner |
| `src/ipc.ts` | File IPC watcher and container-to-host tool operations |
| `src/credential-proxy.ts` | Host credential proxy; real model credentials stay outside containers |
| `src/db.ts` | SQLite schema and data access |
| `electron/main.ts` | Electron shell for Web workbench |
| `electron/renderer/` | Workbench frontend |
| `assistant/main.ts` | Electron shell for personal assistant |
| `assistant/renderer/` | Personal assistant frontend |
| `container/workflow-definitions/` | Workflow state machine definitions |
| `container/cards/` | Interactive card definitions |
| `container/skills/` | Container-side agent skills and methods |
| `groups/{name}/CLAUDE.md` | Per-group memory/instructions used inside container sessions |

## Development Rules

- Run commands directly when needed; do not ask the user to run routine checks.
- Prefer existing project patterns over new abstractions.
- Keep changes scoped. Do not refactor unrelated modules while fixing a narrow issue.
- Do not revert user changes. This repo often has generated data, local groups, and work-in-progress files.
- Use `rg`/`rg --files` for search.
- Use `apply_patch` for manual edits.
- When changing frontend behavior, account for both browser workbench and Electron wrapper behavior.
- When changing assistant behavior, keep the active/passive boundary clear: workbench is the control surface; assistant is the proactive layer.
- When changing mobile-channel behavior, keep Feishu lightweight: task lookup, approval handling, reminder delivery, simple task creation, and short follow-up instructions. Complex configuration, heavy artifact review, knowledge-base editing, and risky operations should return the user to the Web workbench.
- When changing WeCom employee private-channel behavior, preserve the one-to-one customer-service boundary: use private chat to collect employee-provided context needed to resolve Icarus runtime issues, or to answer and handle employee requests on Icarus's behalf. Do not treat WeCom employee DMs as a full workbench, public group channel, or unrestricted privileged control surface.
- When changing container execution, check host-side `src/container-runner.ts` and container-side `container/agent-runner/src/index.ts` together.
- When changing workflow behavior, check the workflow definition/card config and the workbench synchronization path.

## Development Commands

```bash
npm run dev              # Run host service via tsx
npm run build            # Compile TypeScript
npm run typecheck        # Type-check without emit
npm test                 # Run Vitest test suite
npm run format:check     # Check formatting
npm run format:fix       # Format src/**/*.ts
```

Workbench and assistant clients:

```bash
npm run dev:electron     # Build and launch Web workbench Electron client
npm run build:electron   # Build Web workbench Electron entry
npm run dev:assistant    # Build and launch personal assistant Electron client
npm run build:assistant  # Build personal assistant Electron entry
```

Container:

```bash
./container/build.sh
npx tsx setup/index.ts --step container --runtime docker
npx tsx setup/index.ts --step container --runtime apple-container
```

Setup steps:

```bash
npx tsx setup/index.ts --step environment
npx tsx setup/index.ts --step groups
npx tsx setup/index.ts --step register
npx tsx setup/index.ts --step mounts
npx tsx setup/index.ts --step service
npx tsx setup/index.ts --step verify
```

## Runtime Notes

- Web workbench defaults to `http://localhost:3000/`.
- `WEB_TOKEN` protects web APIs and WebSocket when configured.
- Host credential proxy defaults to port `3001`.
- MySQL proxy defaults to port `3003`.
- Feishu webhook server is provided by the Feishu channel when configured; Feishu is the current mobile supplement channel.
- WeCom webhook server is provided by the WeCom channel when configured; WeCom employee DMs are one-to-one private support channels, with each authorized employee mapped to an isolated `wecom:user:{userid}` group.
- Containers receive placeholder credentials and call the host credential proxy.
- `.env` must not be exposed to containers.
- Project root is mounted read-only into the container as `/workspace/project`.
- Current group workspace is mounted read-write as `/workspace/group`.
- Group sessions are isolated under `data/sessions/{group}/.claude/`.

## Core Data Areas

| Path | Meaning |
| --- | --- |
| `store/` | SQLite database files |
| `data/` | Runtime data: IPC, sessions, uploads, attachments, images |
| `groups/` | Per-group workspaces and CLAUDE.md memory |
| `projects/` | Local project knowledge and deliverables |
| `knowledge/` | Host-managed wiki and knowledge base |
| `logs/` | Host service and setup logs |

Many of these paths are local runtime state and are intentionally ignored by git.

## Security Model

The primary security boundary is container isolation.

- Agents do not run directly on the host.
- Real API keys stay in the host process and credential proxy.
- Mount permissions live outside the repo at `~/.config/icarus/mount-allowlist.json`.
- Sensitive paths such as `.ssh`, `.aws`, `.kube`, `.env`, private keys, and credential files must not be mounted.
- Main group is trusted admin context.
- Non-main groups are treated as untrusted input and must only operate within their own scope unless host-side authorization allows more.
- IPC operations must preserve main/non-main permissions.

## Workflow And Workbench Guidance

The workflow engine is configuration-driven. Definitions live in `container/workflow-definitions/*.json`; cards live in `container/cards/*.json`.

When updating workflows:

- Keep role resolution channel-aware.
- Make interrupt/approval points explicit.
- Ensure workbench sync captures task, subtasks, action items, artifacts, comments, context assets, evaluations, and timeline events.
- Preserve traceability through `agent_queries`, `agent_query_steps`, and `agent_query_events`.
- If a user-facing action can pause, retry, skip, approve, revise, or return to a stage, keep workbench and card behavior aligned.
- Mobile approval actions from Feishu cards must write back to the same workflow/workbench state; do not create a separate task state that only exists in chat.

## Personal Assistant Guidance

The assistant is proactive but controlled by policy.

Important defaults:

- `enabled: true`
- `proactiveLevel: balanced`
- `scanIntervalMinutes: 10`
- `evolution.enabled: false`
- `evolution.autoImplementEnabled: false`
- `evolution.autoAdoptEnabled: false`

When updating assistant behavior:

- Do not make proactive scans noisy by default.
- Respect quiet hours, selected services, trigger rule settings, and max inbox item limits.
- Investigation and repair actions must be explicit in action logs.
- Risky operations such as code changes, deploys, restarts, data deletion, permission changes, or branch adoption should require approval unless a narrow policy says otherwise.
- Self-evolution should create proposals and working branches before adoption; do not let the agent freely merge main.

## Container Agent Guidance

The container runner receives JSON input on stdin and follow-up messages via `/workspace/ipc/input`.

Output is wrapped with:

```text
---NANOCLAW_OUTPUT_START---
{...json...}
---NANOCLAW_OUTPUT_END---
```

When modifying container execution:

- Keep stdout protocol stable.
- Keep session reuse and IPC close sentinel behavior intact.
- Preserve query IDs, run IDs, selected model backfill, and trace events.
- Keep `/workspace/project` read-only.
- Be careful with timeouts, idle behavior, and concurrent container limits.

## Service Management

macOS launchd:

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Linux systemd, if installed:

```bash
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Container Build Cache

The container build cache can retain stale copied files. If `./container/build.sh` or `setup --step container` appears to reuse old container code, prune the builder/cache before rebuilding.
