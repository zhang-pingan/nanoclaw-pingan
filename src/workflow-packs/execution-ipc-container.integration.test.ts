import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { processIpcNamespaceOnce, type IpcDeps } from '../ipc.js';
import type { RegisteredAgent } from '../types.js';
import {
  createWorkflowPackExecutionFileScopeAuthority,
  installWorkflowPackExecutionIpcClosingDrainer,
} from './execution-file-scope-authority.js';

const roots: string[] = [];
const disposeDrainers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposeDrainers.splice(0)) dispose();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function localIcarusAgentImage(): string | null {
  const result = spawnSync(
    'docker',
    ['images', '--no-trunc', '--quiet', 'icarus-agent:latest'],
    { encoding: 'utf8' },
  );
  const imageId =
    result.status === 0 ? result.stdout.trim().split('\n')[0] : '';
  return imageId || null;
}

function runDocker(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Docker exited with ${code}: ${stderr}`));
    });
  });
}

const CONTAINER_TEST_IMAGE = localIcarusAgentImage();

describe.skipIf(!CONTAINER_TEST_IMAGE)(
  'Workflow Pack protected IPC icarus-agent closing boundary',
  () => {
    it('drains an atomic request written immediately before the container exits', async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), 'icarus-real-ipc-closing-'),
      );
      roots.push(root);
      const authority = createWorkflowPackExecutionFileScopeAuthority({
        parentDirectory: path.join(root, 'authorities'),
        runId: 'real-container-run',
        queryId: 'real-container-query',
        agentFolder: 'real-container-agent',
        isMain: true,
        hostActions: ['send_message'],
        mappings: [],
      });
      const sendMessage = vi.fn(async () => undefined);
      const agent: RegisteredAgent = {
        name: 'Real container agent',
        folder: authority.agentFolder,
        trigger: '@test',
        added_at: new Date().toISOString(),
        isMain: true,
      };
      const deps: IpcDeps = {
        sendMessage,
        registeredAgents: () => ({ 'web:real': agent }),
        registerAgent: vi.fn(),
        getAvailableAgents: () => [],
        writeAgentsSnapshot: vi.fn(),
        enqueueMessageCheck: vi.fn(),
      };
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
      const script = [
        "const fs = require('fs');",
        "try { fs.writeFileSync('/workspace/ipc/host-action-results/sendmsg-real-container.json', '{}'); process.exit(23); } catch (error) { if (!['EACCES', 'EROFS'].includes(error.code)) throw error; }",
        "const finalPath = '/workspace/ipc/messages/sendmsg-real-container.json';",
        "const temporaryPath = finalPath + '.tmp';",
        'fs.writeFileSync(temporaryPath, JSON.stringify({',
        "  type: 'message',",
        "  requestId: 'sendmsg-real-container',",
        "  chatJid: 'web:real',",
        "  text: 'delivered at close'",
        '}));',
        'fs.renameSync(temporaryPath, finalPath);',
      ].join('\n');

      await runDocker([
        'run',
        '--rm',
        '--entrypoint',
        'node',
        '-v',
        `${path.join(authority.ipcRootPath, 'messages')}:/workspace/ipc/messages`,
        '-v',
        `${authority.hostActionResultsPath}:/workspace/ipc/host-action-results:ro`,
        CONTAINER_TEST_IMAGE!,
        '-e',
        script,
      ]);
      expect(sendMessage).not.toHaveBeenCalled();

      await authority.deactivateAndDrain();

      expect(sendMessage).toHaveBeenCalledWith(
        'web:real',
        'delivered at close',
      );
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(
              authority.hostActionResultsPath,
              'sendmsg-real-container.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({ status: 'success', action: 'send_message' });
      authority.cleanup();
      expect(fs.existsSync(authority.ipcRootPath)).toBe(false);
    }, 30_000);
  },
);
