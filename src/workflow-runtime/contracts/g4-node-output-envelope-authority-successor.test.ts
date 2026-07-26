import { describe, expect, it } from 'vitest';

import {
  checkG4NodeOutputEnvelopeAuthoritySuccessor,
  g4HistoricalAuthorityHashesForTest,
} from './g4-node-output-envelope-authority-successor.js';

describe('G4 NodeOutputEnvelope authority successor', () => {
  it('binds the reopened current closure without rewriting historical G4', () => {
    const artifact = checkG4NodeOutputEnvelopeAuthoritySuccessor();
    expect(artifact.payload).toMatchObject({
      gate: 'G4',
      status:
        'NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      current_closure: 'REOPENED_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      current_store: { database_schema_version: 8 },
      selection: {
        successor_is_current_machine_authority: true,
        bootstrap_runtime_selectable: false,
        registry_latest_lookup: 'forbidden',
        network_or_fallback: 'forbidden',
      },
      g5_status: 'BLOCKED_BY_SPEC/NOT_READY',
      g6_through_g9_status: 'NOT_READY',
      runtime_construction_performed: false,
      production_authorization: false,
    });
  });

  it('checks exact frozen predecessor and member raw bytes', () => {
    expect(g4HistoricalAuthorityHashesForTest()).toEqual({
      packRaw:
        'sha256:1760da21231d46a323caf43ab5936ba90fbe378bf978e4a638caeefcd95082c7',
      memberRawTree:
        'sha256:d4ad1ff6e3f08cbaa5e9b54f1342213d9612dd03078bdcd21abf1870c28f7bf2',
    });
  });
});
