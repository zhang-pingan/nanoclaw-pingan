import type { ContainerOutput } from './container-runner.js';
import type { AgentQueryRecord } from './types.js';

function numberFromPayload(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

export function queryPatchFromTraceEvent(
  event: NonNullable<ContainerOutput['event']>,
): Partial<AgentQueryRecord> {
  const payload = event.payload || {};
  const category =
    typeof payload.category === 'string' ? payload.category : event.type;
  const traceSource =
    typeof payload.traceSource === 'string' ? payload.traceSource : undefined;
  const patch: Partial<AgentQueryRecord> = {};

  if (category === 'container') {
    if (typeof payload.containerName === 'string') {
      patch.container_name = payload.containerName;
    }
    if (typeof payload.runtime === 'string') {
      patch.container_runtime = payload.runtime;
    }
    const exitCode = numberFromPayload(payload.exitCode);
    if (exitCode !== undefined) patch.container_exit_code = exitCode;
    const timeoutMs = numberFromPayload(payload.timeoutMs);
    if (timeoutMs !== undefined) patch.container_timeout_ms = timeoutMs;
    if (typeof payload.terminatedReason === 'string') {
      patch.container_terminated_reason = payload.terminatedReason;
    }
  }

  if (category === 'model') {
    const isProxyConfirmedModel =
      traceSource === 'credential_proxy' &&
      (event.name === 'model_resolution' ||
        event.name === 'model_response_completed');
    if (typeof payload.actualModel === 'string' && isProxyConfirmedModel) {
      patch.actual_model = payload.actualModel;
    }
    const inputTokens = numberFromPayload(payload.inputTokens);
    if (inputTokens !== undefined) patch.input_tokens = inputTokens;
    const outputTokens = numberFromPayload(payload.outputTokens);
    if (outputTokens !== undefined) patch.output_tokens = outputTokens;
    const cacheReadTokens = numberFromPayload(payload.cacheReadTokens);
    if (cacheReadTokens !== undefined)
      patch.cache_read_tokens = cacheReadTokens;
    const cacheWriteTokens = numberFromPayload(payload.cacheWriteTokens);
    if (cacheWriteTokens !== undefined) {
      patch.cache_write_tokens = cacheWriteTokens;
    }
  }

  if (category === 'evaluation' && typeof payload.status === 'string') {
    patch.artifact_contract_status = payload.status;
  }

  return patch;
}
