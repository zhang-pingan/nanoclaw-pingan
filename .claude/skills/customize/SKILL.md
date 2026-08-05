---
name: customize
description: Add new capabilities or modify behavior. Use when the user wants to add a currently unsupported channel, change triggers, add integrations, modify the router, or make other code-level customizations.
---

# Customization

This skill helps users add capabilities or modify behavior. Use AskUserQuestion to understand what they want before making changes.

## Workflow

1. **Understand the request** - Ask clarifying questions
3. **Plan the changes** - Identify files to modify and verify whether the requested capability is currently built in.
4. **Implement** - Make changes directly to the code
5. **Test guidance** - Tell user how to verify

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/feishu.ts` | Feishu connection and send/receive |
| `src/channels/wecom.ts` | WeCom connection and send/receive |
| `src/channels/web.ts` | Web channel and API surface |
| `src/channels/assistant.ts` | Local Assistant channel |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/types.ts` | TypeScript interfaces (includes Channel) |
| `src/config.ts` | Assistant name, trigger pattern, directories |
| `src/db.ts` | Database initialization and queries |
| `agents/CLAUDE.md` | Global memory/persona |

## Common Customization Patterns

### Adding a New Input Channel (for example, Telegram, Slack, or Email)

Questions to ask:
- Which channel? (Telegram, Slack, Discord, email, SMS, etc.)
- Same trigger word or different?
- Same memory hierarchy or separate?
- Should messages from this channel go to existing agents or new ones?

Implementation pattern:
1. Create `src/channels/{name}.ts` implementing the `Channel` interface from `src/types.ts` (use the current built-in channels as references)
2. Add the channel instance to `main()` in `src/index.ts` and wire callbacks (`onMessage`, `onChatMetadata`)
3. Messages are stored via the `onMessage` callback; routing is automatic via `ownsJid()`

### Adding a New MCP Integration

Questions to ask:
- What service? (Calendar, Notion, database, etc.)
- What operations needed? (read, write, both)
- Which agents should have access?

Implementation:
1. Add MCP server config to the container settings (see `src/container-runner.ts` for how MCP servers are mounted)
2. Document available tools in `agents/CLAUDE.md`

### Changing Assistant Behavior

Questions to ask:
- What aspect? (name, trigger, persona, response style)
- Apply to all agents or specific ones?

Simple changes → edit `src/config.ts`
Persona changes → edit `agents/CLAUDE.md`
Per-Agent behavior → edit specific Agent's `CLAUDE.md`

### Adding New Commands

Questions to ask:
- What should the command do?
- Available in all agents or main only?
- Does it need new MCP tools?

Implementation:
1. Commands are handled by the agent naturally — add instructions to `agents/CLAUDE.md` or the Agent's `CLAUDE.md`
2. For trigger-level routing changes, modify `processAgentMessages()` in `src/index.ts`

### Changing Deployment

Questions to ask:
- Target platform? (Linux server, Docker, different Mac)
- Service manager? (systemd, Docker, supervisord)

Implementation:
1. Create appropriate service files
2. Update paths in config
3. Provide setup instructions

## After Changes

Always tell the user:
```bash
# Rebuild and restart
npm run build
# macOS:
launchctl unload ~/Library/LaunchAgents/com.icarus.plist
launchctl load ~/Library/LaunchAgents/com.icarus.plist
# Linux:
# systemctl --user restart icarus.service
```

## Example Interaction

User: "Add Telegram as an input channel"

1. Ask: "Should Telegram use the same @Andy trigger, or a different one?"
2. Ask how Telegram chats should map to Agent folders and conversation contexts.
3. Create `src/channels/telegram.ts` implementing the `Channel` interface using an existing built-in channel as the structural reference.
4. Add the channel to `main()` in `src/index.ts`
5. Tell user how to authenticate and test
