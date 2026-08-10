# Icarus Requirements

Original requirements and design decisions from the project creator.

---

## Project Scope

Icarus is an internal, experimental, single-user tool. It is not a delivered product and does not promise an SLA, uninterrupted upgrades, long-term backward compatibility, compliance certification, or production support.

During the current no-history development stage, the entire project is latest-only. A new protocol, schema, API, event model, Git layout, or SQLite schema immediately replaces the previous version; the project does not retain migration chains, dual-write paths, compatibility readers, obsolete replay, or stale-client negotiation. Version mismatches fail closed and stale development state is explicitly reinitialized. See [`internal-experimental-scope.md`](internal-experimental-scope.md#development-version-policy) for reset safety and the required compatibility freeze point.

Freeze checks, release/activation commands, contracts, approvals, and audit records exist only when they reduce development rework, protect local state, or keep an in-progress checkout from disrupting normal local use. They are internal guardrails, not customer-facing obligations. A guardrail whose maintenance cost or iteration delay exceeds the local risk it prevents should be simplified, moved out of the default path, or archived.

Security boundaries around credentials, host access, external messages, and destructive operations remain real safety requirements even for an internal tool.

The only supported Host runtime topology is a local Git checkout. Users clone the repository, configure and build in that working directory, and point the local service manager at it. Browser and Electron clients consume that checkout's Host. A standalone application bundle, DMG/PKG installer, Host embedded in Electron, packaged-install migration path, and automatic product updater are out of scope.

See [`internal-experimental-scope.md`](internal-experimental-scope.md) for the terminology and engineering-weight decisions.

---

## Why This Exists

This is a lightweight, secure alternative to OpenClaw (formerly ClawBot). That project became a monstrosity - 4-5 different processes running different gateways, endless configuration files, endless integrations. It's a security nightmare where agents don't run in isolated processes; there's all kinds of leaky workarounds trying to prevent them from accessing parts of the system they shouldn't. It's impossible for anyone to realistically understand the whole codebase. When you run it you're kind of just yoloing it.

Icarus gives you the core functionality without that mess.

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your Mac.

### Built for One User

This isn't a framework or a platform. It is working software for a specific deployment. The current built-in channels are Feishu, WeCom, Assistant, and Web. Telegram is not installed; a fork can add it through deliberate code customization when needed.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical. Very minimal things like the trigger word are in config. Everything else - just change the code to do what you want.

### AI-Native Development

I don't need an installation wizard - Claude Code guides the setup. I don't need a monitoring dashboard - I ask Claude Code what's happening. I don't need elaborate logging UIs - I ask Claude to read the logs. I don't need debugging tools - I describe the problem and Claude fixes it.

The codebase assumes you have an AI collaborator. It doesn't need to be excessively self-documenting or self-debugging because Claude is always there.

### Skills Over Features

Channel additions should remain deliberate code changes. A fork that needs Telegram can add a channel implementation without making the base runtime pretend the integration is already available.

---

## RFS (Request for Skills)

Skills we'd love contributors to build:

### Communication Channels
Skills to add or switch to different messaging platforms:
- `/add-telegram` - Add Telegram as an input channel
- `/add-slack` - Add Slack as an input channel
- `/add-discord` - Add Discord as an input channel
- `/add-sms` - Add SMS via Twilio or similar

### Container Runtime
The project uses Docker by default (cross-platform). For macOS users who prefer Apple Container:
- `/convert-to-apple-container` - Switch from Docker to Apple Container (macOS-only)

### Platform Support
- `/setup-linux` - Make the full setup work on Linux (depends on Docker conversion)
- `/setup-windows` - Windows support via WSL2 + Docker

---

## Vision

A personal Claude assistant accessible through its installed channels, with minimal custom code.

**Core components:**
- **Claude Agent SDK** as the core agent
- **Containers** for isolated agent execution (Linux VMs)
- **Feishu, WeCom, Assistant, and Web** as the current I/O channels
- **Persistent memory** per conversation and globally
- **Scheduled tasks** that run Claude and can message back
- **Web access** for search and browsing
- **Browser automation** via agent-browser

**Implementation approach:**
- Use existing tools (Claude Agent SDK, MCP servers, and installed channel APIs)
- Minimal glue code
- File-based systems where possible (CLAUDE.md for memory, folders for Agents)

---

## Architecture Decisions

### Message Routing
- A router receives messages from installed channels and routes them by bound chat JID
- Only messages from registered Agents are processed
- Trigger: `@Andy` prefix (case insensitive), configurable via `ASSISTANT_NAME` env var
- Unregistered Agents are ignored completely

### Memory System
- **Per-agent memory**: Each agent has a folder with its own `CLAUDE.md`
- **Global memory**: Root `CLAUDE.md` is read by all Agents, but only writable from "main" (self-chat)
- **Files**: Agents can create/read files in their folder and reference them
- Agent runs in the agent's folder, automatically inherits both CLAUDE.md files

### Session Management
- Each agent maintains a conversation session (via Claude Agent SDK)
- Sessions auto-compact when context gets too long, preserving critical information

### Container Isolation
- All agents run inside containers (lightweight Linux VMs)
- Each agent invocation spawns a container with mounted directories
- Containers provide filesystem isolation - agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- Browser automation via agent-browser with Chromium in the container

### Scheduled Tasks
- Users can ask Claude to schedule recurring or one-time tasks from any agent
- Tasks run as full agents in the context of the agent that created them
- Tasks have access to all tools including Bash (safe in container)
- Tasks can optionally send messages to their agent via `send_message` tool, or complete silently
- Task runs are logged to the database with duration and result
- Schedule types: cron expressions, intervals (ms), or one-time (ISO timestamp)
- From main: can schedule tasks for any agent, view/manage all tasks
- From other Agents: can only manage that agent's tasks

### Agent Management
- New Agents are added explicitly via the main channel
- Agents are registered in SQLite (via the main channel or IPC `register_agent` command)
- Each agent gets a dedicated folder under `agents/`
- Agents can have additional directories mounted via `containerConfig`

### Main Channel Privileges
- Main channel is the admin/control agent (typically self-chat)
- Can write to global memory (`agents/CLAUDE.md`)
- Can schedule tasks for any agent
- Can view and manage tasks from all Agents
- Can configure additional directory mounts for any agent

---

## Integration Points

### Current Channels
- Feishu and WeCom connect through their application APIs and webhook endpoints
- Assistant and Web provide local product surfaces
- Channel modules self-register and own their canonical JID formats

### Scheduler
- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `icarus` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history
- Scheduler loop checks for due tasks every minute
- Tasks execute Claude Agent SDK in containerized agent context

### Web Access
- Built-in WebSearch and WebFetch tools
- Standard Claude Agent SDK capabilities

### Browser Automation
- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references (@e1, @e2, etc.)
- Screenshots, PDFs, video recording
- Authentication state persistence

---

## Setup & Operations

### Philosophy
- Minimal configuration files
- Setup, diagnosis, and workflow lifecycle operations use project-local Claude Code skills
- Users clone the repo and run Claude Code to configure
- Each user gets a custom setup matching their exact needs

### Skills
- `/setup` - Install dependencies, configure built-in channels and scheduler, and start services
- `/debug` - Diagnose Host, channel, container, credential, session, IPC, and Workflow Runtime failures
- `/manage-workflows` - Manage Personal, Dynamic Runtime, and Collaboration workflow lifecycles

### Deployment
- Runs from a local Git checkout on Mac via launchd
- Single Node.js process handles everything
- Browser and checkout-built Electron clients connect to that Host
- No standalone application package or packaged Host runtime

---

## Personal Configuration (Reference)

These are the creator's settings, stored here for reference:

- **Trigger**: `@Andy` (case insensitive)
- **Response prefix**: `Andy:`
- **Persona**: Default Claude (no custom personality)
- **Main channel**: A registered Assistant, Web, or configured enterprise-chat Agent

---

## Project Name

**Icarus** - A reference to Clawdbot (now OpenClaw).
