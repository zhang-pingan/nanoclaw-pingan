import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('./agent-api.js', () => ({
  callAnthropicMessages: vi.fn(),
}));

import {
  _initTestDatabase,
  createDelegation,
  createTask,
  createTodayPlan,
  createTodayPlanItem,
  getAllTasks,
  getAskQuestion,
  listMemories,
  getMessagesSince,
  getRegisteredAgent,
  getTaskById,
  setRegisteredAgent,
  setMemoryExtractConfig,
  storeChatMetadata,
  storeMessage,
  updateDelegation,
} from './db.js';
import { DATA_DIR } from './config.js';
import { callAnthropicMessages } from './agent-api.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredAgent } from './types.js';
import { handleAskQuestionResponse } from './ask-user-question.js';

// Set up registered agents used across tests
const MAIN_AGENT: RegisteredAgent = {
  name: 'Main',
  folder: 'web_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_AGENT: RegisteredAgent = {
  name: 'Other',
  folder: 'other-agent',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_AGENT: RegisteredAgent = {
  name: 'Third',
  folder: 'third-agent',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let agents: Record<string, RegisteredAgent>;
let deps: IpcDeps;
const callAnthropicMessagesMock = vi.mocked(callAnthropicMessages);

function readMemoryIpcResult(sourceAgent: string, requestId: string): any {
  const p = path.join(
    DATA_DIR,
    'ipc',
    sourceAgent,
    'search-results',
    `${requestId}.json`,
  );
  expect(fs.existsSync(p)).toBe(true);
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  fs.unlinkSync(p);
  return data;
}

function readAskIpcResult(sourceAgent: string, requestId: string): any {
  const p = path.join(
    DATA_DIR,
    'ipc',
    sourceAgent,
    'ask-results',
    `${requestId}.json`,
  );
  expect(fs.existsSync(p)).toBe(true);
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  fs.unlinkSync(p);
  return data;
}

function readDelegationIpcResult(sourceAgent: string, requestId: string): any {
  const p = path.join(
    DATA_DIR,
    'ipc',
    sourceAgent,
    'delegation-results',
    `${requestId}.json`,
  );
  expect(fs.existsSync(p)).toBe(true);
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  fs.unlinkSync(p);
  return data;
}

function readHostScriptIpcResult(sourceAgent: string, requestId: string): any {
  const p = path.join(
    DATA_DIR,
    'ipc',
    sourceAgent,
    'host-script-results',
    `${requestId}.json`,
  );
  expect(fs.existsSync(p)).toBe(true);
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  fs.unlinkSync(p);
  return data;
}

function readDesktopCaptureIpcResult(
  sourceAgent: string,
  requestId: string,
): any {
  const p = path.join(
    DATA_DIR,
    'ipc',
    sourceAgent,
    'desktop-capture-results',
    `${requestId}.json`,
  );
  expect(fs.existsSync(p)).toBe(true);
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  fs.unlinkSync(p);
  return data;
}

function readTodayPlanIpcResult(sourceAgent: string, requestId: string): any {
  const p = path.join(
    DATA_DIR,
    'ipc',
    sourceAgent,
    'today-plan-results',
    `${requestId}.json`,
  );
  expect(fs.existsSync(p)).toBe(true);
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  fs.unlinkSync(p);
  return data;
}

function rid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
  _initTestDatabase();
  callAnthropicMessagesMock.mockReset();

  agents = {
    'web:main': MAIN_AGENT,
    'web:other': OTHER_AGENT,
    'web:third': THIRD_AGENT,
  };

  // Populate DB as well
  setRegisteredAgent('web:main', MAIN_AGENT);
  setRegisteredAgent('web:other', OTHER_AGENT);
  setRegisteredAgent('web:third', THIRD_AGENT);

  deps = {
    sendMessage: async () => {},
    registeredAgents: () => agents,
    registerAgent: (jid, agent) => {
      agents[jid] = agent;
      setRegisteredAgent(jid, agent);
      // Mock the fs.mkdirSync that registerAgent does
    },
    getAvailableAgents: () => [],
    writeAgentsSnapshot: () => {},
    enqueueMessageCheck: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main agent can schedule for another agent', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other agent
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].agent_folder).toBe('other-agent');
  });

  it('non-main agent can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'web:other',
      },
      'other-agent',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].agent_folder).toBe('other-agent');
  });

  it('non-main agent cannot schedule for another agent', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'web:main',
      },
      'other-agent',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });

  it('rejects schedule_task for unregistered target JID', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no target',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'web:unknown',
      },
      'web_main',
      true,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(0);
  });
});

// --- pause_task authorization ---

describe('pause_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-main',
      agent_folder: 'web_main',
      chat_jid: 'web:main',
      prompt: 'main task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
    createTask({
      id: 'task-other',
      agent_folder: 'other-agent',
      chat_jid: 'web:other',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main agent can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'web_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main agent can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-agent',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it("non-main agent cannot pause another Agent's task", async () => {
    const outcome = await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-agent',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
    expect(outcome).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('Unauthorized'),
    });
  });

  it('returns a typed rejection when a task is already paused', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-agent',
      false,
      deps,
    );

    const outcome = await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-agent',
      false,
      deps,
    );

    expect(outcome).toEqual({
      status: 'rejected',
      error: 'Scheduled task task-other is not active',
    });
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      agent_folder: 'other-agent',
      chat_jid: 'web:other',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main agent can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'web_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main agent can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-agent',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it("non-main agent cannot resume another Agent's task", async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-agent',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main agent can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      agent_folder: 'other-agent',
      chat_jid: 'web:other',
      prompt: 'cancel me',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-to-cancel' },
      'web_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main agent can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      agent_folder: 'other-agent',
      chat_jid: 'web:other',
      prompt: 'my task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-own' },
      'other-agent',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it("non-main agent cannot cancel another Agent's task", async () => {
    createTask({
      id: 'task-foreign',
      agent_folder: 'web_main',
      chat_jid: 'web:main',
      prompt: 'not yours',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    await processTaskIpc(
      { type: 'cancel_task', taskId: 'task-foreign' },
      'other-agent',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_agent authorization ---

describe('register_agent authorization', () => {
  it('non-main agent cannot register an Agent', async () => {
    await processTaskIpc(
      {
        type: 'register_agent',
        jid: 'web:new',
        name: 'New Agent',
        folder: 'new-agent',
        trigger: '@Andy',
      },
      'other-agent',
      false,
      deps,
    );

    // registeredAgents should not have changed
    expect(agents['web:new']).toBeUndefined();
  });

  it('main agent cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_agent',
        jid: 'web:new',
        name: 'New Agent',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'web_main',
      true,
      deps,
    );

    expect(agents['web:new']).toBeUndefined();
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetAgent && targetAgent.folder === sourceAgent)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceAgent: string,
    isMain: boolean,
    targetChatJid: string,
    registeredAgents: Record<string, RegisteredAgent>,
  ): boolean {
    const targetAgent = registeredAgents[targetChatJid];
    return isMain || (!!targetAgent && targetAgent.folder === sourceAgent);
  }

  it('main agent can send to any agent', () => {
    expect(isMessageAuthorized('web_main', true, 'web:other', agents)).toBe(
      true,
    );
    expect(isMessageAuthorized('web_main', true, 'web:third', agents)).toBe(
      true,
    );
  });

  it('non-main agent can send to its own chat', () => {
    expect(isMessageAuthorized('other-agent', false, 'web:other', agents)).toBe(
      true,
    );
  });

  it("non-main agent cannot send to another Agent's chat", () => {
    expect(isMessageAuthorized('other-agent', false, 'web:main', agents)).toBe(
      false,
    );
    expect(isMessageAuthorized('other-agent', false, 'web:third', agents)).toBe(
      false,
    );
  });

  it('non-main agent cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-agent', false, 'web:unknown', agents),
    ).toBe(false);
  });

  it('main agent can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(isMessageAuthorized('web_main', true, 'web:unknown', agents)).toBe(
      true,
    );
  });
});

