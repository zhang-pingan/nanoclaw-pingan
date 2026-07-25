import type { Sha256Hash } from './types.js';

export const G5_REPAIR_DATABASE_SCHEMA_VERSION = 6 as const;
export const G5_REPAIR_DATABASE_SCHEMA_HASH =
  'sha256:37f0102a9d6b0077f0d44f20182a7d5768ce32b1c0c2c3998937178b06c9b474' as Sha256Hash;

export const G5_REPAIR_EXIT_STATUS =
  'G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION' as const;

export const G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
