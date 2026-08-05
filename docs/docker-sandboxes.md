# Running Icarus in Docker Sandboxes (Manual Setup)

This guide walks through setting up Icarus inside a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/) from scratch — no install script, no pre-built fork. You'll clone the upstream repo, apply the necessary patches, and have agents running in full hypervisor-level isolation.

## Architecture

```
Host (macOS / Windows WSL)
└── Docker Sandbox (micro VM with isolated kernel)
    ├── Icarus process (Node.js)
    │   ├── Built-in channel adapters (Feishu, WeCom, Assistant, Web)
    │   └── Container spawner → nested Docker daemon
    └── Docker-in-Docker
        └── icarus-agent containers
            └── Claude Agent SDK
```

Each agent runs in its own container, inside a micro VM that is fully isolated from your host. Two layers of isolation: per-agent containers + the VM boundary.

The sandbox provides a MITM proxy at `host.docker.internal:3128` that handles network access and injects your Anthropic API key automatically.

> **Note:** This guide covers the current built-in channels. Custom channels may require additional proxy configuration for their HTTP or WebSocket clients.

## Prerequisites

- **Docker Desktop v4.40+** with Sandbox support
- **Anthropic API key** (the sandbox proxy manages injection)
- Credentials for Feishu or WeCom when either external channel is enabled

Verify sandbox support:
```bash
docker sandbox version
```

## Step 1: Create the Sandbox

On your host machine:

```bash
# Create a workspace directory
mkdir -p ~/icarus-workspace

# Create a shell sandbox with the workspace mounted
docker sandbox create shell ~/icarus-workspace
```

Enter the sandbox:
```bash
docker sandbox run shell-icarus-workspace
```

## Step 2: Install Prerequisites

Inside the sandbox:

```bash
sudo apt-get update && sudo apt-get install -y build-essential python3
npm config set strict-ssl false
```

## Step 3: Clone and Install Icarus

Icarus must live inside the workspace directory — Docker-in-Docker can only bind-mount from the shared workspace path.

```bash
# Clone to home first (virtiofs can corrupt git pack files during clone)
cd ~
git clone  icarus

# Replace with YOUR workspace path (the host path you passed to `docker sandbox create`)
WORKSPACE=/Users/you/icarus-workspace

# Move into workspace so DinD mounts work
mv icarus "$WORKSPACE/icarus"
cd "$WORKSPACE/icarus"

# Install dependencies
npm install
npm install https-proxy-agent
```

## Step 4: Apply Proxy and Sandbox Patches

Icarus needs several patches to work inside a Docker Sandbox. These handle proxy routing, CA certificates, and Docker-in-Docker mount restrictions.

### 4a. Dockerfile — proxy args for container image build

`npm install` inside `docker build` fails with `SELF_SIGNED_CERT_IN_CHAIN` because the sandbox's MITM proxy presents its own certificate. Add proxy build args to `container/Dockerfile`:

Add these lines after the `FROM` line:

```dockerfile
# Accept proxy build args
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NODE_EXTRA_CA_CERTS
ARG npm_config_strict_ssl=true
RUN npm config set strict-ssl ${npm_config_strict_ssl}
```

And after the `RUN npm install` line:

```dockerfile
RUN npm config set strict-ssl true
```

### 4b. Build script — forward proxy args

Patch `container/build.sh` to pass proxy env vars to `docker build`:

Add these `--build-arg` flags to the `docker build` command:

```bash
--build-arg http_proxy="${http_proxy:-$HTTP_PROXY}" \
--build-arg https_proxy="${https_proxy:-$HTTPS_PROXY}" \
--build-arg no_proxy="${no_proxy:-$NO_PROXY}" \
--build-arg npm_config_strict_ssl=false \
```

### 4c. Container runner — proxy forwarding, CA cert mount, /dev/null fix

Three changes to `src/container-runner.ts`:

**Replace `/dev/null` shadow mount.** The sandbox rejects `/dev/null` bind mounts. Find where `.env` is shadow-mounted to `/dev/null` and replace it with an empty file:

```typescript
// Create an empty file to shadow .env (Docker Sandbox rejects /dev/null mounts)
const emptyEnvPath = path.join(DATA_DIR, 'empty-env');
if (!fs.existsSync(emptyEnvPath)) fs.writeFileSync(emptyEnvPath, '');
// Use emptyEnvPath instead of '/dev/null' in the mount
```

