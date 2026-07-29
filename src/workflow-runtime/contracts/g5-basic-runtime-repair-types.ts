import type { Sha256Hash } from './types.js';

export const G5_REPAIR_DATABASE_SCHEMA_VERSION = 11 as const;
export const G5_REPAIR_DATABASE_SCHEMA_HASH =
  'sha256:4d096ce9c2ed47a195c36d11a6540a3c0191183a521b59a1520279a0ffaf9be2' as Sha256Hash;

export const G5_REPAIR_EXIT_STATUS =
  'G5_GENERATED_OUTPUT_SCHEMA_AUTHORITY_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION' as const;

export const G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
