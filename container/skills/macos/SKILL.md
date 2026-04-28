---
name: macos
description: Control the host Mac through SSH — run commands, manage applications, and interact with the desktop environment.
---

# macOS Control Skill

Control your Mac through SSH. The container connects to your Mac via the host's LAN IP address.

## Connection

SSH is configured to connect to `chelaile@172.16.11.100`. The SSH key is automatically mounted from the host.

## Available Commands

### Capture Desktop Screenshot / Info

Use the NanoClaw MCP desktop capture tool when you need to inspect the live Mac desktop. This goes through the connected Electron/Web client and requires macOS Screen Recording permission for the desktop app.

```text
mcp__nanoclaw__desktop_capture
```

Useful arguments:
- `include_image`: `true` for a screenshot, `false` for metadata only.
- `include_windows`: `true` to include visible window titles.
- `display_id`: optional display id from a prior metadata result.
- `max_width`: screenshot max width, default 1920.

### Sleep Mac

```bash
ssh -o StrictHostKeyChecking=no chelaile@172.16.11.100 "pmset sleepnow"
```

### Restart Mac

```bash
ssh -o StrictHostKeyChecking=no chelaile@172.16.11.100 "sudo shutdown -r now"
```

### Shut Down Mac

```bash
ssh -o StrictHostKeyChecking=no chelaile@172.16.11.100 "sudo shutdown -h now"
```

### Get Mac Info

```bash
ssh -o StrictHostKeyChecking=no chelaile@172.16.11.100 "uname -a && uptime"
```

## Usage

When user asks to lock screen, sleep, restart, or shut down the Mac, execute the appropriate SSH command and confirm the action was triggered.
