import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createFileWithAnchoredParents } from './anchored-file-creation.js';
import type { WorkflowPackPersistentFileScope } from './read-only-file-gate.js';

const CONTAINER_SCOPE_ROOTS: Record<WorkflowPackPersistentFileScope, string> = {
  agent: '/workspace/agent',
  workspace: '/workspace/project',
  attachments: '/workspace/attachments',
  desktop_captures: '/workspace/desktop-captures',
  ai_images: '/workspace/ai-images',
};

const OPEN_NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export interface WorkflowPackExecutionFileScopeMapping {
  readonly scope: WorkflowPackPersistentFileScope;
  readonly sourcePath: string;
  readonly shadowHostPath: string;
}

export interface WorkflowPackExecutionFileScopeAuthorityInput {
  readonly parentDirectory: string;
  readonly runId: string;
  readonly queryId: string;
  readonly agentFolder: string;
  readonly isMain: boolean;
  readonly hostActions: readonly string[];
  readonly mappings: readonly WorkflowPackExecutionFileScopeMapping[];
}

interface CanonicalScopeMapping extends WorkflowPackExecutionFileScopeMapping {
  readonly shadowDevice: number;
  readonly shadowInode: number;
}

type ClosingDrainer = (
  authority: WorkflowPackExecutionFileScopeAuthority,
) => Promise<void>;

const activeAuthorities = new Map<
  string,
  WorkflowPackExecutionFileScopeAuthority
>();
let closingDrainer: ClosingDrainer | null = null;

