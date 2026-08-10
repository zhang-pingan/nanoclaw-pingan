import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type WorkflowPackPersistentFileScope =
  | 'agent'
  | 'workspace'
  | 'attachments'
  | 'desktop_captures'
  | 'ai_images';

export interface WorkflowPackReadOnlyScopeSource {
  readonly scope: WorkflowPackPersistentFileScope;
  readonly sourcePath: string;
}

interface FileState {
  readonly type: 'directory' | 'file' | 'symlink';
  readonly mode: number;
  readonly contentHash?: string;
  readonly linkTarget?: string;
}

export interface WorkflowPackReadOnlyFileGateResult {
  readonly clean: boolean;
  readonly changes: string[];
}

interface ScopeState {
  readonly sourcePath: string;
  readonly initialSource: Map<string, FileState>;
  readonly initialShadow: Map<string, FileState>;
}

const CHANGE_LIMIT = 20;

function modeBits(stat: fs.Stats): number {
  return stat.mode & 0o7777;
}

function withReadableDirectory<T>(
  pathname: string,
  stat: fs.Stats,
  action: () => T,
): T {
  const originalMode = modeBits(stat);
  const readableMode = originalMode | 0o500;
  if (readableMode !== originalMode) fs.chmodSync(pathname, readableMode);
  try {
    return action();
  } finally {
    if (readableMode !== originalMode) fs.chmodSync(pathname, originalMode);
  }
}

function hashFile(pathname: string, stat: fs.Stats): string {
  const originalMode = modeBits(stat);
  const readableMode = originalMode | 0o400;
  if (readableMode !== originalMode) fs.chmodSync(pathname, readableMode);
  try {
    return `sha256:${crypto
      .createHash('sha256')
      .update(fs.readFileSync(pathname))
      .digest('hex')}`;
  } finally {
    if (readableMode !== originalMode) fs.chmodSync(pathname, originalMode);
  }
}

function snapshotTree(root: string): Map<string, FileState> {
  const snapshot = new Map<string, FileState>();
  const visit = (pathname: string, relativePath: string): void => {
    const stat = fs.lstatSync(pathname);
    const mode = modeBits(stat);
    if (stat.isSymbolicLink()) {
      snapshot.set(relativePath, {
        type: 'symlink',
        mode,
        linkTarget: fs.readlinkSync(pathname),
      });
      return;
    }
    if (stat.isFile()) {
      snapshot.set(relativePath, {
        type: 'file',
        mode,
        contentHash: hashFile(pathname, stat),
      });
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `Workflow Pack read-only scope contains an unsupported file type: ${pathname}`,
      );
    }
    snapshot.set(relativePath, { type: 'directory', mode });
    withReadableDirectory(pathname, stat, () => {
      for (const entry of fs.readdirSync(pathname).sort()) {
        visit(
          path.join(pathname, entry),
          relativePath === '.' ? entry : `${relativePath}/${entry}`,
        );
      }
    });
  };
  visit(root, '.');
  return snapshot;
}

function copyTree(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  const mode = modeBits(stat);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, mode);
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `Workflow Pack read-only scope contains an unsupported file type: ${source}`,
    );
  }
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const entry of fs.readdirSync(source).sort()) {
    copyTree(path.join(source, entry), path.join(destination, entry));
  }
  fs.chmodSync(destination, mode);
}

function sameState(left: FileState, right: FileState): boolean {
  return (
    left.type === right.type &&
    left.mode === right.mode &&
    left.contentHash === right.contentHash &&
    left.linkTarget === right.linkTarget
  );
}

function describeChanges(
  label: string,
  before: Map<string, FileState>,
  after: Map<string, FileState>,
): string[] {
  const changes: string[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const relativePath of paths) {
    const initial = before.get(relativePath);
    const final = after.get(relativePath);
    if (!initial) {
      changes.push(`${label}:${relativePath} added`);
    } else if (!final) {
      changes.push(`${label}:${relativePath} deleted`);
    } else if (!sameState(initial, final)) {
      const details: string[] = [];
      if (initial.type !== final.type) details.push('type');
      if (initial.mode !== final.mode) details.push('permissions');
      if (initial.contentHash !== final.contentHash) details.push('content');
      if (initial.linkTarget !== final.linkTarget) details.push('link target');
      changes.push(`${label}:${relativePath} changed (${details.join(', ')})`);
    }
    if (changes.length === CHANGE_LIMIT) break;
  }
  return changes;
}

