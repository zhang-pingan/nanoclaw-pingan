import { describe, expect, it } from 'vitest';

import {
  buildCardActionPayload,
  buildCardStringFormValues,
} from './card-action-payload.js';

describe('card-action-payload', () => {
  it('prefers nested payload JSON over legacy flat form values', () => {
    expect(
      buildCardActionPayload({
        action: 'workflow_interrupt_resume',
        resume_action: 'submit',
        payload: JSON.stringify({ answer: 'nested', count: 2 }),
        answer: 'flat',
      }),
    ).toEqual({ answer: 'nested', count: 2 });
  });

  it('falls back to flat values with reserved fields removed', () => {
    expect(
      buildCardActionPayload({
        action: 'workflow_interrupt_resume',
        answer: 'flat',
        resume_action: 'submit',
      }),
    ).toEqual({});
  });

  it('filters nested string form values for ask handlers', () => {
    expect(
      buildCardStringFormValues({
        payload: JSON.stringify({ answer: 'A', count: 2, extra: 'ok' }),
      }),
    ).toEqual({ answer: 'A', extra: 'ok' });
  });
});
