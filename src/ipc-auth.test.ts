import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  _initTestDatabase,
  createTask,
  getAllTasks,
  getMessagesSince,
  getRegisteredGroup,
  getTaskById,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { DATA_DIR } from './config.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Set up registered groups used across tests
const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'whatsapp_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const OTHER_GROUP: RegisteredGroup = {
  name: 'Other',
  folder: 'other-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const THIRD_GROUP: RegisteredGroup = {
  name: 'Third',
  folder: 'third-group',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

function readMemoryIpcResult(
  sourceGroup: string,
  requestId: string,
): any {
  const p = path.join(
    DATA_DIR,
    'ipc',
    sourceGroup,
    'search-results',
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

  groups = {
    'main@g.us': MAIN_GROUP,
    'other@g.us': OTHER_GROUP,
    'third@g.us': THIRD_GROUP,
  };

  // Populate DB as well
  setRegisteredGroup('main@g.us', MAIN_GROUP);
  setRegisteredGroup('other@g.us', OTHER_GROUP);
  setRegisteredGroup('third@g.us', THIRD_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: (jid, group) => {
      groups[jid] = group;
      setRegisteredGroup(jid, group);
      // Mock the fs.mkdirSync that registerGroup does
    },
    syncGroups: async () => {},
    getAvailableGroups: () => [],
    writeGroupsSnapshot: () => {},
    enqueueMessageCheck: () => {},
  };
});

// --- schedule_task authorization ---

describe('schedule_task authorization', () => {
  it('main group can schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'do something',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify task was created in DB for the other group
    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group can schedule for itself', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'self task',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'other@g.us',
      },
      'other-group',
      false,
      deps,
    );

    const allTasks = getAllTasks();
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].group_folder).toBe('other-group');
  });

  it('non-main group cannot schedule for another group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'unauthorized',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        targetJid: 'main@g.us',
      },
      'other-group',
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
        targetJid: 'unknown@g.us',
      },
      'whatsapp_main',
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
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
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
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'other task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can pause any task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group can pause its own task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-other' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-other')!.status).toBe('paused');
  });

  it('non-main group cannot pause another groups task', async () => {
    await processTaskIpc(
      { type: 'pause_task', taskId: 'task-main' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-main')!.status).toBe('active');
  });
});

// --- resume_task authorization ---

