import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { RunOnceOutputFile } from './schemas.js';
import { runOnceWorkspaceHostPath } from './trace-writer.js';

const OUTPUT_ROOT = 'outputs';

const CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
};

export function runOnceOutputRelativeDir(runId: string): string {
  return path.posix.join(OUTPUT_ROOT, runId);
}

export function runOnceOutputAgentPath(runId: string): string {
  return `/workspace/run-once/${runOnceOutputRelativeDir(runId)}`;
}

export function runOnceOutputHostDir(
  agentFolder: string,
  runId: string,
): string {
  return path.join(runOnceWorkspaceHostPath(agentFolder), OUTPUT_ROOT, runId);
}

export function ensureRunOnceOutputDir(
  agentFolder: string,
  runId: string,
): string {
  const outputDir = runOnceOutputHostDir(agentFolder, runId);
  fs.mkdirSync(outputDir, { recursive: true });
  return outputDir;
}

export function contentTypeForFile(filePath: string): string | undefined {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()];
}

function sha256File(filePath: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(filePath))
    .digest('hex');
}

function isInside(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function collectFiles(baseDir: string): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export function buildRunOnceDownloadUrl(input: {
  chatJid: string;
  relativePath: string;
}): string {
  return `/internal/agent/run-once/files?chat_jid=${encodeURIComponent(
    input.chatJid,
  )}&path=${encodeURIComponent(input.relativePath)}`;
}

export function scanRunOnceOutputFiles(input: {
  agentFolder: string;
  chatJid: string;
  runId: string;
}): RunOnceOutputFile[] {
  const outputDir = runOnceOutputHostDir(input.agentFolder, input.runId);
  const workspaceDir = runOnceWorkspaceHostPath(input.agentFolder);
  return collectFiles(outputDir)
    .filter((filePath) => isInside(workspaceDir, filePath))
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => {
      const relativePath = path
        .relative(workspaceDir, filePath)
        .split(path.sep)
        .join('/');
      const stat = fs.statSync(filePath);
      return {
        name: path.basename(filePath),
        agent_path: `/workspace/run-once/${relativePath}`,
        relative_path: relativePath,
        size: stat.size,
        sha256: sha256File(filePath),
        content_type: contentTypeForFile(filePath),
        download_url: buildRunOnceDownloadUrl({
          chatJid: input.chatJid,
          relativePath,
        }),
      };
    });
}

export function resolveRunOnceDownloadFile(input: {
  agentFolder: string;
  relativePath: string;
}): string {
  const normalized = input.relativePath.replace(/\\/g, '/');
  if (
    !normalized.startsWith(`${OUTPUT_ROOT}/`) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('Invalid output file path');
  }

  const workspaceDir = runOnceWorkspaceHostPath(input.agentFolder);
  const filePath = path.resolve(workspaceDir, normalized);
  if (!isInside(workspaceDir, filePath)) {
    throw new Error('Output file path escapes workspace');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error('Output file not found');
  }
  return filePath;
}
