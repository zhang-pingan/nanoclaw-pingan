import { ChildProcess } from 'child_process';
import crypto from 'crypto';

import { buildAgentQueryTraceDetail } from '../agent-query-trace-detail.js';
import { agentQueryTraceManager } from '../agent-query-trace.js';
import { queryPatchFromTraceEvent } from '../agent-query-trace-utils.js';
import { ContainerOutput, runContainerAgent } from '../container-runner.js';
import {
  ClassifiedFailure,
  classifyFailure,
  toAgentQueryFailurePatch,
  toFailureEventPayload,
} from '../failure-taxonomy.js';
import { GroupQueue } from '../group-queue.js';
import { logger } from '../logger.js';
import { clearModelResolutionsForRun } from '../model-resolution.js';
import { selectModel } from '../model-selector.js';
import type { RegisteredGroup } from '../types.js';
import {
  parseRunOnceRequest,
  RunOnceFile,
  RunOnceRequestInput,
  RunOnceResponse,
  runOnceInputLength,
} from './schemas.js';
import { createRunOnceTraceWriter } from './trace-writer.js';

export class RunOnceInputError extends Error {
  status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'RunOnceInputError';
  }
}

export interface InternalAgentRunOnceServiceOptions {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  addOneShotTraceContext?: (
    chatJid: string,
    context: {
      queryId: string;
      stepId: string;
      runId: string;
      traceKey: string;
    },
  ) => void;
  removeOneShotTraceContext?: (chatJid: string, queryId: string) => void;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  maxInputChars: number;
}

