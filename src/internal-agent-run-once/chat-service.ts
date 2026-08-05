import { ChildProcess } from 'child_process';
import crypto from 'crypto';

import { agentQueryTraceManager } from '../agent-query-trace.js';
import { queryPatchFromTraceEvent } from '../agent-query-trace-utils.js';
import { ContainerOutput, runContainerAgent } from '../container-runner.js';
import {
  ClassifiedFailure,
  classifyFailure,
  toAgentQueryFailurePatch,
  toFailureEventPayload,
} from '../failure-taxonomy.js';
import { AgentQueue } from '../agent-queue.js';
import { logger } from '../logger.js';
import { clearModelResolutionsForRun } from '../model-resolution.js';
import { selectModel } from '../model-selector.js';
import { stripInternalTags } from '../router.js';
import type { RegisteredAgent } from '../types.js';
import {
  agentChatInputLength,
  AgentChatRequestInput,
  AgentChatResponse,
  parseAgentChatRequest,
} from './chat-schemas.js';
import { RunOnceInputError } from './service.js';

export interface InternalAgentChatServiceOptions {
  registeredAgents: () => Record<string, RegisteredAgent>;
  queue: AgentQueue;
  onProcess: (
    agentJid: string,
    proc: ChildProcess,
    containerName: string,
    agentFolder: string,
  ) => void;
  maxInputChars: number;
}

