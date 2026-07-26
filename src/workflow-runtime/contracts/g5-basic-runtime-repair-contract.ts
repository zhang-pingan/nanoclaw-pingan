import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G5_REPAIR_DATABASE_SCHEMA_HASH,
  G5_REPAIR_DATABASE_SCHEMA_VERSION,
  G5_REPAIR_EXIT_STATUS,
} from './g5-basic-runtime-repair-types.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

export const G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS = [
  'src/workflow-runtime/capacity/admin-gateway.ts',
  'src/workflow-runtime/capacity/publication.ts',
  'src/workflow-runtime/creation/domain-claims.ts',
  'src/workflow-runtime/creation/recipe-registry.ts',
  'src/workflow-runtime/creation/routing-resolver.ts',
  'src/workflow-runtime/creation/task-intake.ts',
  'src/workflow-runtime/runtime/basic-scheduler.ts',
  'src/workflow-runtime/runtime/fixed-point-authority.ts',
  'src/workflow-runtime/runtime/generated-schema-runtime.ts',
  'src/workflow-runtime/runtime/graph-store.ts',
  'src/workflow-runtime/runtime/ledger.ts',
  'src/workflow-runtime/runtime/lifecycle.ts',
  'src/workflow-runtime/runtime/node-execution.ts',
  'src/workflow-runtime/runtime/operational-blockers.ts',
  'src/workflow-runtime/runtime/outbox.ts',
  'src/workflow-runtime/runtime/plan-authority.ts',
  'src/workflow-runtime/runtime/reconciler.ts',
  'src/workflow-runtime/runtime/static-child-plan-bundle.ts',
  'src/workflow-runtime/runtime/waits.ts',
] as const;

const evidenceSourcePaths = [
  'src/workflow-runtime/compiler/current-g2-golden-replay.ts',
  'src/workflow-runtime/compiler/generated-output-schema-authority.test.ts',
  'src/workflow-runtime/contracts/current-g2-generated-output-schema-golden-authoring.ts',
  'src/workflow-runtime/contracts/current-g2-static-child-replay-authority.ts',
  'src/workflow-runtime/contracts/current-g2-static-child-replay-authority-cli.ts',
  'src/workflow-runtime/contracts/current-g2-static-child-replay-authority.test.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-fixture-harness.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-reference-model.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-reference-model.test.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-contract.test.ts',
  'src/workflow-runtime/contracts/g5-capacity-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/contracts/g5-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/contracts/g5-capability-outbox-blocker.test.ts',
  'src/workflow-runtime/store/node-output-envelope-value-store.test.ts',
  'src/workflow-runtime/runtime/g5-test-bootstrap.ts',
  'src/workflow-runtime/runtime/g5-basic-runtime.test.ts',
  'src/workflow-runtime/compiler/static-child-plan-bundle.test.ts',
  'src/workflow-runtime/contracts/static-child-plan-bundle-fixture-harness.ts',
  'src/workflow-runtime/contracts/static-child-plan-bundle-repair.test.ts',
  'src/workflow-runtime/capacity/capacity-admin.test.ts',
] as const;

const exactBindings = [
  {
    name: 'g2_g5_static_child_plan_bundle_repair_candidate',
    path: 'src/workflow-runtime/contracts/conformance/static-child-plan-bundle-repair/contract-pack-static-child-plan-bundle-repair.json',
    hash: 'sha256:072c612da8d0f42073a1a6ea3c80953936dfdd1c606ed9eef5c6a114225b9a3e',
  },
  {
    name: 'g2_current_compiler_3_0_6_generated_output_schema_replay_authority',
    path: 'src/workflow-runtime/contracts/conformance/current/g2-generated-output-schema-authority-replay-v8/current-replay-authority@2.json',
    hash: 'sha256:d8134a41081786d2f19c99930d89ae3a88ea3af8ba937f5063c07768211019ac',
    bundleHash:
      'sha256:fe308ba0f8d9b8c9604aff39163029bf05e0aa80c7b461a9f2f80d27c2984bd3',
  },
  {
    name: 'r019_generated_schema_join_authority',
    path: 'src/workflow-runtime/contracts/conformance/generated-schema-join-authority-repair/contract-pack-generated-schema-join-authority-repair.json',
    hash: 'sha256:7a852ff21a77a767b708ab8a4fc5c329024ca954422b26d71210b0385ce05441',
  },
  {
    name: 'database_schema_9',
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema-v9.json',
    hash: 'sha256:c32fc2db46c49b09edeea2a31d07b4decf3b89a6272a3b7b69d933288efe24ca',
  },
  {
    name: 'r020_child_consumption_lineage',
    path: 'src/workflow-runtime/contracts/contract-pack-r020-child-consumption-lineage.json',
    hash: 'sha256:8a24efc4bd98c02b92cc6d6ce70f13c879d7e537e1081e4d57d561a63ea85c5a',
  },
  {
    name: 'r021_map_terminal_consumption',
    path: 'src/workflow-runtime/contracts/contract-pack-r021-map-terminal-consumption.json',
    hash: 'sha256:b5e9237d09d829946c496e19eddf16b21c94fb4fd59b3588900f4764332d0699',
  },
  {
    name: 'g2_v6_sealed_compiler_plan',
    path: 'src/workflow-runtime/contracts/conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json',
    hash: 'sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11',
    bundleHash:
      'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7',
  },
  {
    name: 'g3_registry_publish_foundation',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-publish-foundation.json',
    hash: 'sha256:96f6ed7b832b33a924222585f3f55de47264bf462e8b12ffb4b28f4d7ac2621e',
  },
  {
    name: 'g3_registry_persistence',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-persistence.json',
    hash: 'sha256:9b295834dc499b5590566a0bee5ac053adc0da1879699626e0e94ec825e443cd',
  },
  {
    name: 'g3_registry_exact_query',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-exact-resource-query.json',
    hash: 'sha256:8734b6a44d11180b507a0e546bc5784a5ee0073cb94c85785c05eed995d50ba9',
  },
  {
    name: 'g3_retention_executor_preflight',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-retention-executor-abi-preflight.json',
    hash: 'sha256:71be35581adb4717230bb106c658db91777126c8e59bc9c0e95ef5d7bd651e43',
  },
  {
    name: 'g3_workflow_publisher',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-workflow-publisher.json',
    hash: 'sha256:88705beddf6965dc8a947aba1f3dd9fbb2b9124f33824dafe7ad0881ab561be3',
  },
  {
    name: 'g3_feature_release_activation',
    path: 'src/workflow-runtime/contracts/contract-pack-g3.9-feature-release-activation.json',
    hash: 'sha256:230fa30e795e0931d27acfb5a4215e7f30e4d806a525dea6e6966036ee1ea6ee',
  },
  {
    name: 'g4_node_output_envelope_authority_successor',
    path: 'src/workflow-runtime/contracts/contract-pack-g4-node-output-envelope-authority-successor.json',
    hash: 'sha256:58704cc29429d323bc8c3bcb825cfd1d153528671be7ebb63a7f2127d45b0ee4',
  },
  {
    name: 'gate_ownership',
    path: 'src/workflow-runtime/contracts/governance/workflow-runtime-gate-ownership@1.json',
    hash: 'sha256:712a7440e83f087e4bbb1e465a1a677a16708429f46766029baa0f90734e5017',
  },
  {
    name: 'capacity',
    path: 'src/workflow-runtime/contracts/conformance/capacity-control-plane-addendum/contract-pack-capacity-control-plane-addendum.json',
    hash: 'sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6',
  },
] as const;

