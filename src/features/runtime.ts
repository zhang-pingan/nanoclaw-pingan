import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { PROJECT_ROOT } from '../config.js';
import { logger } from '../logger.js';
import {
  assertPathInsideFeature,
  FeatureManifest,
  FeatureResources,
  LoadedFeatureManifest,
  readFeatureManifest,
} from './manifest.js';
import { loadFeatureRuntimeConfig } from './config.js';
import { provisionFeatureAgents } from './provisioning.js';
import {
  createAuditService,
  createEventRegistry,
  createFeatureLogger,
  createPermissionRegistry,
  clearFeatureEventSubscriptions,
  FeatureContext,
  FeatureModule,
} from './context.js';
import {
  createScopedApiRegistry,
  EnabledFeatureRuntimeInfo,
  featureApiRoutes,
  featureNavigation,
  featureResources,
  resetFeatureRegistries,
} from './registry.js';
import { featureMigrations, runFeatureMigrations } from './migrations.js';

export interface FeatureRuntimeState {
  installed: LoadedFeatureManifest[];
  enabled: LoadedFeatureManifest[];
  enabledInfo: EnabledFeatureRuntimeInfo[];
}

interface ActiveFeatureHost {
  featureId: string;
  module: FeatureModule;
  context: FeatureContext;
}

let state: FeatureRuntimeState = {
  installed: [],
  enabled: [],
  enabledInfo: [],
};
let activeHosts: ActiveFeatureHost[] = [];

const RESOURCE_KINDS: Array<keyof FeatureResources> = [
  'skills',
  'agents',
  'mcp',
  'scripts',
  'templates',
];

export async function activateConfiguredFeatures(): Promise<FeatureRuntimeState> {
  await deactivateActiveHosts();
  resetFeatureRegistries();
  featureMigrations.clear();
  const nextActiveHosts: ActiveFeatureHost[] = [];

  const installed = scanInstalledFeatures();
  const enabledIds = loadFeatureRuntimeConfig().enabled;
  const installedById = new Map(
    installed.map((feature) => [feature.manifest.id, feature]),
  );
  const enabled = enabledIds.map((featureId) => {
    const feature = installedById.get(featureId);
    if (!feature) {
      throw new Error(
        `Feature "${featureId}" is enabled but no features/${featureId}/feature.json was found`,
      );
    }
    return feature;
  });

  validateEnabledFeatureSet(enabled);

  for (const feature of enabled) {
    provisionFeatureAgents({
      featureId: feature.manifest.id,
      featureRoot: feature.root,
      manifest: feature.manifest,
    });
  }

  for (const feature of enabled) {
    registerDeclaredResources(feature);
    registerDeclaredNavigation(feature);
    runImplicitFeatureMigrations(feature);
  }

  try {
    for (const feature of enabled) {
      const activeHost = await activateHostEntry(feature);
      if (activeHost) nextActiveHosts.push(activeHost);
    }
    await featureMigrations.runRegisteredMigrations();
  } catch (err) {
    await deactivateHosts(nextActiveHosts);
    resetFeatureRegistries();
    featureMigrations.clear();
    state = {
      installed,
      enabled: [],
      enabledInfo: [],
    };
    throw err;
  }
  activeHosts = nextActiveHosts;

  state = {
    installed,
    enabled,
    enabledInfo: enabled.map((feature) => buildEnabledFeatureInfo(feature)),
  };
  logger.info(
    { enabledFeatures: state.enabledInfo.map((feature) => feature.id) },
    'Feature runtime activated',
  );
  return state;
}

export async function deactivateConfiguredFeatures(): Promise<void> {
  await deactivateActiveHosts();
  resetFeatureRegistries();
  featureMigrations.clear();
  state = {
    installed: scanInstalledFeatures(),
    enabled: [],
    enabledInfo: [],
  };
}

export function getFeatureRuntimeState(): FeatureRuntimeState {
  return {
    installed: [...state.installed],
    enabled: [...state.enabled],
    enabledInfo: state.enabledInfo.map((feature) => ({ ...feature })),
  };
}

export function getEnabledFeatureInfo(): EnabledFeatureRuntimeInfo[] {
  return state.enabledInfo.map((feature) => ({
    ...feature,
    nav: feature.nav.map((item) => ({ ...item })),
  }));
}

export function getEnabledFeatureById(
  featureId: string,
): LoadedFeatureManifest | undefined {
  return state.enabled.find((feature) => feature.manifest.id === featureId);
}

