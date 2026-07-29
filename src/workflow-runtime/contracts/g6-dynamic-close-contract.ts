import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G6_DATABASE_SCHEMA_HASH,
  G6_DATABASE_SCHEMA_VERSION,
  G6_EXIT_STATUS,
  G6_FIXTURE_BINDING_DOMAIN,
  G6_PERSISTENT_MODE_POLICY,
} from './g6-dynamic-close-types.js';
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

export const G6_IMPLEMENTATION_SOURCE_PATHS = [
  'src/workflow-runtime/runtime/basic-scheduler.ts',
  'src/workflow-runtime/runtime/child-runtime.ts',
  'src/workflow-runtime/runtime/graph-runtime.ts',
  'src/workflow-runtime/runtime/graph-store.ts',
  'src/workflow-runtime/runtime/ledger.ts',
  'src/workflow-runtime/runtime/lifecycle.ts',
  'src/workflow-runtime/runtime/plan-authority.ts',
  'src/workflow-runtime/runtime/reconciler.ts',
  'src/workflow-runtime/runtime/root-finalizer.ts',
] as const;

const evidenceSourcePaths = [
  'src/workflow-runtime/contracts/g6-dynamic-close-types.ts',
  'src/workflow-runtime/contracts/g6-dynamic-close-contract.ts',
  'src/workflow-runtime/contracts/g6-dynamic-close-contract-cli.ts',
  'src/workflow-runtime/contracts/g6-dynamic-close-contract.test.ts',
  'src/workflow-runtime/contracts/g6-dynamic-close-reference-model.ts',
  'src/workflow-runtime/contracts/g6-dynamic-close-reference-model.test.ts',
  'src/workflow-runtime/contracts/g6-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/runtime/g6-test-support.ts',
  'src/workflow-runtime/runtime/g6-dynamic-close.test.ts',
] as const;

const exactBindings = [
  {
    name: 'g5_basic_runtime',
    path: 'src/workflow-runtime/contracts/contract-pack-g5-basic-runtime-repair.json',
    hash: 'sha256:c4fc33c361c4f7e4b62f1848518fade64d15b143ddff711b988a147e28f2ba9c',
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
    name: 'r022_domain_claim_handoff',
    path: 'src/workflow-runtime/contracts/contract-pack-r022-domain-claim-handoff.json',
    hash: 'sha256:ea97a3d52a2e4a14fb2671b2191b1b1cb6acc22c4ecded7db2e141a1716b516e',
  },
  {
    name: 'database_schema_11',
    path: 'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema-v11.json',
    hash: 'sha256:2adb9376d341ad430155829647086bcc76f84ebf22dffac28c19d4026ea06ab2',
  },
] as const;

export type G6FixtureCategory = 'positive' | 'negative' | 'fault';

interface FixtureSeed {
  readonly caseId: string;
  readonly transaction: string;
  readonly assertion: string;
  readonly expected: 'committed' | 'rejected' | 'rolled_back' | 'exact_replay';
  readonly exactError?: string;
}

export interface G6FixtureBindingInput extends JsonObject {
  readonly case_id: string;
  readonly category: G6FixtureCategory;
  readonly transaction: string;
  readonly assertion: string;
  readonly handler: string;
  readonly operation: JsonObject;
  readonly oracle: JsonObject;
}

export interface G6FixtureCase extends G6FixtureBindingInput {
  readonly binding_hash: Sha256Hash;
}

