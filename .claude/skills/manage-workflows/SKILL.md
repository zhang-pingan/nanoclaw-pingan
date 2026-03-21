---
name: manage-workflows
description: Add, edit, or disable workflow types in workflows.json. Use when user wants to create a new workflow type (e.g., hotfix, release), modify an existing workflow's states/transitions/templates, or disable a workflow type. Triggers on "add workflow", "new workflow", "edit workflow", "modify workflow", "workflow type".
---

# Manage Workflow Types

Interactive skill for managing workflow type definitions in `container/skills/workflows.json`.

## Workflow

### Step 1: Read current state

Read `container/skills/workflows.json` and `container/skills/skills.json` to understand:
- What workflow types exist
- What roles/skills are available
- Which group folders map to which roles

### Step 2: Ask what the user wants

Use AskUserQuestion:
- **New type**: What is this workflow for? What roles are involved? What's the state flow?
- **Edit existing**: Which type? What to change (states, templates, cards, roles)?
- **Disable/delete**: Which type? Warn about running workflows.

### Step 3: Build the config

Construct or modify the workflow type definition following the schema below, then write it to `container/skills/workflows.json`.

### Step 4: Validate

After writing, run `npm run build` to verify compilation (the engine validates config on load).

Remind the user to restart the service for changes to take effect:
```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
systemctl --user restart nanoclaw
```

## Config Schema

Each key in `workflows.json` is a workflow type. Full structure:

```json
{
  "type_name": {
    "name": "Human-readable name",
    "roles": {
      "role_name": { "skill_to_role_key": "skill-name-in-skills-json" }
    },
    "entry_points": {
      "entry_name": {
        "state": "initial_state_name",
        "requires_deliverable": false
      }
    },
    "states": {
      "state_name": { "type": "delegation | confirmation | terminal | system", "..." : "..." }
    },
    "status_labels": {
      "state_name": "emoji + label"
    },
    "cards": {
      "card_key": { "header_template": "...", "body_template": "...", "actions": ["approve", "pause", "cancel"] }
    }
  }
}
```

### State types

**delegation** — Delegate work to a role's group agent. Must define `on_complete` with `success` and `failure` branches.
```json
{
  "type": "delegation",
  "role": "dev",
  "skill": "dev-requirement",
  "plan_mode": true,
  "task_template": "Please do X for {{name}} on {{service}}",
  "on_complete": {
    "success": {
      "target": "next_state",
      "role": "ops",
      "skill": "ops-staging-deploy",
      "task_template": "Deploy {{service}} branch {{branch}}",
      "read_deliverable": true,
      "read_deliverable_role": "dev",
      "increment_round": false,
      "notify": "[Progress] {{name}} ({{id}}) done!",
      "card": "card_key_or_omit"
    },
    "failure": {
      "target": "failed_state",
      "notify": "[Failed] {{name}} ({{id}}) failed"
    }
  }
}
```

**confirmation** — Wait for user to approve/cancel/pause via Feishu card button.
```json
{
  "type": "confirmation",
  "card": "card_key",
  "on_approve": {
    "target": "next_state",
    "role": "ops",
    "skill": "ops-staging-deploy",
    "task_template": "...",
    "notify": "..."
  }
}
```

**terminal** — End state, no transitions. Every type MUST have `"cancelled": { "type": "terminal" }` and `"paused": { "type": "system" }`.
```json
{ "type": "terminal" }
```

**system** — Engine-reserved. Only used for `paused`.
```json
{ "type": "system" }
```

### Template variables

Available in `task_template`, `notify`, card `header_template` and `body_template`:

| Variable | Description |
|----------|-------------|
| `{{name}}` | Workflow name |
| `{{service}}` | Service name |
| `{{branch}}` | Git branch |
| `{{id}}` | Workflow ID |
| `{{round}}` | Current fix round number |
| `{{deliverable}}` | Deliverable filename |
| `{{deliverable_content}}` | Full deliverable file content |
| `{{delegation_result}}` | Raw delegation result text |
| `{{result_summary}}` | Parsed summary from JSON result |
| `{{role_folder:ROLE}}` | Group folder for ROLE (e.g. `{{role_folder:dev}}`) |

### Transition fields

