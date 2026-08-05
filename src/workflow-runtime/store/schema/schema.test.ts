import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { calculateArtifactHash, canonicalJson } from '../../contracts/hash.js';
import {
  buildGeneratedSchema,
  buildPlanGeneratedSchemaBinding,
} from '../../contracts/generated-schema-authority.js';
import { buildActivationRepairSchemaPrerequisitePayload } from './activation-repair-source.js';
import type { LogicalTableMetadata } from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
} from '../../contracts/types.js';
import {
  buildG1Artifacts,
  checkG1Artifacts,
  G1_ARTIFACT_PATHS,
} from './artifacts.js';
import {
  assertClosedSchemaDependencyManifest,
  buildSchemaDependencyManifestArtifact,
  calculatePhysicalSchemaIdentity,
  verifySchemaDependencyManifestArtifact,
} from './dependencies.js';
import {
  buildQueryFixtures,
  renderMigration,
  renderSchema4To5Upgrade,
  renderSchema5To6Upgrade,
  renderSchema6To7Upgrade,
  renderSchema7To8Upgrade,
  renderSchema8To9Upgrade,
  renderSchema9To10Upgrade,
  renderSchema10To11Upgrade,
} from './ddl.js';
import { calculateDatabaseSqliteSchemaIdentity } from './database-identity.js';
import {
  assertClosedSchemaManifest,
  reconstructSchemaManifest,
} from './manifest.js';
import {
  loadCurrentExecutableSchemaSource,
  loadSchema3ExecutableSchemaSource,
  loadSchema4ExecutableSchemaSource,
  loadSchema5ExecutableSchemaSource,
  loadSchema6ExecutableSchemaSource,
  loadSchema7ExecutableSchemaSource,
  loadSchema8ExecutableSchemaSource,
  loadSchema9ExecutableSchemaSource,
  loadSchema10ExecutableSchemaSource,
} from './source.js';
import {
  createMigratedDatabase,
  verifyQueryPlans,
  verifyReadOnlyConnection,
} from './sqlite-gate.js';
import {
  G1_SCHEMA_DEPENDENCY_ROLES,
  type G1SchemaDependencyManifestPayload,
  type WorkflowRuntimeSchemaManifestPayload,
} from './types.js';

