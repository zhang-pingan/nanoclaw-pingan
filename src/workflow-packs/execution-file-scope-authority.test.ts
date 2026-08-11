import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  activeWorkflowPackExecutionFileScopeAuthorities,
  createWorkflowPackExecutionFileScopeAuthority,
  installWorkflowPackExecutionIpcClosingDrainer,
  type WorkflowPackExecutionFileScopeAuthority,
} from './execution-file-scope-authority.js';

const roots: string[] = [];
const disposeDrainers: Array<() => void> = [];

afterEach(async () => {
  for (const authority of activeWorkflowPackExecutionFileScopeAuthorities()) {
    await authority.deactivateAndDrain().catch(() => undefined);
    authority.cleanup();
  }
  for (const dispose of disposeDrainers.splice(0)) dispose();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-scope-authority-'),
  );
  roots.push(root);
  return root;
}

function makeAuthority(input: {
  root: string;
  suffix: string;
  mappings: Array<{
    scope:
      | 'agent'
      | 'workspace'
      | 'attachments'
      | 'desktop_captures'
      | 'ai_images';
    sourcePath: string;
    shadowHostPath: string;
  }>;
  hostActions?: string[];
}): WorkflowPackExecutionFileScopeAuthority {
  for (const mapping of input.mappings) {
    fs.mkdirSync(mapping.sourcePath, { recursive: true });
    fs.mkdirSync(mapping.shadowHostPath, { recursive: true });
  }
  return createWorkflowPackExecutionFileScopeAuthority({
    parentDirectory: path.join(input.root, 'ipc'),
    runId: `run-${input.suffix}`,
    queryId: `query-${input.suffix}`,
    agentFolder: `agent-${input.suffix}`,
    isMain: false,
    hostActions: input.hostActions ?? ['send_file'],
    mappings: input.mappings,
  });
}

