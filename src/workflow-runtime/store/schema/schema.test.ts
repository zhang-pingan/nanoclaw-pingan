import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { calculateArtifactHash } from '../../contracts/hash.js';
import type { LogicalTableMetadata } from '../../contracts/logical-schema-types.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
} from '../../contracts/types.js';
import { buildG1Artifacts, checkG1Artifacts } from './artifacts.js';
import {
  assertClosedSchemaDependencyManifest,
  buildSchemaDependencyManifestArtifact,
  calculatePhysicalSchemaIdentity,
  verifySchemaDependencyManifestArtifact,
} from './dependencies.js';
import { buildQueryFixtures, renderMigration } from './ddl.js';
import {
  assertClosedSchemaManifest,
  reconstructSchemaManifest,
} from './manifest.js';
import { loadExecutableSchemaSource } from './source.js';
import {
  createMigratedDatabase,
  verifyQueryPlans,
  verifyReadOnlyConnection,
} from './sqlite-gate.js';
import type {
  G1SchemaDependencyManifestPayload,
  WorkflowRuntimeSchemaManifestPayload,
} from './types.js';

const source = loadExecutableSchemaSource();
const migration = renderMigration(source);

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hash(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
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
    const payload = built.dependencyManifest
      .payload as unknown as G1SchemaDependencyManifestPayload;
    expect(() => assertClosedSchemaDependencyManifest(payload)).not.toThrow();
    expect(payload).toMatchObject({
      member_count: 10,
      physical_member_count: 9,
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
      'sqlite_execution_profile',
      'schema_manifest',
      'canonical_migration',
    ]);
    expect(payload.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'canonical_migration',
          semantic_hash:
            'sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345',
          raw_sha256:
            'sha256:eea3547a0f5208d08bfbe771de3895bba020ca3cf34ddf2fb4e3b7945765d345',
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
  });

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
        ),
      ).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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
          const checkId = `ck:${metadata.name}:${column.name}:enum`;
          expect(() =>
            insertRow(database, metadata.name, {
              [column.name]: '__invalid_closed_enum__',
            }),
          ).toThrow(checkId);
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
        created_at_ms: 1000,
      });
      expect(() =>
        seedRow(database, 'workflow_runtime_command_confirmations', {
          id: 'confirmation:bad',
          request_command_id: 'command:ttl',
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

  it('G1.5 constrains Activation idempotency, typed bindings, terminalization, and audit chains', () => {
    const commandMetadata = table(
      'workflow_feature_release_activation_commands',
    );
    expect(commandMetadata.foreign_keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation_id: 'fk:activation_commands:request_value',
          target_table: 'workflow_values',
          target_columns: [
            'id',
            'content_hash',
            'schema_resource_id',
            'schema_resource_hash',
          ],
        }),
        expect.objectContaining({
          relation_id: 'fk:activation_commands:target_release_owner',
          source_columns: [
            'feature_id',
            'target_feature_release_id',
            'target_feature_release_hash',
          ],
          target_columns: ['feature_id', 'id', 'release_hash'],
        }),
        expect.objectContaining({
          relation_id: 'fk:activation_commands:target_retention',
          target_table: 'workflow_registry_retention_handles',
          target_columns: [
            'id',
            'handle_kind',
            'feature_release_id',
            'closure_manifest_id',
            'closure_hash',
          ],
        }),
      ]),
    );
    expect(
      buildQueryFixtures(source)
        .filter((fixture) => fixture.query_id.startsWith('activation_'))
        .map((fixture) => fixture.required_index_id),
    ).toEqual([
      'idx:activation_commands:idempotency',
      'idx:activation_invocations:command_history',
      'idx:activation_events:command_history',
      'idx:activation_commands:pending_recovery',
      'idx:feature_active_releases:activation_cas',
      'idx:feature_releases:activation_preflight',
      'idx:retention_handles:activation_preflight',
    ]);

    withDatabase((database) => {
      database.pragma('foreign_keys = OFF');
      const featureId = 'feature:activation';
      const targetId = 'release:activation:target';
      const targetRef = 'feature.activation.release';
      const targetVersion = '1.0.0';
      const targetHash = hash(targetId);
      const closureId = 'closure:activation:target';
      const closureHash = hash(closureId);
      const retentionId = 'retention:activation:target';
      seedRow(database, 'workflow_feature_releases', {
        id: targetId,
        feature_id: featureId,
        release_ref: targetRef,
        release_version: targetVersion,
        release_hash: targetHash,
        status: 'staged',
        staged_at_ms: 10,
        activated_at_ms: null,
        disabled_at_ms: null,
        row_version: 0,
      });
      seedRow(database, 'workflow_registry_retention_handles', {
        id: retentionId,
        handle_kind: 'published',
        feature_release_id: targetId,
        graph_run_id: null,
        backup_id: null,
        external_actor_ref: null,
        closure_manifest_id: closureId,
        closure_hash: closureHash,
        status: 'held',
        released_at_ms: null,
        row_version: 0,
      });
      const domainRequestHash = hash('activation:domain-request');
      const commandBindings = {
        command_type: 'activate_feature_release',
        idempotency_domain: 'feature-release-activation',
        domain_request_hash: domainRequestHash,
        feature_id: featureId,
        target_feature_release_id: targetId,
        target_feature_release_ref: targetRef,
        target_feature_release_version: targetVersion,
        target_feature_release_hash: targetHash,
        expected_pointer_state: 'absent',
        expected_pointer_row_version: null,
        previous_feature_release_id: null,
        previous_feature_release_ref: null,
        previous_feature_release_version: null,
        previous_feature_release_hash: null,
        target_retention_handle_id: retentionId,
        target_retention_handle_kind: 'published',
        target_retention_closure_manifest_id: closureId,
        target_retention_closure_hash: closureHash,
        target_retention_observed_status: 'held',
        target_retention_observed_row_version: 0,
        previous_retention_handle_id: null,
        previous_retention_handle_kind: null,
        previous_retention_closure_manifest_id: null,
        previous_retention_closure_hash: null,
        previous_retention_observed_status: null,
        previous_retention_observed_row_version: null,
        created_at_ms: 20,
        row_version: 0,
      };
      insertRow(database, 'workflow_feature_release_activation_commands', {
        ...commandBindings,
        command_id: 'activation:command:failed',
        idempotency_key: 'activation:key:failed',
      });
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_commands', {
          ...commandBindings,
          command_id: 'activation:command:duplicate-key',
          idempotency_key: 'activation:key:failed',
        }),
      ).toThrow('UNIQUE constraint failed');
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_commands', {
          ...commandBindings,
          command_id: 'activation:command:bad-present',
          idempotency_key: 'activation:key:bad-present',
          expected_pointer_state: 'present',
        }),
      ).toThrow('ck:activation_commands:expected_pointer_shape');
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands SET lifecycle='failed', finalized_at_ms=30, row_version=1 WHERE command_id='activation:command:failed'`,
        )
        .run();
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_release_activation_commands SET lifecycle='applied', row_version=2 WHERE command_id='activation:command:failed'`,
          )
          .run(),
      ).toThrow('activation_command_lifecycle_transition_invalid');

      const invocationHash1 = hash('activation:invocation:1');
      insertRow(database, 'workflow_feature_release_activation_invocations', {
        id: 'activation:invocation:1',
        command_id: 'activation:command:failed',
        invocation_no: 1,
        command_domain_request_hash: domainRequestHash,
        submitted_request_hash: domainRequestHash,
        disposition: 'failed',
        previous_invocation_hash: null,
        invocation_hash: invocationHash1,
      });
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_invocations', {
          id: 'activation:invocation:2:bad-chain',
          command_id: 'activation:command:failed',
          invocation_no: 2,
          command_domain_request_hash: domainRequestHash,
          submitted_request_hash: domainRequestHash,
          disposition: 'duplicate',
          previous_invocation_hash: hash('activation:wrong-previous'),
          invocation_hash: hash('activation:invocation:2:bad-chain'),
        }),
      ).toThrow('activation_invocation_hash_chain_invalid');
      expect(() =>
        database
          .prepare(
            `UPDATE workflow_feature_release_activation_invocations SET decided_at_ms=decided_at_ms WHERE id='activation:invocation:1'`,
          )
          .run(),
      ).toThrow('activation_invocation_is_immutable');

      const eventIdentity = {
        command_id: 'activation:command:failed',
        attempt_no: 1,
        feature_id: featureId,
        target_feature_release_id: targetId,
        target_feature_release_ref: targetRef,
        target_feature_release_version: targetVersion,
        target_feature_release_hash: targetHash,
        previous_feature_release_id: null,
        previous_feature_release_ref: null,
        previous_feature_release_version: null,
        previous_feature_release_hash: null,
      };
      const eventHash1 = hash('activation:event:1');
      insertRow(database, 'workflow_feature_release_activation_events', {
        ...eventIdentity,
        event_no: 1,
        phase: 'authenticate',
        event_type: 'attempt_started',
        previous_event_hash: null,
        event_hash: eventHash1,
      });
      expect(() =>
        insertRow(database, 'workflow_feature_release_activation_events', {
          ...eventIdentity,
          event_no: 2,
          phase: 'validate',
          event_type: 'phase_succeeded',
          previous_event_hash: hash('activation:event:wrong'),
          event_hash: hash('activation:event:2:wrong'),
        }),
      ).toThrow('activation_event_hash_chain_invalid');
      insertRow(database, 'workflow_feature_release_activation_events', {
        ...eventIdentity,
        event_no: 2,
        phase: 'validate',
        event_type: 'phase_succeeded',
        previous_event_hash: eventHash1,
        event_hash: hash('activation:event:2'),
      });
      expect(() =>
        database
          .prepare(
            `DELETE FROM workflow_feature_release_activation_events WHERE command_id='activation:command:failed' AND event_no=2`,
          )
          .run(),
      ).toThrow('activation_event_is_immutable');

      insertRow(database, 'workflow_feature_release_activation_commands', {
        ...commandBindings,
        command_id: 'activation:command:applied',
        idempotency_key: 'activation:key:applied',
      });
      database
        .prepare(
          `UPDATE workflow_feature_releases SET status='active', activated_at_ms=40, row_version=1 WHERE id=?`,
        )
        .run(targetId);
      insertRow(database, 'workflow_feature_active_releases', {
        feature_id: featureId,
        release_id: targetId,
        release_hash: targetHash,
        row_version: 1,
        activated_at_ms: 40,
      });
      database
        .prepare(
          `UPDATE workflow_feature_release_activation_commands SET applied_pointer_row_version=1, canonical_receipt_value_id='activation:receipt', canonical_receipt_hash=?, canonical_receipt_schema_resource_id='activation:receipt:schema', canonical_receipt_schema_hash=?, lifecycle='applied', finalized_at_ms=50, row_version=1 WHERE command_id='activation:command:applied'`,
        )
        .run(hash('activation:receipt'), hash('activation:receipt:schema'));
      expect(
        database
          .prepare(
            `SELECT lifecycle, applied_pointer_row_version, row_version FROM workflow_feature_release_activation_commands WHERE command_id='activation:command:applied'`,
          )
          .get(),
      ).toEqual({
        lifecycle: 'applied',
        applied_pointer_row_version: 1,
        row_version: 1,
      });
    });
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
});