// --- schedule_task with cron and interval types ---

describe('schedule_task schedule types', () => {
  it('creates task with cron schedule and computes next_run', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'cron task',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *', // every day at 9am
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('cron');
    expect(tasks[0].next_run).toBeTruthy();
    // next_run should be a valid ISO date in the future
    expect(new Date(tasks[0].next_run!).getTime()).toBeGreaterThan(
      Date.now() - 60000,
    );
  });

  it('rejects invalid cron expression', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad cron',
        schedule_type: 'cron',
        schedule_value: 'not a cron',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('creates task with interval schedule', async () => {
    const before = Date.now();

    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'interval task',
        schedule_type: 'interval',
        schedule_value: '3600000', // 1 hour
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].schedule_type).toBe('interval');
    // next_run should be ~1 hour from now
    const nextRun = new Date(tasks[0].next_run!).getTime();
    expect(nextRun).toBeGreaterThanOrEqual(before + 3600000 - 1000);
    expect(nextRun).toBeLessThanOrEqual(Date.now() + 3600000 + 1000);
  });

  it('rejects invalid interval (non-numeric)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad interval',
        schedule_type: 'interval',
        schedule_value: 'abc',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid interval (zero)', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'zero interval',
        schedule_type: 'interval',
        schedule_value: '0',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });

  it('rejects invalid once timestamp', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad once',
        schedule_type: 'once',
        schedule_value: 'not-a-date',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=agent', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'agent context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'agent',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('agent');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults invalid context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'bad context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'bogus' as any,
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });

  it('defaults missing context_mode to isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'no context mode',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'web:other',
      },
      'web_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_agent success path ---

describe('register_agent success', () => {
  it('main agent can register a new agent', async () => {
    await processTaskIpc(
      {
        type: 'register_agent',
        jid: 'web:new',
        name: 'New Agent',
        folder: 'new-agent',
        trigger: '@Andy',
      },
      'web_main',
      true,
      deps,
    );

    // Verify agent was registered in DB
    const agent = getRegisteredAgent('web:new');
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('New Agent');
    expect(agent!.folder).toBe('new-agent');
    expect(agent!.trigger).toBe('@Andy');
  });

  it('register_agent rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_agent',
        jid: 'web:partial',
        name: 'Partial',
        // missing folder and trigger
      },
      'web_main',
      true,
      deps,
    );

    expect(getRegisteredAgent('web:partial')).toBeUndefined();
  });
});

