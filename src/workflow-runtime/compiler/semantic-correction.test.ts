import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import { COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1 } from '../contracts/compiler-semantic-correction-contract.js';
import { checkCurrentSealedEraWorkingCompilerCandidate } from '../contracts/current-sealed-era-historical-checks.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from '../contracts/types.js';
import type { WorkflowCompilerConformanceCaseResultV1 } from '../contracts/compiler-contract-repair-types.js';
import { compileWorkflow } from './compiler.js';
import {
  type BuiltSemanticCorrectionCandidate,
  G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT,
  buildSemanticCorrectionCandidate,
} from './semantic-correction.js';

const compilerRoot = import.meta.dirname;
const contractsRoot = path.resolve(compilerRoot, '../contracts');
const INPUT_ROOT = 'conformance/draft/semantic-correction-v4';
const RESOURCE_DOMAIN =
  'icarus:workflow-semantic-correction-registry-resource:1\n';

function clone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function treeDigest(relativeRoots: string[]): string {
  const hash = crypto.createHash('sha256');
  const visit = (root: string, directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(root, absolute);
      else {
        hash.update(path.relative(contractsRoot, absolute), 'utf8');
        hash.update(fs.readFileSync(absolute));
      }
    }
  };
  for (const relativeRoot of relativeRoots.sort()) {
    visit(relativeRoot, path.join(contractsRoot, relativeRoot));
  }
  return hash.digest('hex');
}

function inputFor(built: BuiltSemanticCorrectionCandidate, caseId: string) {
  const input = built.inputs.cases.find((entry) => entry.case_id === caseId);
  if (!input) throw new Error(`Missing semantic correction input: ${caseId}`);
  return input;
}

function sourceFor(
  built: BuiltSemanticCorrectionCandidate,
  caseId: string,
): JsonObject {
  const input = inputFor(built, caseId);
  const value = strictParseJsonBytes(
    Buffer.from(built.files.get(input.raw_source_bytes_ref) ?? '', 'utf8'),
  );
  assertJsonObject(value);
  return value;
}

function snapshotFor(
  built: BuiltSemanticCorrectionCandidate,
  caseId: string,
): ContractArtifactEnvelope {
  const input = inputFor(built, caseId);
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(built.files.get(input.input_snapshot_ref) ?? '', 'utf8'),
    ),
  );
}

function compileMutation(
  built: BuiltSemanticCorrectionCandidate,
  caseId: string,
  mutateSource: (source: JsonObject) => void = () => undefined,
  mutateSnapshot: (snapshot: JsonObject) => void = () => undefined,
) {
  const input = inputFor(built, caseId);
  const source = clone(sourceFor(built, caseId));
  const snapshot = clone(snapshotFor(built, caseId).payload);
  assertJsonObject(snapshot.compiler_identity);
  const identity = clone(snapshot.compiler_identity);
  mutateSource(source);
  mutateSnapshot(snapshot);
  return compileWorkflow({
    caseId: `test.${caseId}`,
    sourceKind: input.source_kind,
    rawSourceBytes: Buffer.from(JSON.stringify(source), 'utf8'),
    inputSnapshot: snapshot,
    identity: identity as never,
  });
}

function jsonValueAtPointer(
  root: JsonValue,
  pointer: string,
): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  if (pointer === '') return current;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) current = current[Number(token)];
    else if (current && typeof current === 'object') current = current[token];
    else return undefined;
  }
  return current;
}

function actualSet(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value);
  return [];
}

function checkAssertion(
  result: WorkflowCompilerConformanceCaseResultV1,
  assertion: JsonObject,
): void {
  const actual = jsonValueAtPointer(result, String(assertion.subject_pointer));
  const label = String(assertion.assertion_id);
  switch (assertion.operator) {
    case 'equals':
    case 'ordered_equals':
      expect(actual, label).toEqual(assertion.expected);
      break;
    case 'set_equals':
      expect(actualSet(actual).map(String).sort(), label).toEqual(
        actualSet(assertion.expected).map(String).sort(),
      );
      break;
    case 'contains':
      expect(actualSet(actual), label).toContainEqual(assertion.expected);
      break;
    case 'present':
      expect(actual, label).not.toBeUndefined();
      break;
    case 'absent':
      expect(actual, label).toBeUndefined();
      break;
    default:
      throw new Error(
        `Unknown semantic assertion operator: ${assertion.operator}`,
      );
  }
}

