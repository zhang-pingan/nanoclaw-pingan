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
const workflowId = process.env.NANOCLAW_WORKFLOW_ID || '';
const stageKey = process.env.NANOCLAW_STAGE_KEY || '';
const delegationId = process.env.NANOCLAW_DELEGATION_ID || '';

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
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      workflowId: workflowId || undefined,
      stageKey: stageKey || undefined,
      delegationId: delegationId || undefined,
      sourceType: 'send_message',
      sourceRefId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
    caption: z
      .string()
      .optional()
      .describe('可选说明文字，会在文件后以文本消息发送'),
  },
  async (args) => {
    const prefix = '/workspace/group/';
    if (!args.file_path.startsWith(prefix)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `文件路径必须以 ${prefix} 开头。当前路径: ${args.file_path}`,
          },
        ],
        isError: true,
      };
    }

    // Resolve to catch ../ traversal
    const resolved = path.resolve(args.file_path);
    if (!resolved.startsWith(prefix)) {
      return {
        content: [
          { type: 'text' as const, text: '文件路径不合法（检测到路径穿越）。' },
        ],
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

    return {
      content: [{ type: 'text' as const, text: '文件发送请求已提交。' }],
    };
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

SCHEDULE VALUE FORMAT:
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am local time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local timestamp like "2026-03-26 12:05" or "2026-03-26 12:05:00". Interpreted in the container's local timezone.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local time like "2026-03-26 12:05"',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

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
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
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
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
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
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    description: z
      .string()
      .optional()
      .describe(
        'Human-readable description of this group\'s capabilities (e.g., "catstory 项目运维：代码仓库、SSH 日志查看、Jenkins 部署")',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
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
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'ask_user_question',
  `Ask the user one or more questions and wait for responses.

Use this when requirements are ambiguous and you need explicit user choices before proceeding.
Questions are asked sequentially. Each question must provide either:
- options mode: 2-6 options (single or multi-select)
- form mode: 1-8 schema fields (text input form with host-side validation)
Users can answer via interactive cards (when supported) or by replying:
/answer <requestId> <option / free text / JSON / key=value pairs>`,
  {
    questions: z
      .array(
        z.object({
          id: z.string().describe('Unique question id within this tool call'),
          question: z.string().describe('Question text shown to user'),
          options: z
            .array(
              z.object({
                label: z.string().describe('Option label shown to user'),
                description: z
                  .string()
                  .optional()
                  .describe('Optional explanation for the option'),
              }),
            )
            .min(2)
            .max(6)
            .optional(),
          fields: z
            .array(
              z.object({
                id: z.string().describe('Field id used as response key'),
                label: z.string().describe('Field label shown to user'),
                type: z.enum(['string', 'number', 'integer', 'boolean']),
                description: z.string().optional(),
                required: z.boolean().optional(),
                default: z
                  .union([z.string(), z.number(), z.boolean()])
                  .optional(),
                min_length: z.number().optional(),
                max_length: z.number().optional(),
                min: z.number().optional(),
                max: z.number().optional(),
                format: z
                  .enum(['email', 'uri', 'date', 'date-time'])
                  .optional(),
                enum: z
                  .array(
                    z.object({
                      value: z.string(),
                      label: z.string().optional(),
                    }),
                  )
                  .optional(),
              }),
            )
            .min(1)
            .max(8)
            .optional(),
          multi_select: z
            .boolean()
            .optional()
            .describe('Whether multiple options can be selected'),
        }),
      )
      .min(1)
      .max(4),
    timeout_sec: z
      .number()
      .optional()
      .default(1800)
      .describe('Timeout in seconds (30-3600)'),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .describe('Optional tracking metadata'),
  },
  async (args) => {
    const requestId = `aq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutSec = Math.min(
      3600,
      Math.max(30, Math.floor(args.timeout_sec || 1800)),
    );
    const data = {
      type: 'ask_user_question',
      requestId,
      questions: args.questions,
      timeoutSec,
      metadata: args.metadata,
      groupFolder,
      workflowId: workflowId || undefined,
      stageKey: stageKey || undefined,
      delegationId: delegationId || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const resultsDir = path.join(IPC_DIR, 'ask-results');
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const maxWaitMs = timeoutSec * 1000 + 5000;
    const pollMs = 300;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (fs.existsSync(resultPath)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as {
            status?: 'answered' | 'skipped' | 'timeout' | 'rejected';
            answers?: Record<string, unknown>;
            error?: string;
            requestId?: string;
          };
          fs.unlinkSync(resultPath);

          const status = result.status || 'rejected';
          const answers = result.answers || {};
          const summary = JSON.stringify({
            requestId: result.requestId || requestId,
            status,
            answers,
          });

          if (status === 'answered') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `User answered questions: ${summary}`,
                },
              ],
            };
          }

          if (status === 'rejected') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Question flow rejected: ${result.error || 'rejected by host'}. ${summary}`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: `Question flow ended with status=${status}. ${summary}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `ask_user_question result parse failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `ask_user_question timed out waiting for user response (requestId=${requestId}).`,
        },
      ],
      isError: true,
    };
  },
);

