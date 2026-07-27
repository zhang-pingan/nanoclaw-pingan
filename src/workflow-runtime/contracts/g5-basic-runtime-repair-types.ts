import type { Sha256Hash } from './types.js';

export const G5_REPAIR_DATABASE_SCHEMA_VERSION = 10 as const;
export const G5_REPAIR_DATABASE_SCHEMA_HASH =
  'sha256:1ff4fd63239e85630923fa16e204645367958ae487933338a6f676ec9be6faad' as Sha256Hash;

export const G5_REPAIR_EXIT_STATUS =
  'G5_GENERATED_OUTPUT_SCHEMA_AUTHORITY_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION' as const;

export const G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
