import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import { COMPILED_PLAN_V2_DOMAIN_SEPARATOR } from '../contracts/compiler-contract-repair-source.js';
import type { WorkflowCompilerStaticChildPlanBundle } from '../contracts/static-child-plan-bundle-types.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import type { G3RegistryResourceType } from '../contracts/g3-registry-persistence-types.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { compileWorkflow } from '../compiler/compiler.js';
import { readGoldenCorpus } from '../compiler/golden.js';
import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import {
  calculateCreationIntentHash,
  createWorkflowT0,
} from '../creation/task-intake.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  materializeRootScopeT2b,
  persistCompileResultT2a,
} from './reconciler.js';
import {
  createG5TestBootstrap,
  type G5TestBootstrapInstance,
} from './g5-test-bootstrap.js';

const g3Types = new Set<string>([
  'schema',
  'recipe',
  'definition',
  'execution_policy',
  'command_policy',
  'context_contract',
  'routing_scope',
  'wait_contract',
  'operational_remediation_policy',
  'capability',
  'outbox_adapter',
  'outbox_policy',
]);

export const g6Hash = (label: string): Sha256Hash =>
  domainSeparatedSha256('icarus:g6-runtime-test:1\n', { label });

export interface G6CompiledFixture {
  readonly source: JsonObject;
  readonly snapshot: JsonObject;
  readonly plan: CompiledScopePlanV2Document;
  readonly staticChildPlanBundle: WorkflowCompilerStaticChildPlanBundle;
  readonly childSource: JsonObject;
  readonly childPlan: CompiledScopePlanV2Document;
}

export interface G6Seed {
  readonly refs: Record<string, RuntimeRegistryRef>;
  readonly values: Record<string, RuntimeValueRef>;
  readonly snapshotId: string;
  readonly snapshotHash: Sha256Hash;
  readonly closureId: string;
  readonly closureHash: Sha256Hash;
}

export interface G6MapFixture {
  readonly instance: G5TestBootstrapInstance;
  readonly seed: G6Seed;
  readonly source: JsonObject;
  readonly plan: CompiledScopePlanV2Document;
  readonly childSource: JsonObject;
  readonly childPlan: CompiledScopePlanV2Document;
  readonly workflowId: string;
  readonly graphRunId: string;
  readonly rootScopeId: string;
  readonly rootBuildId: string;
  readonly rootPlanId: string;
}

export interface G6MapFixtureOptions {
  readonly dynamicMode?: 'subgraph' | 'expand' | 'map';
  readonly errorTransitionEffects?: readonly JsonObject[];
  readonly errorTargetKind?: 'terminal' | 'graph';
  readonly temporaryReplanRoute?: boolean;
  readonly stateConfigContent?: JsonObject;
  readonly mapCompletionPolicy?: JsonObject;
  readonly domainClaims?: readonly {
    namespace: string;
    keyHash: Sha256Hash;
    mode: 'shared' | 'exclusive';
  }[];
  readonly compiledFixture?: G6CompiledFixture;
  readonly bootstrapInstance?: G5TestBootstrapInstance;
  readonly runResourceLimits?: Readonly<Record<string, number>>;
}

function compileDynamicFixture(
  options: G6MapFixtureOptions,
): G6CompiledFixture {
  const mode = options.dynamicMode ?? 'map';
  const goldenCase = readGoldenCorpus().cases.cases.find(
    (entry) => entry.case_id === `positive.${mode}`,
  );
  if (!goldenCase) throw new Error(`Golden case missing: positive.${mode}`);
  const source = JSON.parse(
    Buffer.from(goldenCase.raw_source_base64, 'base64').toString('utf8'),
  ) as JsonObject;
  if (options.mapCompletionPolicy) {
    const nodes = source.nodes as JsonObject[];
    const mapNode = nodes.find((node) => node.type === 'map');
    if (!mapNode) throw new Error('Current G2 Map source has no Map owner');
    mapNode.completion = options.mapCompletionPolicy;
  }
  const snapshot = goldenCase.registry_snapshot;
  const outcome = compileWorkflow({
    caseId: `g6-runtime-positive-${mode}`,
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
    inputSnapshot: snapshot,
  });
  if (!outcome.ok)
    throw new Error(
      `Current G2 ${mode} fixture did not compile: ${canonicalJson(outcome.value.diagnostics)}`,
    );
  let child = outcome.value.staticChildPlanBundle.entries[0];
  if (mode === 'expand') {
    const subgraph = compileDynamicFixture({ dynamicMode: 'subgraph' });
    const dynamicSource = (
      (source.data_edges as JsonObject[])[0]!.from as JsonObject
    ).value as JsonObject;
    const sourceHash = domainSeparatedSha256(
      'icarus:workflow-graph-source:1\n',
      dynamicSource,
    );
    const planWithoutHash = {
      ...subgraph.childPlan,
      source_hash: sourceHash,
    } as unknown as Record<string, unknown>;
    delete planWithoutHash.plan_hash;
    const dynamicPlan = {
      ...planWithoutHash,
      plan_hash: domainSeparatedSha256(
        COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
        planWithoutHash as JsonObject,
      ),
    } as unknown as CompiledScopePlanV2Document;
    child = {
      closureKey: 'expand_child',
      source: dynamicSource,
      plan: dynamicPlan,
    };
  }
  if (
    !child ||
    outcome.value.staticChildPlanBundle.entries.length !==
      (mode === 'expand' ? 0 : 1)
  )
    throw new Error(`Current G2 ${mode} fixture child Plan set drifted`);
  return {
    source,
    snapshot,
    plan: outcome.value.plan,
    staticChildPlanBundle: outcome.value.staticChildPlanBundle,
    childSource: child.source,
    childPlan: child.plan,
  };
}

