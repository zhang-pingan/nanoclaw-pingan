import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  isValidAgentFolder,
  resolveAgentFolderPath,
  resolveAgentIpcPath,
} from './agent-folder.js';

describe('Agent folder validation', () => {
  it('accepts normal Agent folder names', () => {
    expect(isValidAgentFolder('main')).toBe(true);
    expect(isValidAgentFolder('family-chat')).toBe(true);
    expect(isValidAgentFolder('Team_42')).toBe(true);
  });

  it('rejects traversal and reserved names', () => {
    expect(isValidAgentFolder('../../etc')).toBe(false);
    expect(isValidAgentFolder('/tmp')).toBe(false);
    expect(isValidAgentFolder('global')).toBe(false);
    expect(isValidAgentFolder('')).toBe(false);
  });

  it('resolves safe paths under agents directory', () => {
    const resolved = resolveAgentFolderPath('family-chat');
    expect(resolved.endsWith(`${path.sep}agents${path.sep}family-chat`)).toBe(
      true,
    );
  });

  it('resolves safe paths under data ipc directory', () => {
    const resolved = resolveAgentIpcPath('family-chat');
    expect(
      resolved.endsWith(`${path.sep}data${path.sep}ipc${path.sep}family-chat`),
    ).toBe(true);
  });

  it('throws for unsafe folder names', () => {
    expect(() => resolveAgentFolderPath('../../etc')).toThrow();
    expect(() => resolveAgentIpcPath('/tmp')).toThrow();
  });
});
