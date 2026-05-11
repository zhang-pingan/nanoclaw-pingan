import { describe, expect, it } from 'vitest';

import {
  buildOneShotEmptyOutputError,
  finalizeOneShotAgentResult,
} from './one-shot-agent.js';

describe('finalizeOneShotAgentResult', () => {
  it('returns success when the one-shot agent produced text output', () => {
    expect(
      finalizeOneShotAgentResult({
        status: 'success',
        outputs: ['{"ok":true}'],
      }),
    ).toEqual({
      ok: true,
      text: '{"ok":true}',
      outputs: ['{"ok":true}'],
    });
  });

  it('treats successful completion without text output as an error', () => {
    expect(
      finalizeOneShotAgentResult({
        status: 'success',
        outputs: [],
      }),
    ).toEqual({
      ok: false,
      text: '',
      outputs: [],
      error: 'One-shot agent completed without output',
    });
  });

  it('treats whitespace-only output as an error', () => {
    expect(
      finalizeOneShotAgentResult({
        status: 'success',
        outputs: ['   \n\t  '],
        emptyOutputError: 'empty',
      }),
    ).toEqual({
      ok: false,
      text: '',
      outputs: ['   \n\t  '],
      error: 'empty',
    });
  });

  it('preserves execution errors when no text output was produced', () => {
    const failure = {
      failureType: 'model_output_invalid',
      failureSubtype: 'agent_result_missing',
      failureOrigin: 'model',
      retryable: true,
    } as const;

    expect(
      finalizeOneShotAgentResult({
        status: 'success',
        outputs: [],
        executionError: 'Container completed without required text result',
        emptyOutputError: 'One-shot agent completed without text result',
        failure,
      }),
    ).toEqual({
      ok: false,
      text: '',
      outputs: [],
      error: 'Container completed without required text result',
      failure,
    });
  });

  it('preserves streamed error status even when final status is error', () => {
    const failure = {
      failureType: 'model_output_invalid',
      failureSubtype: 'agent_result_missing',
      failureOrigin: 'model',
      retryable: true,
    } as const;

    expect(
      finalizeOneShotAgentResult({
        status: 'error',
        outputs: [],
        executionError: 'SDK query ended without result message',
        failure,
      }),
    ).toEqual({
      ok: false,
      text: '',
      outputs: [],
      error: 'SDK query ended without result message',
      failure,
    });
  });

  it('includes marker diagnostics in empty-output errors', () => {
    expect(
      buildOneShotEmptyOutputError({
        eventMarkerCount: 3,
        sessionOnlyMarkerCount: 1,
      }),
    ).toBe(
      'One-shot agent completed without text result (session-only markers=1, event markers=3)',
    );
  });
});