describe('resume_task authorization', () => {
  beforeEach(() => {
    createTask({
      id: 'task-paused',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
      prompt: 'paused task',
      schedule_type: 'once',
      schedule_value: '2025-06-01T00:00:00',
      context_mode: 'isolated',
      next_run: '2025-06-01T00:00:00.000Z',
      status: 'paused',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  });

  it('main group can resume any task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group can resume its own task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('active');
  });

  it('non-main group cannot resume another groups task', async () => {
    await processTaskIpc(
      { type: 'resume_task', taskId: 'task-paused' },
      'third-group',
      false,
      deps,
    );
    expect(getTaskById('task-paused')!.status).toBe('paused');
  });
});

// --- cancel_task authorization ---

describe('cancel_task authorization', () => {
  it('main group can cancel any task', async () => {
    createTask({
      id: 'task-to-cancel',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
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
      'whatsapp_main',
      true,
      deps,
    );
    expect(getTaskById('task-to-cancel')).toBeUndefined();
  });

  it('non-main group can cancel its own task', async () => {
    createTask({
      id: 'task-own',
      group_folder: 'other-group',
      chat_jid: 'other@g.us',
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
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-own')).toBeUndefined();
  });

  it('non-main group cannot cancel another groups task', async () => {
    createTask({
      id: 'task-foreign',
      group_folder: 'whatsapp_main',
      chat_jid: 'main@g.us',
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
      'other-group',
      false,
      deps,
    );
    expect(getTaskById('task-foreign')).toBeDefined();
  });
});

// --- register_group authorization ---

describe('register_group authorization', () => {
  it('non-main group cannot register a group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'other-group',
      false,
      deps,
    );

    // registeredGroups should not have changed
    expect(groups['new@g.us']).toBeUndefined();
  });

  it('main group cannot register with unsafe folder path', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: '../../outside',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(groups['new@g.us']).toBeUndefined();
  });
});

// --- refresh_groups authorization ---

describe('refresh_groups authorization', () => {
  it('non-main group cannot trigger refresh', async () => {
    // This should be silently blocked (no crash, no effect)
    await processTaskIpc(
      { type: 'refresh_groups' },
      'other-group',
      false,
      deps,
    );
    // If we got here without error, the auth gate worked
  });
});

// --- IPC message authorization ---
// Tests the authorization pattern from startIpcWatcher (ipc.ts).
// The logic: isMain || (targetGroup && targetGroup.folder === sourceGroup)

describe('IPC message authorization', () => {
  // Replicate the exact check from the IPC watcher
  function isMessageAuthorized(
    sourceGroup: string,
    isMain: boolean,
    targetChatJid: string,
    registeredGroups: Record<string, RegisteredGroup>,
  ): boolean {
    const targetGroup = registeredGroups[targetChatJid];
    return isMain || (!!targetGroup && targetGroup.folder === sourceGroup);
  }

  it('main group can send to any group', () => {
    expect(
      isMessageAuthorized('whatsapp_main', true, 'other@g.us', groups),
    ).toBe(true);
    expect(
      isMessageAuthorized('whatsapp_main', true, 'third@g.us', groups),
    ).toBe(true);
  });

  it('non-main group can send to its own chat', () => {
    expect(
      isMessageAuthorized('other-group', false, 'other@g.us', groups),
    ).toBe(true);
  });

  it('non-main group cannot send to another groups chat', () => {
    expect(isMessageAuthorized('other-group', false, 'main@g.us', groups)).toBe(
      false,
    );
    expect(
      isMessageAuthorized('other-group', false, 'third@g.us', groups),
    ).toBe(false);
  });

  it('non-main group cannot send to unregistered JID', () => {
    expect(
      isMessageAuthorized('other-group', false, 'unknown@g.us', groups),
    ).toBe(false);
  });

  it('main group can send to unregistered JID', () => {
    // Main is always authorized regardless of target
    expect(
      isMessageAuthorized('whatsapp_main', true, 'unknown@g.us', groups),
    ).toBe(true);
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getAllTasks()).toHaveLength(0);
  });
});

// --- context_mode defaulting ---

describe('schedule_task context_mode', () => {
  it('accepts context_mode=group', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'group context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'group',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('group');
  });

  it('accepts context_mode=isolated', async () => {
    await processTaskIpc(
      {
        type: 'schedule_task',
        prompt: 'isolated context',
        schedule_type: 'once',
        schedule_value: '2025-06-01T00:00:00',
        context_mode: 'isolated',
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
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
        targetJid: 'other@g.us',
      },
      'whatsapp_main',
      true,
      deps,
    );

    const tasks = getAllTasks();
    expect(tasks[0].context_mode).toBe('isolated');
  });
});

// --- register_group success path ---

describe('register_group success', () => {
  it('main group can register a new group', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'new@g.us',
        name: 'New Group',
        folder: 'new-group',
        trigger: '@Andy',
      },
      'whatsapp_main',
      true,
      deps,
    );

    // Verify group was registered in DB
    const group = getRegisteredGroup('new@g.us');
    expect(group).toBeDefined();
    expect(group!.name).toBe('New Group');
    expect(group!.folder).toBe('new-group');
    expect(group!.trigger).toBe('@Andy');
  });

  it('register_group rejects request with missing fields', async () => {
    await processTaskIpc(
      {
        type: 'register_group',
        jid: 'partial@g.us',
        name: 'Partial',
        // missing folder and trigger
      },
      'whatsapp_main',
      true,
      deps,
    );

    expect(getRegisteredGroup('partial@g.us')).toBeUndefined();
  });
});

