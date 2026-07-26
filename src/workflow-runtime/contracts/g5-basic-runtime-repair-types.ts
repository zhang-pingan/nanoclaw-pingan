import type { Sha256Hash } from './types.js';

export const G5_REPAIR_DATABASE_SCHEMA_VERSION = 9 as const;
export const G5_REPAIR_DATABASE_SCHEMA_HASH =
  'sha256:9a36d16fd52d26af009f64f6d26b0bf5d713c16a6f9bad3e6e1019d354bc4ff9' as Sha256Hash;

export const G5_REPAIR_EXIT_STATUS =
  'G5_GENERATED_OUTPUT_SCHEMA_AUTHORITY_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION' as const;

export const G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
