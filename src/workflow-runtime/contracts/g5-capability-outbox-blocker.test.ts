import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  CAPABILITY_OUTBOX_COMPILED_PLAN_SCHEMA_PATH,
  CAPABILITY_OUTBOX_CONFORMANCE_RESULT_SCHEMA_PATH,
  CAPABILITY_OUTBOX_HANDOFF_SCHEMA_PATH,
  CAPABILITY_OUTBOX_SNAPSHOT_SCHEMA_PATH,
  checkCapabilityOutboxBindingContract,
} from './capability-outbox-binding-contract.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
const workflowRuntimeRoot = path.resolve(contractsRoot, '..');
const repoRoot = path.resolve(workflowRuntimeRoot, '../..');
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const HASH_C = `sha256:${'c'.repeat(64)}`;
const HASH_D = `sha256:${'d'.repeat(64)}`;
const HASH_E = `sha256:${'e'.repeat(64)}`;

function read(relativePath: string): Buffer {
  return fs.readFileSync(path.join(repoRoot, relativePath));
}

function insertValue(
  database: Database.Database,
  id: string,
  contentHash: string,
  schemaResourceId: string,
  schemaHash: string,
): void {
  database
    .prepare(
      `INSERT INTO workflow_values (
        id, storage_kind, inline_canonical_json, blob_hash,
        immutable_external_locator, expected_hash, content_hash, byte_length,
        media_type, schema_resource_id, schema_resource_hash, provenance_ref,
        retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
        row_version, schema_authority_kind
      ) VALUES (?, 'inline', '{}', NULL, NULL, NULL, ?, 2,
        'application/json', ?, ?, 'contract:test', 'pinned', 'live', NULL, 1, 0,
        'registry')`,
    )
    .run(id, contentHash, schemaResourceId, schemaHash);
}

function insertRegistryResource(
  database: Database.Database,
  id: string,
  resourceType: string,
  resourceId: string,
  valueId: string,
  contentHash: string,
): void {
  database
    .prepare(
      `INSERT INTO workflow_registry_resources (
        id, resource_type, resource_id, resource_version, owner_core_ref,
        owner_feature_id, canonical_value_id, content_hash, publication_state,
        created_at_ms, published_at_ms, retired_at_ms, row_version
      ) VALUES (?, ?, ?, '1.0.0', 'core:test@1', NULL, ?, ?, 'published',
        1, 1, NULL, 0)`,
    )
    .run(id, resourceType, resourceId, valueId, contentHash);
}

function schema7Database(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(
    read(
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v7.sql',
    ).toString('utf8'),
  );
  database.exec('BEGIN');
  insertValue(database, 'value:schema', HASH_A, 'resource:schema', HASH_A);
  insertRegistryResource(
    database,
    'resource:schema',
    'schema',
    'icarus.workflow-json',
    'value:schema',
    HASH_A,
  );
  insertValue(database, 'value:adapter', HASH_B, 'resource:schema', HASH_A);
  insertRegistryResource(
    database,
    'resource:adapter',
    'outbox_adapter',
    'fixture.adapter.capability-dispatch',
    'value:adapter',
    HASH_B,
  );
  insertValue(database, 'value:policy', HASH_C, 'resource:schema', HASH_A);
  insertRegistryResource(
    database,
    'resource:policy',
    'outbox_policy',
    'fixture.outbox-policy.normal-delivery',
    'value:policy',
    HASH_C,
  );
  insertValue(
    database,
    'value:effective-policy',
    HASH_D,
    'resource:schema',
    HASH_A,
  );
  insertValue(database, 'value:payload', HASH_E, 'resource:schema', HASH_A);
  database.exec('COMMIT');
  return database;
}

function insertOutbox(
  database: Database.Database,
  adapterHash: string,
  policySnapshotHash = HASH_D,
): void {
  database
    .prepare(
      `INSERT INTO workflow_outbox (
        id, effect_key, workflow_id, attempt_id, wait_id,
        effect_operation_id, domain_claim_id, projection_target_ref,
        aggregate_row_version, effect_type, adapter_resource_id,
        adapter_resource_hash, delivery_policy_resource_id,
        delivery_policy_resource_hash, policy_snapshot_value_id,
        policy_snapshot_hash, delivery_lane, delivery_requirement,
        payload_value_id, payload_hash, status, delivery_attempt_count,
        reconcile_attempt_count, next_attempt_at_ms, deadline_at_ms,
        lease_owner, lease_token, lease_expires_at_ms, last_result_kind,
        last_error_code, created_at_ms, delivered_at_ms, updated_at_ms
      ) VALUES (
        'outbox:1', 'effect:1', NULL, NULL, NULL, NULL, NULL,
        'projection:test', NULL, 'capability_dispatch', 'resource:adapter', ?,
        'resource:policy', ?, 'value:effective-policy', ?,
        'normal_execution', 'required', 'value:payload', ?, 'pending', 0, 0,
        1, 900001, NULL, NULL, NULL, NULL, NULL, 1, NULL, 1
      )`,
    )
    .run(adapterHash, HASH_C, policySnapshotHash, HASH_E);
}