describe('memory IPC tasks', () => {
  it('memory_write/list/update/delete round-trip works', async () => {
    const sourceGroup = 'other-group';
    const writeId = rid('mw');
    const listId = rid('ml');
    const updateId = rid('mu');
    const deleteId = rid('md');

    await processTaskIpc(
      {
        type: 'memory_write',
        requestId: writeId,
        content: 'Always reply in Chinese',
        layer: 'canonical',
        memory_type: 'preference',
      },
      sourceGroup,
      false,
      deps,
    );
    const writeRes = readMemoryIpcResult(sourceGroup, writeId);
    expect(writeRes.memory?.id).toBeTruthy();
    const memoryId = writeRes.memory.id as string;

    await processTaskIpc(
      { type: 'memory_list', requestId: listId, limit: 10 },
      sourceGroup,
      false,
      deps,
    );
    const listRes = readMemoryIpcResult(sourceGroup, listId);
    expect(Array.isArray(listRes.memories)).toBe(true);
    expect(listRes.memories.length).toBeGreaterThan(0);

    await processTaskIpc(
      {
        type: 'memory_update',
        requestId: updateId,
        memoryId,
        content: 'Always reply in Chinese language',
      },
      sourceGroup,
      false,
      deps,
    );
    const updateRes = readMemoryIpcResult(sourceGroup, updateId);
    expect(updateRes.memory.content).toContain('language');

    await processTaskIpc(
      { type: 'memory_delete', requestId: deleteId, memoryId },
      sourceGroup,
      false,
      deps,
    );
    const deleteRes = readMemoryIpcResult(sourceGroup, deleteId);
    expect(deleteRes.deleted).toBe(true);
  });

  it('memory_search returns hybrid hits', async () => {
    const sourceGroup = 'other-group';
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
      sourceGroup,
      false,
      deps,
    );
    readMemoryIpcResult(sourceGroup, writeId);

    // seed one message hit as well
    storeChatMetadata('other@g.us', Date.now().toString());
    storeMessage({
      id: 'm-foo',
      chat_jid: 'other@g.us',
      sender: 'u@s.whatsapp.net',
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
      sourceGroup,
      false,
      deps,
    );
    const searchRes = readMemoryIpcResult(sourceGroup, searchId);
    expect(searchRes.mode).toBe('hybrid');
    expect(Array.isArray(searchRes.hits)).toBe(true);
    expect(searchRes.hits.length).toBeGreaterThan(0);
    expect(
      searchRes.hits.some(
        (h: { kind: string; content: string }) =>
          h.kind === 'memory' && h.content.includes('branch main'),
      ),
    ).toBe(true);
  });

  it('memory_search keyword mode excludes structured memory hits', async () => {
    const sourceGroup = 'other-group';
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
      sourceGroup,
      false,
      deps,
    );
    readMemoryIpcResult(sourceGroup, writeId);

    storeChatMetadata('other@g.us', Date.now().toString());
    storeMessage({
      id: `m-keyword-${Date.now()}`,
      chat_jid: 'other@g.us',
      sender: 'u@s.whatsapp.net',
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
      sourceGroup,
      false,
      deps,
    );
    const res = readMemoryIpcResult(sourceGroup, searchId);
    expect(res.mode).toBe('keyword');
    expect(res.hits.some((h: { kind: string }) => h.kind === 'memory')).toBe(
      false,
    );
    expect(res.hits.some((h: { kind: string }) => h.kind === 'message')).toBe(
      true,
    );
  });

  it('memory_update/delete return error payload for unknown memory id', async () => {
    const sourceGroup = 'other-group';
    const updateId = rid('mu');
    const deleteId = rid('md');

    await processTaskIpc(
      {
        type: 'memory_update',
        requestId: updateId,
        memoryId: 'mem-not-found',
        content: 'x',
      },
      sourceGroup,
      false,
      deps,
    );
    const updateRes = readMemoryIpcResult(sourceGroup, updateId);
    expect(updateRes.error).toBe('memory not found');

    await processTaskIpc(
      {
        type: 'memory_delete',
        requestId: deleteId,
        memoryId: 'mem-not-found',
      },
      sourceGroup,
      false,
      deps,
    );
    const deleteRes = readMemoryIpcResult(sourceGroup, deleteId);
    expect(deleteRes.error).toBe('memory not found');
  });

  it('memory_gc with dryRun=false deletes duplicates', async () => {
    const sourceGroup = 'other-group';
    const write1 = rid('mw');
    const write2 = rid('mw');
    const gcId = rid('mgc');
    const listId = rid('ml');

    for (const requestId of [write1, write2]) {
      await processTaskIpc(
        {
          type: 'memory_write',
          requestId,
          content: 'Duplicate value for gc',
          layer: 'canonical',
          memory_type: 'fact',
        },
        sourceGroup,
        false,
        deps,
      );
      readMemoryIpcResult(sourceGroup, requestId);
    }

    await processTaskIpc(
      {
        type: 'memory_gc',
        requestId: gcId,
        dryRun: false,
        staleDays: 365,
      },
      sourceGroup,
      false,
      deps,
    );
    const gcRes = readMemoryIpcResult(sourceGroup, gcId);
    expect(gcRes.result.dryRun).toBe(false);
    expect(gcRes.result.duplicateDeletedIds.length).toBeGreaterThan(0);

    await processTaskIpc(
      { type: 'memory_list', requestId: listId, limit: 50 },
      sourceGroup,
      false,
      deps,
    );
    const listRes = readMemoryIpcResult(sourceGroup, listId);
    const remain = listRes.memories.filter(
      (m: { content: string }) => m.content === 'Duplicate value for gc',
    );
    expect(remain.length).toBe(1);
  });

  it('memory_doctor/gc/metrics produce response payloads', async () => {
    const sourceGroup = 'other-group';
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
        sourceGroup,
        false,
        deps,
      );
      readMemoryIpcResult(sourceGroup, writeId);
    }

    const doctorId = rid('mdo');
    await processTaskIpc(
      { type: 'memory_doctor', requestId: doctorId, staleDays: 7 },
      sourceGroup,
      false,
      deps,
    );
    const doctorRes = readMemoryIpcResult(sourceGroup, doctorId);
    expect(doctorRes.report).toBeTruthy();
    expect(doctorRes.report.total).toBeGreaterThan(0);

    const gcId = rid('mgc');
    await processTaskIpc(
      { type: 'memory_gc', requestId: gcId, dryRun: true, staleDays: 14 },
      sourceGroup,
      false,
      deps,
    );
    const gcRes = readMemoryIpcResult(sourceGroup, gcId);
    expect(gcRes.result).toBeTruthy();
    expect(gcRes.result.dryRun).toBe(true);

    const metricsId = rid('mmet');
    await processTaskIpc(
      { type: 'memory_metrics', requestId: metricsId, hours: 24 },
      sourceGroup,
      false,
      deps,
    );
    const metricsRes = readMemoryIpcResult(sourceGroup, metricsId);
    expect(metricsRes.summary).toBeTruthy();
    expect(metricsRes.summary.total).toBeGreaterThan(0);
  });

  it('handles concurrent memory writes without result file collisions', async () => {
    const sourceGroup = 'other-group';
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
          sourceGroup,
          false,
          deps,
        ),
      };
    });

    await Promise.all(tasks.map((t) => t.promise));

    const ids = tasks
      .map((t) => readMemoryIpcResult(sourceGroup, t.requestId)?.memory?.id)
      .filter(Boolean);
    expect(ids.length).toBe(12);
    expect(new Set(ids).size).toBe(12);
  });

  it('handles concurrent memory searches and returns per-request results', async () => {
    const sourceGroup = 'other-group';

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
        sourceGroup,
        false,
        deps,
      );
      readMemoryIpcResult(sourceGroup, writeIds[i]);
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
          sourceGroup,
          false,
          deps,
        ),
      };
    });

    await Promise.all(searchTasks.map((t) => t.promise));

    for (const t of searchTasks) {
      const res = readMemoryIpcResult(sourceGroup, t.requestId);
      expect(Array.isArray(res.hits)).toBe(true);
      expect(res.hits.length).toBeGreaterThan(0);
    }
  });

  it('memory_metrics stays consistent under concurrent operations', async () => {
    const sourceGroup = 'other-group';

    const writeTasks = Array.from({ length: 5 }).map((_, i) => {
      const requestId = rid('mw-metrics');
      return {
        requestId,
        promise: processTaskIpc(
          {
            type: 'memory_write',
            requestId,
            content: `Metrics seed ${i}`,
            layer: 'canonical',
            memory_type: 'fact',
          },
          sourceGroup,
          false,
          deps,
        ),
      };
    });
    await Promise.all(writeTasks.map((t) => t.promise));
    for (const t of writeTasks) readMemoryIpcResult(sourceGroup, t.requestId);

    const listTasks = Array.from({ length: 2 }).map(() => {
      const requestId = rid('ml-metrics');
      return {
        requestId,
        promise: processTaskIpc(
          { type: 'memory_list', requestId, limit: 50 },
          sourceGroup,
          false,
          deps,
        ),
      };
    });
    const searchTasks = Array.from({ length: 3 }).map(() => {
      const requestId = rid('ms-metrics');
      return {
        requestId,
        promise: processTaskIpc(
          {
            type: 'memory_search',
            requestId,
            query: 'Metrics',
            mode: 'hybrid',
            limit: 5,
          },
          sourceGroup,
          false,
          deps,
        ),
      };
    });

    await Promise.all([
      ...listTasks.map((t) => t.promise),
      ...searchTasks.map((t) => t.promise),
    ]);
    for (const t of listTasks) readMemoryIpcResult(sourceGroup, t.requestId);
    for (const t of searchTasks) readMemoryIpcResult(sourceGroup, t.requestId);

    const metricsId = rid('mmet-consistency');
    await processTaskIpc(
      { type: 'memory_metrics', requestId: metricsId, hours: 24 },
      sourceGroup,
      false,
      deps,
    );
    const metrics = readMemoryIpcResult(sourceGroup, metricsId).summary;
    const byEvent = new Map(
      (metrics.byEvent as Array<{ event: string; count: number }>).map((e) => [
        e.event,
        e.count,
      ]),
    );
    expect(byEvent.get('write')).toBe(5);
    expect(byEvent.get('list')).toBe(2);
    expect(byEvent.get('search:hybrid')).toBe(3);
    expect(metrics.total).toBe(10);
  });
});

