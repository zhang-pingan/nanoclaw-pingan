import { describe, expect, it } from 'vitest';

import {
  canDelegateToFolder,
  getFolderChannel,
  isAllowedCrossChannelDelegationTargetFolder,
  parseDelegationTargetChannels,
} from './delegation-policy.js';

describe('delegation policy', () => {
  it('extracts channel prefixes from agent folders', () => {
    expect(getFolderChannel('wecom_user_zhangsan')).toBe('wecom');
    expect(getFolderChannel('web_main')).toBe('web');
    expect(getFolderChannel('')).toBe('');
  });

  it('parses cross-channel target allowlist values', () => {
    expect(
      [...parseDelegationTargetChannels(' wecom, Feishu ,, ')].sort(),
    ).toEqual(['feishu', 'wecom']);
  });

  it('allows same-channel delegation without cross-channel allowlist', () => {
    expect(canDelegateToFolder('web_main', 'web_ops', new Set<string>())).toBe(
      true,
    );
  });

  it('allows cross-channel delegation to allowlisted target channels', () => {
    const allowed = new Set(['wecom']);
    expect(canDelegateToFolder('web_main', 'wecom_user_ops', allowed)).toBe(
      true,
    );
    expect(
      isAllowedCrossChannelDelegationTargetFolder('wecom_user_ops', allowed),
    ).toBe(true);
  });

  it('rejects cross-channel delegation to non-allowlisted target channels', () => {
    expect(
      canDelegateToFolder('web_main', 'feishu_ops', new Set(['wecom'])),
    ).toBe(false);
  });
});
