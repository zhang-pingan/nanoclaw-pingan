import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compileWorkflow } from '../compiler/compiler.js';
import {
  buildWorkflowCompilerToolchainManifest,
  workflowCompilerIdentity,
} from '../compiler/identity.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import {
  canonicalJson,
  calculateArtifactHash,
  domainSeparatedSha256,
} from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');
const root = 'conformance/static-child-plan-bundle-repair';

export const STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS = Object.freeze({
  protocol: `${root}/static-child-plan-bundle-protocol@1.json`,
  positive: `${root}/positive-cases.json`,
  negative: `${root}/negative-cases.json`,
  fault: `${root}/fault-cases.json`,
  evidence: `${root}/static-child-plan-bundle-evidence@1.json`,
  pack: `${root}/contract-pack-static-child-plan-bundle-repair.json`,
});

export const STATIC_CHILD_PLAN_BUNDLE_REPAIR_SOURCE_PATHS = [
  'src/workflow-runtime/contracts/static-child-plan-bundle-types.ts',
  'src/workflow-runtime/compiler/compiler.ts',
  'src/workflow-runtime/compiler/identity.ts',
  'src/workflow-runtime/compiler/types.ts',
  'src/workflow-runtime/runtime/static-child-plan-bundle.ts',
  'src/workflow-runtime/runtime/reconciler.ts',
] as const;

export const STATIC_CHILD_PLAN_BUNDLE_REPAIR_EVIDENCE_PATHS = [
  'src/workflow-runtime/compiler/g2-v6-frozen-replay.ts',
  'src/workflow-runtime/compiler/static-child-plan-bundle.test.ts',
  'src/workflow-runtime/runtime/g5-basic-runtime.test.ts',
] as const;

const PREDECESSOR_SEAL_PATH =
  'src/workflow-runtime/contracts/conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json';
const PREDECESSOR_SEAL_HASH =
  'sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11';
const PREDECESSOR_BUNDLE_HASH =
  'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7';
const SNAPSHOT_DOMAIN = 'icarus:workflow-compiler-input-snapshot:2\n';
const ARCHITECTURE_PATH = 'local/docs/dynamic-workflow-dag-framework.md';
const STATUS =
  'DIRECTED_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION';

interface CaseSeed extends JsonObject {
  case_id: string;
  assertion: string;
}

const positiveCases: readonly CaseSeed[] = [
  {
    case_id: 'compiler_nested_bundle_parent_exact',
    assertion:
      'pure Compiler returns nested child source and Plan bytes while the fixed-identity parent remains exact',
  },
  {
    case_id: 'compiler_shared_content_address',
    assertion:
      'two closure members may share one byte-identical descendant Plan hash',
  },
  {
    case_id: 't2a_atomic_parent_child_schema_persistence',
    assertion:
      'T2a atomically persists parent, unique child Plans, and every generated-schema authority',
  },
  {
    case_id: 't2a_replay_reopen_response_loss',
    assertion:
      'exact replay and reopen perform zero identity drift after response loss',
  },
] as const;

const negativeCases: readonly CaseSeed[] = [
  ['bundle_missing_member', 'missing closure member fails before SQLite'],
  ['bundle_extra_member', 'extra closure member fails before SQLite'],
  ['bundle_duplicate_member', 'duplicate closure member fails before SQLite'],
  ['bundle_order_drift', 'bundle order differing from parent closure fails'],
  ['bundle_closure_alias', 'closure-key alias fails'],
  ['bundle_unknown_field', 'unknown bundle or entry field fails closed'],
  ['bundle_source_tamper', 'child source bytes/hash mismatch fails'],
  ['bundle_plan_tamper', 'child canonical Plan bytes/hash mismatch fails'],
  [
    'bundle_nested_lineage_tamper',
    'nested child closure lineage mismatch fails',
  ],
  [
    'bundle_toolchain_safety_drift',
    'child toolchain or safety authority drift fails',
  ],
  [
    'persisted_plan_collision',
    'same content-addressed identity with different bytes fails',
  ],
  [
    'persisted_child_schema_binding_missing',
    'missing child generated-schema binding fails exact replay',
  ],
].map(([case_id, assertion]) => ({ case_id, assertion })) as CaseSeed[];

const faultCases: readonly CaseSeed[] = [
  [
    'fault_before_first_write',
    'fault before first write leaves Plan and binding tables unchanged',
  ],
  [
    'fault_before_commit',
    'fault after all inserts and before commit rolls back the complete bundle',
  ],
  [
    'stale_build_row_version',
    'stale build row version performs no Plan writes',
  ],
  [
    'stale_compile_lease',
    'stale compile lease owner, token, or expiry performs no Plan writes',
  ],
  ['stale_work_fence', 'stale run or scope work fence performs no Plan writes'],
  [
    'reopen_tamper_recovery',
    'reopen replay detects Plan or generated-schema tamper without repair',
  ],
].map(([case_id, assertion]) => ({ case_id, assertion })) as CaseSeed[];

