import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';
import {
  G5_DATABASE_SCHEMA_HASH,
  G5_DATABASE_SCHEMA_VERSION,
  G5_TRANSACTION_IDS,
  type G5ContractFixture,
} from './g5-basic-runtime-types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

export const G5_IMPLEMENTATION_SOURCE_PATHS = [
  'src/workflow-runtime/capacity/admin-gateway.ts',
  'src/workflow-runtime/capacity/publication.ts',
  'src/workflow-runtime/creation/domain-claims.ts',
  'src/workflow-runtime/creation/recipe-registry.ts',
  'src/workflow-runtime/creation/routing-resolver.ts',
  'src/workflow-runtime/creation/task-intake.ts',
  'src/workflow-runtime/runtime/graph-store.ts',
  'src/workflow-runtime/runtime/ledger.ts',
  'src/workflow-runtime/runtime/lifecycle.ts',
  'src/workflow-runtime/runtime/node-execution.ts',
  'src/workflow-runtime/runtime/operational-blockers.ts',
  'src/workflow-runtime/runtime/outbox.ts',
  'src/workflow-runtime/runtime/plan-authority.ts',
  'src/workflow-runtime/runtime/reconciler.ts',
  'src/workflow-runtime/runtime/basic-scheduler.ts',
  'src/workflow-runtime/runtime/waits.ts',
] as const;

const currentBindings = [
  {
    name: 'ownership',
    path: 'governance/workflow-runtime-gate-ownership@1.json',
    expected:
      'sha256:6ba952bf7761f249fa16c0c44a37d48a67c9f5f21c3667a5c966ac59e8affb38',
  },
  {
    name: 'transaction_protocol',
    path: 'protocols/workflow-run-transaction-protocol-table.json',
    expected:
      'sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79',
  },
  {
    name: 'command_protocol',
    path: 'protocols/workflow-runtime-command-protocol-table.json',
    expected:
      'sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba',
  },
  {
    name: 'capacity',
    path: 'conformance/capacity-control-plane-addendum/contract-pack-capacity-control-plane-addendum.json',
    expected:
      'sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6',
  },
  {
    name: 'execution_binding',
    path: 'conformance/capability-outbox-execution-binding/contract-pack-capability-outbox-execution-binding.json',
    expected:
      'sha256:48f63ae7be30c61f056f78f713591f34431336cc722d6928fbc6e2783a062088',
  },
] as const;

const externalBindings = [
  {
    name: 'schema_5',
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema.json',
    expected:
      'sha256:baa39d55cac34133a29b461466aa450fec59bd2fd6df72334e8b33d1d1619869',
  },
  {
    name: 'g2_sealed_v3',
    path: 'src/workflow-runtime/contracts/conformance/sealed/g2-capability-outbox-binding-v3/golden-conformance-bundle@2.json',
    expected:
      'sha256:967437bb9f91e32e5014b2af90a23f5646e491eb427bdf55accb345ead70db8f',
    expectedBundle:
      'sha256:b3ed9e43bd0fadaf40520257926dcf690ee8495bb417220245f248385bde9efb',
  },
] as const;

const positiveCases: readonly G5ContractFixture[] = [
  {
    case_id: 'static_graph_success',
    transaction_id: 'T3a',
    assertion: 'static nodes reach a deterministic terminal fixed point',
    expected: 'accepted',
  },
  {
    case_id: 'delegation_receipt_lost',
    transaction_id: 'T6b',
    assertion:
      'unknown external outcome is reconciled without a second operation key',
    expected: 'accepted',
  },
  {
    case_id: 'system_execution',
    transaction_id: 'T6a',
    assertion: 'pinned worker result publishes one logical output',
    expected: 'accepted',
  },
  {
    case_id: 'wait_signal_wins',
    transaction_id: 'T6c',
    assertion:
      'one armed wait winner records inbox, fact, event, and reservation release',
    expected: 'accepted',
  },
  {
    case_id: 'join_fixed_point',
    transaction_id: 'T3a',
    assertion: 'route and data facts settle before node readiness',
    expected: 'accepted',
  },
  {
    case_id: 'terminal_settled',
    transaction_id: 'T3b',
    assertion: 'quiescent terminal selection writes one close request',
    expected: 'accepted',
  },
  {
    case_id: 'quality_revision',
    transaction_id: 'T6a',
    assertion: 'validated feedback reserves exactly one quality successor',
    expected: 'accepted',
  },
  {
    case_id: 'capacity_recovery',
    transaction_id: 'CAP0-CAP4',
    assertion:
      'committed head is replayed after crash without changing the prepared invocation',
    expected: 'replayed',
  },
  {
    case_id: 'operational_blocker_open',
    transaction_id: 'T6d',
    assertion: 'blocker creation and run/workflow caches commit together',
    expected: 'accepted',
  },
] as const;