const positiveSeeds: readonly FixtureSeed[] = [
  [
    'subgraph_static_child_authority',
    'T4/T2b/T7b',
    'static subgraph binds exact precompiled Plan and publishes one owner output',
  ],
  [
    'expand_dynamic_child_authority',
    'T4/T2a/T2b/T7b',
    'expand freezes source and policy before pinned dynamic compile and materialization',
  ],
  [
    'map_manifest_slots',
    'T4',
    'map freezes collection and creates every ordered result slot atomically',
  ],
  [
    'empty_map_all_settled',
    'T4/T7b',
    'empty all-settled map publishes an immutable empty result manifest',
  ],
  [
    'empty_map_all_accepted',
    'T4/T7b',
    'empty all-accepted map publishes an immutable empty result manifest',
  ],
  [
    'empty_map_quorum_impossible',
    'T4/T7b',
    'positive finite quorum on an empty map terminalizes impossible',
  ],
  [
    'map_build_failure_policy',
    'T2a/T7b',
    'map build failure writes errored null-scope slot and reevaluates policy',
  ],
  [
    'map_quorum_order',
    'T7b',
    'quorum selection freezes completion-seq then item-index order',
  ],
  [
    'map_fail_fast',
    'T7a/T7b',
    'first rejected child freezes losers and late cuts cannot publish',
  ],
  [
    'hierarchical_scope_fence',
    'T7a',
    'one transaction closes target subtree, advances epochs, and writes fence manifest',
  ],
  [
    'ancestor_preserves_child_close',
    'T7a',
    'ancestor fences only open scopes and preserves closed child close and Cut authority byte-exact',
  ],
  [
    'compensation_barrier',
    'T7a/T7b/T8',
    'only compensated or compensation-not-required effects pass a Cut barrier',
  ],
  [
    'child_exact_consumption',
    'T7b',
    'child Cut and R-020/R-021 parent consumption commit together exactly once',
  ],
  [
    'parent_fenced_non_publish',
    'T7b',
    'parent or owner fence records immutable non-publish disposition',
  ],
  [
    'root_terminal_error',
    'T8',
    'engine-error route creates terminal activation and one transition checkpoint',
  ],
  [
    'root_global_cancel',
    'T8',
    'workflow cancel terminates without Definition route fallback',
  ],
  [
    'root_nonterminal_transition',
    'T8/T1',
    'nonterminal route reuses T1 core and writes one combined checkpoint',
  ],
  [
    'root_finalization_retry_ready',
    'RootFinalization',
    'finite schedule attempt advances retry or becomes ready without child creation',
  ],
  [
    'required_child_atomic_handoff',
    'T0p/T8',
    'required child, relation, schedule, and R-022 claim handoff commit atomically',
  ],
  [
    'best_effort_child_outbox',
    'T8',
    'best-effort child writes deterministic outbox without blocking parent Cut',
  ],
  [
    'commit_reopen_exact_replay',
    'T7a/T7b/T8',
    'committed close lineage reopens and replays without duplicate writes',
  ],
].map(([caseId, transaction, assertion]) => ({
  caseId,
  transaction,
  assertion,
  expected: 'committed' as const,
}));

