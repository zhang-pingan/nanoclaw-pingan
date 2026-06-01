import { describe, expect, it } from 'vitest';

import { getWorkflowActionHandler } from './index.js';
import { findServiceTestToken } from './service.js';

describe('service workflow actions', () => {
  it('finds top-level service testToken first', () => {
    expect(
      findServiceTestToken(
        {
          catstory: {
            testToken: ' top-level-token ',
            staging: { testToken: 'staging-token' },
          },
        },
        'catstory',
      ),
    ).toBe('top-level-token');
  });

  it('falls back to staging testToken', () => {
    expect(
      findServiceTestToken(
        {
          catstory: {
            staging: { testToken: ' staging-token ' },
          },
        },
        'catstory',
      ),
    ).toBe('staging-token');
  });

  it('keeps token out of action output', () => {
    const handler = getWorkflowActionHandler('service.test_token');
    expect(handler).toBeDefined();

    const result = handler!.run({
      workflow: { service: 'missing-service' } as never,
      stateKey: 'testing_token_router',
      params: {},
      context: {},
      steps: {},
    });

    expect(JSON.stringify(result.output || {})).not.toContain('access_token');
    expect(JSON.stringify(result.output || {})).not.toContain('testToken');
  });
});