| Field | Type | Description |
|-------|------|-------------|
| `target` | string | **Required.** Target state name. |
| `role` | string | Role to delegate to. If set, must also set `skill` and `task_template`. |
| `skill` | string | Skill name for the delegation. |
| `task_template` | string | Task content template with `{{var}}` placeholders. |
| `plan_mode` | boolean | Write plan_mode marker for the target agent. |
| `read_deliverable` | boolean | Read latest deliverable doc before delegating. |
| `read_deliverable_role` | string | Which role's folder to read from (default: `"dev"`). |
| `increment_round` | boolean | Increment workflow round counter. |
| `notify` | string | Notification template sent to main group. |
| `card` | string | Card key to send after transition. |

### Card config

```json
{
  "card_key": {
    "header_template": "Title with {{name}}",
    "header_color": "blue",
    "body_template": "**Field**: {{value}}\n**Other**: {{other}}",
    "actions": ["approve", "pause", "cancel"]
  }
}
```

Available actions: `approve`, `pause`, `cancel`, `resume`.

### Roles and skills.json

Each role's `skill_to_role_key` must match a skill assigned to a group folder in `skills.json`:

```json
// skills.json
{
  "feishu_dev": ["dev-requirement", "dev-bugfix"],
  "feishu_ops": ["ops-staging-deploy"],
  "feishu_test": ["test-requirement"]
}
```

If a role's skill isn't found in any group, that workflow type is disabled (but other types still work).

## Rules

- Every workflow type MUST include `"cancelled": { "type": "terminal" }` and `"paused": { "type": "system" }` states.
- All `target` values in transitions must reference existing state names.
- All `role` values must reference keys in the type's `roles` map.
- All `card` values must reference keys in the type's `cards` map.
- The engine validates these at startup and logs errors if references are broken.

## Example: Adding a hotfix workflow

User: "Add a hotfix workflow — just fix and deploy, no test cycle"

1. Read `skills.json` to confirm `dev` and `ops` roles are available
2. Add to `workflows.json`:

```json
{
  "hotfix": {
    "name": "热修复流程",
    "roles": {
      "dev": { "skill_to_role_key": "dev-bugfix" },
      "ops": { "skill_to_role_key": "ops-staging-deploy" }
    },
    "entry_points": {
      "fix": { "state": "fixing" }
    },
    "states": {
      "fixing": {
        "type": "delegation",
        "role": "dev",
        "skill": "dev-bugfix",
        "task_template": "紧急修复：{{name}}\n服务：{{service}}",
        "on_complete": {
          "success": {
            "target": "deploying",
            "role": "ops",
            "skill": "ops-staging-deploy",
            "task_template": "部署修复到预发：\n服务：{{service}}\n分支：{{branch}}",
            "read_deliverable": true,
            "read_deliverable_role": "dev",
            "notify": "[热修复] {{name}} ({{id}}) 修复完成，开始部署"
          },
          "failure": {
            "target": "fix_failed",
            "notify": "[热修复] {{name}} ({{id}}) 修复失败"
          }
        }
      },
      "deploying": {
        "type": "delegation",
        "role": "ops",
        "skill": "ops-staging-deploy",
        "on_complete": {
          "success": {
            "target": "done",
            "notify": "[热修复] {{name}} ({{id}}) 部署完成 ✅"
          },
          "failure": {
            "target": "deploy_failed",
            "notify": "[热修复] {{name}} ({{id}}) 部署失败 ❌\n{{result_summary}}"
          }
        }
      },
      "done": { "type": "terminal" },
      "fix_failed": { "type": "terminal" },
      "deploy_failed": { "type": "terminal" },
      "cancelled": { "type": "terminal" },
      "paused": { "type": "system" }
    },
    "status_labels": {
      "fixing": "🔧 修复中",
      "deploying": "🚀 部署中",
      "done": "✅ 完成",
      "fix_failed": "❌ 修复失败",
      "deploy_failed": "❌ 部署失败",
      "cancelled": "🚫 已取消",
      "paused": "⏸ 已中断"
    },
    "cards": {}
  }
}
```

3. `npm run build`
4. Restart service
5. Agent creates via: `create_workflow(name="xxx", service="yyy", start_from="fix", workflow_type="hotfix")`