const source = loadCurrentExecutableSchemaSource();
const migration = renderMigration(source);
const schema4Source = loadSchema4ExecutableSchemaSource();
const schema4Migration = renderMigration(schema4Source);
const schema5Source = loadSchema5ExecutableSchemaSource();
const schema5Migration = renderMigration(schema5Source);
const schema6Source = loadSchema6ExecutableSchemaSource();
const schema6Migration = renderMigration(schema6Source);
const schema7Source = loadSchema7ExecutableSchemaSource();
const schema7Migration = renderMigration(schema7Source);
const schema8Source = loadSchema8ExecutableSchemaSource();
const schema8Migration = renderMigration(schema8Source);
const schema9Source = loadSchema9ExecutableSchemaSource();
const schema9Migration = renderMigration(schema9Source);
const schema10Source = loadSchema10ExecutableSchemaSource();
const schema10Migration = renderMigration(schema10Source);
const schema4To5Upgrade = renderSchema4To5Upgrade(schema4Source, schema5Source);
const schema5To6Upgrade = renderSchema5To6Upgrade(schema5Source, schema6Source);
const schema6To7Upgrade = renderSchema6To7Upgrade(schema6Source, schema7Source);
const schema7To8Upgrade = renderSchema7To8Upgrade(schema7Source, schema8Source);
const schema8To9Upgrade = renderSchema8To9Upgrade(schema8Source, schema9Source);
const schema9To10Upgrade = renderSchema9To10Upgrade(
  schema9Source,
  schema10Source,
);
const schema10To11Upgrade = renderSchema10To11Upgrade(schema10Source, source);

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hash(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function rawHash(bytes: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function table(name: string): LogicalTableMetadata {
  const result = source.tables.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Unknown table ${name}`);
  return result;
}

function defaultValue(
  tableName: string,
  column: LogicalTableMetadata['columns'][number],
  suffix: string,
): string | number | null {
  if (column.nullable) return null;
  if (column.enum_values.length > 0) return column.enum_values[0];
  switch (column.logical_type) {
    case 'integer':
      return column.safe_integer_intent === 'positive' ? 1 : 0;
    case 'boolean_integer':
      return 0;
    case 'hash':
      return hash(`${tableName}:${column.name}:${suffix}`);
    case 'canonical_json':
      return '{}';
    case 'identifier':
    case 'text':
    case 'external_reference':
      return `${tableName}:${column.name}:${suffix}`;
  }
}

function insertRow(
  database: Database.Database,
  tableName: string,
  overrides: Record<string, string | number | null> = {},
  suffix: string = crypto.randomUUID(),
): number | bigint {
  const metadata = table(tableName);
  const autoColumn = metadata.primary_key.auto_increment_intent
    ? metadata.primary_key.columns[0]
    : null;
  const columns = metadata.columns.filter(
    (column) => column.name !== autoColumn,
  );
  const values = columns.map((column) =>
    Object.hasOwn(overrides, column.name)
      ? overrides[column.name]
      : defaultValue(tableName, column, suffix),
  );
  return database
    .prepare(
      `INSERT INTO ${q(tableName)} (${columns.map((column) => q(column.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    )
    .run(...values).lastInsertRowid;
}

function seedRow(
  database: Database.Database,
  tableName: string,
  overrides: Record<string, string | number | null> = {},
  suffix?: string,
): number | bigint {
  database.pragma('ignore_check_constraints = ON');
  try {
    return insertRow(database, tableName, overrides, suffix);
  } finally {
    database.pragma('ignore_check_constraints = OFF');
  }
}

function withDatabase(
  callback: (database: Database.Database, databasePath: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-schema-test-'));
  const databasePath = path.join(root, 'workflow-runtime.db');
  const database = createMigratedDatabase(databasePath, migration.sql);
  try {
    callback(database, databasePath);
  } finally {
    if (database.open) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('G1.1 executable workflow runtime schema', () => {
  it('keeps Schema 5/6/7/8/9/10 frozen and selects an additive fresh Schema 11 migration', () => {
    const schema5Path = path.join(
      import.meta.dirname,
      'migration/workflow-runtime-schema-v1.sql',
    );
    const schema6Path = path.join(
      import.meta.dirname,
      'migration/workflow-runtime-schema-v6.sql',
    );
    const schema7Path = path.join(
      import.meta.dirname,
      'migration/workflow-runtime-schema-v7.sql',
    );
    const schema8Path = path.join(
      import.meta.dirname,
      'migration/workflow-runtime-schema-v8.sql',
    );
    const schema9Path = path.join(
      import.meta.dirname,
      'migration/workflow-runtime-schema-v9.sql',
    );
    const schema10Path = path.join(
      import.meta.dirname,
      'migration/workflow-runtime-schema-v10.sql',
    );
    const schema11Path = path.join(
      import.meta.dirname,
      'migration/workflow-runtime-schema-v11.sql',
    );
    const schema5Bytes = fs.readFileSync(schema5Path, 'utf8');
    const schema6Bytes = fs.readFileSync(schema6Path, 'utf8');
    const schema7Bytes = fs.readFileSync(schema7Path, 'utf8');
    const schema8Bytes = fs.readFileSync(schema8Path, 'utf8');
    const schema9Bytes = fs.readFileSync(schema9Path, 'utf8');
    const schema10Bytes = fs.readFileSync(schema10Path, 'utf8');
    const schema11Bytes = fs.readFileSync(schema11Path, 'utf8');
    expect(G1_ARTIFACT_PATHS.migration).toBe(
      'migration/workflow-runtime-schema-v11.sql',
    );
    expect(schema5Bytes).toBe(schema5Migration.sql);
    expect(rawHash(schema5Bytes)).toBe(
      'sha256:2ead40dc2f1618f87247e9d3bb476266797c38560e1ad0537a6afa6f71a3fbf6',
    );
    expect(schema6Bytes).toBe(schema6Migration.sql);
    expect(rawHash(schema6Bytes)).toBe(
      'sha256:16a46e84c77d734013e18b4b00b86564f6188ea73717763e9fb7a884d62faa41',
    );
    expect(schema7Bytes).toBe(schema7Migration.sql);
    expect(rawHash(schema7Bytes)).toBe(
      'sha256:b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497',
    );
    expect(schema8Bytes).toBe(schema8Migration.sql);
    expect(rawHash(schema8Bytes)).toBe(
      'sha256:b19ebe83ea8b7c53a2ab54a901df092b4e343ee4e1d5772ed6bc3143a82746ad',
    );
    expect(schema9Bytes).toBe(schema9Migration.sql);
    expect(rawHash(schema9Bytes)).toBe(
      'sha256:4591e2dd417d439c813026816572e8a66e9d088efa6a8de88ebfb38a68cf9837',
    );
    expect(schema10Bytes).toBe(schema10Migration.sql);
    expect(rawHash(schema10Bytes)).toBe(
      'sha256:269645a9f093dc35fd35a04336d71e38cc17b7168584752f9b9bdfc106f46fad',
    );
    expect(schema11Bytes).toBe(migration.sql);

    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-schema5-schema6-paths-'),
    );
    const schema5Database = createMigratedDatabase(
      path.join(root, 'schema5.db'),
      schema5Bytes,
    );
    const schema6Database = createMigratedDatabase(
      path.join(root, 'schema6.db'),
      schema6Bytes,
    );
    const schema7Database = createMigratedDatabase(
      path.join(root, 'schema7.db'),
      schema7Bytes,
    );
    const schema8Database = createMigratedDatabase(
      path.join(root, 'schema8.db'),
      schema8Bytes,
    );
    const schema9Database = createMigratedDatabase(
      path.join(root, 'schema9.db'),
      schema9Bytes,
    );
    const schema10Database = createMigratedDatabase(
      path.join(root, 'schema10.db'),
      schema10Bytes,
    );
    const schema11Database = createMigratedDatabase(
      path.join(root, 'schema11.db'),
      schema11Bytes,
    );
    try {
      expect(schema5Database.pragma('user_version', { simple: true })).toBe(5);
      expect(schema6Database.pragma('user_version', { simple: true })).toBe(6);
      expect(schema7Database.pragma('user_version', { simple: true })).toBe(7);
      expect(schema8Database.pragma('user_version', { simple: true })).toBe(8);
      expect(schema9Database.pragma('user_version', { simple: true })).toBe(9);
      expect(schema10Database.pragma('user_version', { simple: true })).toBe(
        10,
      );
      expect(schema11Database.pragma('user_version', { simple: true })).toBe(
        11,
      );
    } finally {
      schema5Database.close();
      schema6Database.close();
      schema7Database.close();
      schema8Database.close();
      schema9Database.close();
      schema10Database.close();
      schema11Database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('regenerates byte-identical artifacts and a byte-identical introspected manifest', () => {
    const built = checkG1Artifacts();
    expect(built.schemaHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(built.environmentSummary.managed_node_version).toBe('v26.5.0');
    expect(built.environmentSummary.better_sqlite3_version).toBe('12.11.1');
    expect(built.artifacts.at(-1)?.[1].payload).toMatchObject({
      gate: 'G1.1',
      schema_dependency_manifest_hash: built.dependencyManifest.hash,
      physical_schema_identity: (
        built.dependencyManifest
          .payload as unknown as G1SchemaDependencyManifestPayload
      ).physical_schema_identity,
    });
    expect(built.artifacts.at(-1)?.[1].payload).not.toHaveProperty(
      'g0_10_root_hash',
    );
    withDatabase((database, databasePath) => {
      const manifest = reconstructSchemaManifest(
        database,
        source,
        migration.sql,
        migration.statement_count,
        migration.triggers,
      );
      expect(manifest.schema_hash).toBe(built.schemaHash);
      expect(manifest).toEqual(built.manifest.payload);
      verifyQueryPlans(database, buildQueryFixtures(source));
      database.close();
      verifyReadOnlyConnection(databasePath);
    });
  });

  it('publishes a closed exact-member dependency manifest without directory exclusions', () => {
    const built = checkG1Artifacts();
    expect(() =>
      buildSchemaDependencyManifestArtifact(
        built.manifest,
        built.migrationSql,
        {},
        '',
        built.schema4To5UpgradeSql,
        built.schema5To6UpgradeSql,
        built.schema6To7UpgradeSql,
        built.schema7To8UpgradeSql,
        built.schema8To9UpgradeSql,
        built.schema9To10UpgradeSql,
        built.schema10To11UpgradeSql,
      ),
    ).toThrow('Schema 3 to 4 upgrade SQL must not be empty');
    const payload = built.dependencyManifest
      .payload as unknown as G1SchemaDependencyManifestPayload;
    expect(() => assertClosedSchemaDependencyManifest(payload)).not.toThrow();
    expect(payload).toMatchObject({
      member_count: 25,
      physical_member_count: 24,
      construction_provenance_count: 1,
    });
    expect(payload.members.map((member) => member.role)).toEqual([
      'g0_6_logical_schema_manifest',
      'logical_schema_source',
      'typed_relation_catalog',
      'query_catalog',
      'g0_10_capacity_logical_schema_delta',
      'publisher_schema_prerequisite',
      'feature_release_activation_schema_prerequisite',
      'activation_failure_replay_schema_prerequisite',
      'generated_schema_authority_prerequisite',
      'node_output_envelope_schema_authority_prerequisite',
      'child_completion_lineage_schema_prerequisite',
      'map_terminal_consumption_schema_prerequisite',
      'domain_claim_handoff_schema_prerequisite',
      'runtime_command_ingress_schema_prerequisite',
      'sqlite_execution_profile',
      'schema_manifest',
      'canonical_migration',
      'schema3_to_schema4_upgrade',
      'schema4_to_schema5_upgrade',
      'schema5_to_schema6_upgrade',
      'schema6_to_schema7_upgrade',
      'schema7_to_schema8_upgrade',
      'schema8_to_schema9_upgrade',
      'schema9_to_schema10_upgrade',
      'schema10_to_schema11_upgrade',
    ]);
    expect(payload.members.map((member) => member.role)).toEqual([
      ...G1_SCHEMA_DEPENDENCY_ROLES,
    ]);
    const dependencyContract = built.artifacts.find(([relativePath]) =>
      relativePath.includes('schema-dependency-manifest-contract'),
    )?.[1];
    expect(dependencyContract?.payload.required_roles).toEqual([
      ...G1_SCHEMA_DEPENDENCY_ROLES,
    ]);
    expect(payload.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'canonical_migration',
          path: [
            'store',
            'schema',
            'migration',
            'workflow-runtime-schema-v11.sql',
          ].join('/'),
          ref: {
            id: 'icarus.workflow-runtime-schema-v11-migration',
            version: '1',
          },
          semantic_hash: rawHash(built.migrationSql),
          raw_sha256: rawHash(built.migrationSql),
        }),
        expect.objectContaining({
          role: 'schema3_to_schema4_upgrade',
          semantic_hash:
            'sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf',
        }),
        expect.objectContaining({
          role: 'schema4_to_schema5_upgrade',
          semantic_hash:
            'sha256:97479810c2c079d71270d5a714faa4b8fa8ebd6af629ef2f7d772af270c2bb0a',
        }),
        expect.objectContaining({
          role: 'schema5_to_schema6_upgrade',
          semantic_hash:
            'sha256:dc94fa0867ca572b7ec39ffb8df448e38be00ca4831f1d420885ee7cc097687d',
        }),
        expect.objectContaining({
          role: 'schema6_to_schema7_upgrade',
          semantic_hash:
            'sha256:225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062',
        }),
        expect.objectContaining({
          role: 'schema7_to_schema8_upgrade',
          semantic_hash:
            'sha256:544af9b55349268d152650c9a9fda5c399bb0e665750a2c47a6155d22ca6e3a9',
        }),
        expect.objectContaining({
          role: 'schema8_to_schema9_upgrade',
          semantic_hash:
            'sha256:890c911a27074cca3ee34f9a7f022e4fbda6edf77fbe2ad75f2b77d0d1bed23b',
        }),
        expect.objectContaining({
          role: 'schema9_to_schema10_upgrade',
          semantic_hash: rawHash(built.schema9To10UpgradeSql),
        }),
        expect.objectContaining({
          role: 'schema10_to_schema11_upgrade',
          semantic_hash: rawHash(built.schema10To11UpgradeSql),
        }),
      ]),
    );
    for (const member of payload.members) {
      expect(member).toMatchObject({
        role: expect.any(String),
        identity_effect: expect.stringMatching(
          /^(construction_provenance|physical_schema_input|physical_schema_output)$/,
        ),
        path: expect.any(String),
        format: expect.any(String),
        ref: { id: expect.any(String), version: expect.any(String) },
        version: 1,
        semantic_hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        raw_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
    }
    expect(payload.members[0].identity_effect).toBe('construction_provenance');
    expect(
      built.artifacts.find(
        ([, artifact]) =>
          artifact.format ===
          'icarus.workflow-runtime-schema-dependency-manifest-contract/1',
      )?.[1].payload,
    ).toMatchObject({
      path_model: 'exact_required_members_only',
      directory_exclusions: 'forbidden',
    });
    const provenanceOnly = structuredClone(payload.members);
    provenanceOnly[0].raw_sha256 = hash('changed-construction-provenance');
    expect(calculatePhysicalSchemaIdentity(provenanceOnly)).toBe(
      payload.physical_schema_identity,
    );
    const physicalDrift = structuredClone(payload.members);
    physicalDrift[1].raw_sha256 = hash('changed-physical-input');
    expect(calculatePhysicalSchemaIdentity(physicalDrift)).not.toBe(
      payload.physical_schema_identity,
    );
  });

  it('ignores unrelated Contract JSON without an exclusion list', () => {
    const built = checkG1Artifacts();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g1-deps-'));
    const copiedContracts = path.join(root, 'contracts');
    fs.cpSync(
      path.resolve(import.meta.dirname, '../../contracts'),
      copiedContracts,
      {
        recursive: true,
      },
    );
    try {
      const before = buildSchemaDependencyManifestArtifact(
        built.manifest,
        built.migrationSql,
        { contractsRoot: copiedContracts },
        built.schema3To4UpgradeSql,
        built.schema4To5UpgradeSql,
        built.schema5To6UpgradeSql,
        built.schema6To7UpgradeSql,
        built.schema7To8UpgradeSql,
        built.schema8To9UpgradeSql,
        built.schema9To10UpgradeSql,
        built.schema10To11UpgradeSql,
      );
      for (const relativePath of [
        'unrelated/new-contract.json',
        'conformance/compiler-contract-repair/unrelated-contract.json',
        'conformance/future-registry/unrelated-contract.json',
      ]) {
        const absolute = path.join(copiedContracts, relativePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, '{"unrelated":true}\n');
      }
      const after = buildSchemaDependencyManifestArtifact(
        built.manifest,
        built.migrationSql,
        { contractsRoot: copiedContracts },
        built.schema3To4UpgradeSql,
        built.schema4To5UpgradeSql,
        built.schema5To6UpgradeSql,
        built.schema6To7UpgradeSql,
        built.schema7To8UpgradeSql,
        built.schema8To9UpgradeSql,
        built.schema9To10UpgradeSql,
        built.schema10To11UpgradeSql,
      );
      expect(after).toEqual(before);
      expect(after).toEqual(built.dependencyManifest);
      expect(built.artifacts.at(-1)?.[1].payload).toMatchObject({
        schema_dependency_manifest_hash: after.hash,
      });
      expect(
        buildG1Artifacts({ contractsRoot: copiedContracts }).artifacts.at(
          -1,
        )?.[1].hash,
      ).toBe(built.artifacts.at(-1)?.[1].hash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('changes explicit identity for required raw-byte drift and fails on semantic or missing input', () => {
    const built = checkG1Artifacts();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g1-deps-'));
    const copiedContracts = path.join(root, 'contracts');
    fs.cpSync(
      path.resolve(import.meta.dirname, '../../contracts'),
      copiedContracts,
      {
        recursive: true,
      },
    );
    try {
      const queryPath = path.join(
        copiedContracts,
        'sqlite/workflow-runtime-query-catalog@1.json',
      );
      fs.appendFileSync(queryPath, '\n');
      const changed = buildSchemaDependencyManifestArtifact(
        built.manifest,
        built.migrationSql,
        { contractsRoot: copiedContracts },
        built.schema3To4UpgradeSql,
        built.schema4To5UpgradeSql,
        built.schema5To6UpgradeSql,
        built.schema6To7UpgradeSql,
        built.schema7To8UpgradeSql,
        built.schema8To9UpgradeSql,
        built.schema9To10UpgradeSql,
        built.schema10To11UpgradeSql,
      );
      const originalPayload = built.dependencyManifest
        .payload as unknown as G1SchemaDependencyManifestPayload;
      const changedPayload =
        changed.payload as unknown as G1SchemaDependencyManifestPayload;
      expect(changed.hash).not.toBe(built.dependencyManifest.hash);
      expect(changedPayload.physical_schema_identity).not.toBe(
        originalPayload.physical_schema_identity,
      );
      expect(
        changedPayload.members.find((member) => member.role === 'query_catalog')
          ?.semantic_hash,
      ).toBe(
        originalPayload.members.find(
          (member) => member.role === 'query_catalog',
        )?.semantic_hash,
      );
      expect(() =>
        verifySchemaDependencyManifestArtifact(built.dependencyManifest, {
          contractsRoot: copiedContracts,
        }),
      ).toThrow('query_catalog raw hash mismatch');
      expect(() =>
        verifySchemaDependencyManifestArtifact(changed, {
          contractsRoot: copiedContracts,
        }),
      ).not.toThrow();

      const queryArtifact = JSON.parse(
        fs.readFileSync(queryPath, 'utf8'),
      ) as ContractArtifactEnvelope;
      (queryArtifact.payload as JsonObject).query_count = 999;
      queryArtifact.hash = calculateArtifactHash(queryArtifact);
      fs.writeFileSync(
        queryPath,
        `${JSON.stringify(queryArtifact, null, 2)}\n`,
      );
      expect(() =>
        buildSchemaDependencyManifestArtifact(
          built.manifest,
          built.migrationSql,
          { contractsRoot: copiedContracts },
          built.schema3To4UpgradeSql,
          built.schema4To5UpgradeSql,
          built.schema5To6UpgradeSql,
          built.schema6To7UpgradeSql,
          built.schema7To8UpgradeSql,
          built.schema8To9UpgradeSql,
          built.schema9To10UpgradeSql,
          built.schema10To11UpgradeSql,
        ),
      ).toThrow('query_catalog published semantic identity drifted');

      fs.rmSync(
        path.join(
          copiedContracts,
          'sqlite/workflow-runtime-typed-relation-catalog@1.json',
        ),
      );
      expect(() =>
        buildSchemaDependencyManifestArtifact(
          built.manifest,
          built.migrationSql,
          { contractsRoot: copiedContracts },
          built.schema3To4UpgradeSql,
          built.schema4To5UpgradeSql,
          built.schema5To6UpgradeSql,
          built.schema6To7UpgradeSql,
          built.schema7To8UpgradeSql,
          built.schema8To9UpgradeSql,
          built.schema9To10UpgradeSql,
          built.schema10To11UpgradeSql,
        ),
      ).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects missing members, duplicate role/path, unknown fields, and hash mismatch', () => {
    const built = checkG1Artifacts();
    const clonePayload = (): G1SchemaDependencyManifestPayload =>
      structuredClone(
        built.dependencyManifest.payload,
      ) as unknown as G1SchemaDependencyManifestPayload;

    const missing = clonePayload() as unknown as Record<string, unknown>;
    (missing.members as unknown[]).pop();
    missing.member_count = 7;
    expect(() =>
      assertClosedSchemaDependencyManifest(
        missing as unknown as G1SchemaDependencyManifestPayload,
      ),
    ).toThrow('required members are missing');

    const duplicateRole = clonePayload();
    duplicateRole.members[1].role = duplicateRole.members[0].role;
    expect(() => assertClosedSchemaDependencyManifest(duplicateRole)).toThrow(
      'duplicate role',
    );

    const duplicatePath = clonePayload();
    duplicatePath.members[1].path = duplicatePath.members[0].path;
    expect(() => assertClosedSchemaDependencyManifest(duplicatePath)).toThrow(
      'duplicate path',
    );

    const unknown = clonePayload() as unknown as Record<string, unknown>;
    unknown.directory_exclusions = ['future-bypass'];
    expect(() =>
      assertClosedSchemaDependencyManifest(
        unknown as unknown as G1SchemaDependencyManifestPayload,
      ),
    ).toThrow('is not closed');

    const mismatch = clonePayload();
    mismatch.members[1].raw_sha256 = hash('mismatch');
    expect(() => assertClosedSchemaDependencyManifest(mismatch)).toThrow(
      'physical schema identity hash mismatch',
    );

    mismatch.physical_schema_identity = calculatePhysicalSchemaIdentity(
      mismatch.members,
    );
    const mismatchArtifact = structuredClone(built.dependencyManifest);
    mismatchArtifact.payload = mismatch as unknown as JsonObject;
    mismatchArtifact.hash = calculateArtifactHash(mismatchArtifact);
    expect(() =>
      verifySchemaDependencyManifestArtifact(mismatchArtifact),
    ).toThrow('raw hash mismatch');
  });

  it('rejects unknown fields at every nested Schema Manifest object level', () => {
    const built = checkG1Artifacts();
    const selectors: Array<
      (payload: WorkflowRuntimeSchemaManifestPayload) => object
    > = [
      (payload) => payload,
      (payload) => payload.logical_inputs,
      (payload) => payload.tables[0],
      (payload) => payload.tables[0].columns[0],
      (payload) =>
        payload.tables
          .flatMap((table) => table.columns)
          .find((column) => column.external_reference)?.external_reference ??
        {},
      (payload) => payload.tables[0].primary_key,
      (payload) =>
        payload.tables.find((table) => table.unique_keys.length > 0)
          ?.unique_keys[0] ?? {},
      (payload) =>
        payload.tables.find((table) => table.foreign_keys.length > 0)
          ?.foreign_keys[0] ?? {},
      (payload) =>
        payload.tables.find((table) => table.checks.length > 0)?.checks[0] ??
        {},
      (payload) =>
        payload.tables.find((table) => table.indexes.length > 0)?.indexes[0] ??
        {},
      (payload) => payload.triggers[0],
      (payload) => payload.query_fixtures[0],
    ];
    for (const select of selectors) {
      const payload = structuredClone(
        built.manifest.payload,
      ) as unknown as WorkflowRuntimeSchemaManifestPayload;
      (select(payload) as Record<string, unknown>).unknown_field = true;
      expect(() => assertClosedSchemaManifest(payload)).toThrow(
        'is not closed',
      );
    }
  });

  it('rejects an illegal value through every published enum CHECK', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      let checked = 0;
      for (const metadata of source.tables) {
        for (const column of metadata.columns.filter(
          (candidate) => candidate.enum_values.length > 0,
        )) {
          const checkId = metadata.checks.find(
            (candidate) =>
              candidate.kind === 'enum_membership' &&
              candidate.columns.length === 1 &&
              candidate.columns[0] === column.name,
          )?.check_id;
          expect(checkId).toBeDefined();
          const validCapacityInvocation: Record<
            string,
            string | number | null
          > =
            metadata.name === 'runtime_capacity_admin_invocations'
              ? column.name === 'denial_code'
                ? {
                    authorization_result: 'denied',
                    execution_result: 'denied',
                    denial_code: 'permission_denied',
                    applied_at_ms: null,
                  }
                : {
                    authorization_result: 'allowed',
                    execution_result: 'conflict',
                    denial_code: null,
                    applied_at_ms: null,
                  }
              : {};
          const validWorkflowValue: Record<string, string | number | null> =
            metadata.name === 'workflow_values'
              ? {
                  storage_kind: 'inline',
                  inline_canonical_json: '{}',
                  schema_resource_id: 'registry:schema',
                  schema_resource_hash: hash('registry:schema'),
                }
              : {};
          const generatedSchemaRawHash = hash('generated-schema-content');
          const validGeneratedSchemaContent: Record<
            string,
            string | number | null
          > =
            metadata.name === 'workflow_generated_schema_contents'
              ? {
                  schema_ref: `icarus-generated-schema:${generatedSchemaRawHash}`,
                  schema_raw_hash: generatedSchemaRawHash,
                }
              : {};
          const insertInvalid = () =>
            insertRow(database, metadata.name, {
              ...validCapacityInvocation,
              ...validWorkflowValue,
              ...validGeneratedSchemaContent,
              [column.name]: '__invalid_closed_enum__',
            });
          if (
            metadata.name === 'workflow_runtime_command_ingress_invocations' &&
            [
              'resolution_result',
              'authorization_result',
              'execution_result',
            ].includes(column.name)
          ) {
            expect(insertInvalid).toThrow(
              /command_ingress_must_start_prepared|ck:workflow_runtime_command_ingress_invocations:/,
            );
          } else {
            expect(insertInvalid).toThrow(checkId as string);
          }
          checked += 1;
        }
      }
      expect(checked).toBe(
        source.tables.reduce(
          (total, metadata) =>
            total +
            metadata.columns.filter((column) => column.enum_values.length > 0)
              .length,
          0,
        ),
      );
    });
  });

  it('rejects unsafe integers and typed-relation zero/multi target shapes', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      expect(() =>
        insertRow(database, 'workflow_graph_scheduler_admissions', {
          eligible_event_seq: -1,
        }),
      ).toThrow(
        'ck:workflow_graph_scheduler_admissions:eligible_event_seq:safe_integer',
      );
      expect(() =>
        insertRow(database, 'workflow_graph_events', {
          occurred_at_ms: 9007199254740992,
        }),
      ).toThrow('safe_integer');

      expect(() =>
        insertRow(database, 'workflow_graph_resource_accounts', {
          deployment_scope_ref: null,
          workflow_id: null,
          graph_run_id: null,
          scope_id: null,
          node_id: null,
          execution_group_resource_id: null,
          execution_group_resource_hash: null,
        }),
      ).toThrow('exactly_one');
      expect(() =>
        insertRow(database, 'workflow_graph_resource_accounts', {
          deployment_scope_ref: 'deployment',
          workflow_id: 'workflow',
        }),
      ).toThrow('exactly_one');
    });
  });

  it('enforces closed immutable ingress audit without claimed-target foreign keys', () => {
    withDatabase((database) => {
      const foreignKeys = database
        .prepare(
          'PRAGMA foreign_key_list("workflow_runtime_command_ingress_invocations")',
        )
        .all() as Array<{ from: string; table: string }>;
      expect(foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: 'resolved_command_id',
            table: 'workflow_runtime_command_invocations',
          }),
          expect.objectContaining({
            from: 'resolved_invocation_id',
            table: 'workflow_runtime_command_invocations',
          }),
        ]),
      );
      expect(
        foreignKeys.some((foreignKey) =>
          foreignKey.from.startsWith('claimed_'),
        ),
      ).toBe(false);

      const insertPrepared = (
        id: string,
        claimedWorkflowId: string | null,
        claimedRunId: string | null,
      ) =>
        database
          .prepare(
            `INSERT INTO workflow_runtime_command_ingress_invocations (
               id, idempotency_domain, idempotency_key, ingress_no,
               submitted_command_id, canonical_request_json,
               submitted_request_hash, command_type, claimed_target_kind,
               claimed_workflow_id, claimed_run_id, claimed_node_id,
               claimed_retry_schedule_id, claimed_effect_operation_id,
               claimed_operational_blocker_id, actor_ref, actor_kind,
               auth_session_ref, entrypoint, source_feature_id,
               delegation_chain_ref, resolution_result, authorization_result,
               execution_result, denial_code, canonical_result_json,
               canonical_result_hash, resolved_command_id,
               resolved_invocation_id, requested_at_ms, decided_at_ms,
               applied_at_ms
             ) VALUES (?, 'human:owner:runtime_center', ?, 1, ?, '{}', ?,
               'pause_run', ?, ?, ?, NULL, NULL, NULL, NULL, 'human:owner',
               'human', 'session:owner', 'runtime_center', NULL, NULL,
               'prepared', 'pending', 'prepared', NULL, NULL, NULL, NULL,
               NULL, 100, NULL, NULL)`,
          )
          .run(
            id,
            `key:${id}`,
            `command:${id}`,
            hash(`request:${id}`),
            claimedWorkflowId === null ? 'run' : 'workflow',
            claimedWorkflowId,
            claimedRunId,
          );

      expect(() => insertPrepared('ingress:zero', null, null)).toThrow(
        'ck:command_ingress:claimed_target_exactly_one',
      );
      expect(() =>
        insertPrepared('ingress:multi', 'workflow:claimed', 'run:claimed'),
      ).toThrow('ck:command_ingress:claimed_target_exactly_one');

      insertPrepared('ingress:missing-target', null, 'run:does-not-exist');
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_runtime_command_ingress_invocations
                SET resolution_result='target_not_found',
                    authorization_result='not_evaluated',
                    execution_result='denied', denial_code='target_not_found',
                    canonical_result_json='{}', canonical_result_hash=?,
                    decided_at_ms=99, terminal_binding_hash=?
              WHERE id='ingress:missing-target'`,
          )
          .run(hash('result:chronology'), hash('binding:chronology')),
      ).toThrow('ck:command_ingress:chronology');
      database
        .prepare(
          `UPDATE workflow_runtime_command_ingress_invocations
              SET resolution_result='target_not_found',
                  authorization_result='not_evaluated',
                  execution_result='denied', denial_code='target_not_found',
                  canonical_result_json='{}', canonical_result_hash=?,
                  decided_at_ms=100, terminal_binding_hash=?
            WHERE id='ingress:missing-target'`,
        )
        .run(hash('result:missing-target'), hash('binding:missing-target'));
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_runtime_command_ingress_invocations
                SET decided_at_ms=101 WHERE id='ingress:missing-target'`,
          )
          .run(),
      ).toThrow('command_ingress_terminal_transition_invalid');
      expect(() =>
        database
          .prepare(
            `DELETE FROM workflow_runtime_command_ingress_invocations
              WHERE id='ingress:missing-target'`,
          )
          .run(),
      ).toThrow('command_ingress_is_immutable');

      insertPrepared('ingress:fake-resolved', null, 'run:does-not-exist');
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_runtime_command_ingress_invocations
                SET resolution_result='resolved', authorization_result='allowed',
                    execution_result='applied', canonical_result_json='{}',
                    canonical_result_hash=?, resolved_command_id='command:fake',
                    resolved_invocation_id='invocation:fake', decided_at_ms=100,
                    applied_at_ms=100, terminal_binding_hash=?
              WHERE id='ingress:fake-resolved'`,
          )
          .run(hash('result:fake-resolved'), hash('binding:fake-resolved')),
      ).toThrow('FOREIGN KEY constraint failed');

      database.pragma('foreign_keys = OFF');
      expect(() =>
        seedRow(database, 'workflow_runtime_commands', {
          command_id: 'command:starts-terminal',
          command_type: 'pause_run',
          workflow_id: null,
          run_id: 'run:claimed',
          node_id: null,
          retry_schedule_id: null,
          effect_operation_id: null,
          operational_blocker_id: null,
          canonical_result_value_id: 'value:terminal',
          canonical_result_hash: hash('value:terminal'),
          finalized_at_ms: 101,
        }),
      ).toThrow('runtime_command_must_start_pending');
      seedRow(database, 'workflow_runtime_commands', {
        command_id: 'command:immutable',
        command_type: 'pause_run',
        workflow_id: null,
        run_id: 'run:claimed',
        node_id: null,
        retry_schedule_id: null,
        effect_operation_id: null,
        operational_blocker_id: null,
        canonical_result_value_id: null,
        canonical_result_hash: null,
        finalized_at_ms: null,
        created_at_ms: 100,
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_runtime_commands SET reason_code='rewritten'
              WHERE command_id='command:immutable'`,
          )
          .run(),
      ).toThrow('runtime_command_identity_is_immutable');
      database
        .prepare(
          `UPDATE workflow_runtime_commands
              SET canonical_result_value_id='value:terminal',
                  canonical_result_hash=?, finalized_at_ms=101
            WHERE command_id='command:immutable'`,
        )
        .run(hash('value:terminal'));
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_runtime_commands SET finalized_at_ms=102
              WHERE command_id='command:immutable'`,
          )
          .run(),
      ).toThrow('runtime_command_terminalization_invalid');
      expect(() =>
        database
          .prepare(
            `DELETE FROM workflow_runtime_commands
              WHERE command_id='command:immutable'`,
          )
          .run(),
      ).toThrow('runtime_command_is_immutable');

      seedRow(database, 'workflow_runtime_command_invocations', {
        id: 'invocation:immutable',
        command_id: 'command:immutable',
        invocation_no: 1,
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_runtime_command_invocations
                SET decided_at_ms=decided_at_ms
              WHERE id='invocation:immutable'`,
          )
          .run(),
      ).toThrow('runtime_command_invocation_is_immutable');
      expect(() =>
        database
          .prepare(
            `DELETE FROM workflow_runtime_command_invocations
              WHERE id='invocation:immutable'`,
          )
          .run(),
      ).toThrow('runtime_command_invocation_is_immutable');
    });
  });

  it('enforces activation, workflow, attempt, terminal, and blocker state shapes', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      expect(() =>
        insertRow(database, 'workflow_state_activations', {
          state_type: 'terminal',
          status: 'active',
          graph_run_id: 'run',
          terminal_kind: null,
        }),
      ).toThrow('ck:state_activations:type_run');
      expect(() =>
        insertRow(database, 'workflows', {
          status: 'completed',
          operational_state: 'healthy',
          finished_at_ms: null,
        }),
      ).toThrow('ck:workflows:status_time');
      expect(() =>
        insertRow(database, 'workflow_graph_node_attempts', {
          attempt_no: 2,
          continuation_kind: 'initial',
          parent_attempt_id: null,
          parent_attempt_no: null,
        }),
      ).toThrow('ck:node_attempts:continuation');
      expect(() =>
        insertRow(database, 'workflow_graph_completion_cuts', {
          outcome_kind: 'completed',
          exit_name: null,
          output_value_id: null,
          output_hash: null,
          selected_rule_id: null,
          candidate_id: null,
        }),
      ).toThrow('ck:completion_cuts:outcome_shape');
      expect(() =>
        insertRow(database, 'workflow_operational_blockers', {
          source_effect_operation_id: null,
          source_outbox_id: null,
          source_root_finalization_schedule_id: null,
          source_claim_id: null,
          source_event_seq: null,
        }),
      ).toThrow('exactly_one');
      expect(() =>
        insertRow(database, 'workflow_operational_blockers', {
          source_effect_operation_id: 'effect',
          source_outbox_id: 'outbox',
        }),
      ).toThrow('exactly_one');
    });
  });

  it('enforces composite lineage, single successor, idempotency, and root uniqueness', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const runId = 'run:root-unique';
      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:root:1',
        graph_run_id: runId,
        parent_scope_id: null,
      });
      expect(() =>
        seedRow(database, 'workflow_graph_scopes', {
          id: 'scope:root:2',
          graph_run_id: runId,
          parent_scope_id: null,
        }),
      ).toThrow('UNIQUE constraint failed');

      seedRow(database, 'workflow_runtime_commands', {
        command_id: 'command:1',
        idempotency_domain: 'human:local-owner',
        idempotency_key: 'same',
      });
      expect(() =>
        seedRow(database, 'workflow_runtime_commands', {
          command_id: 'command:2',
          idempotency_domain: 'human:local-owner',
          idempotency_key: 'same',
        }),
      ).toThrow('UNIQUE constraint failed');

      seedRow(database, 'workflow_graph_node_attempts', {
        id: 'attempt:parent',
        node_id: 'node:parent',
        attempt_no: 1,
        parent_attempt_id: null,
      });
      seedRow(database, 'workflow_graph_node_attempts', {
        id: 'attempt:child:1',
        node_id: 'node:parent',
        attempt_no: 2,
        parent_attempt_id: 'attempt:parent',
      });
      expect(() =>
        seedRow(database, 'workflow_graph_node_attempts', {
          id: 'attempt:child:2',
          node_id: 'node:other',
          attempt_no: 3,
          parent_attempt_id: 'attempt:parent',
        }),
      ).toThrow('UNIQUE constraint failed');

      seedRow(database, 'workflow_graph_scope_close_requests', {
        id: 'close:1',
        graph_run_id: runId,
        scope_id: 'scope:root:1',
      });
      expect(() =>
        seedRow(database, 'workflow_graph_scope_close_requests', {
          id: 'close:2',
          graph_run_id: runId,
          scope_id: 'scope:root:1',
        }),
      ).toThrow('UNIQUE constraint failed');
      seedRow(database, 'workflow_graph_completion_cuts', {
        id: 'cut:1',
        graph_run_id: runId,
        scope_id: 'scope:root:1',
        close_request_id: 'close:1',
      });
      expect(() =>
        seedRow(database, 'workflow_graph_completion_cuts', {
          id: 'cut:2',
          graph_run_id: runId,
          scope_id: 'scope:root:1',
          close_request_id: 'close:2',
        }),
      ).toThrow('UNIQUE constraint failed');
    });

    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      database.pragma('ignore_check_constraints = ON');
      seedRow(database, 'workflow_graph_runs', {
        id: 'run:a',
        workflow_id: 'workflow:a',
      });
      seedRow(database, 'workflow_graph_runs', {
        id: 'run:b',
        workflow_id: 'workflow:b',
      });
      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:a',
        graph_run_id: 'run:a',
      });
      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:b',
        graph_run_id: 'run:b',
      });
      seedRow(database, 'workflow_graph_nodes', {
        id: 'node:b',
        graph_run_id: 'run:b',
        scope_id: 'scope:b',
      });
      database.pragma('foreign_keys = ON');
      expect(() =>
        insertRow(database, 'workflow_graph_scheduler_admissions', {
          graph_run_id: 'run:a',
          scope_id: 'scope:a',
          node_id: 'node:b',
          attempt_id: 'attempt:b',
        }),
      ).toThrow('FOREIGN KEY constraint failed');
      database.pragma('ignore_check_constraints = OFF');
    });
  });

  it('maintains blocker caches and enforces confirmation and planless-root triggers', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      seedRow(database, 'workflows', {
        id: 'workflow:blocker',
        status: 'active',
        operational_state: 'healthy',
        finished_at_ms: null,
      });
      seedRow(database, 'workflow_graph_runs', {
        id: 'run:blocker',
        workflow_id: 'workflow:blocker',
        operational_state: 'healthy',
      });
      const base = {
        workflow_id: 'workflow:blocker',
        graph_run_id: 'run:blocker',
        source_effect_operation_id: null,
        source_outbox_id: null,
        source_root_finalization_schedule_id: null,
        source_claim_id: null,
        status: 'open',
      } as const;
      insertRow(database, 'workflow_operational_blockers', {
        ...base,
        id: 'blocker:action',
        severity: 'action_required',
        source_event_seq: 1,
      });
      expect(
        database
          .prepare(
            'SELECT operational_state FROM workflow_graph_runs WHERE id = ?',
          )
          .pluck()
          .get('run:blocker'),
      ).toBe('action_required');
      insertRow(database, 'workflow_operational_blockers', {
        ...base,
        id: 'blocker:quarantine',
        severity: 'quarantine',
        source_event_seq: 2,
      });
      expect(
        database
          .prepare('SELECT operational_state FROM workflows WHERE id = ?')
          .pluck()
          .get('workflow:blocker'),
      ).toBe('quarantined');
      database
        .prepare(
          `UPDATE workflow_operational_blockers SET status='resolved', resolved_at_ms=10, resolution_command_id='command:resolve', resolved_event_seq=10 WHERE id='blocker:quarantine'`,
        )
        .run();
      expect(
        database
          .prepare('SELECT operational_state FROM workflows WHERE id = ?')
          .pluck()
          .get('workflow:blocker'),
      ).toBe('action_required');

      seedRow(database, 'workflow_runtime_commands', {
        command_id: 'command:ttl',
        command_type: 'request_administrative_abandon',
        workflow_id: 'workflow:blocker',
        run_id: null,
        node_id: null,
        retry_schedule_id: null,
        effect_operation_id: null,
        operational_blocker_id: null,
        expected_row_version: 0,
        request_hash: hash('command:ttl:request'),
        evidence_manifest_value_id: 'value:command:ttl:evidence',
        evidence_manifest_hash: hash('command:ttl:evidence'),
        created_at_ms: 1000,
      });
      expect(() =>
        seedRow(database, 'workflow_runtime_command_confirmations', {
          id: 'confirmation:bad',
          request_command_id: 'command:ttl',
          workflow_id: 'workflow:blocker',
          expected_workflow_row_version: 0,
          request_hash: hash('command:ttl:request'),
          evidence_manifest_value_id: 'value:command:ttl:evidence',
          evidence_manifest_hash: hash('command:ttl:evidence'),
          expires_at_ms: 300999,
        }),
      ).toThrow('command_confirmation_ttl_invalid');

      seedRow(database, 'workflow_graph_scopes', {
        id: 'scope:planless',
        graph_run_id: 'run:planless',
        plan_id: null,
        lifecycle: 'materializing',
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_graph_scopes SET lifecycle='closing' WHERE id='scope:planless'`,
          )
          .run(),
      ).toThrow('planless_root_close_without_setup_error_or_cancel');
    });
  });

  it('enforces Publisher caller idempotency, lifecycle, invocation, and event audit chains', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const commandId = 'publisher:command:1';
      const domainRequestHash = hash('publisher:request:domain');
      insertRow(database, 'workflow_publisher_commands', {
        command_id: commandId,
        idempotency_domain: 'feature:publisher',
        idempotency_key: 'release:1',
        domain_request_hash: domainRequestHash,
        approved_at_ms: 10,
        created_at_ms: 20,
        expires_at_ms: 30,
      });
      expect(() =>
        insertRow(database, 'workflow_publisher_commands', {
          command_id: 'publisher:command:duplicate',
          idempotency_domain: 'feature:publisher',
          idempotency_key: 'release:1',
          approved_at_ms: 10,
          created_at_ms: 20,
          expires_at_ms: 30,
        }),
      ).toThrow('UNIQUE constraint failed');
      expect(() =>
        insertRow(database, 'workflow_publisher_commands', {
          command_id: 'publisher:command:expired',
          idempotency_key: 'release:expired',
          approved_at_ms: 10,
          created_at_ms: 30,
          expires_at_ms: 30,
        }),
      ).toThrow('ck:publisher_commands:review_window');

      const target = database
        .prepare(
          'SELECT target_feature_release_id AS id, target_feature_release_hash AS hash FROM workflow_publisher_commands WHERE command_id = ?',
        )
        .get(commandId) as { id: string; hash: string };
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_publisher_commands SET lifecycle='applied', applied_feature_release_id=?, applied_feature_release_hash=?, canonical_receipt_value_id='receipt:partial', finalized_at_ms=40, row_version=1 WHERE command_id=?`,
          )
          .run(target.id, target.hash, commandId),
      ).toThrow('ck:publisher_commands:receipt_binding');
      database
        .prepare(
          `UPDATE workflow_publisher_commands SET lifecycle='applied', applied_feature_release_id=?, applied_feature_release_hash=?, canonical_receipt_value_id='receipt:1', canonical_receipt_hash=?, canonical_receipt_schema_resource_id='schema:receipt', canonical_receipt_schema_hash=?, finalized_at_ms=40, row_version=1 WHERE command_id=?`,
        )
        .run(
          target.id,
          target.hash,
          hash('publisher:receipt'),
          hash('publisher:receipt:schema'),
          commandId,
        );
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_publisher_commands SET lifecycle='failed', applied_feature_release_id=NULL, applied_feature_release_hash=NULL, row_version=2 WHERE command_id=?`,
          )
          .run(commandId),
      ).toThrow('publisher_command_lifecycle_transition_invalid');
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_publisher_commands SET idempotency_key='rewritten', row_version=2 WHERE command_id=?`,
          )
          .run(commandId),
      ).toThrow('publisher_command_identity_is_immutable');

      const invocationHash1 = hash('publisher:invocation:1');
      insertRow(database, 'workflow_publisher_command_invocations', {
        id: 'publisher:invocation:1',
        command_id: commandId,
        invocation_no: 1,
        command_domain_request_hash: domainRequestHash,
        submitted_request_hash: domainRequestHash,
        disposition: 'duplicate',
        previous_invocation_hash: null,
        invocation_hash: invocationHash1,
      });
      expect(() =>
        insertRow(database, 'workflow_publisher_command_invocations', {
          id: 'publisher:invocation:2:wrong-chain',
          command_id: commandId,
          invocation_no: 2,
          command_domain_request_hash: domainRequestHash,
          submitted_request_hash: hash('publisher:conflicting-request'),
          disposition: 'conflict',
          previous_invocation_hash: hash('publisher:wrong-previous'),
          invocation_hash: hash('publisher:invocation:2:wrong-chain'),
        }),
      ).toThrow('publisher_invocation_hash_chain_invalid');
      expect(() =>
        insertRow(database, 'workflow_publisher_command_invocations', {
          id: 'publisher:invocation:2:not-conflict',
          command_id: commandId,
          invocation_no: 2,
          command_domain_request_hash: domainRequestHash,
          submitted_request_hash: domainRequestHash,
          disposition: 'conflict',
          previous_invocation_hash: invocationHash1,
          invocation_hash: hash('publisher:invocation:2:not-conflict'),
        }),
      ).toThrow('ck:publisher_invocations:result_consistency');
      const invocationHash2 = hash('publisher:invocation:2');
      insertRow(database, 'workflow_publisher_command_invocations', {
        id: 'publisher:invocation:2',
        command_id: commandId,
        invocation_no: 2,
        command_domain_request_hash: domainRequestHash,
        submitted_request_hash: hash('publisher:conflicting-request'),
        disposition: 'conflict',
        previous_invocation_hash: invocationHash1,
        invocation_hash: invocationHash2,
      });
      expect(() =>
        insertRow(database, 'workflow_publisher_command_invocations', {
          id: 'publisher:invocation:4',
          command_id: commandId,
          invocation_no: 4,
          command_domain_request_hash: domainRequestHash,
          submitted_request_hash: domainRequestHash,
          disposition: 'duplicate',
          previous_invocation_hash: invocationHash2,
          invocation_hash: hash('publisher:invocation:4'),
        }),
      ).toThrow('publisher_invocation_hash_chain_invalid');
      expect(() =>
        database
          .prepare(
            'UPDATE workflow_publisher_command_invocations SET decided_at_ms=decided_at_ms WHERE id=?',
          )
          .run('publisher:invocation:2'),
      ).toThrow('publisher_invocation_is_immutable');
      expect(() =>
        database
          .prepare(
            'DELETE FROM workflow_publisher_command_invocations WHERE id=?',
          )
          .run('publisher:invocation:2'),
      ).toThrow('publisher_invocation_is_immutable');

      const eventHash1 = hash('publisher:event:1');
      insertRow(database, 'workflow_publisher_events', {
        command_id: commandId,
        event_no: 1,
        attempt_no: 1,
        phase: 'authenticate',
        event_type: 'attempt_started',
        previous_event_hash: null,
        event_hash: eventHash1,
      });
      expect(() =>
        insertRow(database, 'workflow_publisher_events', {
          command_id: commandId,
          event_no: 2,
          attempt_no: 1,
          phase: 'validate',
          event_type: 'phase_succeeded',
          previous_event_hash: hash('publisher:event:wrong'),
          event_hash: hash('publisher:event:2:wrong'),
        }),
      ).toThrow('publisher_event_hash_chain_invalid');
      const eventHash2 = hash('publisher:event:2');
      insertRow(database, 'workflow_publisher_events', {
        command_id: commandId,
        event_no: 2,
        attempt_no: 1,
        phase: 'validate',
        event_type: 'phase_succeeded',
        previous_event_hash: eventHash1,
        event_hash: eventHash2,
      });
      expect(() =>
        insertRow(database, 'workflow_publisher_events', {
          command_id: commandId,
          event_no: 3,
          attempt_no: 1,
          phase: 'publish_transaction',
          event_type: 'publish_committed',
          previous_event_hash: eventHash2,
          event_hash: hash('publisher:event:3:missing-release'),
        }),
      ).toThrow('ck:publisher_events:event_mapping');
      insertRow(database, 'workflow_publisher_events', {
        command_id: commandId,
        event_no: 3,
        attempt_no: 1,
        phase: 'publish_transaction',
        event_type: 'publish_committed',
        related_feature_release_id: target.id,
        related_feature_release_hash: target.hash,
        previous_event_hash: eventHash2,
        event_hash: hash('publisher:event:3'),
      });
      expect(() =>
        database
          .prepare(
            'UPDATE workflow_publisher_events SET occurred_at_ms=occurred_at_ms WHERE command_id=? AND event_no=3',
          )
          .run(commandId),
      ).toThrow('publisher_event_is_immutable');
      expect(() =>
        database
          .prepare(
            'DELETE FROM workflow_publisher_events WHERE command_id=? AND event_no=3',
          )
          .run(commandId),
      ).toThrow('publisher_event_is_immutable');
    });
  });

  it('publishes schema-bound Publisher Value relations and typed Registry/Release foreign keys', () => {
    const command = table('workflow_publisher_commands');
    expect(command.foreign_keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation_id: 'fk:publisher_commands:request_value',
          source_columns: [
            'request_value_id',
            'request_hash',
            'request_schema_resource_id',
            'request_schema_hash',
          ],
          target_table: 'workflow_values',
          target_columns: [
            'id',
            'content_hash',
            'schema_resource_id',
            'schema_resource_hash',
          ],
        }),
        expect.objectContaining({
          relation_id: 'fk:publisher_commands:execution_artifact',
          target_table: 'workflow_registry_resources',
        }),
        expect.objectContaining({
          relation_id: 'fk:publisher_commands:closure',
          target_table: 'workflow_registry_closure_manifests',
        }),
        expect.objectContaining({
          relation_id: 'fk:publisher_commands:applied_feature_release',
          target_table: 'workflow_feature_releases',
        }),
      ]),
    );
    expect(
      table('workflow_values').unique_keys.find(
        (key) => key.key_id === 'uk:values:id_hash_schema',
      )?.columns,
    ).toEqual([
      'id',
      'content_hash',
      'schema_resource_id',
      'schema_resource_hash',
    ]);
    expect(
      buildQueryFixtures(source)
        .filter((fixture) => fixture.query_id.startsWith('publisher_'))
        .map((fixture) => fixture.required_index_id),
    ).toEqual([
      'idx:publisher_commands:idempotency',
      'idx:publisher_invocations:command_history',
      'idx:publisher_events:command_history',
      'idx:publisher_commands:pending_recovery',
    ]);

    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const schemaId = 'publisher:schema';
      const schemaHash = hash('publisher:schema');
      const values = [
        ['publisher:value:request', hash('publisher:value:request')],
        ['publisher:value:source', hash('publisher:value:source')],
        ['publisher:value:plan', hash('publisher:value:plan')],
      ] as const;
      for (const [valueId, valueHash] of values) {
        seedRow(database, 'workflow_values', {
          id: valueId,
          content_hash: valueHash,
          schema_resource_id: schemaId,
          schema_resource_hash: schemaHash,
        });
      }
      const artifactHash = hash('publisher:artifact');
      seedRow(database, 'workflow_registry_resources', {
        id: 'publisher:artifact',
        content_hash: artifactHash,
      });
      const closureHash = hash('publisher:closure');
      seedRow(database, 'workflow_registry_closure_manifests', {
        id: 'publisher:closure',
        closure_hash: closureHash,
      });
      const releaseHash = hash('publisher:release');
      seedRow(database, 'workflow_feature_releases', {
        id: 'publisher:release',
        release_hash: releaseHash,
      });
      database.pragma('foreign_keys = ON');

      const exactBindings = {
        request_value_id: values[0][0],
        request_hash: values[0][1],
        request_schema_resource_id: schemaId,
        request_schema_hash: schemaHash,
        source_manifest_value_id: values[1][0],
        source_manifest_hash: values[1][1],
        source_manifest_schema_resource_id: schemaId,
        source_manifest_schema_hash: schemaHash,
        compiled_plan_value_id: values[2][0],
        compiled_plan_hash: values[2][1],
        compiled_plan_schema_resource_id: schemaId,
        compiled_plan_schema_hash: schemaHash,
        execution_artifact_resource_id: 'publisher:artifact',
        execution_artifact_hash: artifactHash,
        closure_manifest_id: 'publisher:closure',
        closure_hash: closureHash,
        target_feature_release_id: 'publisher:release',
        target_feature_release_hash: releaseHash,
        approved_at_ms: 10,
        created_at_ms: 20,
        expires_at_ms: 30,
      };
      insertRow(database, 'workflow_publisher_commands', {
        ...exactBindings,
        command_id: 'publisher:typed:valid',
        idempotency_key: 'publisher:typed:valid',
      });
      expect(() =>
        insertRow(database, 'workflow_publisher_commands', {
          ...exactBindings,
          command_id: 'publisher:typed:bad-schema',
          idempotency_key: 'publisher:typed:bad-schema',
          request_schema_hash: hash('publisher:schema:wrong'),
        }),
      ).toThrow('FOREIGN KEY constraint failed');
      expect(() =>
        insertRow(database, 'workflow_publisher_commands', {
          ...exactBindings,
          command_id: 'publisher:typed:bad-release',
          idempotency_key: 'publisher:typed:bad-release',
          target_feature_release_hash: hash('publisher:release:wrong'),
        }),
      ).toThrow('FOREIGN KEY constraint failed');
    });
  });

  it('G1.5 preserves the reproducible Schema 3 Activation construction input', () => {
    expect(hash(renderMigration(loadSchema3ExecutableSchemaSource()).sql)).toBe(
      'sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345',
    );
  });

  it('G1.5 enforces Release single-active lifecycle and active-pointer owner CAS protection', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const featureId = 'feature:pointer';
      const previousHash = hash('release:pointer:previous');
      const targetHash = hash('release:pointer:target');
      const nextHash = hash('release:pointer:next');
      insertRow(database, 'workflow_feature_releases', {
        id: 'release:pointer:previous',
        feature_id: featureId,
        release_ref: 'feature.pointer.release',
        release_version: '1.0.0',
        release_hash: previousHash,
        status: 'active',
        staged_at_ms: 10,
        activated_at_ms: 20,
        disabled_at_ms: null,
        row_version: 1,
      });
      insertRow(database, 'workflow_feature_releases', {
        id: 'release:pointer:target',
        feature_id: featureId,
        release_ref: 'feature.pointer.release',
        release_version: '2.0.0',
        release_hash: targetHash,
        status: 'staged',
        staged_at_ms: 30,
        activated_at_ms: null,
        disabled_at_ms: null,
        row_version: 0,
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_releases SET status='draining', activated_at_ms=40, row_version=1 WHERE id='release:pointer:target'`,
          )
          .run(),
      ).toThrow('feature_release_lifecycle_transition_invalid');
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_releases SET status='active', activated_at_ms=40, row_version=1 WHERE id='release:pointer:target'`,
          )
          .run(),
      ).toThrow('UNIQUE constraint failed');
      database
        .prepare(
          `UPDATE workflow_feature_releases SET status='draining', row_version=2 WHERE id='release:pointer:previous'`,
        )
        .run();
      database
        .prepare(
          `UPDATE workflow_feature_releases SET status='active', activated_at_ms=40, row_version=1 WHERE id='release:pointer:target'`,
        )
        .run();
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_releases SET release_version='rewritten' WHERE id='release:pointer:target'`,
          )
          .run(),
      ).toThrow('feature_release_identity_is_immutable');

      seedRow(database, 'workflow_feature_releases', {
        id: 'release:pointer:other-owner',
        feature_id: 'feature:other',
        release_hash: hash('release:pointer:other-owner'),
        status: 'active',
      });
      expect(() =>
        insertRow(database, 'workflow_feature_active_releases', {
          feature_id: featureId,
          release_id: 'release:pointer:other-owner',
          release_hash: hash('release:pointer:other-owner'),
          row_version: 1,
        }),
      ).toThrow('feature_active_release_insert_invalid');
      expect(() =>
        insertRow(database, 'workflow_feature_active_releases', {
          feature_id: featureId,
          release_id: 'release:pointer:target',
          release_hash: targetHash,
          row_version: 0,
        }),
      ).toThrow('ck:feature_active_releases:positive_row_version');
      insertRow(database, 'workflow_feature_active_releases', {
        feature_id: featureId,
        release_id: 'release:pointer:target',
        release_hash: targetHash,
        row_version: 1,
        activated_at_ms: 40,
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_active_releases SET row_version=2 WHERE feature_id=?`,
          )
          .run(featureId),
      ).toThrow('feature_active_release_cas_invalid');
      expect(() =>
        database
          .prepare(
            `DELETE FROM workflow_feature_active_releases WHERE feature_id=?`,
          )
          .run(featureId),
      ).toThrow('feature_active_release_delete_forbidden');

      insertRow(database, 'workflow_feature_releases', {
        id: 'release:pointer:next',
        feature_id: featureId,
        release_ref: 'feature.pointer.release',
        release_version: '3.0.0',
        release_hash: nextHash,
        status: 'staged',
        staged_at_ms: 50,
        activated_at_ms: null,
        disabled_at_ms: null,
        row_version: 0,
      });
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_active_releases SET release_id='release:pointer:next', release_hash=?, activated_at_ms=60, row_version=2 WHERE feature_id=?`,
          )
          .run(nextHash, featureId),
      ).toThrow('feature_active_release_cas_invalid');
      database
        .prepare(
          `UPDATE workflow_feature_releases SET status='draining', row_version=2 WHERE id='release:pointer:target'`,
        )
        .run();
      database
        .prepare(
          `UPDATE workflow_feature_releases SET status='active', activated_at_ms=60, row_version=1 WHERE id='release:pointer:next'`,
        )
        .run();
      database
        .prepare(
          `UPDATE workflow_feature_active_releases SET release_id='release:pointer:next', release_hash=?, activated_at_ms=60, row_version=2 WHERE feature_id=?`,
        )
        .run(nextHash, featureId);
      expect(
        database
          .prepare(
            `SELECT release_id, row_version FROM workflow_feature_active_releases WHERE feature_id=?`,
          )
          .get(featureId),
      ).toEqual({ release_id: 'release:pointer:next', row_version: 2 });
    });
  });

  it('G1.5 preserves held Retention roots for active and draining Releases without freezing later release', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const featureId = 'feature:retention';
      const releaseId = 'release:retention';
      insertRow(database, 'workflow_feature_releases', {
        id: releaseId,
        feature_id: featureId,
        release_ref: 'feature.retention.release',
        release_version: '1.0.0',
        release_hash: hash(releaseId),
        status: 'active',
        staged_at_ms: 10,
        activated_at_ms: 20,
        disabled_at_ms: null,
        row_version: 1,
      });
      insertRow(database, 'workflow_registry_retention_handles', {
        id: 'retention:published',
        handle_kind: 'published',
        feature_release_id: releaseId,
        graph_run_id: null,
        backup_id: null,
        external_actor_ref: null,
        closure_manifest_id: 'closure:retention',
        closure_hash: hash('closure:retention'),
        status: 'held',
        created_at_ms: 20,
        released_at_ms: null,
        row_version: 0,
      });
      const releaseHandle = () =>
        database
          .prepare(
            `UPDATE workflow_registry_retention_handles SET status='released', released_at_ms=50, row_version=1 WHERE id='retention:published'`,
          )
          .run();
      expect(releaseHandle).toThrow(
        'retention_handle_release_transition_invalid',
      );
      database
        .prepare(
          `UPDATE workflow_feature_releases SET status='draining', row_version=2 WHERE id=?`,
        )
        .run(releaseId);
      expect(releaseHandle).toThrow(
        'retention_handle_release_transition_invalid',
      );
      expect(() =>
        database
          .prepare(
            `DELETE FROM workflow_registry_retention_handles WHERE id='retention:published'`,
          )
          .run(),
      ).toThrow('active_or_draining_release_retention_delete_forbidden');
      database
        .prepare(
          `UPDATE workflow_feature_releases SET status='disabled', disabled_at_ms=60, row_version=3 WHERE id=?`,
        )
        .run(releaseId);
      expect(releaseHandle).not.toThrow();
      expect(
        database
          .prepare(
            `SELECT status, row_version FROM workflow_registry_retention_handles WHERE id='retention:published'`,
          )
          .get(),
      ).toEqual({ status: 'released', row_version: 1 });
    });
  });

  it('implements the complete Capacity lineage, partial uniqueness, and hash chain intent', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const configHash = hash('capacity:config');
      insertRow(database, 'runtime_capacity_admin_commands', {
        command_id: 'capacity:command:1',
        command_type: 'initialize_deployment_capacity',
        assigned_capacity_revision: 1,
        assigned_change_id: 'capacity:change:1',
        genesis_core_release_hash: hash('core:release'),
        proposed_config_hash: configHash,
        reason_code: 'initial_provisioning',
      });
      insertRow(database, 'runtime_capacity_head', {
        singleton_key: 1,
        current_capacity_revision: null,
        current_change_id: null,
        current_config_hash: null,
        current_publication_hash: null,
        pending_change_id: 'capacity:change:1',
      });
      database
        .prepare(
          `UPDATE runtime_capacity_head SET current_capacity_revision=1, current_change_id='capacity:change:1', current_config_hash=?, current_publication_hash=?, pending_change_id=NULL WHERE singleton_key=1`,
        )
        .run(configHash, hash('capacity:publication:1'));
      expect(
        database
          .prepare(
            'SELECT current_capacity_revision FROM runtime_capacity_head WHERE singleton_key=1',
          )
          .pluck()
          .get(),
      ).toBe(1);

      let previous: string | null = null;
      for (const [index, eventType] of [
        'prepared',
        'recovered',
        'recovered',
        'failed',
        'failed',
        'unauthorized_file_rejected',
        'unauthorized_file_rejected',
      ].entries()) {
        const eventHash = hash(`capacity:event:${index + 1}`);
        insertRow(database, 'runtime_capacity_change_events', {
          change_id: 'capacity:change:1',
          command_id: 'capacity:command:1',
          capacity_revision: 1,
          event_type: eventType,
          config_hash: configHash,
          publication_hash: hash('capacity:publication:1'),
          previous_event_hash: previous,
          event_hash: eventHash,
        });
        previous = eventHash;
      }
      expect(
        database
          .prepare(
            `SELECT count(*) FROM runtime_capacity_change_events WHERE event_type IN ('recovered','failed','unauthorized_file_rejected')`,
          )
          .pluck()
          .get(),
      ).toBe(6);
      expect(() =>
        insertRow(database, 'runtime_capacity_change_events', {
          change_id: 'capacity:change:1',
          command_id: 'capacity:command:1',
          capacity_revision: 1,
          event_type: 'prepared',
          config_hash: configHash,
          publication_hash: hash('capacity:publication:1'),
          previous_event_hash: previous,
          event_hash: hash('capacity:event:duplicate-milestone'),
        }),
      ).toThrow('UNIQUE constraint failed');
      expect(() =>
        database
          .prepare(
            `UPDATE runtime_capacity_change_events SET created_at_ms=created_at_ms WHERE event_seq=1`,
          )
          .run(),
      ).toThrow('capacity_event_is_immutable');
      expect(() =>
        insertRow(database, 'runtime_capacity_change_events', {
          change_id: 'capacity:change:1',
          command_id: 'capacity:command:1',
          capacity_revision: 1,
          event_type: 'recovered',
          config_hash: configHash,
          publication_hash: hash('capacity:publication:1'),
          previous_event_hash: hash('wrong-previous'),
          event_hash: hash('capacity:event:bad-chain'),
        }),
      ).toThrow('capacity_event_hash_chain_invalid');
    });
  });

  it('enforces the closed prepared Capacity Invocation shape and append-only audit', () => {
    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const requestHash = hash('capacity:prepared:request');
      insertRow(database, 'runtime_capacity_admin_commands', {
        command_id: 'capacity:prepared:command',
        command_type: 'initialize_deployment_capacity',
        assigned_capacity_revision: 1,
        assigned_change_id: 'capacity:prepared:change',
        genesis_core_release_hash: hash('capacity:prepared:core'),
        proposed_config_hash: hash('capacity:prepared:config'),
        request_hash: requestHash,
        reason_code: 'initial_provisioning',
      });
      const valid = {
        command_id: 'capacity:prepared:command',
        invocation_no: 1,
        submitted_request_hash: requestHash,
        authorization_result: 'allowed',
        execution_result: 'prepared',
        denial_code: null,
        required_permission: 'runtime.capacity.manage',
        requested_at_ms: 100,
        decided_at_ms: 100,
        applied_at_ms: null,
      };
      insertRow(database, 'runtime_capacity_admin_invocations', valid);
      for (const invalid of [
        { authorization_result: 'denied', denial_code: 'permission_denied' },
        { denial_code: 'permission_denied' },
        { applied_at_ms: 101 },
        { decided_at_ms: 99 },
      ]) {
        expect(() =>
          insertRow(database, 'runtime_capacity_admin_invocations', {
            ...valid,
            ...invalid,
          }),
        ).toThrow('CHECK constraint failed');
      }
      expect(() =>
        insertRow(database, 'runtime_capacity_admin_invocations', {
          ...valid,
          invocation_no: 2,
        }),
      ).toThrow('capacity_prepared_invocation_invalid');
      expect(() =>
        insertRow(database, 'runtime_capacity_admin_invocations', {
          ...valid,
          invocation_no: 2,
          execution_result: 'applied',
          applied_at_ms: 101,
        }),
      ).toThrow('capacity_applied_invocation_is_historical');
      for (const invalid of [
        {
          invocation_no: 2,
          execution_result: 'denied',
          authorization_result: 'denied',
          denial_code: 'permission_denied',
          decided_at_ms: 99,
        },
        {
          invocation_no: 2,
          execution_result: 'conflict',
          denial_code: 'publication_failed',
        },
        {
          invocation_no: 2,
          execution_result: 'failed',
          denial_code: 'publication_failed',
        },
      ]) {
        expect(() =>
          insertRow(database, 'runtime_capacity_admin_invocations', {
            ...valid,
            ...invalid,
          }),
        ).toThrow('capacity_terminal_invocation_invalid');
      }
      const duplicate = {
        ...valid,
        invocation_no: 2,
        execution_result: 'duplicate',
      };
      expect(() =>
        insertRow(database, 'runtime_capacity_admin_invocations', duplicate),
      ).toThrow('capacity_duplicate_invocation_invalid');
      database
        .prepare(
          `UPDATE runtime_capacity_admin_commands SET canonical_result_value_id=?, canonical_result_hash=?, finalized_at_ms=? WHERE command_id=?`,
        )
        .run(
          'capacity:prepared:canonical-result',
          hash('capacity:prepared:canonical-result'),
          101,
          valid.command_id,
        );
      expect(() =>
        insertRow(database, 'runtime_capacity_admin_invocations', {
          ...duplicate,
          submitted_request_hash: hash('capacity:prepared:other-request'),
        }),
      ).toThrow('capacity_duplicate_invocation_invalid');
      expect(() =>
        insertRow(database, 'runtime_capacity_admin_invocations', duplicate),
      ).not.toThrow();
      expect(() =>
        database
          .prepare(
            `UPDATE runtime_capacity_admin_invocations SET execution_result='applied', applied_at_ms=101 WHERE command_id=?`,
          )
          .run(valid.command_id),
      ).toThrow('capacity_invocation_is_immutable');
      expect(() =>
        database
          .prepare(
            'DELETE FROM runtime_capacity_admin_invocations WHERE command_id=?',
          )
          .run(valid.command_id),
      ).toThrow('capacity_invocation_is_immutable');
    });
  });

  it('upgrades nonempty Schema 4 Capacity Invocation data to Schema 5 without loss', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-schema4-capacity-upgrade-'),
    );
    const databasePath = path.join(root, 'workflow-runtime.db');
    const database = createMigratedDatabase(databasePath, schema4Migration.sql);
    try {
      database.pragma('foreign_keys = OFF');
      insertRow(database, 'runtime_capacity_admin_commands', {
        command_id: 'capacity:upgrade:command',
        command_type: 'initialize_deployment_capacity',
        assigned_capacity_revision: 1,
        assigned_change_id: 'capacity:upgrade:change',
        genesis_core_release_hash: hash('capacity:upgrade:core'),
        proposed_config_hash: hash('capacity:upgrade:config'),
        reason_code: 'initial_provisioning',
      });
      const results = [
        ['applied', 'allowed', null, 100, 90, 80],
        ['denied', 'denied', 'permission_denied', 100, 90, null],
        ['conflict', 'allowed', 'publication_failed', 100, 90, null],
        ['duplicate', 'allowed', 'publication_failed', 100, 90, null],
        ['failed', 'allowed', 'publication_failed', 100, 90, null],
      ] as const;
      for (const [
        index,
        [
          executionResult,
          authorizationResult,
          denialCode,
          requestedAt,
          decidedAt,
          appliedAt,
        ],
      ] of results.entries()) {
        insertRow(database, 'runtime_capacity_admin_invocations', {
          id: `capacity:upgrade:invocation:${index + 1}`,
          command_id: 'capacity:upgrade:command',
          invocation_no: index + 1,
          authorization_result: authorizationResult,
          execution_result: executionResult,
          denial_code: denialCode,
          required_permission: 'runtime.capacity.manage',
          requested_at_ms: requestedAt,
          decided_at_ms: decidedAt,
          applied_at_ms: appliedAt,
        });
      }
      const before = database
        .prepare(
          'SELECT * FROM runtime_capacity_admin_invocations ORDER BY invocation_no',
        )
        .all();
      database.pragma('foreign_keys = ON');
      database.exec('BEGIN IMMEDIATE');
      database.exec(schema4To5Upgrade.sql);
      const fresh = createMigratedDatabase(
        path.join(root, 'fresh-schema5.db'),
        schema5Migration.sql,
      );
      const expectedIdentity = calculateDatabaseSqliteSchemaIdentity(fresh);
      fresh.close();
      expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
        expectedIdentity,
      );
      database.exec('COMMIT');
      expect(database.pragma('user_version', { simple: true })).toBe(5);
      expect(
        database
          .prepare(
            'SELECT * FROM runtime_capacity_admin_invocations ORDER BY invocation_no',
          )
          .all(),
      ).toEqual(before);
      expect(
        database.pragma(
          "foreign_key_check('runtime_capacity_admin_invocations')",
        ),
      ).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='runtime_capacity_admin_invocations' ORDER BY name",
          )
          .pluck()
          .all(),
      ).toEqual([
        'idx:capacity_invocations:command_history',
        'sqlite_autoindex_runtime_capacity_admin_invocations_1',
        'uk:capacity_invocations:command_no',
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='runtime_capacity_admin_invocations' ORDER BY name",
          )
          .pluck()
          .all(),
      ).toEqual([
        'trg:capacity_invocations:applied_insert',
        'trg:capacity_invocations:duplicate_insert',
        'trg:capacity_invocations:immutable_delete',
        'trg:capacity_invocations:immutable_update',
        'trg:capacity_invocations:prepared_insert',
        'trg:capacity_invocations:terminal_insert',
      ]);
    } finally {
      if (database.open) database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('upgrades nonempty Schema 5 Values to Schema 6 and preserves every inbound FK target', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-schema5-values-upgrade-'),
    );
    const databasePath = path.join(root, 'workflow-runtime.db');
    const database = createMigratedDatabase(databasePath, schema5Migration.sql);
    const insertValue = database.prepare(
      'INSERT INTO workflow_values (id, storage_kind, inline_canonical_json, blob_hash, immutable_external_locator, expected_hash, content_hash, byte_length, media_type, schema_resource_id, schema_resource_hash, provenance_ref, retention_class, payload_state, payload_pruned_at_ms, created_at_ms, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertRegistry = database.prepare(
      'INSERT INTO workflow_registry_resources (id, resource_type, resource_id, resource_version, owner_core_ref, owner_feature_id, canonical_value_id, content_hash, publication_state, created_at_ms, published_at_ms, retired_at_ms, row_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    try {
      const parentHash = hash('schema5:value:parent');
      const childHash = hash('schema5:value:child');
      database.exec('BEGIN IMMEDIATE');
      insertValue.run(
        'schema5:value:parent',
        'inline',
        '{}',
        null,
        null,
        null,
        parentHash,
        2,
        'application/json',
        'schema5:registry:parent',
        parentHash,
        'test:schema5-upgrade',
        'workflow_audit',
        'live',
        null,
        1,
        0,
      );
      insertValue.run(
        'schema5:value:child',
        'inline',
        '{"child":true}',
        null,
        null,
        null,
        childHash,
        14,
        'application/json',
        'schema5:registry:child',
        childHash,
        'test:schema5-upgrade',
        'workflow_audit',
        'live',
        null,
        2,
        0,
      );
      insertRegistry.run(
        'schema5:registry:parent',
        'schema',
        'schema5.parent',
        '1.0.0',
        'core:test',
        null,
        'schema5:value:parent',
        parentHash,
        'published',
        1,
        1,
        null,
        0,
      );
      insertRegistry.run(
        'schema5:registry:child',
        'schema',
        'schema5.child',
        '1.0.0',
        'core:test',
        null,
        'schema5:value:child',
        childHash,
        'published',
        2,
        2,
        null,
        0,
      );
      database
        .prepare(
          'INSERT INTO workflow_value_edges (parent_value_id, child_value_id, relation_kind, member_key, member_index, child_expected_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'schema5:value:parent',
          'schema5:value:child',
          'manifest_member',
          'child',
          null,
          childHash,
          3,
        );
      database.exec('COMMIT');

      const before = database
        .prepare('SELECT * FROM workflow_values ORDER BY id')
        .all();
      const schema5Inbound = schema5Source.tables
        .flatMap((tableValue) =>
          tableValue.foreign_keys
            .filter((relation) => relation.target_table === 'workflow_values')
            .map((relation) => `${tableValue.name}:${relation.relation_id}`),
        )
        .sort();
      const schema6Inbound = schema6Source.tables
        .flatMap((tableValue) =>
          tableValue.foreign_keys
            .filter((relation) => relation.target_table === 'workflow_values')
            .map((relation) => `${tableValue.name}:${relation.relation_id}`),
        )
        .sort();
      expect(schema5Inbound.length).toBeGreaterThan(30);
      expect(schema6Inbound).toEqual(schema5Inbound);

      database.pragma('foreign_keys = OFF');
      database.exec('BEGIN IMMEDIATE');
      database.exec(schema5To6Upgrade.sql);
      expect(database.pragma('user_version', { simple: true })).toBe(6);
      expect(
        database
          .prepare(
            'SELECT id, schema_authority_kind, schema_resource_id, schema_resource_hash, schema_plan_id, generated_schema_ref FROM workflow_values ORDER BY id',
          )
          .all(),
      ).toEqual(
        before.map((row) => {
          const value = row as Record<string, unknown>;
          return {
            id: value.id,
            schema_authority_kind: 'registry',
            schema_resource_id: value.schema_resource_id,
            schema_resource_hash: value.schema_resource_hash,
            schema_plan_id: null,
            generated_schema_ref: null,
          };
        }),
      );
      expect(
        database.prepare('SELECT * FROM workflow_value_edges').all(),
      ).toHaveLength(1);
      expect(database.pragma('foreign_key_check')).toEqual([]);
      const actualInbound = source.tables.flatMap((tableValue) => {
        const rows = database.pragma(
          `foreign_key_list(${q(tableValue.name)})`,
        ) as Array<{ id: number; table: string }>;
        return [
          ...new Set(
            rows
              .filter((row) => row.table === 'workflow_values')
              .map((row) => row.id),
          ),
        ].map((id) => `${tableValue.name}:${id}`);
      });
      expect(actualInbound).toHaveLength(schema5Inbound.length);
      expect(
        database
          .prepare(
            "SELECT count(*) FROM sqlite_schema WHERE sql LIKE '%workflow_values_schema6%'",
          )
          .pluck()
          .get(),
      ).toBe(0);
      const fresh = createMigratedDatabase(
        path.join(root, 'fresh-schema6.db'),
        schema6Migration.sql,
      );
      const freshIdentity = calculateDatabaseSqliteSchemaIdentity(fresh);
      fresh.close();
      expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
        freshIdentity,
      );
      database.exec('COMMIT');
      database.pragma('foreign_keys = ON');
    } finally {
      if (database.inTransaction) database.exec('ROLLBACK');
      if (database.open) database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('upgrades nonempty Schema 6 authority rows to Schema 7 and rolls faults back byte-exactly', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-schema6-envelope-upgrade-'),
    );
    const databasePath = path.join(root, 'workflow-runtime.db');
    const database = createMigratedDatabase(databasePath, schema6Migration.sql);
    try {
      database.pragma('foreign_keys = OFF');
      const planHash = hash('schema6:plan');
      const schemaRawHash = hash('schema6:raw-schema');
      const schemaRef = `icarus-generated-schema:${schemaRawHash}`;
      const schemaHash = hash('schema6:domain-schema');
      const parameterHash = hash('schema6:parameter');
      database
        .prepare(
          `INSERT INTO workflow_graph_scope_plans (
             id, graph_run_id, plan_hash, format, compiler_version,
             source_json, source_value_id, source_hash, compiled_plan_json,
             compiled_plan_value_id, interface_snapshot_json,
             interface_snapshot_hash, policy_snapshot_json,
             policy_snapshot_hash, capability_catalog_hash, created_at_ms
           ) VALUES (?, ?, ?, 'icarus.workflow-graph-scope-plan/2', '3.0.3',
                     NULL, NULL, NULL, '{}', NULL, '{}', ?, '{}', ?, ?, 1)`,
        )
        .run(
          'schema6:plan',
          'schema6:run',
          planHash,
          hash('schema6:interface'),
          hash('schema6:policy'),
          hash('schema6:catalog'),
        );
      database
        .prepare(
          `INSERT INTO workflow_generated_schema_contents
           VALUES (?, ?, ?, '{}', 'RFC8785-JCS', 2, 1)`,
        )
        .run(schemaRef, schemaRawHash, schemaHash);
      database
        .prepare(
          `INSERT INTO workflow_plan_generated_schemas
           VALUES (?, ?, ?, ?, ?, 'join_expose', ?, ?, 1)`,
        )
        .run(
          'schema6:plan',
          'schema6:run',
          planHash,
          schemaRef,
          schemaHash,
          parameterHash,
          hash('schema6:binding'),
        );
      database
        .prepare(
          `INSERT INTO workflow_values (
             id, storage_kind, inline_canonical_json, blob_hash,
             immutable_external_locator, expected_hash, content_hash,
             byte_length, media_type, schema_resource_id,
             schema_resource_hash, provenance_ref, retention_class,
             payload_state, payload_pruned_at_ms, created_at_ms, row_version,
             schema_authority_kind, schema_plan_id, schema_plan_hash,
             generated_schema_ref, generated_schema_hash,
             generated_schema_generator, generated_schema_parameter_hash
           ) VALUES (
             'schema6:value:registry', 'inline', '{}', NULL, NULL, NULL, ?, 2,
             'application/json', 'schema6:registry', ?, 'schema6:provenance',
             'run_recovery', 'live', NULL, 1, 0, 'registry', NULL, NULL, NULL,
             NULL, NULL, NULL
           ), (
             'schema6:value:generated', 'inline', '{}', NULL, NULL, NULL, ?, 2,
             'application/json', NULL, NULL, 'schema6:provenance',
             'run_recovery', 'live', NULL, 1, 0, 'plan_generated', ?, ?, ?, ?,
             'join_expose', ?
           )`,
        )
        .run(
          hash('schema6:registry-value'),
          hash('schema6:registry'),
          hash('schema6:generated-value'),
          'schema6:plan',
          planHash,
          schemaRef,
          schemaHash,
          parameterHash,
        );
      database
        .prepare(
          `INSERT INTO workflow_value_ownerships
           VALUES ('schema6:value:generated', NULL, 'schema6:run', NULL, NULL,
                   NULL, 1)`,
        )
        .run();
      expect(() =>
        database
          .prepare(
            `INSERT INTO workflow_plan_generated_schemas
             VALUES ('schema6:new', 'schema6:run', ?, ?, ?,
                     'node_output_envelope', ?, ?, 1)`,
          )
          .run(
            planHash,
            schemaRef,
            schemaHash,
            hash('schema6:new-parameter'),
            hash('schema6:new-binding'),
          ),
      ).toThrow('CHECK constraint failed');

      const beforeValues = database
        .prepare('SELECT * FROM workflow_values ORDER BY id')
        .all();
      const beforeBindings = database
        .prepare(
          'SELECT * FROM workflow_plan_generated_schemas ORDER BY plan_id',
        )
        .all();
      const beforeOwnership = database
        .prepare('SELECT * FROM workflow_value_ownerships ORDER BY value_id')
        .all();
      database.exec('BEGIN IMMEDIATE');
      database.exec(schema6To7Upgrade.sql);
      expect(database.pragma('user_version', { simple: true })).toBe(7);
      expect(
        database.prepare('SELECT * FROM workflow_values ORDER BY id').all(),
      ).toEqual(beforeValues);
      expect(
        database
          .prepare(
            'SELECT * FROM workflow_plan_generated_schemas ORDER BY plan_id',
          )
          .all(),
      ).toEqual(beforeBindings);
      expect(
        database
          .prepare('SELECT * FROM workflow_value_ownerships ORDER BY value_id')
          .all(),
      ).toEqual(beforeOwnership);
      database
        .prepare(
          `INSERT INTO workflow_plan_generated_schemas
           VALUES ('schema7:new', 'schema6:run', ?, ?, ?,
                   'node_output_envelope', ?, ?, 1)`,
        )
        .run(
          planHash,
          schemaRef,
          schemaHash,
          hash('schema7:new-parameter'),
          hash('schema7:new-binding'),
        );
      database.exec('COMMIT');
      const fresh = createMigratedDatabase(
        path.join(root, 'fresh-schema7.db'),
        schema7Migration.sql,
      );
      expect(calculateDatabaseSqliteSchemaIdentity(database)).toBe(
        calculateDatabaseSqliteSchemaIdentity(fresh),
      );
      fresh.close();

      const fkDatabase = createMigratedDatabase(
        path.join(root, 'fk-schema7.db'),
        schema7Migration.sql,
      );
      try {
        expect(() =>
          fkDatabase
            .prepare(
              `INSERT INTO workflow_plan_generated_schemas
               VALUES ('missing', 'missing', ?, ?, ?,
                       'node_output_envelope', ?, ?, 1)`,
            )
            .run(
              hash('missing-plan'),
              `icarus-generated-schema:${hash('missing-raw')}`,
              hash('missing-schema'),
              hash('missing-parameter'),
              hash('missing-binding'),
            ),
        ).toThrow('FOREIGN KEY constraint failed');
        fkDatabase.pragma('foreign_keys = OFF');
        expect(() =>
          insertRow(fkDatabase, 'workflow_values', {
            schema_authority_kind: 'plan_generated',
            schema_resource_id: 'forbidden-registry',
            schema_resource_hash: hash('forbidden-registry'),
            schema_plan_id: 'plan',
            schema_plan_hash: hash('plan'),
            generated_schema_ref: `icarus-generated-schema:${hash('raw')}`,
            generated_schema_hash: hash('schema'),
            generated_schema_generator: 'node_output_envelope',
            generated_schema_parameter_hash: hash('parameter'),
          }),
        ).toThrow('CHECK constraint failed');
      } finally {
        fkDatabase.close();
      }

      const faultPath = path.join(root, 'fault-schema6.db');
      const faultDatabase = createMigratedDatabase(
        faultPath,
        schema6Migration.sql,
      );
      try {
        const beforeIdentity =
          calculateDatabaseSqliteSchemaIdentity(faultDatabase);
        const faultSql = schema6To7Upgrade.sql.replace(
          'DROP TABLE "workflow_values_schema6";',
          'SELECT * FROM "missing_schema7_fault";\n\nDROP TABLE "workflow_values_schema6";',
        );
        faultDatabase.pragma('foreign_keys = OFF');
        faultDatabase.exec('BEGIN IMMEDIATE');
        expect(() => faultDatabase.exec(faultSql)).toThrow(
          'missing_schema7_fault',
        );
        faultDatabase.exec('ROLLBACK');
        expect(faultDatabase.pragma('user_version', { simple: true })).toBe(6);
        expect(calculateDatabaseSqliteSchemaIdentity(faultDatabase)).toBe(
          beforeIdentity,
        );
        expect(
          faultDatabase
            .prepare(
              "SELECT count(*) FROM sqlite_schema WHERE name LIKE '%_schema6'",
            )
            .pluck()
            .get(),
        ).toBe(0);
      } finally {
        faultDatabase.close();
      }
    } finally {
      if (database.inTransaction) database.exec('ROLLBACK');
      if (database.open) database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('enforces Registry or exact Plan-generated Value authority with real FKs and CHECKs', () => {
    withDatabase((database) => {
      const validValue = {
        storage_kind: 'inline',
        inline_canonical_json: '{}',
      };
      expect(() =>
        insertRow(database, 'workflow_values', {
          ...validValue,
          schema_resource_id: 'missing:registry',
          schema_resource_hash: hash('missing:registry'),
        }),
      ).toThrow('FOREIGN KEY constraint failed');

      const parameters: JsonObject = {
        node_id: 'join',
        output_port: 'renamed',
        input_port: 'source',
        required: true,
      };
      const authority = buildGeneratedSchema('join_expose', parameters, {
        type: 'string',
      });
      const binding = buildPlanGeneratedSchemaBinding(
        {
          plan_id: 'plan:generated',
          graph_run_id: 'run:generated',
          plan_hash: hash('plan:generated') as `sha256:${string}`,
        },
        authority,
      );
      database.pragma('foreign_keys = OFF');
      expect(() =>
        database
          .prepare(
            'INSERT INTO workflow_generated_schema_contents (schema_ref, schema_raw_hash, schema_hash, canonical_schema_json, canonicalizer, byte_length, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            String(authority.schema_ref).replace(
              'icarus-generated-schema:',
              'unknown:',
            ),
            authority.schema_raw_hash,
            authority.schema_hash,
            canonicalJson(authority.schema_json),
            authority.canonicalizer,
            authority.schema_byte_length,
            1,
          ),
      ).toThrow('ck:generated_schema_contents:ref');
      database
        .prepare(
          'INSERT INTO workflow_generated_schema_contents (schema_ref, schema_raw_hash, schema_hash, canonical_schema_json, canonicalizer, byte_length, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          authority.schema_ref,
          authority.schema_raw_hash,
          authority.schema_hash,
          canonicalJson(authority.schema_json),
          authority.canonicalizer,
          authority.schema_byte_length,
          1,
        );
      database
        .prepare(
          'INSERT INTO workflow_plan_generated_schemas (plan_id, graph_run_id, plan_hash, schema_ref, schema_hash, generator, parameter_hash, binding_hash, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          binding.plan_id,
          binding.graph_run_id,
          binding.plan_hash,
          binding.schema_ref,
          binding.schema_hash,
          binding.generator,
          binding.parameter_hash,
          binding.binding_hash,
          1,
        );
      database.pragma('foreign_keys = ON');
      const generatedValue = {
        ...validValue,
        schema_authority_kind: 'plan_generated',
        schema_resource_id: null,
        schema_resource_hash: null,
        schema_plan_id: binding.plan_id as string,
        schema_plan_hash: binding.plan_hash as string,
        generated_schema_ref: binding.schema_ref as string,
        generated_schema_hash: binding.schema_hash as string,
        generated_schema_generator: binding.generator as string,
        generated_schema_parameter_hash: binding.parameter_hash as string,
      };
      expect(() =>
        insertRow(database, 'workflow_values', generatedValue),
      ).not.toThrow();
      expect(() =>
        insertRow(database, 'workflow_values', {
          ...generatedValue,
          generated_schema_parameter_hash: hash('wrong:parameter'),
        }),
      ).toThrow('FOREIGN KEY constraint failed');

      database.pragma('foreign_keys = OFF');
      expect(() =>
        insertRow(database, 'workflow_values', {
          ...generatedValue,
          schema_resource_id: 'registry:forbidden',
          schema_resource_hash: hash('registry:forbidden'),
        }),
      ).toThrow('ck:values:schema_authority_shape');
      expect(() =>
        insertRow(database, 'workflow_values', {
          ...validValue,
          schema_authority_kind: 'registry',
          schema_resource_id: null,
          schema_resource_hash: null,
        }),
      ).toThrow('ck:values:schema_authority_shape');
    });
  });

  it('rolls back the Schema 4 to 5 rebuild when legacy data violates the new closed shape', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-schema4-capacity-fault-'),
    );
    const databasePath = path.join(root, 'workflow-runtime.db');
    const database = createMigratedDatabase(databasePath, schema4Migration.sql);
    try {
      database.pragma('foreign_keys = OFF');
      insertRow(database, 'runtime_capacity_admin_commands', {
        command_id: 'capacity:fault:command',
        command_type: 'initialize_deployment_capacity',
        assigned_capacity_revision: 1,
        assigned_change_id: 'capacity:fault:change',
        genesis_core_release_hash: hash('capacity:fault:core'),
        proposed_config_hash: hash('capacity:fault:config'),
        reason_code: 'initial_provisioning',
      });
      database.pragma('ignore_check_constraints = ON');
      insertRow(database, 'runtime_capacity_admin_invocations', {
        command_id: 'capacity:fault:command',
        invocation_no: 1,
        authorization_result: 'denied',
        execution_result: 'failed',
        denial_code: null,
        requested_at_ms: 100,
        decided_at_ms: 100,
        applied_at_ms: null,
      });
      database.pragma('ignore_check_constraints = OFF');
      database.exec('BEGIN IMMEDIATE');
      expect(() => database.exec(schema4To5Upgrade.sql)).toThrow(
        'CHECK constraint failed',
      );
      database.exec('ROLLBACK');
      expect(database.pragma('user_version', { simple: true })).toBe(4);
      expect(
        database
          .prepare('SELECT count(*) FROM runtime_capacity_admin_invocations')
          .pluck()
          .get(),
      ).toBe(1);
      expect(
        database
          .prepare(
            "SELECT count(*) FROM sqlite_schema WHERE name='runtime_capacity_admin_invocations_schema4'",
          )
          .pluck()
          .get(),
      ).toBe(0);
    } finally {
      if (database.inTransaction) database.exec('ROLLBACK');
      if (database.open) database.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
