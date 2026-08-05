import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import crypto from 'crypto';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { agentQueryTraceManager } from './agent-query-trace.js';
import { queryPatchFromTraceEvent } from './agent-query-trace-utils.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import {
  ClassifiedFailure,
  classifyFailure,
  toAgentQueryFailurePatch,
  toFailureEventPayload,
} from './failure-taxonomy.js';
import { AgentQueue } from './agent-queue.js';
import { resolveAgentFolderPath } from './agent-folder.js';
import { logger } from './logger.js';
import { selectModel } from './model-selector.js';
import { RegisteredAgent, ScheduledTask } from './types.js';

function createExecutionId(): string {
  return crypto.randomUUID();
}

function finishScheduledTaskErrorQuery(
  queryId: string,
  error: string,
  options: {
    failure?: ClassifiedFailure;
    outputPreview?: string | null;
    summary?: string;
  } = {},
): void {
  const failure =
    options.failure ??
    classifyFailure(new Error(error), {
      module: 'task-scheduler',
      action: 'run_scheduled_task',
      defaultType: 'unknown_error',
      defaultSubtype: 'scheduler_runtime_error',
      defaultOrigin: 'scheduler',
      retryable: true,
    });
  const errorStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'error',
    stepName: 'run_error',
    summary: options.summary ?? 'Scheduled task failed',
    payload: {
      error,
      ...toFailureEventPayload(failure),
    },
  });
  agentQueryTraceManager.completeStep(queryId, errorStepId, 'error');
  agentQueryTraceManager.finishQuery(queryId, 'error', {
    ...toAgentQueryFailurePatch(failure, error),
    output_preview: options.outputPreview ?? null,
  });
}

