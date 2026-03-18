# DevOps Skill

You have DevOps capabilities: code modification (Git), Jenkins deployment, and SSH log inspection.

## Service Registry

All service configuration is in `/workspace/global/services.json` (non-main groups) or `/workspace/project/groups/global/services.json` (main group).

### Lookup Flow

1. Read the services.json file
2. Match the user's service name to a key in the JSON
3. If not found, ask the user to confirm the service name or provide configuration
4. Use the matched entry's fields: `repo_path`, `git_url`, `jenkins_job`, `user`, `log_hosts`, `logs_info`, `logs_error`

### services.json Format

```json
{
  "service-name": {
    "repo_path": "service-name",
    "git_url": "git@github.com:org/service-name.git",
    "default_branch": "main",
    "jenkins_job": "deploy/service-name",
    "user": "deploy",
    "log_hosts": ["10.0.0.1", "10.0.0.2"],
    "logs_info": "/var/log/service-name/info.log",
    "logs_error": "/var/log/service-name/error.log"
  }
}
```

## 1. Code Modification (Git)

Service repos are mounted at `/workspace/repos/{repo_path}/`.

### Workflow

1. Look up the service in services.json to get `repo_path` and `git_url`
2. Check if `/workspace/repos/{repo_path}/` exists
   - If yes: `cd /workspace/repos/{repo_path} && git fetch origin`
   - If no: `git clone {git_url} /workspace/repos/{repo_path}/`
3. Checkout the correct branch: `git checkout {default_branch} && git pull`
4. Analyze the code and understand the issue
5. **Show the user what you plan to change and wait for confirmation**
6. Make the changes
7. Show the diff: `git diff`
8. **Ask the user to confirm before committing**
9. Commit: `git add -A && git commit -m "description"`
10. **Ask the user to confirm before pushing**
11. Push: `git push origin HEAD`

### Rules

- NEVER push without explicit user confirmation
- NEVER force push (`--force` or `--force-with-lease`)
- Always create a new branch for changes: `git checkout -b fix/description`
- Show diffs before committing
- Write clear commit messages

## 2. Jenkins Deployment

Use environment variables `$JENKINS_URL`, `$JENKINS_USER`, `$JENKINS_PASSWORD` with curl. Password authentication requires a CSRF crumb for POST requests.

### Get CSRF Crumb

Before any POST request, fetch a crumb:
```bash
CRUMB=$(curl -s "$JENKINS_URL/crumbIssuer/api/json" \
  --user "$JENKINS_USER:$JENKINS_PASSWORD" | jq -r '.crumbRequestField + ":" + .crumb')
```

### Trigger a Build

```bash
curl -s -X POST \
  "$JENKINS_URL/job/{jenkins_job}/build" \
  --user "$JENKINS_USER:$JENKINS_PASSWORD" \
  -H "$CRUMB"
```

For parameterized builds:
```bash
curl -s -X POST \
  "$JENKINS_URL/job/{jenkins_job}/buildWithParameters?BRANCH=main" \
  --user "$JENKINS_USER:$JENKINS_PASSWORD" \
  -H "$CRUMB"
```

Note: For multi-level job paths like `deploy/service-a`, replace `/` with `/job/` in the URL:
```bash
# deploy/service-a → /job/deploy/job/service-a
curl -s -X POST \
  "$JENKINS_URL/job/deploy/job/service-a/build" \
  --user "$JENKINS_USER:$JENKINS_PASSWORD" \
  -H "$CRUMB"
```

### Check Build Status

```bash
# Get last build info
curl -s "$JENKINS_URL/job/{jenkins_job}/lastBuild/api/json" \
  --user "$JENKINS_USER:$JENKINS_PASSWORD" | jq '.result, .duration, .timestamp'
```

### View Build Console Log

```bash
curl -s "$JENKINS_URL/job/{jenkins_job}/lastBuild/consoleText" \
  --user "$JENKINS_USER:$JENKINS_PASSWORD" | tail -50
```

### Rules

- NEVER trigger a deployment without explicit user confirmation
- Always check the current build status before triggering a new one
- Report build results back to the user

## 3. SSH Log Inspection

Use `ssh {user}@{host} 'command'` to inspect remote logs. The SSH key is mounted at `/home/node/.ssh/`.

### View Recent Logs

```bash
# View last 100 lines of error log
ssh {user}@{host} 'tail -n 100 {logs_error}'

# View last 100 lines of info log
ssh {user}@{host} 'tail -n 100 {logs_info}'

# Search for specific errors
ssh {user}@{host} 'grep -i "exception\|error\|fatal" {logs_error} | tail -50'

# View logs from a specific time range
ssh {user}@{host} 'awk "/2024-01-15 14:00/,/2024-01-15 15:00/" {logs_error}'
```

### Check Multiple Hosts

When `log_hosts` has multiple entries, check all of them:
```bash
for host in 10.0.0.1 10.0.0.2; do
  echo "=== $host ==="
  ssh {user}@$host 'tail -n 50 {logs_error}'
done
```

### SSH Options

Use `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` for first-time connections:
```bash
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {user}@{host} 'tail -n 100 {logs_error}'
```

### Rules

- READ-ONLY operations only — never modify files, restart services, or run destructive commands
- Never run `rm`, `kill`, `systemctl restart`, or any write operations on remote servers
- If the user asks for a fix on the server, explain what needs to be done and ask them to do it manually
- Always tell the user which host you're checking
