import type { Sha256Hash } from './types.js';

export const G7_DATABASE_SCHEMA_VERSION = 11 as const;
export const G7_DATABASE_SCHEMA_HASH =
  'sha256:ad998b2d0bb5e5f158b0be6d13db79cb6a0c0650d5064b267262551af266189c' as Sha256Hash;

export const G7_EXIT_STATUS =
  'G7_CONTROL_CARD_PROJECTION_RECOVERY_CONSTRUCTION_CANDIDATE_PENDING_INDEPENDENT_WHOLE_GATE_ACCEPTANCE' as const;

export const G7_PERSISTENT_MODE_POLICY =
  'HYBRID_GATE_CONTINUOUS_RUNTIME_V1' as const;

export const G7_FIXTURE_BINDING_DOMAIN =
  'icarus:workflow-g7-control-card-projection-recovery-fixture-binding:1\n';
