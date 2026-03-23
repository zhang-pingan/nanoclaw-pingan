/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'send_file',
  '发送文件或图片到当前群/用户。支持图片（png/jpg/gif等）和文件（pdf/doc/xls等）。文件必须在 /workspace/group/ 目录下。',
  {
    file_path: z.string().describe('文件绝对路径，必须在 /workspace/group/ 下'),
    caption: z.string().optional().describe('可选说明文字，会在文件后以文本消息发送'),
  },
  async (args) => {
    const prefix = '/workspace/group/';
    if (!args.file_path.startsWith(prefix)) {
      return {
        content: [{ type: 'text' as const, text: `文件路径必须以 ${prefix} 开头。当前路径: ${args.file_path}` }],
        isError: true,
      };
    }

    // Resolve to catch ../ traversal
    const resolved = path.resolve(args.file_path);
    if (!resolved.startsWith(prefix)) {
      return {
        content: [{ type: 'text' as const, text: '文件路径不合法（检测到路径穿越）。' }],
        isError: true,
      };
    }

    if (!fs.existsSync(resolved)) {
      return {
        content: [{ type: 'text' as const, text: `文件不存在: ${resolved}` }],
        isError: true,
      };
    }

    const data = {
      type: 'file',
      chatJid,
      filePath: resolved,
      caption: args.caption || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: '文件发送请求已提交。' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    description: z.string().optional().describe('Human-readable description of this group\'s capabilities (e.g., "catstory 项目运维：代码仓库、SSH 日志查看、Jenkins 部署")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data: Record<string, string | undefined> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      description: args.description,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'memory_search',
  '搜索历史对话和消息记录。可以搜索聊天消息和归档的对话记录。',
  {
    query: z.string().describe('搜索关键词'),
    limit: z.number().optional().default(10).describe('最大返回条数'),
  },
  async (args) => {
    const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'memory_search',
      query: args.query,
      limit: args.limit || 10,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for results
    const resultsDir = path.join(IPC_DIR, 'search-results');
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const maxWaitMs = 10000;
    const pollMs = 300;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);

          const parts: string[] = [];

          if (result.messages?.length > 0) {
            parts.push('## 消息记录\n');
            for (const msg of result.messages) {
              parts.push(`[${msg.timestamp}] ${msg.sender}: ${msg.content}`);
            }
          }

          if (result.conversations?.length > 0) {
            parts.push('\n## 对话归档\n');
            for (const conv of result.conversations) {
              parts.push(`### ${conv.file}\n${conv.snippet}\n`);
            }
          }

          if (parts.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `没有找到与"${args.query}"相关的记录。` }],
            };
          }

          return {
            content: [{ type: 'text' as const, text: parts.join('\n') }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `搜索结果解析失败: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      content: [{ type: 'text' as const, text: '搜索超时，请稍后重试。' }],
      isError: true,
    };
  },
);

server.tool(
  'delegate_task',
  `Delegate a task to another group's agent. Main group only.

Use this when a task requires another group's workspace, repos, tools, or context.
The target group's agent will receive the task as a synthetic message and process it.
When the target agent completes the task, the result will be sent back to you as a message.

How it works:
1. You call delegate_task with the target group JID and task description
2. The target group's agent receives the task and works on it
3. When done, the result comes back as a [委派结果] message in your conversation
4. You can then summarize and relay the result to the user

Tips:
- Be specific in your task description — the target agent has no context from this conversation
- Include any relevant details (time ranges, error patterns, file paths, etc.)
- Use list_delegations to check status of pending delegations`,
  {
    target_group_jid: z.string().describe('JID of the target group to delegate the task to. Find JIDs in available_groups.json or registered_groups table.'),
    task: z.string().describe('Detailed description of the task for the target agent. Be specific — the target has no context from this conversation.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can delegate tasks.' }],
        isError: true,
      };
    }

    const requestId = `delreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'delegate_task',
      targetGroupJid: args.target_group_jid,
      task: args.task,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    // Poll for delegation ID response
    const resultsDir = path.join(IPC_DIR, 'delegation-results');
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const maxWaitMs = 10000;
    const pollMs = 300;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);
          return {
            content: [{ type: 'text' as const, text: `任务已委派。Delegation ID: ${result.delegationId}\n\n目标群 agent 将处理此任务，完成后结果会以消息形式返回。你可以用 list_delegations 查看状态。` }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `委派请求已发送但确认解析失败: ${err instanceof Error ? err.message : String(err)}` }],
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      content: [{ type: 'text' as const, text: '委派请求已发送，但等待确认超时。请用 list_delegations 检查状态。' }],
    };
  },
);

