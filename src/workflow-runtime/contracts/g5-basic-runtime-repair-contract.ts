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
  'src/workflow-runtime/runtime/g5-basic-runtime.test.ts',
] as const;

const exactBindings = [
  {
    name: 'r019_generated_schema_join_authority',
    path: 'src/workflow-runtime/contracts/conformance/generated-schema-join-authority-repair/contract-pack-generated-schema-join-authority-repair.json',
    hash: 'sha256:0c9b1a04a013bf6284b36c550ead6d81cffecacbe4a9d6495d6153b2335a04fc',
  },
  {
    name: 'database_schema_6',
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema.json',
    hash: 'sha256:3cc206a6dfb1bbaed1bb0f4305323729db23d839652d8a0e020a9a6c4d3e3dd6',
  },
  {
    name: 'g2_v5_sealed_compiler_plan',
    path: 'src/workflow-runtime/contracts/conformance/sealed/g2-generated-schema-join-authority-v5/golden-conformance-bundle@2.json',
    hash: 'sha256:f59040be6f71d8655afcb11ab4527a6683125a7a4e683f1e734b44448f7bb72e',
    bundleHash:
      'sha256:b37ddf415d12d759ddd4b72b754568e01715704d254da26e3355e0898cfeda05',
  },
  {
    name: 'g3_registry_publish_foundation',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-publish-foundation.json',
    hash: 'sha256:c9364171a3d28a752d4510f59e5e45016cd86be14d7e151b483fc0c6c7a2807d',
  },
  {
    name: 'g3_registry_persistence',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-persistence.json',
    hash: 'sha256:590acdd52626838bf30ae14bb04b6f0ee59a95e1efadc4911ff850acc2970763',
  },
  {
    name: 'g3_registry_exact_query',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-registry-exact-resource-query.json',
    hash: 'sha256:b6a4ec1dac738c6036869c763708f8aa144d0a864c8c392ee18cb3aba8c83417',
  },
  {
    name: 'g3_retention_executor_preflight',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-retention-executor-abi-preflight.json',
    hash: 'sha256:7f807ae53e13bcec7712f77c1ebaba7aab5f72d2779ed5d99d33b0e6c54e98d3',
  },
  {
    name: 'g3_workflow_publisher',
    path: 'src/workflow-runtime/contracts/contract-pack-g3-workflow-publisher.json',
    hash: 'sha256:5d023a5323aec482781b0e992197571db9a09481a394eaf955d4598c249e4ec1',
  },
  {
    name: 'g3_feature_release_activation',
    path: 'src/workflow-runtime/contracts/contract-pack-g3.9-feature-release-activation.json',
    hash: 'sha256:cbb6b355819b1eefefa7af5289b10b367c42bbe32b09f003151bc7f9ebf475d7',
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
    case_id: 'sealed_plan_generated_binding',
    surface: 'T2a',
    assertion: 'exact generated content and Plan bindings persist atomically',
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
    case_id: 'sqlite_reopen_response_loss',
    surface: 'T4',
    assertion: 'response-loss replay is exact before and after Store reopen',
    expected: 'replayed',
  },
] as const;

const negativeCases: readonly RepairCase[] = [
  [
    'missing_generated_pair',
    'persisted content or Plan binding pair is absent',
  ],
  ['unknown_generated_scheme', 'generated schema ref scheme is unknown'],
  ['generated_raw_hash_drift', 'canonical bytes and raw hash disagree'],
  ['generated_domain_hash_drift', 'schema domain hash disagrees'],
  ['generated_parameter_drift', 'join expose parameter hash disagrees'],
  ['sealed_plan_binding_drift', 'persisted Plan bytes or hash disagree'],
  ['schema_authority_mismatch', 'Value authority and envelope port disagree'],
  ['join_expose_shape_mismatch', 'expose and output port sets disagree'],
  ['required_output_absent', 'required output cannot be absent'],
  ['output_schema_invalid', 'output content violates the generated schema'],
  ['output_max_bytes_exceeded', 'output content exceeds the compiled maximum'],
  ['port_contract_hash_drift', 'materialized port contract hash disagrees'],
  [
    'registry_latest_fallback',
    'Registry latest or network fallback is forbidden',
  ],
  ['input_snapshot_publication', 'input snapshot cannot masquerade as output'],
].map(
  ([caseId, assertion]): RepairCase => ({
    case_id: caseId!,
    surface: 'T2a_T3a_T4',
    assertion: assertion!,
    expected: 'rejected',
  }),
);

const faultCases: readonly RepairCase[] = [
  {
    case_id: 'fault_t2a_before_commit',
    surface: 'T2a',
    assertion: 'Plan, generated content, and bindings roll back together',
    expected: 'rolled_back',
  },
  {
    case_id: 'fault_t3a_before_commit',
    surface: 'T3a',
    assertion: 'aggregated generated Value and readiness roll back together',
    expected: 'rolled_back',
  },
  {
    case_id: 'fault_t4_before_commit',
    surface: 'T4',
    assertion:
      'port Values, envelope, Node, Event, and candidate roll back together',
    expected: 'rolled_back',
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
        'plan_generated_only_without_registry_fabrication',
      output_publication:
        'canonical_node_output_envelope_with_exact_port_values',
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
        'sha256:bd7b944c66181e05add3618e6355a1acc64ff452dc4c027d4556c776a4402046',
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
