import { ChildProcess, exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONE_SHOT_AGENT_SLOT_TIMEOUT_MS,
} from './config.js';
import { AgentStatusInfo, StopAgentResult } from './types.js';
export { AgentStatusInfo, StopAgentResult } from './types.js';
import {
  getAllActiveWorkflows,
  getDelegationsByTarget,
  updateDelegation,
  updateTask,
} from './db.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';
import { cancelWorkflow } from './workflow.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

export interface OneShotAgentStatusInput {
  groupFolder: string;
  groupName: string;
  promptSummary: string;
  lastSender?: string;
  lastContent?: string;
  lastTime?: string;
  isTask?: boolean;
  traceKey?: string;
}

export type OneShotAgentSlotEventName =
  | 'waiting_for_agent_slot'
  | 'agent_slot_idle_detected'
  | 'closing_idle_container'
  | 'agent_slot_acquired'
  | 'agent_slot_timeout';

export interface OneShotAgentSlotEvent {
  eventName: OneShotAgentSlotEventName;
  groupJid: string;
  oneShotId: string;
  traceKey?: string;
  waitMs: number;
  idleWaiting: boolean;
  pendingQueueLength: number;
  activeCount: number;
  timeoutMs: number;
}

interface QueuedOneShot<T = any> {
  id: string;
  groupJid: string;
  status: OneShotAgentStatusInput;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  enqueuedAt: number;
  timeoutAt: number;
  timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  closeRequested: boolean;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  isOneShot: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  pendingOneShots: QueuedOneShot[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  promptSummary: string | null;
  lastSender: string | null;
  lastContent: string | null;
  lastTime: string | null;
  startedAt: number | null;
  groupName: string | null;
  stopRequested: boolean;
}

export interface CloseStdinContext {
  reason?: string;
  details?: Record<string, unknown>;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private statusChangeCallbacks: (() => void)[] = [];
  private oneShotSlotEventCallbacks: Array<
    (event: OneShotAgentSlotEvent) => void
  > = [];

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        isOneShot: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        pendingOneShots: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        promptSummary: null,
        lastSender: null,
        lastContent: null,
        lastTime: null,
        startedAt: null,
        groupName: null,
        stopRequested: false,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Record extra agent info when an agent starts processing.
   */
  setAgentInfo(
    groupJid: string,
    info: {
      promptSummary: string;
      groupName: string;
      lastSender?: string;
      lastContent?: string;
      lastTime?: string;
    },
  ): void {
    const state = this.getGroup(groupJid);
    state.promptSummary = info.promptSummary;
    state.groupName = info.groupName;
    state.lastSender = info.lastSender ?? null;
    state.lastContent = info.lastContent ?? null;
    state.lastTime = info.lastTime ?? null;
  }

  /**
   * Return all currently active agents with their status info.
   */
  getActiveAgents(): AgentStatusInfo[] {
    const activeWorkflowByTargetFolder =
      this.getActiveWorkflowCountByTargetFolder();
    const result: AgentStatusInfo[] = [];
    for (const [groupJid, state] of this.groups) {
      if (!state.active || !state.startedAt) continue;
      result.push({
        groupJid,
        groupName: state.groupName || groupJid,
        groupFolder: state.groupFolder || '',
        promptSummary: state.promptSummary || '',
        lastSender: state.lastSender || '',
        lastContent: state.lastContent || '',
        lastTime: state.lastTime || '',
        startedAt: state.startedAt,
        isIdle: state.idleWaiting,
        isTask: state.isTaskContainer,
        runningTaskId: state.runningTaskId,
        pendingMessages: state.pendingMessages,
        pendingTaskCount: state.pendingTasks.length,
        pendingOneShotCount: state.pendingOneShots.length,
        activeWorkflowCount:
          activeWorkflowByTargetFolder.get(state.groupFolder || '') || 0,
      });
    }
    return result;
  }

  /**
   * Register a callback invoked whenever agent status changes (start or stop).
   */
  onStatusChange(callback: () => void): void {
    this.statusChangeCallbacks.push(callback);
  }

  onOneShotSlotEvent(callback: (event: OneShotAgentSlotEvent) => void): void {
    this.oneShotSlotEventCallbacks.push(callback);
  }

