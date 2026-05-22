import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

async function loadContainerImage(): Promise<string> {
  vi.resetModules();
  const config = await import('./config.js');
  return config.CONTAINER_IMAGE;
}

describe('container image config', () => {
  afterEach(() => {
    delete process.env.CONTAINER_IMAGE;
    vi.resetModules();
  });

  it('defaults to the Icarus agent image', async () => {
    await expect(loadContainerImage()).resolves.toBe('icarus-agent:latest');
  });

  it('allows Icarus agent image tags', async () => {
    process.env.CONTAINER_IMAGE = 'icarus-agent:debug';

    await expect(loadContainerImage()).resolves.toBe('icarus-agent:debug');
  });

  it('allows registry-qualified Icarus agent images', async () => {
    process.env.CONTAINER_IMAGE =
      'registry.example.com/team/icarus-agent:latest';

    await expect(loadContainerImage()).resolves.toBe(
      'registry.example.com/team/icarus-agent:latest',
    );
  });

  it('rejects old NanoClaw agent images', async () => {
    process.env.CONTAINER_IMAGE = 'nanoclaw-agent:latest';

    await expect(loadContainerImage()).rejects.toThrow(
      'CONTAINER_IMAGE must use the icarus-agent image repository',
    );
  });
});