server.tool(
  'request_human_input',
  'Create a standard human-input request, send it to the user, and wait for a free-text reply.',
  {
    title: z.string().describe('Short title shown in the workbench'),
    text: z.string().describe('Question or prompt sent to the user'),
    timeout_sec: z
      .number()
      .optional()
      .default(1800)
      .describe('Timeout in seconds (30-3600)'),
  },
  async (args) => {
    const requestId = `aq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeoutSec = Math.min(
      3600,
      Math.max(30, Math.floor(args.timeout_sec || 1800)),
    );
    const data = {
      type: 'ask_user_question',
      requestId,
      questions: [
        {
          id: 'reply',
          question: args.text,
          fields: [
            {
              id: 'reply',
              label: '回复',
              type: 'string' as const,
              required: true,
            },
          ],
        },
      ],
      timeoutSec,
      metadata: {
        title: args.title,
        source_type: 'request_human_input',
      },
      groupFolder,
      workflowId: workflowId || undefined,
      stageKey: stageKey || undefined,
      delegationId: delegationId || undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    const resultsDir = path.join(IPC_DIR, 'ask-results');
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const maxWaitMs = timeoutSec * 1000 + 5000;
    const pollMs = 300;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      if (fs.existsSync(resultPath)) {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as {
          status?: string;
          answers?: Record<string, unknown>;
          error?: string;
        };
        fs.unlinkSync(resultPath);
        if (result.status === 'answered') {
          const value =
            typeof result.answers?.reply === 'string'
              ? result.answers.reply
              : JSON.stringify(result.answers?.reply ?? '');
          return {
            content: [
              { type: 'text' as const, text: `User replied: ${value}` },
            ],
          };
        }
        if (result.status === 'rejected') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `request_human_input rejected: ${result.error || 'rejected'}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `request_human_input ended with status=${result.status || 'unknown'}.`,
            },
          ],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: `request_human_input timed out waiting for user response (requestId=${requestId}).`,
        },
      ],
      isError: true,
    };
  },
);

