import { describe, expect, it } from 'vitest';

import { codexThreadDeepLink } from './codex-thread-link.js';

describe('Codex desktop thread links', () => {
  it('targets an existing local conversation route', () => {
    expect(codexThreadDeepLink('019fd4ab-e115-71d3-91a6-4462cbcc2952')).toBe(
      'codex://threads/019fd4ab-e115-71d3-91a6-4462cbcc2952',
    );
  });

  it.each([
    null,
    '',
    'thread-short',
    '019fd4ab-e115-71d3-91a6-4462cbcc2952/../../settings',
    '019fd4ab-e115-71d3-91a6-4462cbcc2952?prompt=dispatch',
  ])('rejects invalid or injectable thread ids: %s', (threadId) => {
    expect(codexThreadDeepLink(threadId)).toBeNull();
  });
});
