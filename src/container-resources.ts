import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export function syncContainerSkills(input: {
  agentFolder: string;
  skillsDst: string;
}): void {
  const source = path.join(process.cwd(), 'container', 'skills');
  fs.rmSync(input.skillsDst, { recursive: true, force: true });
  fs.mkdirSync(input.skillsDst, { recursive: true });
  if (!fs.existsSync(source)) return;
  const allowed = readAllowedSkills(source, input.agentFolder);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || (allowed && !allowed.has(entry.name))) continue;
    fs.cpSync(
      path.join(source, entry.name),
      path.join(input.skillsDst, entry.name),
      { recursive: true, force: true },
    );
  }
}

export function clearContainerAgents(agentsDst: string): void {
  fs.rmSync(agentsDst, { recursive: true, force: true });
}

export function prepareMergedMcpConfigDir(agentFolder: string): string | null {
  const configPath = path.join(process.cwd(), 'container', 'mcp', 'mcp.json');
  const targetDir = path.join(DATA_DIR, 'sessions', agentFolder, 'mcp');
  fs.rmSync(targetDir, { recursive: true, force: true });
  if (!fs.existsSync(configPath)) return null;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Core MCP config must be a JSON object');
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, 'mcp.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    'utf8',
  );
  return targetDir;
}

function readAllowedSkills(
  skillsRoot: string,
  agentFolder: string,
): Set<string> | null {
  const configPath = path.join(skillsRoot, 'skills.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      string[]
    >;
    return new Set([...(config.global ?? []), ...(config[agentFolder] ?? [])]);
  } catch (error) {
    logger.warn({ error, configPath }, 'Failed to parse Core skills config');
    return null;
  }
}
