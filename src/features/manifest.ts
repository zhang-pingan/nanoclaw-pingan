import fs from 'fs';
import path from 'path';

export const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
export const FEATURE_NAV_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface FeatureNavItem {
  key: string;
  label: string;
  order?: number;
}

export interface FeatureRequiredGroup {
  key: string;
  jid: string;
  name: string;
  folder: string;
  requiresTrigger?: boolean;
  description?: string;
  claudeMd: string;
}

export interface FeatureResources {
  workflowDefinitions?: string;
  cards?: string;
  skills?: string;
  agents?: string;
  mcp?: string;
  artifactContracts?: string;
  workflowEvaluators?: string;
  scripts?: string;
  templates?: string;
}

export interface FeaturePermissions {
  hostActions?: string[];
  fileScopes?: string[];
  mcpServers?: string[];
}

export interface FeatureManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  hostEntry?: string;
  rendererEntry?: string;
  apiPrefix?: string;
  nav?: FeatureNavItem[];
  requiredGroups?: FeatureRequiredGroup[];
  resources?: FeatureResources;
  permissions?: FeaturePermissions;
}

export interface LoadedFeatureManifest {
  manifest: FeatureManifest;
  root: string;
  manifestPath: string;
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(
  value: unknown,
  pathName: string,
  errors: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    errors.push(`${pathName} must be a string`);
    return undefined;
  }
  return value;
}

function requiredString(
  value: unknown,
  pathName: string,
  errors: string[],
): string {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${pathName} is required`);
    return '';
  }
  return value;
}

function normalizeStringArray(
  value: unknown,
  pathName: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${pathName} must be an array`);
    return undefined;
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      errors.push(`${pathName}[${index}] must be a non-empty string`);
      return;
    }
    result.push(item);
  });
  return result;
}

function normalizeNav(
  value: unknown,
  errors: string[],
): FeatureNavItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push('nav must be an array');
    return undefined;
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`nav[${index}] must be an object`);
      return { key: '', label: '' };
    }
    const key = requiredString(item.key, `nav[${index}].key`, errors);
    const label = requiredString(item.label, `nav[${index}].label`, errors);
    if (key && !FEATURE_NAV_KEY_PATTERN.test(key)) {
      errors.push(
        `nav[${index}].key "${key}" can only contain letters, numbers, "_" and "-"`,
      );
    }
    if (item.order !== undefined && typeof item.order !== 'number') {
      errors.push(`nav[${index}].order must be a number`);
    }
    return {
      key,
      label,
      order: typeof item.order === 'number' ? item.order : undefined,
    };
  });
}

function normalizeRequiredGroups(
  value: unknown,
  errors: string[],
): FeatureRequiredGroup[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push('requiredGroups must be an array');
    return undefined;
  }
  return value.map((item, index) => {
    if (!isPlainObject(item)) {
      errors.push(`requiredGroups[${index}] must be an object`);
      return {
        key: '',
        jid: '',
        name: '',
        folder: '',
        claudeMd: '',
      };
    }
    const key = requiredString(
      item.key,
      `requiredGroups[${index}].key`,
      errors,
    );
    const jid = requiredString(
      item.jid,
      `requiredGroups[${index}].jid`,
      errors,
    );
    const name = requiredString(
      item.name,
      `requiredGroups[${index}].name`,
      errors,
    );
    const folder = requiredString(
      item.folder,
      `requiredGroups[${index}].folder`,
      errors,
    );
    const claudeMd = requiredString(
      item.claudeMd,
      `requiredGroups[${index}].claudeMd`,
      errors,
    );
    if (
      item.requiresTrigger !== undefined &&
      typeof item.requiresTrigger !== 'boolean'
    ) {
      errors.push(`requiredGroups[${index}].requiresTrigger must be a boolean`);
    }
    return {
      key,
      jid,
      name,
      folder,
      requiresTrigger:
        typeof item.requiresTrigger === 'boolean'
          ? item.requiresTrigger
          : undefined,
      description: optionalString(
        item.description,
        `requiredGroups[${index}].description`,
        errors,
      ),
      claudeMd,
    };
  });
}

