import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import {
  COMPILER_ERROR_CATALOG_V2_PATH,
  COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1,
  COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
} from './compiler-semantic-correction-contract.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const SEMANTIC_CORRECTION_INPUT_ROOT =
  'conformance/draft/semantic-correction-v4';
export const SEMANTIC_CORRECTION_CASE_CATALOG_PATH = `${SEMANTIC_CORRECTION_INPUT_ROOT}/semantic-review-input-cases@4.json`;
export const SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH = `${SEMANTIC_CORRECTION_INPUT_ROOT}/semantic-correction-input-manifest@1.json`;

const SOURCE_ROOT = `${SEMANTIC_CORRECTION_INPUT_ROOT}/sources`;
const SNAPSHOT_ROOT = `${SEMANTIC_CORRECTION_INPUT_ROOT}/snapshots`;
const FROZEN_REPAIR_CASES =
  'conformance/compiler-contract-repair/draft/golden-draft-cases@2.json';
const FROZEN_BASE_SNAPSHOT = 'conformance/draft/snapshots/complete-base@1.json';
const RAW_DOMAIN = 'icarus:workflow-semantic-correction-raw-source:1\n';
const RESOURCE_DOMAIN =
  'icarus:workflow-semantic-correction-registry-resource:1\n';
const INTERFACE_DOMAIN = 'icarus:workflow-semantic-correction-interface:1\n';
const POLICY_DOMAIN = 'icarus:workflow-semantic-correction-policy:1\n';
const SAFETY_DOMAIN = 'icarus:workflow-semantic-correction-safety:1\n';
const SNAPSHOT_DOMAIN = 'icarus:workflow-compiler-input-snapshot:2\n';
const SNAPSHOT_ARTIFACT_DOMAIN =
  'icarus:workflow-compiler-input-snapshot-artifact:2\n';
const CASE_CATALOG_DOMAIN =
  'icarus:workflow-semantic-review-input-cases-artifact:4\n';
const INPUT_MANIFEST_DOMAIN =
  'icarus:workflow-semantic-correction-input-manifest-artifact:1\n';
const OUTBOX_ADAPTER_DOMAIN = 'icarus:workflow-outbox-adapter:1\n';
const OUTBOX_POLICY_DOMAIN = 'icarus:workflow-outbox-delivery-policy:1\n';
const CAPABILITY_ADAPTER_REF = ref('fixture.adapter.capability-dispatch');
const CAPABILITY_DELIVERY_POLICY_REF = ref(
  'fixture.outbox-policy.normal-delivery',
);

export interface SemanticCorrectionCompilerIdentity extends JsonObject {
  compiler_toolchain_manifest_ref: VersionedRef;
  compiler_toolchain_hash: Sha256Hash;
  compiler_version: string;
  compiler_build_hash: Sha256Hash;
  canonical_normalizer_version: string;
  canonical_normalizer_hash: Sha256Hash;
  proof_algorithm_version: string;
  proof_algorithm_hash: Sha256Hash;
  error_catalog_ref: VersionedRef;
  error_catalog_hash: Sha256Hash;
  compiled_ir_schema_ref: string;
  compiled_ir_schema_hash: Sha256Hash;
  conformance_result_schema_ref: string;
  conformance_result_schema_hash: Sha256Hash;
}

export interface SemanticCorrectionCaseInput extends JsonObject {
  case_id: string;
  polarity: 'positive' | 'negative';
  source_kind: 'graph_scope' | 'workflow_definition' | 'workflow_schema';
  coverage_tags: JsonValue[];
  raw_source_bytes_ref: string;
  raw_source_bytes_hash: Sha256Hash;
  input_snapshot_ref: string;
  input_snapshot_hash: Sha256Hash;
  expected_source_hash: Sha256Hash | null;
  review_input: JsonObject;
}

export interface BuiltSemanticCorrectionInputs {
  files: Map<string, string>;
  cases: SemanticCorrectionCaseInput[];
  catalog: ContractArtifactEnvelope;
  manifest: ContractArtifactEnvelope;
}

function absolutePath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(
      `Semantic correction input path escapes root: ${relativePath}`,
    );
  }
  return absolute;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolutePath(relativePath))),
  );
}

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ref(id: string, version = '1.0.0'): VersionedRef {
  return { id, version };
}

function refKey(value: JsonObject | VersionedRef): string {
  return `${String(value.id)}@${String(value.version)}`;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(
  format: string,
  id: string,
  version: string,
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const revision = Number(format.slice(format.lastIndexOf('/') + 1));
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version },
    version: revision,
    domain_separator: domain,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  output.hash = calculateArtifactHash(output);
  return output;
}

function asObjects(value: JsonValue): JsonObject[] {
  if (!Array.isArray(value)) throw new Error('Expected object array');
  return value.map((entry) => {
    assertJsonObject(entry);
    return entry;
  });
}

function sourceHash(
  kind: SemanticCorrectionCaseInput['source_kind'],
  sourceText: string,
): Sha256Hash | null {
  try {
    const source = strictParseJsonBytes(Buffer.from(sourceText, 'utf8'));
    assertJsonObject(source);
    const domains = {
      graph_scope: 'icarus:workflow-graph-source:1\n',
      workflow_definition: 'icarus:workflow-definition-source:1\n',
      workflow_schema: 'icarus:workflow-schema-source:1\n',
    } as const;
    return domainSeparatedSha256(domains[kind], source);
  } catch {
    return null;
  }
}

function definitionHash(source: JsonObject): Sha256Hash {
  const { definition_hash: _ignored, ...withoutHash } = source;
  return domainSeparatedSha256(
    'icarus:workflow-definition:1\n',
    withoutHash as JsonValue,
  );
}

function allRefs(
  value: JsonValue,
  output = new Map<string, VersionedRef>(),
): Map<string, VersionedRef> {
  if (!value || typeof value !== 'object') return output;
  if (Array.isArray(value)) {
    for (const entry of value) allRefs(entry, output);
    return output;
  }
  if (typeof value.id === 'string' && typeof value.version === 'string') {
    output.set(refKey(value), { id: value.id, version: value.version });
  }
  for (const nested of Object.values(value)) allRefs(nested, output);
  return output;
}

function graphTerminal(id = 'target_invalidity_terminal'): JsonObject {
  return { id, type: 'terminal', trigger: { type: 'root' }, exit: 'done' };
}

