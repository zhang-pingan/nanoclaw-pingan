import type { Sha256Hash } from './types.js';

export const G7_DATABASE_SCHEMA_VERSION = 11 as const;
export const G7_DATABASE_SCHEMA_HASH =
  'sha256:4d096ce9c2ed47a195c36d11a6540a3c0191183a521b59a1520279a0ffaf9be2' as Sha256Hash;

export const G7_EXIT_STATUS =
  'G7_CONTROL_CARD_PROJECTION_RECOVERY_CONSTRUCTION_CANDIDATE_PENDING_INDEPENDENT_WHOLE_GATE_ACCEPTANCE' as const;

export const G7_PERSISTENT_MODE_POLICY =
  'HYBRID_GATE_CONTINUOUS_RUNTIME_V1' as const;

export const G7_FIXTURE_BINDING_DOMAIN =
  'icarus:workflow-g7-control-card-projection-recovery-fixture-binding:1\n';
