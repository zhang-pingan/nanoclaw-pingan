import { afterEach, describe, expect, it, vi } from 'vitest';

const mockEnv: Record<string, string> = {};

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ ...mockEnv })),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

import { resolveCredentialProxyExecutionModel } from './credential-proxy.js';

describe('resolveCredentialProxyExecutionModel', () => {
  afterEach(() => {
    for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  });

  it('uses the OpenAI compat model when compat is enabled', () => {
    Object.assign(mockEnv, {
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      CREDENTIAL_PROXY_OPENAI_MODEL: 'gpt-5.4',
    });

    expect(resolveCredentialProxyExecutionModel('claude-sonnet-4-6')).toBe(
      'gpt-5.4',
    );
  });

  it('uses the proxy override model when set', () => {
    Object.assign(mockEnv, {
      ANTHROPIC_CLAUDE_MODEL: 'gpt-4o',
    });

    expect(resolveCredentialProxyExecutionModel('claude-sonnet-4-6')).toBe(
      'gpt-4o',
    );
  });

  it('falls back to the requested model when no proxy rewrite is configured', () => {
    expect(resolveCredentialProxyExecutionModel('claude-sonnet-4-6')).toBe(
      'claude-sonnet-4-6',
    );
  });
});