  private emitStatusChange(): void {
    for (const cb of this.statusChangeCallbacks) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  private emitOneShotSlotEvent(
    groupJid: string,
    item: QueuedOneShot,
    eventName: OneShotAgentSlotEventName,
  ): void {
    const state = this.getGroup(groupJid);
    const event: OneShotAgentSlotEvent = {
      eventName,
      groupJid,
      oneShotId: item.id,
      traceKey: item.status.traceKey,
      waitMs: Math.max(0, Date.now() - item.enqueuedAt),
      idleWaiting: state.idleWaiting,
      pendingQueueLength: state.pendingOneShots.length,
      activeCount: this.activeCount,
      timeoutMs: item.timeoutMs,
    };
    for (const cb of this.oneShotSlotEventCallbacks) {
      try {
        cb(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      if (state.idleWaiting) {
        this.closeStdin(groupJid, {
          reason: 'message_check_while_idle',
          details: { pendingMessages: true },
        });
      }
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    if (state.pendingTasks.length > 0 || state.pendingOneShots.length > 0) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      this.drainWaiting();
      logger.debug(
        {
          groupJid,
          pendingTasks: state.pendingTasks.length,
          pendingOneShots: state.pendingOneShots.length,
        },
        'Message queued behind pending group work',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid, {
          reason: 'task_enqueue_while_idle',
          details: { taskId, pendingTasks: state.pendingTasks.length },
        });
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    if (state.pendingMessages || state.pendingOneShots.length > 0) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      this.drainWaiting();
      logger.debug(
        {
          groupJid,
          taskId,
          pendingMessages: state.pendingMessages,
          pendingOneShots: state.pendingOneShots.length,
        },
        'Task queued behind pending group work',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  async runOneShot<T>(
    groupJid: string,
    status: OneShotAgentStatusInput,
    fn: () => Promise<T>,
  ): Promise<T> {
    const state = this.getGroup(groupJid);
    if (
      !state.active &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS &&
      state.pendingTasks.length === 0 &&
      !state.pendingMessages &&
      state.pendingOneShots.length === 0
    ) {
      return this.executeOneShot(groupJid, status, fn);
    }

    return new Promise<T>((resolve, reject) => {
      const now = Date.now();
      const item: QueuedOneShot<T> = {
        id: this.createOneShotId(),
        groupJid,
        status,
        fn,
        resolve,
        reject,
        enqueuedAt: now,
        timeoutAt: now + ONE_SHOT_AGENT_SLOT_TIMEOUT_MS,
        timeoutMs: ONE_SHOT_AGENT_SLOT_TIMEOUT_MS,
        timeoutHandle: setTimeout(() => {
          this.timeoutOneShot(groupJid, item.id);
        }, ONE_SHOT_AGENT_SLOT_TIMEOUT_MS),
        closeRequested: false,
      };
      state.pendingOneShots.push(item as QueuedOneShot);
      if (!state.active && !this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.info(
        {
          groupJid,
          oneShotId: item.id,
          active: state.active,
          idleWaiting: state.idleWaiting,
          activeCount: this.activeCount,
          pendingQueueLength: state.pendingOneShots.length,
          timeoutMs: item.timeoutMs,
        },
        'One-shot agent queued waiting for slot',
      );
      this.emitOneShotSlotEvent(groupJid, item, 'waiting_for_agent_slot');
      this.emitStatusChange();
      this.requestIdleCloseForOneShot(groupJid, item);
      this.drainWaiting();
    });
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
  }

  private createOneShotId(): string {
    return `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private requestIdleCloseForOneShot(
    groupJid: string,
    item: QueuedOneShot,
  ): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.idleWaiting || item.closeRequested) return;

    item.closeRequested = true;
    this.emitOneShotSlotEvent(groupJid, item, 'agent_slot_idle_detected');
    this.emitOneShotSlotEvent(groupJid, item, 'closing_idle_container');
    this.closeStdin(groupJid, {
      reason: 'one_shot_waiting_for_idle_slot',
      details: {
        oneShotId: item.id,
        waitMs: Math.max(0, Date.now() - item.enqueuedAt),
        pendingOneShots: state.pendingOneShots.length,
      },
    });
  }

  private requestIdleCloseForPendingOneShot(groupJid: string): void {
    const state = this.getGroup(groupJid);
    const item = state.pendingOneShots[0];
    if (!item) return;
    this.requestIdleCloseForOneShot(groupJid, item);
  }

  private timeoutOneShot(groupJid: string, oneShotId: string): void {
    const state = this.getGroup(groupJid);
    const index = state.pendingOneShots.findIndex(
      (item) => item.id === oneShotId,
    );
    if (index === -1) return;

    const [item] = state.pendingOneShots.splice(index, 1);
    clearTimeout(item.timeoutHandle);
    const waitMs = Math.max(0, Date.now() - item.enqueuedAt);
    logger.warn(
      {
        groupJid,
        oneShotId: item.id,
        waitMs,
        timeoutMs: item.timeoutMs,
        idleWaiting: state.idleWaiting,
        pendingQueueLength: state.pendingOneShots.length,
      },
      'One-shot agent timed out waiting for slot',
    );
    this.emitOneShotSlotEvent(groupJid, item, 'agent_slot_timeout');
    item.reject(new Error(`Agent busy timeout for ${groupJid}`));
    this.emitStatusChange();
    this.drainGroup(groupJid);
  }

  private async executeOneShot<T>(
    groupJid: string,
    status: OneShotAgentStatusInput,
    fn: () => Promise<T>,
    item?: QueuedOneShot<T>,
  ): Promise<T> {
    const state = this.getGroup(groupJid);
    if (item) {
      clearTimeout(item.timeoutHandle);
      this.emitOneShotSlotEvent(groupJid, item, 'agent_slot_acquired');
    }

    state.stopRequested = false;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = status.isTask ?? false;
    state.isOneShot = true;
    state.pendingMessages = false;
    state.groupFolder = status.groupFolder;
    state.groupName = status.groupName;
    state.promptSummary = status.promptSummary;
    state.lastSender = status.lastSender ?? null;
    state.lastContent = status.lastContent ?? null;
    state.lastTime = status.lastTime ?? null;
    state.startedAt = Date.now();
    this.activeCount++;
    this.emitStatusChange();

    try {
      return await fn();
    } finally {
      state.active = false;
      state.idleWaiting = false;
      state.isTaskContainer = false;
      state.isOneShot = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.startedAt = null;
      state.promptSummary = null;
      state.lastSender = null;
      state.lastContent = null;
      state.lastTime = null;
      state.groupName = null;
      state.stopRequested = false;
      this.activeCount--;
      this.emitStatusChange();
      this.drainGroup(groupJid);
    }
  }

  /**
   * Check whether a container is currently active for this group.
   */
  isActive(groupJid: string): boolean {
    return this.getGroup(groupJid).active;
  }

  /**
   * Check whether this group has a real container process registered.
   * A group can be active while it is only pre-processing messages.
   */
  hasActiveContainer(groupJid: string): boolean {
    const state = this.getGroup(groupJid);
    return Boolean(state.active && (state.process || state.containerName));
  }

  canPipeMessage(groupJid: string): boolean {
    const state = this.getGroup(groupJid);
    return Boolean(
      state.active &&
      state.groupFolder &&
      !state.isTaskContainer &&
      !state.isOneShot,
    );
  }

  async stopAgent(groupJid: string): Promise<StopAgentResult> {
    const state = this.groups.get(groupJid);
    if (!state?.active) {
      return { ok: false, error: 'Agent is not active' };
    }

    state.stopRequested = true;
    state.pendingMessages = false;
    state.pendingTasks = [];
    for (const item of state.pendingOneShots.splice(0)) {
      clearTimeout(item.timeoutHandle);
      item.reject(
        new Error(`Agent stopped before one-shot could run for ${groupJid}`),
      );
    }
    this.emitStatusChange();

    const stoppedTaskId = state.runningTaskId;
    if (stoppedTaskId) {
      updateTask(stoppedTaskId, { status: 'paused' });
    }

    const cancelledWorkflowIds = this.cancelActiveWorkflowsForGroup(state);

    const proc = state.process;
    const containerName = state.containerName;
    if (!proc && !containerName) {
      this.emitStatusChange();
      return { ok: true, stoppedTaskId, cancelledWorkflowIds };
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const forceKillTimer = setTimeout(() => {
        if (proc && !proc.killed) {
          logger.warn(
            { groupJid, containerName },
            'Agent stop timed out, force killing process',
          );
          proc.kill('SIGKILL');
        }
        finish();
      }, 5000);

      if (proc) {
        proc.once('close', () => {
          clearTimeout(forceKillTimer);
          finish();
        });
      }

      if (containerName) {
        exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
          if (err) {
            logger.warn(
              { groupJid, containerName, err },
              'Graceful container stop failed, falling back to process kill',
            );
            if (proc && !proc.killed) proc.kill('SIGTERM');
            return;
          }
          if (!proc || proc.killed) {
            clearTimeout(forceKillTimer);
            finish();
          }
        });
      } else if (proc && !proc.killed) {
        proc.kill('SIGTERM');
      } else {
        clearTimeout(forceKillTimer);
        finish();
      }
    });

    return { ok: true, stoppedTaskId, cancelledWorkflowIds };
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    const wasIdle = state.idleWaiting;
    state.idleWaiting = true;
    logger.info(
      {
        groupJid,
        groupFolder: state.groupFolder,
        wasIdle,
        pendingMessages: state.pendingMessages,
        pendingTasks: state.pendingTasks.length,
        pendingOneShots: state.pendingOneShots.length,
        hasProcess: Boolean(state.process),
        containerName: state.containerName,
      },
      'Agent marked idle waiting for IPC',
    );
    if (!wasIdle) {
      this.emitStatusChange();
    }
    if (state.pendingOneShots.length > 0) {
      this.requestIdleCloseForPendingOneShot(groupJid);
    } else if (state.pendingTasks.length > 0 || state.pendingMessages) {
      this.closeStdin(groupJid, {
        reason: 'idle_has_pending_work',
        details: {
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
        },
      });
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(
    groupJid: string,
    text: string,
    selectedModel: string,
    queryId: string,
  ): boolean {
    const state = this.getGroup(groupJid);
    if (
      !state.active ||
      !state.groupFolder ||
      state.isTaskContainer ||
      state.isOneShot
    ) {
      logger.warn(
        {
          groupJid,
          active: state.active,
          groupFolder: state.groupFolder,
          isTaskContainer: state.isTaskContainer,
          isOneShot: state.isOneShot,
          queryId,
        },
        'IPC message not written because container cannot receive messages',
      );
      return false;
    }
    const wasIdle = state.idleWaiting;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({ type: 'message', text, selectedModel, queryId }),
      );
      fs.renameSync(tempPath, filepath);
      logger.info(
        {
          groupJid,
          groupFolder: state.groupFolder,
          containerName: state.containerName,
          queryId,
          selectedModel,
          wasIdle,
          inputFile: path.basename(filepath),
          textLength: text.length,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
        },
        'IPC message written to active container',
      );
      if (wasIdle) {
        this.emitStatusChange();
      }
      return true;
    } catch (err) {
      logger.warn(
        {
          groupJid,
          groupFolder: state.groupFolder,
          queryId,
          err,
        },
        'Failed to write IPC message to active container',
      );
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string, context: CloseStdinContext = {}): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) {
      logger.info(
        {
          groupJid,
          reason: context.reason || 'unspecified',
          details: context.details,
          active: state.active,
          groupFolder: state.groupFolder,
          idleWaiting: state.idleWaiting,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
          pendingOneShots: state.pendingOneShots.length,
        },
        'Skipping container close sentinel because no active group folder exists',
      );
      return;
    }

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
      logger.info(
        {
          groupJid,
          groupFolder: state.groupFolder,
          containerName: state.containerName,
          reason: context.reason || 'unspecified',
          details: context.details,
          idleWaiting: state.idleWaiting,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
          pendingOneShots: state.pendingOneShots.length,
          isTaskContainer: state.isTaskContainer,
          isOneShot: state.isOneShot,
          runningTaskId: state.runningTaskId,
          stopRequested: state.stopRequested,
        },
        'Container close sentinel written',
      );
    } catch (err) {
      logger.warn(
        {
          groupJid,
          groupFolder: state.groupFolder,
          reason: context.reason || 'unspecified',
          details: context.details,
          err,
        },
        'Failed to write container close sentinel',
      );
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.stopRequested = false;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.isOneShot = false;
    state.pendingMessages = false;
    state.startedAt = Date.now();
    this.activeCount++;

    logger.debug(
      {
        groupJid,
        reason,
        activeCount: this.activeCount,
        pendingOneShots: state.pendingOneShots.length,
      },
      'Starting container for group',
    );

    this.emitStatusChange();

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else if (!state.stopRequested) {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      if (!state.stopRequested) {
        this.scheduleRetry(groupJid, state);
      }
    } finally {
      state.active = false;
      state.isOneShot = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.startedAt = null;
      state.promptSummary = null;
      state.lastSender = null;
      state.lastContent = null;
      state.lastTime = null;
      state.groupName = null;
      state.stopRequested = false;
      this.activeCount--;
      this.emitStatusChange();
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.stopRequested = false;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.isOneShot = false;
    state.runningTaskId = task.id;
    state.startedAt = Date.now();
    this.activeCount++;

    logger.debug(
      {
        groupJid,
        taskId: task.id,
        activeCount: this.activeCount,
        pendingOneShots: state.pendingOneShots.length,
      },
      'Running queued task',
    );

    this.emitStatusChange();

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.isOneShot = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.startedAt = null;
      state.promptSummary = null;
      state.lastSender = null;
      state.lastContent = null;
      state.lastTime = null;
      state.groupName = null;
      state.stopRequested = false;
      this.activeCount--;
      this.emitStatusChange();
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (state.active) {
      this.requestIdleCloseForPendingOneShot(groupJid);
      return;
    }
    if (state.stopRequested) return;
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      if (
        this.groupHasPendingWork(state) &&
        !this.waitingGroups.includes(groupJid)
      ) {
        this.waitingGroups.push(groupJid);
      }
      return;
    }

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    if (state.pendingOneShots.length > 0) {
      const item = state.pendingOneShots.shift()!;
      this.executeOneShot(groupJid, item.status, item.fn, item).then(
        item.resolve,
        item.reject,
      );
      this.emitStatusChange();
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private groupHasPendingWork(state: GroupState): boolean {
    return (
      state.pendingTasks.length > 0 ||
      state.pendingMessages ||
      state.pendingOneShots.length > 0
    );
  }

  private cancelActiveWorkflowsForGroup(state: GroupState): string[] {
    if (!state.groupFolder) return [];

    const pendingDelegations = getDelegationsByTarget(state.groupFolder).filter(
      (delegation) => delegation.status === 'pending',
    );
    if (pendingDelegations.length === 0) return [];

    const activeWorkflowByDelegation = new Map(
      getAllActiveWorkflows()
        .filter((workflow) => workflow.current_delegation_id)
        .map((workflow) => [workflow.current_delegation_id, workflow.id]),
    );

    const cancelledWorkflowIds: string[] = [];
    for (const delegation of pendingDelegations) {
      const workflowId = activeWorkflowByDelegation.get(delegation.id);
      if (!workflowId) continue;

      updateDelegation(delegation.id, {
        status: 'failed',
        outcome: 'failure',
        result: 'Agent stopped manually from Agent Status panel.',
      });

      const result = cancelWorkflow(workflowId);
      if (!result.error) {
        cancelledWorkflowIds.push(workflowId);
      }
    }

    return cancelledWorkflowIds;
  }

  private getActiveWorkflowCountByTargetFolder(): Map<string, number> {
    const counts = new Map<string, number>();
    const activeWorkflowByDelegation = new Map(
      getAllActiveWorkflows()
        .filter((workflow) => workflow.current_delegation_id)
        .map((workflow) => [workflow.current_delegation_id, workflow.id]),
    );

    for (const state of this.groups.values()) {
      if (!state.groupFolder) continue;
      const activeCount = getDelegationsByTarget(state.groupFolder).filter(
        (delegation) =>
          delegation.status === 'pending' &&
          activeWorkflowByDelegation.has(delegation.id),
      ).length;
      if (activeCount > 0) {
        counts.set(state.groupFolder, activeCount);
      }
    }

    return counts;
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      } else if (state.pendingOneShots.length > 0) {
        const item = state.pendingOneShots.shift()!;
        this.executeOneShot(nextJid, item.status, item.fn, item).then(
          item.resolve,
          item.reject,
        );
        this.emitStatusChange();
      }
      // If neither pending, skip this group
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    for (const [groupJid, state] of this.groups) {
      for (const item of state.pendingOneShots.splice(0)) {
        clearTimeout(item.timeoutHandle);
        item.reject(
          new Error(
            `GroupQueue shutting down before one-shot could run for ${groupJid}`,
          ),
        );
      }
    }

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}
