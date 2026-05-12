---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, configure NanoClaw, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required for configuration choices. Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action. If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## Clean Clone Notes

Assume a newly cloned checkout does not contain local runtime state. The following paths are intentionally ignored by git and must be created, built, or configured during setup:

- `.env` — secrets and local settings. Start from `.env.example` if present.
- `node_modules/`, `container/agent-runner/node_modules/` — installed by bootstrap/container build.
- `dist/`, `dist-electron/`, `dist-assistant/`, renderer build dirs — generated build output. `setup/service` runs `npm run build`.
- `store/` — SQLite databases and auth state. The app creates it via `initDatabase`; `setup/register` also creates it.
- `data/` — IPC, sessions, uploads, attachments, desktop captures, AI images. Created lazily by runtime.
- `logs/` — setup/service logs. `setup.sh` and service setup create it.
- `knowledge/` — wiki/material storage. Created lazily by wiki/web code.
- Most `groups/*` contents — only `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md`, and `groups/global/services.json.example` are tracked. Registered group folders and logs are local runtime state.
- `groups/global/services.json` — optional local service catalog. Copy from `groups/global/services.json.example` only when DevOps/workflow service integration is needed.

Do not treat missing ignored paths as repo corruption. Create the required ones in setup and let runtime create lazy state where appropriate.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- Record APPLE_CONTAINER and DOCKER values for step 5

## 3. Check .env

Check `.env` against the configuration keys currently used by the project. Do not print secret values; only report key names and whether they are configured, missing, placeholder, or using defaults.

If `.env` is missing:
- If `.env.example` exists, copy it to `.env`.
- If `.env.example` does not exist, create an empty `.env`.
- Tell the user which required values must be filled outside chat. Do not ask the user to paste secrets into chat.

Treat empty values and placeholder values as missing. Placeholder examples: `#`, `TODO`, `CHANGEME`, `your-key`, `your_token`, `xxx`.

Refresh the key list from current code when needed:
```bash
rg -n "readEnvFile\\(|process\\.env\\." src setup container/agent-runner/src --glob '!**/*.test.ts' --glob '!**/dist/**' --glob '!**/node_modules/**'
```

### Required

These are required for usable agent execution:

- `ANTHROPIC_API_KEY`

Reason: containers send model traffic through the host credential proxy. The service may start without these, but agent runs will fail when they call the model API.

### Conditionally Required

Only require these when the related feature is enabled or already configured:

- `CREDENTIAL_PROXY_OPENAI_COMPAT=true` → require `CREDENTIAL_PROXY_OPENAI_API_KEY`
- AI image tool enabled/expected → require `AI_IMAGE_BASE_URL`, `AI_IMAGE_API_KEY`, `AI_IMAGE_MODEL`, `AI_IMAGE_SIZE`, `AI_IMAGE_QUALITY`, `AI_IMAGE_TIMEOUT_MS`
- Host-side Agent API usage → require `NANOCLAW_AGENT_API_API_KEY`; if `NANOCLAW_AGENT_API_USE_OPENAI_COMPAT=true`, also check `NANOCLAW_AGENT_API_OPENAI_KEY`, `NANOCLAW_AGENT_API_OPENAI_BASE_URL`, `NANOCLAW_AGENT_API_OPENAI_MODEL`
- Feishu main group registration expected → require `FEISHU_APP_ID` and `FEISHU_APP_SECRET`
- MySQL service proxy usage → for each MySQL service in `groups/global/services.json`, require `MYSQL_PASSWORD_<service>`
- Jenkins/deploy operations → if `JENKINS_URL` is set, require `JENKINS_USER` and `JENKINS_PASSWORD`

### Optional / Defaults Available

These can be omitted unless the user wants to override defaults:

- Assistant and web: `ASSISTANT_NAME`, `ASSISTANT_HAS_OWN_NUMBER`, `WEB_PORT`, `WEB_TOKEN`
- Runtime tuning: `CONTAINER_IMAGE`, `CONTAINER_TIMEOUT`, `CONTAINER_MAX_OUTPUT_SIZE`, `CREDENTIAL_PROXY_PORT`, `CREDENTIAL_PROXY_HOST`, `MYSQL_PROXY_PORT`, `IDLE_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS`, `TZ`, `LOG_LEVEL`
- DevOps paths: `REPOS_DIR`, `SSH_KEY_PATH`
- Model selection: `ANTHROPIC_BASE_URL`, `ANTHROPIC_CLAUDE_MODEL`, `NANOCLAW_MODEL_LIGHT`, `NANOCLAW_MODEL_DEFAULT`, `NANOCLAW_MODEL_HEAVY`, `NANOCLAW_MODEL_FORCE`, `NANOCLAW_MODEL_SELECTOR_URL`, `NANOCLAW_MODEL_SELECTOR_MODEL`, `NANOCLAW_MODEL_SELECTOR_TIMEOUT_MS`
- OpenAI-compatible credential proxy options when compat is disabled: `CREDENTIAL_PROXY_OPENAI_BASE_URL`, `CREDENTIAL_PROXY_OPENAI_MODEL`, `CREDENTIAL_PROXY_OPENAI_TIMEOUT_MS`, `CREDENTIAL_PROXY_OPENAI_PROTOCOL`
- Feishu optional fields: `FEISHU_VERIFICATION_TOKEN`, `FEISHU_ENCRYPT_KEY`, `FEISHU_ADMIN_USER_ID`, `FEISHU_WEBHOOK_PORT`
- Integrations and advanced features: `WORKBENCH_BROADCAST_TARGETS`, `NANOCLAW_MAIL_CONFIG_PATH`, `NANOCLAW_WIKI_DRAFT_TIMEOUT_MS`, `NANOCLAW_WIKI_DRAFT_MAX_TOKENS`, `NANOCLAW_WIKI_MAX_MATERIAL_CHARS`, `NANOCLAW_WIKI_MAX_TOTAL_MATERIAL_CHARS`, `NANOCLAW_WORKFLOW_LLM_JUDGE_RUN`, `NANOCLAW_WORKFLOW_LLM_JUDGE_TIMEOUT_MS`