function createExecutionId(): string {
  return crypto.randomUUID();
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function fallbackChatFailure(error: string): ClassifiedFailure {
  return classifyFailure(new Error(error), {
    module: 'internal-agent-chat',
    action: 'chat',
    defaultType: 'container_runtime_error',
    defaultSubtype: 'internal_agent_chat_failed',
    defaultOrigin: 'container',
    retryable: true,
  });
}

function chatSlotTimeoutFailure(
  error: string,
  details: Record<string, unknown>,
): ClassifiedFailure {
  const failure = classifyFailure(new Error(error), {
    module: 'internal-agent-chat',
    action: 'wait_for_chat_slot',
    defaultType: 'timeout',
    defaultSubtype: 'agent_chat_slot_timeout',
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

export class InternalAgentChatService {
  constructor(private readonly opts: InternalAgentChatServiceOptions) {}

  async chat(input: AgentChatRequestInput): Promise<AgentChatResponse> {
    const request = parseAgentChatRequest(input);
    const agent = this.opts.registeredAgents()[request.chat_jid];
    if (!agent) {
      throw new RunOnceInputError(
        `Registered Agent not found: ${request.chat_jid}`,
      );
    }

    const inputLength = agentChatInputLength(request);
    if (inputLength > this.opts.maxInputChars) {
      throw new RunOnceInputError(
        `agent chat input length exceeds limit (${inputLength}/${this.opts.maxInputChars})`,
      );
    }

    const prompt = request.message;
    const system = request.system;
    const systemForHash = system || '';
    const runId = createExecutionId();
    const queryId = createExecutionId();
    const selectedModel = await selectModel({
      prompt,
      isMain: agent.isMain === true,
    });
    const promptHash = sha256(`${systemForHash}\n${prompt}`);

    agentQueryTraceManager.startQuery({
      queryId,
      runId,
      sourceType: 'internal_agent_chat',
      sourceRefId:
        typeof request.metadata.trace_id === 'string'
          ? request.metadata.trace_id
          : undefined,
      chatJid: request.chat_jid,
      agentFolder: agent.folder,
      selectedModel: selectedModel.selectedModel,
      selectedModelReason: selectedModel.reason,
      promptSummary: request.message.slice(0, 140),
      promptHash,
    });

    const inputStepId = agentQueryTraceManager.startStep({
      queryId,
      stepType: 'input',
      stepName: 'internal_agent_chat_received',
      summary: 'Internal agent chat request received',
      payload: {
        chatJid: request.chat_jid,
        sessionId: request.session_id || null,
        messageChars: request.message.length,
        injectedPromptChars: prompt.length,
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
      stepName: 'run_internal_agent_chat',
      summary: 'Starting internal agent chat execution',
      payload: {
        sessionId: request.session_id || null,
      },
    });

    const outputs: string[] = [];
    let resultDeliveryStepId: string | null = null;
    let executionError: string | undefined;
    let executionFailure: ClassifiedFailure | undefined;
    let selectedOrActualModel = selectedModel.selectedModel;
    let sessionId = request.session_id;
    let resultMarkerCount = 0;
    let eventMarkerCount = 0;
    let closeRequested = false;

    const handleOutput = async (output: ContainerOutput): Promise<void> => {
      if (output.newSessionId) sessionId = output.newSessionId;
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
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: resultDeliveryStepId || executionStepId,
          eventType: 'error',
          eventName: 'query_failed',
          status: 'error',
          summary: output.error || 'Internal agent chat failed',
          payload: {
            error: output.error,
            ...(output.failure ? toFailureEventPayload(output.failure) : {}),
          },
        });
      }
      if (output.result) {
        resultMarkerCount += 1;
        const raw = String(output.result);
        const text = stripInternalTags(raw);
        if (text) outputs.push(text);
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
            summary: 'Collecting internal agent chat result',
          });
        }
        agentQueryTraceManager.appendEvent({
          queryId,
          stepId: resultDeliveryStepId,
          eventType: 'output',
          eventName: 'assistant_output',
          status: 'success',
          summary: text ? `Output: ${text.slice(0, 120)}` : 'Received output',
          payload: { text, rawLength: raw.length },
        });
        if (!closeRequested) {
          closeRequested = true;
          this.opts.queue.closeStdin(request.chat_jid, {
            reason: 'internal_agent_chat_first_result',
            details: { runId, queryId },
          });
        }
      }
    };

    let status: 'success' | 'error' = 'error';
    try {
      status = await this.opts.queue.runOneShot(
        request.chat_jid,
        {
          agentFolder: agent.folder,
          agentName: agent.name,
          promptSummary: request.message.slice(0, 100),
          lastSender: 'internal-agent-chat',
          lastContent: request.message.slice(0, 200),
          lastTime: Date.now().toString(),
          isTask: false,
          traceKey: queryId,
          dedupeKey: `internal-agent-chat:${queryId}`,
        },
        async () => {
          const output = await runContainerAgent(
            agent,
            {
              prompt,
              system,
              sessionId: request.session_id,
              runId,
              queryId,
              requireResult: true,
              isolatedSession: false,
              agentFolder: agent.folder,
              chatJid: request.chat_jid,
              isMain: agent.isMain === true,
              selectedModel: selectedModel.selectedModel,
              isOneShot: true,
            },
            (proc, containerName) =>
              this.opts.onProcess(
                request.chat_jid,
                proc,
                containerName,
                agent.folder,
              ),
            handleOutput,
          );
          if (output.newSessionId) sessionId = output.newSessionId;
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
        err instanceof Error ? err.message : 'Internal agent chat failed';
      executionFailure = executionError.includes('Agent busy timeout')
        ? chatSlotTimeoutFailure(executionError, {
            chatJid: request.chat_jid,
            runId,
            queryId,
          })
        : fallbackChatFailure(executionError);
      status = 'error';
    } finally {
      clearModelResolutionsForRun(runId);
    }

    const text = outputs.join('\n').trim();
    if (status === 'success' && text && sessionId) {
      if (resultDeliveryStepId) {
        agentQueryTraceManager.completeStep(
          queryId,
          resultDeliveryStepId,
          'success',
        );
      }
      agentQueryTraceManager.finishQuery(queryId, 'success', {
        output_preview: text.slice(0, 500),
        session_id: sessionId,
        actual_model: selectedOrActualModel,
      });
      return {
        ok: true,
        text,
        session_id: sessionId,
        run_id: runId,
        query_id: queryId,
        model: selectedOrActualModel,
      };
    }

    const error =
      executionError ||
      (!sessionId
        ? 'Internal agent chat completed without session id'
        : `Internal agent chat completed without text result (events=${eventMarkerCount}, text results=${resultMarkerCount})`);
    const failure = executionFailure || fallbackChatFailure(error);
    logger.warn(
      {
        chatJid: request.chat_jid,
        runId,
        queryId,
        error,
        failure,
      },
      'Internal agent chat failed',
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
    return {
      ok: false,
      error,
      failure,
      session_id: sessionId,
      run_id: runId,
      query_id: queryId,
    };
  }
}