const negativeSeeds: readonly FixtureSeed[] = [
  [
    'stale_run_version',
    'T7a',
    'stale Run row version rejects before writes',
    'cas_conflict',
  ],
  [
    'stale_scope_version',
    'T7a',
    'stale Scope row version rejects before writes',
    'cas_conflict',
  ],
  [
    'stale_run_fence',
    'T7a',
    'stale Run work epoch cannot cross close fence',
    'cas_conflict',
  ],
  [
    'stale_scope_fence',
    'T7a',
    'stale Scope work epoch cannot cross close fence',
    'cas_conflict',
  ],
  [
    'close_cause_replay_drift',
    'T7a',
    'replay with different close cause is an idempotency conflict',
    'idempotency_conflict',
  ],
  [
    'static_plan_binding_drift',
    'T4',
    'static subgraph or map body Plan drift rejects',
    'integrity_violation',
  ],
  [
    'dynamic_source_hash_drift',
    'T2a',
    'dynamic compile source hash drift rejects',
    'integrity_violation',
  ],
  [
    'dynamic_policy_widening',
    'T2a',
    'dynamic plan cannot widen the compiled child policy',
    'integrity_violation',
  ],
  ['stale_build_version', 'T2a/T2b', 'stale build CAS rejects', 'cas_conflict'],
  [
    'stale_owner_node_version',
    'T4/T2b',
    'stale controller node CAS rejects',
    'cas_conflict',
  ],
  [
    'duplicate_map_item_key',
    'T4',
    'duplicate map key cannot create two slots',
    'contract_invalid',
  ],
  [
    'invalid_quorum',
    'T4',
    'nonpositive or nonfinite quorum rejects',
    'contract_invalid',
  ],
  [
    'child_cut_before_compensation',
    'T7b',
    'unsettled required compensation blocks child Cut',
    'precondition_failed',
  ],
  [
    'root_cut_before_descendants',
    'T8',
    'open descendant blocks root Cut',
    'precondition_failed',
  ],
  [
    'root_cut_before_compensation',
    'T8',
    'unsettled compensation blocks root Cut',
    'precondition_failed',
  ],
  [
    'wrong_route_source',
    'T8',
    'route source must match root outcome authority',
    'precondition_failed',
  ],
  [
    'wrong_definition_target',
    'T8',
    'target state must equal published route target',
    'integrity_violation',
  ],
  [
    'wrong_target_kind',
    'T8',
    'terminal versus graph kind must equal published Definition',
    'integrity_violation',
  ],
  [
    'stale_workflow_version',
    'T8',
    'stale Workflow row version rejects',
    'cas_conflict',
  ],
  [
    'stale_activation_version',
    'T8',
    'stale source Activation row version rejects',
    'cas_conflict',
  ],
  [
    'missing_required_schedule',
    'T8',
    'every required effect needs exact ready Schedule provenance',
    'precondition_failed',
  ],
  [
    'required_effect_set_drift',
    'T8',
    'caller required effects must equal published transition effects',
    'integrity_violation',
  ],
  [
    'best_effort_effect_set_drift',
    'T8',
    'caller best-effort effects must equal published transition effects',
    'integrity_violation',
  ],
  [
    'required_claim_head_stale',
    'T8/R-022',
    'stale Claim or Resource Head tuple rolls back the entire T8',
    'cas_conflict',
  ],
  [
    't8_replay_intent_drift',
    'T8',
    'route target child and outbox replay intent must be exact',
    'idempotency_conflict',
  ],
  [
    'g7_gateway_surface_forbidden',
    'boundary',
    'G6 cannot create Gateway Command Invocation T7c or T6e behavior',
    'forbidden_surface',
  ],
].map(([caseId, transaction, assertion, exactError]) => ({
  caseId,
  transaction,
  assertion,
  exactError,
  expected: 'rejected' as const,
}));

const faultSeeds: readonly FixtureSeed[] = [
  [
    'fault_before_commit_t4',
    'T4',
    'expansion manifest and slots fully roll back',
  ],
  [
    'fault_before_commit_t2a',
    'T2a',
    'dynamic compile success or failure fully rolls back',
  ],
  [
    'fault_before_commit_t2b',
    'T2b',
    'scope materialization and Run Manifest fully roll back',
  ],
  [
    'fault_before_commit_t7a',
    'T7a',
    'close request epochs fences cleanup and manifest fully roll back',
  ],
  [
    'fault_before_commit_t7b',
    'T7b',
    'child Cut slot and consumption fully roll back',
  ],
  [
    'fault_before_commit_finalization',
    'RootFinalization',
    'attempt history schedule and blocker fully roll back',
  ],
  [
    'fault_before_commit_t8',
    'T8',
    'Cut activation transition child claim outbox and checkpoint fully roll back',
  ],
  [
    'response_loss_t7a',
    'T7a',
    'reopen returns exact close and verifies manifest identities',
  ],
  [
    'response_loss_t7b',
    'T7b',
    'reopen returns exact child Cut and consumption',
  ],
  [
    'response_loss_t8',
    'T8',
    'reopen returns exact root Cut transition children and checkpoint',
  ],
  [
    'tamper_subtree_manifest',
    'T7a',
    'canonical Value or composite fence tamper fails closed',
  ],
  [
    'tamper_root_cut',
    'T8',
    'Cut hash or transition authority tamper fails closed',
  ],
].map(([caseId, transaction, assertion], index) => ({
  caseId,
  transaction,
  assertion,
  expected: index < 7 ? ('rolled_back' as const) : ('exact_replay' as const),
  exactError: index < 7 ? 'fault_injected' : undefined,
}));

function handlerFor(transaction: string): string {
  return `g6_${transaction
    .toLowerCase()
    .replaceAll('/', '_')
    .replaceAll(/[^a-z0-9_]+/g, '_')}_production`;
}

export function calculateG6FixtureBindingHash(
  fixture: G6FixtureBindingInput,
): Sha256Hash {
  return domainSeparatedSha256(G6_FIXTURE_BINDING_DOMAIN, fixture);
}

