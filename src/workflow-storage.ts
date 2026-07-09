import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { Workflow } from './types.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';
import type {
  WorkflowStorageConfig,
  WorkflowStorageRootConfig,
  WorkflowStorageRootKind,
} from './workflow-definition.js';

export interface FeatureDataRoot {
  featureId: string;
  mode: 'managed' | 'external';
  rootPath: string;
  readonly?: boolean;
  rootId?: string;
}

export interface ResolvedStorageRoot {
  kind: WorkflowStorageRootKind;
  workflowId?: string;
  featureId?: string;
  rootId?: string;
  hostPath: string;
  containerPath: string;
  locationUri: string;
  relativePath: string;
}

export interface ResolvedStorageLocation extends ResolvedStorageRoot {
  hostPath: string;
  containerPath: string;
  locationUri: string;
  rootHostPath: string;
  rootContainerPath: string;
  rootLocationUri: string;
  relativePath: string;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const externalFeatureDataRoots = new Map<string, FeatureDataRoot>();

function assertSafeId(label: string, value: string): string {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed !== value ||
    !SAFE_ID_PATTERN.test(trimmed) ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    path.isAbsolute(trimmed)
  ) {
    throw new Error(`${label} "${value}" is not a safe path segment`);
  }
  return trimmed;
}

function pathInside(childPath: string, parentPath: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function posixJoin(...parts: string[]): string {
  const joined = path.posix.join(...parts.filter((part) => part !== ''));
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function uriJoin(base: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath, {
    allowEmpty: true,
    label: 'location relative path',
  });
  return normalized ? `${base.replace(/\/+$/, '')}/${normalized}` : base;
}

function getTemplatePathValue(value: unknown, expression: string): unknown {
  return expression
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        return undefined;
      }
      return (current as Record<string, unknown>)[key];
    }, value);
}

function scalarTemplateValue(label: string, value: unknown): string {
  if (value === undefined || value === null || value === '') {
    throw new Error(
      `Missing workflow storage template variable "{{${label}}}"`,
    );
  }
  if (
    typeof value !== 'string' &&
    typeof value !== 'number' &&
    typeof value !== 'boolean'
  ) {
    throw new Error(
      `Workflow storage template variable "{{${label}}}" must be scalar`,
    );
  }
  return String(value);
}

export function renderWorkflowStorageTemplate(input: {
  workflow: Workflow;
  template: string;
  stageKey?: string;
  extraVars?: Record<string, unknown>;
}): string {
  const context = input.workflow.context || {};
  const vars: Record<string, unknown> = {
    ...context,
    ...(input.extraVars || {}),
    workflow_id: input.workflow.id,
    workflow_type: input.workflow.workflow_type,
    service: input.workflow.service,
    stage_key: input.stageKey || input.workflow.status,
    feature_id: input.workflow.feature_id || '',
    round: input.workflow.round,
    deliverable:
      getWorkflowContextValue(
        input.workflow,
        WORKFLOW_CONTEXT_KEYS.deliverable,
      ) || '',
  };

  return input.template.replace(/\{\{([^{}]+)}}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const value = key.startsWith('context.')
      ? getTemplatePathValue(context, key.slice('context.'.length))
      : key.includes('.')
        ? getTemplatePathValue(vars, key)
        : vars[key];
    return scalarTemplateValue(key, value);
  });
}

export function normalizeRelativePath(
  value: string,
  opts: { allowEmpty?: boolean; label?: string } = {},
): string {
  const label = opts.label || 'relative path';
  const trimmed = value.trim().replace(/^\/+/, '');
  if (!trimmed) {
    if (opts.allowEmpty) return '';
    throw new Error(`${label} is required`);
  }
  if (
    trimmed.includes('\0') ||
    trimmed.includes('\\') ||
    path.posix.isAbsolute(trimmed)
  ) {
    throw new Error(`${label} "${value}" must be a safe relative path`);
  }
  const normalized = path.posix.normalize(trimmed);
  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`${label} "${value}" must stay inside its root`);
  }
  return normalized === '.' ? '' : normalized;
}

function normalizeStoragePath(input: {
  workflow: Workflow;
  template: string;
  stageKey?: string;
  extraVars?: Record<string, unknown>;
  label: string;
}): string {
  return normalizeRelativePath(
    renderWorkflowStorageTemplate({
      workflow: input.workflow,
      template: input.template,
      stageKey: input.stageKey,
      extraVars: input.extraVars,
    }),
    { allowEmpty: true, label: input.label },
  );
}

