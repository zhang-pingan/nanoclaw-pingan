import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import {
  COMPILER_ERROR_CATALOG_V2_PATH,
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
    semantic_correction_version: '4.0.0-draft',
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
  return {
    role: 'hand_authored_review_input_not_expected_oracle',
    expected_diagnostics: diagnostics,
    semantic_assertions: assertions,
  };
}

function contractResource(id: string): JsonObject {
  const contentWithoutHash: JsonObject = {
    ref: ref(id),
    contract_kind: id.split('.')[1] ?? 'dependency',
  };
  return {
    resource_type: 'dependency_contract',
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
    const { dependency_closure_hash: _ignored, ...dependencyInput } = content;
    content.dependency_closure_hash = domainSeparatedSha256(
      'icarus:workflow-capability-dependency-closure:1\n',
      dependencyInput,
    );
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
    content_hash: domainSeparatedSha256(RESOURCE_DOMAIN, content),
  };
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
  if (caseId === 'negative.child-recipe-set-mismatch') {
    refs.set('fixture.recipe.parent@1.0.0', ref('fixture.recipe.parent'));
    refs.set('fixture.recipe.child@1.0.0', ref('fixture.recipe.child'));
  }
  if (caseId === 'negative.child-recipe-dependency-cycle') {
    refs.set('fixture.recipe.cycle-a@1.0.0', ref('fixture.recipe.cycle-a'));
    refs.set('fixture.recipe.cycle-b@1.0.0', ref('fixture.recipe.cycle-b'));
  }
  if (source?.format === 'icarus.workflow-definition/1') {
    refs.set('fixture.recipe.parent@1.0.0', ref('fixture.recipe.parent'));
  }
  const selected = new Map<string, JsonObject>();
  const queue = [...refs.values()];
  while (queue.length > 0) {
    const current = queue.shift() as VersionedRef;
    const key = refKey(current);
    if (selected.has(key)) continue;
    const resource = oldResourceByKey.get(key);
    if (!resource) continue;
    selected.set(key, resource);
    assertJsonObject(resource.content);
    for (const dependency of allRefs(resource.content).values())
      queue.push(dependency);
  }
  if (caseId === 'negative.child-recipe-set-mismatch') {
    const parent = selected.get('fixture.recipe.parent@1.0.0');
    if (parent) {
      assertJsonObject(parent.content);
      parent.content.allowed_child_recipe_refs = [];
    }
    selected.set('fixture.recipe.child@1.0.0', {
      resource_type: 'recipe',
      ref: ref('fixture.recipe.child'),
      content: {
        ref: ref('fixture.recipe.child'),
        definition_ref: ref('fixture.definition.child'),
        allowed_child_recipe_refs: [],
      },
    });
  }
  if (caseId === 'negative.child-recipe-dependency-cycle') {
    const cycleA = selected.get('fixture.recipe.cycle-a@1.0.0');
    if (cycleA) {
      assertJsonObject(cycleA.content);
      cycleA.content.definition_ref = ref('fixture.definition.cycle-a');
    }
    selected.delete('fixture.recipe.parent@1.0.0');
  }
  const interfaceRefs = new Set(
    [...refs.keys()].filter((key) => key.startsWith('fixture.interface.')),
  );
  const interfaces = oldInterfaces
    .filter((entry) => interfaceRefs.has(refKey(entry.ref as JsonObject)))
    .map((entry) => correctedInterface(entry, caseId));
  for (const interfaceEntry of interfaces) {
    for (const dependency of allRefs(interfaceEntry).values())
      refs.set(refKey(dependency), dependency);
  }
  for (const dependency of refs.values()) {
    const key = refKey(dependency);
    if (selected.has(key) || interfaceRefs.has(key)) continue;
    if (key.startsWith('fixture.policy.')) continue;
    selected.set(key, contractResource(dependency.id));
  }
  let resources = [...selected.values()].map((resource) =>
    fixResource(resource, source),
  );
  resources.sort((left, right) =>
    refKey(left.ref as JsonObject).localeCompare(
      refKey(right.ref as JsonObject),
    ),
  );
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
    childProfiles.push({
      ...profile('fixture.policy.child-escalating', [
        'delegation',
        'system',
        'terminal',
      ]),
      request: {
        ...(profile('fixture.policy.child-escalating', ['terminal'])
          .request as JsonObject),
        allowed_capabilities: [ref('fixture.capability.forbidden')],
        allow_early_close: true,
        effect_policy: {
          allowed_recovery_kinds: ['pure', 'idempotent'],
          max_impact: 'irreversible',
        },
      },
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
    resources.map((resource) => ({
      ref: resource.ref,
      resource_type: resource.resource_type,
      content_hash: resource.content_hash,
    })),
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
      bundle_version: '4.0.0-additive-semantic-correction',
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
      fresh_review_status: 'pending_40_of_40',
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
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = artifact(
    'icarus.workflow-semantic-correction-input-manifest/1',
    'icarus.workflow-semantic-correction-input-manifest',
    '1.0.0',
    INPUT_MANIFEST_DOMAIN,
    {
      gate: 'G2',
      status: 'ADDITIVE_INPUTS_PUBLISHED',
      case_catalog_ref: SEMANTIC_CORRECTION_CASE_CATALOG_PATH,
      case_catalog_hash: catalog.hash,
      compiler_identity: identity,
      case_count: 40,
      per_case_snapshot_count: 40,
      input_snapshot_format: 'icarus.workflow-compiler-input-snapshot/2',
      identity_match_boolean: 'forbidden',
      artifact_inventory: inventory,
      expected_oracle_status: 'absent_pending_fresh_human_review',
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