function bytes(relativePath: string): Buffer {
  return fs.readFileSync(path.join(repoRoot, relativePath));
}

function rawHash(value: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function artifact(
  format: string,
  id: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const ref = { id, version: '1.0.0' };
  const base = {
    format,
    ref,
    version: 1,
    domain_separator: domain,
    payload,
  };
  return {
    ...base,
    hash: calculateArtifactHash({
      ...base,
      hash: `sha256:${'0'.repeat(64)}`,
    }),
  };
}

function inventory(paths: readonly string[]) {
  return [...paths]
    .sort()
    .map((entry) => ({ path: entry, raw_sha256: rawHash(bytes(entry)) }));
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(bytes(relativePath)),
  );
}

function withoutCompilerIdentity(plan: JsonObject): JsonObject {
  const copy = structuredClone(plan);
  const strip = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      for (const child of value) strip(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (
        [
          'plan_hash',
          'plan_ref',
          'precompiled_plan_hash',
          'member_hash',
          'closure_hash',
          'compiler_version',
          'compiler_build_hash',
          'compiler_toolchain_ref',
          'compiler_toolchain_hash',
        ].includes(key)
      ) {
        delete value[key];
      } else {
        strip(value[key] as JsonValue);
      }
    }
  };
  strip(copy);
  return copy;
}