function workflowRuntimeHostRoot(workflowId: string): string {
  return path.join(
    DATA_DIR,
    'workflows',
    assertSafeId('workflow_id', workflowId),
  );
}

function workflowRuntimeContainerRoot(workflowId: string): string {
  return `/workspace/workflows/${assertSafeId('workflow_id', workflowId)}`;
}

function managedFeatureDataHostRoot(featureId: string): string {
  return path.join(DATA_DIR, 'features', assertSafeId('feature_id', featureId));
}

function managedFeatureDataContainerRoot(featureId: string): string {
  return `/workspace/features/${assertSafeId('feature_id', featureId)}/data`;
}

function externalRootKey(featureId: string, rootId: string): string {
  return `${featureId}:${rootId}`;
}

function defaultRootConfig(
  rootName: 'artifact_root' | 'context_pack_root',
): WorkflowStorageRootConfig {
  return {
    kind: 'workflow_runtime',
    path: rootName === 'artifact_root' ? 'artifacts' : 'context/{{stage_key}}',
  };
}

export function getWorkflowRuntimeRoot(
  workflowId: string,
): ResolvedStorageRoot {
  const safeWorkflowId = assertSafeId('workflow_id', workflowId);
  const hostPath = workflowRuntimeHostRoot(safeWorkflowId);
  return {
    kind: 'workflow_runtime',
    workflowId: safeWorkflowId,
    hostPath,
    containerPath: workflowRuntimeContainerRoot(safeWorkflowId),
    locationUri: `workflow://${safeWorkflowId}`,
    relativePath: '',
  };
}

export function getFeatureDataRoot(featureId: string): FeatureDataRoot {
  const safeFeatureId = assertSafeId('feature_id', featureId);
  return {
    featureId: safeFeatureId,
    mode: 'managed',
    rootPath: managedFeatureDataHostRoot(safeFeatureId),
    readonly: false,
  };
}

export function registerExternalFeatureDataRoot(input: {
  featureId: string;
  rootId: string;
  rootPath: string;
  readonly?: boolean;
}): FeatureDataRoot {
  const featureId = assertSafeId('feature_id', input.featureId);
  const rootId = assertSafeId('external feature data root id', input.rootId);
  const rootPath = path.resolve(input.rootPath);
  const root: FeatureDataRoot = {
    featureId,
    rootId,
    mode: 'external',
    rootPath,
    readonly: input.readonly,
  };
  externalFeatureDataRoots.set(externalRootKey(featureId, rootId), root);
  return root;
}

export function getExternalFeatureDataRoot(
  featureId: string,
  rootId: string,
): FeatureDataRoot | undefined {
  return externalFeatureDataRoots.get(
    externalRootKey(
      assertSafeId('feature_id', featureId),
      assertSafeId('external feature data root id', rootId),
    ),
  );
}

export function resolveFeatureDataPath(
  featureId: string,
  relativePath: string,
): ResolvedStorageLocation {
  const root = getFeatureDataRoot(featureId);
  const safeRelativePath = normalizeRelativePath(relativePath, {
    allowEmpty: true,
    label: 'feature data path',
  });
  const hostPath = path.join(root.rootPath, safeRelativePath);
  assertPathInsideFeatureData(root.featureId, hostPath);
  const rootContainerPath = managedFeatureDataContainerRoot(root.featureId);
  const rootLocationUri = `feature://${root.featureId}`;
  return {
    kind: 'feature_data',
    featureId: root.featureId,
    hostPath,
    containerPath: posixJoin(rootContainerPath, safeRelativePath),
    locationUri: uriJoin(rootLocationUri, safeRelativePath),
    relativePath: safeRelativePath,
    rootHostPath: root.rootPath,
    rootContainerPath,
    rootLocationUri,
  };
}

export function assertPathInsideFeatureData(
  featureId: string,
  hostPath: string,
): void {
  const root = getFeatureDataRoot(featureId);
  if (!pathInside(hostPath, root.rootPath)) {
    throw new Error(
      `Path "${hostPath}" is outside feature data root for "${featureId}"`,
    );
  }
}

