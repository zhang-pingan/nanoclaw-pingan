import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENTS_DIR, DATA_DIR } from './config.js';
import {
  processIpcNamespaceOnce,
  processTaskIpc,
  resolveContainerFilePath,
  type IpcDeps,
} from './ipc.js';
import type { RegisteredAgent } from './types.js';
import {
  createWorkflowPackExecutionFileScopeAuthority,
  installWorkflowPackExecutionIpcClosingDrainer,
} from './workflow-packs/execution-file-scope-authority.js';

const roots: string[] = [];
const disposeDrainers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposeDrainers.splice(0)) dispose();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ipc-authority-'));
  roots.push(root);
  return root;
}

function makeDeps(agentFolder: string, sendFile: IpcDeps['sendFile']): IpcDeps {
  const agent: RegisteredAgent = {
    name: agentFolder,
    folder: agentFolder,
    trigger: '@test',
    added_at: new Date().toISOString(),
  };
  return {
    sendMessage: vi.fn(async () => undefined),
    sendFile,
    registeredAgents: () => ({ 'web:test': agent }),
    registerAgent: vi.fn(),
    getAvailableAgents: () => [],
    writeAgentsSnapshot: vi.fn(),
    enqueueMessageCheck: vi.fn(),
  };
}

describe('Workflow Pack IPC file scope authority', () => {
  it('resolves send_file from each concurrent Run shadow instead of the real Agent directory', async () => {
    const root = makeRoot();
    const delivered: Array<{ path: string; content: string }> = [];
    const makeAuthority = (suffix: string) => {
      const sourcePath = path.join(root, `source-${suffix}`);
      const shadowHostPath = path.join(root, `shadow-${suffix}`);
      fs.mkdirSync(sourcePath, { recursive: true });
      fs.mkdirSync(shadowHostPath, { recursive: true });
      fs.writeFileSync(path.join(sourcePath, 'report.txt'), `real-${suffix}`);
      fs.writeFileSync(
        path.join(shadowHostPath, 'report.txt'),
        `shadow-${suffix}`,
      );
      const authority = createWorkflowPackExecutionFileScopeAuthority({
        parentDirectory: path.join(root, 'ipc'),
        runId: `run-${suffix}`,
        queryId: `query-${suffix}`,
        agentFolder: `agent-${suffix}`,
        isMain: false,
        hostActions: ['send_file'],
        mappings: [{ scope: 'agent', sourcePath, shadowHostPath }],
      });
      authority.register();
      const requestId = `sendfile-${suffix}`;
      fs.writeFileSync(
        path.join(authority.ipcRootPath, 'messages', `${requestId}.json`),
        JSON.stringify({
          type: 'file',
          requestId,
          chatJid: 'web:test',
          filePath: '/workspace/agent/report.txt',
          agentFolder: 'forged-agent',
          runId: 'forged-run',
        }),
      );
      return authority;
    };
    const first = makeAuthority('one');
    const second = makeAuthority('two');
    const sendFile = vi.fn(async (_jid: string, filePath: string) => {
      delivered.push({
        path: filePath,
        content: fs.readFileSync(filePath, 'utf8'),
      });
    });

    await Promise.all(
      [first, second].map((authority) =>
        processIpcNamespaceOnce({
          rootPath: authority.ipcRootPath,
          sourceAgent: authority.agentFolder,
          isMain: authority.isMain,
          deps: makeDeps(authority.agentFolder, sendFile),
          fileScopeAuthority: authority,
        }),
      ),
    );

    expect(delivered.map(({ content }) => content).sort()).toEqual([
      'shadow-one',
      'shadow-two',
    ]);
    expect(
      delivered.every(({ path: deliveredPath }) =>
        deliveredPath.includes(`${path.sep}host-artifacts${path.sep}`),
      ),
    ).toBe(true);
    await first.deactivateAndDrain();
    await second.deactivateAndDrain();
    first.cleanup();
    second.cleanup();
  });

  it('stops accepting old protected IPC after authority deactivation', async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, 'source');
    const shadowHostPath = path.join(root, 'shadow');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(shadowHostPath, { recursive: true });
    fs.writeFileSync(path.join(shadowHostPath, 'report.txt'), 'shadow');
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'finished-run',
      queryId: 'finished-query',
      agentFolder: 'finished-agent',
      isMain: false,
      hostActions: ['send_file'],
      mappings: [{ scope: 'agent', sourcePath, shadowHostPath }],
    });
    authority.register();
    await authority.deactivateAndDrain();
    const requestPath = path.join(
      authority.ipcRootPath,
      'messages',
      'stale.json',
    );
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        type: 'file',
        chatJid: 'web:test',
        filePath: '/workspace/agent/report.txt',
      }),
    );
    const sendFile = vi.fn(async () => undefined);

    await processIpcNamespaceOnce({
      rootPath: authority.ipcRootPath,
      sourceAgent: authority.agentFolder,
      isMain: authority.isMain,
      deps: makeDeps(authority.agentFolder, sendFile),
      fileScopeAuthority: authority,
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(fs.existsSync(requestPath)).toBe(true);
    authority.cleanup();
    expect(fs.existsSync(authority.ipcRootPath)).toBe(false);
  });

  it('rejects a protected Host action that the pinned Manifest did not declare', async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, 'source');
    const shadowHostPath = path.join(root, 'shadow');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(shadowHostPath, { recursive: true });
    fs.writeFileSync(path.join(shadowHostPath, 'report.txt'), 'shadow');
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'restricted-run',
      queryId: 'restricted-query',
      agentFolder: 'restricted-agent',
      isMain: false,
      hostActions: [],
      mappings: [{ scope: 'agent', sourcePath, shadowHostPath }],
    });
    authority.register();
    const requestPath = path.join(
      authority.ipcRootPath,
      'messages',
      'sendfile-undeclared.json',
    );
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        type: 'file',
        requestId: 'sendfile-undeclared',
        chatJid: 'web:test',
        filePath: '/workspace/agent/report.txt',
      }),
    );
    const sendFile = vi.fn(async () => undefined);

    await processIpcNamespaceOnce({
      rootPath: authority.ipcRootPath,
      sourceAgent: authority.agentFolder,
      isMain: authority.isMain,
      deps: makeDeps(authority.agentFolder, sendFile),
      fileScopeAuthority: authority,
    });

    expect(sendFile).not.toHaveBeenCalled();
    expect(fs.existsSync(requestPath)).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            authority.hostActionResultsPath,
            'sendfile-undeclared.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      status: 'error',
      action: 'send_file',
      error: expect.stringContaining('was not declared'),
    });
    await authority.deactivateAndDrain();
    authority.cleanup();
  });

  it('rejects a pre-created receipt collision and continues with the next request', async () => {
    const root = makeRoot();
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'receipt-collision-run',
      queryId: 'receipt-collision-query',
      agentFolder: 'receipt-agent',
      isMain: false,
      hostActions: ['send_message'],
      mappings: [],
    });
    authority.register();
    const deps = makeDeps(
      'receipt-agent',
      vi.fn(async () => undefined),
    );
    const sendMessage = vi.mocked(deps.sendMessage);
    const firstId = 'a-receipt-collision';
    const secondId = 'b-receipt-after-collision';
    fs.writeFileSync(
      path.join(authority.hostActionResultsPath, `${firstId}.json`),
      JSON.stringify({
        status: 'success',
        requestId: firstId,
        action: 'send_message',
      }),
    );
    for (const [requestId, text] of [
      [firstId, 'first'],
      [secondId, 'second'],
    ]) {
      fs.writeFileSync(
        path.join(authority.ipcRootPath, 'messages', `${requestId}.json`),
        JSON.stringify({
          type: 'message',
          requestId,
          chatJid: 'web:test',
          text,
        }),
      );
    }

    await processIpcNamespaceOnce({
      rootPath: authority.ipcRootPath,
      sourceAgent: authority.agentFolder,
      isMain: authority.isMain,
      deps,
      fileScopeAuthority: authority,
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(authority.hostActionResultsPath, `${firstId}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({
      status: 'error',
      requestId: firstId,
      action: 'send_message',
      error: expect.stringContaining('receipt collision'),
    });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(authority.hostActionResultsPath, `${secondId}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({
      status: 'success',
      requestId: secondId,
      action: 'send_message',
    });
    await expect(authority.deactivateAndDrain()).rejects.toThrow(
      'rejected or failed',
    );
    authority.cleanup();
  });

  it('rejects a request whose filename does not match its requestId', async () => {
    const root = makeRoot();
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'request-identity-run',
      queryId: 'request-identity-query',
      agentFolder: 'request-identity-agent',
      isMain: false,
      hostActions: ['send_message'],
      mappings: [],
    });
    authority.register();
    const deps = makeDeps(
      authority.agentFolder,
      vi.fn(async () => undefined),
    );
    const requestId = 'sendmsg-content-id';
    fs.writeFileSync(
      path.join(authority.ipcRootPath, 'messages', 'sendmsg-wrong-file.json'),
      JSON.stringify({
        type: 'message',
        requestId,
        chatJid: 'web:test',
        text: 'must not be sent',
      }),
    );

    await processIpcNamespaceOnce({
      rootPath: authority.ipcRootPath,
      sourceAgent: authority.agentFolder,
      isMain: authority.isMain,
      deps,
      fileScopeAuthority: authority,
    });

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(authority.hostActionResultsPath, `${requestId}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({
      status: 'error',
      requestId,
      action: 'send_message',
      error: expect.stringContaining('filename does not match requestId'),
    });
    await authority.deactivateAndDrain();
    authority.cleanup();
  });

  it('publishes a semantic task rejection instead of acknowledging success', async () => {
    const root = makeRoot();
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'task-rejection-run',
      queryId: 'task-rejection-query',
      agentFolder: 'task-agent',
      isMain: true,
      hostActions: ['schedule_task'],
      mappings: [],
    });
    authority.register();
    const requestId = 'schedule-missing-target';
    fs.writeFileSync(
      path.join(authority.ipcRootPath, 'tasks', `${requestId}.json`),
      JSON.stringify({
        type: 'schedule_task',
        requestId,
        prompt: 'never scheduled',
        schedule_type: 'once',
        schedule_value: '2030-01-01T00:00:00',
        targetJid: 'web:missing',
      }),
    );

    await processIpcNamespaceOnce({
      rootPath: authority.ipcRootPath,
      sourceAgent: authority.agentFolder,
      isMain: authority.isMain,
      deps: makeDeps(
        authority.agentFolder,
        vi.fn(async () => undefined),
      ),
      fileScopeAuthority: authority,
    });

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(authority.hostActionResultsPath, `${requestId}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({
      status: 'error',
      requestId,
      action: 'schedule_task',
      error: expect.stringContaining('not registered'),
    });
    await authority.deactivateAndDrain();
    authority.cleanup();
  });

  it('fails a closing drain when the final task request is rejected', async () => {
    const root = makeRoot();
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'closing-rejection-run',
      queryId: 'closing-rejection-query',
      agentFolder: 'closing-rejection-agent',
      isMain: true,
      hostActions: ['schedule_task'],
      mappings: [],
    });
    const deps = makeDeps(
      authority.agentFolder,
      vi.fn(async () => undefined),
    );
    disposeDrainers.push(
      installWorkflowPackExecutionIpcClosingDrainer(async (closing) => {
        await processIpcNamespaceOnce({
          rootPath: closing.ipcRootPath,
          sourceAgent: closing.agentFolder,
          isMain: closing.isMain,
          deps,
          fileScopeAuthority: closing,
          closingDrain: true,
        });
      }),
    );
    authority.register();
    const requestId = 'schedule-closing-rejection';
    fs.writeFileSync(
      path.join(authority.ipcRootPath, 'tasks', `${requestId}.json`),
      JSON.stringify({
        type: 'schedule_task',
        requestId,
        prompt: 'never scheduled',
        schedule_type: 'once',
        schedule_value: '2030-01-01T00:00:00',
        targetJid: 'web:missing',
      }),
    );

    await expect(authority.deactivateAndDrain()).rejects.toThrow(
      'closing drain failed',
    );
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(authority.hostActionResultsPath, `${requestId}.json`),
          'utf8',
        ),
      ),
    ).toMatchObject({ status: 'error', action: 'schedule_task' });
    authority.cleanup();
  });

  it('passes the desktop capture shadow output root through the Host action chain', async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, 'desktop-source');
    const shadowHostPath = path.join(root, 'desktop-shadow');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(shadowHostPath, { recursive: true });
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'desktop-run',
      queryId: 'desktop-query',
      agentFolder: 'main',
      isMain: true,
      hostActions: ['desktop_capture'],
      mappings: [
        {
          scope: 'desktop_captures',
          sourcePath,
          shadowHostPath,
        },
      ],
    });
    const captureDesktop = vi.fn(
      async (
        _options?: Parameters<NonNullable<IpcDeps['captureDesktop']>>[0],
      ) => ({
        status: 'success' as const,
        requestId: 'desktop-client-request',
        displays: [],
      }),
    );
    const deps = makeDeps(
      'main',
      vi.fn(async () => undefined),
    );
    deps.captureDesktop = captureDesktop;
    const requestId = `desktop-${Date.now()}`;

    await processTaskIpc(
      { type: 'desktop_capture', requestId, includeImage: true },
      'main',
      true,
      deps,
      { fileScopeAuthority: authority },
    );

    const options = captureDesktop.mock.calls[0]?.[0];
    expect(options).toEqual(
      expect.objectContaining({ writeImage: expect.any(Function) }),
    );
    const capturePath = await options?.writeImage?.(
      'capture.png',
      Buffer.from('capture'),
    );
    expect(capturePath).toBe(
      path.join(fs.realpathSync(shadowHostPath), 'capture.png'),
    );
    expect(fs.readFileSync(capturePath!, 'utf8')).toBe('capture');
    fs.rmSync(
      path.join(
        DATA_DIR,
        'ipc',
        'main',
        'desktop-capture-results',
        `${requestId}.json`,
      ),
      { force: true },
    );
    authority.cleanup();
  });

  it('resolves local Host scripts from the mapped workspace shadow', async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, 'workspace-source');
    const shadowHostPath = path.join(root, 'workspace-shadow');
    const shellRoot = path.join(shadowHostPath, 'local', 'shell');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(shellRoot, { recursive: true });
    const scriptPath = path.join(shellRoot, 'shadow-script.sh');
    fs.writeFileSync(scriptPath, '#!/bin/sh\nprintf shadow-script\n');
    fs.chmodSync(scriptPath, 0o700);
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'script-run',
      queryId: 'script-query',
      agentFolder: 'main',
      isMain: true,
      hostActions: ['run_local_host_script'],
      mappings: [{ scope: 'workspace', sourcePath, shadowHostPath }],
    });
    const requestId = `script-${Date.now()}`;

    await processTaskIpc(
      {
        type: 'run_local_host_script',
        requestId,
        scriptPath: '/workspace/project/local/shell/shadow-script.sh',
      },
      'main',
      true,
      makeDeps(
        'main',
        vi.fn(async () => undefined),
      ),
      { fileScopeAuthority: authority },
    );

    const resultPath = path.join(
      DATA_DIR,
      'ipc',
      'main',
      'host-script-results',
      `${requestId}.json`,
    );
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'success',
      stdout: 'shadow-script',
      scriptPath: expect.stringContaining(
        `${path.sep}host-artifacts${path.sep}`,
      ),
    });
    fs.rmSync(resultPath, { force: true });
    authority.cleanup();
  });

  it('drains a final send_file written before watcher pickup and cleans only after delivery', async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, 'source');
    const shadowHostPath = path.join(root, 'shadow');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(shadowHostPath, { recursive: true });
    fs.writeFileSync(path.join(shadowHostPath, 'last.txt'), 'last-shadow-file');
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'closing-run',
      queryId: 'closing-query',
      agentFolder: 'closing-agent',
      isMain: false,
      hostActions: ['send_file', 'reload_tools'],
      mappings: [{ scope: 'agent', sourcePath, shadowHostPath }],
    });
    const delivered = vi.fn(async (_jid: string, deliveredPath: string) => {
      expect(fs.readFileSync(deliveredPath, 'utf8')).toBe('last-shadow-file');
      expect(fs.existsSync(authority.ipcRootPath)).toBe(true);
    });
    const deps = makeDeps('closing-agent', delivered);
    deps.reloadContainer = vi.fn();
    disposeDrainers.push(
      installWorkflowPackExecutionIpcClosingDrainer(async (closing) => {
        await processIpcNamespaceOnce({
          rootPath: closing.ipcRootPath,
          sourceAgent: closing.agentFolder,
          isMain: closing.isMain,
          deps,
          fileScopeAuthority: closing,
          closingDrain: true,
        });
      }),
    );
    authority.register();
    fs.writeFileSync(
      path.join(
        authority.ipcRootPath,
        'messages',
        'sendfile-closing-race.json',
      ),
      JSON.stringify({
        type: 'file',
        requestId: 'sendfile-closing-race',
        chatJid: 'web:test',
        filePath: '/workspace/agent/last.txt',
      }),
    );
    fs.writeFileSync(
      path.join(authority.ipcRootPath, 'tasks', 'reload-closing-race.json'),
      JSON.stringify({
        type: 'reload_container',
        requestId: 'reload-closing-race',
        chatJid: 'web:test',
      }),
    );

    await authority.deactivateAndDrain();

    expect(delivered).toHaveBeenCalledOnce();
    expect(deps.reloadContainer).toHaveBeenCalledWith('web:test');
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            authority.hostActionResultsPath,
            'sendfile-closing-race.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ status: 'success', action: 'send_file' });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(
            authority.hostActionResultsPath,
            'reload-closing-race.json',
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({
      status: 'success',
      requestId: 'reload-closing-race',
      action: 'reload_tools',
    });
    authority.cleanup();
    expect(fs.existsSync(authority.ipcRootPath)).toBe(false);
  });

  it('rejects a local/shell symlink escape through the Host action chain', async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, 'workspace-source');
    const shadowHostPath = path.join(root, 'workspace-shadow');
    const outside = path.join(root, 'outside-shell');
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(path.join(shadowHostPath, 'local'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'escape.sh'),
      '#!/bin/sh\nprintf escaped\n',
    );
    fs.symlinkSync(outside, path.join(shadowHostPath, 'local', 'shell'));
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'script-escape-run',
      queryId: 'script-escape-query',
      agentFolder: 'main',
      isMain: true,
      hostActions: ['run_local_host_script'],
      mappings: [{ scope: 'workspace', sourcePath, shadowHostPath }],
    });
    const requestId = `script-escape-${Date.now()}`;

    await processTaskIpc(
      {
        type: 'run_local_host_script',
        requestId,
        scriptPath: '/workspace/project/local/shell/escape.sh',
      },
      'main',
      true,
      makeDeps(
        'main',
        vi.fn(async () => undefined),
      ),
      { fileScopeAuthority: authority },
    );

    const resultPath = path.join(
      DATA_DIR,
      'ipc',
      'main',
      'host-script-results',
      `${requestId}.json`,
    );
    expect(JSON.parse(fs.readFileSync(resultPath, 'utf8'))).toMatchObject({
      status: 'error',
      error: expect.stringContaining('symbolic link'),
    });
    fs.rmSync(resultPath, { force: true });
    authority.cleanup();
  });

  it('keeps ordinary IPC path resolution on the real Agent directory', () => {
    expect(
      resolveContainerFilePath('/workspace/agent/report.txt', 'ordinary-agent'),
    ).toEqual({
      hostPath: path.join(AGENTS_DIR, 'ordinary-agent', 'report.txt'),
    });
  });
});
