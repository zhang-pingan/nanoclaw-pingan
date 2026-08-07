import { ChildProcess, exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  MAX_CONCURRENT_CONTAINERS,
  ONE_SHOT_AGENT_MAX_QUEUE_LENGTH,
  ONE_SHOT_AGENT_SLOT_TIMEOUT_MS,
} from './config.js';
import type { AgentStatusInfo, StopAgentResult } from './types.js';
export type { AgentStatusInfo, StopAgentResult } from './types.js';
import { updateTask } from './db.js';
import { stopContainer } from './container-runtime.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  agentJid: string;
  fn: () => Promise<void>;
}

export interface OneShotAgentStatusInput {
  agentFolder: string;
  agentName: string;
  promptSummary: string;
  lastSender?: string;
  lastContent?: string;
  lastTime?: string;
  isTask?: boolean;
  traceKey?: string;
  dedupeKey?: string;
}

export type OneShotAgentSlotEventName =
  | 'waiting_for_agent_slot'
  | 'agent_slot_idle_detected'
  | 'closing_idle_container'
  | 'agent_slot_acquired'
  | 'agent_slot_timeout';

export interface OneShotAgentSlotEvent {
  eventName: OneShotAgentSlotEventName;
  agentJid: string;
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
  agentJid: string;
  status: OneShotAgentStatusInput;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  enqueuedAt: number;
  timeoutAt: number;
  timeoutMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  closeRequested: boolean;
  closeRequestedAt: number | null;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const ONE_SHOT_IDLE_CLOSE_RETRY_MS = 250;

interface AgentState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  isOneShot: boolean;
  runningOneShotDedupeKey: string | null;
  runningTaskId: string | null;
  stdinClosing: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  pendingOneShots: QueuedOneShot[];
  process: ChildProcess | null;
  containerName: string | null;
  agentFolder: string | null;
  retryCount: number;
  promptSummary: string | null;
  lastSender: string | null;
  lastContent: string | null;
  lastTime: string | null;
  startedAt: number | null;
  agentName: string | null;
  stopRequested: boolean;
}

export interface CloseStdinContext {
  reason?: string;
  details?: Record<string, unknown>;
}