export type G5RepairFixtureCategory = 'positive' | 'negative' | 'fault';

interface RepairCaseSeed extends JsonObject {
  readonly case_id: string;
  readonly surface: string;
  readonly assertion: string;
  readonly expected: 'accepted' | 'rejected' | 'rolled_back' | 'replayed';
}

export interface G5RepairFixtureOperation extends JsonObject {
  readonly kind: string;
  readonly scenario_key: string;
  readonly transaction: string;
  readonly input: JsonObject;
  readonly fault: JsonObject | null;
}

export interface G5RepairFixtureOracle extends JsonObject {
  readonly disposition: 'accepted' | 'rejected' | 'rolled_back' | 'replayed';
  readonly sqlite_state: 'committed' | 'unchanged';
  readonly reopen_required: boolean;
  readonly exact_error: string | null;
}

export interface G5RepairFixtureCase extends JsonObject {
  readonly case_id: string;
  readonly category: G5RepairFixtureCategory;
  readonly surface: string;
  readonly assertion: string;
  readonly handler: string;
  readonly operation: G5RepairFixtureOperation;
  readonly oracle: G5RepairFixtureOracle;
  readonly binding_hash: Sha256Hash;
}

export type G5RepairFixtureBindingInput = {
  readonly case_id: string;
  readonly category: G5RepairFixtureCategory;
  readonly surface: string;
  readonly assertion: string;
  readonly handler: string;
  readonly operation: G5RepairFixtureOperation;
  readonly oracle: G5RepairFixtureOracle;
};

