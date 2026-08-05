import { describe, expect, it } from 'vitest';

import { resolveBroadcastTargetJids } from './broadcast-targets.js';
import type { RegisteredAgent } from './types.js';

describe('resolveBroadcastTargetJids', () => {
  const agents: Record<string, RegisteredAgent> = {
    'feishu:oc_1': {
      name: '研发群',
      folder: 'dev',
      trigger: '@bot',
      added_at: '1',
    },
    'feishu:oc_2': {
      name: '主 Agent',
      folder: 'main',
      trigger: '',
      added_at: '1',
    },
  };

  it('resolves target keys by jid, folder, and name', () => {
    expect(
      resolveBroadcastTargetJids(['feishu:oc_1', 'main', '研发群'], agents),
    ).toEqual(['feishu:oc_1', 'feishu:oc_2']);
  });
});
