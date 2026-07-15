import { describe, it, expect, beforeEach } from 'vitest';

import { agentQueryTraceManager } from './agent-query-trace.js';
import {
  _initTestDatabase,
  createDelegation,
  createMemory,
  createTask,
  deleteMemory,
  deleteTask,
  doctorMemories,
  gcMemories,
  getMemoryById,
  getMemoryExtractConfig,
  getMemoryMetricSummary,
  getAllChats,
  getAllRegisteredGroups,
  getAgentQuery,
  getDatabase,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  listAgentQueries,
  listMemories,
  recordMemoryMetric,
  resolveConflict,
  searchMemories,
  setRegisteredGroup,
  setMemoryExtractConfig,
  storeChatMetadata,
  storeMessage,
  updateMemory,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

describe('removed runtime schema cleanup', () => {
  function legacySchemaObjects(): string[] {
    return (
      getDatabase()
        .prepare(
          `SELECT name
           FROM sqlite_schema
           WHERE name = 'workflows'
              OR name GLOB 'workflow_*'
              OR name GLOB 'workbench_*'
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  function columnNames(table: string): string[] {
    return (
      getDatabase()
        .prepare(`SELECT name FROM pragma_table_info(?)`)
        .all(table) as Array<{ name: string }>
    ).map((column) => column.name);
  }

  it('does not create removed tables, columns, or indexes in a fresh database', () => {
    expect(legacySchemaObjects()).toEqual([]);
    expect(
      columnNames('messages').filter((name) => name.startsWith('workflow_')),
    ).toEqual([]);
    expect(
      columnNames('assistant_chat_messages').filter((name) =>
        name.startsWith('workflow_'),
      ),
    ).toEqual([]);
    expect(
      columnNames('delegations').filter(
        (name) => name.startsWith('workflow_') || name.startsWith('handoff_'),
      ),
    ).toEqual([]);
    expect(
      columnNames('agent_queries').filter(
        (name) => name.startsWith('workflow_') || name === 'stage_key',
      ),
    ).toEqual([]);
  });

  it('removes an existing legacy schema while preserving active data', () => {
    storeChatMetadata('protected@g.us', '2026-07-14T00:00:00.000Z');
    store({
      id: 'protected-message',
      chat_jid: 'protected@g.us',
      sender: 'user@example.com',
      sender_name: 'User',
      content: 'keep this message',
      timestamp: '2026-07-14T00:00:01.000Z',
    });
    createDelegation({
      id: 'protected-delegation',
      source_jid: 'protected@g.us',
      source_folder: 'main',
      target_jid: 'target@g.us',
      target_folder: 'target',
      task: 'Keep this delegation',
      status: 'pending',
      result: null,
      outcome: null,
      requester_jid: 'protected@g.us',
      created_at: '2026-07-14T00:00:00.000Z',
      updated_at: '2026-07-14T00:00:00.000Z',
    });
    createTask({
      id: 'protected-task',
      group_folder: 'main',
      chat_jid: 'protected@g.us',
      prompt: 'Keep this scheduled task',
      schedule_type: 'once',
      schedule_value: '2026-07-15T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2026-07-15T00:00:00.000Z',
      status: 'active',
      created_at: '2026-07-14T00:00:00.000Z',
    });
    createMemory({
      group_folder: 'main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'Keep this memory',
    });

    const existing = getDatabase();
    existing.exec(`
      ALTER TABLE messages ADD COLUMN workflow_id TEXT;
      ALTER TABLE assistant_chat_messages ADD COLUMN workflow_id TEXT;
      ALTER TABLE assistant_chat_messages ADD COLUMN workflow_stage TEXT;
      ALTER TABLE delegations ADD COLUMN workflow_id TEXT;
      ALTER TABLE delegations ADD COLUMN handoff_context_json TEXT;
      ALTER TABLE agent_queries ADD COLUMN workflow_type TEXT;
      ALTER TABLE agent_queries ADD COLUMN workflow_id TEXT;
      ALTER TABLE agent_queries ADD COLUMN stage_key TEXT;
      CREATE INDEX idx_messages_workflow_id ON messages(workflow_id);
      CREATE INDEX idx_delegations_handoff_context ON delegations(handoff_context_json);
      CREATE INDEX idx_agent_queries_workflow_id ON agent_queries(workflow_id);
      CREATE TABLE workflows (id TEXT PRIMARY KEY);
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY);
      CREATE TABLE workbench_tasks (id TEXT PRIMARY KEY);
      INSERT INTO workflows (id) VALUES ('legacy-runtime');
      INSERT INTO workflow_runs (id) VALUES ('legacy-run');
      INSERT INTO workbench_tasks (id) VALUES ('legacy-task');
    `);

    _initTestDatabase(existing);

    expect(legacySchemaObjects()).toEqual([]);
    expect(columnNames('messages')).not.toContain('workflow_id');
    expect(columnNames('assistant_chat_messages')).not.toContain('workflow_id');
    expect(columnNames('assistant_chat_messages')).not.toContain(
      'workflow_stage',
    );
    expect(columnNames('delegations')).not.toContain('workflow_id');
    expect(columnNames('delegations')).not.toContain('handoff_context_json');
    expect(columnNames('agent_queries')).not.toContain('workflow_type');
    expect(columnNames('agent_queries')).not.toContain('workflow_id');
    expect(columnNames('agent_queries')).not.toContain('stage_key');

    for (const table of [
      'chats',
      'messages',
      'delegations',
      'scheduled_tasks',
      'memories',
    ]) {
      const row = getDatabase()
        .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
        .get() as { count: number };
      expect(row.count).toBe(1);
    }
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its canonical run history', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    agentQueryTraceManager.startQuery({
      queryId: 'query-task-3',
      runId: 'run-task-3',
      sourceType: 'scheduled_task',
      sourceRefId: 'task-3',
      chatJid: 'group@g.us',
      groupFolder: 'main',
      promptSummary: 'delete me',
      promptHash: 'prompt-hash',
    });
    const stepId = agentQueryTraceManager.startStep({
      queryId: 'query-task-3',
      stepType: 'finish',
      stepName: 'run_completed',
      summary: 'Scheduled task completed',
    });
    agentQueryTraceManager.completeStep('query-task-3', stepId, 'success');
    agentQueryTraceManager.finishQuery('query-task-3', 'success', {
      output_preview: 'Completed',
    });

    expect(getAgentQuery('query-task-3')).toBeDefined();

    deleteTask('task-3');

    expect(getTaskById('task-3')).toBeUndefined();
    expect(getAgentQuery('query-task-3')).toBeUndefined();
    expect(
      listAgentQueries(10, 0, {
        sourceType: 'scheduled_task',
        sourceRefId: 'task-3',
      }),
    ).toHaveLength(0);
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Structured memory ---

describe('structured memory CRUD/search/status', () => {
  it('creates, lists, updates, deletes memories', () => {
    const created = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'preference',
      content: 'Always reply in Chinese',
    });
    expect(created.id).toMatch(/^mem-/);

    const listed = listMemories('web_main', 10);
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe('active');

    updateMemory(created.id, {
      content: 'Always reply in Chinese for this group',
      memory_type: 'rule',
    });
    const updated = getMemoryById(created.id)!;
    expect(updated.content).toContain('this group');
    expect(updated.memory_type).toBe('rule');

    deleteMemory(created.id);
    expect(getMemoryById(created.id)).toBeUndefined();
  });

  it('memory_search includes structured memory hits and excludes deprecated ones', () => {
    const m1 = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'Service foo uses branch main',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'episodic',
      memory_type: 'summary',
      content: 'Yesterday fixed foo timeout',
    });

    let hits = searchMemories('web_main', 'foo', 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.id === m1.id)).toBe(true);

    updateMemory(m1.id, { status: 'deprecated' });
    hits = searchMemories('web_main', 'foo', 10);
    expect(hits.some((h) => h.id === m1.id)).toBe(false);
  });

  it('marks contradictory rules as conflicted automatically', () => {
    const pos = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Always use send_message for progress',
    });
    const neg = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Never use send_message for progress',
    });

    const p = getMemoryById(pos.id)!;
    const n = getMemoryById(neg.id)!;
    expect(p.status).toBe('conflicted');
    expect(n.status).toBe('conflicted');
  });
});

describe('memory doctor/gc/metrics', () => {
  it('doctor reports duplicates, conflicts, stale working', () => {
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'preference',
      content: 'Always reply in Chinese',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'preference',
      content: 'Always reply in Chinese',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Always include summary',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Never include summary',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'working',
      memory_type: 'summary',
      content: 'temporary context',
    });

    const report = doctorMemories('web_main', -1);
    expect(report.duplicateGroups.length).toBeGreaterThan(0);
    expect(report.conflictGroups.length).toBeGreaterThan(0);
    expect(report.staleWorkingIds.length).toBeGreaterThan(0);
  });

  it('gc supports dry-run and execute', () => {
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'API endpoint is /v1/orders',
    });
    createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'API endpoint is /v1/orders',
    });

    const dry = gcMemories('web_main', { dryRun: true, staleWorkingDays: 365 });
    expect(dry.dryRun).toBe(true);
    expect(dry.duplicateDeletedIds.length).toBe(1);
    expect(listMemories('web_main', 20).length).toBe(2);

    const run = gcMemories('web_main', {
      dryRun: false,
      staleWorkingDays: 365,
    });
    expect(run.dryRun).toBe(false);
    expect(listMemories('web_main', 20).length).toBe(1);
  });

  it('aggregates metric summary by event', () => {
    recordMemoryMetric('web_main', 'write', 'layer=canonical');
    recordMemoryMetric('web_main', 'write', 'layer=working');
    recordMemoryMetric('web_main', 'search:hybrid', 'q=foo');

    const summary = getMemoryMetricSummary('web_main', 24);
    expect(summary.total).toBe(3);
    const writeRow = summary.byEvent.find((e) => e.event === 'write');
    const searchRow = summary.byEvent.find((e) => e.event === 'search:hybrid');
    expect(writeRow?.count).toBe(2);
    expect(searchRow?.count).toBe(1);
  });
});

describe('memory extract config table', () => {
  it('returns defaults and supports per-group overrides', () => {
    const defaults = getMemoryExtractConfig('web_main');
    expect(defaults.canonical_max).toBe(3);
    expect(defaults.working_max).toBe(4);
    expect(defaults.canonical_min_confidence).toBe(0.8);

    setMemoryExtractConfig('*', 'working_max', 7);
    setMemoryExtractConfig('web_main', 'working_max', 2);
    setMemoryExtractConfig('web_main', 'canonical_min_confidence', 0.9);

    const cfg = getMemoryExtractConfig('web_main');
    expect(cfg.working_max).toBe(2);
    expect(cfg.canonical_min_confidence).toBe(0.9);

    const other = getMemoryExtractConfig('other_group');
    expect(other.working_max).toBe(7);
  });
});

describe('memory_resolve_conflict', () => {
  it('keep mode: keeps one memory active, deprecates the other with audit trail', () => {
    const pos = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Always use send_message for progress',
    });
    const neg = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Never use send_message for progress',
    });

    // Both should be conflicted
    expect(getMemoryById(pos.id)!.status).toBe('conflicted');
    expect(getMemoryById(neg.id)!.status).toBe('conflicted');

    const result = resolveConflict('keep', {
      keepId: pos.id,
      deprecateId: neg.id,
      groupFolder: 'web_main',
    });

    // Verify kept memory
    expect(result.kept.status).toBe('active');
    const keptMeta = JSON.parse(result.kept.metadata!);
    expect(keptMeta.resolved_conflict_with).toBe(neg.id);
    expect(keptMeta.resolved_at).toBeDefined();

    // Verify deprecated memory
    expect(result.deprecated.status).toBe('deprecated');
    const depMeta = JSON.parse(result.deprecated.metadata!);
    expect(depMeta.deprecated_reason).toBe('conflict_resolution');
    expect(depMeta.resolved_by).toBe('keep');
    expect(depMeta.counterpart_id).toBe(pos.id);
  });

  it('merge mode: deprecates both and creates merged memory with audit trail', () => {
    const pos = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Always use send_message for progress',
    });
    const neg = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'rule',
      content: 'Never use send_message for progress',
    });

    expect(getMemoryById(pos.id)!.status).toBe('conflicted');
    expect(getMemoryById(neg.id)!.status).toBe('conflicted');

    const result = resolveConflict('merge', {
      mergeIds: [pos.id, neg.id],
      mergedContent: 'Use send_message for important progress only',
      groupFolder: 'web_main',
    });

    // Verify merged memory
    expect(result.merged.status).toBe('active');
    expect(result.merged.content).toBe(
      'Use send_message for important progress only',
    );
    const mergedMeta = JSON.parse(result.merged.metadata!);
    expect(mergedMeta.merged_from).toEqual([pos.id, neg.id]);
    expect(mergedMeta.resolved_at).toBeDefined();

    // Verify both originals deprecated
    expect(result.deprecated[0].status).toBe('deprecated');
    expect(result.deprecated[1].status).toBe('deprecated');
    const depMetaA = JSON.parse(result.deprecated[0].metadata!);
    expect(depMetaA.resolved_by).toBe('merge');
    expect(depMetaA.deprecated_reason).toBe('conflict_resolution');
  });

  it('throws error when memory is not conflicted', () => {
    const mem1 = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'API endpoint is /v1/orders',
    });
    const mem2 = createMemory({
      group_folder: 'web_main',
      layer: 'canonical',
      memory_type: 'fact',
      content: 'API version is v2',
    });

    // These are not conflicted (no polarity clash)
    expect(getMemoryById(mem1.id)!.status).toBe('active');
    expect(getMemoryById(mem2.id)!.status).toBe('active');

    expect(() =>
      resolveConflict('keep', {
        keepId: mem1.id,
        deprecateId: mem2.id,
        groupFolder: 'web_main',
      }),
    ).toThrow(/not conflicted/);

    expect(() =>
      resolveConflict('merge', {
        mergeIds: [mem1.id, mem2.id],
        mergedContent: 'combined',
        groupFolder: 'web_main',
      }),
    ).toThrow(/not conflicted/);
  });
});