const positiveCaseSeeds: readonly RepairCaseSeed[] = [
  {
    case_id: 'intake_routing_domain_claim',
    surface: 'T0',
    assertion:
      'intake, exact routing, creation intent, workflow, activation, and claims commit and replay atomically',
    expected: 'accepted',
  },
  {
    case_id: 'required_finalization_intent',
    surface: 'T0p',
    assertion:
      'required finalization creates one stable intent and exact replay',
    expected: 'accepted',
  },
  {
    case_id: 'activation_state_lowering',
    surface: 'T1',
    assertion:
      'activation lowers the exact state and immutable context authority',
    expected: 'accepted',
  },
  {
    case_id: 'sealed_plan_generated_binding',
    surface: 'T2a',
    assertion: 'exact generated content and Plan bindings persist atomically',
    expected: 'accepted',
  },
  {
    case_id: 'static_graph_materialization',
    surface: 'T2b',
    assertion:
      'exact Plan nodes, edges, limits, and bindings materialize atomically',
    expected: 'accepted',
  },
  {
    case_id: 'static_graph_fixed_point',
    surface: 'T3a',
    assertion:
      'routing, data, trigger, input sealing, scheduler, Fact, Event, and ledger reach a deterministic fixed point',
    expected: 'accepted',
  },
  {
    case_id: 'settled_completion_selection',
    surface: 'T3b',
    assertion:
      'settled completion selects one exact named exit or engine error',
    expected: 'accepted',
  },
  {
    case_id: 'join_expose_rename_single',
    surface: 'T4',
    assertion: 'renamed required single output publishes a generated Value',
    expected: 'accepted',
  },
  {
    case_id: 'join_optional_absent',
    surface: 'T4',
    assertion: 'optional missing single publishes explicit absent',
    expected: 'accepted',
  },
  {
    case_id: 'join_default_single',
    surface: 'T3a_T4',
    assertion: 'defaulted single persists and publishes its logical Value',
    expected: 'accepted',
  },
  {
    case_id: 'join_list_aggregation',
    surface: 'T3a_T4',
    assertion: 'sealed list order and aggregate bytes are preserved',
    expected: 'accepted',
  },
  {
    case_id: 'downstream_port_resolution',
    surface: 'T3a',
    assertion: 'downstream reads the immutable port Value from the envelope',
    expected: 'accepted',
  },
  {
    case_id: 'capability_effect_outbox',
    surface: 'T5',
    assertion:
      'exact Adapter, Policy, effect, idempotency key, claims, and outbox binding persist before external work',
    expected: 'accepted',
  },
  {
    case_id: 'system_execution_output_envelope',
    surface: 'T6a',
    assertion:
      'terminal success publishes the exact compiled port set in its canonical envelope',
    expected: 'accepted',
  },
  {
    case_id: 'delegation_receipt_recovery',
    surface: 'T6b',
    assertion:
      'unknown external outcome reconciles without a second operation identity',
    expected: 'replayed',
  },
  {
    case_id: 'durable_wait_signal_envelope',
    surface: 'T6c',
    assertion:
      'one wait winner records typed authorization, inbox, Fact, Event, ledger release, and resolution envelope',
    expected: 'accepted',
  },
  {
    case_id: 'automatic_retry_timers',
    surface: 'T6d',
    assertion:
      'watchdog and automatic retry consume the exact schedule and current Capacity lineage',
    expected: 'accepted',
  },
  {
    case_id: 'capacity_admin_recovery',
    surface: 'CAP0_CAP4',
    assertion:
      'prepared publication and committed head recover across rename and reopen boundaries',
    expected: 'replayed',
  },
  {
    case_id: 'operational_blocker_create_open_cache',
    surface: 'G5_BLOCKER',
    assertion:
      'blocker create, open listing, and run/workflow action-required caches commit together',
    expected: 'accepted',
  },
  {
    case_id: 'node_output_envelope_store_recovery',
    surface: 'SCHEMA7_STORE',
    assertion:
      'canonical envelope and present members retain exact bytes, schema authority, provenance, and ownership through read, reopen, and recovery scan',
    expected: 'replayed',
  },
  {
    case_id: 'sqlite_reopen_response_loss',
    surface: 'T4',
    assertion: 'response-loss replay is exact before and after Store reopen',
    expected: 'replayed',
  },
] as const;

const negativeCaseSeeds: readonly RepairCaseSeed[] = [
  [
    'creation_intent_conflict',
    'same creation key with different intent bytes conflicts',
    'T0',
  ],
  [
    'stale_activation_row',
    'stale activation row version cannot partially activate',
    'T1',
  ],
  [
    'stale_compile_lease',
    'stale compile lease, epoch, source, or snapshot is rejected',
    'T2a',
  ],
  [
    'paused_materialization',
    'paused or unhealthy runs cannot materialize',
    'T2b',
  ],
  [
    'fact_payload_drift',
    'same Fact key with different bytes is an integrity violation',
    'T3a',
  ],
  [
    'stale_node_activation',
    'node activation requires current work epochs and row version',
    'T4',
  ],
  [
    'latest_policy_forbidden',
    'moving or latest Adapter and Delivery Policy lookup is forbidden',
    'T5',
  ],
  [
    'test_authority_promotion',
    'test-only Registry authority cannot authorize Production dispatch',
    'T5',
  ],
  ['late_worker_result', 'fenced acceptance cannot publish output', 'T6a'],
  [
    'callback_identity_drift',
    'delegation callback identity drift is conflict or late evidence',
    'T6b',
  ],
  [
    'second_wait_winner',
    'a terminal wait cannot accept a second winner',
    'T6c',
  ],
  [
    'manual_retry_without_gateway',
    'manual retry requires future G7 authorization and audit',
    'T6d',
  ],
  [
    'capacity_file_tamper',
    'a valid but unaudited Capacity file never becomes authority',
    'CAP0_CAP4',
  ],
  [
    'capacity_idempotency_conflict',
    'same Capacity key with different request bytes conflicts',
    'CAP0_CAP4',
  ],
  [
    'missing_generated_pair',
    'persisted content or Plan binding pair is absent',
    'T2a_T3a_T4',
  ],
  ['unknown_generated_scheme', 'generated schema ref scheme is unknown', 'T2a'],
  ['generated_raw_hash_drift', 'canonical bytes and raw hash disagree', 'T2a'],
  ['generated_domain_hash_drift', 'schema domain hash disagrees', 'T2a'],
  ['generated_parameter_drift', 'join expose parameter hash disagrees', 'T2a'],
  [
    'sealed_plan_binding_drift',
    'persisted Plan bytes or hash disagree',
    'T2a_T3a_T4',
  ],
  [
    'schema_authority_mismatch',
    'Value authority and envelope port disagree',
    'T3a_T4',
  ],
  [
    'join_expose_shape_mismatch',
    'expose and output port sets disagree',
    'T2a_T4',
  ],
  ['required_output_absent', 'required output cannot be absent', 'T4'],
  [
    'output_schema_invalid',
    'output content violates the generated schema',
    'T3a_T4',
  ],
  [
    'output_max_bytes_exceeded',
    'output content exceeds the compiled maximum',
    'T3a_T4',
  ],
  [
    'port_contract_hash_drift',
    'materialized port contract hash disagrees',
    'T3a_T4',
  ],
  [
    'registry_latest_fallback',
    'Registry latest or network fallback is forbidden',
    'T2a_T3a_T4',
  ],
  [
    'input_snapshot_publication',
    'input snapshot cannot masquerade as output',
    'T4',
  ],
].map(
  ([caseId, assertion, surface]): RepairCaseSeed => ({
    case_id: caseId!,
    surface: surface!,
    assertion: assertion!,
    expected: 'rejected',
  }),
);

