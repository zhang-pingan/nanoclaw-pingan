import type { Sha256Hash } from './types.js';

export const G6_DATABASE_SCHEMA_VERSION = 10 as const;
export const G6_DATABASE_SCHEMA_HASH =
  'sha256:1ff4fd63239e85630923fa16e204645367958ae487933338a6f676ec9be6faad' as Sha256Hash;

export const G6_EXIT_STATUS =
  'G6_DYNAMIC_CLOSE_CONSTRUCTION_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION' as const;

export const G6_PERSISTENT_MODE_POLICY =
  'HYBRID_GATE_CONTINUOUS_RUNTIME_V1' as const;

export const G6_FIXTURE_BINDING_DOMAIN =
  'icarus:workflow-g6-dynamic-close-fixture-binding:1\n';
