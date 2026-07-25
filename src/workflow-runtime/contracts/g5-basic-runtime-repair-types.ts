import type { Sha256Hash } from './types.js';

export const G5_REPAIR_DATABASE_SCHEMA_VERSION = 7 as const;
export const G5_REPAIR_DATABASE_SCHEMA_HASH =
  'sha256:27a212831d2abd8898eb8becbfd714d96b1bfb15d818d471cfc58fdc36196e65' as Sha256Hash;

export const G5_REPAIR_EXIT_STATUS =
  'G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION' as const;

export const G5_REPAIR_NODE_OUTPUT_PORT_CONTRACT_DOMAIN =
  'icarus:workflow-node-output-port-contract:1\n';
export const G5_REPAIR_NODE_OUTPUT_ENVELOPE_DOMAIN =
  'icarus:workflow-node-output-envelope:1\n';
