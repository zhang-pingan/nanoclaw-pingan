import { execFile } from 'child_process';
import { promisify } from 'util';

import { PROJECT_ROOT } from '../config.js';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  command: string;
  exitCode?: number;
}

export interface EvolutionGitAdapter {
  currentBranch(): Promise<string>;
  currentCommit(): Promise<string>;
  hasDirtyWorktree(): Promise<boolean>;
  worktreeChangedFiles(): Promise<string[]>;
  branchExists(branch: string): Promise<boolean>;
  checkout(branch: string): Promise<CommandResult>;
  createBranch(branch: string): Promise<CommandResult>;
  addAll(): Promise<CommandResult>;
  commit(message: string): Promise<CommandResult>;
  stashPush(message: string): Promise<CommandResult>;
  mergeNoFfNoCommit(branch: string): Promise<CommandResult>;
  mergeAbort(): Promise<CommandResult>;
  changedFiles(baseRef?: string): Promise<string[]>;
  diff(baseRef?: string): Promise<string>;
}

export interface EvolutionCheckRunner {
  (input: {
    itemId: string;
    phase: 'check' | 'adoption';
  }): Promise<CommandResult>;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(' ');
}

function uniqueFiles(files: string[]): string[] {
  return Array.from(new Set(files.map((file) => file.trim()).filter(Boolean)));
}

function parsePorcelainZ(stdout: string): string[] {
  const entries = stdout.split('\0').filter(Boolean);
  const files: string[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    files.push(path);

    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
  }

  return uniqueFiles(files);
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string = PROJECT_ROOT,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: 30 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      command: formatCommand(command, args),
    };
  } catch (err) {
    const error = err as {
      stdout?: string;
      stderr?: string;
      code?: number;
      message?: string;
    };
    return {
      ok: false,
      stdout: error.stdout || '',
      stderr: error.stderr || error.message || '',
      command: formatCommand(command, args),
      exitCode: typeof error.code === 'number' ? error.code : undefined,
    };
  }
}

export function createDefaultEvolutionGitAdapter(): EvolutionGitAdapter {
  return {
    async currentBranch() {
      const result = await runCommand('git', ['branch', '--show-current']);
      if (!result.ok) throw new Error(result.stderr || 'git branch failed');
      return result.stdout.trim();
    },
    async currentCommit() {
      const result = await runCommand('git', ['rev-parse', 'HEAD']);
      if (!result.ok) throw new Error(result.stderr || 'git rev-parse failed');
      return result.stdout.trim();
    },
    async hasDirtyWorktree() {
      const result = await runCommand('git', ['status', '--porcelain']);
      if (!result.ok) throw new Error(result.stderr || 'git status failed');
      return result.stdout.trim().length > 0;
    },
    async worktreeChangedFiles() {
      const result = await runCommand('git', ['status', '--porcelain', '-z']);
      if (!result.ok) throw new Error(result.stderr || 'git status failed');
      return parsePorcelainZ(result.stdout);
    },
    async branchExists(branch: string) {
      const result = await runCommand('git', [
        'rev-parse',
        '--verify',
        '--quiet',
        branch,
      ]);
      return result.ok;
    },
    checkout(branch: string) {
      return runCommand('git', ['checkout', branch]);
    },
    createBranch(branch: string) {
      return runCommand('git', ['checkout', '-b', branch]);
    },
    addAll() {
      return runCommand('git', ['add', '-A']);
    },
    commit(message: string) {
      return runCommand('git', ['commit', '-m', message]);
    },
    stashPush(message: string) {
      return runCommand('git', ['stash', 'push', '-u', '-m', message]);
    },
    mergeNoFfNoCommit(branch: string) {
      return runCommand('git', ['merge', '--no-ff', '--no-commit', branch]);
    },
    mergeAbort() {
      return runCommand('git', ['merge', '--abort']);
    },
    async changedFiles(baseRef?: string) {
      const args = baseRef
        ? ['diff', '--name-only', baseRef, 'HEAD']
        : ['diff', '--name-only'];
      const result = await runCommand('git', args);
      if (!result.ok) throw new Error(result.stderr || 'git diff failed');
      return uniqueFiles(
        result.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      );
    },
    async diff(baseRef?: string) {
      const args = baseRef ? ['diff', baseRef] : ['diff'];
      const result = await runCommand('git', args);
      if (!result.ok) throw new Error(result.stderr || 'git diff failed');
      return result.stdout;
    },
  };
}

export async function defaultEvolutionCheckRunner(input: {
  itemId: string;
  phase: 'check' | 'adoption';
}): Promise<CommandResult> {
  const typecheck = await runCommand('npm', ['run', 'typecheck']);
  if (!typecheck.ok) {
    return {
      ...typecheck,
      command: `${typecheck.command} (${input.phase}:${input.itemId})`,
    };
  }
  const test = await runCommand('npm', ['test']);
  return {
    ok: test.ok,
    stdout: [typecheck.stdout, test.stdout].filter(Boolean).join('\n'),
    stderr: [typecheck.stderr, test.stderr].filter(Boolean).join('\n'),
    command: `${typecheck.command} && ${test.command} (${input.phase}:${input.itemId})`,
    exitCode: test.exitCode,
  };
}