function rowId(resourceType: string, ref: { id: string; version: string }) {
  return g3Types.has(resourceType)
    ? registryResourceId({
        resource_type: resourceType as G3RegistryResourceType,
        ref,
      })
    : `resource:g6:${resourceType}:${ref.id}@${ref.version}`;
}

function seedG6Runtime(
  store: WorkflowRuntimeStore,
  compiled: G6CompiledFixture,
  options: G6MapFixtureOptions,
): G6Seed {
  const snapshotResources = (
    (compiled.snapshot.registry_snapshot as JsonObject)
      .resources as JsonObject[]
  ).map((resource) => ({
    name: `compiler:${String((resource.ref as JsonObject).id)}`,
    resourceType: String(resource.resource_type),
    ref: resource.ref as { id: string; version: string },
    hash: resource.content_hash as Sha256Hash,
    content: resource.content,
  }));
  const specs: Array<{
    name: string;
    resourceType: string;
    ref: { id: string; version: string };
    hash: Sha256Hash;
    content: JsonValue;
  }> = [
    {
      name: 'schema',
      resourceType: 'schema',
      ref: { id: 'g6.schema.generic', version: '1.0.0' },
      hash: g6Hash('resource:schema'),
      content: {},
    },
    ...[
      ['recipe', 'recipe'],
      ['definition', 'definition'],
      ['executionPolicy', 'execution_policy'],
      ['commandPolicy', 'command_policy'],
      ['inputSchema', 'schema'],
      ['contextContract', 'context_contract'],
      ['routingScope', 'routing_scope'],
      ['waitContract', 'wait_contract'],
      ['supportedLimits', 'runtime_supported_limits'],
      ['sqliteProfile', 'sqlite_execution_profile'],
      ['finalizationPolicy', 'root_finalization_policy'],
      ['fenceManifestSchema', 'schema'],
      ['mapItemResultsManifestSchema', 'schema'],
      ['outboxAdapter', 'outbox_adapter'],
      ['outboxPolicy', 'outbox_policy'],
    ].map(([name, resourceType]) => ({
      name,
      resourceType,
      ref: { id: `g6.${name}`, version: '1.0.0' },
      hash: g6Hash(`resource:${name}`),
      content: {},
    })),
    ...snapshotResources,
  ];
  const refs: Record<string, RuntimeRegistryRef> = {};
  for (const spec of specs) {
    refs[spec.name] = {
      rowId: rowId(spec.resourceType, spec.ref),
      resourceType: spec.resourceType,
      ref: spec.ref,
      hash: spec.hash,
    };
  }
  const values: Record<string, RuntimeValueRef> = {
    input: { id: 'value:g6:input', hash: g6Hash('value:input') },
    attachments: {
      id: 'value:g6:attachments',
      hash: g6Hash('value:attachments'),
    },
    context: { id: 'value:g6:context', hash: g6Hash('value:context') },
    routing: { id: 'value:g6:routing', hash: g6Hash('value:routing') },
    stateConfig: {
      id: 'value:g6:state-config',
      hash: g6Hash('value:state-config'),
    },
    safety: {
      id: 'value:g6:safety',
      hash: compiled.plan.runtime_safety_hash as Sha256Hash,
    },
    source: {
      id: 'value:g6:source',
      hash: compiled.plan.source_hash as Sha256Hash,
    },
    childInput: {
      id: 'value:g6:child-input',
      hash: g6Hash('value:child-input'),
    },
    childSource: {
      id: 'value:g6:child-source',
      hash: compiled.childPlan.source_hash as Sha256Hash,
    },
  };
  const snapshotId = 'snapshot:g6';
  const snapshotHash = g6Hash('registry-snapshot');
  const closureId = 'closure:g6';
  const closureHash = g6Hash('closure');
  store.withImmediateTransaction((transaction) => {
    for (const spec of specs) {
      const ref = refs[spec.name]!;
      const valueId = `value:g6:resource:${spec.name}`;
      const content = canonicalJson(
        spec.name === 'definition'
          ? {
              compiled_plan_pin: {
                plan_hash: compiled.plan.plan_hash,
                plan_format: compiled.plan.format,
                compiler_version: compiled.plan.compiler_version,
                provenance: 'golden_corpus',
              },
              states: {
                run: {
                  type: 'graph',
                  on_error: {
                    target:
                      options.errorTargetKind === 'graph' ? 'next' : 'failed',
                    ...(options.errorTransitionEffects
                      ? {
                          effects: {
                            operations: [...options.errorTransitionEffects],
                          },
                        }
                      : {}),
                  },
                  on_local_cancel: { target: 'cancelled' },
                  ...(options.temporaryReplanRoute
                    ? { on_temporary_replan: { target: 'run' } }
                    : {}),
                },
                failed: {
                  type: 'terminal',
                  terminal_kind: 'errored',
                  error_code: 'g6_fixture_failed',
                },
                next: {
                  type: 'graph',
                  on_error: { target: 'failed' },
                  on_local_cancel: { target: 'cancelled' },
                },
                cancelled: {
                  type: 'terminal',
                  terminal_kind: 'errored',
                  error_code: 'g6_fixture_cancelled',
                },
              },
            }
          : spec.content,
      );
      transaction.execute(
        `INSERT INTO workflow_values (
           id, storage_kind, inline_canonical_json, blob_hash,
           immutable_external_locator, expected_hash, content_hash, byte_length,
           media_type, schema_resource_id, schema_resource_hash, provenance_ref,
           retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
           row_version
         ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
           ?, ?, 'g6-test', 'pinned', 'live', NULL, 1, 1)`,
        [
          valueId,
          content,
          ref.hash,
          Buffer.byteLength(content),
          refs.schema!.rowId,
          refs.schema!.hash,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_registry_resources (
           id, resource_type, resource_id, resource_version, owner_core_ref,
           owner_feature_id, canonical_value_id, content_hash,
           publication_state, created_at_ms, published_at_ms, retired_at_ms,
           row_version
         ) VALUES (?, ?, ?, ?, 'icarus.core@1.0.0', NULL, ?, ?, 'published',
           1, 1, NULL, 1)`,
        [
          ref.rowId,
          ref.resourceType,
          ref.ref.id,
          ref.ref.version,
          valueId,
          ref.hash,
        ],
      );
    }
    const valueContent: Record<string, JsonObject> = {
      input: { items: ['accepted'] },
      attachments: {},
      context: {},
      routing: { reason_codes: ['explicit_recipe'] },
      stateConfig: options.stateConfigContent ?? {},
      safety: compiled.plan.runtime_safety_snapshot as JsonObject,
      source: compiled.source,
      childInput: { item: 'accepted' },
      childSource: compiled.childSource,
    };
    for (const [name, value] of Object.entries(values)) {
      const content = canonicalJson(valueContent[name]!);
      transaction.execute(
        `INSERT INTO workflow_values (
           id, storage_kind, inline_canonical_json, blob_hash,
           immutable_external_locator, expected_hash, content_hash, byte_length,
           media_type, schema_resource_id, schema_resource_hash, provenance_ref,
           retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
           row_version
         ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
           ?, ?, 'g6-test', 'run_recovery', 'live', NULL, 2, 1)`,
        [
          value.id,
          content,
          value.hash,
          Buffer.byteLength(content),
          refs.schema!.rowId,
          refs.schema!.hash,
        ],
      );
    }
    transaction.execute(
      `INSERT INTO workflow_registry_closure_manifests (
         id, closure_hash, manifest_value_id, manifest_hash, created_at_ms
       ) VALUES (?, ?, ?, ?, 2)`,
      [closureId, closureHash, values.context!.id, values.context!.hash],
    );
    transaction.execute(
      `INSERT INTO workflow_registry_snapshots (
         id, snapshot_hash, closure_manifest_id, closure_hash,
         compiler_version, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, 2)`,
      [
        snapshotId,
        snapshotHash,
        closureId,
        closureHash,
        compiled.plan.compiler_version,
      ],
    );
  });
  return { refs, values, snapshotId, snapshotHash, closureId, closureHash };
}

export function createG6MapFixture(
  key: string,
  options: G6MapFixtureOptions = {},
): G6MapFixture {
  const compiled = options.compiledFixture ?? compileDynamicFixture(options);
  const instance =
    options.bootstrapInstance ??
    createG5TestBootstrap(`g6-${options.dynamicMode ?? 'map'}-${key}`);
  const seed = seedG6Runtime(instance.store, compiled, options);
  const creationKey = `g6-map:${key}`;
  const ownershipHash = g6Hash('ownership');
  const creationIntentHash = calculateCreationIntentHash({
    creationDomain: 'assistant',
    creationKey,
    principalRef: 'human:local-owner',
    ownershipHash,
    routingScope: seed.refs.routingScope!,
    recipe: seed.refs.recipe!,
    entryPoint: 'default',
    inputHash: seed.values.input!.hash,
    attachmentManifestHash: seed.values.attachments!.hash,
  });
  const created = createWorkflowT0(instance.store, {
    requestId: `request:${creationKey}`,
    creationDomain: 'assistant',
    creationKey,
    source: 'api',
    actor: 'system',
    launchPolicy: 'auto',
    launchAuthorization: {
      kind: 'trusted_system',
      authorizationRef: `test:${creationKey}`,
    },
    entryPoint: 'default',
    principalRef: 'human:local-owner',
    recipe: seed.refs.recipe!,
    definition: seed.refs.definition!,
    executionPolicy: seed.refs.executionPolicy!,
    commandPolicy: seed.refs.commandPolicy!,
    inputSchema: seed.refs.inputSchema!,
    contextContract: seed.refs.contextContract!,
    routingScope: seed.refs.routingScope!,
    input: seed.values.input!,
    attachments: seed.values.attachments!,
    contextSnapshot: seed.values.context!,
    routingDecision: seed.values.routing!,
    routingDecisionJson: { reason_codes: ['explicit_recipe'] },
    runtimeSafetyHash: seed.values.safety!.hash,
    ownershipHash,
    creationIntentHash,
    workflowDefinitionVersion: '1.0.0',
    recipeVersion: '1.0.0',
    deadlineAtMs: null,
    resourceLimits: {
      state_activations_total: 8,
      graph_runs_total: 8,
      descendant_workflows_total: 8,
    },
    domainClaims: options.domainClaims ?? [],
    initialActivation: {
      stateKey: 'run',
      stateType: 'graph',
      definition: seed.refs.definition!,
      definitionVersion: '1.0.0',
      stateConfig: seed.values.stateConfig!,
      registrySnapshotId: seed.snapshotId,
      registrySnapshotHash: seed.snapshotHash,
      closureManifestId: seed.closureId,
      closureHash: seed.closureHash,
      runtimeSafetySnapshot: seed.values.safety!,
      runtimeSupportedLimits: seed.refs.supportedLimits!,
      sqliteExecutionProfile: seed.refs.sqliteProfile!,
      sourceSeedHash: compiled.plan.source_hash as Sha256Hash,
      compilerSnapshotHash: g6Hash('compiler-snapshot'),
      inputSnapshot: seed.values.input!,
      runResourceLimits: options.runResourceLimits ?? {
        scopes_total: 32,
        nodes_total: 64,
        edges_total: 64,
        map_items_total: 32,
        builds_total: 32,
        build_attempts_total: 32,
        attempts_total: 32,
        waits_total: 32,
        effect_operations_total: 32,
        facts_total: 256,
        active_waits: 8,
        active_executions: 8,
      },
      checkpoint: { status: 'initial' },
      nowMs: 10,
    },
    nowMs: 10,
  });
  const compiledRoot = persistCompileResultT2a(instance.store, {
    graphRunId: created.activation.graphRunId,
    buildId: created.activation.rootBuildId,
    expectedBuildRowVersion: 1,
    expectedRunWorkFenceEpoch: 0,
    expectedOwnerScopeWorkFenceEpoch: 0,
    expectedCompilerSnapshotHash: g6Hash('compiler-snapshot'),
    expectedBuildLease: null,
    sourceJson: compiled.source,
    sourceHash: compiled.plan.source_hash as Sha256Hash,
    plan: compiled.plan,
    staticChildPlanBundle: compiled.staticChildPlanBundle,
    nowMs: 11,
  });
  const run = instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [created.activation.graphRunId],
  )!;
  materializeRootScopeT2b(instance.store, {
    graphRunId: created.activation.graphRunId,
    buildId: created.activation.rootBuildId,
    rootScopeId: created.activation.rootScopeId,
    expectedBuildRowVersion: 2,
    expectedRunRowVersion: run.row_version,
    expectedScopeRowVersion: 1,
    expectedRunWorkFenceEpoch: 0,
    planId: compiledRoot.planId,
    plan: compiled.plan,
    inputSnapshot: seed.values.input!,
    nowMs: 12,
  });
  return {
    instance,
    seed,
    source: compiled.source,
    plan: compiled.plan,
    childSource: compiled.childSource,
    childPlan: compiled.childPlan,
    workflowId: created.workflowId,
    graphRunId: created.activation.graphRunId,
    rootScopeId: created.activation.rootScopeId,
    rootBuildId: created.activation.rootBuildId,
    rootPlanId: compiledRoot.planId,
  };
}