export function resolveWorkflowStorageRoot(input: {
  workflow: Workflow;
  storage?: WorkflowStorageConfig;
  root: 'artifact_root' | 'context_pack_root';
  stageKey?: string;
  extraVars?: Record<string, unknown>;
  create?: boolean;
}): ResolvedStorageRoot {
  const spec = input.storage?.[input.root] || defaultRootConfig(input.root);
  if (
    spec.kind !== 'workflow_runtime' &&
    spec.kind !== 'feature_data' &&
    spec.kind !== 'external_feature_data'
  ) {
    throw new Error(`Unsupported workflow storage root kind "${spec.kind}"`);
  }
  const relativePath = normalizeStoragePath({
    workflow: input.workflow,
    template: spec.path || '',
    stageKey: input.stageKey,
    extraVars: input.extraVars,
    label: `${input.root}.path`,
  });

  let resolved: ResolvedStorageRoot;
  if (spec.kind === 'workflow_runtime') {
    const root = getWorkflowRuntimeRoot(input.workflow.id);
    resolved = {
      ...root,
      hostPath: path.join(root.hostPath, relativePath),
      containerPath: posixJoin(root.containerPath, relativePath),
      locationUri: uriJoin(root.locationUri, relativePath),
      relativePath,
    };
    if (!pathInside(resolved.hostPath, root.hostPath)) {
      throw new Error(
        `${input.root}.path must stay inside workflow runtime root`,
      );
    }
  } else if (spec.kind === 'feature_data') {
    const renderedFeatureId = spec.feature_id
      ? renderWorkflowStorageTemplate({
          workflow: input.workflow,
          template: spec.feature_id,
          stageKey: input.stageKey,
          extraVars: input.extraVars,
        })
      : input.workflow.feature_id || '';
    const featureId = assertSafeId('feature_id', renderedFeatureId);
    const location = resolveFeatureDataPath(featureId, relativePath);
    resolved = {
      kind: 'feature_data',
      featureId,
      hostPath: location.hostPath,
      containerPath: location.containerPath,
      locationUri: location.locationUri,
      relativePath,
    };
  } else {
    const renderedFeatureId = spec.feature_id
      ? renderWorkflowStorageTemplate({
          workflow: input.workflow,
          template: spec.feature_id,
          stageKey: input.stageKey,
          extraVars: input.extraVars,
        })
      : input.workflow.feature_id || '';
    const featureId = assertSafeId('feature_id', renderedFeatureId);
    const rootId = assertSafeId(
      'external feature data root id',
      spec.root_id || 'default',
    );
    const external = getExternalFeatureDataRoot(featureId, rootId);
    if (!external) {
      throw new Error(
        `External feature data root "${rootId}" for feature "${featureId}" is not registered`,
      );
    }
    const hostPath = path.join(external.rootPath, relativePath);
    if (!pathInside(hostPath, external.rootPath)) {
      throw new Error(
        `${input.root}.path must stay inside external feature data root`,
      );
    }
    resolved = {
      kind: 'external_feature_data',
      featureId,
      rootId,
      hostPath,
      containerPath: posixJoin(
        `/workspace/features/${featureId}/external/${rootId}`,
        relativePath,
      ),
      locationUri: uriJoin(
        `external-feature://${featureId}/${rootId}`,
        relativePath,
      ),
      relativePath,
    };
  }

  if (input.create) {
    fs.mkdirSync(resolved.hostPath, { recursive: true });
  }
  return resolved;
}