function buildFixture(
  seed: FixtureSeed,
  category: G6FixtureCategory,
): G6FixtureCase {
  const withoutHash: G6FixtureBindingInput = {
    case_id: seed.caseId,
    category,
    transaction: seed.transaction,
    assertion: seed.assertion,
    handler: handlerFor(seed.transaction),
    operation: {
      scenario_key: `g6:${category}:${seed.caseId}`,
      database: 'isolated_real_file_sqlite',
      transaction_mode: 'BEGIN_IMMEDIATE',
      virtual_clock_ms: 1_781_000_000_000,
      fake_adapter_only: true,
      fault_point:
        category === 'fault' && seed.expected === 'rolled_back'
          ? 'before_commit'
          : null,
      reopen: category === 'fault' || seed.expected === 'exact_replay',
    },
    oracle: {
      disposition: seed.expected,
      sqlite_state:
        seed.expected === 'committed' || seed.expected === 'exact_replay'
          ? 'committed'
          : 'unchanged',
      exact_error: seed.exactError ?? null,
      duplicate_writes: 0,
    },
  };
  return {
    ...withoutHash,
    binding_hash: calculateG6FixtureBindingHash(withoutHash),
  };
}

export const G6_POSITIVE_FIXTURES = positiveSeeds.map((seed) =>
  buildFixture(seed, 'positive'),
);
export const G6_NEGATIVE_FIXTURES = negativeSeeds.map((seed) =>
  buildFixture(seed, 'negative'),
);
export const G6_FAULT_FIXTURES = faultSeeds.map((seed) =>
  buildFixture(seed, 'fault'),
);

const artifactPaths = {
  protocol: 'conformance/g6-dynamic-close/g6-dynamic-close-protocol@1.json',
  positive: 'conformance/g6-dynamic-close/positive-cases.json',
  negative: 'conformance/g6-dynamic-close/negative-cases.json',
  fault: 'conformance/g6-dynamic-close/fault-cases.json',
  reference:
    'conformance/g6-dynamic-close/g6-dynamic-close-reference-authority@1.json',
  implementation: 'implementation/g6-dynamic-close-implementation@1.json',
  pack: 'contract-pack-g6-dynamic-close.json',
} as const;