function finishScheduledTaskSuccessQuery(
  queryId: string,
  result: string | null,
): void {
  const finishStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'finish',
    stepName: 'run_completed',
    summary: 'Scheduled task completed',
  });
  agentQueryTraceManager.completeStep(queryId, finishStepId, 'success');
  agentQueryTraceManager.finishQuery(queryId, 'success', {
    output_preview: result ? result.slice(0, 200) : 'Completed',
  });
}

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredAgents: () => Record<string, RegisteredAgent>;
  getSessions: () => Record<string, string>;
  queue: AgentQueue;
  onProcess: (
    agentJid: string,
    proc: ChildProcess,
    containerName: string,
    agentFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let result: string | null = null;
  let error: string | null = null;
  const runId = createExecutionId();
  const queryId = createExecutionId();
  const promptHash = crypto
    .createHash('sha256')
    .update(task.prompt)
    .digest('hex');

  // For agent context mode, use the agent's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'agent' ? sessions[task.agent_folder] : undefined;

  agentQueryTraceManager.startQuery({
    queryId,
    runId,
    sourceType: 'scheduled_task',
    sourceRefId: task.id,
    chatJid: task.chat_jid,
    agentFolder: task.agent_folder,
    taskId: task.id,
    taskTitle: task.prompt.slice(0, 120),
    sessionId,
    promptSummary: task.prompt.slice(0, 140),
    promptHash,
  });
  const inputStepId = agentQueryTraceManager.startStep({
    queryId,
    stepType: 'input',
    stepName: 'task_received',
    summary: `Scheduled task ${task.id} started`,
    payload: { taskId: task.id, contextMode: task.context_mode },
  });
  agentQueryTraceManager.completeStep(queryId, inputStepId, 'success');

  let agentDir: string;
  try {
    agentDir = resolveAgentFolderPath(task.agent_folder);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, agentFolder: task.agent_folder, error },
      'Task has invalid agent folder',
    );
    finishScheduledTaskErrorQuery(queryId, error, {
      failure: classifyFailure(err, {
        module: 'task-scheduler',
        action: 'resolve_agent_folder',
        defaultType: 'invalid_input',
        defaultSubtype: 'invalid_agent_folder',
        defaultOrigin: 'scheduler',
        retryable: false,
      }),
      summary: 'Scheduled task failed preflight validation',
    });
    updateTaskAfterRun(task.id, task.next_run, `Error: ${error}`, {
      lastQueryId: queryId,
      status: 'paused',
    });
    return;
  }
  fs.mkdirSync(agentDir, { recursive: true });

  logger.info(
    { taskId: task.id, agent: task.agent_folder },
    'Running scheduled task',
  );

  const agents = deps.registeredAgents();
  const agent = Object.values(agents).find(
    (g) => g.folder === task.agent_folder,
  );

  if (!agent) {
    error = `Agent not found: ${task.agent_folder}`;
    logger.error(
      { taskId: task.id, agentFolder: task.agent_folder },
      'Agent not found for task',
    );
    finishScheduledTaskErrorQuery(queryId, error, {
      failure: classifyFailure(new Error(error), {
        module: 'task-scheduler',
        action: 'lookup_agent',
        defaultType: 'invalid_input',
        defaultSubtype: 'agent_not_found',
        defaultOrigin: 'scheduler',
        retryable: false,
      }),
      summary: 'Scheduled task agent lookup failed',
    });
    updateTaskAfterRun(task.id, task.next_run, `Error: ${error}`, {
      lastQueryId: queryId,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by agent)
  const isMain = agent.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.agent_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      agentFolder: t.agent_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid, {
        reason: 'scheduled_task_close_after_result',
        details: {
          taskId: task.id,
          delayMs: TASK_CLOSE_DELAY_MS,
        },
      });
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const modelStepId = agentQueryTraceManager.startStep({
      queryId,
      stepType: 'model_select',
      stepName: 'select_model',
      summary: 'Selecting execution model',
    });
    const modelSelection = await selectModel({
      prompt: task.prompt,
      isMain,
      isScheduledTask: true,
    });
    agentQueryTraceManager.updateQuery(queryId, {
      selected_model: modelSelection.selectedModel,
      selected_model_reason: modelSelection.reason,
      current_action: `Using ${modelSelection.selectedModel}`,
    });
    agentQueryTraceManager.completeStep(
      queryId,
      modelStepId,
      'success',
      `Selected ${modelSelection.selectedModel}`,
    );
    logger.info(
      {
        taskId: task.id,
        agent: agent.name,
        selectedModel: modelSelection.selectedModel,
        reason: modelSelection.reason,
      },
      'Selected model for scheduled task',
    );
    const executionStepId = agentQueryTraceManager.startStep({
      queryId,
      stepType: 'agent_execution',
      stepName: 'run_agent',
      summary: 'Starting scheduled task execution',
      payload: { queryId },
    });
    let resultDeliveryStepId: string | null = null;
    const output = await runContainerAgent(
      agent,
      {
        prompt: task.prompt,
        sessionId,
        runId,
        queryId,
        agentFolder: task.agent_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        selectedModel: modelSelection.selectedModel,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.agent_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.newSessionId) {
          agentQueryTraceManager.updateQuery(queryId, {
            session_id: streamedOutput.newSessionId,
          });
        }
        if (streamedOutput.event) {
          const eventQueryPatch = queryPatchFromTraceEvent(
            streamedOutput.event,
          );
          if (Object.keys(eventQueryPatch).length > 0) {
            agentQueryTraceManager.updateQuery(queryId, eventQueryPatch);
          }
          agentQueryTraceManager.appendEvent({
            queryId,
            stepId: resultDeliveryStepId || executionStepId,
            eventType: streamedOutput.event.type,
            eventName: streamedOutput.event.name,
            status: streamedOutput.event.status ?? null,
            summary: streamedOutput.event.summary ?? null,
            payload: streamedOutput.event.payload,
          });
        }
        if (streamedOutput.result) {
          if (!resultDeliveryStepId) {
            agentQueryTraceManager.completeStep(
              queryId,
              executionStepId,
              'success',
              'Task execution produced output',
            );
            resultDeliveryStepId = agentQueryTraceManager.startStep({
              queryId,
              stepType: 'result_delivery',
              stepName: 'deliver_result',
              summary: 'Delivering task result',
            });
          }
          result = streamedOutput.result;
          agentQueryTraceManager.appendEvent({
            queryId,
            stepId: resultDeliveryStepId,
            eventType: 'output',
            eventName: 'assistant_output',
            status: 'success',
            summary: `Output: ${streamedOutput.result.slice(0, 120)}`,
            payload: { text: streamedOutput.result },
          });
          logger.info(
            { taskId: task.id, resultLength: result.length },
            `Task result: ${result.slice(0, 200)}`,
          );
          // Forward result to user (sendMessage handles formatting)
          try {
            agentQueryTraceManager.appendEvent({
              queryId,
              stepId: resultDeliveryStepId,
              eventType: 'lifecycle',
              eventName: 'channel_send_started',
              status: 'running',
              summary: 'Sending task result to channel',
            });
            await deps.sendMessage(task.chat_jid, streamedOutput.result);
            agentQueryTraceManager.appendEvent({
              queryId,
              stepId: resultDeliveryStepId,
              eventType: 'lifecycle',
              eventName: 'channel_send_finished',
              status: 'success',
              summary: 'Delivered task result to channel',
            });
          } catch (sendErr) {
            logger.error(
              { taskId: task.id, chatJid: task.chat_jid, error: sendErr },
              'Failed to send task result to channel',
            );
            agentQueryTraceManager.appendEvent({
              queryId,
              stepId: resultDeliveryStepId,
              eventType: 'error',
              eventName: 'channel_send_failed',
              status: 'error',
              summary:
                sendErr instanceof Error ? sendErr.message : String(sendErr),
            });
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success' && !streamedOutput.event) {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          const failure =
            streamedOutput.failure ??
            classifyFailure(new Error(error), {
              module: 'task-scheduler',
              action: 'run_container_agent',
              defaultType: 'container_runtime_error',
              defaultSubtype: 'agent_execution_failed',
              defaultOrigin: 'container',
              retryable: true,
            });
          agentQueryTraceManager.appendEvent({
            queryId,
            stepId: resultDeliveryStepId || executionStepId,
            eventType: 'error',
            eventName: 'run_failed',
            status: 'error',
            summary: error,
            payload: {
              error,
              ...toFailureEventPayload(failure),
            },
          });
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (!resultDeliveryStepId) {
      agentQueryTraceManager.completeStep(
        queryId,
        executionStepId,
        output.status === 'error' ? 'error' : 'success',
        output.status === 'error'
          ? 'Task execution failed'
          : 'Task execution finished',
      );
    } else {
      agentQueryTraceManager.completeStep(
        queryId,
        resultDeliveryStepId,
        output.status === 'error' ? 'error' : 'success',
        output.status === 'error'
          ? 'Task result delivery failed'
          : 'Task result delivery finished',
      );
    }

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
    if (error) {
      finishScheduledTaskErrorQuery(queryId, error, {
        failure:
          output.failure ??
          classifyFailure(new Error(error), {
            module: 'task-scheduler',
            action: 'run_container_agent',
            defaultType: 'container_runtime_error',
            defaultSubtype: 'agent_execution_failed',
            defaultOrigin: 'container',
            retryable: true,
          }),
        outputPreview: result ? result.slice(0, 200) : null,
      });
    } else {
      finishScheduledTaskSuccessQuery(queryId, result);
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
    finishScheduledTaskErrorQuery(queryId, error, {
      failure: classifyFailure(err, {
        module: 'task-scheduler',
        action: 'run_scheduled_task',
        defaultType: 'unknown_error',
        defaultSubtype: 'scheduler_runtime_error',
        defaultOrigin: 'scheduler',
        retryable: true,
      }),
    });
  }

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary, {
    lastQueryId: queryId,
  });
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
        // Also set agent info right away for the status panel
        const taskAgent = Object.values(deps.registeredAgents()).find(
          (g) => g.folder === currentTask.agent_folder,
        );
        if (taskAgent) {
          deps.queue.setAgentInfo(currentTask.chat_jid, {
            promptSummary: currentTask.prompt.slice(0, 100),
            agentName: taskAgent.name,
            lastSender: 'Scheduled Task',
            lastContent: currentTask.prompt.slice(0, 200),
            lastTime: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
