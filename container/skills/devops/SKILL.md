---
name: devops
description: DevOps capabilities including code modification (Git), Jenkins deployment, SSH log inspection, and MySQL database queries for configured services.
---

# DevOps Skill

## Service Registry

All service configuration is in `/workspace/global/services.json` (non-main groups) or `/workspace/project/groups/global/services.json` (main group).

### Lookup Flow

1. Read the services.json file
2. Match the user's service name to a key in the JSON
3. If not found, ask the user to confirm the service name or provide configuration
4. Use the matched entry's fields: `repo_path`, `git_url`, `jenkins_job`, `user`, `log_hosts`, `logs_info`, `logs_error`, `mysql`

### services.json Format

MySQL passwords are in the host `.env` as `MYSQL_PASSWORD_{service}` — the container never sees them.

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

Rules:
- NEVER push without explicit user confirmation
- NEVER force push
- Always create a new branch: `git checkout -b fix/description`

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

Use `ssh` to inspect remote logs. Two SSH keys may be available:
- `/home/node/.ssh/` — default SSH directory (contains git keys)
- `/home/node/.ssh_devops_key` — dedicated server SSH key (if configured via `SSH_KEY_PATH`)

**Always try the devops key first.** If `/home/node/.ssh_devops_key` exists, use `-i /home/node/.ssh_devops_key`. Otherwise fall back to the default key.

```bash
SSH_KEY_FLAG=""
[ -f /home/node/.ssh_devops_key ] && SSH_KEY_FLAG="-i /home/node/.ssh_devops_key"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null $SSH_KEY_FLAG"

# Check all hosts in log_hosts
for host in {host1} {host2}; do
  echo "=== $host ==="
  ssh $SSH_OPTS {user}@$host 'tail -n 100 {logs_error}'
done
```

### Rules

- READ-ONLY operations only — never modify files, restart services, or run destructive commands
- Never run `rm`, `kill`, `systemctl restart`, or any write operations on remote servers
- If the user asks for a fix on the server, explain what needs to be done and ask them to do it manually
- Always tell the user which host you're checking

## 4. MySQL Database Query

Query via proxy (`$MYSQL_PROXY_URL`), passwords injected by host:

```bash
curl -s -X POST "$MYSQL_PROXY_URL/query" \
  -H "Content-Type: application/json" \
  -d '{"service": "{service-name}", "sql": "SELECT * FROM users LIMIT 10"}' | jq .
```

### Lookup Service Database Config

1. Read services.json to find the `mysql` configuration for the service
2. Get `host`, `port`, `user`, and `database` from the config
3. Use the service name as the `service` field in the API request

### Example Workflow

1. User asks: "Check the user table in catstory database"
2. Look up service "catstory" in services.json
3. Find `mysql.host`, `mysql.database` fields
4. Execute query via proxy:

```bash
curl -s -X POST "$MYSQL_PROXY_URL/query" \
  -H "Content-Type: application/json" \
  -d '{"service": "catstory", "sql": "SELECT * FROM users LIMIT 10"}' | jq .
```

### Rules

- **READ-ONLY only** — only SELECT queries are allowed
- Never execute INSERT, UPDATE, DELETE, DROP, or any write operations
- If the user asks to modify data, explain what needs to be done and ask them to do it manually
- Format results in a readable way for the user
- Limit results with LIMIT clause when appropriate (e.g., LIMIT 100)