const faultCaseSeeds: readonly RepairCaseSeed[] = [
  ...[
    'T0',
    'T0p',
    'T1',
    'T2a',
    'T2b',
    'T3a',
    'T3b',
    'T4',
    'T5',
    'T6a',
    'T6b',
    'T6c',
    'T6d',
  ].map(
    (surface): RepairCaseSeed => ({
      case_id: `fault_before_commit_${surface.toLowerCase()}`,
      surface,
      assertion: `${surface} rolls back every write when failure is injected before commit`,
      expected: 'rolled_back',
    }),
  ),
  {
    case_id: 'fault_node_output_envelope_boundary',
    surface: 'STORE',
    assertion:
      'generated content, binding, member Values, envelope, and ownership roll back together at every injected stage',
    expected: 'rolled_back',
  },
  {
    case_id: 'fault_capacity_after_prepare',
    surface: 'CAP1_CAP2',
    assertion:
      'prepared Capacity invocation survives crash and resumes the same publication',
    expected: 'replayed',
  },
  {
    case_id: 'fault_capacity_after_rename',
    surface: 'CAP2_CAP3',
    assertion: 'Watcher rejects or resumes a renamed file before head commit',
    expected: 'replayed',
  },
  {
    case_id: 'fault_capacity_after_head',
    surface: 'CAP3_CAP4',
    assertion: 'CAP4 reopens the committed head and finalizes exactly once',
    expected: 'replayed',
  },
] as const;

const generatedEnvelopeCases = new Set([
  'join_expose_rename_single',
  'join_optional_absent',
  'join_default_single',
  'join_list_aggregation',
  'downstream_port_resolution',
  'sqlite_reopen_response_loss',
  'missing_generated_pair',
  'unknown_generated_scheme',
  'generated_raw_hash_drift',
  'generated_domain_hash_drift',
  'generated_parameter_drift',
  'sealed_plan_binding_drift',
  'schema_authority_mismatch',
  'join_expose_shape_mismatch',
  'required_output_absent',
  'output_schema_invalid',
  'output_max_bytes_exceeded',
  'port_contract_hash_drift',
  'registry_latest_fallback',
  'input_snapshot_publication',
]);

const exactNegativeErrors: Readonly<Record<string, string>> = {
  creation_intent_conflict: 'idempotency_conflict',
  stale_activation_row: 'cas_conflict',
  stale_compile_lease: 'cas_conflict',
  paused_materialization: 'cas_conflict',
  fact_payload_drift: 'integrity_violation',
  stale_node_activation: 'cas_conflict',
  latest_policy_forbidden: 'integrity_violation',
  test_authority_promotion: 'forbidden_surface',
  late_worker_result: 'cas_conflict',
  callback_identity_drift: 'idempotency_conflict',
  second_wait_winner: 'late',
  manual_retry_without_gateway: 'forbidden_surface',
  capacity_file_tamper: 'publication_not_authoritative',
  capacity_idempotency_conflict: 'idempotency_conflict',
  missing_generated_pair: 'sqlite_foreign_key',
  unknown_generated_scheme: 'plan_authority_invalid',
  generated_raw_hash_drift: 'generated_schema_invalid',
  generated_domain_hash_drift: 'generated_schema_invalid',
  generated_parameter_drift: 'sqlite_foreign_key',
  sealed_plan_binding_drift: 'binding_invalid',
  schema_authority_mismatch: 'sqlite_check',
  join_expose_shape_mismatch: 'plan_authority_invalid',
  required_output_absent: 'envelope_invalid',
  output_schema_invalid: 'envelope_invalid',
  output_max_bytes_exceeded: 'envelope_invalid',
  port_contract_hash_drift: 'envelope_invalid',
  registry_latest_fallback: 'plan_authority_invalid',
  input_snapshot_publication: 'member_value_invalid',
};

export type G5RepairFixtureOperationKind =
  | 'create_workflow_t0'
  | 'prepare_required_finalization_t0p'
  | 'activate_workflow_t1'
  | 'persist_compile_result_t2a'
  | 'materialize_root_scope_t2b'
  | 'initialize_fixed_point_t3a'
  | 'request_settled_close_t3b'
  | 'schedule_ready_node_t4'
  | 'prepare_capability_dispatch_t5'
  | 'accept_internal_result_t6a'
  | 'accept_delegation_callback_t6b'
  | 'resolve_wait_t6c'
  | 'fire_attempt_watchdog_t6d'
  | 'capacity_admin_cap0_cap4'
  | 'open_operational_blocker'
  | 'node_output_envelope_store';

const fixtureOperationByCase: Readonly<
  Record<string, G5RepairFixtureOperationKind>
