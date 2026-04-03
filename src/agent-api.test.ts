import { afterEach, describe, expect, it, vi } from 'vitest';

import { callAnthropicMessages } from './agent-api.js';

describe('callAnthropicMessages', () => {
  const oldEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...oldEnv };
    vi.restoreAllMocks();
  });

  it('calls anthropic messages endpoint using env config', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_BASE_URL = 'https://example.test/api/';
    process.env.NANOCLAW_AGENT_API_MODEL = 'claude-test';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'claude-test',
        content: [{ type: 'text', text: '{"ok":true}' }],
      }),
    });

    const res = await callAnthropicMessages(
      {
        system: 'system prompt',
        messages: [{ role: 'user', content: 'hello' }],
      },
      fetchMock as unknown as typeof fetch,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/api/v1/messages');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'sk-test',
        'anthropic-version': '2023-06-01',
      },
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'claude-test',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res).toEqual({
      text: '{"ok":true}',
      raw: {
        model: 'claude-test',
        content: [{ type: 'text', text: '{"ok":true}' }],
      },
      model: 'claude-test',
    });
  });

  it('throws when api key is missing', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    process.env.ANTHROPIC_BASE_URL = 'https://example.test';

    await expect(
      callAnthropicMessages(
        {
          messages: [{ role: 'user', content: 'hello' }],
        },
        vi.fn() as unknown as typeof fetch,
      ),
    ).rejects.toThrow('ANTHROPIC_API_KEY is required');
  });

  it('throws on non-ok responses', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    process.env.ANTHROPIC_BASE_URL = 'https://example.test';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
    });

    await expect(
      callAnthropicMessages(
        {
          messages: [{ role: 'user', content: 'hello' }],
        },
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow('Anthropic API request failed with status 502');
  });
});
