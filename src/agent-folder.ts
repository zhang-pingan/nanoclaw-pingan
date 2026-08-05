import path from 'path';

import { DATA_DIR, AGENTS_DIR } from './config.js';

const AGENT_FOLDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESERVED_FOLDERS = new Set(['global']);

export function isValidAgentFolder(folder: string): boolean {
  if (!folder) return false;
  if (folder !== folder.trim()) return false;
  if (!AGENT_FOLDER_PATTERN.test(folder)) return false;
  if (folder.includes('/') || folder.includes('\\')) return false;
  if (folder.includes('..')) return false;
  if (RESERVED_FOLDERS.has(folder.toLowerCase())) return false;
  return true;
}

export function assertValidAgentFolder(folder: string): void {
  if (!isValidAgentFolder(folder)) {
    throw new Error(`Invalid Agent folder "${folder}"`);
  }
}

function ensureWithinBase(baseDir: string, resolvedPath: string): void {
  const rel = path.relative(baseDir, resolvedPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes base directory: ${resolvedPath}`);
  }
}

export function resolveAgentFolderPath(folder: string): string {
  assertValidAgentFolder(folder);
  const agentPath = path.resolve(AGENTS_DIR, folder);
  ensureWithinBase(AGENTS_DIR, agentPath);
  return agentPath;
}

export function resolveAgentIpcPath(folder: string): string {
  assertValidAgentFolder(folder);
  const ipcBaseDir = path.resolve(DATA_DIR, 'ipc');
  const ipcPath = path.resolve(ipcBaseDir, folder);
  ensureWithinBase(ipcBaseDir, ipcPath);
  return ipcPath;
}
