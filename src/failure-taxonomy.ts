import type { AgentQueryRecord } from './types.js';

export type FailureType =
  | 'model_api_error'
  | 'model_output_invalid'
  | 'container_runtime_error'
  | 'sandbox_error'
  | 'tool_error'
  | 'tool_contract_error'
  | 'timeout'
  | 'routing_error'
  | 'workflow_transition_error'
  | 'evaluator_error'
  | 'invalid_input'
  | 'invalid_config'
  | 'permission_error'
  | 'db_error'
  | 'unknown_error';

export type FailureOrigin =
  | 'model'
  | 'tool'
  | 'scheduler'
  | 'workflow'
  | 'router'
  | 'container'
  | 'db'
  | 'web'
  | 'system';

export interface ClassifiedFailure {
  failureType: FailureType;
  failureSubtype?: string;
  failureOrigin: FailureOrigin;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ClassifyFailureContext {
  module: string;
  action?: string;
  workflowId?: string;
  stageKey?: string;
  defaultType?: FailureType;
  defaultSubtype?: string;
  defaultOrigin?: FailureOrigin;
  retryable?: boolean;
}

type ErrorRecord = Record<string, unknown>;

function asErrorRecord(err: unknown): ErrorRecord | null {
  return err && typeof err === 'object' ? (err as ErrorRecord) : null;
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function getStringProp(record: ErrorRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function getNumberProp(record: ErrorRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function retryableForHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function defaultRetryableForType(type: FailureType): boolean {
  return (
    type === 'model_api_error' ||
    type === 'timeout' ||
    type === 'container_runtime_error' ||
    type === 'db_error' ||
    type === 'unknown_error'
  );
}

function withContextDetails(
  context: ClassifyFailureContext,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    module: context.module,
    ...(context.action ? { action: context.action } : {}),
    ...(context.workflowId ? { workflowId: context.workflowId } : {}),
    ...(context.stageKey ? { stageKey: context.stageKey } : {}),
    ...details,
  };
}

function fromDefaults(context: ClassifyFailureContext): ClassifiedFailure {
  const failureType = context.defaultType ?? 'unknown_error';
  return {
    failureType,
    failureSubtype: context.defaultSubtype,
    failureOrigin: context.defaultOrigin ?? 'system',
    retryable: context.retryable ?? defaultRetryableForType(failureType),
    details: withContextDetails(context),
  };
}

function parseStatusFromMessage(message: string): number | null {
  const match = /\bstatus\s+(\d{3})\b/i.exec(message);
  if (!match) return null;
  const status = Number.parseInt(match[1], 10);
  return Number.isFinite(status) ? status : null;
}

export function classifyFailure(
  err: unknown,
  context: ClassifyFailureContext,
): ClassifiedFailure {
  const record = asErrorRecord(err);
  const message = getErrorMessage(err);
  const normalizedMessage = message.toLowerCase();
  const name = getStringProp(record, 'name') ?? '';
  const code = getStringProp(record, 'code') ?? '';
  const status =
    getNumberProp(record, 'status') ?? parseStatusFromMessage(message);
  const subtype = getStringProp(record, 'failureSubtype');
  const provider = getStringProp(record, 'provider');

  if (name === 'AgentApiTimeoutError') {
    return {
      failureType: 'timeout',
      failureSubtype: 'model_fetch_timeout',
      failureOrigin: 'model',
      retryable: true,
      details: withContextDetails(context, {
        ...(provider ? { provider } : {}),
      }),
    };
  }

  if (
    name === 'AgentApiResponseError' ||
    subtype === 'model_empty_text' ||
    subtype === 'model_json_parse_failed' ||
    subtype === 'model_sse_invalid' ||
    subtype === 'openai_compat_response_invalid'
  ) {
    return {
      failureType: 'model_output_invalid',
      failureSubtype: subtype ?? 'model_output_invalid',
      failureOrigin: 'model',
      retryable: false,
      details: withContextDetails(context, {
        ...(provider ? { provider } : {}),
      }),
    };
  }

  if (
    name === 'OpenAiCompatRequestError' ||
    name === 'AnthropicRequestError' ||
    normalizedMessage.includes('api request failed with status')
  ) {
    const httpStatus = status ?? 0;
    return {
      failureType: 'model_api_error',
      failureSubtype: 'model_http_non_2xx',
      failureOrigin: 'model',
      retryable: httpStatus ? retryableForHttpStatus(httpStatus) : true,
      details: withContextDetails(context, {
        ...(httpStatus ? { status: httpStatus } : {}),
        ...(provider ? { provider } : {}),
      }),
    };
  }

  if (
    name === 'AbortError' ||
    code === 'ETIMEDOUT' ||
    /\b(timed out|timeout)\b/i.test(message)
  ) {
    return {
      failureType: 'timeout',
      failureSubtype: context.defaultSubtype ?? 'timeout',
      failureOrigin: context.defaultOrigin ?? 'system',
      retryable: context.retryable ?? true,
      details: withContextDetails(context),
    };
  }

  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    normalizedMessage.includes('permission denied') ||
    normalizedMessage.includes('operation not permitted')
  ) {
    const origin = context.defaultOrigin ?? 'system';
    return {
      failureType:
        origin === 'container' ? 'sandbox_error' : 'permission_error',
      failureSubtype:
        origin === 'container' ? 'sandbox_access_denied' : 'permission_denied',
      failureOrigin: origin,
      retryable: false,
      details: withContextDetails(context, { ...(code ? { code } : {}) }),
    };
  }

  if (normalizedMessage.includes('invalid group folder')) {
    return {
      failureType: 'invalid_input',
      failureSubtype: 'invalid_group_folder',
      failureOrigin: context.defaultOrigin ?? 'scheduler',
      retryable: false,
      details: withContextDetails(context),
    };
  }

  if (normalizedMessage.includes('group not found')) {
    return {
      failureType: 'invalid_input',
      failureSubtype: 'group_not_found',
      failureOrigin: context.defaultOrigin ?? 'scheduler',
      retryable: false,
      details: withContextDetails(context),
    };
  }

  return fromDefaults(context);
}

export function toAgentQueryFailurePatch(
  failure: ClassifiedFailure,
  errorMessage: string,
): Pick<
  AgentQueryRecord,
  | 'failure_type'
  | 'failure_subtype'
  | 'failure_origin'
  | 'failure_retryable'
  | 'error_message'
> {
  return {
    failure_type: failure.failureType,
    failure_subtype: failure.failureSubtype ?? null,
    failure_origin: failure.failureOrigin,
    failure_retryable: failure.retryable ? 1 : 0,
    error_message: errorMessage,
  };
}

export function toFailureEventPayload(
  failure: ClassifiedFailure,
): Record<string, unknown> {
  return {
    failure_type: failure.failureType,
    failure_subtype: failure.failureSubtype ?? null,
    failure_origin: failure.failureOrigin,
    failure_retryable: failure.retryable,
    ...(failure.details ? { failure_details: failure.details } : {}),
  };
}
