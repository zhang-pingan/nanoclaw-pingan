import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { featureResources } from './registry.js';

interface SkillSource {
  featureId: string | null;
  dir: string;
}

export function syncContainerSkills(input: {
  groupFolder: string;
  skillsDst: string;
}): void {
  const sources: SkillSource[] = [
    {
      featureId: null,
      dir: path.join(process.cwd(), 'container', 'skills'),
    },
    ...featureResources.list('skills').map((source) => ({
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
      groupFolder: input.groupFolder,
      skillsDst: input.skillsDst,
    });
  }
}

export function prepareMergedMcpConfigDir(groupFolder: string): string | null {
  const sources = [
    { featureId: null, dir: path.join(process.cwd(), 'container', 'mcp') },
    ...featureResources.list('mcp').map((source) => ({
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
  const targetDir = path.join(DATA_DIR, 'sessions', groupFolder, 'mcp');
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
  groupFolder: string;
  skillsDst: string;
}): void {
  const { source, groupFolder, skillsDst } = input;
  const allowedSkills = readAllowedSkills(source.dir, groupFolder);
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
  groupFolder: string,
): Set<string> | null {
  const skillsConfigPath = path.join(skillsSrc, 'skills.json');
  if (!fs.existsSync(skillsConfigPath)) return null;
  try {
    const skillsConfig = JSON.parse(
      fs.readFileSync(skillsConfigPath, 'utf-8'),
    ) as Record<string, string[]>;
    const allowedSkills = new Set<string>(skillsConfig.global || []);
    for (const skill of skillsConfig[groupFolder] || []) {
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