If required or conditionally required values are missing, stop and tell the user exactly which keys need values. Continue only after the user confirms they have updated `.env`, then re-check `.env`.

## 4. Register Required Main Groups

Setup must ensure the required main groups are registered. These are hard requirements for a usable installation:

- Assistant main group: `assistant:main` → folder `assistant_main`
- Web main group: `web:main` → folder `web_main`
- Feishu main group: `feishu:oc_...` → folder `feishu_main`

The assistant main group is created automatically by `src/channels/assistant.ts` when the service starts, but setup should still verify it after startup.

Before service startup, register the web main group if it is missing:

```bash
npx tsx setup/index.ts --step register -- \
  --channel web \
  --jid web:main \
  --name "Web Main" \
  --trigger "@Andy" \
  --folder web_main \
  --no-trigger-required \
  --is-main
```

For Feishu, first confirm `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are configured. Then ask the user for the main Feishu chat id if it is not already known. Use the canonical registered JID format with the `feishu:` prefix:

```bash
npx tsx setup/index.ts --step register -- \
  --channel feishu \
  --jid feishu:<oc_chat_id> \
  --name "Feishu Main" \
  --trigger "@Andy" \
  --folder feishu_main \
  --no-trigger-required \
  --is-main
```

Do not register raw `oc_...` Feishu JIDs without the `feishu:` prefix. `src/channels/feishu.ts` looks up inbound main-group status using `feishu:${chatJid}`.

If the user does not want Feishu enabled, stop setup and explain that this setup profile requires the Feishu main group. Do not silently downgrade to web-only.

## 5. Container Runtime

### 5a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 5d.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 5b. Install Docker

- DOCKER=running → continue to 5d
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 5c. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 5d.

**If the chosen runtime is Docker**, no conversion is needed. Continue to 5d.

### 5d. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 8. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

Treat setup success as: service running, required `.env` values configured, and all required main groups registered. The current `setup/verify.ts` also reports legacy channel/group status; use it as signal, but perform the main-group checks below explicitly.

Required main group checks:

```bash
node --input-type=module <<'EOF'
import Database from "better-sqlite3";
const db = new Database("store/messages.db", { readonly: true });
const rows = db.prepare("SELECT jid, folder, is_main, requires_trigger FROM registered_groups").all();
const required = [
  ["assistant:main", "assistant_main"],
  ["web:main", "web_main"],
];
for (const [jid, folder] of required) {
  const row = rows.find((r) => r.jid === jid && r.folder === folder && r.is_main === 1);
  console.log(row ? "OK " + jid : "MISSING " + jid);
}
const feishuMain = rows.find((r) => String(r.jid).startsWith("feishu:") && r.folder === "feishu_main" && r.is_main === 1);
console.log(feishuMain ? "OK " + feishuMain.jid : "MISSING feishu:main");
db.close();
EOF
```

**If setup/verify or explicit checks fail, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- Required `.env` values missing → re-run step 3
- Missing required main group → re-run step 4
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

### Non-main Workflow Groups

Do not fail setup when non-main groups are missing. Warn the user that the `dev_test` and `fix_test` workflows depend on role groups for delegation. If these are not registered, those workflows cannot run end-to-end.

Expected non-main role folders from current workflow definitions:

- `dev_test`: `feishu_plan`, `feishu_plan_examine`, `feishu_dev`, `feishu_dev_examine`, `feishu_ops`, `feishu_test`, or the web equivalents `web_plan`, `web_plan_examine`, `web_dev`, `web_dev_examine`, `web_ops`, `web_test`
- `fix_test`: `feishu_dev`, `feishu_ops`, `feishu_test`, or the web equivalents `web_dev`, `web_ops`, `web_test`

If any are missing, report them as warnings only. Tell the user they can register them later from the main group with the `register_group` tool or by running `npx tsx setup/index.ts --step register`.

Show logs with: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), missing `.env`, invalid Feishu credentials, or port conflicts on `WEB_PORT`, `CREDENTIAL_PROXY_PORT`, `MYSQL_PROXY_PORT`, or `FEISHU_WEBHOOK_PORT`.

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs under the relevant group folder, such as `groups/assistant_main/logs/`, `groups/web_main/logs/`, or `groups/feishu_main/logs/`.

**Feishu main group not recognized:** Registered JID must include the `feishu:` prefix, for example `feishu:oc_xxx`. The inbound Feishu handler computes the lookup key as `feishu:${chatJid}`.

**Clean clone missing local files:** Recreate `.env` from `.env.example`, run `bash setup.sh`, register required main groups, run container setup, configure mounts, then start service. Do not copy ignored runtime state from another machine unless the user explicitly wants to migrate data.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