function normalizeResources(
  value: unknown,
  errors: string[],
): FeatureResources | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push('resources must be an object');
    return undefined;
  }
  return {
    workflowDefinitions: optionalString(
      value.workflowDefinitions,
      'resources.workflowDefinitions',
      errors,
    ),
    cards: optionalString(value.cards, 'resources.cards', errors),
    skills: optionalString(value.skills, 'resources.skills', errors),
    agents: optionalString(value.agents, 'resources.agents', errors),
    mcp: optionalString(value.mcp, 'resources.mcp', errors),
    artifactContracts: optionalString(
      value.artifactContracts,
      'resources.artifactContracts',
      errors,
    ),
    workflowEvaluators: optionalString(
      value.workflowEvaluators,
      'resources.workflowEvaluators',
      errors,
    ),
    scripts: optionalString(value.scripts, 'resources.scripts', errors),
    templates: optionalString(value.templates, 'resources.templates', errors),
  };
}

function normalizePermissions(
  value: unknown,
  errors: string[],
): FeaturePermissions | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push('permissions must be an object');
    return undefined;
  }
  return {
    hostActions: normalizeStringArray(
      value.hostActions,
      'permissions.hostActions',
      errors,
    ),
    fileScopes: normalizeStringArray(
      value.fileScopes,
      'permissions.fileScopes',
      errors,
    ),
    mcpServers: normalizeStringArray(
      value.mcpServers,
      'permissions.mcpServers',
      errors,
    ),
  };
}

export function normalizeFeatureManifest(input: unknown): {
  manifest?: FeatureManifest;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { errors: ['feature manifest must be an object'] };
  }

  const id = requiredString(input.id, 'id', errors);
  if (id && !FEATURE_ID_PATTERN.test(id)) {
    errors.push(`id "${id}" must be kebab-case`);
  }

  const manifest: FeatureManifest = {
    id,
    name: requiredString(input.name, 'name', errors),
    version: requiredString(input.version, 'version', errors),
    description: optionalString(input.description, 'description', errors),
    hostEntry: optionalString(input.hostEntry, 'hostEntry', errors),
    rendererEntry: optionalString(input.rendererEntry, 'rendererEntry', errors),
    apiPrefix: optionalString(input.apiPrefix, 'apiPrefix', errors),
    nav: normalizeNav(input.nav, errors),
    requiredGroups: normalizeRequiredGroups(input.requiredGroups, errors),
    resources: normalizeResources(input.resources, errors),
    permissions: normalizePermissions(input.permissions, errors),
  };

  if (
    manifest.apiPrefix &&
    !manifest.apiPrefix.startsWith(`/api/features/${manifest.id}`)
  ) {
    errors.push(
      `apiPrefix "${manifest.apiPrefix}" must start with /api/features/${manifest.id}`,
    );
  }

  return { manifest: errors.length ? undefined : manifest, errors };
}

export function assertPathInsideFeature(
  featureRoot: string,
  relativePath: string,
  label: string,
): string {
  if (!relativePath.trim()) {
    throw new Error(`${label} path is required`);
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative to the feature root`);
  }
  const resolved = path.resolve(featureRoot, relativePath);
  const normalizedRoot = path.resolve(featureRoot);
  if (
    resolved !== normalizedRoot &&
    !resolved.startsWith(normalizedRoot + path.sep)
  ) {
    throw new Error(`${label} must stay inside the feature root`);
  }
  return resolved;
}

export function readFeatureManifest(
  manifestPath: string,
): LoadedFeatureManifest {
  const root = path.dirname(manifestPath);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as unknown;
  const { manifest, errors } = normalizeFeatureManifest(parsed);
  if (!manifest) {
    throw new Error(`${manifestPath}: ${errors.join('; ')}`);
  }
  if (manifest.id !== path.basename(root)) {
    throw new Error(
      `${manifestPath}: id "${manifest.id}" must match feature folder "${path.basename(root)}"`,
    );
  }
  return { manifest, root, manifestPath };
}
