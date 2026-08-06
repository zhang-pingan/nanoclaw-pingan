import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import {
  DEPLOYMENT_CAPACITY_KEYS,
  type DeploymentRuntimeCapacity,
} from './safety-sqlite-types.js';
import type { JsonValue, Sha256Hash } from './types.js';
import type {
  CapacityAdminCommand,
  DeploymentRuntimeCapacityPublication,
  DeploymentRuntimeCapacitySnapshot,
} from './capacity-control-plane-types.js';

function capacityPayloadWithoutHash(
  capacity: DeploymentRuntimeCapacitySnapshot,
): Omit<DeploymentRuntimeCapacity, 'config_hash'> {
  return {
    max_active_executions: capacity.max_active_executions,
    max_active_waits: capacity.max_active_waits,
    max_pending_signals: capacity.max_pending_signals,
    max_outbox_inflight: capacity.max_outbox_inflight,
    max_physical_blob_bytes: capacity.max_physical_blob_bytes,
    soft_blob_high_water_bytes: capacity.soft_blob_high_water_bytes,
    minimum_free_disk_bytes: capacity.minimum_free_disk_bytes,
  };
}

export function calculateDeploymentCapacityConfigHash(
  capacity: Omit<DeploymentRuntimeCapacitySnapshot, 'config_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:deployment-runtime-capacity:1\n',
    capacity as unknown as JsonValue,
  );
}

export function validateDeploymentCapacitySnapshot(
  capacity: DeploymentRuntimeCapacitySnapshot,
): string | null {
  if (
    canonicalJson(Object.keys(capacity).sort()) !==
    canonicalJson([...DEPLOYMENT_CAPACITY_KEYS].sort())
  ) {
    return 'capacity_snapshot_closed_shape_invalid';
  }
  for (const field of DEPLOYMENT_CAPACITY_KEYS) {
    if (field === 'config_hash') continue;
    const value = capacity[field];
    if (!Number.isSafeInteger(value) || value <= 0) {
      return `capacity_snapshot_invalid_integer:${field}`;
    }
  }
  if (capacity.soft_blob_high_water_bytes > capacity.max_physical_blob_bytes) {
    return 'capacity_snapshot_soft_high_water_exceeds_hard_limit';
  }
  const expected = calculateDeploymentCapacityConfigHash(
    capacityPayloadWithoutHash(capacity),
  );
  if (capacity.config_hash !== expected) {
    return 'capacity_snapshot_config_hash_invalid';
  }
  return null;
}

export function calculateCapacityPublicationHash(
  publication: Omit<DeploymentRuntimeCapacityPublication, 'publication_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:deployment-runtime-capacity-publication:1\n',
    publication as unknown as JsonValue,
  );
}

export function buildDeploymentCapacityPublication(
  capacityRevision: number,
  capacityChangeId: string,
  previousConfigHash: Sha256Hash | null,
  capacity: DeploymentRuntimeCapacitySnapshot,
): DeploymentRuntimeCapacityPublication {
  const withoutHash = {
    format: 'icarus.deployment-runtime-capacity-publication/1' as const,
    deployment_profile: 'local_single_user' as const,
    capacity_revision: capacityRevision,
    capacity_change_id: capacityChangeId,
    previous_config_hash: previousConfigHash,
    capacity,
  };
  return {
    ...withoutHash,
    publication_hash: calculateCapacityPublicationHash(withoutHash),
  };
}

export function validateCapacityPublication(
  publication: DeploymentRuntimeCapacityPublication,
): string | null {
  const expectedKeys = [
    'format',
    'deployment_profile',
    'capacity_revision',
    'capacity_change_id',
    'previous_config_hash',
    'capacity',
    'publication_hash',
  ];
  if (
    canonicalJson(Object.keys(publication).sort()) !==
    canonicalJson(expectedKeys.sort())
  ) {
    return 'capacity_publication_closed_shape_invalid';
  }
  if (
    publication.format !== 'icarus.deployment-runtime-capacity-publication/1' ||
    publication.deployment_profile !== 'local_single_user' ||
    !Number.isSafeInteger(publication.capacity_revision) ||
    publication.capacity_revision <= 0 ||
    publication.capacity_change_id.length === 0
  ) {
    return 'capacity_publication_header_invalid';
  }
  if (
    (publication.capacity_revision === 1) !==
    (publication.previous_config_hash === null)
  ) {
    return 'capacity_publication_previous_hash_lineage_invalid';
  }
  const snapshotError = validateDeploymentCapacitySnapshot(
    publication.capacity,
  );
  if (snapshotError) return snapshotError;
  const { publication_hash: _ignored, ...withoutHash } = publication;
  if (
    publication.publication_hash !==
    calculateCapacityPublicationHash(withoutHash)
  ) {
    return 'capacity_publication_hash_invalid';
  }
  return null;
}

export function calculateCapacityAdminRequestHash(
  command: CapacityAdminCommand,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:capacity-admin-command-request:1\n',
    command as unknown as JsonValue,
  );
}
