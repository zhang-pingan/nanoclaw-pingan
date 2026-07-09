import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  getDatabase,
  getFeatureMigration,
  recordFeatureMigration,
} from '../db.js';
import { logger } from '../logger.js';

export interface FeatureMigrationSource {
  featureId: string;
  dir: string;
}

export class FeatureMigrationRegistry {
  private readonly sources = new Map<string, FeatureMigrationSource>();

  registerMigrations(input: FeatureMigrationSource): void {
    const dir = path.resolve(input.dir);
    const key = `${input.featureId}:${dir}`;
    this.sources.set(key, { featureId: input.featureId, dir });
  }

  async runRegisteredMigrations(): Promise<void> {
    for (const source of this.sources.values()) {
      runFeatureMigrations(source);
    }
  }

  clear(): void {
    this.sources.clear();
  }
}

export const featureMigrations = new FeatureMigrationRegistry();

export function runFeatureMigrations(source: FeatureMigrationSource): void {
  if (!fs.existsSync(source.dir)) return;
  const stat = fs.statSync(source.dir);
  if (!stat.isDirectory()) {
    throw new Error(
      `Feature ${source.featureId} migration source is not a directory: ${source.dir}`,
    );
  }

  const files = fs
    .readdirSync(source.dir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const version = path.basename(fileName, '.sql');
    const fullPath = path.join(source.dir, fileName);
    const sql = fs.readFileSync(fullPath, 'utf-8');
    assertFeatureMigrationSqlAllowed(source.featureId, version, sql);
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');
    const existing = getFeatureMigration(source.featureId, version);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Feature ${source.featureId} migration ${version} checksum changed`,
        );
      }
      continue;
    }

    const database = getDatabase();
    const apply = database.transaction(() => {
      database.exec(sql);
      recordFeatureMigration({
        featureId: source.featureId,
        version,
        checksum,
      });
    });
    apply();
    logger.info(
      { featureId: source.featureId, version, file: fullPath },
      'Feature migration applied',
    );
  }
}

const CORE_TABLE_PATTERNS = [
  'registered_groups',
  'feature_group_bindings',
  'feature_migrations',
  'workflows',
  'workbench_',
  'agent_queries',
  'workflow_events',
  'workflow_interrupts',
  'workflow_checkpoints',
  'workflow_outbox',
  'delegations',
  'messages',
  'chats',
  'sessions',
  'router_state',
  'scheduled_tasks',
  'memories',
  'knowledge_',
];

function assertFeatureMigrationSqlAllowed(
  featureId: string,
  version: string,
  sql: string,
): void {
  const normalized = sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .toLowerCase();
  for (const tablePattern of CORE_TABLE_PATTERNS) {
    const escaped = tablePattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}[a-z0-9_]*\\b`, 'i');
    if (pattern.test(normalized)) {
      throw new Error(
        `Feature ${featureId} migration ${version} references protected core table pattern "${tablePattern}"`,
      );
    }
  }
}