export function resolveEnabledFeatureStaticPath(
  urlPathname: string,
): { filePath: string; featureId: string } | null {
  const match = urlPathname.match(/^\/features\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const featureId = decodeURIComponent(match[1]);
  const rest = decodeURIComponent(match[2]);
  const feature = getEnabledFeatureById(featureId);
  if (!feature) return null;
  if (rest !== 'renderer' && !rest.startsWith('renderer/')) {
    throw new Error(
      `feature static path ${urlPathname} must stay under renderer/`,
    );
  }
  const filePath = assertPathInsideFeature(
    feature.root,
    `./${rest}`,
    `feature static path ${urlPathname}`,
  );
  return { filePath, featureId };
}

export function scanInstalledFeatures(): LoadedFeatureManifest[] {
  const featuresDir = path.join(PROJECT_ROOT, 'features');
  if (!fs.existsSync(featuresDir)) return [];
  return fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(featuresDir, entry.name, 'feature.json'))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => readFeatureManifest(manifestPath))
    .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

function validateEnabledFeatureSet(features: LoadedFeatureManifest[]): void {
  const navKeys = new Map<string, string>();
  const agentKeysByFeature = new Map<string, Set<string>>();
  const agentJids = new Map<string, string>();
  const agentFolders = new Map<string, string>();

  for (const feature of features) {
    for (const item of feature.manifest.nav || []) {
      const owner = navKeys.get(item.key);
      if (owner) {
        throw new Error(
          `Feature nav key "${item.key}" is declared by both ${owner} and ${feature.manifest.id}`,
        );
      }
      navKeys.set(item.key, feature.manifest.id);
    }

    const agentKeys = agentKeysByFeature.get(feature.manifest.id) || new Set();
    agentKeysByFeature.set(feature.manifest.id, agentKeys);
    for (const agent of feature.manifest.requiredAgents || []) {
      if (agentKeys.has(agent.key)) {
        throw new Error(
          `Feature ${feature.manifest.id} declares duplicate required agent key "${agent.key}"`,
        );
      }
      agentKeys.add(agent.key);
      const jidOwner = agentJids.get(agent.jid);
      if (jidOwner) {
        throw new Error(
          `Feature agent JID "${agent.jid}" is declared by both ${jidOwner} and ${feature.manifest.id}`,
        );
      }
      const folderOwner = agentFolders.get(agent.folder);
      if (folderOwner) {
        throw new Error(
          `Feature agent folder "${agent.folder}" is declared by both ${folderOwner} and ${feature.manifest.id}`,
        );
      }
      agentJids.set(agent.jid, feature.manifest.id);
      agentFolders.set(agent.folder, feature.manifest.id);
    }
  }
}

function registerDeclaredResources(feature: LoadedFeatureManifest): void {
  const resources = feature.manifest.resources || {};
  for (const kind of RESOURCE_KINDS) {
    const relativePath = resources[kind];
    if (!relativePath) continue;
    const dir = assertPathInsideFeature(
      feature.root,
      relativePath,
      `resources.${kind}`,
    );
    if (!fs.existsSync(dir)) {
      throw new Error(
        `Feature ${feature.manifest.id} resources.${kind} not found: ${dir}`,
      );
    }
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(
        `Feature ${feature.manifest.id} resources.${kind} must be a directory: ${dir}`,
      );
    }
    validateDeclaredResourcePermissions(feature.manifest, kind, dir);
    featureResources.register({
      featureId: feature.manifest.id,
      kind,
      dir,
    });
  }
}