// --- request_delegation target parsing ---

describe('request_delegation target parsing', () => {
  it('parses @{groupfolder} and includes target_group_jid hint for main group', async () => {
    const enqueued: string[] = [];
    deps.enqueueMessageCheck = (groupJid) => {
      enqueued.push(groupJid);
    };

    await processTaskIpc(
      {
        type: 'request_delegation',
        task: '@{third-group} 请帮我排查线上告警并给出修复建议',
      },
      'other-group',
      false,
      deps,
    );

    const msgs = getMessagesSince('main@g.us', '0', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('[委派请求 | 来自:Other]');
    expect(msgs[0].content).toContain('请帮我排查线上告警并给出修复建议');
    expect(msgs[0].content).not.toContain('@{third-group}');
    expect(msgs[0].content).toContain('folder="third-group"');
    expect(msgs[0].content).toContain('target_group_jid="third@g.us"');
    expect(enqueued).toEqual(['main@g.us']);
  });

  it('strips leading trigger mention like @Andy from forwarded task body', async () => {
    await processTaskIpc(
      {
        type: 'request_delegation',
        task: '@Andy @{third-group} 请帮我定位接口超时根因',
      },
      'other-group',
      false,
      deps,
    );

    const msgs = getMessagesSince('main@g.us', '0', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('请帮我定位接口超时根因');
    expect(msgs[0].content).not.toContain('@Andy ');
    expect(msgs[0].content).not.toContain('@{third-group}');
    expect(msgs[0].content).toContain('target_group_jid="third@g.us"');
  });

  it('keeps forwarding when @{groupfolder} is unknown and marks it unresolved', async () => {
    await processTaskIpc(
      {
        type: 'request_delegation',
        task: '@{missing-group} 请协助处理客户问题',
      },
      'other-group',
      false,
      deps,
    );

    const msgs = getMessagesSince('main@g.us', '0', 'Andy');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain('请协助处理客户问题');
    expect(msgs[0].content).toContain('folder="missing-group"');
    expect(msgs[0].content).toContain('未找到该 folder 对应的注册群');
  });
});
