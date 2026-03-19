# macOS Control Skill

Control your Mac through SSH. The container connects to your Mac via the host's LAN IP address.

## Connection

SSH is configured to connect to `chelaile@172.16.11.100`. The SSH key is automatically mounted from the host.

## Available Commands

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
