import type { Sha256Hash } from './types.js';

export const G5_REPAIR_DATABASE_SCHEMA_VERSION = 11 as const;
export const G5_REPAIR_DATABASE_SCHEMA_HASH =
  'sha256:ad998b2d0bb5e5f158b0be6d13db79cb6a0c0650d5064b267262551af266189c' as Sha256Hash;

export const G5_REPAIR_EXIT_STATUS =
  'G5_GENERATED_OUTPUT_SCHEMA_AUTHORITY_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION' as const;

export const G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
