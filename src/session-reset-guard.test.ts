import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetSessionResetGuardForTests,
  bumpSessionResetEpoch,
  getSessionResetEpoch,
  isSessionResetEpochCurrent,
} from './session-reset-guard.js';

describe('session reset guard', () => {
  beforeEach(() => {
    _resetSessionResetGuardForTests();
  });

  it('keeps normal session writes current while no reset occurs', () => {
    const epoch = getSessionResetEpoch('web_main');

    expect(isSessionResetEpochCurrent('web_main', epoch)).toBe(true);
  });

  it('invalidates session writes from runs started before reset', () => {
    const staleEpoch = getSessionResetEpoch('web_main');

    bumpSessionResetEpoch('web_main');

    expect(isSessionResetEpochCurrent('web_main', staleEpoch)).toBe(false);
    expect(isSessionResetEpochCurrent('web_main', staleEpoch + 1)).toBe(true);
  });

  it('tracks resets independently per agent folder', () => {
    const mainEpoch = getSessionResetEpoch('web_main');
    const opsEpoch = getSessionResetEpoch('web_ops');

    bumpSessionResetEpoch('web_main');

    expect(isSessionResetEpochCurrent('web_main', mainEpoch)).toBe(false);
    expect(isSessionResetEpochCurrent('web_ops', opsEpoch)).toBe(true);
  });
});