> = {
  intake_routing_domain_claim: 'create_workflow_t0',
  creation_intent_conflict: 'create_workflow_t0',
  fault_before_commit_t0: 'create_workflow_t0',
  required_finalization_intent: 'prepare_required_finalization_t0p',
  fault_before_commit_t0p: 'prepare_required_finalization_t0p',
  activation_state_lowering: 'activate_workflow_t1',
  stale_activation_row: 'activate_workflow_t1',
  fault_before_commit_t1: 'activate_workflow_t1',
  sealed_plan_generated_binding: 'persist_compile_result_t2a',
  stale_compile_lease: 'persist_compile_result_t2a',
  fault_before_commit_t2a: 'persist_compile_result_t2a',
  static_graph_materialization: 'materialize_root_scope_t2b',
  paused_materialization: 'materialize_root_scope_t2b',
  fault_before_commit_t2b: 'materialize_root_scope_t2b',
  static_graph_fixed_point: 'initialize_fixed_point_t3a',
  fact_payload_drift: 'initialize_fixed_point_t3a',
  fault_before_commit_t3a: 'initialize_fixed_point_t3a',
  settled_completion_selection: 'request_settled_close_t3b',
  fault_before_commit_t3b: 'request_settled_close_t3b',
  join_expose_rename_single: 'schedule_ready_node_t4',
  join_optional_absent: 'schedule_ready_node_t4',
  join_default_single: 'schedule_ready_node_t4',
  join_list_aggregation: 'schedule_ready_node_t4',
  downstream_port_resolution: 'schedule_ready_node_t4',
  sqlite_reopen_response_loss: 'schedule_ready_node_t4',
  stale_node_activation: 'schedule_ready_node_t4',
  missing_generated_pair: 'schedule_ready_node_t4',
  unknown_generated_scheme: 'schedule_ready_node_t4',
  generated_raw_hash_drift: 'schedule_ready_node_t4',
  generated_domain_hash_drift: 'schedule_ready_node_t4',
  generated_parameter_drift: 'schedule_ready_node_t4',
  sealed_plan_binding_drift: 'schedule_ready_node_t4',
  schema_authority_mismatch: 'schedule_ready_node_t4',
  join_expose_shape_mismatch: 'schedule_ready_node_t4',
  required_output_absent: 'schedule_ready_node_t4',
  output_schema_invalid: 'schedule_ready_node_t4',
  output_max_bytes_exceeded: 'schedule_ready_node_t4',
  port_contract_hash_drift: 'schedule_ready_node_t4',
  registry_latest_fallback: 'schedule_ready_node_t4',
  input_snapshot_publication: 'schedule_ready_node_t4',
  fault_before_commit_t4: 'schedule_ready_node_t4',
  capability_effect_outbox: 'prepare_capability_dispatch_t5',
  latest_policy_forbidden: 'prepare_capability_dispatch_t5',
  test_authority_promotion: 'prepare_capability_dispatch_t5',
  fault_before_commit_t5: 'prepare_capability_dispatch_t5',
  system_execution_output_envelope: 'accept_internal_result_t6a',
  late_worker_result: 'accept_internal_result_t6a',
  fault_before_commit_t6a: 'accept_internal_result_t6a',
  delegation_receipt_recovery: 'accept_delegation_callback_t6b',
  callback_identity_drift: 'accept_delegation_callback_t6b',
  fault_before_commit_t6b: 'accept_delegation_callback_t6b',
  durable_wait_signal_envelope: 'resolve_wait_t6c',
  second_wait_winner: 'resolve_wait_t6c',
  fault_before_commit_t6c: 'resolve_wait_t6c',
  automatic_retry_timers: 'fire_attempt_watchdog_t6d',
  manual_retry_without_gateway: 'fire_attempt_watchdog_t6d',
  fault_before_commit_t6d: 'fire_attempt_watchdog_t6d',
  capacity_admin_recovery: 'capacity_admin_cap0_cap4',
  capacity_file_tamper: 'capacity_admin_cap0_cap4',
  capacity_idempotency_conflict: 'capacity_admin_cap0_cap4',
  fault_capacity_after_prepare: 'capacity_admin_cap0_cap4',
  fault_capacity_after_rename: 'capacity_admin_cap0_cap4',
  fault_capacity_after_head: 'capacity_admin_cap0_cap4',
  operational_blocker_create_open_cache: 'open_operational_blocker',
  node_output_envelope_store_recovery: 'node_output_envelope_store',
  fault_node_output_envelope_boundary: 'node_output_envelope_store',
};

const fixtureRelationByOperation: Readonly<
  Record<G5RepairFixtureOperationKind, string>
> = {
  create_workflow_t0: 'workflows',
  prepare_required_finalization_t0p: 'workflow_root_finalization_schedules',
  activate_workflow_t1: 'workflow_state_activations',
  persist_compile_result_t2a: 'workflow_graph_scope_plans',
  materialize_root_scope_t2b: 'workflow_graph_run_manifest',
  initialize_fixed_point_t3a: 'workflow_graph_facts',
  request_settled_close_t3b: 'workflow_graph_scope_close_requests',
  schedule_ready_node_t4: 'workflow_graph_nodes',
  prepare_capability_dispatch_t5: 'workflow_outbox',
  accept_internal_result_t6a: 'workflow_graph_node_attempts',
  accept_delegation_callback_t6b: 'workflow_graph_node_attempts',
  resolve_wait_t6c: 'workflow_graph_waits',
  fire_attempt_watchdog_t6d: 'workflow_graph_retry_schedules',
  capacity_admin_cap0_cap4: 'runtime_capacity_admin_commands',
  open_operational_blocker: 'workflow_operational_blockers',
  node_output_envelope_store: 'workflow_values',
};

const fixtureRelationByCase: Readonly<Record<string, string>> = {
  callback_identity_drift: 'workflow_graph_late_results',
  second_wait_winner: 'workflow_graph_late_results',
  capacity_file_tamper: 'runtime_capacity_change_events',
  capacity_idempotency_conflict: 'runtime_capacity_admin_invocations',
};