export function resolveWorkflowArtifactLocation(input: {
  workflow: Workflow;
  storage?: WorkflowStorageConfig;
  artifactPath: string;
  root?: 'artifact_root' | 'context_pack_root';
  stageKey?: string;
  extraVars?: Record<string, unknown>;
}): ResolvedStorageLocation {
  const rawPath = input.artifactPath.trim();
  if (!rawPath) {
    throw new Error('artifact path is required');
  }
  if (
    rawPath.startsWith('workflow://') ||
    rawPath.startsWith('feature://') ||
    rawPath.startsWith('external-feature://')
  ) {
    return resolveLocationUri(rawPath);
  }
  if (rawPath.startsWith('/workspace/')) {
    const resolved = resolveWorkspacePathToHost(rawPath);
    if (!resolved) {
      throw new Error(`Unsupported workspace path "${rawPath}"`);
    }
    return resolved;
  }

  const relativePath = normalizeStoragePath({
    workflow: input.workflow,
    template: rawPath,
    stageKey: input.stageKey,
    extraVars: input.extraVars,
    label: 'artifact.path',
  });
  const root = resolveWorkflowStorageRoot({
    workflow: input.workflow,
    storage: input.storage,
    root: input.root || 'artifact_root',
    stageKey: input.stageKey,
    extraVars: input.extraVars,
  });
  const hostPath = path.join(root.hostPath, relativePath);
  if (!pathInside(hostPath, root.hostPath)) {
    throw new Error(
      `artifact path "${rawPath}" must stay inside ${input.root || 'artifact_root'}`,
    );
  }
  return {
    ...root,
    hostPath,
    containerPath: posixJoin(root.containerPath, relativePath),
    locationUri: uriJoin(root.locationUri, relativePath),
    rootHostPath: root.hostPath,
    rootContainerPath: root.containerPath,
    rootLocationUri: root.locationUri,
    relativePath,
  };
}

export function resolveWorkspacePathToHost(
  workspacePath: string,
): ResolvedStorageLocation | null {
  const value = workspacePath.trim();
  if (
    !value.startsWith('/workspace/') ||
    value.includes('\0') ||
    value.split('/').some((segment) => segment === '..')
  ) {
    return null;
  }
  const workflowMatch = value.match(
    /^\/workspace\/workflows\/([^/]+)(?:\/(.*))?$/,
  );
  if (workflowMatch) {
    const workflowId = assertSafeId('workflow_id', workflowMatch[1] || '');
    const relativePath = normalizeRelativePath(workflowMatch[2] || '', {
      allowEmpty: true,
      label: 'workflow workspace path',
    });
    const root = getWorkflowRuntimeRoot(workflowId);
    const hostPath = path.join(root.hostPath, relativePath);
    if (!pathInside(hostPath, root.hostPath)) return null;
    return {
      ...root,
      hostPath,
      containerPath: posixJoin(root.containerPath, relativePath),
      locationUri: uriJoin(root.locationUri, relativePath),
      rootHostPath: root.hostPath,
      rootContainerPath: root.containerPath,
      rootLocationUri: root.locationUri,
      relativePath,
    };
  }
  const featureMatch = value.match(
    /^\/workspace\/features\/([^/]+)\/data(?:\/(.*))?$/,
  );
  if (featureMatch) {
    return resolveFeatureDataPath(featureMatch[1] || '', featureMatch[2] || '');
  }
  const externalMatch = value.match(
    /^\/workspace\/features\/([^/]+)\/external\/([^/]+)(?:\/(.*))?$/,
  );
  if (externalMatch) {
    const featureId = assertSafeId('feature_id', externalMatch[1] || '');
    const rootId = assertSafeId(
      'external feature data root id',
      externalMatch[2] || '',
    );
    const external = getExternalFeatureDataRoot(featureId, rootId);
    if (!external) return null;
    const relativePath = normalizeRelativePath(externalMatch[3] || '', {
      allowEmpty: true,
      label: 'external feature data path',
    });
    const hostPath = path.join(external.rootPath, relativePath);
    if (!pathInside(hostPath, external.rootPath)) return null;
    return {
      kind: 'external_feature_data',
      featureId,
      rootId,
      hostPath,
      containerPath: posixJoin(
        `/workspace/features/${featureId}/external/${rootId}`,
        relativePath,
      ),
      locationUri: uriJoin(
        `external-feature://${featureId}/${rootId}`,
        relativePath,
      ),
      relativePath,
      rootHostPath: external.rootPath,
      rootContainerPath: `/workspace/features/${featureId}/external/${rootId}`,
      rootLocationUri: `external-feature://${featureId}/${rootId}`,
    };
  }
  return null;
}