server.tool(
  'complete_delegation',
  `Report completion of a delegated task. Call this when you finish processing a task that was delegated to your group.

The result you provide will be sent back to the main group's agent as a message.
Be thorough in your result — include all relevant findings, data, and conclusions.`,
  {
    delegation_id: z.string().describe('委派任务 ID（格式：del-xxx）'),
    outcome: z.enum(['success', 'failure']).describe('任务结果：success=成功，failure=失败'),
    result: z.string().describe('任务结果详情，JSON 格式'),
  },
  async (args) => {
    const data = {
      type: 'complete_delegation',
      delegationId: args.delegation_id,
      outcome: args.outcome,
      result: args.result,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `委派任务 ${args.delegation_id} 的结果已提交。` }],
    };
  },
);

server.tool(
  'list_delegations',
  'List delegation tasks. Main group sees tasks it delegated; other groups see tasks assigned to them.',
  {},
  async () => {
    const delegationsFile = path.join(IPC_DIR, 'current_delegations.json');

    try {
      if (!fs.existsSync(delegationsFile)) {
        return { content: [{ type: 'text' as const, text: '没有找到委派任务。' }] };
      }

      const data = JSON.parse(fs.readFileSync(delegationsFile, 'utf-8'));
      const delegations = data.delegations;

      if (!delegations || delegations.length === 0) {
        return { content: [{ type: 'text' as const, text: '没有找到委派任务。' }] };
      }

      const formatted = delegations
        .map(
          (d: {
            id: string;
            target_name: string;
            task: string;
            status: string;
            result: string | null;
            created_at: string;
          }) => {
            let line = `- [${d.id}] → ${d.target_name}: ${d.task.slice(0, 80)}... (${d.status})`;
            if (d.result) {
              line += `\n  结果: ${d.result.slice(0, 100)}...`;
            }
            return line;
          },
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `委派任务列表:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `读取委派任务失败: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

// --- Workflow tools (main group only) ---

if (isMain) {
  server.tool(
    'create_workflow',
    `创建工作流。先用 list_workflow_types 查看可用的流程类型和入口点，再调用此工具。

流程会自动驱动状态转换，进展消息会发送到群内。`,
    {
      name: z.string().describe('需求名称'),
      service: z.string().describe('服务名称（对应 services.json 中的 key）'),
      workflow_type: z.string().describe("流程类型（如 'dev_test'）。用 list_workflow_types 查看可用类型。"),
      start_from: z.string().describe("入口点名称（如 'dev', 'testing'）。用 list_workflow_types 查看各类型的入口点。"),
    },
    async (args) => {
      const requestId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const data: Record<string, string> = {
        type: 'create_workflow',
        name: args.name,
        service: args.service,
        start_from: args.start_from,
        workflow_type: args.workflow_type,
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      // Poll for result
      const resultsDir = path.join(IPC_DIR, 'workflow-results');
      const resultPath = path.join(resultsDir, `${requestId}.json`);
      const maxWaitMs = 10000;
      const pollMs = 300;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        if (fs.existsSync(resultPath)) {
          try {
            const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
            fs.unlinkSync(resultPath);
            if (result.error) {
              return {
                content: [{ type: 'text' as const, text: `流程创建失败: ${result.error}` }],
                isError: true,
              };
            }
            return {
              content: [{ type: 'text' as const, text: `流程已创建。Workflow ID: ${result.workflowId}\n\n流程将自动推进，进展消息会发送到群内。` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `流程创建结果解析失败: ${err instanceof Error ? err.message : String(err)}` }],
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      return {
        content: [{ type: 'text' as const, text: '流程创建请求已发送，但等待确认超时。' }],
      };
    },
  );

  server.tool(
    'list_workflow_types',
    '查看所有可用的流程类型定义。返回每个类型的名称、入口点和角色映射情况。用于了解可以创建哪些类型的流程。',
    {},
    async () => {
      const requestId = `wf-types-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const data = {
        type: 'list_workflow_types',
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      // Poll for result
      const resultsDir = path.join(IPC_DIR, 'workflow-results');
      const resultPath = path.join(resultsDir, `${requestId}.json`);
      const maxWaitMs = 10000;
      const pollMs = 300;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        if (fs.existsSync(resultPath)) {
          try {
            const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
            fs.unlinkSync(resultPath);

            const types = result.types || [];
            if (types.length === 0) {
              return {
                content: [{ type: 'text' as const, text: '没有配置任何流程类型（workflows.json 不存在或为空）。' }],
              };
            }

            const formatted = types
              .map(
                (t: {
                  type: string;
                  name: string;
                  entry_points: string[];
                  roles: Record<string, string>;
                  roles_resolved: boolean;
                }) => {
                  const status = t.roles_resolved ? '✅ 可用' : '❌ 角色未就绪';
                  const rolesStr = Object.entries(t.roles)
                    .map(([role, folder]) => `${role}→${folder}`)
                    .join(', ');
                  return `- **${t.type}** (${t.name}) ${status}\n  入口点: ${t.entry_points.join(', ')}\n  角色: ${rolesStr || '未解析'}`;
                },
              )
              .join('\n');

            return {
              content: [{ type: 'text' as const, text: `可用流程类型:\n${formatted}` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `流程类型列表获取失败: ${err instanceof Error ? err.message : String(err)}` }],
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      return {
        content: [{ type: 'text' as const, text: '获取流程类型列表超时，请稍后重试。' }],
        isError: true,
      };
    },
  );

  server.tool(
    'list_workflows',
    '查看所有开发测试流程的状态。会在群内发送带操作按钮的卡片，同时返回流程数据。',
    {},
    async () => {
      const requestId = `wf-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const data = {
        type: 'list_workflows',
        requestId,
        groupFolder,
        timestamp: new Date().toISOString(),
      };

      writeIpcFile(TASKS_DIR, data);

      // Poll for result
      const resultsDir = path.join(IPC_DIR, 'workflow-results');
      const resultPath = path.join(resultsDir, `${requestId}.json`);
      const maxWaitMs = 10000;
      const pollMs = 300;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        if (fs.existsSync(resultPath)) {
          try {
            const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
            fs.unlinkSync(resultPath);

            const workflows = result.workflows || [];
            if (workflows.length === 0) {
              return {
                content: [{ type: 'text' as const, text: '当前没有活跃的流程。' }],
              };
            }

            const statusLabels: Record<string, string> = {
              dev: '🔧 开发中',
              awaiting_confirm: '⏳ 待确认',
              ops_deploy: '🚀 部署中',
              testing: '🧪 测试中',
              fixing: '🔨 修复中',
              passed: '✅ 已通过',
              ops_failed: '❌ 部署失败',
              cancelled: '🚫 已取消',
              paused: '⏸ 已中断',
            };

            const cardSent = result.cardSent ? '（已发送流程卡片到群内）\n\n' : '';

            const formatted = workflows
              .map(
                (w: {
                  id: string;
                  name: string;
                  service: string;
                  status: string;
                  round: number;
                  branch: string;
                  created_at: string;
                  paused_from?: string;
                }) => {
                  const statusDisplay = w.status === 'paused'
                    ? `⏸ 已中断（原状态：${statusLabels[w.paused_from || ''] || w.paused_from || '未知'}）`
                    : (statusLabels[w.status] || w.status);
                  return `- [${w.id}] ${w.name} (${w.service}) — ${statusDisplay}${w.round > 0 ? ` Round ${w.round}` : ''}\n  分支: ${w.branch || 'N/A'} | 创建: ${w.created_at}`;
                },
              )
              .join('\n');

            return {
              content: [{ type: 'text' as const, text: `${cardSent}活跃流程:\n${formatted}` }],
            };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `流程列表获取失败: ${err instanceof Error ? err.message : String(err)}` }],
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      return {
        content: [{ type: 'text' as const, text: '获取流程列表超时，请稍后重试。' }],
        isError: true,
      };
    },
  );
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