const negativeCasesWithDurableAudit = new Set(
  Object.keys(fixtureRelationByCase),
);

const fixtureBehaviorByCase: Readonly<Record<string, string>> = {
  creation_intent_conflict: 'conflicting_valid_creation_intent',
  stale_activation_row: 'stale_workflow_row_version',
  stale_compile_lease: 'stale_build_row_version',
  paused_materialization: 'paused_run_control',
  fact_payload_drift: 'conflicting_fact_payload',
  stale_node_activation: 'stale_node_row_version',
  latest_policy_forbidden: 'moving_delivery_policy_ref',
  test_authority_promotion: 'test_only_adapter_authority',
  late_worker_result: 'stale_attempt_row_version',
  callback_identity_drift: 'different_external_execution_identity',
  second_wait_winner: 'timeout_after_signal_winner',
  manual_retry_without_gateway: 'automatic_timer_false',
  capacity_file_tamper: 'recover_unaudited_file',
  capacity_idempotency_conflict: 'conflicting_capacity_request',
  missing_generated_pair: 'delete_referenced_generated_binding',
  unknown_generated_scheme: 'unknown_envelope_schema_ref',
  generated_raw_hash_drift: 'generated_schema_bytes_drift',
  generated_domain_hash_drift: 'generated_schema_length_drift',
  generated_parameter_drift: 'change_referenced_parameter_hash',
  sealed_plan_binding_drift: 'change_binding_hash',
  schema_authority_mismatch: 'unsupported_schema_canonicalizer',
  join_expose_shape_mismatch: 'add_unsealed_output_port',
  required_output_absent: 'absent_required_port',
  output_schema_invalid: 'wrong_member_schema_hash',
  output_max_bytes_exceeded: 'member_exceeds_compiled_max_bytes',
  port_contract_hash_drift: 'unexpected_envelope_port',
  registry_latest_fallback: 'moving_registry_schema_ref',
  input_snapshot_publication: 'wrong_member_provenance',
  join_expose_rename_single: 'publish_renamed_single',
  join_optional_absent: 'publish_optional_absent',
  join_default_single: 'publish_defaulted_single',
  join_list_aggregation: 'publish_ordered_list',
  downstream_port_resolution: 'publish_selected_immutable_value',
  capacity_admin_recovery: 'recover_after_rename_response_loss',
  fault_capacity_after_prepare: 'recover_after_cap1_prepare',
  fault_capacity_after_rename: 'recover_after_cap2_rename',
  fault_capacity_after_head: 'recover_after_cap3_head',
  fault_node_output_envelope_boundary: 'rollback_after_envelope_value',
};

function fixtureBehaviorName(
  seed: RepairCaseSeed,
  category: G5RepairFixtureCategory,
): string {
  const explicit = fixtureBehaviorByCase[seed.case_id];
  if (explicit) return explicit;
  if (seed.case_id.startsWith('fault_before_commit_'))
    return 'rollback_before_commit';
  if (category === 'positive')
    return seed.expected === 'replayed'
      ? 'commit_reopen_exact_replay'
      : 'commit_and_reopen';
  throw new Error(`G5 fixture ${seed.case_id} has no executable behavior`);
}

function fixtureOperationKind(caseId: string): G5RepairFixtureOperationKind {
  if (generatedEnvelopeCases.has(caseId)) return 'node_output_envelope_store';
  const kind = fixtureOperationByCase[caseId];
  if (!kind) throw new Error(`G5 fixture ${caseId} has no operation binding`);
  return kind;
}

function fixtureHandler(kind: G5RepairFixtureOperationKind): string {
  return `${kind}_production`;
}

function fixtureInput(
  seed: RepairCaseSeed,
  category: G5RepairFixtureCategory,
  kind: G5RepairFixtureOperationKind,
): JsonObject {
  return {
    fixture_token: `g5-fixture:${seed.case_id}`,
    idempotency_key: `g5-fixture:${seed.case_id}`,
    now_ms: 1_780_000_000_000,
    expected_surface: seed.surface,
    mode:
      category === 'fault' && seed.expected === 'rolled_back'
        ? 'inject_and_rollback'
        : category === 'fault'
          ? 'commit_reopen_replay'
          : category === 'negative'
            ? 'reject_constraint'
            : seed.expected === 'replayed'
              ? 'commit_reopen_replay'
              : 'commit',
    payload: {
      operation: kind,
      behavior: fixtureBehaviorName(seed, category),
      durable_relation:
        fixtureRelationByCase[seed.case_id] ?? fixtureRelationByOperation[kind],
    },
    rejection_code:
      category === 'negative'
        ? (exactNegativeErrors[seed.case_id] ?? 'rejected')
        : null,
    replay_count: seed.expected === 'replayed' ? 2 : 1,
    reopen_after: true,
  };
}

export function calculateG5RepairFixtureBindingHash(
  fixture: G5RepairFixtureBindingInput,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-g5-basic-runtime-repair-fixture-binding:1\n',
    fixture,
  );
}

