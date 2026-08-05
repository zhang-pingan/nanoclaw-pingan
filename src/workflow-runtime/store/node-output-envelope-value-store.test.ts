import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildNodeOutputEnvelopeSchema,
  NODE_OUTPUT_ENVELOPE_DOMAIN,
  nodeOutputPortContractHash,
} from '../contracts/generated-schema-authority.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from './runtime-store/index.js';
import {
  NodeOutputEnvelopeAuthorityError,
  NodeOutputEnvelopeValueStore,
  nodeOutputMemberProvenanceRef,
  type NodeOutputEnvelopeFaultStage,
} from './node-output-envelope-value-store.js';

const roots: string[] = [];
const PLAN_ID = 'plan:node-output';
const RUN_ID = 'run:node-output';
const NODE_ID = 'node:single';
const VALUE_ID = 'value:envelope';
const STRING_SCHEMA_HASH = hash('schema:string');

function hash(label: string): Sha256Hash {
  return domainSeparatedSha256('icarus:node-output-envelope-test:1\n', {
    label,
  });
}

const stringPortSchema = {
  type: 'registry',
  ref: { id: 'schema.string', version: '1.0.0' },
  schema_hash: STRING_SCHEMA_HASH,
} as const;

function outputPorts(overrides: JsonObject = {}): JsonObject {
  return {
    result: {
      schema: stringPortSchema,
      max_bytes: 32,
      required: true,
    },
    ...overrides,
  };
}

function plan(ports: JsonObject): { value: JsonObject; hash: Sha256Hash } {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-graph-scope-plan/2',
    compiler_version: '3.0.4',
    nodes: [
      {
        id: NODE_ID,
        output_ports: ports,
        output_envelope_schema: buildNodeOutputEnvelopeSchema(NODE_ID, ports),
      },
    ],
  };
  const planHash = domainSeparatedSha256(
    'icarus:workflow-graph-plan:2\n',
    withoutHash,
  );
  return { value: { ...withoutHash, plan_hash: planHash }, hash: planHash };
}

class TestTransaction implements WorkflowRuntimeWriteTransaction {
  readonly transactionKind = 'immediate' as const;
  constructor(private readonly database: Database.Database) {}
  execute(sql: string, parameters: readonly WorkflowRuntimeSqlValue[]) {
    const result = this.database.prepare(sql).run(...parameters);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }
  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[] {
    return this.database.prepare(sql).all(...parameters) as T[];
  }
  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined {
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }
}

