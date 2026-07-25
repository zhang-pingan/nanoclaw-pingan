import { describe, expect, it } from 'vitest';

import { checkFrozenGateOwnershipAuthority } from './frozen-gate-ownership-authority.js';

describe('frozen gate ownership authority', () => {
  it('preserves the exact historical ownership bytes and identity', () => {
    expect(checkFrozenGateOwnershipAuthority()).toMatchObject({
      hash: 'sha256:712a7440e83f087e4bbb1e465a1a677a16708429f46766029baa0f90734e5017',
      payload: {
        status: 'T6D_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION',
      },
    });
  });
});
