---
name: setup
description: Install, configure, start, or repair the current Icarus checkout on macOS or Linux using its managed Node 26 toolchain, Docker runtime, setup CLI, channel registration, mount allowlist, Host Core launcher, and verification checks. Use for first-time setup, dependency installation, local environment configuration, service installation, or recovery of an incomplete setup.
---

# Set Up Icarus

Set up the current checkout in place. Do not fetch another repository, configure Git remotes, merge external history, or replace the checkout as part of setup.

## Operating Rules

- Run from the repository root and use the checked-in setup/toolchain scripts as the authority.
- Preserve an existing `.env`, `store/`, `data/`, `agents/`, `knowledge/`, mount allowlist, and Host Core snapshots.
- Do not print or request secrets in chat. Ask the user to place secret values in `.env`, then verify only key presence and placeholder status.
- Ask before installing system software, changing service-manager state, opening external network access, or resetting persisted Workflow state.
- Fix recoverable setup failures and rerun the failed step. Do not hide failed status fields.
- Use Docker. `src/container-runtime.ts` is the runtime authority for this checkout.

## Local State

These paths are intentionally local or generated and may be absent in a clean checkout:

- `.env`, `node_modules/`, `dist/`, `dist-electron/`, `dist-assistant/`;
- `store/`, `data/`, `logs/`, `knowledge/`;
- registered Agent folders under `agents/`;
- `~/.config/icarus/mount-allowlist.json`;
- `${ICARUS_RUNTIME_HOME:-$HOME/Library/Application Support/Icarus}` for the managed Node toolchain, Host Core snapshots, and Workflow state backups.

Do not interpret their absence as source corruption.

## Setup Workflow

### 1. Inspect before writing

Run:

```bash
git status --short
test -f .env && echo '.env present' || echo '.env missing'
test -f "$HOME/.config/icarus/mount-allowlist.json" && echo 'mount allowlist present' || echo 'mount allowlist missing'
```

If this is a repair, also inspect `logs/setup.log`, `logs/icarus.error.log`, the registered Agents, and current service state. Work with existing user changes.

### 2. Bootstrap the managed runtime and dependencies

Run:

```bash
bash setup.sh
```

Parse the `BOOTSTRAP` status block. Success requires `MANAGED_OK=true`, `DEPS_OK=true`, and `NATIVE_OK=true`. The project requires Node major 26 and a compatible native ABI.

On failure, read `logs/setup.log`:

- `managed_runtime_failed`: check platform/architecture support, network access, checksum, and the current Node executable;
- `deps_failed`: diagnose `npm ci` without deleting unrelated local state;
- `native_failed`: install the platform build toolchain when required, then rerun bootstrap.

Use the configured runtime for all later Node/npm/npx commands:

```bash
./scripts/runtime-toolchain.sh verify
./scripts/runtime-toolchain.sh exec -- node --version
```

### 3. Detect the environment

Run:

```bash
./scripts/runtime-toolchain.sh exec -- npx tsx setup/index.ts --step environment
```

Reject unsupported platforms. Record Docker status, `.env` presence, and whether Agents are already registered.

### 4. Configure `.env`

If `.env` is missing, create it from `.env.example`. Do not overwrite an existing file.

Classify each relevant key as configured, missing, placeholder, or defaulted without showing its value. Refresh the key inventory from current code when necessary:

```bash
rg -n "readEnvFile\\(|process\\.env\\." src setup container/agent-runner/src \
  --glob '!**/*.test.ts' --glob '!**/dist/**' --glob '!**/node_modules/**'
```

Require one Host model credential for Agent execution:

- `ANTHROPIC_API_KEY`, or
- `CLAUDE_CODE_OAUTH_TOKEN`.

Require integration-specific keys only when that integration is enabled. In particular:

- Feishu requires its app credentials;
- WeCom requires corp, app, agent, token, encoding key, and allowed-user configuration;
- OpenAI-compatible credential proxying requires its API key, base URL, model, and protocol;
- Workflow execution adapters require only the selected adapter's settings;
- DevOps, mail, image, Collaboration, and external service credentials remain optional until used.