const DEAD_END_CASES = new Set([
  'negative.graph-endpoint-not-found',
  'negative.graph-dependency-cycle',
  'negative.json-pointer-non-total',
  'negative.schema-not-assignable',
  'negative.capability-not-allowed',
  'negative.policy-escalation',
  'negative.quality-revision-missing-feedback-schema',
  'negative.quality-revision-effect-key-incompatible',
  'negative.quality-revision-missing-quality-gate',
]);

function transformDefinitionPolicy(source: JsonObject): void {
  assertJsonObject(source.entry_points);
  assertJsonObject(source.states);
  const entry = source.entry_points.default;
  assertJsonObject(entry);
  const state = source.states[String(entry.state_key)];
  assertJsonObject(state);
  const capabilityRef = state.capability_ref;
  const allowedCapabilities = capabilityRef ? [capabilityRef] : [];
  state.policy = {
    allowed_node_types: [state.type, 'terminal'],
    allowed_capabilities: allowedCapabilities,
    allowed_templates: [],
    allowed_interface_refs: [],
    allowed_wait_contracts: [],
    allowed_child_policy_refs: [],
    allowed_claim_ids: [],
    allow_early_close: false,
    allow_indefinite_waits: false,
    effect_policy: {
      allowed_recovery_kinds: ['pure'],
      max_impact: 'read_only',
    },
    build_retry: null,
    limits: {
      max_scopes: null,
      max_nodes: null,
      max_nodes_per_scope: null,
      max_edges_per_scope: null,
      max_nesting_depth: null,
      max_map_items: null,
      max_concurrency: null,
      max_total_attempts: null,
      max_total_waits: null,
      max_total_output_bytes: null,
      max_scope_spec_bytes: null,
      max_condition_steps: null,
      max_wait_duration_ms: null,
      max_pending_signals: null,
      max_fixed_point_facts: null,
      max_frontier_bytes: null,
    },
    usage_budget: {
      max_total_tool_calls: null,
      max_total_input_tokens: null,
      max_total_output_tokens: null,
      max_total_cost_micros: null,
    },
  };
  source.name = 'G2 semantic correction fixture';
  source.definition_hash = definitionHash(source);
}

function transformSource(
  historicalCase: JsonObject,
  replacementId: string,
): string {
  const originalPath =
    replacementId === 'positive.compiler-integrity-match-control'
      ? 'conformance/draft/cases/negative.compiler-integrity-mismatch/source.json'
      : String(historicalCase.raw_source_bytes_ref);
  const original = fs.readFileSync(absolutePath(originalPath), 'utf8');
  let source: JsonObject;
  try {
    const parsed = strictParseJsonBytes(Buffer.from(original, 'utf8'));
    assertJsonObject(parsed);
    source = parsed;
  } catch {
    return ` ${original}`;
  }
  if (historicalCase.source_kind === 'workflow_schema') {
    source.$id = `https://icarus.local/g2-semantic-correction/${replacementId}`;
    return render(source);
  }
  if (historicalCase.source_kind === 'workflow_definition') {
    if (replacementId === 'negative.child-recipe-dependency-cycle') {
      assertJsonObject(source.ref);
      source.ref.id = 'fixture.definition.cycle-a';
      assertJsonObject(source.states);
      const start = source.states.start;
      assertJsonObject(start);
      assertJsonObject(start.on_complete);
      const success = start.on_complete.success;
      assertJsonObject(success);
      success.effects = {
        operations: [
          {
            id: 'child.cycle-b',
            type: 'start_child_workflow',
            recipe_ref: ref('fixture.recipe.cycle-b'),
            routing_scope_ref: ref('fixture.routing.child'),
            principal_binding: 'inherit_parent_principal',
            creation_domain: 'parent_workflow_lineage',
            relation_kind: 'follow_up',
            input_bindings: {},
            delivery_requirement: 'required',
            finalization_policy_ref: ref('fixture.finalization'),
          },
        ],
      };
    }
    transformDefinitionPolicy(source);
    return render(source);
  }
  source.metadata = {
    ...(source.metadata &&
    typeof source.metadata === 'object' &&
    !Array.isArray(source.metadata)
      ? source.metadata
      : {}),
    semantic_correction_version: 'working-g2',
  };
  if (replacementId === 'positive.wait') {
    assertJsonObject(source.interface_ref);
    const edges = asObjects(source.data_edges);
    edges.push({
      id: 'data.correlation-key',
      kind: 'data',
      from: { type: 'scope_input', port: 'correlation_key' },
      to: { node_id: 'approval', port: 'correlation_key' },
    });
    source.data_edges = edges;
  }
  if (replacementId === 'positive.subgraph') {
    const owner = asObjects(source.nodes).find(
      (node) => node.type === 'subgraph',
    );
    const scopeFactory = owner ? (owner.scope as JsonObject) : null;
    const child = scopeFactory?.scope as JsonObject | undefined;
    if (child) child.interface_ref = ref('fixture.interface.child');
  }
  if (replacementId === 'positive.expand') {
    const edge = asObjects(source.data_edges).find(
      (candidate) => (candidate.from as JsonObject)?.type === 'literal',
    );
    const literal = edge
      ? ((edge.from as JsonObject).value as JsonObject)
      : null;
    if (literal) literal.interface_ref = ref('fixture.interface.child');
  }
  if (replacementId === 'positive.map') {
    const owner = asObjects(source.nodes).find((node) => node.type === 'map');
    const body = owner
      ? ((owner.body as JsonObject).scope as JsonObject)
      : null;
    if (body) body.interface_ref = ref('fixture.interface.child');
    const itemsEdge = asObjects(source.data_edges).find(
      (edge) => (edge.to as JsonObject)?.node_id === owner?.id,
    );
    if (itemsEdge) {
      assertJsonObject(itemsEdge.from);
      itemsEdge.from.value = ['accepted', 'rejected'];
    }
  }
  if (replacementId === 'positive.static-child-closure') {
    const rootOwner = asObjects(source.nodes).find(
      (node) => node.type === 'subgraph',
    );
    if (rootOwner) {
      rootOwner.child_policy_ref = ref('fixture.policy.child-nested');
      const nested = (rootOwner.scope as JsonObject).scope as JsonObject;
      nested.interface_ref = ref('fixture.interface.child');
      const nestedOwner = asObjects(nested.nodes).find(
        (node) => node.type === 'subgraph',
      );
      if (nestedOwner) {
        nestedOwner.child_policy_ref = ref('fixture.policy.child-leaf');
        const leaf = (nestedOwner.scope as JsonObject).scope as JsonObject;
        leaf.interface_ref = ref('fixture.interface.child');
      }
    }
  }
  if (replacementId === 'negative.graph-cross-scope-edge') {
    const owner = asObjects(source.nodes).find(
      (node) => node.type === 'subgraph',
    );
    const child = owner
      ? (((owner.scope as JsonObject).scope as JsonObject) ?? null)
      : null;
    if (child) child.interface_ref = ref('fixture.interface.child');
  }
  if (replacementId === 'negative.policy-escalation') {
    const owner = asObjects(source.nodes).find(
      (node) => node.type === 'subgraph',
    );
    const child = owner
      ? (((owner.scope as JsonObject).scope as JsonObject) ?? null)
      : null;
    if (child) child.interface_ref = ref('fixture.interface.child');
  }
  if (DEAD_END_CASES.has(replacementId)) {
    const nodes = asObjects(source.nodes);
    if (!nodes.some((node) => node.type === 'terminal')) {
      nodes.push(graphTerminal());
      source.nodes = nodes;
    }
  }
  return render(source);
}