function makeTreeRemovable(pathname: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  fs.chmodSync(pathname, modeBits(stat) | 0o700);
  for (const entry of fs.readdirSync(pathname)) {
    makeTreeRemovable(path.join(pathname, entry));
  }
}

export class WorkflowPackReadOnlyFileGate {
  private cleaned = false;

  constructor(
    readonly rootPath: string,
    private readonly initialState: ReadonlyMap<
      WorkflowPackPersistentFileScope,
      ScopeState
    >,
  ) {}

  mountPath(scope: WorkflowPackPersistentFileScope): string {
    if (!this.initialState.has(scope)) {
      throw new Error(
        `Workflow Pack read-only scope was not prepared: ${scope}`,
      );
    }
    return path.join(this.rootPath, scope);
  }

  verify(): WorkflowPackReadOnlyFileGateResult {
    if (this.cleaned) {
      throw new Error('Workflow Pack read-only file gate was already cleaned');
    }
    const changes: string[] = [];
    for (const [scope, state] of this.initialState) {
      const finalShadow = snapshotTree(this.mountPath(scope));
      changes.push(...describeChanges(scope, state.initialShadow, finalShadow));
      try {
        const finalSource = snapshotTree(state.sourcePath);
        changes.push(
          ...describeChanges(
            `${scope}:source`,
            state.initialSource,
            finalSource,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          changes.push(`${scope}:source:. deleted`);
        } else {
          throw error;
        }
      }
      if (changes.length >= CHANGE_LIMIT) break;
    }
    return {
      clean: changes.length === 0,
      changes: changes.slice(0, CHANGE_LIMIT),
    };
  }

  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    try {
      makeTreeRemovable(this.rootPath);
    } finally {
      fs.rmSync(this.rootPath, { recursive: true, force: true });
    }
  }
}

export function prepareWorkflowPackReadOnlyFileGate(input: {
  readonly parentDirectory: string;
  readonly runKey: string;
  readonly scopes: readonly WorkflowPackReadOnlyScopeSource[];
}): WorkflowPackReadOnlyFileGate {
  fs.mkdirSync(input.parentDirectory, { recursive: true });
  const safeRunKey = input.runKey.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
  const rootPath = fs.mkdtempSync(
    path.join(input.parentDirectory, `${safeRunKey || 'run'}-`),
  );
  const initialState = new Map<WorkflowPackPersistentFileScope, ScopeState>();
  const gate = new WorkflowPackReadOnlyFileGate(rootPath, initialState);
  try {
    for (const { scope, sourcePath } of input.scopes) {
      if (initialState.has(scope)) {
        throw new Error(
          `Workflow Pack read-only scope is duplicated: ${scope}`,
        );
      }
      const sourceStat = fs.lstatSync(sourcePath);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        throw new Error(
          `Workflow Pack read-only scope must be a directory: ${scope}`,
        );
      }
      const destination = path.join(rootPath, scope);
      const sourceBeforeCopy = snapshotTree(sourcePath);
      copyTree(sourcePath, destination);
      const sourceAfterCopy = snapshotTree(sourcePath);
      const preparationChanges = describeChanges(
        `${scope}:source`,
        sourceBeforeCopy,
        sourceAfterCopy,
      );
      if (preparationChanges.length > 0) {
        throw new Error(
          `Workflow Pack read-only source changed while preparing its isolated copy: ${preparationChanges.join('; ')}`,
        );
      }
      initialState.set(scope, {
        sourcePath,
        initialSource: sourceAfterCopy,
        initialShadow: snapshotTree(destination),
      });
    }
    return gate;
  } catch (error) {
    gate.cleanup();
    throw error;
  }
}