function childProfile(snapshot: JsonObject, id: string): JsonObject {
  assertJsonObject(snapshot.policy_snapshot);
  assertJsonObject(snapshot.policy_snapshot.complete_policy);
  const profiles = snapshot.policy_snapshot.complete_policy.child_profiles;
  if (!Array.isArray(profiles)) throw new Error('Child profiles missing');
  const profile = profiles.find((entry) => {
    assertJsonObject(entry);
    assertJsonObject(entry.ref);
    return entry.ref.id === id;
  });
  assertJsonObject(profile);
  assertJsonObject(profile.request);
  return profile;
}

function registryResources(snapshot: JsonObject): JsonObject[] {
  assertJsonObject(snapshot.registry_snapshot);
  const resources = snapshot.registry_snapshot.resources;
  if (!Array.isArray(resources)) throw new Error('Registry resources missing');
  return resources.map((entry) => {
    assertJsonObject(entry);
    return entry;
  });
}

function versionedRefs(value: JsonValue): Map<string, JsonObject> {
  const output = new Map<string, JsonObject>();
  const visit = (candidate: JsonValue): void => {
    if (!candidate || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (
      typeof candidate.id === 'string' &&
      typeof candidate.version === 'string'
    ) {
      output.set(`${candidate.id}@${candidate.version}`, candidate);
      return;
    }
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  return output;
}

function rehashDefinition(source: JsonObject): void {
  const { definition_hash: _ignored, ...withoutHash } = source;
  source.definition_hash = domainSeparatedSha256(
    'icarus:workflow-definition:1\n',
    withoutHash,
  );
}

describe('G2 working semantic correction candidate', () => {
  it('replays all 40 cases deterministically and checks predecessor trees read-only', () => {
    const roots = [INPUT_ROOT, G2_SEMANTIC_CORRECTION_CANDIDATE_ROOT];
    const before = treeDigest(roots);
    const first = buildSemanticCorrectionCandidate();
    const second = buildSemanticCorrectionCandidate();
    expect([...second.files]).toEqual([...first.files]);
    expect(second.root.hash).toBe(first.root.hash);
    expect(first.root.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.root.payload).toMatchObject({
      status: 'WORKING_COMPILER_COMPARISON',
      construction_phase: 'WORKING',
      publishable: false,
      production_reachable: false,
      human_review_status: 'not_requested_until_prepare_rc',
    });
    expect(first.inputs.manifest.payload).toMatchObject({
      status: 'WORKING_INPUTS_CURRENT',
      construction_phase: 'WORKING',
      publishable: false,
      production_reachable: false,
      human_review_status: 'not_requested_until_prepare_rc',
    });
    expect(first.results).toHaveLength(40);
    expect(
      first.results.filter((entry) => entry.outcome === 'compiled'),
    ).toHaveLength(11);
    expect(
      first.results.filter((entry) => entry.outcome === 'rejected'),
    ).toHaveLength(29);
    expect(checkCurrentSealedEraWorkingCompilerCandidate().hash).toBe(
      'sha256:54ba5b80b92a9c053e4439964fbea03326c9c8b7fc3cc3fe244dffa2144d341a',
    );
    expect(treeDigest(roots)).toBe(before);
  }, 15_000);

  it('matches every hand-authored review target and positive assertion', () => {
    const built = buildSemanticCorrectionCandidate();
    const resultByCase = new Map(
      built.results.map((entry) => [entry.case_id, entry]),
    );
    for (const input of built.inputs.cases) {
      const result = resultByCase.get(input.case_id)!;
      const review = input.review_input;
      expect(result.outcome, input.case_id).toBe(
        input.polarity === 'positive' ? 'compiled' : 'rejected',
      );
      expect(result.diagnostics, input.case_id).toEqual(
        review.expected_diagnostics,
      );
      expect(result.diagnostics.length, input.case_id).toBe(
        input.polarity === 'positive' ? 0 : 1,
      );
      if (!Array.isArray(review.semantic_assertions)) {
        throw new Error(`Assertions missing: ${input.case_id}`);
      }
      for (const assertion of review.semantic_assertions) {
        assertJsonObject(assertion);
        checkAssertion(result, assertion);
      }
    }
  });

  it('uses isolated snapshots with real hashes and no identity verdict boolean', () => {
    const built = buildSemanticCorrectionCandidate();
    expect(
      new Set(built.inputs.cases.map((entry) => entry.input_snapshot_ref)).size,
    ).toBe(40);
    for (const input of built.inputs.cases) {
      expect(input.input_snapshot_ref).not.toContain('complete-base');
      const snapshot = snapshotFor(built, input.case_id);
      const payload = snapshot.payload;
      assertJsonObject(payload.compiler_identity);
      expect(payload.compiler_identity).not.toHaveProperty('identity_match');
      const { snapshot_hash: snapshotHash, ...snapshotWithoutHash } = payload;
      expect(snapshotHash, input.case_id).toBe(
        domainSeparatedSha256(
          'icarus:workflow-compiler-input-snapshot:2\n',
          snapshotWithoutHash,
        ),
      );
      const resources = registryResources(payload);
      expect(resources.length, input.case_id).toBeLessThanOrEqual(24);
      for (const resource of resources) {
        assertJsonObject(resource.content);
        expect(
          resource.content_hash,
          `${input.case_id}/${String(resource.resource_type)}`,
        ).toBe(domainSeparatedSha256(RESOURCE_DOMAIN, resource.content));
        if (resource.resource_type === 'wait_contract') {
          const { contract_hash: hash, ...withoutHash } = resource.content;
          expect(hash).toBe(
            domainSeparatedSha256(
              'icarus:workflow-wait-contract:1\n',
              withoutHash,
            ),
          );
        }
        if (resource.resource_type === 'recipe') {
          const { recipe_hash: hash, ...withoutHash } = resource.content;
          expect(hash).toBe(
            domainSeparatedSha256('icarus:workflow-recipe:1\n', withoutHash),
          );
        }
        if (resource.resource_type === 'dependency_contract') {
          const { contract_hash: hash, ...withoutHash } = resource.content;
          expect(hash).toBe(
            domainSeparatedSha256(
              'icarus:workflow-semantic-correction-dependency-contract:1\n',
              withoutHash,
            ),
          );
        }
      }
      if (input.source_kind === 'workflow_definition') {
        const source = sourceFor(built, input.case_id);
        const { definition_hash: definitionHash, ...withoutHash } = source;
        expect(definitionHash, input.case_id).toBe(
          domainSeparatedSha256('icarus:workflow-definition:1\n', withoutHash),
        );
      }
    }
  });

  it('enumerates and verifies every reachable Capability, Wait, and Recipe dependency', () => {
    const built = buildSemanticCorrectionCandidate();
    let capabilityBearingSnapshots = 0;
    for (const input of built.inputs.cases) {
      const snapshot = snapshotFor(built, input.case_id).payload;
      assertJsonObject(snapshot.registry_snapshot);
      const resources = registryResources(snapshot);
      const byKey = new Map<string, JsonObject>(
        resources.map((resource) => {
          assertJsonObject(resource.ref);
          return [
            `${resource.ref.id}@${resource.ref.version}`,
            resource,
          ] as const;
        }),
      );
      const closures = snapshot.registry_snapshot.dependency_closures;
      if (!Array.isArray(closures)) {
        throw new Error(`Dependency closures missing: ${input.case_id}`);
      }
      expect(
        snapshot.registry_snapshot.dependency_closure_count,
        input.case_id,
      ).toBe(closures.length);
      if (
        resources.some((resource) => resource.resource_type === 'capability')
      ) {
        capabilityBearingSnapshots += 1;
      }
      for (const closure of closures) {
        assertJsonObject(closure);
        assertJsonObject(closure.root_ref);
        const rootKey = `${closure.root_ref.id}@${closure.root_ref.version}`;
        const root = byKey.get(rootKey);
        assertJsonObject(root);
        assertJsonObject(root.content);
        expect(root.resource_type).toBe(closure.root_resource_type);
        const visited = new Set([rootKey]);
        const transitive = new Map<string, JsonObject>();
        const queue = [...versionedRefs(root.content).values()];
        while (queue.length > 0) {
          const dependencyRef = queue.shift() as JsonObject;
          const key = `${dependencyRef.id}@${dependencyRef.version}`;
          if (visited.has(key)) continue;
          visited.add(key);
          const dependency = byKey.get(key);
          assertJsonObject(dependency);
          transitive.set(key, dependency);
          assertJsonObject(dependency.content);
          queue.push(...versionedRefs(dependency.content).values());
        }
        const expectedMembers = [...transitive.values()]
          .sort((left, right) => {
            assertJsonObject(left.ref);
            assertJsonObject(right.ref);
            const leftKey = `${left.ref.id}@${left.ref.version}`;
            const rightKey = `${right.ref.id}@${right.ref.version}`;
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          })
          .map((resource) => ({
            resource_type: resource.resource_type,
            ref: resource.ref,
            content_hash: resource.content_hash,
          }));
        expect(closure.members, `${input.case_id}/${rootKey}`).toEqual(
          expectedMembers,
        );
        expect(closure.member_count).toBe(expectedMembers.length);
        const { closure_hash: closureHash, ...withoutHash } = closure;
        expect(closureHash).toBe(
          domainSeparatedSha256(
            COMPILER_SNAPSHOT_DEPENDENCY_CLOSURE_DOMAIN_V1,
            withoutHash,
          ),
        );
        if (root.resource_type === 'capability') {
          expect(root.content.dependency_closure_hash).toBe(closureHash);
          expect(
            expectedMembers.some(
              (member) =>
                (member.ref as JsonObject).id === 'fixture.executor' &&
                member.resource_type === 'executor_implementation',
            ),
            `${input.case_id}/${rootKey}`,
          ).toBe(true);
        }
      }
    }
    expect(capabilityBearingSnapshots).toBe(20);

    const waitSnapshot = snapshotFor(built, 'positive.wait').payload;
    const waitResources = registryResources(waitSnapshot);
    expect(waitResources).toContainEqual(
      expect.objectContaining({
        resource_type: 'authorization_policy',
        ref: { id: 'fixture.authorization', version: '1.0.0' },
      }),
    );
    const qualityResources = registryResources(
      snapshotFor(built, 'positive.quality-revision-binding').payload,
    );
    expect(qualityResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource_type: 'evaluator',
          ref: { id: 'fixture.evaluator', version: '1.0.0' },
        }),
        expect.objectContaining({
          resource_type: 'quality_gate',
          ref: { id: 'fixture.quality-gate', version: '1.0.0' },
        }),
      ]),
    );
  });

  it('derives integrity mismatch from one exact field and compiles the matching control', () => {
    const built = buildSemanticCorrectionCandidate();
    const mismatchId = 'negative.compiler-integrity-mismatch';
    const controlId = 'positive.compiler-integrity-match-control';
    const mismatchInput = inputFor(built, mismatchId);
    const controlInput = inputFor(built, controlId);
    expect(built.files.get(mismatchInput.raw_source_bytes_ref)).toBe(
      built.files.get(controlInput.raw_source_bytes_ref),
    );
    const mismatchIdentity = snapshotFor(built, mismatchId).payload
      .compiler_identity as JsonObject;
    const controlIdentity = snapshotFor(built, controlId).payload
      .compiler_identity as JsonObject;
    expect(
      Object.keys(controlIdentity).filter(
        (field) =>
          JSON.stringify(controlIdentity[field]) !==
          JSON.stringify(mismatchIdentity[field]),
      ),
    ).toEqual(['proof_algorithm_hash']);
    const resultByCase = new Map(
      built.results.map((entry) => [entry.case_id, entry]),
    );
    expect(resultByCase.get(controlId)?.outcome).toBe('compiled');
    expect(resultByCase.get(mismatchId)?.diagnostics[0]).toMatchObject({
      code: 'compiler_integrity_mismatch',
      phase: 'hash',
      instance_pointer: '/compiler_identity/proof_algorithm_hash',
    });
    const orderedMismatch = compileMutation(
      built,
      controlId,
      undefined,
      (snapshot) => {
        assertJsonObject(snapshot.compiler_identity);
        snapshot.compiler_identity.compiler_toolchain_hash = `sha256:${'e'.repeat(64)}`;
        snapshot.compiler_identity.compiler_version = '0.0.0-mismatch';
      },
    );
    expect(orderedMismatch.ok).toBe(false);
    if (!orderedMismatch.ok) {
      expect(orderedMismatch.value.diagnostics[0].instance_pointer).toBe(
        '/compiler_identity/compiler_toolchain_hash',
      );
    }
  });

  it('enforces Definition kind and Wait required-input contracts', () => {
    const built = buildSemanticCorrectionCandidate();
    const lowered = built.results.find(
      (entry) => entry.case_id === 'positive.static-lowering',
    );
    expect(lowered?.outcome).toBe('compiled');
    if (lowered?.outcome === 'compiled') {
      expect(
        (lowered.normalized_plan.nodes as JsonObject[]).map((node) => ({
          id: node.id,
          type: node.type,
          exit: node.exit,
        })),
      ).toEqual([
        { id: 'capability', type: 'delegation', exit: undefined },
        { id: 'failure', type: 'terminal', exit: 'failure' },
        { id: 'success', type: 'terminal', exit: 'success' },
      ]);
      expect(lowered.normalized_plan.control_edges).toHaveLength(2);
    }
    const definitionMismatch = compileMutation(
      built,
      'positive.static-lowering',
      undefined,
      (snapshot) => {
        const capability = registryResources(snapshot).find(
          (entry) => entry.resource_type === 'capability',
        );
        assertJsonObject(capability);
        assertJsonObject(capability.content);
        capability.content.node_type = 'system';
      },
    );
    expect(definitionMismatch.ok).toBe(false);
    if (!definitionMismatch.ok) {
      expect(definitionMismatch.value.diagnostics[0]).toMatchObject({
        code: 'capability_not_allowed',
        instance_pointer: '/states/start/capability_ref',
      });
    }
    const missingWaitBinding = compileMutation(
      built,
      'positive.wait',
      (source) => {
        source.data_edges = [];
      },
    );
    expect(missingWaitBinding.ok).toBe(false);
    if (!missingWaitBinding.ok) {
      expect(missingWaitBinding.value.diagnostics[0]).toMatchObject({
        code: 'schema_not_assignable',
        phase: 'bind',
      });
    }
  });

  it('freezes typed structural-owner outputs and proves Map item assignability', () => {
    const built = buildSemanticCorrectionCandidate();
    const resultByCase = new Map(
      built.results.map((entry) => [entry.case_id, entry]),
    );
    for (const [caseId, port, generator] of [
      ['positive.subgraph', 'completion', 'child_completion'],
      ['positive.expand', 'completion', 'child_completion'],
      ['positive.map', 'results', 'map_result'],
      ['positive.static-child-closure', 'completion', 'child_completion'],
    ] as const) {
      const result = resultByCase.get(caseId);
      expect(result?.outcome, caseId).toBe('compiled');
      if (result?.outcome !== 'compiled') continue;
      const owner = (result.normalized_plan.nodes as JsonObject[]).find(
        (node) =>
          node.type === 'subgraph' ||
          node.type === 'expand' ||
          node.type === 'map',
      );
      assertJsonObject(owner);
      assertJsonObject(owner.output_ports);
      assertJsonObject(owner.output_ports[port]);
      assertJsonObject((owner.output_ports[port] as JsonObject).schema);
      expect(
        ((owner.output_ports[port] as JsonObject).schema as JsonObject)
          .generator,
        caseId,
      ).toBe(generator);
      expect(
        ((owner.output_ports[port] as JsonObject).schema as JsonObject)
          .schema_json,
        caseId,
      ).toBeTruthy();
    }

    const mapSource = sourceFor(built, 'positive.map');
    const itemsEdge = (mapSource.data_edges as JsonObject[])[0];
    assertJsonObject(itemsEdge);
    assertJsonObject(itemsEdge.from);
    expect(itemsEdge.from.value).toEqual(['accepted', 'rejected']);
    const mapSnapshot = snapshotFor(built, 'positive.map').payload;
    const mapSchemas = registryResources(mapSnapshot);
    const itemsSchema = mapSchemas.find((resource) => {
      assertJsonObject(resource.ref);
      return resource.ref.id === 'fixture.schema.string-array';
    });
    const childSchema = mapSchemas.find((resource) => {
      assertJsonObject(resource.ref);
      return resource.ref.id === 'fixture.schema.string-wide';
    });
    assertJsonObject(itemsSchema);
    assertJsonObject(itemsSchema.content);
    assertJsonObject(itemsSchema.content.items);
    assertJsonObject(childSchema);
    expect(itemsSchema.content.items).toMatchObject({
      type: 'string',
      enum: ['accepted', 'rejected'],
    });
    expect(childSchema.resource_type).toBe('schema');

    const incompatible = compileMutation(
      built,
      'positive.map',
      undefined,
      (snapshot) => {
        const schema = registryResources(snapshot).find((resource) => {
          assertJsonObject(resource.ref);
          return resource.ref.id === 'fixture.schema.string-array';
        });
        assertJsonObject(schema);
        assertJsonObject(schema.content);
        schema.content.items = { type: 'string' };
      },
    );
    expect(incompatible.ok).toBe(false);
    if (!incompatible.ok) {
      expect(incompatible.value.diagnostics[0].code).toBe(
        'schema_not_assignable',
      );
    }
  });

  it('enforces child interface and node allowlists on every child path', () => {
    const built = buildSemanticCorrectionCandidate();
    for (const caseId of [
      'positive.subgraph',
      'positive.map',
      'positive.expand',
    ]) {
      const outcome = compileMutation(built, caseId, undefined, (snapshot) => {
        childProfile(snapshot, 'fixture.policy.child-tight').request = {
          ...(childProfile(snapshot, 'fixture.policy.child-tight')
            .request as JsonObject),
          allowed_interface_refs: [],
        };
      });
      expect(outcome.ok, caseId).toBe(false);
      if (!outcome.ok) {
        expect(outcome.value.diagnostics[0].code, caseId).toBe(
          'capability_not_allowed',
        );
      }
    }
    const nestedClosure = compileMutation(
      built,
      'positive.static-child-closure',
      undefined,
      (snapshot) => {
        const leaf = childProfile(snapshot, 'fixture.policy.child-leaf');
        assertJsonObject(leaf.request);
        leaf.request.allowed_node_types = [];
      },
    );
    expect(nestedClosure.ok).toBe(false);
    if (!nestedClosure.ok) {
      expect(nestedClosure.value.diagnostics[0].code).toBe(
        'capability_not_allowed',
      );
    }
    const invalidExpandCandidate = compileMutation(
      built,
      'positive.expand',
      (source) => {
        if (!Array.isArray(source.data_edges))
          throw new Error('Expand edge missing');
        assertJsonObject(source.data_edges[0]);
        assertJsonObject(source.data_edges[0].from);
        assertJsonObject(source.data_edges[0].from.value);
        source.data_edges[0].from.value.interface_ref = {
          id: 'fixture.interface.root',
          version: '1.0.0',
        };
      },
    );
    expect(invalidExpandCandidate.ok).toBe(false);
    if (!invalidExpandCandidate.ok) {
      expect(invalidExpandCandidate.value.diagnostics[0].code).toBe(
        'schema_not_assignable',
      );
    }
  });

  it('checks only the selected Recipe closure and binds the real cycle', () => {
    const built = buildSemanticCorrectionCandidate();
    const cycle = built.results.find(
      (entry) => entry.case_id === 'negative.child-recipe-dependency-cycle',
    )!;
    expect(cycle.diagnostics[0]).toMatchObject({
      code: 'child_recipe_dependency_cycle',
      stable_object_id: 'fixture.recipe.cycle-a',
    });
    const cycleResources = registryResources(
      snapshotFor(built, 'negative.child-recipe-dependency-cycle').payload,
    ).filter((entry) => {
      assertJsonObject(entry.ref);
      return String(entry.ref.id).startsWith('fixture.recipe.cycle-');
    });
    const unrelatedCycle = compileMutation(
      built,
      'positive.static-lowering',
      undefined,
      (snapshot) => {
        assertJsonObject(snapshot.registry_snapshot);
        const resources = registryResources(snapshot);
        snapshot.registry_snapshot.resources = [
          ...resources,
          ...clone(cycleResources),
        ];
      },
    );
    expect(unrelatedCycle.ok).toBe(true);
  });

  it('rejects missing reachable execution and Wait authorization dependencies', () => {
    const built = buildSemanticCorrectionCandidate();
    const missingExecutor = compileMutation(
      built,
      'positive.static-lowering',
      undefined,
      (snapshot) => {
        assertJsonObject(snapshot.registry_snapshot);
        snapshot.registry_snapshot.resources = registryResources(
          snapshot,
        ).filter((resource) => {
          assertJsonObject(resource.ref);
          return resource.ref.id !== 'fixture.executor';
        });
      },
    );
    expect(missingExecutor.ok).toBe(false);
    if (!missingExecutor.ok) {
      expect(missingExecutor.value.diagnostics[0]).toMatchObject({
        code: 'registry_ref_not_found',
        stable_object_id: 'fixture.executor',
      });
    }
    const missingAuthorization = compileMutation(
      built,
      'positive.wait',
      undefined,
      (snapshot) => {
        assertJsonObject(snapshot.registry_snapshot);
        snapshot.registry_snapshot.resources = registryResources(
          snapshot,
        ).filter((resource) => {
          assertJsonObject(resource.ref);
          return resource.ref.id !== 'fixture.authorization';
        });
      },
    );
    expect(missingAuthorization.ok).toBe(false);
    if (!missingAuthorization.ok) {
      expect(missingAuthorization.value.diagnostics[0]).toMatchObject({
        code: 'registry_ref_not_found',
        stable_object_id: 'fixture.authorization',
      });
    }
  });

  it('keeps policy and Recipe negatives single-invalidity inputs', () => {
    const built = buildSemanticCorrectionCandidate();
    const repairedPolicy = compileMutation(
      built,
      'negative.policy-escalation',
      undefined,
      (snapshot) => {
        const escalating = childProfile(
          snapshot,
          'fixture.policy.child-escalating',
        );
        assertJsonObject(escalating.request);
        assertJsonObject(escalating.request.effect_policy);
        escalating.request.effect_policy.max_impact = 'mutable_effects';
      },
    );
    expect(repairedPolicy.ok).toBe(true);

    const repairedSet = compileMutation(
      built,
      'negative.child-recipe-set-mismatch',
      (source) => {
        assertJsonObject(source.states);
        assertJsonObject(source.states.start);
        assertJsonObject(source.states.start.on_complete);
        assertJsonObject(source.states.start.on_complete.success);
        delete source.states.start.on_complete.success.effects;
        rehashDefinition(source);
      },
    );
    expect(repairedSet.ok).toBe(true);

    const repairedRemovedField = compileMutation(
      built,
      'negative.definition-child-creation-key-template',
      (source) => {
        assertJsonObject(source.states);
        assertJsonObject(source.states.start);
        assertJsonObject(source.states.start.on_complete);
        assertJsonObject(source.states.start.on_complete.success);
        assertJsonObject(source.states.start.on_complete.success.effects);
        const operations = source.states.start.on_complete.success.effects
          .operations as JsonObject[];
        delete operations[0].creation_key_template;
        rehashDefinition(source);
      },
    );
    expect(repairedRemovedField.ok).toBe(true);

    for (const caseId of [
      'negative.child-recipe-set-mismatch',
      'negative.child-recipe-dependency-cycle',
      'negative.definition-child-creation-key-template',
    ]) {
      const resources = registryResources(snapshotFor(built, caseId).payload);
      const definitions = new Set(
        resources
          .filter((resource) => resource.resource_type === 'definition')
          .map((resource) => {
            assertJsonObject(resource.ref);
            return String(resource.ref.id);
          }),
      );
      for (const recipe of resources.filter(
        (resource) => resource.resource_type === 'recipe',
      )) {
        assertJsonObject(recipe.content);
        assertJsonObject(recipe.content.definition_ref);
        expect(
          definitions.has(String(recipe.content.definition_ref.id)),
          `${caseId}/${String((recipe.ref as JsonObject).id)}`,
        ).toBe(true);
      }
    }
  });

  it('validates cancellation pairings before producing safe early-close proof', () => {
    const built = buildSemanticCorrectionCandidate();
    const invalid = compileMutation(
      built,
      'positive.condition-route',
      undefined,
      (snapshot) => {
        const capability = registryResources(snapshot).find(
          (entry) => entry.resource_type === 'capability',
        );
        assertJsonObject(capability);
        assertJsonObject(capability.content);
        assertJsonObject(capability.content.effect);
        capability.content.effect.type = 'idempotent';
        capability.content.cancellation = { type: 'requires_compensation' };
      },
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.value.diagnostics[0].code).toBe('capability_not_allowed');
    }
    const safe = compileMutation(
      built,
      'positive.condition-route',
      (source) => {
        assertJsonObject(source.completion);
        source.completion.early_rules = [
          {
            id: 'early_done',
            phase: 'early',
            arbitration: 'first_eligible',
            same_event_priority: 10,
            when: { fact: 'candidate_count', cmp: 'gte', value: 1 },
            select: {
              exits: ['done'],
              pick: { type: 'first_reached' },
            },
          },
        ];
      },
      (snapshot) => {
        const capability = registryResources(snapshot).find(
          (entry) => entry.resource_type === 'capability',
        );
        assertJsonObject(capability);
        assertJsonObject(capability.content);
        assertJsonObject(capability.content.effect);
        capability.content.effect.type = 'compensatable';
        capability.content.cancellation = { type: 'requires_compensation' };
      },
    );
    expect(safe.ok).toBe(true);
    if (safe.ok) {
      const completion = safe.value.plan.completion as JsonObject;
      const early = completion.early_rules as JsonObject[];
      expect(early[0].cancellation_safety_proof).not.toBeNull();
    }
  });

  it('gives all nine SR-009 graphs a terminal path and one target invalidity', () => {
    const built = buildSemanticCorrectionCandidate();
    const ids = [
      'negative.graph-endpoint-not-found',
      'negative.graph-dependency-cycle',
      'negative.json-pointer-non-total',
      'negative.schema-not-assignable',
      'negative.capability-not-allowed',
      'negative.policy-escalation',
      'negative.quality-revision-missing-feedback-schema',
      'negative.quality-revision-effect-key-incompatible',
      'negative.quality-revision-missing-quality-gate',
    ];
    const resultByCase = new Map(
      built.results.map((entry) => [entry.case_id, entry]),
    );
    for (const caseId of ids) {
      const source = sourceFor(built, caseId);
      if (!Array.isArray(source.nodes))
        throw new Error(`Nodes missing: ${caseId}`);
      expect(
        source.nodes.some((node) => {
          assertJsonObject(node);
          return node.type === 'terminal';
        }),
        caseId,
      ).toBe(true);
      expect(resultByCase.get(caseId)?.diagnostics, caseId).toHaveLength(1);
    }
  });

  it('treats the undocumented double-colon token as an ordinary unknown Node ID', () => {
    const result = buildSemanticCorrectionCandidate().results.find(
      (entry) => entry.case_id === 'negative.graph-cross-scope-edge',
    )!;
    expect(result.diagnostics[0]).toMatchObject({
      code: 'graph_endpoint_not_found',
      stable_object_id: 'edge.cross',
    });
  });

  it('lowers the exact Capability Outbox binding and finite Policy snapshot', () => {
    const result = buildSemanticCorrectionCandidate().results.find(
      (entry) => entry.case_id === 'positive.static-lowering',
    );
    expect(result?.outcome).toBe('compiled');
    if (!result || result.outcome !== 'compiled') return;
    const nodes = result.normalized_plan.nodes as JsonObject[];
    const capability = nodes.find(
      (node) => node.type === 'delegation',
    ) as JsonObject;
    assertJsonObject(capability.outbox_execution_binding);
    const binding = capability.outbox_execution_binding;
    expect(binding).toMatchObject({
      adapter_identity: {
        resource_type: 'outbox_adapter',
        ref: {
          id: 'fixture.adapter.capability-dispatch',
          version: '1.0.0',
        },
      },
      delivery_policy_identity: {
        resource_type: 'outbox_policy',
        ref: {
          id: 'fixture.outbox-policy.normal-delivery',
          version: '1.0.0',
        },
      },
      effect_contract: {
        delivery_lane: 'normal_execution',
        reconciliation: { type: 'not_required' },
        idempotency: 'provider_key',
        delivery_requirement: 'required',
      },
    });
    assertJsonObject(binding.effective_policy_snapshot);
    expect(binding.effective_policy_snapshot.snapshot_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    assertJsonObject(binding.effective_policy_snapshot.effective_policy);
    expect(
      binding.effective_policy_snapshot.effective_policy.max_delivery_attempts,
    ).toBe(8);
  });

  it.each([
    [
      'missing binding',
      'capability_not_allowed',
      (snapshot: JsonObject) => {
        const capability = registryResources(snapshot).find(
          (entry) => entry.resource_type === 'capability',
        );
        assertJsonObject(capability);
        assertJsonObject(capability.content);
        delete capability.content.outbox_effect;
      },
    ],
    [
      'latest Adapter ref',
      'registry_ref_unpinned',
      (snapshot: JsonObject) => {
        const capability = registryResources(snapshot).find(
          (entry) => entry.resource_type === 'capability',
        );
        assertJsonObject(capability);
        assertJsonObject(capability.content);
        assertJsonObject(capability.content.outbox_effect);
        assertJsonObject(capability.content.outbox_effect.adapter_ref);
        capability.content.outbox_effect.adapter_ref.version = 'latest';
      },
    ],
    [
      'unpublished Adapter',
      'capability_not_allowed',
      (snapshot: JsonObject) => {
        const adapter = registryResources(snapshot).find(
          (entry) => entry.resource_type === 'outbox_adapter',
        );
        assertJsonObject(adapter);
        adapter.publication_state = 'staged';
      },
    ],
    [
      'Policy drift',
      'compiler_integrity_mismatch',
      (snapshot: JsonObject) => {
        const policy = registryResources(snapshot).find(
          (entry) => entry.resource_type === 'outbox_policy',
        );
        assertJsonObject(policy);
        assertJsonObject(policy.content);
        policy.content.max_delivery_attempts = 9;
      },
    ],
  ] as const)('rejects %s before Plan execution', (_label, code, mutate) => {
    const result = compileMutation(
      buildSemanticCorrectionCandidate(),
      'positive.static-lowering',
      undefined,
      mutate,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.value.diagnostics[0].code).toBe(code);
  });
});
