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
  'src/workflow-runtime/runtime/waits.ts',
] as const;

const evidenceSourcePaths = [
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-reference-model.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-reference-model.test.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-contract.test.ts',
  'src/workflow-runtime/contracts/g5-capacity-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/contracts/g5-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/contracts/g5-capability-outbox-blocker.test.ts',
  'src/workflow-runtime/store/node-output-envelope-value-store.test.ts',
  'src/workflow-runtime/runtime/g5-test-bootstrap.ts',
  'src/workflow-runtime/runtime/g5-basic-runtime.test.ts',
  'src/workflow-runtime/capacity/capacity-admin.test.ts',
] as const;

const exactBindings = [
  {
    name: 'r019_generated_schema_join_authority',
    path: 'src/workflow-runtime/contracts/conformance/generated-schema-join-authority-repair/contract-pack-generated-schema-join-authority-repair.json',
    hash: 'sha256:7a852ff21a77a767b708ab8a4fc5c329024ca954422b26d71210b0385ce05441',
  },
  {
    name: 'database_schema_7',
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema.json',
    hash: 'sha256:b60e3c7fe91d1cfab341d487102c7bff13ad73a320444b45fb6ea71d8b914306',
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
    hash: 'sha256:54355b3c74eb311e495ea31effcbfca6e3ce7547f2ccae663805556060b0b685',
  },
  {
    name: 'g3_registry_persistence',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-persistence.json',
    hash: 'sha256:746280b172ab970a953a20aaaf3dbff557fa7aaecfad6e20bcedc0a0171d72cb',
  },
  {
    name: 'g3_registry_exact_query',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-exact-resource-query.json',
    hash: 'sha256:0ef337e5b94dcbd279589a7522744462e7a5240e12be54cd47f6afd413675ed1',
  },
  {
    name: 'g3_retention_executor_preflight',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-retention-executor-abi-preflight.json',
    hash: 'sha256:207c7604cf8157dc6e17fe4440bdb6651fed22018e094d0a4342e4dce3c1117d',
  },
  {
    name: 'g3_workflow_publisher',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-workflow-publisher.json',
    hash: 'sha256:d25e7842961ee76b5736b3217628daf5adf7cd00b52d64c15020b7a2bde3f622',
  },
  {
    name: 'g3_feature_release_activation',
    path: 'src/workflow-runtime/contracts/contract-pack-g3.9-feature-release-activation.json',
    hash: 'sha256:5411955aa8cd10888fb1ca3df38f311d0a0310d2bd5570ef1f7a9ed41fe08d95',
  },
  {
    name: 'g4_node_output_envelope_authority_successor',
    path: 'src/workflow-runtime/contracts/contract-pack-g4-node-output-envelope-authority-successor.json',
    hash: 'sha256:2b27a8fad1e9a690922186d11bc173f4242174efc843c3eb35e8dfeb94f5c34f',
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

interface RepairCase extends JsonObject {
  readonly case_id: string;
  readonly surface: string;
  readonly assertion: string;
  readonly expected: 'accepted' | 'rejected' | 'rolled_back' | 'replayed';
}

const positiveCases: readonly RepairCase[] = [
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

const negativeCases: readonly RepairCase[] = [
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
  ([caseId, assertion, surface]): RepairCase => ({
    case_id: caseId!,
    surface: surface!,
    assertion: assertion!,
    expected: 'rejected',
  }),
);

const faultCases: readonly RepairCase[] = [
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
    (surface): RepairCase => ({
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
        'sha256:2b27a8fad1e9a690922186d11bc173f4242174efc843c3eb35e8dfeb94f5c34f',
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
      next_task_only: 'independent_G5_whole_gate_regression',
      bindings: upstream,
    },
  );
  const positive = artifact(
    'icarus.workflow-g5-basic-runtime-repair-positive-cases/1',
    'icarus.workflow-g5-basic-runtime-repair-positive-cases',
    'icarus:workflow-g5-basic-runtime-repair-positive-cases:1\n',
    { cases: positiveCases as unknown as JsonValue },
  );
  const negative = artifact(
    'icarus.workflow-g5-basic-runtime-repair-negative-cases/1',
    'icarus.workflow-g5-basic-runtime-repair-negative-cases',
    'icarus:workflow-g5-basic-runtime-repair-negative-cases:1\n',
    { cases: negativeCases as unknown as JsonValue },
  );
  const fault = artifact(
    'icarus.workflow-g5-basic-runtime-repair-fault-cases/1',
    'icarus.workflow-g5-basic-runtime-repair-fault-cases',
    'icarus:workflow-g5-basic-runtime-repair-fault-cases:1\n',
    { cases: faultCases as unknown as JsonValue },
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
      positive_case_count: positiveCases.length,
      negative_case_count: negativeCases.length,
      fault_case_count: faultCases.length,
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
