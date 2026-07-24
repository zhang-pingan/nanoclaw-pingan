import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  LOGICAL_SCHEMA_NEGATIVE_CASES,
  LOGICAL_SCHEMA_POSITIVE_CASES,
} from './logical-schema-fixtures.js';
import {
  checkContractPackLogicalSchema,
  generateContractPackLogicalSchema,
} from './logical-schema-pack.js';
import {
  buildLogicalQueryCatalogPayload,
  buildLogicalSchemaSourcePayload,
  buildTypedRelationCatalogPayload,
} from './logical-schema-source.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

describe('G0.6 Logical Schema Metadata Contract Pack', () => {
  it('generates deterministically and keeps check read-only with prior identities pinned', () => {
    const trackedArtifacts = [
      'contract-pack-foundation.json',
      'contract-pack-closed-schemas.json',
      'contract-pack-catalog-protocols.json',
      'contract-pack-safety-sqlite.json',
      'contract-pack-logical-schema.json',
      'sqlite/workflow-runtime-logical-schema-source@1.json',
      'sqlite/workflow-runtime-typed-relation-catalog@1.json',
      'sqlite/workflow-runtime-query-catalog@1.json',
    ];
    const first = generateContractPackLogicalSchema();
    const firstBytes = new Map(
      trackedArtifacts.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );
    const second = generateContractPackLogicalSchema();
    expect(second.hash).toBe(first.hash);
    const checked = checkContractPackLogicalSchema();
    expect(checked.hash).toBe(first.hash);
    expect(readArtifact('contract-pack-foundation.json').hash).toBe(
      'sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d',
    );
    expect(readArtifact('contract-pack-closed-schemas.json').hash).toBe(
      'sha256:6f7aa5b997c5a496a4eb95776a09f18e3c25753e7324a6ef1f095a23b8413d81',
    );
    expect(readArtifact('contract-pack-catalog-protocols.json').hash).toBe(
      'sha256:078be3fed7e8d430b228c0aa526e15e6bd92665f863c6d0818eaebbcaf43b533',
    );
    expect(readArtifact('contract-pack-safety-sqlite.json').hash).toBe(
      'sha256:e289868eb489bb3c41731afe17f50cbc06f2b10c549769c1786fcd185a0b5775',
    );
    for (const [relativePath, bytes] of firstBytes) {
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    }
  });

  it('covers every one of the 74 Normative Logical Schema objects exactly once', () => {
    const source = buildLogicalSchemaSourcePayload();
    expect(source.table_count).toBe(74);
    expect(source.column_count).toBe(1221);
    expect(new Set(source.tables.map((table) => table.name)).size).toBe(74);
    expect(source.tables.map((table) => table.name)).toContain(
      'workflow_values',
    );
    expect(source.tables.map((table) => table.name)).toContain(
      'workflow_operational_blockers',
    );
    expect(source.tables.map((table) => table.name)).toContain(
      'workflow_runtime_command_confirmations',
    );
    expect(source.tables.map((table) => table.name)).toContain(
      'workflow_checkpoints',
    );
    for (const table of source.tables) {
      expect(table.columns.length).toBeGreaterThan(0);
      expect(new Set(table.columns.map((column) => column.name)).size).toBe(
        table.columns.length,
      );
      expect(table.primary_key.columns.length).toBeGreaterThan(0);
      for (const primaryColumn of table.primary_key.columns) {
        expect(
          table.columns.find((column) => column.name === primaryColumn)
            ?.nullable,
        ).toBe(false);
      }
    }
  });

  it('expands internal ownership and targets into typed relation metadata', () => {
    const source = buildLogicalSchemaSourcePayload();
    const catalog = buildTypedRelationCatalogPayload();
    expect(catalog.internal_relation_count).toBe(345);
    expect(catalog.external_reference_count).toBe(43);
    expect(catalog.relations).toHaveLength(388);
    const ownership = source.tables.find(
      (table) => table.name === 'workflow_value_ownerships',
    )!;
    expect(ownership.columns.map((column) => column.name)).toEqual([
      'value_id',
      'owner_workflow_id',
      'owner_graph_run_id',
      'owner_registry_resource_id',
      'owner_feature_release_id',
      'system_owner_ref',
      'created_at_ms',
    ]);
    expect(
      ownership.checks.some((candidate) => candidate.kind === 'exactly_one'),
    ).toBe(true);
    const commands = source.tables.find(
      (table) => table.name === 'workflow_runtime_commands',
    )!;
    expect(
      commands.checks.some(
        (candidate) => candidate.kind === 'closed_target_mapping',
      ),
    ).toBe(true);
    for (const relation of catalog.relations) {
      if (relation.relation_kind === 'foreign_key') {
        expect(relation.target_table).not.toBeNull();
        expect(relation.validator_owner).toBeNull();
      } else {
        expect(relation.target_table).toBeNull();
        expect(relation.validator_owner).not.toBeNull();
        expect(relation.reference_domain).not.toBeNull();
      }
    }
  });

  it('freezes CHECK, UK, FK and index intent for state and lineage invariants', () => {
    const source = buildLogicalSchemaSourcePayload();
    const totals = source.tables.reduce(
      (accumulator, table) => ({
        foreignKeys: accumulator.foreignKeys + table.foreign_keys.length,
        uniqueKeys: accumulator.uniqueKeys + table.unique_keys.length,
        checks: accumulator.checks + table.checks.length,
        indexes: accumulator.indexes + table.indexes.length,
      }),
      { foreignKeys: 0, uniqueKeys: 0, checks: 0, indexes: 0 },
    );
    expect(totals).toEqual({
      foreignKeys: 345,
      uniqueKeys: 129,
      checks: 759,
      indexes: 25,
    });
    const activations = source.tables.find(
      (table) => table.name === 'workflow_state_activations',
    )!;
    expect(activations.checks.map((candidate) => candidate.check_id)).toContain(
      'ck:state_activations:type_run',
    );
    expect(
      activations.unique_keys.map((candidate) => candidate.key_id),
    ).toContain('uk:state_activations:graph_run');
    const attempts = source.tables.find(
      (table) => table.name === 'workflow_graph_node_attempts',
    )!;
    expect(
      attempts.foreign_keys.map((relation) => relation.relation_id),
    ).toContain('fk:node_attempts:parent');
    expect(attempts.unique_keys.map((candidate) => candidate.key_id)).toContain(
      'uk:node_attempts:parent',
    );
  });

  it('binds every query intent bidirectionally to a declared index intent', () => {
    const source = buildLogicalSchemaSourcePayload();
    const catalog = buildLogicalQueryCatalogPayload();
    expect(catalog.query_count).toBe(24);
    expect(catalog.sql_text_status).toBe('absent');
    const tables = new Map(source.tables.map((table) => [table.name, table]));
    for (const query of catalog.queries) {
      const table = tables.get(query.table)!;
      const requiredIndex = table.indexes.find(
        (candidate) => candidate.index_id === query.required_index_id,
      );
      expect(requiredIndex).toBeDefined();
      expect(requiredIndex!.supports_query_ids).toContain(query.query_id);
      expect(query.execution_status).toBe('intent_only');
    }
  });

  it('rejects forbidden draft columns and keeps all external refs explicit', () => {
    const source = buildLogicalSchemaSourcePayload();
    const forbidden = new Set(source.forbidden_logical_columns);
    for (const table of source.tables) {
      for (const column of table.columns) {
        expect(forbidden.has(column.name)).toBe(false);
        expect(column.name.endsWith('_at')).toBe(false);
        if (column.logical_type === 'external_reference') {
          expect(column.external_reference).not.toBeNull();
          expect(column.relation_ids).toContain(
            `ext:${table.name}:${column.name}`,
          );
        } else {
          expect(column.external_reference).toBeNull();
        }
      }
    }
  });

  it('executes all positive and negative G0.6 fixtures', () => {
    expect(LOGICAL_SCHEMA_POSITIVE_CASES).toHaveLength(6);
    expect(LOGICAL_SCHEMA_NEGATIVE_CASES).toHaveLength(34);
    expect(() => checkContractPackLogicalSchema()).not.toThrow();
  });

  it('keeps G0.6 metadata-only without DDL, Store, SQLite open, Golden or Runtime semantics', () => {
    const manifest = readArtifact('contract-pack-logical-schema.json');
    expect(manifest.payload).toMatchObject({
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
      executable_ddl_status: 'absent',
      executable_schema_manifest_status: 'absent',
      sqlite_connection_factory_status: 'absent',
      sql_text_status: 'absent',
    });
    expect(
      fs.existsSync(path.join(contractsRoot, '../store/runtime-store.ts')),
    ).toBe(false);
    for (const directory of ['conformance/sealed']) {
      expect(fs.readdirSync(path.join(contractsRoot, directory))).toEqual([
        '.gitkeep',
        'g2-capability-outbox-binding-v3',
        'g2-generated-schema-join-authority-v4',
        'g2-generated-schema-join-authority-v5',
        'g2-production-compiler-replay-repair-v2',
        'g2-semantic-correction',
      ]);
    }
    const sourceFiles = [
      'logical-schema-types.ts',
      'logical-schema-source.ts',
      'logical-schema-artifacts.ts',
      'logical-schema-fixtures.ts',
      'logical-schema-pack.ts',
    ].map((relativePath) =>
      fs.readFileSync(path.join(contractsRoot, relativePath), 'utf8'),
    );
    const joined = sourceFiles.join('\n');
    expect(joined).not.toMatch(/from ['"]better-sqlite3/);
    expect(joined).not.toMatch(/new Database\s*\(/);
    expect(joined).not.toMatch(/\.pragma\s*\(/);
    expect(joined).not.toMatch(/CREATE\s+(?:TABLE|INDEX|TRIGGER)/i);
  });
});
