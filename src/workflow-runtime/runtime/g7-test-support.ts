import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import type { RuntimeRegistryRef } from '../contracts/g5-basic-runtime-types.js';
import type { RuntimePermissionCode } from '../contracts/catalog-protocol-types.js';
import type { CapacitySnapshotWatcher } from '../capacity/publication.js';
import { buildDeploymentCapacityPublication } from '../contracts/capacity-control-plane-source.js';
import type { DeploymentRuntimeCapacitySnapshot } from '../contracts/capacity-control-plane-types.js';
import {
  createG6MapFixture,
  g6Hash,
  type G6MapFixture,
  type G6MapFixtureOptions,
} from './g6-test-support.js';
import type { AuthenticatedRuntimeCommandActor } from './commands.js';

export const g7Hash = (label: string): Sha256Hash =>
  domainSeparatedSha256('icarus:g7-runtime-test:1\n', { label });

export const G7_ALL_PERMISSIONS = new Set<RuntimePermissionCode>([
  'workflow.operate',
  'workflow.cancel.own',
  'workflow.cancel.any',
  'workflow.node.skip',
  'workflow.retry.advance',
  'workflow.effect.remediate',
  'workflow.blocker.remediate',
  'workflow.integrity.restore',
  'workflow.administrative_abandon',
]);

export interface G7Fixture extends G6MapFixture {
  readonly commandPolicy: RuntimeRegistryRef;
  readonly remediationPolicy: RuntimeRegistryRef;
  readonly actor: AuthenticatedRuntimeCommandActor;
  readonly capacityWatcher: Pick<CapacitySnapshotWatcher, 'current'>;
}

function insertPublishedResource(
  fixture: G6MapFixture,
  resourceType: 'command_policy' | 'operational_remediation_policy',
  name: string,
  content: JsonObject,
): RuntimeRegistryRef {
  const ref = { id: `g7.${name}`, version: '1.0.0' };
  const hash = g7Hash(`resource:${name}`);
  const rowId = registryResourceId({
    resource_type: resourceType,
    ref,
  });
  const valueId = `value:g7:resource:${name}:${fixture.workflowId}`;
  fixture.instance.store.withImmediateTransaction((transaction) => {
    const bytes = canonicalJson(content);
    transaction.execute(
      `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, blob_hash,
         immutable_external_locator, expected_hash, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
         row_version
       ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
         ?, ?, 'g7-test-policy', 'pinned', 'live', NULL, 20, 1)`,
      [
        valueId,
        bytes,
        hash,
        Buffer.byteLength(bytes),
        fixture.seed.refs.schema!.rowId,
        fixture.seed.refs.schema!.hash,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_registry_resources (
         id, resource_type, resource_id, resource_version, owner_core_ref,
         owner_pack_id, canonical_value_id, content_hash, publication_state,
         created_at_ms, published_at_ms, retired_at_ms, row_version
       ) VALUES (?, ?, ?, ?, 'icarus.core@1.0.0', NULL, ?, ?, 'published',
         20, 20, NULL, 1)`,
      [rowId, resourceType, ref.id, ref.version, valueId, hash],
    );
  });
  return { rowId, resourceType, ref, hash };
}

export function installG7Capacity(
  fixture: G6MapFixture,
): ReturnType<typeof buildDeploymentCapacityPublication> {
  const row = fixture.instance.store.queryOne<{
    current_capacity_revision: number;
    current_change_id: string;
    current_publication_hash: Sha256Hash;
    proposed_capacity_json: string;
  }>(
    `SELECT h.current_capacity_revision, h.current_change_id,
            h.current_publication_hash, c.proposed_capacity_json
       FROM runtime_capacity_head h
       JOIN runtime_capacity_admin_commands c
         ON c.assigned_capacity_revision = h.current_capacity_revision
        AND c.assigned_change_id = h.current_change_id
      WHERE h.singleton_key = 1`,
    [],
  );
  if (!row) throw new Error('fresh Store Capacity defaults are missing');
  const publication = buildDeploymentCapacityPublication(
    row.current_capacity_revision,
    row.current_change_id,
    null,
    JSON.parse(row.proposed_capacity_json) as DeploymentRuntimeCapacitySnapshot,
  );
  if (publication.publication_hash !== row.current_publication_hash) {
    throw new Error('fresh Store Capacity publication is inconsistent');
  }
  return publication;
}

export function createG7Fixture(
  key: string,
  options: G6MapFixtureOptions = {},
): G7Fixture {
  const fixture = createG6MapFixture(`g7-${key}`, options);
  const commandPolicy = insertPublishedResource(
    fixture,
    'command_policy',
    `command-policy:${key}`,
    {
      command_policy_allow_pause: true,
      command_policy_allow_resume: true,
      command_policy_allows_local_graph_cancel: true,
      command_policy_allows_workflow_cancel: true,
      command_policy_allow_manual_skip: true,
      command_policy_allow_retry_wait_advance: true,
      receipt_remediation_contract_allows_reconcile: true,
      receipt_remediation_contract_allows_verified_receipt: true,
      receipt_remediation_contract_allows_not_applied_proof: true,
      command_policy_administrative_abandon_allowed: true,
      administrative_abandon_release_claims: false,
    },
  );
  const remediationPolicy = insertPublishedResource(
    fixture,
    'operational_remediation_policy',
    `remediation-policy:${key}`,
    {
      ref: { id: `g7.remediation-policy:${key}`, version: '1.0.0' },
      max_attempts: 4,
      max_duration_ms: 10_000,
      initial_backoff_ms: 10,
      max_backoff_ms: 100,
      allowed_blocker_kinds: [
        'effect_unknown',
        'compensation_dead_letter',
        'root_finalization_exhausted',
        'claim_release_failed',
        'resource_or_credential_unavailable',
        'integrity_quarantine',
      ],
      policy_hash: g7Hash(`remediation-policy-content:${key}`),
    },
  );
  fixture.instance.store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `UPDATE workflows SET workflow_command_policy_resource_id = ?,
              workflow_command_policy_resource_hash = ?, row_version = row_version + 1,
              updated_at_ms = 21 WHERE id = ?`,
      [commandPolicy.rowId, commandPolicy.hash, fixture.workflowId],
    );
  });
  const publication = installG7Capacity(fixture);
  return {
    ...fixture,
    commandPolicy,
    remediationPolicy,
    actor: {
      authenticated: true,
      actorRef: 'human:local-owner',
      actorKind: 'human',
      authSessionRef: `session:g7:${key}`,
      entrypoint: 'runtime_center',
      sourcePackId: null,
      delegationChainRef: null,
      permissions: G7_ALL_PERMISSIONS,
      packPermissionCeiling: null,
    },
    capacityWatcher: { current: () => publication },
  };
}