function correctedReviewInput(
  historicalCase: JsonObject,
  caseId: string,
): JsonObject {
  if (caseId === 'positive.compiler-integrity-match-control') {
    return {
      role: 'hand_authored_review_input_not_expected_oracle',
      expected_diagnostics: [],
      semantic_assertions: [
        {
          assertion_id: 'matching-exact-identity-compiles',
          subject_pointer: '/outcome',
          operator: 'equals',
          expected: 'compiled',
          rationale:
            'The same valid source compiles when every exact identity field matches.',
        },
      ],
    };
  }
  const diagnostics = clone(historicalCase.expected_diagnostics as JsonValue[]);
  const assertions = clone(historicalCase.semantic_assertions as JsonValue[]);
  if (caseId === 'negative.graph-cross-scope-edge') {
    const first = diagnostics[0];
    assertJsonObject(first);
    first.code = 'graph_endpoint_not_found';
    const codeAssertion = assertions.find((value) => {
      assertJsonObject(value);
      return value.subject_pointer === '/diagnostics/0/code';
    });
    if (codeAssertion) {
      assertJsonObject(codeAssertion);
      codeAssertion.expected = 'graph_endpoint_not_found';
      codeAssertion.rationale =
        'The undocumented double-colon token is an ordinary unknown Node ID.';
    }
  }
  if (caseId === 'negative.compiler-integrity-mismatch') {
    const first = diagnostics[0];
    assertJsonObject(first);
    first.instance_pointer = '/compiler_identity/proof_algorithm_hash';
    assertions.push({
      assertion_id: 'compiler-integrity-exact-field-pointer',
      subject_pointer: '/diagnostics/0/instance_pointer',
      operator: 'equals',
      expected: '/compiler_identity/proof_algorithm_hash',
      rationale:
        'The Compiler derives the diagnostic from the first mismatching exact identity field.',
    });
  }
  if (caseId === 'positive.static-lowering') {
    assertions.push({
      assertion_id: 'lowered-capability-node-type',
      subject_pointer: '/normalized_plan/nodes/0/capability_binding/node_type',
      operator: 'equals',
      expected: 'delegation',
      rationale:
        'Definition state, lowered node, and bound Capability use one execution kind.',
    });
    assertions.push(
      {
        assertion_id: 'lowered-outbox-adapter-exact-ref',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/adapter_identity/ref/id',
        operator: 'equals',
        expected: 'fixture.adapter.capability-dispatch',
        rationale:
          'Capability dispatch binds one exact Published Adapter identity.',
      },
      {
        assertion_id: 'lowered-outbox-adapter-content-hash',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/adapter_identity/content_hash',
        operator: 'present',
        expected: true,
        rationale:
          'The Adapter Registry content hash is part of the immutable Plan binding.',
      },
      {
        assertion_id: 'lowered-outbox-policy-exact-ref',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/delivery_policy_identity/ref/id',
        operator: 'equals',
        expected: 'fixture.outbox-policy.normal-delivery',
        rationale:
          'Capability dispatch binds one exact finite Delivery Policy identity.',
      },
      {
        assertion_id: 'lowered-outbox-policy-snapshot-hash',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/effective_policy_snapshot/snapshot_hash',
        operator: 'present',
        expected: true,
        rationale:
          'T5 persists this exact effective Policy snapshot as an immutable Value.',
      },
      {
        assertion_id: 'lowered-outbox-delivery-lane',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/effect_contract/delivery_lane',
        operator: 'equals',
        expected: 'normal_execution',
        rationale: 'Planner cannot choose the Capability dispatch lane.',
      },
      {
        assertion_id: 'lowered-outbox-reconciliation',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/effect_contract/reconciliation/type',
        operator: 'equals',
        expected: 'not_required',
        rationale:
          'The reconciliation mode is fixed by the Published Capability.',
      },
      {
        assertion_id: 'lowered-outbox-idempotency',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/effect_contract/idempotency',
        operator: 'equals',
        expected: 'provider_key',
        rationale:
          'The Adapter idempotency contract is immutable execution input.',
      },
      {
        assertion_id: 'lowered-outbox-delivery-required',
        subject_pointer:
          '/normalized_plan/nodes/0/outbox_execution_binding/effect_contract/delivery_requirement',
        operator: 'equals',
        expected: 'required',
        rationale:
          'Capability dispatch failure remains coupled to Attempt outcome.',
      },
      {
        assertion_id: 'lowered-failure-terminal-node',
        subject_pointer: '/normalized_plan/nodes/1/exit',
        operator: 'equals',
        expected: 'failure',
        rationale:
          'The lowered failure route terminates through a first-class Terminal Node.',
      },
      {
        assertion_id: 'lowered-success-terminal-node',
        subject_pointer: '/normalized_plan/nodes/2/exit',
        operator: 'equals',
        expected: 'success',
        rationale:
          'The lowered success route terminates through a first-class Terminal Node.',
      },
      {
        assertion_id: 'lowered-outcome-control-edge-count',
        subject_pointer:
          '/normalized_plan/complexity_summary/control_edge_count',
        operator: 'equals',
        expected: 2,
        rationale:
          'Succeeded and failed capability facts have distinct terminal routes.',
      },
    );
  }
  if (caseId === 'positive.wait') {
    assertions.push({
      assertion_id: 'wait-correlation-data-binding',
      subject_pointer: '/normalized_plan/data_edges/0/to/port',
      operator: 'equals',
      expected: 'correlation_key',
      rationale: 'The required Wait correlation port has a typed data binding.',
    });
  }
  if (caseId === 'positive.expand') {
    assertions.push({
      assertion_id: 'expand-child-interface-match',
      subject_pointer:
        '/normalized_plan/nodes/1/child_interface_snapshot/ref/id',
      operator: 'equals',
      expected: 'fixture.interface.child',
      rationale:
        'The literal candidate implements the pinned child interface and is child-compiled.',
    });
  }
  const ownerIndex =
    caseId === 'positive.subgraph'
      ? 0
      : caseId === 'positive.expand' ||
          caseId === 'positive.map' ||
          caseId === 'positive.static-child-closure'
        ? 1
        : null;
  if (ownerIndex !== null) {
    const portName = caseId === 'positive.map' ? 'results' : 'completion';
    const generator =
      caseId === 'positive.map' ? 'map_result' : 'child_completion';
    assertions.push({
      assertion_id: `${caseId}-typed-owner-output`,
      subject_pointer: `/normalized_plan/nodes/${ownerIndex}/output_ports/${portName}/schema/generator`,
      operator: 'equals',
      expected: generator,
      rationale:
        'The structural owner freezes its declared completion/result port as a generated typed output.',
    });
  }
  return {
    role: 'hand_authored_review_input_not_expected_oracle',
    expected_diagnostics: diagnostics,
    semantic_assertions: assertions,
  };
}