function rawSha256(bytes: Buffer | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function inventory(paths: readonly string[]): JsonObject[] {
  return paths.map((relativePath) => {
    const absolute = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolute))
      throw new Error(`Missing G6 source ${relativePath}`);
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
    const observed = parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(path.join(repoRoot, binding.path))),
    );
    if (observed.hash !== binding.hash)
      throw new Error(`${binding.name} identity drift: ${observed.hash}`);
    return { ...binding };
  });
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const upstream = bindings();
  const protocol = artifact(
    'icarus.workflow-g6-dynamic-close-protocol/1',
    'icarus.workflow-g6-dynamic-close-protocol',
    'icarus:workflow-g6-dynamic-close-protocol:1\n',
    {
      gate: 'G6',
      status: G6_EXIT_STATUS,
      persistent_mode_policy: G6_PERSISTENT_MODE_POLICY,
      database_schema_version: G6_DATABASE_SCHEMA_VERSION,
      database_schema_hash: G6_DATABASE_SCHEMA_HASH,
      transaction_host: 'WorkflowRuntimeStore.withImmediateTransaction',
      transaction_mode: 'BEGIN_IMMEDIATE',
      owned_transactions: [
        'T4_dynamic',
        'T2a_dynamic',
        'T2b_dynamic',
        'T7a',
        'T7b',
        'T8',
      ],
      owned_semantics: [
        'subgraph_expand_map_materialization',
        'child_scope_provenance_and_append_only_run_manifest',
        'map_all_settled_all_accepted_quorum_fail_fast',
        'hierarchical_work_fence_and_close_cleanup',
        'required_compensation_barrier',
        'root_finalization_schedule',
        'required_child_t0p_t0_t1_r022_handoff',
        'best_effort_child_outbox',
        'root_cut_activation_transition_context_checkpoint',
      ],
      exact_replay: [
        'caller_intent',
        'canonical_value_bytes',
        'manifest_and_cut_hashes',
        'route_and_target',
        'child_and_outbox_effect_sets',
      ],
      forbidden: [
        'T7c',
        'Gateway',
        'Command_Invocation_audit',
        'System_Grant',
        'T6e_resolution_or_abandon',
        'workflow_deadline',
        'authorized_manual_retry',
        'Recovery',
        'Card',
        'Projection',
        'certification',
        'Production_loader_activation_ingress_network',
        'real_Adapter_or_user_data',
      ],
      bindings: upstream,
    },
  );
  const positive = artifact(
    'icarus.workflow-g6-dynamic-close-positive-cases/1',
    'icarus.workflow-g6-dynamic-close-positive-cases',
    'icarus:workflow-g6-dynamic-close-positive-cases:1\n',
    { cases: G6_POSITIVE_FIXTURES as unknown as JsonValue },
  );
  const negative = artifact(
    'icarus.workflow-g6-dynamic-close-negative-cases/1',
    'icarus.workflow-g6-dynamic-close-negative-cases',
    'icarus:workflow-g6-dynamic-close-negative-cases:1\n',
    { cases: G6_NEGATIVE_FIXTURES as unknown as JsonValue },
  );
  const fault = artifact(
    'icarus.workflow-g6-dynamic-close-fault-cases/1',
    'icarus.workflow-g6-dynamic-close-fault-cases',
    'icarus:workflow-g6-dynamic-close-fault-cases:1\n',
    { cases: G6_FAULT_FIXTURES as unknown as JsonValue },
  );
  const evidence = inventory(evidenceSourcePaths);
  const reference = artifact(
    'icarus.workflow-g6-dynamic-close-reference-authority/1',
    'icarus.workflow-g6-dynamic-close-reference-authority',
    'icarus:workflow-g6-dynamic-close-reference-authority:1\n',
    {
      independent_from_runtime: true,
      map_policy_model: 'completion_seq_then_item_index',
      hierarchical_close_model:
        'preserve_closed_descendant_authority_fence_open_only',
      property_tests: true,
      real_file_sqlite_runtime_evidence: true,
      virtual_clock_and_fake_adapter_only: true,
      evidence,
      evidence_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g6-dynamic-close-evidence-tree:1\n',
        evidence,
      ),
    },
  );
  const sources = inventory(G6_IMPLEMENTATION_SOURCE_PATHS);
  const implementation = artifact(
    'icarus.workflow-g6-dynamic-close-implementation/1',
    'icarus.workflow-g6-dynamic-close-implementation',
    'icarus:workflow-g6-dynamic-close-implementation:1\n',
    {
      production_target: true,
      production_ingress_enabled: false,
      production_implementation_count: sources.length,
      sources,
      source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g6-dynamic-close-source-tree:1\n',
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
    'icarus.workflow-contract-pack-g6-dynamic-close/1',
    'icarus.workflow-contract-pack-g6-dynamic-close',
    'icarus:workflow-contract-pack-g6-dynamic-close:1\n',
    {
      gate: 'G6',
      status: G6_EXIT_STATUS,
      g6_state: 'IN_PROGRESS',
      g6_done: false,
      g7_through_g9: 'NOT_READY',
      persistent_mode_policy: G6_PERSISTENT_MODE_POLICY,
      production_implementation_count: G6_IMPLEMENTATION_SOURCE_PATHS.length,
      positive_case_count: G6_POSITIVE_FIXTURES.length,
      negative_case_count: G6_NEGATIVE_FIXTURES.length,
      fault_case_count: G6_FAULT_FIXTURES.length,
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(
        'icarus:workflow-g6-dynamic-close-member-tree:1\n',
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

export function generateG6DynamicCloseContracts(): void {
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

export function checkG6DynamicCloseContracts(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | null = null;
  for (const [relativePath, expected] of buildArtifacts()) {
    const absolute = path.join(contractsRoot, relativePath);
    if (
      !fs.existsSync(absolute) ||
      fs.readFileSync(absolute, 'utf8') !== bytes(expected)
    )
      throw new Error(
        `${relativePath} is not generated byte-for-byte; run contracts:g6:generate`,
      );
    parseContractArtifactEnvelope(
      strictParseJsonBytes(fs.readFileSync(absolute)),
    );
    if (relativePath === artifactPaths.pack) pack = expected;
  }
  if (pack === null)
    throw new Error('G6 Dynamic / Close Contract Pack is missing');
  return pack;
}
