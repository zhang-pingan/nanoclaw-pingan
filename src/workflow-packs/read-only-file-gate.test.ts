import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareWorkflowPackReadOnlyFileGate } from './read-only-file-gate.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; source: string; gates: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-read-only-gate-'));
  roots.push(root);
  const source = path.join(root, 'source');
  const gates = path.join(root, 'gates');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'keep.txt'), 'initial');
  fs.writeFileSync(path.join(source, 'nested', 'delete.txt'), 'delete me');
  fs.symlinkSync('keep.txt', path.join(source, 'link'));
  return { root, source, gates };
}

describe('Workflow Pack read-only file gate', () => {
  it('keeps the Host source untouched and accepts a restored isolated copy', () => {
    const paths = fixture();
    const gate = prepareWorkflowPackReadOnlyFileGate({
      parentDirectory: paths.gates,
      runKey: 'run:clean',
      scopes: [{ scope: 'workspace', sourcePath: paths.source }],
    });
    const copy = gate.mountPath('workspace');
    fs.writeFileSync(path.join(copy, 'keep.txt'), 'temporary');
    fs.writeFileSync(path.join(copy, 'keep.txt'), 'initial');

    expect(gate.verify()).toEqual({ clean: true, changes: [] });
    expect(fs.readFileSync(path.join(paths.source, 'keep.txt'), 'utf8')).toBe(
      'initial',
    );
    gate.cleanup();
    expect(fs.existsSync(gate.rootPath)).toBe(false);
  });

  it('detects additions, deletions, content, permissions, and link changes', () => {
    const paths = fixture();
    const gate = prepareWorkflowPackReadOnlyFileGate({
      parentDirectory: paths.gates,
      runKey: 'run:dirty',
      scopes: [{ scope: 'agent', sourcePath: paths.source }],
    });
    const copy = gate.mountPath('agent');
    fs.writeFileSync(path.join(copy, 'added.txt'), 'new');
    fs.rmSync(path.join(copy, 'nested', 'delete.txt'));
    fs.writeFileSync(path.join(copy, 'keep.txt'), 'changed');
    fs.chmodSync(path.join(copy, 'nested'), 0o700);
    fs.rmSync(path.join(copy, 'link'));
    fs.symlinkSync('added.txt', path.join(copy, 'link'));

    const result = gate.verify();
    expect(result.clean).toBe(false);
    expect(result.changes.join('\n')).toMatch(/added\.txt added/);
    expect(result.changes.join('\n')).toMatch(/delete\.txt deleted/);
    expect(result.changes.join('\n')).toMatch(/keep\.txt changed \(content\)/);
    expect(result.changes.join('\n')).toMatch(/nested changed \(permissions\)/);
    expect(result.changes.join('\n')).toMatch(/link changed \(link target\)/);
    expect(fs.readFileSync(path.join(paths.source, 'keep.txt'), 'utf8')).toBe(
      'initial',
    );

    fs.chmodSync(copy, 0o000);
    gate.cleanup();
    expect(fs.existsSync(gate.rootPath)).toBe(false);
  });

  it('fails closed when the real source changes outside the shadow mount', () => {
    const paths = fixture();
    const gate = prepareWorkflowPackReadOnlyFileGate({
      parentDirectory: paths.gates,
      runKey: 'run:source-drift',
      scopes: [{ scope: 'ai_images', sourcePath: paths.source }],
    });
    fs.writeFileSync(path.join(paths.source, 'outside.png'), 'unexpected');

    expect(gate.verify()).toEqual({
      clean: false,
      changes: ['ai_images:source:outside.png added'],
    });
    gate.cleanup();
  });
});