export function resolveLocationUri(uri: string): ResolvedStorageLocation {
  const parsed = new URL(uri);
  const relativePath = normalizeRelativePath(
    parsed.pathname.replace(/^\/+/, ''),
    {
      allowEmpty: true,
      label: 'location URI path',
    },
  );
  if (parsed.protocol === 'workflow:') {
    const workflowId = assertSafeId('workflow_id', parsed.hostname);
    const root = getWorkflowRuntimeRoot(workflowId);
    const hostPath = path.join(root.hostPath, relativePath);
    if (!pathInside(hostPath, root.hostPath)) {
      throw new Error(`Location URI "${uri}" escapes workflow runtime root`);
    }
    return {
      ...root,
      hostPath,
      containerPath: posixJoin(root.containerPath, relativePath),
      locationUri: uriJoin(root.locationUri, relativePath),
      relativePath,
      rootHostPath: root.hostPath,
      rootContainerPath: root.containerPath,
      rootLocationUri: root.locationUri,
    };
  }
  if (parsed.protocol === 'feature:') {
    return resolveFeatureDataPath(parsed.hostname, relativePath);
  }
  if (parsed.protocol === 'external-feature:') {
    const featureId = assertSafeId('feature_id', parsed.hostname);
    const [rootIdRaw, ...rest] = relativePath.split('/');
    const rootId = assertSafeId(
      'external feature data root id',
      rootIdRaw || '',
    );
    const externalRelativePath = rest.join('/');
    const external = getExternalFeatureDataRoot(featureId, rootId);
    if (!external) {
      throw new Error(
        `External feature data root "${rootId}" for feature "${featureId}" is not registered`,
      );
    }
    const hostPath = path.join(external.rootPath, externalRelativePath);
    if (!pathInside(hostPath, external.rootPath)) {
      throw new Error(
        `Location URI "${uri}" escapes external feature data root`,
      );
    }
    return {
      kind: 'external_feature_data',
      featureId,
      rootId,
      hostPath,
      containerPath: posixJoin(
        `/workspace/features/${featureId}/external/${rootId}`,
        externalRelativePath,
      ),
      locationUri: uriJoin(
        `external-feature://${featureId}/${rootId}`,
        externalRelativePath,
      ),
      relativePath: externalRelativePath,
      rootHostPath: external.rootPath,
      rootContainerPath: `/workspace/features/${featureId}/external/${rootId}`,
      rootLocationUri: `external-feature://${featureId}/${rootId}`,
    };
  }
  throw new Error(`Unsupported location URI "${uri}"`);
}

export function resolveAllowedStorageRoot(input: {
  workflow: Workflow;
  storage?: WorkflowStorageConfig;
  allowedRoot: string;
  stageKey?: string;
}): ResolvedStorageRoot | null {
  const allowedRoot = input.allowedRoot.trim();
  if (!allowedRoot) return null;
  if (allowedRoot === 'root:artifact_root') {
    return resolveWorkflowStorageRoot({
      workflow: input.workflow,
      storage: input.storage,
      root: 'artifact_root',
      stageKey: input.stageKey,
    });
  }
  if (allowedRoot === 'root:context_pack_root') {
    return resolveWorkflowStorageRoot({
      workflow: input.workflow,
      storage: input.storage,
      root: 'context_pack_root',
      stageKey: input.stageKey,
    });
  }
  if (allowedRoot === 'workflow://current') {
    return getWorkflowRuntimeRoot(input.workflow.id);
  }
  if (allowedRoot.startsWith('workflow://')) {
    const location = resolveLocationUri(allowedRoot);
    return {
      kind: location.kind,
      workflowId: location.workflowId,
      hostPath: location.hostPath,
      containerPath: location.containerPath,
      locationUri: location.locationUri,
      relativePath: location.relativePath,
    };
  }
  if (
    allowedRoot.startsWith('feature://') ||
    allowedRoot.startsWith('external-feature://')
  ) {
    const location = resolveLocationUri(allowedRoot);
    return {
      kind: location.kind,
      featureId: location.featureId,
      rootId: location.rootId,
      hostPath: location.hostPath,
      containerPath: location.containerPath,
      locationUri: location.locationUri,
      relativePath: location.relativePath,
    };
  }
  if (allowedRoot.startsWith('/workspace/')) {
    const location = resolveWorkspacePathToHost(allowedRoot);
    if (!location) return null;
    return {
      kind: location.kind,
      workflowId: location.workflowId,
      featureId: location.featureId,
      rootId: location.rootId,
      hostPath: location.hostPath,
      containerPath: location.containerPath,
      locationUri: location.locationUri,
      relativePath: location.relativePath,
    };
  }
  return null;
}

export function isPathInsideResolvedRoot(
  hostPath: string,
  root: ResolvedStorageRoot,
): boolean {
  return pathInside(hostPath, root.hostPath);
}
