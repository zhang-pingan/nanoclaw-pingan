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
        database_schema_version: 11,
        g1_root_hash:
          'sha256:d4dfd9e1beaea10ab7ecca33308d0624fe7ae4c45518a98729198ed7c6f09375',
        database_schema_hash:
          'sha256:4d096ce9c2ed47a195c36d11a6540a3c0191183a521b59a1520279a0ffaf9be2',
        schema11_migration_hash:
          'sha256:2a29e1f527f47eb43799a7a35a5272b85f5dc154c003f92f71e152788b17f530',
        schema10_to_11_upgrade_hash:
          'sha256:740aab608641511e4cb9ca991e0d60ffd3679c02b1ca4a063422128aa8fb830b',
        schema10_migration_hash:
          'sha256:269645a9f093dc35fd35a04336d71e38cc17b7168584752f9b9bdfc106f46fad',
        schema9_to_10_upgrade_hash:
          'sha256:19c24f06558a3e98f1415468c4af8ce44e94afcad8be3428ebdc133bf4a353c5',
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
        expect.objectContaining({
          role: 'r022_domain_claim_handoff',
          hash: 'sha256:ea97a3d52a2e4a14fb2671b2191b1b1cb6acc22c4ecded7db2e141a1716b516e',
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
