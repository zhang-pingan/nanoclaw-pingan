import type { ClassifiedFailure } from './failure-taxonomy.js';

export interface OneShotAgentResult {
  ok: boolean;
  text: string;
  outputs: string[];
  error?: string;
  failure?: ClassifiedFailure;
}

export interface OneShotEmptyOutputDiagnostics {
  resultMarkerCount?: number;
  eventMarkerCount?: number;
  sessionOnlyMarkerCount?: number;
  errorMarkerCount?: number;
}

export function buildOneShotEmptyOutputError(
  diagnostics: OneShotEmptyOutputDiagnostics = {},
): string {
  const details: string[] = [];
  if (diagnostics.sessionOnlyMarkerCount) {
    details.push(`session-only markers=${diagnostics.sessionOnlyMarkerCount}`);
  }
  if (diagnostics.eventMarkerCount) {
    details.push(`event markers=${diagnostics.eventMarkerCount}`);
  }
  if (diagnostics.errorMarkerCount) {
    details.push(`error markers=${diagnostics.errorMarkerCount}`);
  }
  if (diagnostics.resultMarkerCount) {
    details.push(`text result markers=${diagnostics.resultMarkerCount}`);
  }

  return details.length
    ? `One-shot agent completed without text result (${details.join(', ')})`
    : 'One-shot agent completed without output';
}

export function finalizeOneShotAgentResult(input: {
  status: 'success' | 'error';
  outputs: string[];
  executionError?: string;
  emptyOutputError?: string;
  failure?: ClassifiedFailure;
}): OneShotAgentResult {
  const text = input.outputs.join('\n').trim();
  if (input.status === 'error') {
    return {
      ok: false,
      text,
      outputs: input.outputs,
      error: text || input.executionError || 'One-shot agent execution failed',
      failure: input.failure,
    };
  }
  if (!text) {
    return {
      ok: false,
      text,
      outputs: input.outputs,
      error:
        input.executionError ||
        input.emptyOutputError ||
        'One-shot agent completed without output',
      failure: input.failure,
    };
  }
  return { ok: true, text, outputs: input.outputs };
}