**Forward proxy env vars** to spawned agent containers. Add `-e` flags for `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase variants.

**Mount CA certificate.** If `NODE_EXTRA_CA_CERTS` or `SSL_CERT_FILE` is set, copy the cert into the project directory and mount it into agent containers:

```typescript
const caCertSrc = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
if (caCertSrc) {
  const certDir = path.join(DATA_DIR, 'ca-cert');
  fs.mkdirSync(certDir, { recursive: true });
  fs.copyFileSync(caCertSrc, path.join(certDir, 'proxy-ca.crt'));
  // Mount: certDir -> /workspace/ca-cert (read-only)
  // Set NODE_EXTRA_CA_CERTS=/workspace/ca-cert/proxy-ca.crt in the container
}
```

### 4d. Container runtime — prevent self-termination

In `src/container-runtime.ts`, the `cleanupOrphans()` function matches containers by the `icarus-` prefix. Inside a sandbox, the sandbox container itself may match (e.g., `icarus-docker-sandbox`). Filter out the current hostname:

```typescript
// In cleanupOrphans(), filter out os.hostname() from the list of containers to stop
```

### 4e. Credential proxy — route through MITM proxy

In `src/credential-proxy.ts`, upstream API requests need to go through the sandbox proxy. Add `HttpsProxyAgent` to outbound requests:

```typescript
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const upstreamAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
// Pass upstreamAgent to https.request() options
```

### 4f. Setup script — proxy build args

Patch `setup/container.ts` to pass the same proxy `--build-arg` flags as `build.sh` (Step 4b).

## Step 5: Build

```bash
npm run build
bash container/build.sh
```

## Step 6: Configure a Built-in Channel

Web and Assistant are available locally. Register the Web main Agent explicitly:

```bash
cat > .env << EOF
ASSISTANT_NAME=Icarus
ANTHROPIC_API_KEY=proxy-managed
EOF
mkdir -p data/env && cp .env data/env/env

npx tsx setup/index.ts --step register -- \
  --jid "web:main" \
  --name "Web Main" \
  --trigger "@Icarus" \
  --folder "web_main" \
  --channel web \
  --assistant-name "Icarus" \
  --is-main \
  --no-trigger-required
```

Feishu and WeCom require their documented application credentials in `.env`. Register their canonical JIDs with `--channel feishu` or `--channel wecom` after configuring those credentials.

## Step 7: Run

```bash
npm start
```

You don't need to set `ANTHROPIC_API_KEY` manually. The sandbox proxy intercepts requests and replaces `proxy-managed` with your real key automatically.

## Networking Details

### How the proxy works

All traffic from the sandbox routes through the host proxy at `host.docker.internal:3128`:

```
Agent container → DinD bridge → Sandbox VM → host.docker.internal:3128 → Host proxy → api.anthropic.com
```

**"Bypass" does not mean traffic skips the proxy.** It means the proxy passes traffic through without MITM inspection. Node.js doesn't automatically use `HTTP_PROXY` env vars — you need explicit `HttpsProxyAgent` configuration in every HTTP/WebSocket client.

### Shared paths for DinD mounts

Only the workspace directory is available for Docker-in-Docker bind mounts. Paths outside the workspace fail with "path not shared":
- `/dev/null` → replace with an empty file in the project dir
- `/usr/local/share/ca-certificates/` → copy cert to project dir
- `/home/agent/` → clone to workspace instead

### Git clone and virtiofs

The workspace is mounted via virtiofs. Git's pack file handling can corrupt over virtiofs during clone. Workaround: clone to `/home/agent` first, then `mv` into the workspace.

## Troubleshooting

### npm install fails with SELF_SIGNED_CERT_IN_CHAIN
```bash
npm config set strict-ssl false
```

### Container build fails with proxy errors
```bash
docker build \
  --build-arg http_proxy=$http_proxy \
  --build-arg https_proxy=$https_proxy \
  -t icarus-agent:latest container/
```

### Agent containers fail with "path not shared"
All bind-mounted paths must be under the workspace directory. Check:
- Is Icarus cloned into the workspace? (not `/home/agent/`)
- Is the CA cert copied to the project root?
- Has the empty `.env` shadow file been created?

### Agent containers can't reach Anthropic API
Verify proxy env vars are forwarded to agent containers. Check container logs for `HTTP_PROXY=http://host.docker.internal:3128`.

### Git clone fails with "inflate: data stream error"
Clone to a non-workspace path first, then move:
```bash
cd ~ && git clone  icarus && mv icarus /path/to/workspace/icarus
```
