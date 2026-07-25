import { describe, expect, it } from 'vitest';

import {
  checkNodeOutputEnvelopeRepairReadiness,
  nodeOutputEnvelopeRepairStatusForTest,
} from './node-output-envelope-authority-repair-readiness.js';

describe('NodeOutputEnvelope schema authority repair readiness', () => {
  it('is the current blocker identity without promoting G1-G5 closure', () => {
    const artifact = checkNodeOutputEnvelopeRepairReadiness();
    expect(artifact.payload).toMatchObject({
      status:
        'NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      current_machine_authority: true,
      current_schema: {
        database_schema_version: 7,
        stored_value_authority: 'first_class_plan_generated_node_output_envelope',
      },
      g1_through_g4_current_closure:
        'REOPENED_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      g5: {
        gate_status: 'BLOCKED_BY_SPEC',
        readiness: 'NOT_READY',
        predecessor_candidate: 'INVALIDATED_HISTORICAL_BYTES_ONLY',
        runtime_construction_performed: false,
      },
      g6_through_g9_status: 'NOT_READY',
      blocker_resolution_or_abandon_performed: false,
      workflow_deadline_or_t6e_performed: false,
      certification_or_production_authorized: false,
    });
  });

  it('pins the protected G5 source bytes and forbids authority fabrication', () => {
    expect(nodeOutputEnvelopeRepairStatusForTest()).toMatchObject({
      protected_runtime_sources: [
        {
          path: 'src/workflow-runtime/runtime/generated-schema-runtime.ts',
          raw_sha256:
            'sha256:01f3118ade3563d1b06ad053d760bc175896454fd6ba23c3c84c192683f6dd9c',
        },
        {
          path: 'src/workflow-runtime/runtime/basic-scheduler.ts',
          raw_sha256:
            'sha256:c80144ecef8efd58de2730ea6623bfd42a8adf9fa452c64352557a9bcdb354de',
        },
      ],
      forbidden_resolution: {
        business_port_or_input_snapshot_schema: true,
        registry_latest_or_fabricated_publication: true,
        network_or_fallback: true,
        manual_bypass: true,
      },
    });
  });
});