function compilerEvidence(): JsonObject {
  const fixtureRoot =
    'src/workflow-runtime/contracts/conformance/sealed/g2-generated-schema-join-authority-v6';
  const source = strictParseJsonBytes(
    bytes(`${fixtureRoot}/inputs/positive.static-child-closure.source.json`),
  ) as JsonObject;
  const snapshotArtifact = readArtifact(
    `${fixtureRoot}/inputs/positive.static-child-closure.snapshot@2.json`,
  );
  const predecessorPlan = strictParseJsonBytes(
    bytes(`${fixtureRoot}/expected/positive.static-child-closure.plan.json`),
  ) as JsonObject;
  const predecessor = compileWorkflow({
    caseId: 'static-child-plan-bundle-predecessor-exact',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source)),
    inputSnapshot: snapshotArtifact.payload,
    identity: snapshotArtifact.payload
      .compiler_identity as unknown as ReturnType<
      typeof workflowCompilerIdentity
    >,
  });
  if (
    !predecessor.ok ||
    canonicalJson(predecessor.value.plan) !== canonicalJson(predecessorPlan)
  ) {
    throw new Error(
      'Static child bundle repair changed the fixed v6 parent Plan',
    );
  }

  const toolchain = buildWorkflowCompilerToolchainManifest();
  const identity = workflowCompilerIdentity(toolchain);
  const { snapshot_hash: _snapshotHash, ...snapshotWithoutHash } =
    snapshotArtifact.payload;
  void _snapshotHash;
  const currentSnapshotWithoutHash = {
    ...snapshotWithoutHash,
    compiler_identity: identity as unknown as JsonObject,
  };
  const currentSnapshot = {
    ...currentSnapshotWithoutHash,
    snapshot_hash: domainSeparatedSha256(
      SNAPSHOT_DOMAIN,
      currentSnapshotWithoutHash as JsonObject,
    ),
  };
  const current = compileWorkflow({
    caseId: 'static-child-plan-bundle-current',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source)),
    inputSnapshot: currentSnapshot,
    identity,
  });
  if (!current.ok)
    throw new Error('Current static child bundle fixture rejected');
  if (
    canonicalJson(withoutCompilerIdentity(current.value.plan)) !==
    canonicalJson(withoutCompilerIdentity(predecessorPlan))
  ) {
    throw new Error('Static child bundle repair changed parent Plan lowering');
  }
  const entries = current.value.staticChildPlanBundle.entries.map((entry) => ({
    closure_key: entry.closureKey,
    source_hash: domainSeparatedSha256(
      'icarus:workflow-graph-source:1\n',
      entry.source,
    ),
    plan_hash: entry.plan.plan_hash,
    canonical_plan_raw_sha256: rawHash(
      Buffer.from(canonicalJson(entry.plan), 'utf8'),
    ),
  }));
  return {
    compiler_version: identity.compiler_version,
    compiler_build_hash: identity.compiler_build_hash,
    compiler_toolchain_hash: identity.compiler_toolchain_hash,
    predecessor_parent_plan_exact: true,
    predecessor_parent_plan_hash: predecessor.value.plan.plan_hash,
    current_parent_plan_lowering_exact_excluding_compiler_and_content_identities: true,
    current_parent_plan_hash: current.value.plan.plan_hash,
    bundle_format: current.value.staticChildPlanBundle.format,
    bundle_entries: entries,
    bundle_entry_count: entries.length,
  };
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const predecessor = readArtifact(PREDECESSOR_SEAL_PATH);
  if (
    predecessor.hash !== PREDECESSOR_SEAL_HASH ||
    predecessor.payload.bundle_hash !== PREDECESSOR_BUNDLE_HASH
  ) {
    throw new Error('G2 v6 predecessor seal identity drifted');
  }
  const protocol = artifact(
    'icarus.workflow-static-child-plan-bundle-protocol/1',
    'icarus.workflow-static-child-plan-bundle-protocol',
    'icarus:workflow-static-child-plan-bundle-protocol:1\n',
    {
      status: STATUS,
      parent_plan_format: 'icarus.workflow-graph-scope-plan/2',
      bundle_format: 'icarus.workflow-compiler-static-child-plan-bundle/1',
      bundle_entry_exact_keys: ['closureKey', 'source', 'plan'],
      parent_plan_canonical_bytes_unchanged_for_fixed_identity: true,
      persistence_transaction: 'T2a',
      persistence_semantics:
        'parent_plus_all_missing_unique_static_children_and_generated_schema_authorities',
      replay_semantics: 'verify_exact_zero_dml',
      forbidden: [
        'runtime_recompile',
        'moving_registry_resolution',
        'latest_or_fallback_resolution',
        'hash_manifest_plan_synthesis',
        'embedded_second_golden_oracle',
      ],
    },
  );
  const caseArtifact = (category: string, cases: readonly CaseSeed[]) =>
    artifact(
      `icarus.workflow-static-child-plan-bundle-${category}-cases/1`,
      `icarus.workflow-static-child-plan-bundle-${category}-cases`,
      `icarus:workflow-static-child-plan-bundle-${category}-cases:1\n`,
      { cases: cases as unknown as JsonValue, case_count: cases.length },
    );
  const positive = caseArtifact('positive', positiveCases);
  const negative = caseArtifact('negative', negativeCases);
  const fault = caseArtifact('fault', faultCases);
  const sources = inventory(STATIC_CHILD_PLAN_BUNDLE_REPAIR_SOURCE_PATHS);
  const evidenceSources = inventory(
    STATIC_CHILD_PLAN_BUNDLE_REPAIR_EVIDENCE_PATHS,
  );
  const evidence = artifact(
    'icarus.workflow-static-child-plan-bundle-evidence/1',
    'icarus.workflow-static-child-plan-bundle-evidence',
    'icarus:workflow-static-child-plan-bundle-evidence:1\n',
    {
      compiler: compilerEvidence(),
      architecture_ref: ARCHITECTURE_PATH,
      architecture_raw_sha256: rawHash(bytes(ARCHITECTURE_PATH)),
      real_file_sqlite: true,
      generated_schema_authority_verified_per_unique_plan: true,
      production_sources: sources,
      production_source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-static-child-plan-bundle-source-tree:1\n',
        sources,
      ),
      evidence_sources: evidenceSources,
      evidence_source_tree_hash: domainSeparatedSha256(
        'icarus:workflow-static-child-plan-bundle-evidence-tree:1\n',
        evidenceSources,
      ),
    },
  );
  const members = [protocol, positive, negative, fault, evidence].map(
    (member) => ({ format: member.format, ref: member.ref, hash: member.hash }),
  );
  const pack = artifact(
    'icarus.workflow-contract-pack-static-child-plan-bundle-repair/1',
    'icarus.workflow-contract-pack-static-child-plan-bundle-repair',
    'icarus:workflow-contract-pack-static-child-plan-bundle-repair:1\n',
    {
      gates: ['G2', 'G5'],
      status: STATUS,
      predecessor_g2_v6_seal_ref: PREDECESSOR_SEAL_PATH,
      predecessor_g2_v6_seal_hash: PREDECESSOR_SEAL_HASH,
      predecessor_g2_v6_bundle_hash: PREDECESSOR_BUNDLE_HASH,
      g2_g5_closed: false,
      g6_ready: false,
      independent_review_required: true,
      member_count: members.length,
      members,
      member_tree_hash: domainSeparatedSha256(
        'icarus:workflow-static-child-plan-bundle-member-tree:1\n',
        members,
      ),
    },
  );
  return [
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.protocol, protocol],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.positive, positive],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.negative, negative],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.fault, fault],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.evidence, evidence],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack, pack],
  ];
}

function render(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function generateStaticChildPlanBundleRepair(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | null = null;
  for (const [relativePath, value] of buildArtifacts()) {
    const target = path.join(contractsRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, render(value), 'utf8');
    if (relativePath === STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack)
      pack = value;
  }
  if (!pack) throw new Error('Static child Plan bundle repair pack is missing');
  return pack;
}

export function checkStaticChildPlanBundleRepair(): ContractArtifactEnvelope {
  let pack: ContractArtifactEnvelope | null = null;
  for (const [relativePath, expected] of buildArtifacts()) {
    const target = path.join(contractsRoot, relativePath);
    if (
      !fs.existsSync(target) ||
      fs.readFileSync(target, 'utf8') !== render(expected)
    ) {
      throw new Error(
        `Static child Plan bundle artifact drift: ${relativePath}`,
      );
    }
    if (relativePath === STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.pack)
      pack = expected;
  }
  if (!pack) throw new Error('Static child Plan bundle repair pack is missing');
  return pack;
}