Treat `#`, empty strings, `TODO`, `CHANGEME`, `your-*`, and similar examples as missing.

### 5. Ensure Docker is available

Run `docker info`. If Docker is installed but stopped, start it using the platform's normal mechanism and recheck. If it is not installed, ask before installation.

Do not offer a runtime conversion during setup. Runtime changes are code changes outside this skill.

### 6. Build and smoke-test the Agent image

Run:

```bash
./scripts/runtime-toolchain.sh exec -- npx tsx setup/index.ts --step container -- --runtime docker
```

Require both `BUILD_OK=true` and `TEST_OK=true`. On failure, read `logs/setup.log` and Docker output. Do not prune all Docker data as a first response.

### 7. Configure additional-mount policy

For no external Agent mounts, use the fail-closed default:

```bash
./scripts/runtime-toolchain.sh exec -- npx tsx setup/index.ts --step mounts -- --empty
```

When the user needs external mounts, collect exact roots and read/write intent, then pass JSON shaped like:

```json
{
  "allowedRoots": [
    {
      "path": "/absolute/path",
      "allowReadWrite": false,
      "description": "Purpose of this root"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

Do not allow credential directories or secret-bearing paths.

### 8. Register the channels the user will use

The built-in channels are `assistant`, `web`, `feishu`, and `wecom`.

- Assistant ensures `assistant:main` when the Host connects.
- Register a Web main Agent for the workbench when absent:

```bash
./scripts/runtime-toolchain.sh exec -- npx tsx setup/index.ts --step register -- \
  --channel web --jid web:main --name "Web Main" \
  --trigger "@Andy" --folder web_main --no-trigger-required --is-main
```

Use `--assistant-name` when the configured assistant name differs from `Andy`.

Register Feishu or WeCom only when the user enables that channel and provides its canonical identity:

- Feishu JIDs start with `feishu:oc_` or `feishu:ou_`;
- WeCom private-user JIDs start with `wecom:user:`.

Do not create speculative role Agents. Feature activation and actual workflow/execution bindings determine any additional Agent requirements.

### 9. Install and start the Host service

Run the maintained setup step:

```bash
./scripts/runtime-toolchain.sh exec -- npx tsx setup/index.ts --step service
```

It builds through the configured runtime and installs launchd on macOS, systemd on Linux, or a nohup wrapper when systemd is unavailable. Read the structured status and repair `SERVICE_LOADED=false` from `logs/setup.log` and `logs/icarus.error.log`.

For later checkout-owned macOS lifecycle operations, use:

```bash
./local/shell/start.sh --mode current
./local/shell/restart.sh --mode current
./local/shell/stop.sh
```

Do not select an `active` Host Core snapshot during ordinary setup.

### 10. Verify end to end

Run:

```bash
./scripts/runtime-toolchain.sh exec -- npx tsx setup/index.ts --step verify
```

Require:

- Host service running;
- Docker detected;
- a supported model credential configured;
- at least one registered Agent;
- intended optional channel credentials configured;
- mount allowlist configured when additional mounts are expected.

Then open the local Web endpoint, send a small request through the intended Agent, and confirm a successful query Trace and container exit.

## Workflow State Compatibility

Startup may stop when the local Workflow Runtime database is not compatible with the current checkout. Inspect it with:

```bash
./local/shell/workflow-state.sh inspect --mode current
```

If and only if it reports `RESET_REQUIRED`, stop Icarus, show the exact DB/WAL/SHM targets and backup location, obtain confirmation, and run:

```bash
./local/shell/workflow-state.sh reset --mode current
```

The guarded command creates and verifies a backup before removing the exact live Workflow Runtime unit. Never broaden the reset to `store/`, `data/`, credentials, configuration, Agent files, or user artifacts.

## Completion Report

Report the configured runtime, service manager, enabled channels, registered main Agent(s), mount policy, verification result, local Web URL, and log locations. List optional integrations that remain intentionally unconfigured.