describe('ask_user_question', () => {
  it('creates pending ask question and dispatches first prompt via card', async () => {
    const sentCards: Array<{ jid: string; card: unknown }> = [];
    deps.sendCard = async (jid, card) => {
      sentCards.push({ jid, card });
      return 'card-1';
    };

    const requestId = rid('aq');
    await processTaskIpc(
      {
        type: 'ask_user_question',
        requestId,
        questions: [
          {
            id: 'q1',
            question: 'Choose env?',
            options: [{ label: 'prod' }, { label: 'staging' }],
          },
        ],
      },
      'other-agent',
      false,
      deps,
    );

    const rec = getAskQuestion(requestId);
    expect(rec).toBeDefined();
    expect(rec?.status).toBe('pending');
    expect(rec?.agent_folder).toBe('other-agent');
    expect(sentCards.length).toBe(1);
    expect(sentCards[0].jid).toBe('web:other');
    expect(sentCards[0].card).toMatchObject({
      buttons: [{ label: 'prod' }, { label: 'staging' }, { label: '跳过' }],
      form: {
        inputs: [
          {
            name: 'answer',
            type: 'textarea',
          },
        ],
        submitButton: {
          label: '提交自定义答复',
        },
      },
    });
  });

  it('writes rejected ask-result when payload is invalid', async () => {
    const requestId = rid('aq');
    await processTaskIpc(
      {
        type: 'ask_user_question',
        requestId,
        questions: [
          { id: 'q1', question: 'bad', options: [{ label: 'only-one' }] },
        ],
      },
      'other-agent',
      false,
      deps,
    );

    const res = readAskIpcResult('other-agent', requestId);
    expect(res.status).toBe('rejected');
    expect(typeof res.error).toBe('string');
    expect(getAskQuestion(requestId)).toBeUndefined();
  });

  it('supports schema form questions and validates answer types', async () => {
    const requestId = rid('aq');
    await processTaskIpc(
      {
        type: 'ask_user_question',
        requestId,
        questions: [
          {
            id: 'deploy',
            question: '填写部署参数',
            fields: [
              { id: 'env', label: '环境', type: 'string', required: true },
              {
                id: 'replicas',
                label: '副本数',
                type: 'integer',
                min: 1,
                max: 5,
                required: true,
              },
              { id: 'dry_run', label: '仅演练', type: 'boolean' },
            ],
          },
        ],
      },
      'other-agent',
      false,
      deps,
    );

    const invalid = await handleAskQuestionResponse({
      requestId,
      agentFolder: 'other-agent',
      userId: 'user-1',
      answer: '{"env":"prod","replicas":"bad"}',
      registeredAgents: agents,
      sendMessage: deps.sendMessage,
      sendCard: deps.sendCard,
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.completed).toBe(false);

    const valid = await handleAskQuestionResponse({
      requestId,
      agentFolder: 'other-agent',
      userId: 'user-1',
      answer: '{"env":"prod","replicas":3,"dry_run":false}',
      registeredAgents: agents,
      sendMessage: deps.sendMessage,
      sendCard: deps.sendCard,
    });
    expect(valid.ok).toBe(true);
    expect(valid.completed).toBe(true);

    const res = readAskIpcResult('other-agent', requestId);
    expect(res.status).toBe('answered');
    expect(res.answers.deploy.env).toBe('prod');
    expect(res.answers.deploy.replicas).toBe(3);
    expect(res.answers.deploy.dry_run).toBe(false);
  });

  it('accepts custom text for option questions', async () => {
    const requestId = rid('aq');
    await processTaskIpc(
      {
        type: 'ask_user_question',
        requestId,
        questions: [
          {
            id: 'env',
            question: 'Choose env?',
            options: [{ label: 'prod' }, { label: 'staging' }],
          },
        ],
      },
      'other-agent',
      false,
      deps,
    );

    const valid = await handleAskQuestionResponse({
      requestId,
      agentFolder: 'other-agent',
      userId: 'user-1',
      answer: 'canary',
      registeredAgents: agents,
      sendMessage: deps.sendMessage,
      sendCard: deps.sendCard,
    });
    expect(valid.ok).toBe(true);
    expect(valid.completed).toBe(true);

    const res = readAskIpcResult('other-agent', requestId);
    expect(res.status).toBe('answered');
    expect(res.answers.env).toBe('canary');
  });

  it('accepts mixed option and custom text for multi-select questions', async () => {
    const sentCards: Array<{ jid: string; card: unknown }> = [];
    deps.sendCard = async (jid, card) => {
      sentCards.push({ jid, card });
      return 'card-1';
    };

    const requestId = rid('aq');
    await processTaskIpc(
      {
        type: 'ask_user_question',
        requestId,
        questions: [
          {
            id: 'checks',
            question: '选择发布前检查项',
            options: [{ label: '回归' }, { label: '冒烟' }],
            multi_select: true,
          },
        ],
      },
      'other-agent',
      false,
      deps,
    );

    expect(sentCards[0].card).toMatchObject({
      buttons: [{ label: '跳过' }],
      form: {
        inputs: [
          {
            name: 'answer',
            type: 'textarea',
          },
        ],
        submitButton: {
          label: '提交答复',
        },
      },
    });

    const valid = await handleAskQuestionResponse({
      requestId,
      agentFolder: 'other-agent',
      userId: 'user-1',
      answer: '1, 额外巡检',
      registeredAgents: agents,
      sendMessage: deps.sendMessage,
      sendCard: deps.sendCard,
    });
    expect(valid.ok).toBe(true);
    expect(valid.completed).toBe(true);

    const res = readAskIpcResult('other-agent', requestId);
    expect(res.status).toBe('answered');
    expect(res.answers.checks).toEqual(['回归', '额外巡检']);
  });

  it('advances the stored current question after each answer', async () => {
    const requestId = rid('aq');
    await processTaskIpc(
      {
        type: 'ask_user_question',
        requestId,
        questions: [
          {
            id: 'env',
            question: '请选择环境',
            options: [{ label: '测试' }, { label: '预发' }],
          },
          {
            id: 'strategy',
            question: '请选择发布策略',
            options: [{ label: '灰度' }, { label: '全量' }],
          },
        ],
      },
      'other-agent',
      false,
      deps,
    );

    let question = getAskQuestion(requestId);
    expect(question?.current_index).toBe(0);
    expect(
      JSON.parse(question?.payload_json || '{}').questions[0],
    ).toMatchObject({
      id: 'env',
      options: [{ label: '测试' }, { label: '预发' }],
    });

    const answered = await handleAskQuestionResponse({
      requestId,
      agentFolder: 'other-agent',
      userId: 'user-1',
      answer: '测试',
      registeredAgents: agents,
      sendMessage: deps.sendMessage,
      sendCard: deps.sendCard,
    });
    expect(answered.ok).toBe(true);
    expect(answered.completed).toBe(false);

    question = getAskQuestion(requestId);
    expect(question?.current_index).toBe(1);
    expect(
      JSON.parse(question?.payload_json || '{}').questions[1],
    ).toMatchObject({
      id: 'strategy',
      options: [{ label: '灰度' }, { label: '全量' }],
    });
  });
});

describe('memory IPC tasks', () => {
  it('memory_write round-trip works', async () => {
    const sourceAgent = 'other-agent';
    const writeId = rid('mw');

    await processTaskIpc(
      {
        type: 'memory_write',
        requestId: writeId,
        content: 'Always reply in Chinese',
        layer: 'canonical',
        memory_type: 'preference',
      },
      sourceAgent,
      false,
      deps,
    );
    const writeRes = readMemoryIpcResult(sourceAgent, writeId);
    expect(writeRes.memory?.id).toBeTruthy();
  });

  it('memory_delete removes memory in same agent', async () => {
    const sourceAgent = 'other-agent';
    const writeId = rid('mw');
    const deleteId = rid('md');

    await processTaskIpc(
      {
        type: 'memory_write',
        requestId: writeId,
        content: 'Delete me',
        layer: 'working',
        memory_type: 'summary',
      },
      sourceAgent,
      false,
      deps,
    );
    const writeRes = readMemoryIpcResult(sourceAgent, writeId);
    const memoryId = writeRes.memory?.id as string;
    expect(memoryId).toBeTruthy();

    await processTaskIpc(
      {
        type: 'memory_delete',
        requestId: deleteId,
        memoryId,
      },
      sourceAgent,
      false,
      deps,
    );
    const deleteRes = readMemoryIpcResult(sourceAgent, deleteId);
    expect(deleteRes.deleted).toBe(true);
    expect(deleteRes.memoryId).toBe(memoryId);

    const remains = listMemories(sourceAgent, 50).filter(
      (m) => m.id === memoryId,
    );
    expect(remains.length).toBe(0);
  });

  it('memory_search returns hybrid hits', async () => {
    const sourceAgent = 'other-agent';
    const writeId = rid('mw');
    const searchId = rid('ms');

    await processTaskIpc(
      {
        type: 'memory_write',
        requestId: writeId,
        content: 'Service foo uses branch main',
        layer: 'canonical',
        memory_type: 'fact',
      },
      sourceAgent,
      false,
      deps,
    );
    const writeRes = readMemoryIpcResult(sourceAgent, writeId);
    const memoryId = writeRes.memory?.id as string;

    // seed one message hit as well
    storeChatMetadata('web:other', Date.now().toString());
    storeMessage({
      id: 'm-foo',
      chat_jid: 'web:other',
      sender: 'user:u',
      sender_name: 'User',
      content: 'foo release is pending',
      timestamp: Date.now().toString(),
    });

    await processTaskIpc(
      {
        type: 'memory_search',
        requestId: searchId,
        query: 'foo',
        mode: 'hybrid',
        limit: 10,
      },
      sourceAgent,
      false,
      deps,
    );
    const searchRes = readMemoryIpcResult(sourceAgent, searchId);
    expect(searchRes.mode).toBe('hybrid');
    expect(Array.isArray(searchRes.hits)).toBe(true);
    expect(searchRes.hits.length).toBeGreaterThan(0);
    expect(
      searchRes.hits.some(
        (h: { kind: string; id?: string; content: string }) =>
          h.kind === 'memory' &&
          h.id === memoryId &&
          h.content.includes('branch main'),
      ),
    ).toBe(true);
  });

  it('memory_search keyword mode excludes structured memory hits', async () => {
    const sourceAgent = 'other-agent';
    const writeId = rid('mw');
    const searchId = rid('ms');

    await processTaskIpc(
      {
        type: 'memory_write',
        requestId: writeId,
        content: 'Keyword-only should not include this memory hit',
        layer: 'canonical',
        memory_type: 'fact',
      },
      sourceAgent,
      false,
      deps,
    );
    readMemoryIpcResult(sourceAgent, writeId);

    storeChatMetadata('web:other', Date.now().toString());
    storeMessage({
      id: `m-keyword-${Date.now()}`,
      chat_jid: 'web:other',
      sender: 'user:u',
      sender_name: 'User',
      content: 'keyword-only message hit',
      timestamp: Date.now().toString(),
    });

    await processTaskIpc(
      {
        type: 'memory_search',
        requestId: searchId,
        query: 'keyword',
        mode: 'keyword',
        limit: 10,
      },
      sourceAgent,
      false,
      deps,
    );
    const res = readMemoryIpcResult(sourceAgent, searchId);
    expect(res.mode).toBe('keyword');
    expect(res.hits.some((h: { kind: string }) => h.kind === 'memory')).toBe(
      false,
    );
    expect(res.hits.some((h: { kind: string }) => h.kind === 'message')).toBe(
      true,
    );
  });

  it('memory_search uses shared synonym expansion for structured memories', async () => {
    const sourceAgent = 'other-agent';
    const writeId = rid('mw');
    const searchId = rid('ms');

    await processTaskIpc(
      {
        type: 'memory_write',
        requestId: writeId,
        content: 'Payment service deploy checklist is required',
        layer: 'canonical',
        memory_type: 'rule',
      },
      sourceAgent,
      false,
      deps,
    );
    readMemoryIpcResult(sourceAgent, writeId);

    await processTaskIpc(
      {
        type: 'memory_search',
        requestId: searchId,
        query: 'payment release',
        mode: 'hybrid',
        limit: 10,
      },
      sourceAgent,
      false,
      deps,
    );
    const res = readMemoryIpcResult(sourceAgent, searchId);
    expect(
      res.hits.some(
        (h: { kind: string; content: string }) =>
          h.kind === 'memory' && h.content.includes('deploy checklist'),
      ),
    ).toBe(true);
  });

  it('memory_search uses Chinese n-gram fallback for structured memories', async () => {
    const sourceAgent = 'other-agent';
    const writeId = rid('mw');
    const searchId = rid('ms');

    await processTaskIpc(
      {
        type: 'memory_write',
        requestId: writeId,
        content: '支付服务上线前先检查回滚预案',
        layer: 'canonical',
        memory_type: 'rule',
      },
      sourceAgent,
      false,
      deps,
    );
    readMemoryIpcResult(sourceAgent, writeId);

    await processTaskIpc(
      {
        type: 'memory_search',
        requestId: searchId,
        query: '请帮我整理支付服务上线计划',
        mode: 'hybrid',
        limit: 10,
      },
      sourceAgent,
      false,
      deps,
    );
    const res = readMemoryIpcResult(sourceAgent, searchId);
    expect(
      res.hits.some(
        (h: { kind: string; content: string }) =>
          h.kind === 'memory' &&
          h.content.includes('支付服务上线前先检查回滚预案'),
      ),
    ).toBe(true);
  });

  it('memory_gc with dryRun=false deletes duplicates', async () => {
    const sourceAgent = 'other-agent';
    const write1 = rid('mw');
    const write2 = rid('mw');
    const gcId = rid('mgc');

    for (const requestId of [write1, write2]) {
      await processTaskIpc(
        {
          type: 'memory_write',
          requestId,
          content: 'Duplicate value for gc',
          layer: 'canonical',
          memory_type: 'fact',
        },
        sourceAgent,
        false,
        deps,
      );
      readMemoryIpcResult(sourceAgent, requestId);
    }

    await processTaskIpc(
      {
        type: 'memory_gc',
        requestId: gcId,
        dryRun: false,
        staleDays: 365,
      },
      sourceAgent,
      false,
      deps,
    );
    const gcRes = readMemoryIpcResult(sourceAgent, gcId);
    expect(gcRes.result.dryRun).toBe(false);
    expect(gcRes.result.duplicateDeletedIds.length).toBeGreaterThan(0);

    const remain = listMemories(sourceAgent, 50).filter(
      (m: { content: string }) => m.content === 'Duplicate value for gc',
    );
    expect(remain.length).toBe(1);
  });

  it('memory_extract_from_archive writes candidates and runs cleanup pipeline', async () => {
    const sourceAgent = 'other-agent';
    const conversationsDir = path.join(
      process.cwd(),
      'agents',
      sourceAgent,
      'conversations',
    );
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveFile = `2026-04-01-${Date.now()}-archive.md`;
    const archivePath = path.join(conversationsDir, archiveFile);
    fs.writeFileSync(
      archivePath,
      [
        '---',
        'session: sess-1',
        'round: 2',
        'hash: abc123',
        'source: exit',
        'created_at: 2026-04-01T00:00:00.000Z',
        '---',
        '',
        '# Conversation',
        '',
        '**User**: 请记住：以后都用中文回答我',
        '',
        '**Andy**: 好的，我会使用中文回答。',
        '',
        '**User**: 帮我总结今天进展',
      ].join('\n'),
      'utf-8',
    );
    callAnthropicMessagesMock.mockResolvedValue({
      model: 'claude-test',
      raw: {},
      text: JSON.stringify({
        memories: [
          {
            layer: 'canonical',
            memory_type: 'preference',
            content: '用户偏好使用中文交流',
            reason: '用户明确要求以后都用中文回答',
            confidence: 0.93,
            source_indexes: [0],
          },
          {
            layer: 'working',
            memory_type: 'summary',
            content: '当前任务是总结今天进展',
            reason: '用户要求总结今天进展',
            confidence: 0.78,
            source_indexes: [2],
          },
        ],
      }),
    });

    try {
      await processTaskIpc(
        {
          type: 'memory_extract_from_archive',
          archiveFile,
          archiveHash: 'abc123',
          round: 2,
        },
        sourceAgent,
        false,
        deps,
      );
    } finally {
      fs.unlinkSync(archivePath);
    }

    const memories = listMemories(sourceAgent, 50);
    const archiveMemories = memories.filter((m) => m.source === 'archive');
    expect(archiveMemories.length).toBeGreaterThan(0);
    expect(
      archiveMemories.some(
        (m) => m.layer === 'canonical' && m.content === '用户偏好使用中文交流',
      ),
    ).toBe(true);
    expect(
      archiveMemories.some(
        (m) =>
          m.layer === 'working' &&
          m.memory_type === 'summary' &&
          m.content === '当前任务是总结今天进展',
      ),
    ).toBe(true);
    expect(
      archiveMemories.every(
        (m) =>
          typeof m.metadata === 'string' && m.metadata.includes(archiveFile),
      ),
    ).toBe(true);
    expect(
      archiveMemories.every(
        (m) =>
          typeof m.metadata === 'string' &&
          m.metadata.includes('"extraction_mode":"agent_api"'),
      ),
    ).toBe(true);
  });

  it('memory_extract_from_archive includes multi-line message details in the extraction payload', async () => {
    const sourceAgent = 'other-agent';
    const conversationsDir = path.join(
      process.cwd(),
      'agents',
      sourceAgent,
      'conversations',
    );
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveFile = `2026-04-01-${Date.now()}-multiline.md`;
    const archivePath = path.join(conversationsDir, archiveFile);
    fs.writeFileSync(
      archivePath,
      [
        '**Andy**: 已完成委派开发并回传结果。',
        '',
        '本次实际交付：',
        '• 分支：pre_manhua',
        '• 提交：2c5ef9a',
        '• 交付文档：/workspace/projects/catstory/iteration/demo/dev.md',
      ].join('\n'),
      'utf-8',
    );
    callAnthropicMessagesMock.mockResolvedValue({
      model: 'claude-test',
      raw: {},
      text: JSON.stringify({ memories: [] }),
    });

    try {
      await processTaskIpc(
        {
          type: 'memory_extract_from_archive',
          archiveFile,
          archiveHash: 'multi-line',
          round: 1,
        },
        sourceAgent,
        false,
        deps,
      );
    } finally {
      fs.unlinkSync(archivePath);
    }

    expect(callAnthropicMessagesMock).toHaveBeenCalledTimes(1);
    const requestPayload = callAnthropicMessagesMock.mock.calls[0]?.[0] as
      | { messages?: Array<{ content?: string }> }
      | undefined;
    const serialized = requestPayload?.messages?.[0]?.content || '';
    expect(serialized).toContain('分支：pre_manhua');
    expect(serialized).toContain('提交：2c5ef9a');
    expect(serialized).toContain(
      '交付文档：/workspace/projects/catstory/iteration/demo/dev.md',
    );
  });

  it('memory_extract_from_archive rejects generic completion boilerplate memories', async () => {
    const sourceAgent = 'other-agent';
    const conversationsDir = path.join(
      process.cwd(),
      'agents',
      sourceAgent,
      'conversations',
    );
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveFile = `2026-04-01-${Date.now()}-boilerplate.md`;
    const archivePath = path.join(conversationsDir, archiveFile);
    fs.writeFileSync(
      archivePath,
      ['**Andy**: 已完成一次委派测试并回传结果。'].join('\n'),
      'utf-8',
    );
    callAnthropicMessagesMock.mockResolvedValue({
      model: 'claude-test',
      raw: {},
      text: JSON.stringify({
        memories: [
          {
            layer: 'episodic',
            memory_type: 'summary',
            content: '已完成一次委派测试并回传结果。',
            reason: '消息明确说明一项任务已经完成并给出了结果回传。',
            confidence: 0.97,
            source_indexes: [0],
          },
        ],
      }),
    });

    try {
      await processTaskIpc(
        {
          type: 'memory_extract_from_archive',
          archiveFile,
          archiveHash: 'boilerplate',
          round: 1,
        },
        sourceAgent,
        false,
        deps,
      );
    } finally {
      fs.unlinkSync(archivePath);
    }

    const archiveMemories = listMemories(sourceAgent, 50).filter(
      (m) =>
        m.source === 'archive' &&
        typeof m.metadata === 'string' &&
        m.metadata.includes(archiveFile),
    );
    expect(archiveMemories).toHaveLength(0);
  });

  it('memory_extract_from_archive keeps concrete episodic outcomes with actionable detail', async () => {
    const sourceAgent = 'other-agent';
    const conversationsDir = path.join(
      process.cwd(),
      'agents',
      sourceAgent,
      'conversations',
    );
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveFile = `2026-04-01-${Date.now()}-concrete-outcome.md`;
    const archivePath = path.join(conversationsDir, archiveFile);
    fs.writeFileSync(
      archivePath,
      [
        '**Andy**: 已按委派要求执行并回传结果。',
        '',
        '排查结果：',
        '• catstory 预发部署成功',
        '• Jenkins Build #63 结果为 SUCCESS',
        '• 主 Agent 已收到阶段性汇报',
      ].join('\n'),
      'utf-8',
    );
    callAnthropicMessagesMock.mockResolvedValue({
      model: 'claude-test',
      raw: {},
      text: JSON.stringify({
        memories: [
          {
            layer: 'episodic',
            memory_type: 'summary',
            content:
              'catstory 预发部署成功，Jenkins Build #63 结果为 SUCCESS。',
            reason: '消息明确给出了具体服务、部署结果和构建编号。',
            confidence: 0.91,
            source_indexes: [0],
          },
        ],
      }),
    });

    try {
      await processTaskIpc(
        {
          type: 'memory_extract_from_archive',
          archiveFile,
          archiveHash: 'concrete-outcome',
          round: 1,
        },
        sourceAgent,
        false,
        deps,
      );
    } finally {
      fs.unlinkSync(archivePath);
    }

    const archiveMemories = listMemories(sourceAgent, 50).filter(
      (m) =>
        m.source === 'archive' &&
        typeof m.metadata === 'string' &&
        m.metadata.includes(archiveFile),
    );
    expect(
      archiveMemories.some(
        (m) =>
          m.layer === 'episodic' &&
          m.memory_type === 'summary' &&
          m.content ===
            'catstory 预发部署成功，Jenkins Build #63 结果为 SUCCESS。',
      ),
    ).toBe(true);
  });

  it('memory_extract_from_archive ignores internal context fragments', async () => {
    const sourceAgent = 'other-agent';
    const conversationsDir = path.join(
      process.cwd(),
      'agents',
      sourceAgent,
      'conversations',
    );
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveFile = `2026-04-01-${Date.now()}-internal.md`;
    const archivePath = path.join(conversationsDir, archiveFile);
    fs.writeFileSync(
      archivePath,
      [
        '---',
        'session: sess-2',
        'round: 3',
        'hash: def456',
        'source: exit',
        'created_at: 2026-04-01T00:00:00.000Z',
        '---',
        '',
        '# Conversation',
        '',
        '**User**: Base directory for this skill: /home/node/.claude/skills/dev-examine',
        '',
        '**User**: <context timezone="Asia/Shanghai" />',
        '',
        '**User**: [MEMORY PACK]',
      ].join('\n'),
      'utf-8',
    );
    callAnthropicMessagesMock.mockResolvedValue({
      model: 'claude-test',
      raw: {},
      text: JSON.stringify({
        memories: [
          {
            layer: 'working',
            memory_type: 'summary',
            content: '[MEMORY PACK]',
            reason: '模型误提取内部包装内容',
            confidence: 0.8,
            source_indexes: [0],
          },
        ],
      }),
    });

    try {
      await processTaskIpc(
        {
          type: 'memory_extract_from_archive',
          archiveFile,
          archiveHash: 'def456',
          round: 3,
        },
        sourceAgent,
        false,
        deps,
      );
    } finally {
      fs.unlinkSync(archivePath);
    }

    const archiveMemories = listMemories(sourceAgent, 50).filter(
      (m) =>
        m.source === 'archive' &&
        typeof m.metadata === 'string' &&
        m.metadata.includes(archiveFile),
    );
    expect(archiveMemories).toHaveLength(0);
  });

  it('memory_extract_from_archive respects configurable thresholds from config table', async () => {
    const sourceAgent = 'other-agent';
    setMemoryExtractConfig(sourceAgent, 'canonical_max', 1);
    setMemoryExtractConfig(sourceAgent, 'working_max', 1);
    setMemoryExtractConfig(sourceAgent, 'canonical_min_confidence', 0.95);

    const conversationsDir = path.join(
      process.cwd(),
      'agents',
      sourceAgent,
      'conversations',
    );
    fs.mkdirSync(conversationsDir, { recursive: true });
    const archiveFile = `2026-04-01-${Date.now()}-thresholds.md`;
    const archivePath = path.join(conversationsDir, archiveFile);
    fs.writeFileSync(
      archivePath,
      [
        '**User**: 请记住：以后都用中文回答我',
        '',
        '**User**: 请记住：以后输出要简洁',
        '',
        '**User**: 帮我总结今天进展',
      ].join('\n'),
      'utf-8',
    );
    callAnthropicMessagesMock.mockResolvedValue({
      model: 'claude-test',
      raw: {},
      text: JSON.stringify({
        memories: [
          {
            layer: 'canonical',
            memory_type: 'preference',
            content: '用户偏好使用中文交流',
            reason: '用户明确要求用中文',
            confidence: 0.91,
            source_indexes: [0],
          },
          {
            layer: 'canonical',
            memory_type: 'preference',
            content: '用户偏好输出简洁',
            reason: '用户明确要求输出简洁',
            confidence: 0.9,
            source_indexes: [1],
          },
          {
            layer: 'working',
            memory_type: 'summary',
            content: '当前任务是总结今天进展',
            reason: '用户要求总结今天进展',
            confidence: 0.74,
            source_indexes: [2],
          },
        ],
      }),
    });

    try {
      await processTaskIpc(
        {
          type: 'memory_extract_from_archive',
          archiveFile,
          archiveHash: 'cfg-thresholds',
          round: 3,
        },
        sourceAgent,
        false,
        deps,
      );
    } finally {
      fs.unlinkSync(archivePath);
    }

    const memories = listMemories(sourceAgent, 50).filter(
      (m) => m.source === 'archive' && m.metadata?.includes(archiveFile),
    );
    const canonicalCount = memories.filter(
      (m) => m.layer === 'canonical',
    ).length;
    const workingCount = memories.filter((m) => m.layer === 'working').length;
    expect(canonicalCount).toBe(0);
    expect(workingCount).toBeLessThanOrEqual(1);
  });

  it('memory_doctor/gc produce response payloads', async () => {
    const sourceAgent = 'other-agent';
    // duplicates
    for (let i = 0; i < 2; i++) {
      const writeId = rid('mw-dup');
      await processTaskIpc(
        {
          type: 'memory_write',
          requestId: writeId,
          content: 'Always include summary',
          layer: 'canonical',
          memory_type: 'rule',
        },
        sourceAgent,
        false,
        deps,
      );
      readMemoryIpcResult(sourceAgent, writeId);
    }

    const doctorId = rid('mdo');
    await processTaskIpc(
      { type: 'memory_doctor', requestId: doctorId, staleDays: 7 },
      sourceAgent,
      false,
      deps,
    );
    const doctorRes = readMemoryIpcResult(sourceAgent, doctorId);
    expect(doctorRes.report).toBeTruthy();
    expect(doctorRes.report.total).toBeGreaterThan(0);

    const gcId = rid('mgc');
    await processTaskIpc(
      { type: 'memory_gc', requestId: gcId, dryRun: true, staleDays: 14 },
      sourceAgent,
      false,
      deps,
    );
    const gcRes = readMemoryIpcResult(sourceAgent, gcId);
    expect(gcRes.result).toBeTruthy();
    expect(gcRes.result.dryRun).toBe(true);
  });

  it('handles concurrent memory writes without result file collisions', async () => {
    const sourceAgent = 'other-agent';
    const tasks = Array.from({ length: 12 }).map((_, i) => {
      const requestId = rid('mw-concurrent');
      return {
        requestId,
        promise: processTaskIpc(
          {
            type: 'memory_write',
            requestId,
            content: `Concurrent memory value ${i}`,
            layer: i % 2 === 0 ? 'canonical' : 'working',
            memory_type: 'fact',
          },
          sourceAgent,
          false,
          deps,
        ),
      };
    });

    await Promise.all(tasks.map((t) => t.promise));

    const ids = tasks
      .map((t) => readMemoryIpcResult(sourceAgent, t.requestId)?.memory?.id)
      .filter(Boolean);
    expect(ids.length).toBe(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('handles concurrent memory searches and returns per-request results', async () => {
    const sourceAgent = 'other-agent';

    const writeIds = Array.from({ length: 6 }).map(() => rid('mw-base'));
    for (let i = 0; i < writeIds.length; i++) {
      await processTaskIpc(
        {
          type: 'memory_write',
          requestId: writeIds[i],
          content: `Search baseline memory ${i}`,
          layer: 'canonical',
          memory_type: 'summary',
        },
        sourceAgent,
        false,
        deps,
      );
      readMemoryIpcResult(sourceAgent, writeIds[i]);
    }

    const searchTasks = Array.from({ length: 8 }).map(() => {
      const requestId = rid('ms-concurrent');
      return {
        requestId,
        promise: processTaskIpc(
          {
            type: 'memory_search',
            requestId,
            query: 'baseline',
            mode: 'hybrid',
            limit: 5,
          },
          sourceAgent,
          false,
          deps,
        ),
      };
    });

    await Promise.all(searchTasks.map((t) => t.promise));

    for (const t of searchTasks) {
      const res = readMemoryIpcResult(sourceAgent, t.requestId);
      expect(Array.isArray(res.hits)).toBe(true);
      expect(res.hits.length).toBeGreaterThan(0);
    }
  });
});

// --- complete_delegation requester auto-copy ---

describe('complete_delegation requester auto-copy', () => {
  it('auto-sends a copy to requester_jid when requester differs from source', async () => {
    const enqueued: string[] = [];
    deps.enqueueMessageCheck = (agentJid) => {
      enqueued.push(agentJid);
    };

    createDelegation({
      id: 'del-auto-copy',
      source_jid: 'web:main',
      source_folder: 'web_main',
      target_jid: 'web:third',
      target_folder: 'third-agent',
      task: 'run diagnostics',
      status: 'pending',
      result: null,
      outcome: null,
      requester_jid: 'web:other',
      created_at: Date.now().toString(),
      updated_at: Date.now().toString(),
    });
    storeChatMetadata('web:main', Date.now().toString());
    storeChatMetadata('web:other', Date.now().toString());

    await processTaskIpc(
      {
        type: 'complete_delegation',
        delegationId: 'del-auto-copy',
        outcome: 'success',
        result: '诊断完成：未发现异常',
      },
      'third-agent',
      false,
      deps,
    );

    const sourceMsgs = getMessagesSince('web:main', '0', 'Andy');
    const requesterMsgs = getMessagesSince('web:other', '0', 'Andy');
    expect(sourceMsgs).toHaveLength(1);
    expect(requesterMsgs).toHaveLength(1);
    expect(sourceMsgs[0].content).toContain(
      '[委派结果 | 来自:Third | ID:del-auto-copy]',
    );
    expect(requesterMsgs[0].content).toContain(
      '[委派结果抄送 | 来自:Third | ID:del-auto-copy]',
    );
    expect(sourceMsgs[0].content).not.toContain('请将此结果转发给请求方');
    expect(enqueued.sort()).toEqual(['web:main', 'web:other'].sort());
  });

  it('does not duplicate delivery when requester_jid equals source_jid', async () => {
    const enqueued: string[] = [];
    deps.enqueueMessageCheck = (agentJid) => {
      enqueued.push(agentJid);
    };

    createDelegation({
      id: 'del-no-dup',
      source_jid: 'web:main',
      source_folder: 'web_main',
      target_jid: 'web:third',
      target_folder: 'third-agent',
      task: 'run diagnostics',
      status: 'pending',
      result: null,
      outcome: null,
      requester_jid: 'web:main',
      created_at: Date.now().toString(),
      updated_at: Date.now().toString(),
    });
    storeChatMetadata('web:main', Date.now().toString());

    await processTaskIpc(
      {
        type: 'complete_delegation',
        delegationId: 'del-no-dup',
        outcome: 'success',
        result: '完成',
      },
      'third-agent',
      false,
      deps,
    );

    const sourceMsgs = getMessagesSince('web:main', '0', 'Andy');
    expect(sourceMsgs).toHaveLength(1);
    expect(sourceMsgs[0].content).toContain(
      '[委派结果 | 来自:Third | ID:del-no-dup]',
    );
    expect(enqueued).toEqual(['web:main']);
  });
});

// --- list_delegations db query ---

describe('list_delegations', () => {
  it('main agent lists delegations it sourced from the database', async () => {
    createDelegation({
      id: 'del-main-visible',
      source_jid: 'web:main',
      source_folder: 'web_main',
      target_jid: 'web:other',
      target_folder: 'other-agent',
      task: 'visible to main',
      status: 'pending',
      result: null,
      outcome: null,
      created_at: '100',
      updated_at: '100',
    });
    createDelegation({
      id: 'del-main-hidden',
      source_jid: 'web:other',
      source_folder: 'other-agent',
      target_jid: 'web:third',
      target_folder: 'third-agent',
      task: 'hidden from main',
      status: 'pending',
      result: null,
      outcome: null,
      created_at: '101',
      updated_at: '101',
    });

    await processTaskIpc(
      {
        type: 'list_delegations',
        requestId: 'list-main',
      },
      'web_main',
      true,
      deps,
    );

    const result = readDelegationIpcResult('web_main', 'list-main');
    expect(result.status).toBe('success');
    expect(result.delegations.map((d: any) => d.id)).toEqual([
      'del-main-visible',
    ]);
    expect(result.delegations[0].target_name).toBe('Other');
  });

  it('non-main agent lists delegations assigned to it from the database', async () => {
    createDelegation({
      id: 'del-target-visible',
      source_jid: 'web:main',
      source_folder: 'web_main',
      target_jid: 'web:other',
      target_folder: 'other-agent',
      task: 'visible to target',
      status: 'completed',
      result: 'done',
      outcome: 'success',
      created_at: '100',
      updated_at: '101',
    });
    updateDelegation('del-target-visible', {
      outcome: 'success',
    });
    createDelegation({
      id: 'del-target-hidden',
      source_jid: 'web:main',
      source_folder: 'web_main',
      target_jid: 'web:third',
      target_folder: 'third-agent',
      task: 'hidden from target',
      status: 'pending',
      result: null,
      outcome: null,
      created_at: '102',
      updated_at: '102',
    });

    await processTaskIpc(
      {
        type: 'list_delegations',
        requestId: 'list-target',
      },
      'other-agent',
      false,
      deps,
    );

    const result = readDelegationIpcResult('other-agent', 'list-target');
    expect(result.status).toBe('success');
    expect(result.delegations.map((d: any) => d.id)).toEqual([
      'del-target-visible',
    ]);
    expect(result.delegations[0]).toMatchObject({
      source_folder: 'web_main',
      target_name: 'Other',
      result: 'done',
      outcome: 'success',
    });
  });
});

describe('delegate_task IPC result', () => {
  it('returns an error result when the target agent is not registered', async () => {
    await processTaskIpc(
      {
        type: 'delegate_task',
        requestId: 'del-missing-target',
        targetAgentJid: 'web:missing',
        task: 'do work',
      },
      'web_main',
      true,
      deps,
    );

    const result = readDelegationIpcResult('web_main', 'del-missing-target');
    expect(result).toMatchObject({
      status: 'error',
      error: 'Target agent is not registered: web:missing',
    });
  });

  it('returns an error result when a non-main agent delegates directly', async () => {
    await processTaskIpc(
      {
        type: 'delegate_task',
        requestId: 'del-non-main',
        targetAgentJid: 'web:third',
        task: 'do work',
      },
      'other-agent',
      false,
      deps,
    );

    const result = readDelegationIpcResult('other-agent', 'del-non-main');
    expect(result).toMatchObject({
      status: 'error',
      error: 'Only main agent can delegate tasks',
    });
  });

  it('returns an error result when cross-channel delegation is blocked', async () => {
    const targetJid = 'feishu:test';
    agents[targetJid] = {
      name: 'Feishu Target',
      folder: 'feishu_target',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    };

    await processTaskIpc(
      {
        type: 'delegate_task',
        requestId: 'del-cross-channel',
        targetAgentJid: targetJid,
        task: 'do work',
      },
      'web_main',
      true,
      deps,
    );

    const result = readDelegationIpcResult('web_main', 'del-cross-channel');
    expect(result).toMatchObject({
      status: 'error',
      error: 'Cross-channel delegation not allowed (main: web, target: feishu)',
    });
  });
});

// --- request_delegation target parsing ---

describe('request_delegation target parsing', () => {
  it('parses @{agentfolder} and includes target_agent_jid hint for main agent', async () => {
    const enqueued: string[] = [];
    deps.enqueueMessageCheck = (agentJid) => {
      enqueued.push(agentJid);
    };

    await processTaskIpc(
      {
        type: 'request_delegation',
        task: '@{third-agent} 请帮我排查线上告警并给出修复建议',
      },
      'other-agent',
      false,
      deps,
    );

    const msgs = getMessagesSince('web:main', '0', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('[委派请求 | 来自:Other]');
    expect(msgs[0].content).toContain('请帮我排查线上告警并给出修复建议');
    expect(msgs[0].content).not.toContain('@{third-agent}');
    expect(msgs[0].content).toContain('folder="third-agent"');
    expect(msgs[0].content).toContain('target_agent_jid="web:third"');
    expect(enqueued).toEqual(['web:main']);
  });

  it('strips leading trigger mention like @Andy from forwarded task body', async () => {
    await processTaskIpc(
      {
        type: 'request_delegation',
        task: '@Andy @{third-agent} 请帮我定位接口超时根因',
      },
      'other-agent',
      false,
      deps,
    );

    const msgs = getMessagesSince('web:main', '0', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('请帮我定位接口超时根因');
    expect(msgs[0].content).not.toContain('@Andy ');
    expect(msgs[0].content).not.toContain('@{third-agent}');
    expect(msgs[0].content).toContain('target_agent_jid="web:third"');
  });

  it('keeps forwarding when @{agentfolder} is unknown and marks it unresolved', async () => {
    await processTaskIpc(
      {
        type: 'request_delegation',
        task: '@{missing-agent} 请协助处理客户问题',
      },
      'other-agent',
      false,
      deps,
    );

    const msgs = getMessagesSince('web:main', '0', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('请协助处理客户问题');
    expect(msgs[0].content).toContain('folder="missing-agent"');
    expect(msgs[0].content).toContain('未找到该 folder 对应的注册 Agent');
  });
});

describe('run_local_host_script authorization', () => {
  it('main agent can run a script under local/shell', async () => {
    const requestId = rid('hostscript');
    const filename = `__icarus-test-${Date.now()}.sh`;
    const hostPath = path.join(process.cwd(), 'local', 'shell', filename);

    fs.writeFileSync(
      hostPath,
      '#!/bin/sh\nprintf "host-script-ok:%s\\n" "$1"\n',
      'utf8',
    );
    fs.chmodSync(hostPath, 0o755);

    try {
      await processTaskIpc(
        {
          type: 'run_local_host_script',
          requestId,
          scriptPath: `/workspace/project/local/shell/${filename}`,
          args: ['main'],
        },
        'web_main',
        true,
        deps,
      );
    } finally {
      fs.unlinkSync(hostPath);
    }

    const result = readHostScriptIpcResult('web_main', requestId);
    expect(result.status).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('host-script-ok:main');
    expect(result.scriptPath).toContain(`/local/shell/${filename}`);
  });
});

describe('desktop_capture authorization', () => {
  it('main agent can capture desktop through a supporting channel', async () => {
    const requestId = rid('desktop');
    const captureDesktop = vi.fn(async () => ({
      status: 'success' as const,
      requestId: 'client-request',
      source: 'web-client' as const,
      capturedAt: '2026-04-28T00:00:00.000Z',
      displays: [],
    }));
    deps.captureDesktop = captureDesktop;

    await processTaskIpc(
      {
        type: 'desktop_capture',
        requestId,
        displayId: '123',
        maxWidth: 1280,
        includeImage: false,
        includeWindows: true,
      },
      'web_main',
      true,
      deps,
    );

    expect(captureDesktop).toHaveBeenCalledWith(
      expect.objectContaining({
        displayId: '123',
        maxWidth: 1280,
        includeImage: false,
        includeWindows: true,
      }),
    );
    const result = readDesktopCaptureIpcResult('web_main', requestId);
    expect(result.status).toBe('success');
    expect(result.requestId).toBe('client-request');
    expect(result.source).toBe('web-client');
  });

  it('non-main agent cannot capture desktop', async () => {
    const requestId = rid('desktop');
    const captureDesktop = vi.fn();
    deps.captureDesktop = captureDesktop;

    await processTaskIpc(
      {
        type: 'desktop_capture',
        requestId,
      },
      'other-agent',
      false,
      deps,
    );

    expect(captureDesktop).not.toHaveBeenCalled();
    const result = readDesktopCaptureIpcResult('other-agent', requestId);
    expect(result.status).toBe('error');
    expect(result.error).toContain('main agent');
  });
});

describe('query_recent_today_plan_details authorization', () => {
  it('main agent can query recent today plan details', async () => {
    const requestId = rid('today-plan');
    const plan = createTodayPlan({
      plan_date: '2026-05-12',
      title: '今日计划',
      status: 'active',
    });
    createTodayPlanItem({
      plan_id: plan.id,
      title: '整理上下文',
      associations_json: JSON.stringify({
        chat_selections: [],
        services: [{ service: 'icarus', branches: [] }],
      }),
    });

    await processTaskIpc(
      {
        type: 'query_recent_today_plan_details',
        requestId,
        days: 1,
        date: '2026-05-12',
      },
      'web_main',
      true,
      deps,
    );

    const result = readTodayPlanIpcResult('web_main', requestId);
    expect(result.query.days).toBe(1);
    expect(result.query.mode).toBe('date');
    expect(result.query.date).toBe('2026-05-12');
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].items[0].title).toBe('整理上下文');
    expect(result.services[0].service).toBe('icarus');
  });

  it('non-main agent can query recent today plan details', async () => {
    const requestId = rid('today-plan');
    const plan = createTodayPlan({
      plan_date: '2026-05-13',
      title: '非主 Agent 可查计划',
      status: 'active',
    });
    createTodayPlanItem({
      plan_id: plan.id,
      title: '同步上下文',
      associations_json: JSON.stringify({
        chat_selections: [],
        services: [],
      }),
    });

    await processTaskIpc(
      {
        type: 'query_recent_today_plan_details',
        requestId,
        date: '2026-05-13',
      },
      'other-agent',
      false,
      deps,
    );

    const result = readTodayPlanIpcResult('other-agent', requestId);
    expect(result.query.mode).toBe('date');
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].items[0].title).toBe('同步上下文');
  });
});