function dependencyResourceType(id: string): string {
  if (id.includes('.executor')) return 'executor_implementation';
  if (id.includes('.evaluator')) return 'evaluator';
  if (id.includes('.quality-gate')) return 'quality_gate';
  if (id.includes('.authorization')) return 'authorization_policy';
  if (id.includes('.context')) return 'context_contract';
  if (id.includes('.routing.')) return 'routing_scope';
  if (id.includes('.finalization')) return 'root_finalization_policy';
  return 'dependency_contract';
}

function contractResource(id: string): JsonObject {
  const contentWithoutHash: JsonObject = {
    ref: ref(id),
    contract_kind: id.split('.')[1] ?? 'dependency',
  };
  return {
    resource_type: dependencyResourceType(id),
    ref: ref(id),
    content: {
      ...contentWithoutHash,
      contract_hash: domainSeparatedSha256(
        'icarus:workflow-semantic-correction-dependency-contract:1\n',
        contentWithoutHash,
      ),
    },
  };
}

function outboxAdapterResource(): JsonObject {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-outbox-adapter/1',
    ref: CAPABILITY_ADAPTER_REF,
    supported_effect_types: ['capability_dispatch'],
    supported_delivery_lanes: ['normal_execution'],
    supported_reconciliation: ['not_required'],
    supported_idempotency: ['provider_key'],
  };
  return {
    resource_type: 'outbox_adapter',
    ref: CAPABILITY_ADAPTER_REF,
    content: {
      ...withoutHash,
      adapter_hash: domainSeparatedSha256(OUTBOX_ADAPTER_DOMAIN, withoutHash),
    },
  };
}

function outboxDeliveryPolicyResource(): JsonObject {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-outbox-delivery-policy/1',
    ref: CAPABILITY_DELIVERY_POLICY_REF,
    max_delivery_attempts: 8,
    max_reconcile_attempts: 4,
    delivery_duration_ms: 900_000,
    attempt_timeout_ms: 60_000,
    initial_backoff_ms: 1_000,
    max_backoff_ms: 60_000,
    backoff: 'exponential',
    deterministic_jitter_micros: 200_000,
    honor_retry_after: true,
    retryable_error_codes: ['provider_unavailable', 'rate_limited'],
    permanent_error_codes: ['contract_rejected', 'permission_denied'],
  };
  return {
    resource_type: 'outbox_policy',
    ref: CAPABILITY_DELIVERY_POLICY_REF,
    content: {
      ...withoutHash,
      policy_hash: domainSeparatedSha256(OUTBOX_POLICY_DOMAIN, withoutHash),
    },
  };
}

function addCapabilityOutboxContract(resource: JsonObject): void {
  if (resource.resource_type !== 'capability') return;
  assertJsonObject(resource.content);
  resource.content.outbox_effect = {
    effect_type: 'capability_dispatch',
    adapter_ref: CAPABILITY_ADAPTER_REF,
    delivery_policy_ref: CAPABILITY_DELIVERY_POLICY_REF,
    delivery_lane: 'normal_execution',
    reconciliation: { type: 'not_required' },
    idempotency: 'provider_key',
    delivery_requirement: 'required',
  };
}

function childCreationEffect(recipeId: string): JsonObject {
  return {
    operations: [
      {
        id: `child.${recipeId}`,
        type: 'start_child_workflow',
        recipe_ref: ref(recipeId),
        routing_scope_ref: ref('fixture.routing.child'),
        principal_binding: 'inherit_parent_principal',
        creation_domain: 'parent_workflow_lineage',
        relation_kind: 'follow_up',
        input_bindings: {},
        delivery_requirement: 'required',
        finalization_policy_ref: ref('fixture.finalization'),
      },
    ],
  };
}

function definitionFixture(
  id: string,
  childRecipeId: string | null,
): JsonObject {
  const source: JsonObject = {
    format: 'icarus.workflow-definition/1',
    ref: ref(id),
    owner_feature_id: 'fixture-feature',
    name: `Definition binding for ${id}`,
    context_contract_ref: ref('fixture.context'),
    entry_points: { default: { state_key: 'start' } },
    states: {
      start: {
        type: 'delegation',
        capability_ref: ref('fixture.capability.static'),
        input_bindings: {},
        retry_request: null,
        timeout_ms: null,
        on_complete: {
          success: {
            target: 'done',
            ...(childRecipeId
              ? { effects: childCreationEffect(childRecipeId) }
              : {}),
          },
          failure: { target: 'done' },
        },
        on_error: { target: 'done' },
        on_local_cancel: { target: 'done' },
      },
      done: {
        type: 'terminal',
        terminal_kind: 'normal',
        output_binding: { source: 'constant', value: { status: 'done' } },
      },
    },
    definition_hash: `sha256:${'0'.repeat(64)}`,
  };
  transformDefinitionPolicy(source);
  source.definition_hash = definitionHash(source);
  return source;
}