class TestStore {
  constructor(readonly database: Database.Database) {}
  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[] {
    return this.database.prepare(sql).all(...parameters) as T[];
  }
  queryOne<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined {
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }
  withImmediateTransaction<T>(
    callback: (transaction: WorkflowRuntimeWriteTransaction) => T,
  ): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback(new TestTransaction(this.database));
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.inTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function createAuthorityDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE workflow_graph_scope_plans (
      id TEXT PRIMARY KEY,
      graph_run_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      format TEXT NOT NULL,
      compiler_version TEXT NOT NULL,
      compiled_plan_json TEXT
    );
    CREATE TABLE workflow_generated_schema_contents (
      schema_ref TEXT PRIMARY KEY,
      schema_raw_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      canonical_schema_json TEXT NOT NULL,
      canonicalizer TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (schema_ref, schema_hash)
    );
    CREATE TABLE workflow_plan_generated_schemas (
      plan_id TEXT NOT NULL,
      graph_run_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      schema_ref TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      generator TEXT NOT NULL CHECK (generator IN (
        'join_expose', 'child_completion', 'map_result', 'node_output_envelope'
      )),
      parameter_hash TEXT NOT NULL,
      binding_hash TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (plan_id, schema_ref, generator, parameter_hash)
    );
    CREATE TABLE workflow_values (
      id TEXT PRIMARY KEY,
      storage_kind TEXT NOT NULL,
      inline_canonical_json TEXT,
      blob_hash TEXT,
      immutable_external_locator TEXT,
      expected_hash TEXT,
      content_hash TEXT NOT NULL,
      byte_length INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      schema_resource_id TEXT,
      schema_resource_hash TEXT,
      provenance_ref TEXT NOT NULL,
      retention_class TEXT NOT NULL,
      payload_state TEXT NOT NULL,
      payload_pruned_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      row_version INTEGER NOT NULL,
      schema_authority_kind TEXT NOT NULL,
      schema_plan_id TEXT,
      schema_plan_hash TEXT,
      generated_schema_ref TEXT,
      generated_schema_hash TEXT,
      generated_schema_generator TEXT CHECK (
        generated_schema_generator IS NULL OR generated_schema_generator IN (
          'join_expose', 'child_completion', 'map_result', 'node_output_envelope'
        )
      ),
      generated_schema_parameter_hash TEXT
    );
    CREATE TABLE workflow_value_ownerships (
      value_id TEXT PRIMARY KEY,
      owner_workflow_id TEXT,
      owner_graph_run_id TEXT,
      owner_registry_resource_id TEXT,
      owner_feature_release_id TEXT,
      system_owner_ref TEXT,
      created_at_ms INTEGER NOT NULL
    );
  `);
  return database;
}

function fixture(customPorts = outputPorts()): {
  root: string;
  databasePath: string;
  database: Database.Database;
  store: TestStore;
  boundary: NodeOutputEnvelopeValueStore;
  planHash: Sha256Hash;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-envelope-store-'));
  roots.push(root);
  const databasePath = path.join(root, 'workflow-runtime.db');
  const database = createAuthorityDatabase(databasePath);
  const sealed = plan(customPorts);
  database
    .prepare(
      `INSERT INTO workflow_graph_scope_plans
       (id, graph_run_id, plan_hash, format, compiler_version, compiled_plan_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      PLAN_ID,
      RUN_ID,
      sealed.hash,
      'icarus.workflow-graph-scope-plan/2',
      '3.0.4',
      canonicalJson(sealed.value),
    );
  const store = new TestStore(database);
  return {
    root,
    databasePath,
    database,
    store,
    boundary: new NodeOutputEnvelopeValueStore(
      store as unknown as WorkflowRuntimeStore,
    ),
    planHash: sealed.hash,
  };
}

function seedStringMember(
  database: Database.Database,
  planHash: Sha256Hash,
  portName = 'result',
  valueRef = 'value:member',
  value = 'hello',
): { valueRef: string; valueHash: Sha256Hash; byteLength: number } {
  const bytes = canonicalJson(value);
  const valueHash = hash(`member:${valueRef}:${bytes}`);
  const byteLength = Buffer.byteLength(bytes, 'utf8');
  const provenance = nodeOutputMemberProvenanceRef({
    planId: PLAN_ID,
    graphRunId: RUN_ID,
    planHash,
    nodeId: NODE_ID,
    portName,
    valueRef,
    valueHash,
    schemaHash: STRING_SCHEMA_HASH,
    byteLength,
  });
  database
    .prepare(
      `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, blob_hash,
         immutable_external_locator, expected_hash, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
         row_version, schema_authority_kind, schema_plan_id, schema_plan_hash,
         generated_schema_ref, generated_schema_hash,
         generated_schema_generator, generated_schema_parameter_hash
       ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
                 'schema:string', ?, ?, 'run_recovery', 'live', NULL, 1, 0,
                 'registry', NULL, NULL, NULL, NULL, NULL, NULL)`,
    )
    .run(
      valueRef,
      bytes,
      valueHash,
      byteLength,
      STRING_SCHEMA_HASH,
      provenance,
    );
  database
    .prepare(
      `INSERT INTO workflow_value_ownerships
       VALUES (?, NULL, ?, NULL, NULL, NULL, 1)`,
    )
    .run(valueRef, RUN_ID);
  return { valueRef, valueHash, byteLength };
}

function present(member: {
  valueRef: string;
  valueHash: Sha256Hash;
  byteLength: number;
}): JsonObject {
  return {
    state: 'present',
    value_ref: member.valueRef,
    value_hash: member.valueHash,
    schema_hash: STRING_SCHEMA_HASH,
    byte_length: member.byteLength,
  };
}

