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
      current_store: {
        database_schema_version: 9,
        g1_root_hash:
          'sha256:c32fc2db46c49b09edeea2a31d07b4decf3b89a6272a3b7b69d933288efe24ca',
        database_schema_hash:
          'sha256:9a36d16fd52d26af009f64f6d26b0bf5d713c16a6f9bad3e6e1019d354bc4ff9',
        schema9_migration_hash:
          'sha256:4591e2dd417d439c813026816572e8a66e9d088efa6a8de88ebfb38a68cf9837',
        schema8_to_9_upgrade_hash:
          'sha256:890c911a27074cca3ee34f9a7f022e4fbda6edf77fbe2ad75f2b77d0d1bed23b',
      },
      upstreams: expect.arrayContaining([
        expect.objectContaining({
          role: 'r021_map_terminal_consumption',
          hash: 'sha256:b5e9237d09d829946c496e19eddf16b21c94fb4fd59b3588900f4764332d0699',
        }),
      ]),
      selection: {
        successor_is_current_machine_authority: true,
        bootstrap_runtime_selectable: false,
        registry_latest_lookup: 'forbidden',
        network_or_fallback: 'forbidden',
      },
      g5_status: 'IN_PROGRESS',
      g6_status: 'BLOCKED_PENDING_REGRESSION/NOT_STARTED',
      g7_through_g9_status: 'NOT_READY',
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