function recipeResource(
  id: string,
  definitionId: string,
  childRecipeIds: string[],
): JsonObject {
  return {
    resource_type: 'recipe',
    ref: ref(id),
    content: {
      ref: ref(id),
      definition_ref: ref(definitionId),
      allowed_child_recipe_refs: childRecipeIds.map((child) => ref(child)),
    },
  };
}

function recipeResourceForCase(id: string, caseId: string): JsonObject | null {
  if (id === 'fixture.recipe.parent') {
    return recipeResource(
      id,
      'fixture.definition.main',
      caseId === 'negative.definition-child-creation-key-template'
        ? ['fixture.recipe.child']
        : [],
    );
  }
  if (id === 'fixture.recipe.child') {
    return recipeResource(id, 'fixture.definition.child', []);
  }
  if (id === 'fixture.recipe.cycle-a') {
    return recipeResource(id, 'fixture.definition.cycle-a', [
      'fixture.recipe.cycle-b',
    ]);
  }
  if (id === 'fixture.recipe.cycle-b') {
    return recipeResource(id, 'fixture.definition.cycle-b', [
      'fixture.recipe.cycle-a',
    ]);
  }
  return null;
}

function definitionResource(id: string, source: JsonObject | null): JsonObject {
  const sourceRef = source ? (source.ref as JsonObject | undefined) : undefined;
  const content =
    source?.format === 'icarus.workflow-definition/1' &&
    sourceRef &&
    refKey(sourceRef) === refKey(ref(id))
      ? clone(source)
      : definitionFixture(
          id,
          id === 'fixture.definition.cycle-b' ? 'fixture.recipe.cycle-a' : null,
        );
  const sanitize = (value: JsonValue): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(sanitize);
      return;
    }
    delete value.creation_key_template;
    if ('contract_ref' in value && 'input_bindings' in value) {
      delete value.delivery_requirement;
    }
    Object.values(value).forEach(sanitize);
  };
  sanitize(content);
  content.definition_hash = definitionHash(content);
  return { resource_type: 'definition', ref: ref(id), content };
}

function syntheticResource(
  dependency: VersionedRef,
  source: JsonObject | null,
  caseId: string,
): JsonObject {
  if (dependency.id === CAPABILITY_ADAPTER_REF.id) {
    return outboxAdapterResource();
  }
  if (dependency.id === CAPABILITY_DELIVERY_POLICY_REF.id) {
    return outboxDeliveryPolicyResource();
  }
  const recipe = recipeResourceForCase(dependency.id, caseId);
  if (recipe) return recipe;
  if (dependency.id.startsWith('fixture.definition.')) {
    return definitionResource(dependency.id, source);
  }
  return contractResource(dependency.id);
}

function fixResource(
  resourceValue: JsonObject,
  source: JsonObject | null,
): JsonObject {
  const resource = clone(resourceValue);
  const resourceRef = resource.ref;
  assertJsonObject(resourceRef);
  assertJsonObject(resource.content);
  const content = resource.content;
  if (resource.resource_type === 'capability') {
    const usedNodeTypes = new Set<string>();
    if (source) {
      const visit = (value: JsonValue): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        const capabilityRef = value.capability_ref;
        if (
          capabilityRef &&
          typeof capabilityRef === 'object' &&
          !Array.isArray(capabilityRef)
        ) {
          assertJsonObject(capabilityRef);
          if (refKey(capabilityRef) !== refKey(resourceRef)) {
            Object.values(value).forEach(visit);
            return;
          }
          usedNodeTypes.add(String(value.type));
        }
        Object.values(value).forEach(visit);
      };
      visit(source);
    }
    if (usedNodeTypes.size === 1) content.node_type = [...usedNodeTypes][0];
  }
  if (resource.resource_type === 'wait_contract') {
    const { contract_hash: _ignored, ...withoutHash } = content;
    content.contract_hash = domainSeparatedSha256(
      'icarus:workflow-wait-contract:1\n',
      withoutHash,
    );
  }
  if (resource.resource_type === 'recipe') {
    const { recipe_hash: _ignored, ...withoutHash } = content;
    content.recipe_hash = domainSeparatedSha256(
      'icarus:workflow-recipe:1\n',
      withoutHash,
    );
  }
  delete resource.content_hash;
  return {
    ...resource,
    publication_state: 'published',
    launchability: 'test_only',
    content_hash: domainSeparatedSha256(RESOURCE_DOMAIN, content),
  };
}

function dependencyMembers(
  root: JsonObject,
  resourcesByKey: Map<string, JsonObject>,
): JsonObject[] {
  assertJsonObject(root.ref);
  assertJsonObject(root.content);
  const rootKey = refKey(root.ref);
  const visited = new Set<string>([rootKey]);
  const selected = new Map<string, JsonObject>();
  const queue = [...allRefs(root.content).values()];
  while (queue.length > 0) {
    const dependencyRef = queue.shift() as VersionedRef;
    const key = refKey(dependencyRef);
    if (visited.has(key)) continue;
    visited.add(key);
    const dependency = resourcesByKey.get(key);
    if (!dependency) {
      throw new Error(`Dependency closure for ${rootKey} is missing ${key}`);
    }
    selected.set(key, dependency);
    assertJsonObject(dependency.content);
    queue.push(...allRefs(dependency.content).values());
  }
  return [...selected.values()]
    .sort((left, right) =>
      compareAscii(
        refKey(left.ref as JsonObject),
        refKey(right.ref as JsonObject),
      ),
    )
    .map((resource) => ({
      resource_type: resource.resource_type,
      ref: resource.ref,
      content_hash: resource.content_hash,
    }));
}

function dependencyClosure(
  root: JsonObject,
  resourcesByKey: Map<string, JsonObject>,
): JsonObject {
  assertJsonObject(root.ref);
  const members = dependencyMembers(root, resourcesByKey);
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-registry-dependency-closure/1',
    root_resource_type: root.resource_type,
    root_ref: root.ref,
    members,
    member_count: members.length,
  };
  return {
    ...withoutHash,
    closure_hash: domainSeparatedSha256(
      COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1,
      withoutHash,
    ),
  };
}

