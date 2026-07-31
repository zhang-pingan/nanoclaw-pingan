import { describe, expect, it } from 'vitest';

import type { Sha256Hash } from '../contracts/types.js';
import { resolveDeterministicRoute } from '../creation/routing-resolver.js';
import { WorkflowProjectionStore } from '../projection/workflow-projection.js';
import {
  buildG9DeploymentJournalEvent,
  buildG9ProductionActivationRequest,
  calculateG9FeaturePointerAggregateHash,
  calculateG9ProjectionGenerationAggregateHash,
  parseG9DeploymentActivationBinding,
  parseG9DeploymentJournalEvent,
  parseG9ProductionActivationRequest,
} from './production-activation.js';

function hash(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}`;
}

describe('G9 pre-activation production authority', () => {
  it('returns the generic zero-inventory Intake result', () => {
    const result = resolveDeterministicRoute('intake-empty', hash('0'), []);
    expect(result.disposition).toBe('no_route_available');
    expect(result.selected).toBeNull();
    expect(result.decision).toMatchObject({
      disposition: 'no_route_available',
      selected_recipe_resource_id: null,
    });

    const runtimeCenter = new WorkflowProjectionStore();
    for (const view of ['workflows', 'pending'] as const) {
      expect(runtimeCenter.rows(view)).toEqual([]);
      expect(runtimeCenter.status(view)).toMatchObject({
        state: 'ready',
        source_head_seq: 0,
        projected_head_seq: 0,
      });
    }
    expect(runtimeCenter.rows('trace')).toEqual([]);
    expect(runtimeCenter.status('trace')).toMatchObject({
      state: 'ready',
      projection_version: 'g7.1',
    });
  });

  it('builds one deterministic closed request, audit, and deployment binding', () => {
    const generations = [
      {
        view: 'workflows' as const,
        generation_id: `generation:workflows:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
      {
        view: 'agent_executions' as const,
        generation_id: `generation:agent_executions:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
      {
        view: 'pending' as const,
        generation_id: `generation:pending:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
      {
        view: 'trace' as const,
        generation_id: `generation:trace:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
    ];
    const request = buildG9ProductionActivationRequest({
      activation_id: 'activation-g9-1',
      operation_key: 'deployment-g9-1',
      requested_at_ms: 1000,
      previous_deployment_binding_hash: null,
      deployment_binding: {
        deployment_profile: 'local_single_user',
        runtime_surface: 'node_service',
        release_manifest_hash: hash('1'),
        release_artifact_hash: hash('2'),
        core_build_hash: hash('3'),
        core_binding_hash: hash('4'),
        applicable_g8_evidence: {
          status: 'fresh_independent_boundary_pass',
          release_artifact_hash: hash('2'),
          startup_report_hash: hash('5'),
          readiness_report_hash: hash('6'),
          startup_harness_hash: hash('7'),
          readiness_harness_hash: hash('8'),
          sqlite_profile_candidate_hash: hash('9'),
          node_executable_hash: hash('a'),
          native_module_hash: hash('b'),
        },
        static_authority: {
          source_core_build_hash: hash('c'),
          absence_baseline_hash: hash('d'),
          product_surface_manifest_hash: hash('e'),
          migration_candidate_boundary_hash: hash('f'),
        },
        feature_registry_pointer: {
          state: 'empty',
          active_release_count: 0,
          pointers: [],
          pointer_aggregate_hash: calculateG9FeaturePointerAggregateHash([]),
        },
        runtime_center_projection: {
          projection_version: 'g7.1',
          generations,
          generation_aggregate_hash:
            calculateG9ProjectionGenerationAggregateHash(generations),
        },
        capacity_authority: {
          mode: 'existing_preserved',
          capacity_revision: 4,
          change_id: 'capacity-change-4',
          config_hash: hash('1'),
          publication_hash: hash('2'),
          publication_file_raw_hash: hash('3'),
          audit_head_hash: hash('4'),
        },
      },
    });
    expect(parseG9ProductionActivationRequest(request)).toEqual(request);
    expect(
      parseG9DeploymentActivationBinding(request.deployment_binding),
    ).toEqual(request.deployment_binding);
    expect(request.audit.audit_hash).toBe(
      request.deployment_binding.activation_audit_hash,
    );
  });

  it('builds an adjacent deterministic journal chain', () => {
    const first = buildG9DeploymentJournalEvent({
      activation_id: 'activation-g9-1',
      sequence: 1,
      phase: 'prepared',
      participant: null,
      previous_event_hash: null,
      previous_binding_hash: null,
      target_binding_hash: hash('1'),
      operation_key: 'deployment-g9-1',
      occurred_at_ms: 1000,
    });
    const second = buildG9DeploymentJournalEvent({
      activation_id: 'activation-g9-1',
      sequence: 2,
      phase: 'participant_prepared',
      participant: 'core_binding',
      previous_event_hash: first.event_hash,
      previous_binding_hash: null,
      target_binding_hash: hash('1'),
      operation_key: 'deployment-g9-1',
      occurred_at_ms: 1001,
    });
    expect(parseG9DeploymentJournalEvent(first)).toEqual(first);
    expect(parseG9DeploymentJournalEvent(second).previous_event_hash).toBe(
      first.event_hash,
    );
  });
});