function validateDeclaredResourcePermissions(
  manifest: FeatureManifest,
  kind: keyof FeatureResources,
  dir: string,
): void {
  if (kind === 'scripts' && !(manifest.permissions?.hostActions || []).length) {
    throw new Error(
      `Feature ${manifest.id} declares scripts resources but no permissions.hostActions`,
    );
  }
  if (kind !== 'mcp') return;
  const configPath = path.join(dir, 'mcp.json');
  if (!fs.existsSync(configPath)) return;
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Feature ${manifest.id} MCP config must be an object`);
  }
  const profiles = (parsed as { profiles?: unknown }).profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new Error(
      `Feature ${manifest.id} MCP config must declare a profiles object`,
    );
  }
  const declaredServers = new Set(manifest.permissions?.mcpServers || []);
  for (const profileKey of Object.keys(profiles)) {
    if (!declaredServers.has(profileKey)) {
      throw new Error(
        `Feature ${manifest.id} MCP profile "${profileKey}" is not declared in permissions.mcpServers`,
      );
    }
  }
}

function registerDeclaredNavigation(feature: LoadedFeatureManifest): void {
  const rendererEntryUrl = feature.manifest.rendererEntry
    ? featureEntryUrl(
        feature.root,
        feature.manifest.id,
        feature.manifest.rendererEntry,
      )
    : undefined;
  for (const item of feature.manifest.nav || []) {
    featureNavigation.register({
      ...item,
      featureId: feature.manifest.id,
      rendererEntryUrl,
    });
  }
}

function runImplicitFeatureMigrations(feature: LoadedFeatureManifest): void {
  const dir = path.join(feature.root, 'host', 'migrations');
  if (fs.existsSync(dir)) {
    runFeatureMigrations({ featureId: feature.manifest.id, dir });
  }
}

async function activateHostEntry(
  feature: LoadedFeatureManifest,
): Promise<ActiveFeatureHost | null> {
  if (!feature.manifest.hostEntry) return null;
  const entryPath = resolveEntryPath(feature.root, feature.manifest.hostEntry);
  const moduleUrl = pathToFileURL(entryPath).href;
  const imported = (await import(moduleUrl)) as
    | FeatureModule
    | { default?: FeatureModule };
  const module = 'activate' in imported ? imported : imported.default;
  if (!module?.activate || typeof module.activate !== 'function') {
    throw new Error(
      `Feature ${feature.manifest.id} hostEntry must export activate(context)`,
    );
  }
  const context = createFeatureContext(feature);
  try {
    await module.activate(context);
  } catch (err) {
    clearFeatureEventSubscriptions(feature.manifest.id);
    throw err;
  }
  return {
    featureId: feature.manifest.id,
    module,
    context,
  };
}

async function deactivateActiveHosts(): Promise<void> {
  if (!activeHosts.length) return;
  const hosts = activeHosts;
  activeHosts = [];
  await deactivateHosts(hosts);
}

async function deactivateHosts(hosts: ActiveFeatureHost[]): Promise<void> {
  for (const host of [...hosts].reverse()) {
    try {
      if (typeof host.module.deactivate === 'function') {
        await host.module.deactivate(host.context);
      }
    } catch (err) {
      logger.error(
        { err, featureId: host.featureId },
        'Feature host deactivate failed',
      );
    } finally {
      clearFeatureEventSubscriptions(host.featureId);
    }
  }
}

function createFeatureContext(feature: LoadedFeatureManifest): FeatureContext {
  const apiPrefix =
    feature.manifest.apiPrefix || `/api/features/${feature.manifest.id}`;
  return {
    featureId: feature.manifest.id,
    featureRoot: feature.root,
    manifest: feature.manifest,
    logger: createFeatureLogger(feature.manifest.id),
    api: createScopedApiRegistry({
      featureId: feature.manifest.id,
      apiPrefix,
      registry: featureApiRoutes,
    }),
    nav: featureNavigation,
    containerResources: featureResources,
    mcp: featureResources,
    db: featureMigrations,
    events: createEventRegistry(feature.manifest.id),
    permissions: createPermissionRegistry(feature.manifest),
    audit: createAuditService(feature.manifest.id),
  };
}

function buildEnabledFeatureInfo(
  feature: LoadedFeatureManifest,
): EnabledFeatureRuntimeInfo {
  const rendererEntryUrl = feature.manifest.rendererEntry
    ? featureEntryUrl(
        feature.root,
        feature.manifest.id,
        feature.manifest.rendererEntry,
      )
    : undefined;
  return {
    id: feature.manifest.id,
    name: feature.manifest.name,
    version: feature.manifest.version,
    description: feature.manifest.description,
    apiPrefix:
      feature.manifest.apiPrefix || `/api/features/${feature.manifest.id}`,
    rendererEntryUrl,
    nav: featureNavigation
      .list()
      .filter((item) => item.featureId === feature.manifest.id),
    manifest: feature.manifest,
    root: feature.root,
  };
}

function featureEntryUrl(
  featureRoot: string,
  featureId: string,
  relativePath: string,
): string {
  const normalized = relativePath.replace(/^\.\//, '').replace(/^\/+/, '');
  const resolved = assertPathInsideFeature(
    featureRoot,
    normalized,
    'rendererEntry',
  );
  const rendererRoot = path.join(path.resolve(featureRoot), 'renderer');
  if (
    resolved !== rendererRoot &&
    !resolved.startsWith(rendererRoot + path.sep)
  ) {
    throw new Error(
      `Feature ${featureId} rendererEntry must stay under renderer/`,
    );
  }
  return `/features/${encodeURIComponent(featureId)}/${normalized}`;
}

function resolveEntryPath(featureRoot: string, relativePath: string): string {
  const resolved = assertPathInsideFeature(
    featureRoot,
    relativePath,
    'hostEntry',
  );
  if (fs.existsSync(resolved)) return resolved;
  if (resolved.endsWith('.js')) {
    const tsPath = resolved.slice(0, -'.js'.length) + '.ts';
    if (fs.existsSync(tsPath)) return tsPath;
  }
  throw new Error(`Feature hostEntry not found: ${resolved}`);
}