function finalizeResources(
  selected: Map<string, JsonObject>,
  source: JsonObject | null,
): { resources: JsonObject[]; dependencyClosures: JsonObject[] } {
  const resources = [...selected.values()].map((resource) =>
    fixResource(resource, source),
  );
  resources.sort((left, right) =>
    compareAscii(
      refKey(left.ref as JsonObject),
      refKey(right.ref as JsonObject),
    ),
  );
  const byKey = new Map(
    resources.map((resource) => [refKey(resource.ref as JsonObject), resource]),
  );
  for (const capability of resources.filter(
    (resource) => resource.resource_type === 'capability',
  )) {
    const closure = dependencyClosure(capability, byKey);
    assertJsonObject(capability.content);
    capability.content.dependency_closure_hash = closure.closure_hash;
    capability.content_hash = domainSeparatedSha256(
      RESOURCE_DOMAIN,
      capability.content,
    );
  }
  const dependencyClosures = resources
    .filter((resource) =>
      ['capability', 'wait_contract', 'recipe'].includes(
        String(resource.resource_type),
      ),
    )
    .map((resource) => dependencyClosure(resource, byKey))
    .sort((left, right) => {
      assertJsonObject(left.root_ref);
      assertJsonObject(right.root_ref);
      return compareAscii(refKey(left.root_ref), refKey(right.root_ref));
    });
  return { resources, dependencyClosures };
}

function correctedInterface(
  originalValue: JsonObject,
  caseId: string,
): JsonObject {
  const value = clone(originalValue);
  delete value.interface_hash;
  if (
    refKey(value.ref as JsonObject) === 'fixture.interface.root@1.0.0' &&
    caseId === 'positive.wait'
  ) {
    assertJsonObject(value.inputs);
    value.inputs.correlation_key = {
      schema_ref: ref('fixture.schema.string-wide'),
      max_bytes: 512,
      required: true,
    };
  }
  if (
    refKey(value.ref as JsonObject) === 'fixture.interface.child@1.0.0' &&
    caseId === 'positive.map'
  ) {
    assertJsonObject(value.inputs);
    assertJsonObject(value.inputs.item);
    value.inputs.item.required = true;
  }
  return {
    ...value,
    interface_hash: domainSeparatedSha256(INTERFACE_DOMAIN, value),
  };
}

function profile(
  id: string,
  nodeTypes: string[],
  childPolicyRefs: VersionedRef[] = [],
): JsonObject {
  return {
    ref: ref(id),
    request: {
      allowed_node_types: nodeTypes,
      allowed_capabilities: [],
      allowed_templates: [],
      allowed_interface_refs: [ref('fixture.interface.child')],
      allowed_wait_contracts: [],
      allowed_child_policy_refs: childPolicyRefs,
      allowed_claim_ids: [],
      allow_early_close: false,
      allow_indefinite_waits: false,
      effect_policy: {
        allowed_recovery_kinds: ['pure'],
        max_impact: 'read_only',
      },
      build_retry: null,
      limits: {
        max_scopes: null,
        max_nodes: 16,
        max_nodes_per_scope: null,
        max_edges_per_scope: 32,
        max_nesting_depth: null,
        max_map_items: null,
        max_concurrency: null,
        max_total_attempts: null,
        max_total_waits: null,
        max_total_output_bytes: null,
        max_scope_spec_bytes: null,
        max_condition_steps: null,
        max_wait_duration_ms: null,
        max_pending_signals: null,
        max_fixed_point_facts: null,
        max_frontier_bytes: null,
      },
      usage_budget: {
        max_total_tool_calls: null,
        max_total_input_tokens: null,
        max_total_output_tokens: null,
        max_total_cost_micros: null,
      },
    },
  };
}

