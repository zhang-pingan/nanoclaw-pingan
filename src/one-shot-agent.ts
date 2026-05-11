export interface OneShotAgentResult {
  ok: boolean;
  text: string;
  outputs: string[];
  error?: string;
}

export function finalizeOneShotAgentResult(input: {
  status: 'success' | 'error';
  outputs: string[];
  executionError?: string;
  emptyOutputError?: string;
}): OneShotAgentResult {
  const text = input.outputs.join('\n').trim();
  if (input.status === 'error') {
    return {
      ok: false,
      text,
      outputs: input.outputs,
      error: text || input.executionError || 'One-shot agent execution failed',
    };
  }
  if (!text) {
    return {
      ok: false,
      text,
      outputs: input.outputs,
      error: input.emptyOutputError || 'One-shot agent completed without output',
    };
  }
  return { ok: true, text, outputs: input.outputs };
}
