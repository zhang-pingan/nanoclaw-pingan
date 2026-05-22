import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./env.js', () => ({
  readEnvFile: () => ({}),
}));

async function loadContainerImage(): Promise<string> {
  vi.resetModules();
  const config = await import('./config.js');
  return config.CONTAINER_IMAGE;
}

async function loadConfigPaths(): Promise<{
  mountAllowlistPath: string;
  senderAllowlistPath: string;
  containerNodeModulesDir: string;
}> {
  vi.resetModules();
  const config = await import('./config.js');
  return {
    mountAllowlistPath: config.MOUNT_ALLOWLIST_PATH,
    senderAllowlistPath: config.SENDER_ALLOWLIST_PATH,
    containerNodeModulesDir: config.CONTAINER_NODE_MODULES_DIR,
  };
}

describe('Icarus rename source contracts', () => {
  function readProjectFile(relativePath: string): string {
    return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf-8');
  }

  it('exposes only the Icarus Electron preload API and CLI argument', () => {
    const preload = readProjectFile('electron/preload.ts');
    const main = readProjectFile('electron/main.ts');
    const rendererTypes = readProjectFile(
      'electron/renderer/types/renderer.d.ts',
    );

    expect(preload).toContain("exposeInMainWorld('icarusApp'");
    expect(preload).not.toContain('nanoclawApp');
    expect(main).toContain('--icarus-open-workstation');
    expect(main).not.toContain('--nanoclaw-open-workstation');
    expect(rendererTypes).toContain('icarusApp: IcarusAppAPI');
    expect(rendererTypes).not.toContain('nanoclawApp');
  });

  it('uses Icarus MCP server names, env keys, and output markers only', () => {
    const hostRunner = readProjectFile('src/container-runner.ts');
    const agentRunner = readProjectFile('container/agent-runner/src/index.ts');
    const mcpServer = readProjectFile(
      'container/agent-runner/src/ipc-mcp-stdio.ts',
    );

    expect(hostRunner).toContain('---ICARUS_OUTPUT_START---');
    expect(hostRunner).not.toContain('---NANOCLAW_OUTPUT_START---');
    expect(agentRunner).toContain('mcp__icarus__*');
    expect(agentRunner).toContain('/__icarus__/');
    expect(agentRunner).toContain('ICARUS_CHAT_JID');
    expect(agentRunner).not.toContain('mcp__nanoclaw__');
    expect(agentRunner).not.toContain('/__nanoclaw__/');
    expect(agentRunner).not.toContain('NANOCLAW_CHAT_JID');
    expect(mcpServer).toContain("name: 'icarus'");
    expect(mcpServer).toContain('ICARUS_GROUP_FOLDER');
    expect(mcpServer).not.toContain("name: 'nanoclaw'");
  });

  it('uses Icarus mail protocol identifiers', () => {
    const mail = readProjectFile('src/mail.ts');

    expect(mail).toContain('<icarus-');
    expect(mail).toContain('icarus.local');
    expect(mail).not.toContain('<nanoclaw-');
    expect(mail).not.toContain('nanoclaw.local');
  });
});

describe('container image config', () => {
  afterEach(() => {
    delete process.env.CONTAINER_IMAGE;
    vi.resetModules();
  });

  it('uses Icarus-only config and cache paths', async () => {
    const paths = await loadConfigPaths();

    expect(paths.mountAllowlistPath).toBe(
      path.join(
        process.env.HOME || '',
        '.config',
        'icarus',
        'mount-allowlist.json',
      ),
    );
    expect(paths.senderAllowlistPath).toBe(
      path.join(
        process.env.HOME || '',
        '.config',
        'icarus',
        'sender-allowlist.json',
      ),
    );
    expect(paths.containerNodeModulesDir).toBe(
      path.join(
        process.env.HOME || '',
        '.cache',
        'icarus',
        'container-node-modules',
        'project',
      ),
    );
    expect(Object.values(paths).join('\n')).not.toContain('nanoclaw');
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
