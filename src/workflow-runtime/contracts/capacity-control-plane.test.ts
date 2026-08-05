import { describe, expect, it } from 'vitest';

import { buildDeploymentRuntimeCapacityBaseline } from './safety-sqlite-artifacts.js';
import type {
  DeploymentRuntimeCapacitySnapshot,
  ReplaceDeploymentCapacityCommand,
} from './capacity-control-plane-types.js';
import {
  buildDeploymentCapacityPublication,
  calculateCapacityAdminRequestHash,
  validateCapacityPublication,
  validateDeploymentCapacitySnapshot,
} from './capacity-control-plane-source.js';

function baseline(): DeploymentRuntimeCapacitySnapshot {
  return buildDeploymentRuntimeCapacityBaseline() as DeploymentRuntimeCapacitySnapshot;
}

describe('Capacity runtime contracts', () => {
  it('validates the closed capacity snapshot and consumed config hash', () => {
    const capacity = baseline();
    expect(validateDeploymentCapacitySnapshot(capacity)).toBeNull();
    expect(
      validateDeploymentCapacitySnapshot({
        ...capacity,
        max_active_executions: 0,
      }),
    ).toBe('capacity_snapshot_invalid_integer:max_active_executions');
    expect(
      validateDeploymentCapacitySnapshot({
        ...capacity,
        config_hash: `sha256:${'0'.repeat(64)}`,
      }),
    ).toBe('capacity_snapshot_config_hash_invalid');
  });

  it('validates publication lineage and corruption', () => {
    const capacity = baseline();
    const publication = buildDeploymentCapacityPublication(
      1,
      'capacity-change:genesis',
      null,
      capacity,
    );
    expect(validateCapacityPublication(publication)).toBeNull();
    expect(
      validateCapacityPublication({
        ...publication,
        previous_config_hash: capacity.config_hash,
      }),
    ).toBe('capacity_publication_previous_hash_lineage_invalid');
    expect(
      validateCapacityPublication({
        ...publication,
        publication_hash: `sha256:${'a'.repeat(64)}`,
      }),
    ).toBe('capacity_publication_hash_invalid');
  });

  it('keeps request hashing deterministic and content-sensitive', () => {
    const command: ReplaceDeploymentCapacityCommand = {
      command_type: 'replace_deployment_capacity',
      command_id: 'capacity-command:replace',
      idempotency_key: 'capacity-key:replace',
      expected_capacity_revision: 1,
      expected_config_hash: baseline().config_hash,
      proposed_capacity: baseline(),
      reason_code: 'planned_tuning',
      reason_text: 'Local adjustment.',
      evidence_refs: [],
    };
    const first = calculateCapacityAdminRequestHash(command);
    expect(calculateCapacityAdminRequestHash(structuredClone(command))).toBe(
      first,
    );
    expect(
      calculateCapacityAdminRequestHash({
        ...command,
        reason_text: 'Different local adjustment.',
      }),
    ).not.toBe(first);
  });
});