function requireIdentity(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Workflow Pack file scope authority ${label} is required`);
  }
  return value;
}

function canonicalExistingDirectory(pathname: string, label: string): string {
  const resolved = fs.realpathSync.native(path.resolve(pathname));
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }
  return resolved;
}

function canonicalPath(pathname: string): string {
  const resolved = path.resolve(pathname);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function safeRelativeSegments(relativePath: string): string[] {
  if (
    typeof relativePath !== 'string' ||
    relativePath.includes('\0') ||
    path.posix.isAbsolute(relativePath)
  ) {
    throw new Error('Workflow Pack shadow child path is invalid');
  }
  const segments = relativePath.split('/');
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    throw new Error('Workflow Pack shadow child path traversal was blocked');
  }
  return segments;
}

function validateRequestId(requestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(requestId)) {
    throw new Error('Workflow Pack Host action requestId is invalid');
  }
  return requestId;
}

export function installWorkflowPackExecutionIpcClosingDrainer(
  drainer: ClosingDrainer,
): () => void {
  if (closingDrainer && closingDrainer !== drainer) {
    throw new Error('Workflow Pack IPC closing drainer is already installed');
  }
  closingDrainer = drainer;
  return () => {
    if (closingDrainer === drainer) closingDrainer = null;
  };
}

export class WorkflowPackExecutionFileScopeAuthority {
  readonly id = crypto.randomUUID();
  readonly ipcRootPath: string;
  readonly hostActionResultsPath: string;
  private readonly hostArtifactsPath: string;
  private readonly byScope = new Map<
    WorkflowPackPersistentFileScope,
    CanonicalScopeMapping
  >();
  private readonly allowedHostActions: ReadonlySet<string>;
  private registered = false;
  private acceptingOperations = false;
  private activeOperationCount = 0;
  private drainResolvers: Array<() => void> = [];
  private ipcFailures: Error[] = [];

  constructor(input: WorkflowPackExecutionFileScopeAuthorityInput) {
    this.runId = requireIdentity(input.runId, 'runId');
    this.queryId = requireIdentity(input.queryId, 'queryId');
    this.agentFolder = requireIdentity(input.agentFolder, 'agentFolder');
    this.isMain = input.isMain;
    this.allowedHostActions = new Set(input.hostActions);
    for (const mapping of input.mappings) {
      if (this.byScope.has(mapping.scope)) {
        throw new Error(
          `Workflow Pack file scope authority duplicates ${mapping.scope}`,
        );
      }
      const shadowHostPath = canonicalExistingDirectory(
        mapping.shadowHostPath,
        `Workflow Pack ${mapping.scope} shadow root`,
      );
      const stat = fs.statSync(shadowHostPath);
      this.byScope.set(mapping.scope, {
        ...mapping,
        sourcePath: canonicalPath(mapping.sourcePath),
        shadowHostPath,
        shadowDevice: stat.dev,
        shadowInode: stat.ino,
      });
    }
    fs.mkdirSync(input.parentDirectory, { recursive: true });
    this.ipcRootPath = fs.mkdtempSync(
      path.join(input.parentDirectory, `${this.id.slice(0, 12)}-`),
    );
    for (const directory of [
      'messages',
      'tasks',
      'host-action-results',
      'host-artifacts',
    ]) {
      fs.mkdirSync(path.join(this.ipcRootPath, directory), { recursive: true });
    }
    this.hostActionResultsPath = path.join(
      this.ipcRootPath,
      'host-action-results',
    );
    this.hostArtifactsPath = path.join(this.ipcRootPath, 'host-artifacts');
  }

  readonly runId: string;
  readonly queryId: string;
  readonly agentFolder: string;
  readonly isMain: boolean;

  register(): void {
    if (this.registered || activeAuthorities.has(this.id)) {
      throw new Error(
        'Workflow Pack file scope authority is already registered',
      );
    }
    this.registered = true;
    this.acceptingOperations = true;
    activeAuthorities.set(this.id, this);
  }

  allowsHostAction(action: string): boolean {
    return this.allowedHostActions.has(action);
  }

  readContainerFile(
    containerPath: string,
    allowedScopes?: ReadonlySet<WorkflowPackPersistentFileScope>,
  ): Buffer {
    const { mapping, segments } = this.parseContainerPath(
      containerPath,
      allowedScopes,
    );
    return this.readFile(mapping, segments);
  }

  readScopeFile(
    scope: WorkflowPackPersistentFileScope,
    relativePath: string,
  ): Buffer {
    return this.readFile(
      this.requireMapping(scope),
      safeRelativeSegments(relativePath),
    );
  }

  snapshotContainerFile(
    containerPath: string,
    allowedScopes?: ReadonlySet<WorkflowPackPersistentFileScope>,
  ): string {
    const { mapping, segments } = this.parseContainerPath(
      containerPath,
      allowedScopes,
    );
    const bytes = this.readFile(mapping, segments);
    const snapshotDirectory = fs.mkdtempSync(
      path.join(this.hostArtifactsPath, 'file-'),
    );
    const snapshotPath = path.join(
      snapshotDirectory,
      path.basename(segments.at(-1)!),
    );
    fs.writeFileSync(snapshotPath, bytes, { flag: 'wx', mode: 0o600 });
    return snapshotPath;
  }

  snapshotScopeDirectory(
    scope: WorkflowPackPersistentFileScope,
    relativePath: string,
  ): string {
    const mapping = this.requireMapping(scope);
    const segments = safeRelativeSegments(relativePath);
    this.assertExistingPath(mapping, segments, 'directory');
    const snapshotRoot = fs.mkdtempSync(
      path.join(this.hostArtifactsPath, 'directory-'),
    );
    this.copyDirectoryToSnapshot(mapping, segments, snapshotRoot);
    this.assertRootStable(mapping);
    return snapshotRoot;
  }

  async createScopeFile(
    scope: WorkflowPackPersistentFileScope,
    relativePath: string,
    bytes: Uint8Array,
    mode = 0o600,
    afterParentOpened?: () => void | Promise<void>,
  ): Promise<string> {
    const mapping = this.requireMapping(scope);
    const segments = safeRelativeSegments(relativePath);
    const targetPath = path.join(mapping.shadowHostPath, ...segments);
    await createFileWithAnchoredParents({
      rootPath: mapping.shadowHostPath,
      rootDevice: mapping.shadowDevice,
      rootInode: mapping.shadowInode,
      relativePath: segments.join('/'),
      bytes,
      mode,
      afterParentOpened,
      verifyCreatedFile: (identity) => {
        const verifiedPath = this.assertExistingPath(mapping, segments, 'file');
        const stat = fs.statSync(verifiedPath);
        if (stat.dev !== identity.device || stat.ino !== identity.inode) {
          throw new Error(
            'Created Workflow Pack shadow file changed during authority validation',
          );
        }
      },
    });
    this.assertExistingPath(mapping, segments, 'file');
    return targetPath;
  }

  writeHostActionResult(
    requestId: string,
    action: string,
    outcome: { status: 'success' | 'error'; error?: string },
  ): void {
    const safeRequestId = validateRequestId(requestId);
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(action)) {
      throw new Error('Workflow Pack Host action receipt action is invalid');
    }
    const resultPath = path.join(
      this.hostActionResultsPath,
      `${safeRequestId}.json`,
    );
    const payload = {
      ...outcome,
      requestId: safeRequestId,
      action,
    };
    try {
      this.writeExclusiveResult(resultPath, safeRequestId, payload);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const collisionError = new Error(
      `Workflow Pack Host action receipt collision for requestId=${safeRequestId}`,
    );
    const quarantinedPath = path.join(
      this.hostActionResultsPath,
      `.${safeRequestId}-${crypto.randomUUID()}.collision`,
    );
    try {
      fs.renameSync(resultPath, quarantinedPath);
      this.writeExclusiveResult(resultPath, safeRequestId, {
        status: 'error',
        requestId: safeRequestId,
        action,
        error: collisionError.message,
      });
    } catch (error) {
      throw new AggregateError(
        [collisionError, error],
        `Failed to publish rejected Workflow Pack Host action receipt for requestId=${safeRequestId}`,
      );
    }
    throw collisionError;
  }

  recordIpcFailure(error: unknown): void {
    this.ipcFailures.push(
      error instanceof Error ? error : new Error(String(error)),
    );
  }

  private writeExclusiveResult(
    resultPath: string,
    requestId: string,
    payload: object,
  ): void {
    const temporaryPath = path.join(
      this.hostActionResultsPath,
      `.${requestId}-${crypto.randomUUID()}.tmp`,
    );
    fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      fs.linkSync(temporaryPath, resultPath);
    } finally {
      fs.unlinkSync(temporaryPath);
    }
  }

  beginOperation(): (() => void) | null {
    if (!this.acceptingOperations || !this.registered) return null;
    this.activeOperationCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOperationCount -= 1;
      if (this.activeOperationCount === 0) {
        const resolvers = this.drainResolvers.splice(0);
        for (const resolve of resolvers) resolve();
      }
    };
  }

  async deactivateAndDrain(): Promise<void> {
    this.acceptingOperations = false;
    activeAuthorities.delete(this.id);
    if (this.activeOperationCount !== 0) {
      await new Promise<void>((resolve) => this.drainResolvers.push(resolve));
    }

    let drainError: unknown;
    try {
      const pendingBeforeDrain = this.pendingProtectedIpcFiles();
      if (pendingBeforeDrain.length > 0) {
        if (!closingDrainer) {
          throw new Error(
            `Workflow Pack IPC closed with pending requests but no closing drainer: ${pendingBeforeDrain.join(', ')}`,
          );
        }
        await closingDrainer(this);
      }
      const pendingAfterDrain = this.pendingProtectedIpcFiles();
      if (pendingAfterDrain.length > 0) {
        throw new Error(
          `Workflow Pack IPC closing drain left pending requests: ${pendingAfterDrain.join(', ')}`,
        );
      }
      if (this.ipcFailures.length > 0) {
        throw new AggregateError(
          this.ipcFailures,
          `Workflow Pack IPC rejected or failed ${this.ipcFailures.length} request(s)`,
        );
      }
    } catch (error) {
      drainError = error;
    } finally {
      this.registered = false;
    }
    if (drainError) throw drainError;
  }

  cleanup(): void {
    if (this.registered || this.activeOperationCount !== 0) {
      throw new Error(
        'Workflow Pack file scope authority must drain before cleanup',
      );
    }
    fs.rmSync(this.ipcRootPath, { recursive: true, force: true });
  }

  private requireMapping(
    scope: WorkflowPackPersistentFileScope,
  ): CanonicalScopeMapping {
    const mapping = this.byScope.get(scope);
    if (!mapping) {
      throw new Error(
        `Workflow Pack Run did not map declared file scope ${scope}`,
      );
    }
    return mapping;
  }

  private parseContainerPath(
    containerPath: string,
    allowedScopes?: ReadonlySet<WorkflowPackPersistentFileScope>,
  ): { mapping: CanonicalScopeMapping; segments: string[] } {
    if (
      typeof containerPath !== 'string' ||
      containerPath.includes('\0') ||
      !path.posix.isAbsolute(containerPath)
    ) {
      throw new Error('Workflow Pack container file path is invalid');
    }
    const normalized = path.posix.normalize(containerPath);
    const entry = (
      Object.entries(CONTAINER_SCOPE_ROOTS) as Array<
        [WorkflowPackPersistentFileScope, string]
      >
    ).find(([, root]) => normalized.startsWith(`${root}/`));
    if (!entry || (allowedScopes && !allowedScopes.has(entry[0]))) {
      throw new Error(
        `Workflow Pack container file path is outside the allowed scopes: ${containerPath}`,
      );
    }
    const [scope, containerRoot] = entry;
    const originalRelative = containerPath.slice(containerRoot.length + 1);
    const normalizedRelative = normalized.slice(containerRoot.length + 1);
    if (originalRelative !== normalizedRelative) {
      throw new Error(
        'Workflow Pack container file path traversal was blocked',
      );
    }
    return {
      mapping: this.requireMapping(scope),
      segments: safeRelativeSegments(normalizedRelative),
    };
  }

  private assertRootStable(mapping: CanonicalScopeMapping): void {
    const rootStat = fs.lstatSync(mapping.shadowHostPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error(
        `Workflow Pack ${mapping.scope} shadow root changed during the Run`,
      );
    }
    const currentRoot = fs.realpathSync.native(mapping.shadowHostPath);
    const stat = fs.statSync(currentRoot);
    if (
      currentRoot !== mapping.shadowHostPath ||
      stat.dev !== mapping.shadowDevice ||
      stat.ino !== mapping.shadowInode
    ) {
      throw new Error(
        `Workflow Pack ${mapping.scope} shadow root identity changed during the Run`,
      );
    }
  }

  private assertExistingPath(
    mapping: CanonicalScopeMapping,
    segments: readonly string[],
    kind: 'file' | 'directory' | 'any',
  ): string {
    this.assertRootStable(mapping);
    let current = mapping.shadowHostPath;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(
          'Workflow Pack shadow child path escaped through a symbolic link',
        );
      }
      const realCurrent = fs.realpathSync.native(current);
      if (!isWithinRoot(mapping.shadowHostPath, realCurrent)) {
        throw new Error(
          'Workflow Pack shadow child path escaped its authority',
        );
      }
      current = realCurrent;
    }
    const stat = fs.statSync(current);
    if (kind === 'file' && !stat.isFile()) {
      throw new Error('Workflow Pack shadow child path is not a regular file');
    }
    if (kind === 'directory' && !stat.isDirectory()) {
      throw new Error('Workflow Pack shadow child path is not a directory');
    }
    return current;
  }

  private assertFdMatchesPath(
    mapping: CanonicalScopeMapping,
    segments: readonly string[],
    fd: number,
  ): void {
    const verifiedPath = this.assertExistingPath(mapping, segments, 'file');
    const openedStat = fs.fstatSync(fd);
    const verifiedStat = fs.statSync(verifiedPath);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== verifiedStat.dev ||
      openedStat.ino !== verifiedStat.ino
    ) {
      throw new Error(
        'Opened Workflow Pack shadow file changed during authority validation',
      );
    }
  }

  private readFile(
    mapping: CanonicalScopeMapping,
    segments: readonly string[],
  ): Buffer {
    const targetPath = this.assertExistingPath(mapping, segments, 'file');
    const targetStat = fs.statSync(targetPath);
    let fd: number | null = null;
    try {
      fd = fs.openSync(targetPath, fs.constants.O_RDONLY | OPEN_NO_FOLLOW);
      const openedStat = fs.fstatSync(fd);
      if (
        !openedStat.isFile() ||
        openedStat.dev !== targetStat.dev ||
        openedStat.ino !== targetStat.ino
      ) {
        throw new Error(
          'Workflow Pack shadow child path is not a regular file',
        );
      }
      this.assertFdMatchesPath(mapping, segments, fd);
      const bytes = fs.readFileSync(fd);
      this.assertFdMatchesPath(mapping, segments, fd);
      return bytes;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private copyDirectoryToSnapshot(
    mapping: CanonicalScopeMapping,
    sourceSegments: readonly string[],
    destination: string,
  ): void {
    const sourcePath = this.assertExistingPath(
      mapping,
      sourceSegments,
      'directory',
    );
    for (const entry of fs.readdirSync(sourcePath).sort()) {
      const entrySegments = [...sourceSegments, entry];
      const entryPath = path.join(sourcePath, entry);
      const stat = fs.lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          'Workflow Pack shadow directory snapshot rejected a symbolic link',
        );
      }
      const destinationPath = path.join(destination, entry);
      if (stat.isDirectory()) {
        fs.mkdirSync(destinationPath, { mode: stat.mode & 0o777 });
        this.copyDirectoryToSnapshot(mapping, entrySegments, destinationPath);
      } else if (stat.isFile()) {
        const bytes = this.readFile(mapping, entrySegments);
        fs.writeFileSync(destinationPath, bytes, {
          flag: 'wx',
          mode: stat.mode & 0o777,
        });
      } else {
        throw new Error(
          'Workflow Pack shadow directory snapshot only supports files and directories',
        );
      }
    }
  }

  private pendingProtectedIpcFiles(): string[] {
    return ['messages', 'tasks'].flatMap((directory) => {
      const directoryPath = path.join(this.ipcRootPath, directory);
      return fs
        .readdirSync(directoryPath)
        .filter((file) => file.endsWith('.json') || file.endsWith('.tmp'))
        .sort()
        .map((file) => `${directory}/${file}`);
    });
  }
}

export function createWorkflowPackExecutionFileScopeAuthority(
  input: WorkflowPackExecutionFileScopeAuthorityInput,
): WorkflowPackExecutionFileScopeAuthority {
  return new WorkflowPackExecutionFileScopeAuthority(input);
}

export function activeWorkflowPackExecutionFileScopeAuthorities(): readonly WorkflowPackExecutionFileScopeAuthority[] {
  return [...activeAuthorities.values()];
}