const negativeCases: readonly G5ContractFixture[] = [
  {
    case_id: 'creation_intent_conflict',
    transaction_id: 'T0',
    assertion: 'same creation key with a different intent conflicts',
    expected: 'rejected',
  },
  {
    case_id: 'stale_activation_row',
    transaction_id: 'T1',
    assertion: 'stale workflow row version cannot partially activate',
    expected: 'rejected',
  },
  {
    case_id: 'stale_compile_lease',
    transaction_id: 'T2a',
    assertion: 'stale compile lease, epoch, source, or snapshot is rejected',
    expected: 'rejected',
  },
  {
    case_id: 'paused_materialization',
    transaction_id: 'T2b',
    assertion: 'paused or unhealthy runs cannot materialize',
    expected: 'rejected',
  },
  {
    case_id: 'fact_payload_drift',
    transaction_id: 'T3a',
    assertion: 'same fact key with different bytes is an integrity violation',
    expected: 'rejected',
  },
  {
    case_id: 'stale_node_activation',
    transaction_id: 'T4',
    assertion: 'node activation requires current work epochs and row version',
    expected: 'rejected',
  },
  {
    case_id: 'latest_policy_forbidden',
    transaction_id: 'T5',
    assertion:
      'moving or latest Adapter and Delivery Policy lookup is forbidden',
    expected: 'rejected',
  },
  {
    case_id: 'test_authority_promotion',
    transaction_id: 'T5',
    assertion:
      'G4 test-only resource cannot authorize production outbox dispatch',
    expected: 'rejected',
  },
  {
    case_id: 'late_worker_result',
    transaction_id: 'T6a',
    assertion: 'fenced acceptance cannot publish output',
    expected: 'rejected',
  },
  {
    case_id: 'callback_identity_drift',
    transaction_id: 'T6b',
    assertion: 'delegation callback identity drift is conflict or late audit',
    expected: 'rejected',
  },
  {
    case_id: 'second_wait_winner',
    transaction_id: 'T6c',
    assertion: 'a terminal wait cannot accept a second winner',
    expected: 'rejected',
  },
  {
    case_id: 'manual_retry_without_gateway',
    transaction_id: 'T6d',
    assertion: 'manual retry requires future G7 authorization and audit',
    expected: 'rejected',
  },
  {
    case_id: 'capacity_file_tamper',
    transaction_id: 'CAP0-CAP4',
    assertion: 'a valid but unaudited file never becomes authorization',
    expected: 'rejected',
  },
  {
    case_id: 'capacity_idempotency_conflict',
    transaction_id: 'CAP0-CAP4',
    assertion: 'same key with different request bytes conflicts',
    expected: 'rejected',
  },
] as const;

const faultCases: readonly G5ContractFixture[] = [
  ...G5_TRANSACTION_IDS.map(
    (transactionId): G5ContractFixture => ({
      case_id: `fault_before_commit_${transactionId.toLowerCase()}`,
      transaction_id: transactionId,
      assertion: `${transactionId} rolls back every write when failure is injected before commit`,
      expected: 'rolled_back',
    }),
  ),
  {
    case_id: 'fault_capacity_after_prepare',
    transaction_id: 'CAP0-CAP4',
    assertion: 'CAP1 survives crash and resumes the same publication',
    expected: 'replayed',
  },
  {
    case_id: 'fault_capacity_after_rename',
    transaction_id: 'CAP0-CAP4',
    assertion: 'Watcher rejects a renamed file before CAP3 head commit',
    expected: 'replayed',
  },
  {
    case_id: 'fault_capacity_after_head',
    transaction_id: 'CAP0-CAP4',
    assertion: 'CAP4 reopens committed head and publishes exactly once',
    expected: 'replayed',
  },
];