function buildSnapshot(
  caseId: string,
  sourceText: string,
  identity: SemanticCorrectionCompilerIdentity,
  mismatchField: string | null,
): ContractArtifactEnvelope {
  const base = readArtifact(FROZEN_BASE_SNAPSHOT).payload;
  assertJsonObject(base.registry_snapshot);
  assertJsonObject(base.interface_snapshot);
  assertJsonObject(base.policy_snapshot);
  assertJsonObject(base.policy_snapshot.complete_policy);
  assertJsonObject(base.safety_snapshot);
  const oldResources = asObjects(base.registry_snapshot.resources);
  const oldResourceByKey = new Map(
    oldResources.map((resource) => [
      refKey(resource.ref as JsonObject),
      resource,
    ]),
  );
  const oldInterfaces = asObjects(base.interface_snapshot.interfaces);
  let source: JsonObject | null = null;
  try {
    const parsed = strictParseJsonBytes(Buffer.from(sourceText, 'utf8'));
    assertJsonObject(parsed);
    source = parsed;
  } catch {
    source = null;
  }
  const refs = source ? allRefs(source) : new Map<string, VersionedRef>();
  if (source?.format === 'icarus.workflow-definition/1') {
    assertJsonObject(source.ref);
    const owningRecipe =
      source.ref.id === 'fixture.definition.cycle-a'
        ? ref('fixture.recipe.cycle-a')
        : ref('fixture.recipe.parent');
    refs.set(refKey(owningRecipe), owningRecipe);
  }
  const selected = new Map<string, JsonObject>();
  const selectedInterfaces = new Map<string, JsonObject>();
  const queue = [...refs.values()];
  while (queue.length > 0) {
    const current = queue.shift() as VersionedRef;
    const key = refKey(current);
    if (selected.has(key) || selectedInterfaces.has(key)) continue;
    if (key.startsWith('fixture.policy.')) continue;
    const oldInterface = oldInterfaces.find(
      (entry) => refKey(entry.ref as JsonObject) === key,
    );
    if (oldInterface) {
      const interfaceEntry = correctedInterface(oldInterface, caseId);
      selectedInterfaces.set(key, interfaceEntry);
      for (const dependency of allRefs(interfaceEntry).values()) {
        refs.set(refKey(dependency), dependency);
        queue.push(dependency);
      }
      continue;
    }
    if (current.id.startsWith('fixture.interface.')) continue;
    const resource =
      recipeResourceForCase(current.id, caseId) ??
      clone(
        oldResourceByKey.get(key) ?? syntheticResource(current, source, caseId),
      );
    addCapabilityOutboxContract(resource);
    selected.set(key, resource);
    assertJsonObject(resource.content);
    for (const dependency of allRefs(resource.content).values()) {
      refs.set(refKey(dependency), dependency);
      queue.push(dependency);
    }
  }
  if (caseId === 'positive.map') {
    const arraySchema = selected.get('fixture.schema.string-array@1.0.0');
    if (!arraySchema) throw new Error('Map items schema is missing');
    assertJsonObject(arraySchema.content);
    arraySchema.content.items = {
      type: 'string',
      enum: ['accepted', 'rejected'],
    };
  }
  const interfaces = [...selectedInterfaces.values()].sort((left, right) =>
    compareAscii(
      refKey(left.ref as JsonObject),
      refKey(right.ref as JsonObject),
    ),
  );
  const finalized = finalizeResources(selected, source);
  const resources = finalized.resources;
  const dependencyClosures = finalized.dependencyClosures;
  let childProfiles: JsonObject[] = [];
  const sourceRefs = new Set(refs.keys());
  if (sourceRefs.has('fixture.policy.child-tight@1.0.0')) {
    childProfiles.push(profile('fixture.policy.child-tight', ['terminal']));
  }
  if (sourceRefs.has('fixture.policy.child-nested@1.0.0')) {
    childProfiles.push(
      profile(
        'fixture.policy.child-nested',
        ['subgraph', 'terminal'],
        [ref('fixture.policy.child-leaf')],
      ),
      profile('fixture.policy.child-leaf', ['terminal']),
    );
  }
  if (sourceRefs.has('fixture.policy.child-escalating@1.0.0')) {
    const escalating = profile('fixture.policy.child-escalating', ['terminal']);
    assertJsonObject(escalating.request);
    assertJsonObject(escalating.request.effect_policy);
    escalating.request.effect_policy.max_impact = 'irreversible';
    childProfiles.push({
      ...escalating,
    });
  }
  const sourceNodes =
    source && Array.isArray(source.nodes) ? asObjects(source.nodes) : [];
  const allowedCapabilities = resources
    .filter((resource) => resource.resource_type === 'capability')
    .filter(
      (resource) =>
        caseId !== 'negative.capability-not-allowed' ||
        (resource.ref as JsonObject).id !== 'fixture.capability.forbidden',
    )
    .map((resource) => resource.ref);
  const allowedInterfaces = interfaces.map((entry) => entry.ref);
  const allowedWaits = resources
    .filter((resource) => resource.resource_type === 'wait_contract')
    .map((resource) => resource.ref);
  const allowedChildPolicies = childProfiles
    .filter((entry) => sourceRefs.has(refKey(entry.ref as JsonObject)))
    .map((entry) => entry.ref);
  const rootPolicy: JsonObject = {
    allowed_node_types: [
      ...new Set([
        ...sourceNodes.map((node) => String(node.type)),
        'delegation',
        'system',
        'wait',
        'join',
        'subgraph',
        'expand',
        'map',
        'terminal',
      ]),
    ],
    allowed_capabilities: allowedCapabilities,
    allowed_templates: resources
      .filter((resource) => resource.resource_type === 'template')
      .map((resource) => resource.ref),
    allowed_interface_refs:
      caseId === 'negative.registry-ref-not-found'
        ? [ref('fixture.interface.missing')]
        : allowedInterfaces,
    allowed_wait_contracts: allowedWaits,
    allowed_child_policy_refs: allowedChildPolicies,
    allowed_claim_ids: [],
    allow_early_close: true,
    allow_indefinite_waits: false,
    effect_policy: {
      allowed_recovery_kinds: ['pure', 'idempotent', 'compensatable'],
      max_impact: 'mutable_effects',
    },
    build_retry: null,
    limits: {
      max_scopes: null,
      max_nodes: null,
      max_nodes_per_scope: null,
      max_edges_per_scope: null,
      max_nesting_depth: null,
      max_map_items: null,
      max_concurrency: null,
      max_total_attempts: null,
      max_total_waits: null,
      max_total_output_bytes: null,
      max_scope_spec_bytes: null,
      max_condition_steps: null,
      max_wait_duration_ms: null,
      max_pending_signals: null,
      max_fixed_point_facts: null,
      max_frontier_bytes: null,
    },
    usage_budget: {
      max_total_tool_calls: null,
      max_total_input_tokens: null,
      max_total_output_tokens: null,
      max_total_cost_micros: null,
    },
  };
  const policyHash = domainSeparatedSha256(POLICY_DOMAIN, {
    root_policy: rootPolicy,
    child_profiles: childProfiles,
  });
  assertJsonObject(base.safety_snapshot.ceilings);
  const safety = clone(base.safety_snapshot.ceilings);
  const safetyHash = domainSeparatedSha256(SAFETY_DOMAIN, safety);
  const registryHash = domainSeparatedSha256(
    'icarus:workflow-semantic-correction-registry-snapshot:1\n',
    {
      resources: resources.map((resource) => ({
        ref: resource.ref,
        resource_type: resource.resource_type,
        content_hash: resource.content_hash,
      })),
      dependency_closures: dependencyClosures.map((closure) => ({
        root_resource_type: closure.root_resource_type,
        root_ref: closure.root_ref,
        closure_hash: closure.closure_hash,
      })),
    },
  );
  const interfaceHash = domainSeparatedSha256(
    'icarus:workflow-semantic-correction-interface-snapshot:1\n',
    interfaces,
  );
  const compilerIdentity = clone(identity);
  if (mismatchField) {
    compilerIdentity[mismatchField] = `sha256:${'f'.repeat(64)}`;
  }
  const withoutSnapshotHash: JsonObject = {
    format: 'icarus.workflow-compiler-input-snapshot/2',
    snapshot_id: `semantic-correction:${caseId}`,
    launchability: 'test_only',
    compiler_identity: compilerIdentity,
    registry_snapshot: {
      snapshot_ref: `test-only:registry:semantic-correction:${caseId}@1`,
      snapshot_hash: registryHash,
      resource_count: resources.length,
      resources,
      dependency_closure_count: dependencyClosures.length,
      dependency_closures: dependencyClosures,
    },
    interface_snapshot: {
      snapshot_ref: `test-only:interfaces:semantic-correction:${caseId}@1`,
      snapshot_hash: interfaceHash,
      interface_count: interfaces.length,
      interfaces,
    },
    policy_snapshot: {
      snapshot_ref: `test-only:policy:semantic-correction:${caseId}@1`,
      complete_policy: {
        root_policy_ref: ref(`fixture.policy.root.${caseId}`),
        root_policy: rootPolicy,
        child_profiles: childProfiles,
        intersection_order: [
          'global',
          'workflow',
          'state',
          'parent',
          'child_request',
          'runtime_safety',
        ],
        policy_hash: policyHash,
      },
    },
    safety_snapshot: {
      snapshot_ref: `test-only:safety:semantic-correction:${caseId}@1`,
      source_artifact_hash: safetyHash,
      ceilings: safety,
    },
  };
  const payload = {
    ...withoutSnapshotHash,
    snapshot_hash: domainSeparatedSha256(SNAPSHOT_DOMAIN, withoutSnapshotHash),
  };
  return artifact(
    'icarus.workflow-compiler-input-snapshot/2',
    `icarus.workflow-compiler-input-snapshot.semantic-correction.${caseId}`,
    '2.0.0',
    SNAPSHOT_ARTIFACT_DOMAIN,
    payload,
  );
}

