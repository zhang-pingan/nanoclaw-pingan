import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  getDatabase,
  getFeatureMigration,
  recordFeatureMigration,
} from '../db.js';
import { logger } from '../logger.js';
import {
  getFeatureOwnedTablePrefixes,
  isFeatureOwnedTableName,
} from './naming.js';

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
  'feature_audit_events',
  'agent_queries',
  'agent_query_',
  'agent_inbox_items',
  'delegations',
  'messages',
  'messages_fts',
  'chats',
  'sessions',
  'router_state',
  'scheduled_tasks',
  'ask_questions',
  'memories',
  'memories_fts',
  'memory_',
  'knowledge_',
  'today_plan',
  'assistant_',
  'wiki_',
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
  for (const tableName of extractReferencedTableNames(normalized)) {
    if (tableName.startsWith('sqlite_')) continue;
    if (isFeatureOwnedTableName(featureId, tableName)) continue;
    throw new Error(
      `Feature ${featureId} migration ${version} references table "${tableName}", but feature migrations may only use feature-owned table prefixes: ${getFeatureOwnedTablePrefixes(featureId).join(', ')}`,
    );
  }
}

function extractReferencedTableNames(sql: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /\bcreate\s+(?:virtual\s+)?table(?:\s+if\s+not\s+exists)?\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\bdrop\s+table(?:\s+if\s+exists)?\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\balter\s+table\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\binsert\s+(?:or\s+[a-z_]+\s+)?into\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\breplace\s+into\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\bupdate\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\bdelete\s+from\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\bfrom\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\bjoin\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\breferences\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\bcreate\s+(?:unique\s+)?index(?:\s+if\s+not\s+exists)?\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)\s+on\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
    /\bcreate\s+trigger(?:\s+if\s+not\s+exists)?\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)\s+(?:before|after|instead\s+of)\s+\w+\s+on\s+("[^"]+"|`[^`]+`|\[[^\]]+\]|[a-z_][a-z0-9_]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of sql.matchAll(pattern)) {
      const rawName = match[2] || match[1];
      const name = normalizeSqlIdentifier(rawName);
      if (name) names.add(name);
    }
  }
  return [...names];
}

function normalizeSqlIdentifier(rawName: string | undefined): string | null {
  if (!rawName) return null;
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
