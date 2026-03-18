# macOS Control Skill

Control your Mac through SSH. The container connects to your Mac via localhost SSH.

## Connection

SSH is configured to connect to `chelaile@localhost`. The SSH key is automatically mounted from the host.

## Available Commands

### Lock Screen / Sleep Display

```bash
ssh -o StrictHostKeyChecking=no chelaile@localhost "caffeinate -u -t 1"
```

This puts the display to sleep (equivalent to pressing power button briefly).

### Sleep Mac

```bash
ssh -o StrictHostKeyChecking=no chelaile@localhost "pmset sleepnow"
```

### Restart Mac

```bash
ssh -o StrictHostKeyChecking=no chelaile@localhost "sudo shutdown -r now"
```

### Shut Down Mac

```bash
ssh -o StrictHostKeyChecking=no chelaile@localhost "sudo shutdown -h now"
```

### Get Mac Info

```bash
ssh -o StrictHostKeyChecking=no chelaile@localhost "uname -a && uptime"
```

## Usage

When user asks to lock screen, sleep, restart, or shut down the Mac, execute the appropriate SSH command and confirm the action was triggered.