server.tool(
  'memory_search',
  '混合检索记忆：联合搜索聊天消息与结构化记忆（working/episodic/canonical）。',
  {
    query: z.string().describe('搜索关键词'),
    limit: z.number().optional().default(10).describe('最大返回条数'),
    mode: z
      .enum(['hybrid', 'keyword'])
      .optional()
      .default('hybrid')
      .describe('hybrid=消息+结构化记忆，keyword=仅消息'),
  },
  async (args) => {
    const requestId = `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'memory_search',
      query: args.query,
      limit: args.limit || 10,
      mode: args.mode || 'hybrid',
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
          const hits = Array.isArray(result.hits) ? result.hits : [];
          if (hits.length > 0) {
            parts.push(`## 检索结果（mode=${result.mode || 'hybrid'}）\n`);
            for (const hit of hits) {
              if (hit.kind === 'memory') {
                const memoryId =
                  typeof hit.id === 'string' && hit.id.trim().length > 0
                    ? hit.id
                    : 'unknown-id';
                parts.push(
                  `[MEMORY][${memoryId}][${hit.layer}/${hit.memoryType}] ${hit.content}`,
                );
              } else {
                parts.push(
                  `[MSG][${hit.timestamp}] ${hit.sender}: ${hit.content}`,
                );
              }
            }
          }

          if (parts.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `没有找到与"${args.query}"相关的记录。`,
                },
              ],
            };
          }

          return {
            content: [{ type: 'text' as const, text: parts.join('\n') }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `搜索结果解析失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
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
  'memory_write',
  '写入结构化记忆到当前群组（working/episodic/canonical）。',
  {
    content: z.string().describe('记忆内容'),
    layer: z
      .enum(['working', 'episodic', 'canonical'])
      .default('canonical')
      .describe('记忆层级'),
    memory_type: z
      .enum(['preference', 'rule', 'fact', 'summary'])
      .default('preference')
      .describe('记忆类型'),
  },
  async (args) => {
    const requestId = `memw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'memory_write',
      content: args.content,
      layer: args.layer,
      memory_type: args.memory_type,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

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
          return {
            content: [
              {
                type: 'text' as const,
                text: `记忆已写入：${result?.memory?.id || 'unknown-id'}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `写入结果解析失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      content: [{ type: 'text' as const, text: 'memory_write 请求超时。' }],
      isError: true,
    };
  },
);

server.tool(
  'memory_delete',
  '删除一条结构化记忆。',
  {
    memory_id: z.string().describe('记忆 ID'),
  },
  async (args) => {
    const requestId = `memd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'memory_delete',
      memoryId: args.memory_id,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);
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
          if (!result.deleted) {
            return {
              content: [
                { type: 'text' as const, text: '删除失败或记忆不存在。' },
              ],
              isError: true,
            };
          }
          return {
            content: [
              { type: 'text' as const, text: `记忆已删除：${result.memoryId}` },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `删除记忆失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return {
      content: [{ type: 'text' as const, text: 'memory_delete 请求超时。' }],
      isError: true,
    };
  },
);

server.tool(
  'memory_resolve_conflict',
  `Resolve a conflict between two conflicted memories. Two modes:
- **keep**: Keep one memory as active, deprecate the other. Provide keep_id and deprecate_id.
- **merge**: Deprecate both and create a new merged memory. Provide merge_ids (array of 2 IDs) and merged_content.`,
  {
    mode: z
      .enum(['keep', 'merge'])
      .describe(
        'Resolution mode: "keep" to keep one and deprecate the other, "merge" to combine both into a new memory',
      ),
    keep_id: z
      .string()
      .optional()
      .describe('(keep mode) ID of the memory to keep as active'),
    deprecate_id: z
      .string()
      .optional()
      .describe('(keep mode) ID of the memory to deprecate'),
    merge_ids: z
      .array(z.string())
      .optional()
      .describe('(merge mode) Array of exactly 2 memory IDs to merge'),
    merged_content: z
      .string()
      .optional()
      .describe(
        '(merge mode) The new merged content that replaces both conflicting memories',
      ),
  },
  async (args) => {
    const requestId = `memrc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, unknown> = {
      type: 'memory_resolve_conflict',
      mode: args.mode,
      requestId,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    if (args.mode === 'keep') {
      if (!args.keep_id || !args.deprecate_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'keep 模式需要 keep_id 和 deprecate_id。',
            },
          ],
          isError: true,
        };
      }
      data.keep_id = args.keep_id;
      data.deprecate_id = args.deprecate_id;
    } else {
      if (
        !args.merge_ids ||
        args.merge_ids.length !== 2 ||
        !args.merged_content
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'merge 模式需要 merge_ids（2个ID）和 merged_content。',
            },
          ],
          isError: true,
        };
      }
      data.merge_ids = args.merge_ids;
      data.merged_content = args.merged_content;
    }

    writeIpcFile(TASKS_DIR, data);

    const resultsDir = path.join(IPC_DIR, 'search-results');
    const resultPath = path.join(resultsDir, `${requestId}.json`);
    const maxWaitMs = 10000;
    const pollMs = 300;
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      if (fs.existsSync(resultPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
          fs.unlinkSync(resultPath);
          if (raw.error) {
            return {
              content: [
                { type: 'text' as const, text: `冲突解决失败: ${raw.error}` },
              ],
              isError: true,
            };
          }
          const result = raw.result;
          if (!result) {
            return {
              content: [
                { type: 'text' as const, text: '冲突解决未返回结果。' },
              ],
              isError: true,
            };
          }
          const lines: string[] = ['冲突已解决。'];
          if (args.mode === 'keep') {
            lines.push(
              `保留: ${result.kept.id} — ${result.kept.content.slice(0, 80)}`,
            );
            lines.push(
              `废弃: ${result.deprecated.id} — ${result.deprecated.content.slice(0, 80)}`,
            );
          } else {
            lines.push(
              `新记忆: ${result.merged.id} — ${result.merged.content.slice(0, 80)}`,
            );
            for (const dep of result.deprecated) {
              lines.push(`废弃: ${dep.id} — ${dep.content.slice(0, 80)}`);
            }
          }
          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `冲突解决结果解析失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return {
      content: [
        { type: 'text' as const, text: 'memory_resolve_conflict 请求超时。' },
      ],
      isError: true,
    };
  },
);

server.tool(
  'delegate_task',
  `Delegate a task to another group's agent. Main group only. The target agent processes the task and returns results as a [委派结果] message. Be specific — the target has no context from this conversation.
  Tips:
- Be specific in your task description — the target agent has no context from this conversation
- Include any relevant details (time ranges, error patterns, file paths, etc.)
- Use list_delegations to check status of pending delegations`,
  {
    target_group_jid: z
      .string()
      .describe(
        'JID of the target group to delegate the task to. Find JIDs in available_groups.json or registered_groups table.',
      ),
    task: z
      .string()
      .describe(
        'Detailed description of the task for the target agent. Be specific — the target has no context from this conversation.',
      ),
    requester_jid: z
      .string()
      .optional()
      .describe(
        'JID of the group that originally requested this delegation via request_delegation. When provided, the requester will be auto-notified when the task completes.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can delegate tasks.',
          },
        ],
        isError: true,
      };
    }

    const requestId = `delreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'delegate_task',
      targetGroupJid: args.target_group_jid,
      task: args.task,
      requesterJid: args.requester_jid || '',
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
            content: [
              {
                type: 'text' as const,
                text: `任务已委派。Delegation ID: ${result.delegationId}\n\n目标群 agent 将处理此任务，完成后结果会以消息形式返回。你可以用 list_delegations 查看状态。`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `委派请求已发送但确认解析失败: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: '委派请求已发送，但等待确认超时。请用 list_delegations 检查状态。',
        },
      ],
    };
  },
);

