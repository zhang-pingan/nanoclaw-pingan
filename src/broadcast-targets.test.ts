import { describe, expect, it } from 'vitest';

import { resolveBroadcastTargetJids } from './broadcast-targets.js';
import type { RegisteredGroup } from './types.js';

describe('resolveBroadcastTargetJids', () => {
  const groups: Record<string, RegisteredGroup> = {
    'feishu:oc_1': {
      name: '研发群',
      folder: 'dev',
      trigger: '@bot',
      added_at: '1',
    },
    'feishu:oc_2': {
      name: '主群',
      folder: 'main',
      trigger: '',
      added_at: '1',
    },
  };

  it('resolves target keys by jid, folder, and name', () => {
    expect(
      resolveBroadcastTargetJids(['feishu:oc_1', 'main', '研发群'], groups),
    ).toEqual(['feishu:oc_1', 'feishu:oc_2']);
  });
});