function buildFixtureCase(
  seed: RepairCaseSeed,
  category: G5RepairFixtureCategory,
): G5RepairFixtureCase {
  const kind = fixtureOperationKind(seed.case_id);
  const handler = fixtureHandler(kind);
  const fault =
    category === 'fault'
      ? {
          point:
            seed.case_id === 'fault_node_output_envelope_boundary'
              ? 'after_value'
              : seed.case_id.startsWith('fault_before_commit_')
                ? 'before_commit'
                : seed.case_id.replace(/^fault_/, ''),
          boundary: seed.surface,
        }
      : null;
  const fixtureWithoutHash: G5RepairFixtureBindingInput = {
    case_id: seed.case_id,
    category,
    surface: seed.surface,
    assertion: seed.assertion,
    handler,
    operation: {
      kind,
      scenario_key: `g5-fixture:${category}:${seed.case_id}`,
      transaction: seed.surface,
      input: fixtureInput(seed, category, kind),
      fault,
    },
    oracle: {
      disposition: seed.expected,
      sqlite_state:
        seed.expected === 'rejected' &&
        negativeCasesWithDurableAudit.has(seed.case_id)
          ? 'committed'
          : seed.expected === 'rejected' || seed.expected === 'rolled_back'
            ? 'unchanged'
            : 'committed',
      reopen_required: true,
      exact_error:
        category === 'negative'
          ? `sqlite_constraint:${exactNegativeErrors[seed.case_id] ?? 'rejected'}`
          : category === 'fault' && seed.expected === 'rolled_back'
            ? 'injected_fault'
            : null,
    },
  };
  return {
    ...fixtureWithoutHash,
    binding_hash: calculateG5RepairFixtureBindingHash(fixtureWithoutHash),
  };
}

export const G5_REPAIR_POSITIVE_FIXTURES = positiveCaseSeeds.map((seed) =>
  buildFixtureCase(seed, 'positive'),
);
export const G5_REPAIR_NEGATIVE_FIXTURES = negativeCaseSeeds.map((seed) =>
  buildFixtureCase(seed, 'negative'),
);
export const G5_REPAIR_FAULT_FIXTURES = faultCaseSeeds.map((seed) =>
  buildFixtureCase(seed, 'fault'),
);

const artifactPaths = {
  protocol:
    'conformance/g5-basic-runtime-repair/g5-basic-runtime-repair-protocol@1.json',
  positive: 'conformance/g5-basic-runtime-repair/positive-cases.json',
  negative: 'conformance/g5-basic-runtime-repair/negative-cases.json',
  fault: 'conformance/g5-basic-runtime-repair/fault-cases.json',
  reference:
    'conformance/g5-basic-runtime-repair/g5-basic-runtime-repair-reference-authority@1.json',
  implementation:
    'implementation/g5-basic-runtime-repair-implementation@1.json',
  pack: 'contract-pack-g5-basic-runtime-repair.json',
} as const;

function rawSha256(bytes: Buffer | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function inventory(paths: readonly string[]): JsonObject[] {
  return paths.map((relativePath) => {
    const absolute = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolute))
      throw new Error(`Missing G5 repair source ${relativePath}`);
    return {
      path: relativePath,
      raw_sha256: rawSha256(fs.readFileSync(absolute)),
    };
  });
}

function artifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const base = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    payload,
  };
  return {
    ...base,
    hash: calculateArtifactHash({ ...base, hash: `sha256:${'0'.repeat(64)}` }),
  };
}