function createExecutionId(): string {
  return crypto.randomUUID();
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function buildFilesPrompt(files: RunOnceFile[]): string {
  if (files.length === 0) return '';
  return [
    'Available files:',
    ...files.map((file, index) => {
      const details = [
        `path=${file.agent_path}`,
        file.relative_path ? `relative=${file.relative_path}` : '',
        file.size != null ? `size=${file.size}` : '',
        file.content_type ? `type=${file.content_type}` : '',
        file.sha256 ? `sha256=${file.sha256}` : '',
      ].filter(Boolean);
      return `${index + 1}. ${file.name} (${details.join(', ')})`;
    }),
    '',
    'Use these files when they are relevant to the user request.',
  ].join('\n');
}

function buildPromptWithFiles(prompt: string, files: RunOnceFile[]): string {
  const filesPrompt = buildFilesPrompt(files);
  if (!filesPrompt) return prompt;
  return `${filesPrompt}\n\nUser request:\n${prompt}`;
}

function oneShotSlotTimeoutFailure(
  error: string,
  details: Record<string, unknown>,
): ClassifiedFailure {
  const failure = classifyFailure(new Error(error), {
    module: 'internal-agent-run-once',
    action: 'wait_for_one_shot_slot',
    defaultType: 'timeout',
    defaultSubtype: 'one_shot_agent_slot_timeout',
    defaultOrigin: 'container',
    retryable: true,
  });
  return {
    ...failure,
    details: {
      ...(failure.details || {}),
      ...details,
    },
  };
}

function fallbackRunOnceFailure(error: string): ClassifiedFailure {
  return classifyFailure(new Error(error), {
    module: 'internal-agent-run-once',
    action: 'run_once',
    defaultType: 'container_runtime_error',
    defaultSubtype: 'internal_run_once_failed',
    defaultOrigin: 'container',
    retryable: true,
  });
}

export class InternalAgentRunOnceService {
  constructor(private readonly opts: InternalAgentRunOnceServiceOptions) {}

  resolveGroupFolder(chatJid: string): string {
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      throw new RunOnceInputError(`Registered group not found: ${chatJid}`);
    }
    return group.folder;
  }

  async runOnce(input: RunOnceRequestInput): Promise<RunOnceResponse> {
    const request = parseRunOnceRequest(input);
    const group = this.opts.registeredGroups()[request.chat_jid];
    if (!group) {
      throw new RunOnceInputError(
        `Registered group not found: ${request.chat_jid}`,
      );
    }

    const inputLength = runOnceInputLength(request);
    if (inputLength > this.opts.maxInputChars) {
      throw new RunOnceInputError(
        `system + messages length exceeds limit (${inputLength}/${this.opts.maxInputChars})`,
      );
    }

    const [message] = request.messages;
    if (message.role !== 'user') {
      throw new RunOnceInputError('unsupported messages shape');
    }

    const runId = createExecutionId();
    const queryId = createExecutionId();
    const userPrompt = message.content;
    const prompt = buildPromptWithFiles(userPrompt, request.files);
    const promptHash = sha256(`${request.system}\n${prompt}`);
    const selectedModel = await selectModel({
      prompt,
      isMain: group.isMain === true,
    });
    const traceWriter = createRunOnceTraceWriter({
      groupFolder: group.folder,
      chatJid: request.chat_jid,
      request,
      runId,
      queryId,
      selectedModel: selectedModel.selectedModel,
      selectedModelReason: selectedModel.reason,
    });

    agentQueryTraceManager.startQuery({
      queryId,
      runId,
      sourceType: 'internal_run_once',
      sourceRefId:
        typeof request.metadata.trace_id === 'string'
          ? request.metadata.trace_id
          : undefined,
      chatJid: request.chat_jid,
      groupFolder: group.folder,
      selectedModel: selectedModel.selectedModel,
      selectedModelReason: selectedModel.reason,
      promptSummary: userPrompt.slice(0, 140),
      promptHash,
    });

    const inputStepId = agentQueryTraceManager.startStep({
      queryId,
      stepType: 'input',
      stepName: 'internal_run_once_received',
      summary: 'Internal run-once request received',
      payload: {
        chatJid: request.chat_jid,
        systemChars: request.system.length,
        messageChars: userPrompt.length,
        injectedPromptChars: prompt.length,
        files: request.files,
        metadata: request.metadata,
      },
    });
    agentQueryTraceManager.completeStep(queryId, inputStepId, 'success');

    const modelStepId = agentQueryTraceManager.startStep({
      queryId,
      stepType: 'model_select',
      stepName: 'select_model',
      summary: 'Selecting execution model',
    });
    agentQueryTraceManager.completeStep(
      queryId,
      modelStepId,
      'success',
      `Selected ${selectedModel.selectedModel}`,
    );

    const executionStepId = agentQueryTraceManager.startStep({
      queryId,
      stepType: 'agent_execution',
      stepName: 'run_external_system_once',
      summary: 'Starting internal run-once execution',
      payload: {
        executionMode: 'external_system_once',
        isolatedSession: true,
      },
    });

    const outputs: string[] = [];
    let resultDeliveryStepId: string | null = null;
    let executionError: string | undefined;
    let executionFailure: ClassifiedFailure | undefined;
    let eventMarkerCount = 0;
    let resultMarkerCount = 0;
    let selectedOrActualModel = selectedModel.selectedModel;
    let closeRequested = false;

    const handleOutput = async (output: ContainerOutput): Promise<void> => {
      traceWriter.recordOutput(output);
      if (output.selectedModel) selectedOrActualModel = output.selectedModel;
      if (output.event) {
        eventMarkerCount += 1;
        const patch = queryPatchFromTraceEvent(output.event);
        if (Object.keys(patch).length > 0) {
          agentQueryTraceManager.updateQuery(queryId, patch);
          if (patch.actual_model) selectedOrActualModel = patch.actual_model;
        }
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: resultDeliveryStepId || executionStepId,
          eventType: output.event.type,
          eventName: output.event.name,
          status: output.event.status ?? null,
          summary: output.event.summary ?? null,
          payload: output.event.payload,
        });
      }
      if (output.status === 'error') {
        executionError = output.error || executionError;
        executionFailure = output.failure || executionFailure;
        traceWriter.recordError(
          output.error || 'Internal run-once execution failed',
          output.failure,
        );
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: resultDeliveryStepId || executionStepId,
          eventType: 'error',
          eventName: 'query_failed',
          status: 'error',
          summary: output.error || 'Internal run-once execution failed',
          payload: {
            error: output.error,
            ...(output.failure ? toFailureEventPayload(output.failure) : {}),
          },
        });
      }
      if (output.result) {
        resultMarkerCount += 1;
        outputs.push(output.result);
        if (!resultDeliveryStepId) {
          agentQueryTraceManager.completeStep(
            queryId,
            executionStepId,
            'success',
            'Agent produced output',
          );
          resultDeliveryStepId = agentQueryTraceManager.startStep({
            queryId,
            stepType: 'result_delivery',
            stepName: 'collect_result',
            summary: 'Collecting internal run-once result',
          });
        }
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: resultDeliveryStepId,
          eventType: 'output',
          eventName: 'assistant_output',
          status: 'success',
          summary: `Output: ${output.result.slice(0, 120)}`,
          payload: { text: output.result },
        });
        if (!closeRequested) {
          closeRequested = true;
          this.opts.queue.closeStdin(request.chat_jid, {
            reason: 'internal_run_once_first_result',
            details: { runId, queryId },
          });
        }
      }
    };

    let status: 'success' | 'error' = 'error';
    this.opts.addOneShotTraceContext?.(request.chat_jid, {
      queryId,
      stepId: executionStepId,
      runId,
      traceKey: queryId,
    });
    try {
      status = await this.opts.queue.runOneShot(
        request.chat_jid,
        {
          groupFolder: group.folder,
          groupName: group.name,
          promptSummary: userPrompt.slice(0, 100),
          lastSender: 'internal-agent-run-once',
          lastContent: userPrompt.slice(0, 200),
          lastTime: Date.now().toString(),
          isTask: true,
          traceKey: queryId,
          dedupeKey: `internal-run-once:${queryId}`,
        },
        async () => {
          const output = await runContainerAgent(
            group,
            {
              prompt,
              system: request.system,
              runId,
              queryId,
              requireResult: request.require_result,
              isolatedSession: true,
              executionMode: 'external_system_once',
              groupFolder: group.folder,
              chatJid: request.chat_jid,
              isMain: group.isMain === true,
              selectedModel: selectedModel.selectedModel,
              isOneShot: true,
            },
            (proc, containerName) =>
              this.opts.onProcess(
                request.chat_jid,
                proc,
                containerName,
                group.folder,
              ),
            handleOutput,
          );
          if (output.status === 'error') {
            executionError = output.error || executionError;
            executionFailure = output.failure || executionFailure;
            return 'error';
          }
          return 'success';
        },
      );
    } catch (err) {
      executionError =
        err instanceof Error ? err.message : 'Internal run-once failed';
      executionFailure = executionError.includes('Agent busy timeout')
        ? oneShotSlotTimeoutFailure(executionError, {
            chatJid: request.chat_jid,
            runId,
            queryId,
          })
        : fallbackRunOnceFailure(executionError);
      status = 'error';
    } finally {
      this.opts.removeOneShotTraceContext?.(request.chat_jid, queryId);
      clearModelResolutionsForRun(runId);
    }

    const text = outputs.join('\n').trim();
    if (status === 'success' && text) {
      if (resultDeliveryStepId) {
        agentQueryTraceManager.completeStep(
          queryId,
          resultDeliveryStepId,
          'success',
        );
      }
      agentQueryTraceManager.finishQuery(queryId, 'success', {
        output_preview: text.slice(0, 500),
      });
      traceWriter.finalize({
        status: 'success',
        actualModel: selectedOrActualModel,
        agentTrace: buildAgentQueryTraceDetail(queryId),
        response: {
          ok: true,
          text,
        },
      });
      return {
        ok: true,
        text,
        run_id: runId,
        query_id: queryId,
        model: selectedOrActualModel,
        trace_path: traceWriter.containerPath,
      };
    }

    const error =
      executionError ||
      (request.require_result
        ? `Internal run-once completed without text result (events=${eventMarkerCount}, text results=${resultMarkerCount})`
        : 'Internal run-once completed without output');
    const failure = executionFailure || fallbackRunOnceFailure(error);
    logger.warn(
      {
        chatJid: request.chat_jid,
        runId,
        queryId,
        error,
        failure,
      },
      'Internal run-once failed',
    );
    agentQueryTraceManager.completeStep(queryId, executionStepId, 'error');
    if (resultDeliveryStepId) {
      agentQueryTraceManager.completeStep(
        queryId,
        resultDeliveryStepId,
        'error',
      );
    }
    agentQueryTraceManager.finishQuery(queryId, 'error', {
      ...toAgentQueryFailurePatch(failure, error),
      output_preview: text.slice(0, 500) || null,
    });
    traceWriter.finalize({
      status: 'error',
      actualModel: selectedOrActualModel,
      agentTrace: buildAgentQueryTraceDetail(queryId),
      response: {
        ok: false,
        error,
        failure,
      },
    });
    return {
      ok: false,
      error,
      failure,
      run_id: runId,
      query_id: queryId,
      trace_path: traceWriter.containerPath,
    };
  }
}
