import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  getTaskById,
  listAgentQueries,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

function formatLocalTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid Agent folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      agent_folder: '../../outside',
      chat_jid: 'web:bad',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: formatLocalTime(new Date(Date.now() - 60_000)),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_agentJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredAgents: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
    expect(task?.last_result).toContain('Invalid Agent folder');
    expect(task?.last_query_id).toBeTruthy();

    const queries = listAgentQueries(10, 0, {
      sourceType: 'scheduled_task',
      sourceRefId: 'task-invalid-folder',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].query_id).toBe(task?.last_query_id);
    expect(queries[0].status).toBe('error');
    expect(queries[0].failure_type).toBe('invalid_input');
    expect(queries[0].failure_subtype).toBe('invalid_agent_folder');
    expect(queries[0].failure_origin).toBe('scheduler');
    expect(queries[0].failure_retryable).toBe(0);
    expect(queries[0].error_message).toContain('Invalid Agent folder');
  });

  it('records canonical query history when a task Agent is missing', async () => {
    createTask({
      id: 'task-missing-agent',
      agent_folder: 'missing-agent',
      chat_jid: 'web:missing',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: formatLocalTime(new Date(Date.now() - 60_000)),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_agentJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredAgents: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-missing-agent');
    expect(task?.status).toBe('active');
    expect(task?.last_result).toContain('Agent not found: missing-agent');
    expect(task?.last_query_id).toBeTruthy();

    const queries = listAgentQueries(10, 0, {
      sourceType: 'scheduled_task',
      sourceRefId: 'task-missing-agent',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].query_id).toBe(task?.last_query_id);
    expect(queries[0].status).toBe('error');
    expect(queries[0].failure_type).toBe('invalid_input');
    expect(queries[0].failure_subtype).toBe('agent_not_found');
    expect(queries[0].failure_origin).toBe('scheduler');
    expect(queries[0].failure_retryable).toBe(0);
    expect(queries[0].error_message).toBe('Agent not found: missing-agent');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      agent_folder: 'test',
      chat_jid: 'web:test',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      agent_folder: 'test',
      chat_jid: 'web:test',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      agent_folder: 'test',
      chat_jid: 'web:test',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