function bindings(): JsonObject[] {
  return exactBindings.map((binding) => {
    const absolute = path.join(repoRoot, binding.path);
    const observed = parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute)),
    );
    if (observed.hash !== binding.hash)
      throw new Error(`${binding.name} identity drift: ${observed.hash}`);
    if (
      'bundleHash' in binding &&
      observed.payload.bundle_hash !== binding.bundleHash
    )
      throw new Error(`${binding.name} internal bundle identity drift`);
    return {
      name: binding.name,
      path: binding.path,
      hash: observed.hash,
      ...('bundleHash' in binding ? { bundle_hash: binding.bundleHash } : {}),
    };
  });
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const upstream = bindings();
  const protocol = artifact(
    'icarus.workflow-g5-basic-runtime-repair-protocol/1',
    'icarus.workflow-g5-basic-runtime-repair-protocol',
    'icarus:workflow-g5-basic-runtime-repair-protocol:1\n',
    {
      gate: 'G5',
      status: G5_REPAIR_EXIT_STATUS,
      g5_done: false,
      database_schema_version: G5_REPAIR_DATABASE_SCHEMA_VERSION,
      database_schema_hash: G5_REPAIR_DATABASE_SCHEMA_HASH,
      plan_authority:
        'persisted_hash_verified_sealed_plan_plus_exact_generated_content_and_binding_rows',
      generated_value_authority:
        'business_members_use_exact_compiled_schema_and_envelope_uses_exact_node_output_envelope_schema',
      output_publication:
        'canonical_node_output_envelope_with_exact_port_values',
      node_output_envelope_store_boundary: [
        'write',
        'exact_replay',
        'read',
        'reopen',
        'recovery_scan',
      ],
      join_contracts: [
        'expose_rename',
        'required_single',
        'optional_absent_single',
        'default_single',
        'list_aggregation',
        'required_max_schema_port_contract',
      ],
      transaction_host: 'WorkflowRuntimeStore.withImmediateTransaction',
      transaction_mode: 'BEGIN_IMMEDIATE',
      fixture_execution: {
        record_shape:
          'closed_category_surface_handler_operation_fault_oracle_binding',
        dispatch: 'exactly_one_registered_handler_per_checked_in_record',
        completion:
          'missing_duplicate_unknown_unhandled_or_multiply_handled_fails',
        contract_checker_scope: 'closed_structure_identity_and_bytes_only',
        runtime_execution_proof: 'managed_test_g5_fixture_execution_only',
      },
      fallback: [
        'registry_latest_forbidden',
        'network_forbidden',
        'runtime_fallback_forbidden',
      ],
      preserved: [
        'T0_T6d',
        'CAP0_CAP4',
        'ownership',
        'readiness',
        'fencing',
        'idempotency',
        'fact_event',
        'open_blocker_cache',
      ],
      g4_isolation_authority_hash:
        'sha256:58704cc29429d323bc8c3bcb825cfd1d153528671be7ebb63a7f2127d45b0ee4',
      forbidden: [
        'Gateway',
        'Command_Invocation_audit',
        'T6e',
        'blocker_resolve_abandon',
        'workflow_deadline',
        'manual_retry_bypass',
        'G6_plus',
        'certification',
        'Production_activation',
      ],
      next_task_only:
        'independent_G2_G3_G4_G5_generated_output_schema_affected_chain_regression',
      bindings: upstream,
    },
  );
  const positive = artifact(
    'icarus.workflow-g5-basic-runtime-repair-positive-cases/1',
    'icarus.workflow-g5-basic-runtime-repair-positive-cases',
    'icarus:workflow-g5-basic-runtime-repair-positive-cases:1\n',
    { cases: G5_REPAIR_POSITIVE_FIXTURES as unknown as JsonValue },
  );
  const negative = artifact(
    'icarus.workflow-g5-basic-runtime-repair-negative-cases/1',
    'icarus.workflow-g5-basic-runtime-repair-negative-cases',
    'icarus:workflow-g5-basic-runtime-repair-negative-cases:1\n',
    { cases: G5_REPAIR_NEGATIVE_FIXTURES as unknown as JsonValue },
  );
  const fault = artifact(
    'icarus.workflow-g5-basic-runtime-repair-fault-cases/1',
    'icarus.workflow-g5-basic-runtime-repair-fault-cases',
    'icarus:workflow-g5-basic-runtime-repair-fault-cases:1\n',
    { cases: G5_REPAIR_FAULT_FIXTURES as unknown as JsonValue },
  );
  const evidence = inventory(evidenceSourcePaths);
  const reference = artifact(
    'icarus.workflow-g5-basic-runtime-repair-reference-authority/1',
    'icarus.workflow-g5-basic-runtime-repair-reference-authority',
    'icarus:workflow-g5-basic-runtime-repair-reference-authority:1\n',
    {
      independent_from_runtime: true,
      deterministic_property_tests: true,
      real_sqlite_runtime_tests: true,
      checked_in_fixture_execution: {
        full_record_required: true,
        exact_once_required: true,
        exact_oracle_required: true,
        mutation_tests_required: true,
        contract_checker_does_not_claim_runtime_execution: true,
      },
      evidence,
      evidence_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g5-basic-runtime-repair-evidence-tree:1\n',
        evidence,
      ),
    },
  );
  const sources = inventory(G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS);
  const implementation = artifact(
    'icarus.workflow-g5-basic-runtime-repair-implementation/1',
    'icarus.workflow-g5-basic-runtime-repair-implementation',
    'icarus:workflow-g5-basic-runtime-repair-implementation:1\n',
    {
      production_target: true,
      production_ingress_enabled: false,
      source_count: sources.length,
      sources,
      source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g5-basic-runtime-repair-source-tree:1\n',
        sources,
      ),
    },
  );
  const members = [
    protocol,
    positive,
    negative,
    fault,
    reference,
    implementation,
  ].map((member) => ({
    format: member.format,
    ref: member.ref,
    hash: member.hash,
  }));
  const pack = artifact(
    'icarus.workflow-contract-pack-g5-basic-runtime-repair/1',
    'icarus.workflow-contract-pack-g5-basic-runtime-repair',
    'icarus:workflow-contract-pack-g5-basic-runtime-repair:1\n',
    {
      gate: 'G5',
      status: G5_REPAIR_EXIT_STATUS,
      g5_done: false,
      g6_through_g9: 'NOT_READY',
      historical_g5_candidate_authority: 'forbidden',
      fixture_count_is_not_runtime_execution_proof: true,
      positive_case_count: G5_REPAIR_POSITIVE_FIXTURES.length,
      negative_case_count: G5_REPAIR_NEGATIVE_FIXTURES.length,
      fault_case_count: G5_REPAIR_FAULT_FIXTURES.length,
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g5-basic-runtime-repair-member-tree:1\n',
        members,
      ),
    },
  );
  return [
    [artifactPaths.protocol, protocol],
    [artifactPaths.positive, positive],
    [artifactPaths.negative, negative],
    [artifactPaths.fault, fault],
    [artifactPaths.reference, reference],
    [artifactPaths.implementation, implementation],
    [artifactPaths.pack, pack],
  ];
}

function bytes(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateG5BasicRuntimeRepairContracts(): void {
  for (const [relativePath, value] of buildArtifacts()) {
    const absolute = path.join(contractsRoot, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, bytes(value), {
      encoding: 'utf8',
      mode: 0o644,
    });
    fs.renameSync(temporary, absolute);
  }
}

export function checkG5BasicRuntimeRepairContracts(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | null = null;
  for (const [relativePath, expected] of buildArtifacts()) {
    const absolute = path.join(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes(expected)
    )
      throw new Error(
        `${relativePath} is not generated byte-for-byte; run contracts:g5:generate`,
      );
    parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute)),
    );
    if (relativePath === artifactPaths.pack) pack = expected;
  }
  if (pack === null) throw new Error('G5 repair Contract Pack is missing');
  return pack;
}