server.tool(
  'request_delegation',
  `Request the main group to delegate a task on your behalf. Non-main groups only. The main group decides where to delegate.
  Use this when you need help from another group's agent but cannot delegate directly.
  If the original user message contains "@{groupfolder}", keep it in task text. The system will parse and forward it to the main group as a target-group hint.
  Do not proactively invent or choose "@{groupfolder}" yourself when the user did not specify it.`,
  {
    task: z
      .string()
      .describe(
        'Detailed description of what you need another group to do. Be specific — include all relevant context.',
      ),
  },
  async (args) => {
    if (isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: '主群请直接使用 delegate_task 工具。',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'request_delegation',
      task: args.task,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: '委派请求已发送给主群，主群将决定是否委派及委派目标。',
        },
      ],
    };
  },
);

server.tool(
  'complete_delegation',
  `Report completion of a delegated task. Call this when you finish processing a task that was delegated to your group.

The result you provide will be sent back to the source group's agent as a message.
Be thorough in your result — include all relevant findings, data, and conclusions.`,
  {
    delegation_id: z.string().describe('委派任务 ID（格式：del-xxx）'),
    outcome: z
      .enum(['success', 'failure'])
      .describe('任务结果：success=成功，failure=失败'),
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
      content: [
        {
          type: 'text' as const,
          text: `委派任务 ${args.delegation_id} 的结果已提交。`,
        },
      ],
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
        return {
          content: [{ type: 'text' as const, text: '没有找到委派任务。' }],
        };
      }

      const data = JSON.parse(fs.readFileSync(delegationsFile, 'utf-8'));
      const delegations = data.delegations;

      if (!delegations || delegations.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '没有找到委派任务。' }],
        };
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

      return {
        content: [
          { type: 'text' as const, text: `委派任务列表:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `读取委派任务失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

// --- Workflow tools (main group only) ---

if (isMain) {
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
                content: [
                  {
                    type: 'text' as const,
                    text: '没有配置任何流程类型（workflows.json 不存在或为空）。',
                  },
                ],
              };
            }

            const formatted = types
              .map(
                (t: {
                  type: string;
                  name: string;
                  entry_points: string[];
                  entry_points_detail: Record<
                    string,
                    { requires_deliverable: boolean; deliverable_role?: string }
                  >;
                  role_channels: Record<string, Record<string, string>>;
                }) => {
                  const epLines = t.entry_points.map((ep) => {
                    const detail = t.entry_points_detail?.[ep];
                    if (detail?.requires_deliverable) {
                      return `${ep} (需指定 deliverable_role=${detail.deliverable_role || 'dev'})`;
                    }
                    return ep;
                  });
                  return `- **${t.type}** (${t.name})\n  入口点: ${epLines.join(', ')}`;
                },
              )
              .join('\n');

            return {
              content: [
                { type: 'text' as const, text: `可用流程类型:\n${formatted}` },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `流程类型列表获取失败: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      return {
        content: [
          { type: 'text' as const, text: '获取流程类型列表超时，请稍后重试。' },
        ],
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
                content: [
                  { type: 'text' as const, text: '当前没有活跃的流程。' },
                ],
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

            const cardSent = result.cardSent
              ? '（已发送流程卡片到群内）\n\n'
              : '';

            const formatted = workflows
              .map(
                (w: {
                  id: string;
                  name: string;
                  service: string;
                  status: string;
                  round: number;
                  work_branch: string;
                  staging_work_branch: string;
                  created_at: string;
                  paused_from?: string;
                }) => {
                  const statusDisplay =
                    w.status === 'paused'
                      ? `⏸ 已中断（原状态：${statusLabels[w.paused_from || ''] || w.paused_from || '未知'}）`
                      : statusLabels[w.status] || w.status;
                  return `- [${w.id}] ${w.name} (${w.service}) — ${statusDisplay}${w.round > 0 ? ` Round ${w.round}` : ''}\n  工作分支: ${w.work_branch || 'N/A'} | 预发工作分支: ${w.staging_work_branch || 'N/A'} | 创建: ${w.created_at}`;
                },
              )
              .join('\n');

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${cardSent}活跃流程:\n${formatted}`,
                },
              ],
            };
          } catch (err) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `流程列表获取失败: ${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      return {
        content: [
          { type: 'text' as const, text: '获取流程列表超时，请稍后重试。' },
        ],
        isError: true,
      };
    },
  );
}

server.tool(
  'reload_tools',
  '重新加载工具。修改了自定义工具源码后调用此工具，会重启容器并恢复当前会话。',
  {},
  async () => {
    writeIpcFile(TASKS_DIR, {
      type: 'reload_container',
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        { type: 'text' as const, text: '工具重载请求已提交，容器即将重启...' },
      ],
    };
  },
);

// Load custom tools from /app/custom-tools/*.js (plugin mechanism)
const CUSTOM_TOOLS_DIR = '/app/custom-tools';
if (fs.existsSync(CUSTOM_TOOLS_DIR)) {
  for (const file of fs
    .readdirSync(CUSTOM_TOOLS_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort()) {
    try {
      const plugin = await import(path.join(CUSTOM_TOOLS_DIR, file));
      if (typeof plugin.register === 'function') {
        plugin.register(server, {
          chatJid,
          groupFolder,
          isMain,
          writeIpcFile,
          MESSAGES_DIR,
          TASKS_DIR,
        });
      }
    } catch (err) {
      // Log but don't crash — bad plugin shouldn't break core tools
      process.stderr.write(`[plugin] Failed to load ${file}: ${err}\n`);
    }
  }
}

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