describe('Workflow Pack execution file scope authority', () => {
  it('keeps concurrent Run mappings isolated and unregisters before cleanup', async () => {
    const root = makeRoot();
    const first = makeAuthority({
      root,
      suffix: 'one',
      mappings: [
        {
          scope: 'agent',
          sourcePath: path.join(root, 'source-1'),
          shadowHostPath: path.join(root, 'shadow-1'),
        },
      ],
    });
    const second = makeAuthority({
      root,
      suffix: 'two',
      mappings: [
        {
          scope: 'agent',
          sourcePath: path.join(root, 'source-2'),
          shadowHostPath: path.join(root, 'shadow-2'),
        },
      ],
    });
    fs.writeFileSync(path.join(root, 'shadow-1', 'report.txt'), 'one');
    fs.writeFileSync(path.join(root, 'shadow-2', 'report.txt'), 'two');
    first.register();
    second.register();

    expect(
      first.readContainerFile('/workspace/agent/report.txt').toString(),
    ).toBe('one');
    expect(
      second.readContainerFile('/workspace/agent/report.txt').toString(),
    ).toBe('two');
    expect(activeWorkflowPackExecutionFileScopeAuthorities()).toEqual(
      expect.arrayContaining([first, second]),
    );

    const releaseOperation = first.beginOperation();
    expect(releaseOperation).not.toBeNull();
    let drained = false;
    const drain = first.deactivateAndDrain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(first.beginOperation()).toBeNull();
    releaseOperation?.();
    await drain;
    expect(activeWorkflowPackExecutionFileScopeAuthorities()).not.toContain(
      first,
    );
    first.cleanup();
    expect(fs.existsSync(first.ipcRootPath)).toBe(false);

    await second.deactivateAndDrain();
    second.cleanup();
  });

  it('does not lock a real source against unrelated writers', async () => {
    const root = makeRoot();
    const sourcePath = path.join(root, 'source');
    const authority = makeAuthority({
      root,
      suffix: 'no-global-lease',
      mappings: [
        {
          scope: 'attachments',
          sourcePath,
          shadowHostPath: path.join(root, 'shadow'),
        },
      ],
    });
    authority.register();

    fs.writeFileSync(
      path.join(sourcePath, 'channel-attachment.bin'),
      'inbound',
    );
    expect(
      fs.readFileSync(path.join(sourcePath, 'channel-attachment.bin'), 'utf8'),
    ).toBe('inbound');

    await authority.deactivateAndDrain();
    authority.cleanup();
  });

  it('synchronously drains JSON written before the watcher began an operation', async () => {
    const root = makeRoot();
    const authority = makeAuthority({
      root,
      suffix: 'closing-race',
      mappings: [
        {
          scope: 'agent',
          sourcePath: path.join(root, 'source'),
          shadowHostPath: path.join(root, 'shadow'),
        },
      ],
    });
    const handled: string[] = [];
    disposeDrainers.push(
      installWorkflowPackExecutionIpcClosingDrainer(async (closing) => {
        const requestPath = path.join(
          closing.ipcRootPath,
          'messages',
          'last.json',
        );
        handled.push(fs.readFileSync(requestPath, 'utf8'));
        fs.unlinkSync(requestPath);
      }),
    );
    authority.register();
    fs.writeFileSync(
      path.join(authority.ipcRootPath, 'messages', 'last.json'),
      JSON.stringify({ type: 'message', text: 'last request' }),
    );

    await authority.deactivateAndDrain();

    expect(handled).toHaveLength(1);
    expect(JSON.parse(handled[0])).toMatchObject({ text: 'last request' });
    authority.cleanup();
  });

  it('rejects unmapped and excluded container scopes by default', () => {
    const root = makeRoot();
    const authority = makeAuthority({
      root,
      suffix: 'scope-rejection',
      mappings: [
        {
          scope: 'workspace',
          sourcePath: path.join(root, 'source'),
          shadowHostPath: path.join(root, 'shadow'),
        },
      ],
    });
    fs.writeFileSync(path.join(root, 'shadow', 'input.txt'), 'input');

    expect(
      authority.readContainerFile('/workspace/project/input.txt').toString(),
    ).toBe('input');
    expect(() =>
      authority.readContainerFile('/workspace/agent/input.txt'),
    ).toThrow('did not map declared file scope agent');
    expect(() =>
      authority.readContainerFile('/workspace/run-once/outputs/result.txt'),
    ).toThrow('outside the allowed scopes');
    authority.cleanup();
  });

  it('rejects a local/shell symlink instead of trusting its target as a root', () => {
    const root = makeRoot();
    const outside = path.join(root, 'outside-shell');
    const shadow = path.join(root, 'workspace-shadow');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(path.join(shadow, 'local'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'escape.sh'), '#!/bin/sh\n');
    fs.symlinkSync(outside, path.join(shadow, 'local', 'shell'));
    const authority = makeAuthority({
      root,
      suffix: 'script-symlink',
      mappings: [
        {
          scope: 'workspace',
          sourcePath: path.join(root, 'workspace-source'),
          shadowHostPath: shadow,
        },
      ],
    });

    expect(() =>
      authority.snapshotScopeDirectory('workspace', 'local/shell'),
    ).toThrow('symbolic link');
    authority.cleanup();
  });

  it('rejects an AI output parent symlink without writing outside the shadow', async () => {
    const root = makeRoot();
    const outside = path.join(root, 'outside-images');
    const shadow = path.join(root, 'ai-shadow');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(shadow, { recursive: true });
    fs.symlinkSync(outside, path.join(shadow, 'request'));
    const authority = makeAuthority({
      root,
      suffix: 'image-symlink',
      mappings: [
        {
          scope: 'ai_images',
          sourcePath: path.join(root, 'ai-source'),
          shadowHostPath: shadow,
        },
      ],
    });

    await expect(
      authority.createScopeFile(
        'ai_images',
        'request/image.png',
        Buffer.from('image'),
      ),
    ).rejects.toThrow('parent directory open failed');
    expect(fs.readdirSync(outside)).toEqual([]);
    authority.cleanup();
  });

  it('reads and creates normal shadow child paths', async () => {
    const root = makeRoot();
    const authority = makeAuthority({
      root,
      suffix: 'normal-paths',
      mappings: [
        {
          scope: 'ai_images',
          sourcePath: path.join(root, 'ai-source'),
          shadowHostPath: path.join(root, 'ai-shadow'),
        },
      ],
    });

    const created = await authority.createScopeFile(
      'ai_images',
      'request/image.png',
      Buffer.from('image'),
    );
    expect(fs.readFileSync(created, 'utf8')).toBe('image');
    expect(
      authority
        .readContainerFile('/workspace/ai-images/request/image.png')
        .toString(),
    ).toBe('image');
    authority.cleanup();
  });

  it('never creates outside the shadow during a synchronized parent symlink swap', async () => {
    const root = makeRoot();
    const outside = path.join(root, 'outside-parent-swap');
    const shadow = path.join(root, 'swap-shadow');
    const originalParent = path.join(shadow, 'request');
    const detachedParent = path.join(shadow, 'request-detached');
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(originalParent, { recursive: true });
    const authority = makeAuthority({
      root,
      suffix: 'parent-swap',
      mappings: [
        {
          scope: 'ai_images',
          sourcePath: path.join(root, 'swap-source'),
          shadowHostPath: shadow,
        },
      ],
    });

    await expect(
      authority.createScopeFile(
        'ai_images',
        'request/image.png',
        Buffer.from('image'),
        0o600,
        () => {
          fs.renameSync(originalParent, detachedParent);
          fs.symlinkSync(outside, originalParent);
        },
      ),
    ).rejects.toThrow('symbolic link');

    expect(fs.existsSync(path.join(outside, 'image.png'))).toBe(false);
    expect(fs.existsSync(path.join(detachedParent, 'image.png'))).toBe(false);
    authority.cleanup();
  });
});
