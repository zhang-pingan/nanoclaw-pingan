import type { Sha256Hash } from './types.js';

export const G5_REPAIR_DATABASE_SCHEMA_VERSION = 8 as const;
export const G5_REPAIR_DATABASE_SCHEMA_HASH =
  'sha256:1c7592c8b24a2b032217f42b31a5af3ebf39a9dd4dd10f1158ab9ced340142c6' as Sha256Hash;

export const G5_REPAIR_EXIT_STATUS =
  'G5_GENERATED_OUTPUT_SCHEMA_AUTHORITY_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION' as const;

export const G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
