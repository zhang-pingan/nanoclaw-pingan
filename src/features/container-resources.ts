import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { getFeatureAgentBindingByFolder } from '../db.js';
import { logger } from '../logger.js';
import { featureResources } from './registry.js';

interface SkillSource {
  featureId: string | null;
  dir: string;
}

interface ResourceSource {
  featureId: string;
  dir: string;
}

export function syncContainerSkills(input: {
  agentFolder: string;
  skillsDst: string;
}): void {
  const sources: SkillSource[] = [
    {
      featureId: null,
      dir: path.join(process.cwd(), 'container', 'skills'),
    },
    ...featureResources
      .list('skills')
      .filter((source) =>
        isFeatureResourceVisibleToAgent(source.featureId, input.agentFolder),
      )
      .map((source) => ({
        featureId: source.featureId,
        dir: source.dir,
      })),
  ];

  fs.mkdirSync(input.skillsDst, { recursive: true });
  removeManagedFeatureSkillDirs(input.skillsDst);

  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    syncSkillSource({
      source,
      agentFolder: input.agentFolder,
      skillsDst: input.skillsDst,
    });
  }
}

export function syncContainerAgents(input: {
  agentFolder: string;
  agentsDst: string;
}): void {
  const sources: ResourceSource[] = featureResources
    .list('agents')
    .filter(
      (source) =>
        !!source.featureId &&
        isFeatureResourceVisibleToAgent(source.featureId, input.agentFolder),
    )
    .map((source) => ({
      featureId: source.featureId as string,
      dir: source.dir,
    }));
  if (!sources.length) {
    removeManagedFeatureResourceEntries(input.agentsDst);
    return;
  }

  fs.mkdirSync(input.agentsDst, { recursive: true });
  removeManagedFeatureResourceEntries(input.agentsDst);
  for (const source of sources) {
    syncNamedResourceEntries({
      source,
      dst: input.agentsDst,
      allowedExtensions: new Set(['.md']),
    });
  }
}

export function prepareFeatureResourceMountDir(
  agentFolder: string,
): string | null {
  const sources = [
    ...featureResources.list('scripts').map((source) => ({
      kind: 'scripts' as const,
      featureId: source.featureId,
      dir: source.dir,
    })),
    ...featureResources.list('templates').map((source) => ({
      kind: 'templates' as const,
      featureId: source.featureId,
      dir: source.dir,
    })),
  ]
    .filter(
      (
        source,
      ): source is {
        kind: 'scripts' | 'templates';
        featureId: string;
        dir: string;
      } => !!source.featureId,
    )
    .filter((source) =>
      isFeatureResourceVisibleToAgent(source.featureId, agentFolder),
    );
  const targetDir = path.join(
    DATA_DIR,
    'sessions',
    agentFolder,
    'feature-resources',
  );
  fs.rmSync(targetDir, { recursive: true, force: true });
  if (!sources.length) return null;

  const manifest: Array<{
    featureId: string;
    kind: 'scripts' | 'templates';
    containerPath: string;
  }> = [];
  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    const dst = path.join(targetDir, source.featureId, source.kind);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(source.dir, dst, { recursive: true, force: true });
    if (source.kind === 'scripts') {
      makeTreeNonExecutable(dst);
    }
    manifest.push({
      featureId: source.featureId,
      kind: source.kind,
      containerPath: `/workspace/feature-resources/${source.featureId}/${source.kind}`,
    });
  }
  if (!manifest.length) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(
    path.join(targetDir, 'manifest.json'),
    `${JSON.stringify({ resources: manifest }, null, 2)}\n`,
    'utf-8',
  );
  return targetDir;
}

export function prepareMergedMcpConfigDir(agentFolder: string): string | null {
  const sources = [
    { featureId: null, dir: path.join(process.cwd(), 'container', 'mcp') },
    ...featureResources
      .list('mcp')
      .filter((source) =>
        isFeatureResourceVisibleToAgent(source.featureId, agentFolder),
      )
      .map((source) => ({
        featureId: source.featureId,
        dir: source.dir,
      })),
  ];
  const configs: Array<{ label: string; config: Record<string, unknown> }> = [];
  for (const source of sources) {
    const configPath = path.join(source.dir, 'mcp.json');
    if (!fs.existsSync(configPath)) continue;
    const label = source.featureId ? `feature:${source.featureId}` : 'core';
    configs.push({
      label,
      config: JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
        string,
        unknown
      >,
    });
  }
  if (configs.length === 0) return null;

  const merged = mergeMcpConfigs(configs);
  const targetDir = path.join(DATA_DIR, 'sessions', agentFolder, 'mcp');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'mcp.json'),
    `${JSON.stringify(merged, null, 2)}\n`,
    'utf-8',
  );
  return targetDir;
}