describe('G5 Capability to Outbox execution-binding Contract repair', () => {
  it('checks the generated closed source/snapshot/Plan and handoff schemas', () => {
    const manifest = checkCapabilityOutboxBindingContract();
    expect(manifest.payload).toMatchObject({
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      latest_lookup: 'forbidden',
      g4_fixture_authority: 'forbidden',
      runtime_implementation: 'absent',
    });
    for (const relativePath of [
      CAPABILITY_OUTBOX_COMPILED_PLAN_SCHEMA_PATH,
      CAPABILITY_OUTBOX_CONFORMANCE_RESULT_SCHEMA_PATH,
      CAPABILITY_OUTBOX_SNAPSHOT_SCHEMA_PATH,
      CAPABILITY_OUTBOX_HANDOFF_SCHEMA_PATH,
    ]) {
      expect(
        fs.existsSync(path.join(contractsRoot, relativePath)),
        relativePath,
      ).toBe(true);
    }
  });

  it('validates the sealed Plan and result against the current closed schemas', () => {
    const schema = (relativePath: string): AnySchema =>
      parseContractArtifactEnvelope(
        strictParseJsonBytes(
          fs.readFileSync(path.join(contractsRoot, relativePath)),
        ),
      ).payload as AnySchema;
    const plan = strictParseJsonBytes(
      read(
        'src/workflow-runtime/contracts/conformance/sealed/g2-capability-outbox-binding-v3/expected/positive.static-lowering.plan.json',
      ),
    ) as JsonObject;
    const result = strictParseJsonBytes(
      read(
        'src/workflow-runtime/contracts/conformance/sealed/g2-capability-outbox-binding-v3/expected/positive.static-lowering.result.json',
      ),
    ) as JsonObject;
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const validatePlan = ajv.compile(
      schema(CAPABILITY_OUTBOX_COMPILED_PLAN_SCHEMA_PATH),
    );
    const validateResult = ajv.compile(
      schema(CAPABILITY_OUTBOX_CONFORMANCE_RESULT_SCHEMA_PATH),
    );
    expect(validatePlan(plan), JSON.stringify(validatePlan.errors)).toBe(true);
    expect(validateResult(result), JSON.stringify(validateResult.errors)).toBe(
      true,
    );
    expect(validatePlan({ ...plan, implicit_latest: true })).toBe(false);
    expect(validateResult({ ...result, implicit_binding: true })).toBe(false);
    const planWithUnknownBindingField = structuredClone(plan);
    const boundNode = (planWithUnknownBindingField.nodes as JsonObject[]).find(
      (candidate) => candidate.outbox_execution_binding !== undefined,
    );
    expect(boundNode).toBeDefined();
    const binding = boundNode?.outbox_execution_binding as JsonObject;
    binding.implicit_adapter = true;
    expect(validatePlan(planWithUnknownBindingField)).toBe(false);
  });

  it('binds exact Adapter, finite Policy, lane, reconciliation, idempotency, and delivery requirement in the sealed Plan', () => {
    const plan = strictParseJsonBytes(
      read(
        'src/workflow-runtime/contracts/conformance/sealed/g2-capability-outbox-binding-v3/expected/positive.static-lowering.plan.json',
      ),
    ) as JsonObject;
    const node = (plan.nodes as JsonObject[]).find(
      (candidate) => candidate.outbox_execution_binding !== undefined,
    );
    expect(node).toBeDefined();
    const binding = node?.outbox_execution_binding as JsonObject;
    expect(binding).toMatchObject({
      adapter_identity: {
        resource_type: 'outbox_adapter',
        ref: { version: '1.0.0' },
      },
      delivery_policy_identity: {
        resource_type: 'outbox_policy',
        ref: { version: '1.0.0' },
      },
      effect_contract: {
        delivery_lane: 'normal_execution',
        reconciliation: { type: 'not_required' },
        idempotency: 'provider_key',
        delivery_requirement: 'required',
      },
    });
    const snapshot = binding.effective_policy_snapshot as JsonObject;
    const policy = snapshot.effective_policy as JsonObject;
    expect(policy.max_delivery_attempts).toBe(8);
    expect(policy.max_reconcile_attempts).toBe(4);
    expect(snapshot.snapshot_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('persists the exact binding through Schema 7 registry-authority Value FKs', () => {
    const database = schema7Database();
    try {
      database.exec('BEGIN');
      insertOutbox(database, HASH_B);
      database.exec('COMMIT');
      const row = database
        .prepare(
          `SELECT adapter_resource_hash, delivery_policy_resource_hash,
             policy_snapshot_hash
           FROM workflow_outbox WHERE id = 'outbox:1'`,
        )
        .get() as Record<string, string>;
      expect(row).toEqual({
        adapter_resource_hash: HASH_B,
        delivery_policy_resource_hash: HASH_C,
        policy_snapshot_hash: HASH_D,
      });
    } finally {
      database.close();
    }
  });

  it('rejects an Adapter identity drift at the deferred Schema 7 FK handoff', () => {
    const database = schema7Database();
    try {
      database.exec('BEGIN');
      insertOutbox(database, HASH_E);
      expect(() => database.exec('COMMIT')).toThrow(/FOREIGN KEY/u);
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  });

  it('rejects a Policy snapshot hash drift at the deferred Schema 7 FK handoff', () => {
    const database = schema7Database();
    try {
      database.exec('BEGIN');
      insertOutbox(database, HASH_B, HASH_E);
      expect(() => database.exec('COMMIT')).toThrow(/FOREIGN KEY/u);
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
  });
});