export class AgentQueue {
  private agents = new Map<string, AgentState>();
  private activeCount = 0;
  private waitingAgents: string[] = [];
  private processMessagesFn: ((agentJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private statusChangeCallbacks: (() => void)[] = [];
  private oneShotSlotEventCallbacks: Array<
    (event: OneShotAgentSlotEvent) => void
  > = [];

  private getAgentState(agentJid: string): AgentState {
    let state = this.agents.get(agentJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        isOneShot: false,
        runningOneShotDedupeKey: null,
        runningTaskId: null,
        stdinClosing: false,
        pendingMessages: false,
        pendingTasks: [],
        pendingOneShots: [],
        process: null,
        containerName: null,
        agentFolder: null,
        retryCount: 0,
        promptSummary: null,
        lastSender: null,
        lastContent: null,
        lastTime: null,
        startedAt: null,
        agentName: null,
        stopRequested: false,
      };
      this.agents.set(agentJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (agentJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Record extra Agent info when an Agent starts processing.
   */
  setAgentInfo(
    agentJid: string,
    info: {
      promptSummary: string;
      agentName: string;
      lastSender?: string;
      lastContent?: string;
      lastTime?: string;
    },
  ): void {
    const state = this.getAgentState(agentJid);
    state.promptSummary = info.promptSummary;
    state.agentName = info.agentName;
    state.lastSender = info.lastSender ?? null;
    state.lastContent = info.lastContent ?? null;
    state.lastTime = info.lastTime ?? null;
  }

  /**
   * Return all currently active agents with their status info.
   */
  getActiveAgents(): AgentStatusInfo[] {
    const result: AgentStatusInfo[] = [];
    for (const [agentJid, state] of this.agents) {
      if (!state.active || !state.startedAt) continue;
      result.push({
        agentJid,
        agentName: state.agentName || agentJid,
        agentFolder: state.agentFolder || '',
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
    agentJid: string,
    item: QueuedOneShot,
    eventName: OneShotAgentSlotEventName,
  ): void {
    const state = this.getAgentState(agentJid);
    const event: OneShotAgentSlotEvent = {
      eventName,
      agentJid,
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

  enqueueMessageCheck(agentJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getAgentState(agentJid);

    if (state.active) {
      state.pendingMessages = true;
      if (state.idleWaiting) {
        this.closeStdin(agentJid, {
          reason: 'message_check_while_idle',
          details: { pendingMessages: true },
        });
      }
      logger.debug({ agentJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingAgents.includes(agentJid)) {
        this.waitingAgents.push(agentJid);
      }
      logger.debug(
        { agentJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    if (state.pendingTasks.length > 0 || state.pendingOneShots.length > 0) {
      state.pendingMessages = true;
      if (!this.waitingAgents.includes(agentJid)) {
        this.waitingAgents.push(agentJid);
      }
      this.drainWaiting();
      logger.debug(
        {
          agentJid,
          pendingTasks: state.pendingTasks.length,
          pendingOneShots: state.pendingOneShots.length,
        },
        'Message queued behind pending agent work',
      );
      return;
    }

    this.runForAgent(agentJid, 'messages').catch((err) =>
      logger.error({ agentJid, err }, 'Unhandled error in runForAgent'),
    );
  }

  enqueueTask(agentJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getAgentState(agentJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ agentJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ agentJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, agentJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(agentJid, {
          reason: 'task_enqueue_while_idle',
          details: { taskId, pendingTasks: state.pendingTasks.length },
        });
      }
      logger.debug({ agentJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, agentJid, fn });
      if (!this.waitingAgents.includes(agentJid)) {
        this.waitingAgents.push(agentJid);
      }
      logger.debug(
        { agentJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    if (state.pendingMessages || state.pendingOneShots.length > 0) {
      state.pendingTasks.push({ id: taskId, agentJid, fn });
      if (!this.waitingAgents.includes(agentJid)) {
        this.waitingAgents.push(agentJid);
      }
      this.drainWaiting();
      logger.debug(
        {
          agentJid,
          taskId,
          pendingMessages: state.pendingMessages,
          pendingOneShots: state.pendingOneShots.length,
        },
        'Task queued behind pending agent work',
      );
      return;
    }

    // Run immediately
    this.runTask(agentJid, { id: taskId, agentJid, fn }).catch((err) =>
      logger.error({ agentJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  async runOneShot<T>(
    agentJid: string,
    status: OneShotAgentStatusInput,
    fn: () => Promise<T>,
  ): Promise<T> {
    const state = this.getAgentState(agentJid);
    if (
      status.dedupeKey &&
      (state.runningOneShotDedupeKey === status.dedupeKey ||
        state.pendingOneShots.some(
          (item) => item.status.dedupeKey === status.dedupeKey,
        ))
    ) {
      throw new Error(
        `One-shot agent already queued for ${agentJid}: ${status.dedupeKey}`,
      );
    }
    if (state.pendingOneShots.length >= ONE_SHOT_AGENT_MAX_QUEUE_LENGTH) {
      throw new Error(
        `One-shot agent queue is full for ${agentJid} (${state.pendingOneShots.length}/${ONE_SHOT_AGENT_MAX_QUEUE_LENGTH})`,
      );
    }
    if (
      !state.active &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS &&
      state.pendingTasks.length === 0 &&
      !state.pendingMessages &&
      state.pendingOneShots.length === 0
    ) {
      return this.executeOneShot(agentJid, status, fn);
    }

    return new Promise<T>((resolve, reject) => {
      const now = Date.now();
      const item: QueuedOneShot<T> = {
        id: this.createOneShotId(),
        agentJid,
        status,
        fn,
        resolve,
        reject,
        enqueuedAt: now,
        timeoutAt: now + ONE_SHOT_AGENT_SLOT_TIMEOUT_MS,
        timeoutMs: ONE_SHOT_AGENT_SLOT_TIMEOUT_MS,
        timeoutHandle: setTimeout(() => {
          this.timeoutOneShot(agentJid, item.id);
        }, ONE_SHOT_AGENT_SLOT_TIMEOUT_MS),
        closeRequested: false,
        closeRequestedAt: null,
      };
      state.pendingOneShots.push(item as QueuedOneShot);
      if (!state.active && !this.waitingAgents.includes(agentJid)) {
        this.waitingAgents.push(agentJid);
      }
      logger.info(
        {
          agentJid,
          oneShotId: item.id,
          active: state.active,
          idleWaiting: state.idleWaiting,
          activeCount: this.activeCount,
          pendingQueueLength: state.pendingOneShots.length,
          timeoutMs: item.timeoutMs,
        },
        'One-shot agent queued waiting for slot',
      );
      this.emitOneShotSlotEvent(agentJid, item, 'waiting_for_agent_slot');
      this.emitStatusChange();
      this.requestIdleCloseForOneShot(agentJid, item);
      this.drainWaiting();
    });
  }

  registerProcess(
    agentJid: string,
    proc: ChildProcess,
    containerName: string,
    agentFolder?: string,
  ): void {
    const state = this.getAgentState(agentJid);
    state.process = proc;
    state.containerName = containerName;
    if (agentFolder) state.agentFolder = agentFolder;
  }

  private createOneShotId(): string {
    return `oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private requestIdleCloseForOneShot(
    agentJid: string,
    item: QueuedOneShot,
  ): void {
    const state = this.getAgentState(agentJid);
    if (!state.pendingOneShots.includes(item)) return;
    if (!state.active || !state.idleWaiting || item.closeRequested) return;

    this.emitOneShotSlotEvent(agentJid, item, 'agent_slot_idle_detected');
    const closeWritten = this.closeStdin(agentJid, {
      reason: 'one_shot_waiting_for_idle_slot',
      details: {
        oneShotId: item.id,
        waitMs: Math.max(0, Date.now() - item.enqueuedAt),
        pendingOneShots: state.pendingOneShots.length,
      },
    });
    if (!closeWritten) {
      setTimeout(() => {
        this.requestIdleCloseForOneShot(agentJid, item);
      }, ONE_SHOT_IDLE_CLOSE_RETRY_MS);
      return;
    }
    item.closeRequested = true;
    item.closeRequestedAt = Date.now();
    this.emitOneShotSlotEvent(agentJid, item, 'closing_idle_container');
  }

  private requestIdleCloseForPendingOneShot(agentJid: string): void {
    const state = this.getAgentState(agentJid);
    const item = state.pendingOneShots[0];
    if (!item) return;
    this.requestIdleCloseForOneShot(agentJid, item);
  }

  private timeoutOneShot(agentJid: string, oneShotId: string): void {
    const state = this.getAgentState(agentJid);
    const index = state.pendingOneShots.findIndex(
      (item) => item.id === oneShotId,
    );
    if (index === -1) return;

    const [item] = state.pendingOneShots.splice(index, 1);
    clearTimeout(item.timeoutHandle);
    const waitMs = Math.max(0, Date.now() - item.enqueuedAt);
    logger.warn(
      {
        agentJid,
        oneShotId: item.id,
        waitMs,
        timeoutMs: item.timeoutMs,
        idleWaiting: state.idleWaiting,
        pendingQueueLength: state.pendingOneShots.length,
      },
      'One-shot agent timed out waiting for slot',
    );
    this.emitOneShotSlotEvent(agentJid, item, 'agent_slot_timeout');
    item.reject(new Error(`Agent busy timeout for ${agentJid}`));
    this.emitStatusChange();
    this.drainAgent(agentJid);
  }

  private async executeOneShot<T>(
    agentJid: string,
    status: OneShotAgentStatusInput,
    fn: () => Promise<T>,
    item?: QueuedOneShot<T>,
  ): Promise<T> {
    const state = this.getAgentState(agentJid);
    if (item) {
      clearTimeout(item.timeoutHandle);
      this.emitOneShotSlotEvent(agentJid, item, 'agent_slot_acquired');
    }

    state.stopRequested = false;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = status.isTask ?? false;
    state.isOneShot = true;
    state.runningOneShotDedupeKey = status.dedupeKey ?? null;
    state.stdinClosing = false;
    state.pendingMessages = false;
    state.agentFolder = status.agentFolder;
    state.agentName = status.agentName;
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
      state.runningOneShotDedupeKey = null;
      state.runningTaskId = null;
      state.stdinClosing = false;
      state.process = null;
      state.containerName = null;
      state.agentFolder = null;
      state.startedAt = null;
      state.promptSummary = null;
      state.lastSender = null;
      state.lastContent = null;
      state.lastTime = null;
      state.agentName = null;
      state.stopRequested = false;
      this.activeCount--;
      this.emitStatusChange();
      this.drainAgent(agentJid);
    }
  }

  /**
   * Check whether a container is currently active for this agent.
   */
  isActive(agentJid: string): boolean {
    return this.getAgentState(agentJid).active;
  }

  /**
   * Check whether this agent has a real container process registered.
   * An Agent can be active while it is only pre-processing messages.
   */
  hasActiveContainer(agentJid: string): boolean {
    const state = this.getAgentState(agentJid);
    return Boolean(state.active && (state.process || state.containerName));
  }

  purgeAgentState(agentJid: string, reason = 'purge_agent_state'): void {
    const state = this.agents.get(agentJid);
    this.waitingAgents = this.waitingAgents.filter((jid) => jid !== agentJid);
    if (!state) return;

    state.pendingMessages = false;
    state.pendingTasks = [];
    state.stopRequested = true;
    for (const item of state.pendingOneShots.splice(0)) {
      clearTimeout(item.timeoutHandle);
      item.reject(new Error(`Agent ${agentJid} purged: ${reason}`));
    }

    if (!state.active) {
      this.agents.delete(agentJid);
    }
    this.emitStatusChange();
  }

  canPipeMessage(agentJid: string): boolean {
    const state = this.getAgentState(agentJid);
    return Boolean(
      state.active &&
      state.agentFolder &&
      !state.stdinClosing &&
      !state.isTaskContainer &&
      !state.isOneShot &&
      !state.pendingOneShots.some((item) => item.closeRequested),
    );
  }

  async stopAgent(agentJid: string): Promise<StopAgentResult> {
    const state = this.agents.get(agentJid);
    if (!state?.active) {
      return { ok: false, error: 'Agent is not active' };
    }

    state.stopRequested = true;
    state.pendingMessages = false;
    state.pendingTasks = [];
    for (const item of state.pendingOneShots.splice(0)) {
      clearTimeout(item.timeoutHandle);
      item.reject(
        new Error(`Agent stopped before one-shot could run for ${agentJid}`),
      );
    }
    this.emitStatusChange();

    const stoppedTaskId = state.runningTaskId;
    if (stoppedTaskId) {
      updateTask(stoppedTaskId, { status: 'paused' });
    }

    const proc = state.process;
    const containerName = state.containerName;
    if (!proc && !containerName) {
      this.emitStatusChange();
      return { ok: true, stoppedTaskId };
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
            { agentJid, containerName },
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
              { agentJid, containerName, err },
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

    return { ok: true, stoppedTaskId };
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(agentJid: string): void {
    const state = this.getAgentState(agentJid);
    const wasIdle = state.idleWaiting;
    state.idleWaiting = true;
    logger.info(
      {
        agentJid,
        agentFolder: state.agentFolder,
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
      this.requestIdleCloseForPendingOneShot(agentJid);
    } else if (state.pendingTasks.length > 0 || state.pendingMessages) {
      this.closeStdin(agentJid, {
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
    agentJid: string,
    text: string,
    selectedModel: string,
    queryId: string,
  ): boolean {
    const state = this.getAgentState(agentJid);
    if (
      !state.active ||
      !state.agentFolder ||
      state.isTaskContainer ||
      state.isOneShot ||
      state.stdinClosing ||
      state.pendingOneShots.some((item) => item.closeRequested)
    ) {
      logger.warn(
        {
          agentJid,
          active: state.active,
          agentFolder: state.agentFolder,
          isTaskContainer: state.isTaskContainer,
          isOneShot: state.isOneShot,
          stdinClosing: state.stdinClosing,
          pendingOneShots: state.pendingOneShots.length,
          oneShotCloseRequested: state.pendingOneShots.some(
            (item) => item.closeRequested,
          ),
          queryId,
        },
        'IPC message not written because container cannot receive messages',
      );
      return false;
    }
    const wasIdle = state.idleWaiting;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.agentFolder, 'input');
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
          agentJid,
          agentFolder: state.agentFolder,
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
          agentJid,
          agentFolder: state.agentFolder,
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
  closeStdin(agentJid: string, context: CloseStdinContext = {}): boolean {
    const state = this.getAgentState(agentJid);
    if (!state.active || !state.agentFolder) {
      logger.info(
        {
          agentJid,
          reason: context.reason || 'unspecified',
          details: context.details,
          active: state.active,
          agentFolder: state.agentFolder,
          idleWaiting: state.idleWaiting,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
          pendingOneShots: state.pendingOneShots.length,
        },
        'Skipping container close sentinel because no active agent folder exists',
      );
      return false;
    }

    const inputDir = path.join(DATA_DIR, 'ipc', state.agentFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
      state.stdinClosing = true;
      state.idleWaiting = false;
      logger.info(
        {
          agentJid,
          agentFolder: state.agentFolder,
          containerName: state.containerName,
          reason: context.reason || 'unspecified',
          details: context.details,
          idleWaiting: state.idleWaiting,
          pendingMessages: state.pendingMessages,
          pendingTasks: state.pendingTasks.length,
          pendingOneShots: state.pendingOneShots.length,
          isTaskContainer: state.isTaskContainer,
          isOneShot: state.isOneShot,
          stdinClosing: state.stdinClosing,
          runningTaskId: state.runningTaskId,
          stopRequested: state.stopRequested,
        },
        'Container close sentinel written',
      );
      return true;
    } catch (err) {
      logger.warn(
        {
          agentJid,
          agentFolder: state.agentFolder,
          reason: context.reason || 'unspecified',
          details: context.details,
          err,
        },
        'Failed to write container close sentinel',
      );
      return false;
    }
  }

  private async runForAgent(
    agentJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getAgentState(agentJid);
    state.stopRequested = false;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.isOneShot = false;
    state.runningOneShotDedupeKey = null;
    state.stdinClosing = false;
    state.pendingMessages = false;
    state.startedAt = Date.now();
    this.activeCount++;

    logger.debug(
      {
        agentJid,
        reason,
        activeCount: this.activeCount,
        pendingOneShots: state.pendingOneShots.length,
      },
      'Starting container for agent',
    );

    this.emitStatusChange();

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(agentJid);
        if (success) {
          state.retryCount = 0;
        } else if (!state.stopRequested) {
          this.scheduleRetry(agentJid, state);
        }
      }
    } catch (err) {
      logger.error({ agentJid, err }, 'Error processing messages for agent');
      if (!state.stopRequested) {
        this.scheduleRetry(agentJid, state);
      }
    } finally {
      state.active = false;
      state.isOneShot = false;
      state.runningOneShotDedupeKey = null;
      state.stdinClosing = false;
      state.process = null;
      state.containerName = null;
      state.agentFolder = null;
      state.startedAt = null;
      state.promptSummary = null;
      state.lastSender = null;
      state.lastContent = null;
      state.lastTime = null;
      state.agentName = null;
      state.stopRequested = false;
      this.activeCount--;
      this.emitStatusChange();
      this.drainAgent(agentJid);
    }
  }

  private async runTask(agentJid: string, task: QueuedTask): Promise<void> {
    const state = this.getAgentState(agentJid);
    state.stopRequested = false;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.isOneShot = false;
    state.runningOneShotDedupeKey = null;
    state.stdinClosing = false;
    state.runningTaskId = task.id;
    state.startedAt = Date.now();
    this.activeCount++;

    logger.debug(
      {
        agentJid,
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
      logger.error({ agentJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.isOneShot = false;
      state.runningOneShotDedupeKey = null;
      state.runningTaskId = null;
      state.stdinClosing = false;
      state.process = null;
      state.containerName = null;
      state.agentFolder = null;
      state.startedAt = null;
      state.promptSummary = null;
      state.lastSender = null;
      state.lastContent = null;
      state.lastTime = null;
      state.agentName = null;
      state.stopRequested = false;
      this.activeCount--;
      this.emitStatusChange();
      this.drainAgent(agentJid);
    }
  }

  private scheduleRetry(agentJid: string, state: AgentState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { agentJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { agentJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(agentJid);
      }
    }, delayMs);
  }

  private drainAgent(agentJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getAgentState(agentJid);
    if (state.active) {
      this.requestIdleCloseForPendingOneShot(agentJid);
      return;
    }
    if (state.stopRequested) return;
    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      if (
        this.agentHasPendingWork(state) &&
        !this.waitingAgents.includes(agentJid)
      ) {
        this.waitingAgents.push(agentJid);
      }
      return;
    }

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(agentJid, task).catch((err) =>
        logger.error(
          { agentJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForAgent(agentJid, 'drain').catch((err) =>
        logger.error(
          { agentJid, err },
          'Unhandled error in runForAgent (drain)',
        ),
      );
      return;
    }

    if (state.pendingOneShots.length > 0) {
      const item = state.pendingOneShots.shift()!;
      this.executeOneShot(agentJid, item.status, item.fn, item).then(
        item.resolve,
        item.reject,
      );
      this.emitStatusChange();
      return;
    }

    // Nothing pending for this agent; check if other agents are waiting for a slot
    this.drainWaiting();
  }

  private agentHasPendingWork(state: AgentState): boolean {
    return (
      state.pendingTasks.length > 0 ||
      state.pendingMessages ||
      state.pendingOneShots.length > 0
    );
  }

  private drainWaiting(): void {
    while (
      this.waitingAgents.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingAgents.shift()!;
      const state = this.getAgentState(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { agentJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForAgent(nextJid, 'drain').catch((err) =>
          logger.error(
            { agentJid: nextJid, err },
            'Unhandled error in runForAgent (waiting)',
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
      // If neither pending, skip this agent
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    for (const [agentJid, state] of this.agents) {
      for (const item of state.pendingOneShots.splice(0)) {
        clearTimeout(item.timeoutHandle);
        item.reject(
          new Error(
            `AgentQueue shutting down before one-shot could run for ${agentJid}`,
          ),
        );
      }
    }

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents host restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.agents) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'AgentQueue shutting down (containers detached, not killed)',
    );
  }
}