function syncSkillSource(input: {
  source: SkillSource;
  agentFolder: string;
  skillsDst: string;
}): void {
  const { source, agentFolder, skillsDst } = input;
  const allowedSkills = readAllowedSkills(source.dir, agentFolder);
  for (const skillDir of fs.readdirSync(source.dir)) {
    if (skillDir === 'skills.json') continue;
    const srcDir = path.join(source.dir, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    if (allowedSkills && !allowedSkills.has(skillDir)) continue;
    const dstName = source.featureId
      ? `${source.featureId}-${skillDir}`
      : skillDir;
    fs.cpSync(srcDir, path.join(skillsDst, dstName), {
      recursive: true,
      force: true,
    });
  }
}

function readAllowedSkills(
  skillsSrc: string,
  agentFolder: string,
): Set<string> | null {
  const skillsConfigPath = path.join(skillsSrc, 'skills.json');
  if (!fs.existsSync(skillsConfigPath)) return null;
  try {
    const skillsConfig = JSON.parse(
      fs.readFileSync(skillsConfigPath, 'utf-8'),
    ) as Record<string, string[]>;
    const allowedSkills = new Set<string>(skillsConfig.global || []);
    for (const skill of skillsConfig[agentFolder] || []) {
      allowedSkills.add(skill);
    }
    return allowedSkills;
  } catch (err) {
    logger.warn({ err, skillsConfigPath }, 'Failed to parse skills.json');
    return null;
  }
}

function removeManagedFeatureSkillDirs(skillsDst: string): void {
  if (!fs.existsSync(skillsDst)) return;
  const installedIds = scanInstalledFeatureIds();
  if (installedIds.length === 0) return;
  for (const entry of fs.readdirSync(skillsDst)) {
    if (!installedIds.some((featureId) => entry.startsWith(`${featureId}-`))) {
      continue;
    }
    fs.rmSync(path.join(skillsDst, entry), { recursive: true, force: true });
  }
}

function removeManagedFeatureResourceEntries(dst: string): void {
  if (!fs.existsSync(dst)) return;
  const installedIds = scanInstalledFeatureIds();
  if (installedIds.length === 0) return;
  for (const entry of fs.readdirSync(dst)) {
    if (!installedIds.some((featureId) => entry.startsWith(`${featureId}-`))) {
      continue;
    }
    fs.rmSync(path.join(dst, entry), { recursive: true, force: true });
  }
}

function syncNamedResourceEntries(input: {
  source: ResourceSource;
  dst: string;
  allowedExtensions?: Set<string>;
}): void {
  if (!fs.existsSync(input.source.dir)) return;
  for (const entry of fs.readdirSync(input.source.dir)) {
    const src = path.join(input.source.dir, entry);
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      if (
        input.allowedExtensions &&
        !input.allowedExtensions.has(path.extname(entry))
      ) {
        continue;
      }
      const parsed = path.parse(entry);
      const dstName = `${input.source.featureId}-${parsed.name}${parsed.ext}`;
      fs.copyFileSync(src, path.join(input.dst, dstName));
      continue;
    }
    if (!stat.isDirectory()) continue;
    const dstName = `${input.source.featureId}-${entry}`;
    fs.cpSync(src, path.join(input.dst, dstName), {
      recursive: true,
      force: true,
    });
  }
}

function makeTreeNonExecutable(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      fs.chmodSync(fullPath, 0o755);
      makeTreeNonExecutable(fullPath);
      continue;
    }
    if (entry.isFile()) fs.chmodSync(fullPath, 0o644);
  }
}

function scanInstalledFeatureIds(): string[] {
  const featuresDir = path.join(process.cwd(), 'features');
  if (!fs.existsSync(featuresDir)) return [];
  return fs
    .readdirSync(featuresDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(featuresDir, entry.name, 'feature.json'))
    .filter((manifestPath) => fs.existsSync(manifestPath))
    .map((manifestPath) => {
      try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
          id?: unknown;
        };
        return typeof parsed.id === 'string' ? parsed.id : null;
      } catch {
        return null;
      }
    })
    .filter((id): id is string => !!id);
}

function isFeatureResourceVisibleToAgent(
  featureId: string | null,
  agentFolder: string,
): boolean {
  if (!featureId) return true;
  const binding = getFeatureAgentBindingByFolder(agentFolder);
  return binding?.feature_id === featureId;
}

function mergeMcpConfigs(
  configs: Array<{ label: string; config: Record<string, unknown> }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { label, config } of configs) {
    for (const [key, value] of Object.entries(config)) {
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        result[key] &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        result[key] = mergeObjectMaps(
          result[key] as Record<string, unknown>,
          value as Record<string, unknown>,
          `${label}.${key}`,
        );
        continue;
      }
      if (result[key] !== undefined) {
        throw new Error(`MCP config key conflict "${key}" from ${label}`);
      }
      result[key] = value;
    }
  }
  return result;
}

function mergeObjectMaps(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (merged[key] !== undefined) {
      throw new Error(`MCP config key conflict "${key}" from ${label}`);
    }
    merged[key] = value;
  }
  return merged;
}