function buildCaseSeeds(): Array<{
  historical: JsonObject;
  caseId: string;
  polarity: 'positive' | 'negative';
  coverageTags: JsonValue[];
}> {
  const frozen = readArtifact(FROZEN_REPAIR_CASES).payload;
  const cases = asObjects(frozen.cases);
  return cases.map((historical) => {
    if (
      historical.case_id === 'negative.early-completion-cancellation-unsafe'
    ) {
      return {
        historical,
        caseId: 'positive.compiler-integrity-match-control',
        polarity: 'positive' as const,
        coverageTags: ['compiler_integrity_matching_control'],
      };
    }
    return {
      historical,
      caseId: String(historical.case_id),
      polarity: historical.polarity as 'positive' | 'negative',
      coverageTags:
        historical.case_id === 'negative.graph-cross-scope-edge'
          ? ['ordinary_unknown_node_id', 'cross_scope_syntax_absent']
          : clone(historical.coverage_tags as JsonValue[]),
    };
  });
}

export function buildSemanticCorrectionInputs(
  identity: SemanticCorrectionCompilerIdentity,
): BuiltSemanticCorrectionInputs {
  const files = new Map<string, string>();
  const cases: SemanticCorrectionCaseInput[] = [];
  for (const seed of buildCaseSeeds()) {
    const sourceText = transformSource(seed.historical, seed.caseId);
    const sourcePath = `${SOURCE_ROOT}/${seed.caseId}/source.json`;
    const snapshotPath = `${SNAPSHOT_ROOT}/${seed.caseId}@2.json`;
    const snapshot = buildSnapshot(
      seed.caseId,
      sourceText,
      identity,
      seed.caseId === 'negative.compiler-integrity-mismatch'
        ? 'proof_algorithm_hash'
        : null,
    );
    files.set(sourcePath, sourceText);
    files.set(snapshotPath, render(snapshot));
    cases.push({
      case_id: seed.caseId,
      polarity: seed.polarity,
      source_kind: seed.historical
        .source_kind as SemanticCorrectionCaseInput['source_kind'],
      coverage_tags: seed.coverageTags,
      raw_source_bytes_ref: sourcePath,
      raw_source_bytes_hash: domainSeparatedSha256(RAW_DOMAIN, sourceText),
      input_snapshot_ref: snapshotPath,
      input_snapshot_hash: snapshot.hash,
      expected_source_hash: sourceHash(
        seed.historical
          .source_kind as SemanticCorrectionCaseInput['source_kind'],
        sourceText,
      ),
      review_input: correctedReviewInput(seed.historical, seed.caseId),
    });
  }
  const catalog = artifact(
    'icarus.workflow-semantic-review-input-cases/4',
    'icarus.workflow-semantic-review-input-cases',
    '4.0.0',
    CASE_CATALOG_DOMAIN,
    {
      format: 'icarus.workflow-semantic-review-input-cases/4',
      bundle_version: 'working-g2',
      construction_phase: 'WORKING',
      publishable: false,
      production_reachable: false,
      correction_contract_ref: COMPILER_SEMANTIC_CORRECTION_MANIFEST_PATH,
      error_catalog_ref: COMPILER_ERROR_CATALOG_V2_PATH,
      case_count: cases.length,
      positive_case_count: cases.filter(
        (entry) => entry.polarity === 'positive',
      ).length,
      negative_case_count: cases.filter(
        (entry) => entry.polarity === 'negative',
      ).length,
      cases,
      expected_full_case_result_bytes_authored: 0,
      human_judgment_coverage: 0,
      review_status: 'not_requested_until_prepare_rc',
      golden_semantic_review_status: 'not_run',
      approval_status: 'not_run',
      golden_seal_status: 'not_run',
      sealed_write_status: 'not_run',
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(SEMANTIC_CORRECTION_CASE_CATALOG_PATH, render(catalog));
  const inventory = [...files.entries()]
    .map(([artifactPath, contents]) => ({
      path: artifactPath,
      raw_sha256: rawSha256(Buffer.from(contents, 'utf8')),
    }))
    .sort((left, right) => compareAscii(left.path, right.path));
  const manifest = artifact(
    'icarus.workflow-semantic-correction-input-manifest/1',
    'icarus.workflow-semantic-correction-input-manifest',
    '1.0.0',
    INPUT_MANIFEST_DOMAIN,
    {
      gate: 'G2',
      status: 'WORKING_INPUTS_CURRENT',
      construction_phase: 'WORKING',
      publishable: false,
      production_reachable: false,
      case_catalog_ref: SEMANTIC_CORRECTION_CASE_CATALOG_PATH,
      case_catalog_hash: catalog.hash,
      compiler_identity: identity,
      case_count: 40,
      per_case_snapshot_count: 40,
      input_snapshot_format: 'icarus.workflow-compiler-input-snapshot/2',
      identity_match_boolean: 'forbidden',
      artifact_inventory: inventory,
      expected_oracle_status: 'absent_working_not_review_candidate',
      human_review_status: 'not_requested_until_prepare_rc',
      golden_semantic_review_status: 'not_run',
      approval_status: 'not_run',
      golden_seal_status: 'not_run',
      sealed_write_status: 'not_run',
      g3_through_g9_status: 'not_started',
    },
  );
  files.set(SEMANTIC_CORRECTION_INPUT_MANIFEST_PATH, render(manifest));
  return { files, cases, catalog, manifest };
}