function writeInput(
  planHash: Sha256Hash,
  ports: JsonObject,
  faultAt?: NodeOutputEnvelopeFaultStage,
) {
  return {
    planId: PLAN_ID,
    graphRunId: RUN_ID,
    planHash,
    nodeId: NODE_ID,
    valueId: VALUE_ID,
    ports,
    createdAtMs: 10,
    ...(faultAt ? { faultAt } : {}),
  } as const;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('canonical NodeOutputEnvelope Stored Value authority', () => {
  it('publishes a real closed Draft 2020-12 present/absent schema', () => {
    const ports = outputPorts({
      optional: {
        schema: stringPortSchema,
        max_bytes: 8,
        required: false,
      },
    });
    const descriptor = buildNodeOutputEnvelopeSchema(NODE_ID, ports);
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
      descriptor.schema_json as AnySchema,
    );
    const portContractHash = nodeOutputPortContractHash(ports);
    const portValues: JsonObject = {
      result: {
        state: 'present',
        value_ref: 'value:result',
        value_hash: hash('result'),
        schema_hash: STRING_SCHEMA_HASH,
        byte_length: 7,
      },
      optional: { state: 'absent', schema_hash: STRING_SCHEMA_HASH },
    };
    const envelopeHash = domainSeparatedSha256(NODE_OUTPUT_ENVELOPE_DOMAIN, {
      port_contract_hash: portContractHash,
      ports: portValues,
    });
    const value = {
      port_contract_hash: portContractHash,
      ports: portValues,
      envelope_hash: envelopeHash,
    };
    expect(validate(value)).toBe(true);
    for (const invalid of [
      { ...value, unknown: true },
      { ...value, ports: { optional: portValues.optional } },
      { ...value, ports: { ...portValues, renamed: portValues.result } },
      {
        ...value,
        ports: {
          ...portValues,
          result: { state: 'absent', schema_hash: STRING_SCHEMA_HASH },
        },
      },
      {
        ...value,
        ports: {
          ...portValues,
          optional: { state: 'absent', schema_hash: hash('wrong-schema') },
        },
      },
      {
        ...value,
        ports: {
          ...portValues,
          optional: {
            state: 'present',
            value_ref: 'value:optional',
            value_hash: hash('optional'),
            schema_hash: STRING_SCHEMA_HASH,
            byte_length: 9,
          },
        },
      },
    ]) {
      expect(validate(invalid)).toBe(false);
    }
  });

  it('writes, reads, exactly replays, reopens, and recovery-scans one string port', () => {
    const test = fixture();
    const member = seedStringMember(test.database, test.planHash);
    const input = writeInput(test.planHash, { result: present(member) });
    const written = test.boundary.write(input);
    expect(written.content).toEqual({
      port_contract_hash: nodeOutputPortContractHash(outputPorts()),
      ports: input.ports,
      envelope_hash: written.envelopeHash,
    });
    expect(test.boundary.write(input)).toEqual(written);
    expect(test.boundary.read(input)).toEqual(written);
    test.database.close();

    const reopenedDatabase = new Database(test.databasePath);
    const reopenedStore = new TestStore(reopenedDatabase);
    const reopened = new NodeOutputEnvelopeValueStore(
      reopenedStore as unknown as WorkflowRuntimeStore,
    );
    expect(reopened.verifyReopenAndRecovery()).toEqual([written]);
    reopenedDatabase.close();
  });

  it('enforces optional/default/list/rename as the exact compiled port set', () => {
    const cases: Array<{ ports: JsonObject; value: JsonObject }> = [
      {
        ports: outputPorts({
          optional: {
            schema: stringPortSchema,
            max_bytes: 8,
            required: false,
          },
        }),
        value: {
          optional: { state: 'absent', schema_hash: STRING_SCHEMA_HASH },
        },
      },
      {
        ports: {
          defaulted: {
            schema: stringPortSchema,
            max_bytes: 16,
            required: true,
          },
        },
        value: {},
      },
      {
        ports: {
          list: {
            schema: {
              type: 'generated',
              generator: 'map_result',
              canonicalizer: 'RFC8785-JCS',
              parameter_hash: hash('list-parameter'),
              schema_ref: `icarus-generated-schema:${hash('list-raw')}`,
              schema_raw_hash: hash('list-raw'),
              schema_hash: STRING_SCHEMA_HASH,
              schema_byte_length: 2,
              schema_json: {},
            },
            max_bytes: null,
            required: true,
          },
        },
        value: {},
      },
      {
        ports: {
          renamed: {
            schema: stringPortSchema,
            max_bytes: 32,
            required: true,
          },
        },
        value: {},
      },
    ];
    for (const testCase of cases) {
      const descriptor = buildNodeOutputEnvelopeSchema(NODE_ID, testCase.ports);
      const validate = new Ajv2020({ strict: true }).compile(
        descriptor.schema_json as AnySchema,
      );
      const names = Object.keys(testCase.ports);
      expect(
        Object.keys(
          (descriptor.schema_json as JsonObject).properties as JsonObject,
        ),
      ).toEqual(['port_contract_hash', 'ports', 'envelope_hash']);
      expect(
        Object.keys(
          (
            ((descriptor.schema_json as JsonObject).properties as JsonObject)
              .ports as JsonObject
          ).properties as JsonObject,
        ).sort(),
      ).toEqual(names.sort());
      expect(validate(testCase.value)).toBe(false);
    }
  });

  it.each([
    [
      'authority',
      "UPDATE workflow_values SET schema_authority_kind = 'registry' WHERE id = ?",
    ],
    [
      'payload',
      "UPDATE workflow_values SET inline_canonical_json = '{}' WHERE id = ?",
    ],
    [
      'hash',
      `UPDATE workflow_values SET content_hash = '${hash('drift')}' WHERE id = ?`,
    ],
    [
      'length',
      'UPDATE workflow_values SET byte_length = byte_length + 1 WHERE id = ?',
    ],
    [
      'ownership',
      "UPDATE workflow_value_ownerships SET owner_graph_run_id = 'run:other' WHERE value_id = ?",
    ],
    [
      'provenance',
      "UPDATE workflow_values SET provenance_ref = 'drift' WHERE id = ?",
    ],
  ])('fails closed on %s drift', (_label, sql) => {
    const test = fixture();
    const member = seedStringMember(test.database, test.planHash);
    const input = writeInput(test.planHash, { result: present(member) });
    test.boundary.write(input);
    test.database.prepare(sql).run(VALUE_ID);
    expect(() => test.boundary.read(input)).toThrow(
      NodeOutputEnvelopeAuthorityError,
    );
  });

  it('rejects wrong descriptor/content pairs and present member provenance drift', () => {
    const test = fixture();
    const member = seedStringMember(test.database, test.planHash);
    const input = writeInput(test.planHash, { result: present(member) });
    test.boundary.write(input);
    test.database
      .prepare(
        `UPDATE workflow_generated_schema_contents
            SET canonical_schema_json = '{}' WHERE schema_ref = (
              SELECT generated_schema_ref FROM workflow_values WHERE id = ?
            )`,
      )
      .run(VALUE_ID);
    expect(() => test.boundary.read(input)).toThrow('generated schema content');

    const second = fixture();
    const secondMember = seedStringMember(second.database, second.planHash);
    second.database
      .prepare(
        "UPDATE workflow_values SET provenance_ref = 'wrong' WHERE id = ?",
      )
      .run(secondMember.valueRef);
    expect(() =>
      second.boundary.write(
        writeInput(second.planHash, { result: present(secondMember) }),
      ),
    ).toThrow('member Value');
  });

  it.each<NodeOutputEnvelopeFaultStage>([
    'after_content',
    'after_binding',
    'after_value',
    'after_ownership',
  ])('rolls the whole write back on %s', (stage) => {
    const test = fixture();
    const member = seedStringMember(test.database, test.planHash);
    expect(() =>
      test.boundary.write(
        writeInput(test.planHash, { result: present(member) }, stage),
      ),
    ).toThrow('fault injected');
    for (const table of [
      'workflow_generated_schema_contents',
      'workflow_plan_generated_schemas',
    ]) {
      expect(
        test.database.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),
      ).toBe(0);
    }
    expect(
      test.database
        .prepare('SELECT count(*) FROM workflow_values WHERE id = ?')
        .pluck()
        .get(VALUE_ID),
    ).toBe(0);
    expect(
      test.database
        .prepare(
          'SELECT count(*) FROM workflow_value_ownerships WHERE value_id = ?',
        )
        .pluck()
        .get(VALUE_ID),
    ).toBe(0);
  });
});
