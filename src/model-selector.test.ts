import { afterEach, describe, expect, it, vi } from 'vitest';

const { readEnvFileMock } = vi.hoisted(() => ({
  readEnvFileMock: vi.fn(),
}));

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

describe('model-selector', () => {
  afterEach(() => {
    readEnvFileMock.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.CREDENTIAL_PROXY_OPENAI_COMPAT;
    delete process.env.ICARUS_MODEL_LIGHT;
    delete process.env.ICARUS_MODEL_FORCE;
  });

  it('forces the light model before calling selector api when compat is enabled', async () => {
    readEnvFileMock.mockReturnValue({
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      ICARUS_MODEL_LIGHT: 'claude-haiku-test',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { selectModel } = await import('./model-selector.js');

    await expect(
      selectModel({
        prompt: 'please analyze this code path',
        isMain: true,
      }),
    ).resolves.toEqual({
      selectedModel: 'claude-haiku-test',
      reason: 'openai_compat',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still lets forced model override compat mode', async () => {
    readEnvFileMock.mockReturnValue({
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      ICARUS_MODEL_LIGHT: 'claude-haiku-test',
      ICARUS_MODEL_FORCE: 'claude-force-test',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { selectModel } = await import('./model-selector.js');

    await expect(
      selectModel({
        prompt: 'any prompt',
        isMain: false,
      }),
    ).resolves.toEqual({
      selectedModel: 'claude-force-test',
      reason: 'forced',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ignores legacy NanoClaw model env keys', async () => {
    readEnvFileMock.mockReturnValue({
      CREDENTIAL_PROXY_OPENAI_COMPAT: 'true',
      NANOCLAW_MODEL_LIGHT: 'legacy-haiku',
      NANOCLAW_MODEL_FORCE: 'legacy-force',
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { selectModel } = await import('./model-selector.js');

    await expect(
      selectModel({
        prompt: 'please summarize this',
        isMain: false,
      }),
    ).resolves.toEqual({
      selectedModel: 'claude-haiku-4-5-20251001',
      reason: 'openai_compat',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readEnvFileMock.mock.calls[0]?.[0]).not.toContain(
      'NANOCLAW_MODEL_LIGHT',
    );
  });
});
