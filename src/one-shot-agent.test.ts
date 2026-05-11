import { describe, expect, it } from 'vitest';

import { finalizeOneShotAgentResult } from './one-shot-agent.js';

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
});