const artifactPaths = {
  protocol: 'conformance/g5-basic-runtime/g5-basic-runtime-protocol@1.json',
  schema: 'conformance/g5-basic-runtime/g5-basic-runtime-records-schema@1.json',
  positive: 'conformance/g5-basic-runtime/positive-cases.json',
  negative: 'conformance/g5-basic-runtime/negative-cases.json',
  fault: 'conformance/g5-basic-runtime/fault-cases.json',
  implementation: 'implementation/g5-basic-runtime-implementation@1.json',
  pack: 'contract-pack-g5-basic-runtime.json',
} as const;

function rawSha256(bytes: Buffer | string): string {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function artifact(
  format: string,
  refId: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const base = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domain,
    payload,
  };
  return {
    ...base,
    hash: calculateArtifactHash({ ...base, hash: `sha256:${'0'.repeat(64)}` }),
  };
}

function sourceInventory(): JsonObject[] {
  return G5_IMPLEMENTATION_SOURCE_PATHS.map((relativePath) => {
    const absolute = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolute))
      throw new Error(`Missing G5 implementation source ${relativePath}`);
    return {
      path: relativePath,
      raw_sha256: rawSha256(fs.readFileSync(absolute)),
    };
  });
}

function bindings(): JsonObject[] {
  return [
    ...currentBindings.map((binding) => {
      const observed = readArtifact(binding.path).hash;
      if (observed !== binding.expected)
        throw new Error(`${binding.name} identity drift: ${observed}`);
      return { name: binding.name, path: binding.path, hash: observed };
    }),
    ...externalBindings.map((binding) => {
      const artifact = readArtifact(
        path.relative(contractsRoot, path.join(repoRoot, binding.path)),
      );
      const observed = artifact.hash;
      if (observed !== binding.expected)
        throw new Error(`${binding.name} identity drift: ${observed}`);
      if (
        'expectedBundle' in binding &&
        artifact.payload.bundle_hash !== binding.expectedBundle
      ) {
        throw new Error(
          `${binding.name} bundle identity drift: ${String(artifact.payload.bundle_hash)}`,
        );
      }
      return {
        name: binding.name,
        path: binding.path,
        hash: observed,
        ...('expectedBundle' in binding
          ? { bundle_hash: binding.expectedBundle }
          : {}),
      };
    }),
  ];
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const protocol = artifact(
    'icarus.workflow-g5-basic-runtime-protocol/1',
    'icarus.workflow-g5-basic-runtime-protocol',
    'icarus:workflow-g5-basic-runtime-protocol:1\n',
    {
      gate: 'G5',
      status:
        'G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION',
      transaction_host: 'WorkflowRuntimeStore.withImmediateTransaction',
      transaction_mode: 'BEGIN IMMEDIATE',
      database_schema_version: G5_DATABASE_SCHEMA_VERSION,
      database_schema_hash: G5_DATABASE_SCHEMA_HASH,
      transaction_ids: [...G5_TRANSACTION_IDS],
      external_work_inside_transaction: 'forbidden',
      capacity_protocol: ['CAP0', 'CAP1', 'CAP2', 'CAP3', 'CAP4'],
      t5_binding:
        'sealed_plan_v2_outbox_execution_binding_exact_registry_and_immutable_policy_value',
      materialized_authority:
        'run_scope_plan_hash_plus_exact_normalized_node_plus_published_capability',
      t3_fixed_point:
        'persisted_terminal_facts_control_and_data_targets_all_join_and_plan_completion',
      t4_wait_authority:
        'sealed_wait_binding_exact_published_contract_and_two_phase_typed_authorization',
      t6d_scope: [
        'automatic_attempt_dispatch_execution_watchdog',
        'automatic_execution_retry_timer',
        'automatic_quality_revision_timer',
        'retry_schedule_consumption_primitive',
      ],
      blocker_scope: ['create', 'open_set', 'run_cache', 'workflow_cache'],
      forbidden: [
        'runtime_command_gateway',
        'runtime_command_audit',
        'T6e',
        'workflow_deadline',
        'manual_retry_bypass',
        'G6',
        'G7_projection',
        'G8',
        'G9',
      ],
      bindings: bindings(),
    },
  );
  const schema = artifact(
    'icarus.workflow-g5-basic-runtime-record-schema/1',
    'icarus.workflow-g5-basic-runtime-record-schema',
    'icarus:workflow-g5-basic-runtime-record-schema:1\n',
    {
      dialect: 'typescript_closed_record_surface',
      source: 'src/workflow-runtime/contracts/g5-basic-runtime-types.ts',
      records: [
        'Task',
        'Creation',
        'Launch',
        'Activation',
        'Manifest',
        'Fact',
        'Event',
        'Attempt',
        'Wait',
        'Effect',
        'Inbox',
        'Outbox',
        'Claim',
        'Ledger',
        'Capacity',
        'CapacityPublication',
        'Blocker',
      ],
      unknown_fields: 'rejected_at_public_ingress',
      database_schema_version: 5,
    },
  );
  const positive = artifact(
    'icarus.workflow-g5-basic-runtime-positive-cases/1',
    'icarus.workflow-g5-basic-runtime-positive-cases',
    'icarus:workflow-g5-basic-runtime-positive-cases:1\n',
    { cases: positiveCases as unknown as JsonValue },
  );
  const negative = artifact(
    'icarus.workflow-g5-basic-runtime-negative-cases/1',
    'icarus.workflow-g5-basic-runtime-negative-cases',
    'icarus:workflow-g5-basic-runtime-negative-cases:1\n',
    { cases: negativeCases as unknown as JsonValue },
  );
  const fault = artifact(
    'icarus.workflow-g5-basic-runtime-fault-cases/1',
    'icarus.workflow-g5-basic-runtime-fault-cases',
    'icarus:workflow-g5-basic-runtime-fault-cases:1\n',
    { cases: faultCases as unknown as JsonValue },
  );
  const inventory = sourceInventory();
  const implementation = artifact(
    'icarus.workflow-g5-basic-runtime-implementation/1',
    'icarus.workflow-g5-basic-runtime-implementation',
    'icarus:workflow-g5-basic-runtime-implementation:1\n',
    {
      production_target: true,
      production_ingress_enabled: false,
      source_count: inventory.length,
      sources: inventory,
      source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g5-basic-runtime-source-tree:1\n',
        inventory,
      ),
    },
  );
  const members = [
    protocol,
    schema,
    positive,
    negative,
    fault,
    implementation,
  ].map((member) => ({
    format: member.format,
    ref: member.ref,
    hash: member.hash,
  }));
  const pack = artifact(
    'icarus.workflow-contract-pack-g5-basic-runtime/1',
    'icarus.workflow-contract-pack-g5-basic-runtime',
    'icarus:workflow-contract-pack-g5-basic-runtime:1\n',
    {
      gate: 'G5',
      status:
        'G5_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_G5_WHOLE_GATE_REGRESSION',
      positive_case_count: positiveCases.length,
      negative_case_count: negativeCases.length,
      fault_case_count: faultCases.length,
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g5-basic-runtime-member-tree:1\n',
        members,
      ),
    },
  );
  return [
    [artifactPaths.protocol, protocol],
    [artifactPaths.schema, schema],
    [artifactPaths.positive, positive],
    [artifactPaths.negative, negative],
    [artifactPaths.fault, fault],
    [artifactPaths.implementation, implementation],
    [artifactPaths.pack, pack],
  ];
}

function bytes(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateG5BasicRuntimeContracts(): void {
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

export function checkG5BasicRuntimeContracts(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | undefined;
  for (const [relativePath, expected] of buildArtifacts()) {
    const absolute = path.join(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes(expected)
    ) {
      throw new Error(
        `${relativePath} is not generated byte-for-byte; run contracts:g5:generate`,
      );
    }
    parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute)),
    );
    if (relativePath === artifactPaths.pack) pack = expected;
  }
  return pack!;
}
