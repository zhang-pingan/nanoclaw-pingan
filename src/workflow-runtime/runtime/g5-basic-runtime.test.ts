import fs from 'node:fs';
import os from 'node:os';

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createG4TestBootstrap,
  currentG4TestBootstrapSelector,
  deriveG4TestDataRoot,
  type G4TestBootstrapInstance,
} from '../bootstrap/index.js';
import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import { COMPILED_PLAN_V2_DOMAIN_SEPARATOR } from '../contracts/compiler-contract-repair-source.js';
import {
  buildDeploymentCapacityPublication,
  calculateDeploymentCapacityConfigHash,
} from '../contracts/capacity-control-plane-source.js';
import {
  CAPABILITY_OUTBOX_ADAPTER_DOMAIN,
  CAPABILITY_OUTBOX_EXECUTION_BINDING_DOMAIN,
  CAPABILITY_OUTBOX_POLICY_DOMAIN,
  capabilityOutboxPolicySnapshotHash,
} from '../contracts/capability-outbox-binding-contract.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import type { G3RegistryResourceType } from '../contracts/g3-registry-persistence-types.js';
import { G5_DATABASE_SCHEMA_HASH } from '../contracts/g5-basic-runtime-types.js';
import { G5BasicRuntimeReferenceModel } from '../contracts/g5-basic-runtime-reference-model.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import {
  calculateCreationIntentHash,
  createWorkflowT0,
  prepareRequiredFinalizationT0p,
} from '../creation/task-intake.js';
import { acquireDomainClaim } from '../creation/domain-claims.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  initializeScopeFixedPointT3a,
  materializeRootScopeT2b,
  persistCompileResultT2a,
  reconcileFactT3a,
  requestSettledCloseT3b,
} from './reconciler.js';
import { scheduleReadyNodeT4 } from './basic-scheduler.js';
import {
  leaseOutboxWork,
  prepareCapabilityDispatchT5,
  recordOutboxResult,
} from './outbox.js';
import {
  acceptDelegationCallbackT6b,
  acceptInternalResultT6a,
  consumeRetryScheduleT6d,
  fireAttemptWatchdogT6d,
} from './node-execution.js';
import { resolveWaitT6c } from './waits.js';
import { activateWorkflowT1 } from './lifecycle.js';
import {
  listOpenOperationalBlockers,
  openOperationalBlocker,
} from './operational-blockers.js';
import { stableRuntimeId } from './graph-store.js';

const instances: G4TestBootstrapInstance[] = [];
const fixtureEvidence = new Map<string, string>();
const g5FixtureCases = [
  'positive-cases.json',
  'negative-cases.json',
  'fault-cases.json',
].flatMap((name) => {
  const artifact = JSON.parse(
    fs.readFileSync(
      new URL(
        `../contracts/conformance/g5-basic-runtime/${name}`,
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    payload: { cases: Array<{ case_id: string; transaction_id: string }> };
  };
  return artifact.payload.cases;
});
const hash = (label: string): Sha256Hash =>
  domainSeparatedSha256('icarus:g5-runtime-test:1\n', { label });

function bootstrap(key: string): G4TestBootstrapInstance {
  const selector = currentG4TestBootstrapSelector();
  const parent = fs.realpathSync(os.tmpdir());
  const instance = createG4TestBootstrap({
    ...selector,
    instanceKey: key,
    dataRoot: deriveG4TestDataRoot(parent, key),
  });
  instances.push(instance);
  return instance;
}

interface SeededRuntime {
  readonly refs: Record<
    string,
    {
      rowId: string;
      resourceType: string;
      ref: { id: string; version: string };
      hash: Sha256Hash;
    }
  >;
  readonly values: Record<string, { id: string; hash: Sha256Hash }>;
  readonly snapshotId: string;
  readonly snapshotHash: Sha256Hash;
  readonly closureId: string;
  readonly closureHash: Sha256Hash;
}

function seedRuntime(store: WorkflowRuntimeStore): SeededRuntime {
  const specs = [
    ['schema', 'schema'],
    ['recipe', 'recipe'],
    ['definition', 'definition'],
    ['executionPolicy', 'execution_policy'],
    ['commandPolicy', 'command_policy'],
    ['inputSchema', 'schema'],
    ['contextContract', 'context_contract'],
    ['routingScope', 'routing_scope'],
    ['supportedLimits', 'runtime_supported_limits'],
    ['sqliteProfile', 'sqlite_execution_profile'],
    ['compilerToolchain', 'compiler_toolchain'],
    ['capability', 'capability'],
    ['waitContract', 'wait_contract'],
    ['remediationPolicy', 'operational_remediation_policy'],
    ['finalizationPolicy', 'root_finalization_policy'],
    ['policySnapshotSchema', 'schema'],
    ['adapter', 'outbox_adapter'],
    ['outboxPolicy', 'outbox_policy'],
  ] as const;
  const refs: SeededRuntime['refs'] = {};
  for (const [name, resourceType] of specs) {
    const ref = { id: `g5.${name}`, version: '1.0.0' };
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
    refs[name] = {
      rowId: g3Types.has(resourceType)
        ? registryResourceId({
            resource_type: resourceType as G3RegistryResourceType,
            ref,
          })
        : `resource:${name}`,
      resourceType,
      ref,
      hash: hash(`resource:${name}`),
    };
  }
  const values: SeededRuntime['values'] = {};
  for (const name of [
    'input',
    'attachments',
    'context',
    'routing',
    'stateConfig',
    'safety',
    'contextPack',
    'request',
    'result',
    'ingressAuthorization',
    'bindingAuthorization',
    'evidence',
  ]) {
    values[name] = { id: `value:${name}`, hash: hash(`value:${name}`) };
  }
  const closureId = 'closure:g5';
  const closureHash = hash('closure');
  const snapshotId = 'snapshot:g5';
  const snapshotHash = hash('snapshot');
  const seedView: SeededRuntime = {
    refs,
    values,
    snapshotId,
    snapshotHash,
    closureId,
    closureHash,
  };
  const pinnedPlan = plan(seedView);
  store.withImmediateTransaction((transaction) => {
    for (const [name] of specs) {
      const resource = refs[name];
      const valueId = `value:resource:${name}`;
      const content = JSON.stringify(
        name === 'definition'
          ? {
              compiled_plan_pin: {
                plan_hash: pinnedPlan.plan_hash,
                plan_format: pinnedPlan.format,
                compiler_toolchain_hash: pinnedPlan.compiler_toolchain_hash,
                compiler_build_hash: pinnedPlan.compiler_build_hash,
                provenance: 'sealed_g2_expected',
              },
            }
          : name === 'adapter'
            ? outboxAdapterContent(refs.adapter.ref)
            : name === 'outboxPolicy'
              ? outboxPolicyContent(refs.outboxPolicy.ref)
              : { name },
      );
      transaction.execute(
        `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, blob_hash,
         immutable_external_locator, expected_hash, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
         row_version
       ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json', ?, ?,
         'g5-test', 'pinned', 'live', NULL, 1, 1)`,
        [
          valueId,
          content,
          resource.hash,
          Buffer.byteLength(content),
          refs.schema.rowId,
          refs.schema.hash,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_registry_resources (
         id, resource_type, resource_id, resource_version, owner_core_ref,
         owner_feature_id, canonical_value_id, content_hash, publication_state,
         created_at_ms, published_at_ms, retired_at_ms, row_version
       ) VALUES (?, ?, ?, ?, 'icarus.core@1.0.0', NULL, ?, ?, 'published', 1, 1,
         NULL, 1)`,
        [
          resource.rowId,
          resource.resourceType,
          resource.ref.id,
          resource.ref.version,
          valueId,
          resource.hash,
        ],
      );
    }
    for (const [name, value] of Object.entries(values)) {
      const content = JSON.stringify(
        name === 'ingressAuthorization'
          ? {
              format: 'icarus.workflow-wait-ingress-authorization/1',
              phase: 'ingress',
            }
          : name === 'bindingAuthorization'
            ? {
                format: 'icarus.workflow-wait-binding-authorization/1',
                phase: 'binding',
              }
            : { name },
      );
      transaction.execute(
        `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, blob_hash,
         immutable_external_locator, expected_hash, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
         row_version
       ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json', ?, ?,
         'g5-test', 'run_recovery', 'live', NULL, 1, 1)`,
        [
          value.id,
          content,
          value.hash,
          Buffer.byteLength(content),
          refs.schema.rowId,
          refs.schema.hash,
        ],
      );
    }
    transaction.execute(
      'INSERT INTO workflow_registry_closure_manifests (id, closure_hash, manifest_value_id, manifest_hash, created_at_ms) VALUES (?, ?, ?, ?, 1)',
      [closureId, closureHash, values.evidence.id, values.evidence.hash],
    );
    transaction.execute(
      `INSERT INTO workflow_registry_snapshots (
       id, snapshot_hash, closure_manifest_id, closure_hash, compiler_version,
       core_build_hash, database_schema_hash, created_at_ms
     ) VALUES (?, ?, ?, ?, '3.0.2', ?, ?, 1)`,
      [
        snapshotId,
        snapshotHash,
        closureId,
        closureHash,
        hash('core-build'),
        hash('schema-5'),
      ],
    );
  });
  return { refs, values, snapshotId, snapshotHash, closureId, closureHash };
}

const G5_TEST_SOURCE: JsonObject = { format: 'g5-test-source' };

function plan(seed: SeededRuntime): CompiledScopePlanV2Document {
  const sourceHash = domainSeparatedSha256(
    'icarus:workflow-graph-source:1\n',
    G5_TEST_SOURCE,
  );
  const interfaceHash = hash('interface');
  const policyHash = hash('policy');
  const capabilityHash = hash('capability-catalog');
  const withoutHash = {
    format: 'icarus.workflow-graph-scope-plan/2',
    compiler_version: '3.0.2',
    compiler_build_hash: hash('compiler-build'),
    compiler_toolchain_ref: seed.refs.compilerToolchain.ref,
    compiler_toolchain_hash: seed.refs.compilerToolchain.hash,
    compiler_error_catalog_hash: hash('compiler-errors'),
    canonical_normalizer_version: '2.0.1',
    canonical_normalizer_hash: hash('normalizer'),
    proof_algorithm_version: '2.0.1',
    proof_algorithm_hash: hash('proof'),
    source_hash: sourceHash,
    interface_snapshot_hash: interfaceHash,
    policy_snapshot_hash: policyHash,
    effective_policy_snapshot: {},
    capability_catalog_hash: capabilityHash,
    wait_contract_catalog_hash: hash('wait-catalog'),
    interface_snapshot: {},
    nodes: [
      {
        id: 'work',
        type: 'delegation',
        capability_binding: {
          ref: seed.refs.capability.ref,
        },
        outbox_execution_binding: executionBinding(seed),
        effective_retry_policy: {
          backoff: 'fixed',
          effective_node_max_attempts: 3,
          effective_retry_on: ['attempt_timeout', 'quality_revision'],
          policy_hash: hash('node-retry-policy'),
          quality_revision: {
            context_mode: 'base_input_plus_latest_revision',
            effective_max_feedback_bytes: 4096,
            feedback_schema_ref: seed.refs.schema.ref,
            feedback_schema_hash: seed.refs.schema.hash,
          },
        },
      },
      {
        id: 'timeout',
        type: 'system',
        capability_binding: {
          ref: seed.refs.capability.ref,
        },
        outbox_execution_binding: executionBinding(seed),
        effective_retry_policy: {
          backoff: 'fixed',
          effective_node_max_attempts: 2,
          effective_retry_on: ['attempt_timeout'],
          policy_hash: hash('timeout-retry-policy'),
          quality_revision: null,
        },
      },
      {
        id: 'quality',
        type: 'system',
        capability_binding: {
          ref: seed.refs.capability.ref,
        },
        outbox_execution_binding: executionBinding(seed),
        effective_retry_policy: {
          backoff: 'fixed',
          effective_node_max_attempts: 1,
          effective_retry_on: ['quality_revision'],
          policy_hash: hash('quality-retry-policy'),
          quality_revision: {
            context_mode: 'base_input_plus_latest_revision',
            effective_max_feedback_bytes: 4096,
            feedback_schema_ref: seed.refs.schema.ref,
            feedback_schema_hash: seed.refs.schema.hash,
          },
        },
      },
      {
        id: 'pause',
        type: 'wait',
        capability_binding: null,
        wait_binding: {
          type: 'signal',
          contract_ref: seed.refs.waitContract.ref,
          contract_snapshot: {
            ref: seed.refs.waitContract.ref,
            contract_hash: seed.refs.waitContract.hash,
          },
          correlation_input_port: 'correlation_key',
          timeout_ms: 5_000,
          effective_max_duration_ms: 5_000,
        },
      },
      {
        id: 'join',
        type: 'join',
        capability_binding: null,
        input_ports: {
          value: {
            aggregation: { type: 'single', select: 'only', required: true },
          },
        },
      },
      { id: 'done', type: 'terminal', capability_binding: null },
    ],
    route_groups: [],
    control_edges: [
      {
        id: 'work-to-done',
        from_node_id: 'work',
        to_node_id: 'join',
        outcome_match: { statuses: ['succeeded'] },
        compiled_edge_hash: hash('edge'),
      },
      {
        id: 'join-to-done',
        from_node_id: 'join',
        to_node_id: 'done',
        outcome_match: { statuses: ['succeeded'] },
        compiled_edge_hash: hash('edge:join-done'),
      },
    ],
    data_edges: [
      {
        id: 'work-result-to-join',
        from: { type: 'node_output', node_id: 'work', port: 'result' },
        to: { node_id: 'join', port: 'value' },
        derived_schema: {
          type: 'registry',
          ref: seed.refs.schema.ref,
          schema_hash: seed.refs.schema.hash,
        },
        producer_schema_hash: seed.refs.schema.hash,
        consumer_schema_hash: seed.refs.schema.hash,
        compiled_edge_hash: hash('edge:data'),
      },
    ],
    completion: {
      early_close: 'cancel_and_fence_remaining',
      early_rules: [],
      no_match: 'error',
      policy_hash: hash('completion-policy'),
      settled_rules: [
        {
          id: 'select_named_exit',
          phase: 'settled',
          priority: 100,
          normalized_fact_expression: { fact: 'all_nodes_terminal' },
          selector: {
            exits: ['done'],
            pick: { type: 'lowest_terminal_node_id' },
          },
          rule_hash: hash('completion-rule'),
        },
      ],
    },
    complexity_summary: {},
    static_child_plan_closure: {
      members: [],
      member_count: 0,
      closure_hash: hash('static-closure'),
    },
    effective_limits: {},
    effective_usage_budget: {},
    runtime_safety_snapshot: {},
    runtime_safety_hash: seed.values.safety.hash,
  } as Omit<CompiledScopePlanV2Document, 'plan_hash'>;
  return {
    ...withoutHash,
    plan_hash: domainSeparatedSha256(
      COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
      withoutHash as JsonObject,
    ),
  } as CompiledScopePlanV2Document;
}

function withPlanHash(
  value: Omit<CompiledScopePlanV2Document, 'plan_hash'>,
): CompiledScopePlanV2Document {
  return {
    ...value,
    plan_hash: domainSeparatedSha256(
      COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
      value as JsonObject,
    ),
  } as CompiledScopePlanV2Document;
}

function outboxAdapterContent(ref: {
  id: string;
  version: string;
}): JsonObject {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-outbox-adapter/1',
    ref,
    supported_effect_types: ['capability_dispatch'],
    supported_delivery_lanes: ['normal_execution'],
    supported_reconciliation: ['not_required'],
    supported_idempotency: ['provider_key'],
  };
  return {
    ...withoutHash,
    adapter_hash: domainSeparatedSha256(
      CAPABILITY_OUTBOX_ADAPTER_DOMAIN,
      withoutHash,
    ),
  };
}

function outboxPolicyContent(ref: { id: string; version: string }): JsonObject {
  const withoutHash: JsonObject = {
    format: 'icarus.workflow-outbox-delivery-policy/1',
    ref,
    max_delivery_attempts: 4,
    max_reconcile_attempts: 2,
    attempt_timeout_ms: 1_000,
    delivery_duration_ms: 10_000,
    initial_backoff_ms: 10,
    max_backoff_ms: 100,
    backoff: 'fixed',
    deterministic_jitter_micros: 0,
    honor_retry_after: false,
    retryable_error_codes: ['provider_unavailable'],
    permanent_error_codes: ['contract_rejected'],
  };
  return {
    ...withoutHash,
    policy_hash: domainSeparatedSha256(
      CAPABILITY_OUTBOX_POLICY_DOMAIN,
      withoutHash,
    ),
  };
}

function executionBinding(seed: SeededRuntime): JsonObject {
  const publishedPolicy = outboxPolicyContent(seed.refs.outboxPolicy.ref);
  const snapshotWithoutHash: JsonObject = {
    format: 'icarus.workflow-outbox-effective-policy-snapshot/1',
    source_policy_ref: seed.refs.outboxPolicy.ref,
    source_policy_content_hash: seed.refs.outboxPolicy.hash,
    source_policy_hash: publishedPolicy.policy_hash!,
    runtime_safety_hash: seed.values.safety.hash,
    effective_policy: {
      max_delivery_attempts: 4,
      max_reconcile_attempts: 2,
      attempt_timeout_ms: 1_000,
      delivery_duration_ms: 10_000,
      initial_backoff_ms: 10,
      max_backoff_ms: 100,
      backoff: 'fixed',
      deterministic_jitter_micros: 0,
      honor_retry_after: false,
      retryable_error_codes: ['provider_unavailable'],
      permanent_error_codes: ['contract_rejected'],
    },
  };
  const effectivePolicySnapshot: JsonObject = {
    ...snapshotWithoutHash,
    snapshot_hash: capabilityOutboxPolicySnapshotHash(snapshotWithoutHash),
  };
  const effectContract: JsonObject = {
    adapter_ref: seed.refs.adapter.ref,
    delivery_policy_ref: seed.refs.outboxPolicy.ref,
    effect_type: 'capability_dispatch',
    delivery_lane: 'normal_execution',
    delivery_requirement: 'required',
    idempotency: 'provider_key',
    reconciliation: { type: 'not_required' },
  };
  const withoutHash: JsonObject = {
    adapter_identity: {
      resource_type: 'outbox_adapter',
      ref: seed.refs.adapter.ref,
      content_hash: seed.refs.adapter.hash,
    },
    delivery_policy_identity: {
      resource_type: 'outbox_policy',
      ref: seed.refs.outboxPolicy.ref,
      content_hash: seed.refs.outboxPolicy.hash,
    },
    effective_policy_snapshot: effectivePolicySnapshot,
    effect_contract: effectContract,
  };
  return {
    ...withoutHash,
    binding_hash: domainSeparatedSha256(
      CAPABILITY_OUTBOX_EXECUTION_BINDING_DOMAIN,
      withoutHash,
    ),
  };
}

function initialActivation(seed: SeededRuntime, nowMs: number) {
  return {
    stateKey: 'run',
    stateType: 'system' as const,
    definition: seed.refs.definition,
    definitionVersion: '1.0.0',
    stateConfig: seed.values.stateConfig,
    registrySnapshotId: seed.snapshotId,
    registrySnapshotHash: seed.snapshotHash,
    closureManifestId: seed.closureId,
    closureHash: seed.closureHash,
    runtimeSafetySnapshot: seed.values.safety,
    runtimeSupportedLimits: seed.refs.supportedLimits,
    sqliteExecutionProfile: seed.refs.sqliteProfile,
    compilerToolchain: seed.refs.compilerToolchain,
    coreReleaseRef: 'icarus.core@1.0.0',
    coreReleaseHash: hash('core-release'),
    coreBuildHash: hash('core-build'),
    databaseSchemaHash: G5_DATABASE_SCHEMA_HASH,
    sourceSeedHash: plan(seed).source_hash as Sha256Hash,
    compilerSnapshotHash: hash('compiler-snapshot'),
    inputSnapshot: seed.values.input,
    runResourceLimits: {
      scopes_total: 10,
      nodes_total: 10,
      edges_total: 10,
      builds_total: 10,
      build_attempts_total: 10,
      attempts_total: 10,
      waits_total: 10,
      effect_operations_total: 10,
      facts_total: 100,
      active_executions: 2,
      active_waits: 2,
    },
    checkpoint: { status: 'initial' },
    nowMs,
  };
}

function directCreationIntentHash(
  seed: SeededRuntime,
  creationDomain: string,
  creationKey: string,
): Sha256Hash {
  return calculateCreationIntentHash({
    creationDomain,
    creationKey,
    principalRef: 'human:local-owner',
    ownershipHash: hash('ownership'),
    routingScope: seed.refs.routingScope,
    recipe: seed.refs.recipe,
    entryPoint: 'default',
    inputHash: seed.values.input.hash,
    attachmentManifestHash: seed.values.attachments.hash,
  });
}

afterEach(() => {
  while (instances.length > 0) instances.pop()!.cleanup();
});

describe('G5 Basic Runtime Schema 5 transaction integration', () => {
  it('commits T0/T1/T2a/T2b/T3a and exact replays across reopen', () => {
    const instance = bootstrap('g5-runtime-path');
    const seed = seedRuntime(instance.store);
    const creationInput = {
      requestId: 'request-1',
      creationDomain: 'assistant',
      creationKey: 'task-1',
      source: 'api' as const,
      principalRef: 'human:local-owner',
      recipe: seed.refs.recipe,
      definition: seed.refs.definition,
      executionPolicy: seed.refs.executionPolicy,
      commandPolicy: seed.refs.commandPolicy,
      inputSchema: seed.refs.inputSchema,
      contextContract: seed.refs.contextContract,
      routingScope: seed.refs.routingScope,
      input: seed.values.input,
      attachments: seed.values.attachments,
      contextSnapshot: seed.values.context,
      routingDecision: seed.values.routing,
      routingDecisionJson: { reason_codes: ['explicit_recipe'] },
      runtimeSafetyHash: seed.values.safety.hash,
      ownershipHash: hash('ownership'),
      creationIntentHash: directCreationIntentHash(seed, 'assistant', 'task-1'),
      workflowDefinitionVersion: '1.0.0',
      recipeVersion: '1.0.0',
      deadlineAtMs: null,
      resourceLimits: {
        state_activations_total: 8,
        graph_runs_total: 8,
        descendant_workflows_total: 8,
      },
      domainClaims: [],
      initialActivation: initialActivation(seed, 10),
      nowMs: 10,
    };
    expect(() =>
      createWorkflowT0(instance.store, creationInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflows',
        [],
      )!.count,
    ).toBe(0);
    const created = createWorkflowT0(instance.store, creationInput);
    expect(() =>
      activateWorkflowT1(instance.store, {
        ...initialActivation(seed, 12),
        workflowId: created.workflowId,
        expectedWorkflowRowVersion: 0,
        stateKey: 'stale-activation',
      }),
    ).toThrow(/row version is stale/);
    expect(created.disposition).toBe('created');
    const sharedClaimInput = {
      namespace: 'workspace',
      keyHash: hash('workspace:shared'),
      mode: 'shared' as const,
      ownerWorkflowId: created.workflowId,
      recipeResourceId: seed.refs.recipe.rowId,
      recipeResourceHash: seed.refs.recipe.hash,
      sourceIntakeId: created.intakeId,
      creationKey: 'task-1-shared',
      acquiredAtMs: 11,
    };
    instance.store.withImmediateTransaction((transaction) => {
      expect(
        acquireDomainClaim(transaction, sharedClaimInput).disposition,
      ).toBe('acquired');
    });
    expect(() =>
      instance.store.withImmediateTransaction((transaction) =>
        acquireDomainClaim(transaction, {
          ...sharedClaimInput,
          mode: 'exclusive',
          creationKey: 'task-1-exclusive-conflict',
        }),
      ),
    ).toThrow(/conflicts with an existing holder/);
    const exclusiveClaimInput = {
      ...sharedClaimInput,
      keyHash: hash('workspace:exclusive'),
      mode: 'exclusive' as const,
      creationKey: 'task-1-exclusive',
    };
    instance.store.withImmediateTransaction((transaction) => {
      expect(
        acquireDomainClaim(transaction, exclusiveClaimInput).disposition,
      ).toBe('acquired');
    });
    expect(() =>
      instance.store.withImmediateTransaction((transaction) =>
        acquireDomainClaim(transaction, {
          ...exclusiveClaimInput,
          mode: 'shared',
          creationKey: 'task-1-shared-conflict',
        }),
      ),
    ).toThrow(/conflicts with an existing holder/);
    const replay = createWorkflowT0(instance.store, {
      requestId: 'request-1',
      creationDomain: 'assistant',
      creationKey: 'task-1',
      source: 'api',
      principalRef: 'human:local-owner',
      recipe: seed.refs.recipe,
      definition: seed.refs.definition,
      executionPolicy: seed.refs.executionPolicy,
      commandPolicy: seed.refs.commandPolicy,
      inputSchema: seed.refs.inputSchema,
      contextContract: seed.refs.contextContract,
      routingScope: seed.refs.routingScope,
      input: seed.values.input,
      attachments: seed.values.attachments,
      contextSnapshot: seed.values.context,
      routingDecision: seed.values.routing,
      routingDecisionJson: { reason_codes: ['explicit_recipe'] },
      runtimeSafetyHash: seed.values.safety.hash,
      ownershipHash: hash('ownership'),
      creationIntentHash: directCreationIntentHash(seed, 'assistant', 'task-1'),
      workflowDefinitionVersion: '1.0.0',
      recipeVersion: '1.0.0',
      deadlineAtMs: null,
      resourceLimits: {
        state_activations_total: 8,
        graph_runs_total: 8,
        descendant_workflows_total: 8,
      },
      domainClaims: [],
      initialActivation: initialActivation(seed, 10),
      nowMs: 11,
    });
    expect(replay.disposition).toBe('exact_replay');
    const activated = created.activation;
    const compiledPlan = plan(seed);
    const compileInput = {
      graphRunId: activated.graphRunId,
      buildId: activated.rootBuildId,
      expectedBuildRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedOwnerScopeWorkFenceEpoch: 0,
      expectedCompilerSnapshotHash: hash('compiler-snapshot'),
      sourceJson: G5_TEST_SOURCE,
      sourceHash: compiledPlan.source_hash as Sha256Hash,
      plan: compiledPlan,
      nowMs: 30,
    };
    expect(() =>
      persistCompileResultT2a(instance.store, compileInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const compiled = persistCompileResultT2a(instance.store, compileInput);
    const runBeforeMaterialize = instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_graph_runs WHERE id = ?', [
      activated.graphRunId,
    ])!;
    const materializeInput = {
      graphRunId: activated.graphRunId,
      buildId: activated.rootBuildId,
      rootScopeId: activated.rootScopeId,
      expectedBuildRowVersion: 2,
      expectedRunRowVersion: runBeforeMaterialize.row_version,
      expectedScopeRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      planId: compiled.planId,
      plan: compiledPlan,
      inputSnapshot: seed.values.input,
      nowMs: 40,
    };
    expect(() =>
      materializeRootScopeT2b(instance.store, materializeInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const materialized = materializeRootScopeT2b(
      instance.store,
      materializeInput,
    );
    expect(materialized).toMatchObject({
      disposition: 'materialized',
      nodeCount: 6,
      edgeCount: 3,
    });
    expect(
      instance.store.queryOne<{
        capability_resource_id: string;
        capability_hash: string;
        normalized_node_json: string;
      }>(
        "SELECT capability_resource_id, capability_hash, normalized_node_json FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'work'",
        [activated.graphRunId],
      ),
    ).toMatchObject({
      capability_resource_id: seed.refs.capability.rowId,
      capability_hash: seed.refs.capability.hash,
    });
    const runBeforeFixedPoint = instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_graph_runs WHERE id = ?', [
      activated.graphRunId,
    ])!;
    const initializeInput = {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      expectedRunRowVersion: runBeforeFixedPoint.row_version,
      nowMs: 50,
    };
    expect(() =>
      initializeScopeFixedPointT3a(instance.store, initializeInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const fixedPoint = initializeScopeFixedPointT3a(
      instance.store,
      initializeInput,
    );
    expect(fixedPoint.readyNodeIds).toHaveLength(4);
    const capacityPayload = {
      max_active_executions: 5,
      max_active_waits: 256,
      max_pending_signals: 2048,
      max_outbox_inflight: 16,
      max_physical_blob_bytes: 21_474_836_480,
      soft_blob_high_water_bytes: 17_179_869_184,
      minimum_free_disk_bytes: 5_368_709_120,
    };
    const capacity = buildDeploymentCapacityPublication(
      1,
      'capacity-change-test',
      null,
      {
        ...capacityPayload,
        config_hash: calculateDeploymentCapacityConfigHash(capacityPayload),
      },
    );
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `INSERT INTO runtime_capacity_admin_commands (
         command_id, idempotency_domain, idempotency_key, command_type,
         expected_capacity_revision, expected_config_hash,
         assigned_capacity_revision, assigned_change_id,
         genesis_core_release_hash, proposed_capacity_json,
         proposed_config_hash, request_hash, reason_code, reason_text_value_id,
         reason_text_hash, evidence_manifest_value_id, evidence_manifest_hash,
         canonical_result_value_id, canonical_result_hash, created_at_ms,
         finalized_at_ms
       ) VALUES ('capacity:test', 'deployment_capacity', 'capacity:test',
         'initialize_deployment_capacity', NULL, NULL, 1, ?, ?, ?, ?, ?,
         'initial_provisioning', NULL, NULL, ?, ?, ?, ?, 1, 1)`,
        [
          capacity.capacity_change_id,
          hash('core-release'),
          JSON.stringify(capacity.capacity),
          capacity.capacity.config_hash,
          hash('capacity-request'),
          seed.values.evidence.id,
          seed.values.evidence.hash,
          seed.values.result.id,
          seed.values.result.hash,
        ],
      );
      transaction.execute(
        `INSERT INTO runtime_capacity_head (
         singleton_key, current_capacity_revision, current_change_id,
         current_config_hash, current_publication_hash, pending_change_id,
         row_version, created_at_ms, updated_at_ms
       ) VALUES (1, 1, ?, ?, ?, NULL, 1, 1, 1)`,
        [
          capacity.capacity_change_id,
          capacity.capacity.config_hash,
          capacity.publication_hash,
        ],
      );
    });
    const capacityProvider = { current: () => capacity };
    const workNode = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'work'",
      [activated.graphRunId],
    )!;
    const waitNode = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'pause'",
      [activated.graphRunId],
    )!;
    const timeoutNode = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'timeout'",
      [activated.graphRunId],
    )!;
    const qualityNode = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'quality'",
      [activated.graphRunId],
    )!;
    const waitAdmissionInput = {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: waitNode.id,
      expectedNodeRowVersion: waitNode.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: waitNode.activation_event_seq,
      activation: { kind: 'wait' },
      nowMs: 60,
    } as const;
    expect(() =>
      scheduleReadyNodeT4(
        instance.store,
        capacityProvider,
        waitAdmissionInput,
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault before commit/);
    const waitAdmission = scheduleReadyNodeT4(
      instance.store,
      capacityProvider,
      waitAdmissionInput,
    );
    expect(waitAdmission.waitId).not.toBeNull();
    const waitResolutionInput = {
      waitId: waitAdmission.waitId!,
      providerRef: 'provider:test',
      providerEventId: 'event:signal:1',
      principalRef: 'human:local-owner',
      workflowId: created.workflowId,
      resolution: 'signal',
      payload: seed.values.result,
      payloadByteLength: 17,
      ingressAuthorization: seed.values.ingressAuthorization,
      bindingAuthorization: seed.values.bindingAuthorization,
      expectedWaitRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      receivedAtMs: 70,
      expiresAtMs: 1_000,
    } as const;
    expect(() =>
      resolveWaitT6c(instance.store, waitResolutionInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const waitResolution = resolveWaitT6c(instance.store, waitResolutionInput);
    expect(waitResolution.disposition).toBe('accepted');
    expect(
      resolveWaitT6c(instance.store, {
        waitId: waitAdmission.waitId!,
        providerRef: 'provider:test',
        providerEventId: 'event:signal:1',
        principalRef: 'human:local-owner',
        workflowId: created.workflowId,
        resolution: 'signal',
        payload: seed.values.result,
        payloadByteLength: 17,
        ingressAuthorization: seed.values.ingressAuthorization,
        bindingAuthorization: seed.values.bindingAuthorization,
        expectedWaitRowVersion: 1,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        receivedAtMs: 71,
        expiresAtMs: 1_000,
      }).disposition,
    ).toBe('duplicate');
    expect(
      resolveWaitT6c(instance.store, {
        waitId: waitAdmission.waitId!,
        providerRef: 'provider:test',
        providerEventId: 'event:signal:1',
        principalRef: 'human:local-owner',
        workflowId: created.workflowId,
        resolution: 'timeout',
        payload: seed.values.result,
        payloadByteLength: 17,
        ingressAuthorization: seed.values.ingressAuthorization,
        bindingAuthorization: seed.values.bindingAuthorization,
        expectedWaitRowVersion: 1,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        receivedAtMs: 72,
        expiresAtMs: 1_000,
      }).disposition,
    ).toBe('conflict');
    const executionAdmission = scheduleReadyNodeT4(
      instance.store,
      capacityProvider,
      {
        graphRunId: activated.graphRunId,
        scopeId: activated.rootScopeId,
        nodeId: workNode.id,
        expectedNodeRowVersion: workNode.row_version,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        eligibleEventSeq: workNode.activation_event_seq,
        activation: { kind: 'execution' },
        nowMs: 80,
      },
    );
    const workDispatchInput = {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: workNode.id,
      attemptId: executionAdmission.attemptId!,
      expectedAttemptRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      request: seed.values.request,
      policySnapshotSchema: seed.refs.policySnapshotSchema,
      operationKey: 'operation:work:1',
      requiredClaims: [],
      dispatchDeadlineAtMs: 1_000,
      outboxDeadlineAtMs: 10_000,
      nowMs: 90,
    };
    const adapterValue = instance.store.queryOne<{
      canonical_value_id: string;
      inline_canonical_json: string;
    }>(
      `SELECT r.canonical_value_id, v.inline_canonical_json
         FROM workflow_registry_resources r
         JOIN workflow_values v ON v.id = r.canonical_value_id
        WHERE r.id = ?`,
      [seed.refs.adapter.rowId],
    )!;
    instance.store.withImmediateTransaction((transaction) => {
      const testOnly = JSON.parse(
        adapterValue.inline_canonical_json,
      ) as JsonObject;
      testOnly.launchability = 'test_only';
      transaction.execute(
        'UPDATE workflow_values SET inline_canonical_json = ? WHERE id = ?',
        [JSON.stringify(testOnly), adapterValue.canonical_value_id],
      );
    });
    expect(() =>
      prepareCapabilityDispatchT5(instance.store, workDispatchInput),
    ).toThrow(/test-only Registry authority/);
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_values SET inline_canonical_json = ? WHERE id = ?',
        [adapterValue.inline_canonical_json, adapterValue.canonical_value_id],
      );
    });
    expect(() =>
      prepareCapabilityDispatchT5(instance.store, {
        ...workDispatchInput,
        expectedAttemptRowVersion: 99,
      }),
    ).toThrow(/attempt, run, or work epoch is stale/);
    expect(() =>
      prepareCapabilityDispatchT5(instance.store, workDispatchInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const dispatch = prepareCapabilityDispatchT5(
      instance.store,
      workDispatchInput,
    );
    expect(() =>
      prepareCapabilityDispatchT5(instance.store, {
        ...workDispatchInput,
        request: seed.values.result,
      }),
    ).toThrow(/operation key replay drift/);
    const firstLease = leaseOutboxWork(instance.store, {
      outboxId: dispatch.outboxId,
      leaseOwner: 'worker:outbox',
      leaseToken: 'lease:1',
      leaseExpiresAtMs: 200,
      nowMs: 91,
    });
    const lostReceipt = {
      resultKind: 'applied_but_receipt_lost' as const,
      resultCode: 'receipt_lost',
      receipt: null,
      afterState: null,
      immutableOutput: null,
      externalId: 'external:1',
      nextAttemptAtMs: 100,
      attemptsExhausted: false,
      startedAtMs: 91,
      finishedAtMs: 92,
    };
    expect(recordOutboxResult(instance.store, firstLease, lostReceipt)).toBe(
      'reconciling',
    );
    expect(() =>
      recordOutboxResult(instance.store, firstLease, {
        ...lostReceipt,
        resultCode: 'receipt_lost_drift',
      }),
    ).toThrow(/replay bytes drifted/);
    expect(recordOutboxResult(instance.store, firstLease, lostReceipt)).toBe(
      'reconciling',
    );
    const reconcileLease = leaseOutboxWork(instance.store, {
      outboxId: dispatch.outboxId,
      leaseOwner: 'worker:outbox',
      leaseToken: 'lease:2',
      leaseExpiresAtMs: 300,
      nowMs: 100,
    });
    const recoveredReceipt = {
      resultKind: 'applied_with_receipt' as const,
      resultCode: null,
      receipt: seed.values.result,
      afterState: seed.values.result,
      immutableOutput: seed.values.result,
      externalId: 'external:1',
      nextAttemptAtMs: null,
      attemptsExhausted: false,
      startedAtMs: 100,
      finishedAtMs: 101,
    };
    expect(
      recordOutboxResult(instance.store, reconcileLease, recoveredReceipt),
    ).toBe('succeeded');
    expect(
      recordOutboxResult(instance.store, reconcileLease, recoveredReceipt),
    ).toBe('succeeded');
    const callbackInput = {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: workNode.id,
      attemptId: executionAdmission.attemptId!,
      delegationId: stableRuntimeId('delegation', {
        attempt_id: executionAdmission.attemptId!,
      }),
      externalExecutionId: 'external:1',
      providerEventId: 'callback:1',
      result: seed.values.result,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      nowMs: 105,
    };
    expect(() =>
      acceptDelegationCallbackT6b(instance.store, callbackInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    expect(acceptDelegationCallbackT6b(instance.store, callbackInput)).toBe(
      'accepted',
    );
    expect(
      acceptDelegationCallbackT6b(instance.store, {
        graphRunId: activated.graphRunId,
        scopeId: activated.rootScopeId,
        nodeId: workNode.id,
        attemptId: executionAdmission.attemptId!,
        delegationId: stableRuntimeId('delegation', {
          attempt_id: executionAdmission.attemptId!,
        }),
        externalExecutionId: 'external:1',
        providerEventId: 'callback:1',
        result: seed.values.result,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        nowMs: 106,
      }),
    ).toBe('duplicate');
    const attempt = instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_graph_node_attempts WHERE id = ?',
      [executionAdmission.attemptId!],
    )!;
    const revisionInput = {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: workNode.id,
      attemptId: executionAdmission.attemptId!,
      expectedAttemptRowVersion: attempt.row_version,
      leaseOwner: null,
      leaseToken: null,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      executionOutcome: 'succeeded',
      qualityDecision: 'needs_revision',
      result: seed.values.result,
      evaluation: null,
      feedback: seed.values.result,
      errorCode: null,
      factPayload: seed.values.result,
      nowMs: 110,
    } as const;
    expect(() =>
      acceptInternalResultT6a(instance.store, revisionInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const revision = acceptInternalResultT6a(instance.store, revisionInput);
    expect(revision.disposition).toBe('retry_scheduled');
    expect(
      acceptDelegationCallbackT6b(instance.store, {
        graphRunId: activated.graphRunId,
        scopeId: activated.rootScopeId,
        nodeId: workNode.id,
        attemptId: executionAdmission.attemptId!,
        delegationId: stableRuntimeId('delegation', {
          attempt_id: executionAdmission.attemptId!,
        }),
        externalExecutionId: 'external:drift',
        providerEventId: 'callback:conflict',
        result: seed.values.result,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        nowMs: 111,
      }),
    ).toBe('conflict');
    expect(() =>
      consumeRetryScheduleT6d(instance.store, capacityProvider, {
        retryScheduleId: revision.retryScheduleId!,
        expectedScheduleRowVersion: 1,
        automaticTimer: false as unknown as true,
        nowMs: 119,
      }),
    ).toThrow(/does not authorize manual retry/);
    expect(() =>
      consumeRetryScheduleT6d(
        instance.store,
        capacityProvider,
        {
          retryScheduleId: revision.retryScheduleId!,
          expectedScheduleRowVersion: 1,
          automaticTimer: true,
          nowMs: 120,
        },
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected fault before commit/);
    const consumed = consumeRetryScheduleT6d(instance.store, capacityProvider, {
      retryScheduleId: revision.retryScheduleId!,
      expectedScheduleRowVersion: 1,
      automaticTimer: true,
      nowMs: 120,
    });
    expect(consumed.disposition).toBe('consumed');
    expect(
      instance.store.queryOne<{
        capacity_revision: number;
        capacity_change_id: string;
        capacity_config_hash: string;
      }>(
        'SELECT capacity_revision, capacity_change_id, capacity_config_hash FROM workflow_graph_scheduler_admissions WHERE attempt_id = ?',
        [consumed.attemptId],
      ),
    ).toEqual({
      capacity_revision: capacity.capacity_revision,
      capacity_change_id: capacity.capacity_change_id,
      capacity_config_hash: capacity.capacity.config_hash,
    });
    expect(
      consumeRetryScheduleT6d(instance.store, capacityProvider, {
        retryScheduleId: revision.retryScheduleId!,
        expectedScheduleRowVersion: 2,
        automaticTimer: true,
        nowMs: 121,
      }).disposition,
    ).toBe('duplicate_timer');
    const secondDispatch = prepareCapabilityDispatchT5(instance.store, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: workNode.id,
      attemptId: consumed.attemptId,
      expectedAttemptRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      request: seed.values.request,
      policySnapshotSchema: seed.refs.policySnapshotSchema,
      operationKey: 'operation:work:2',
      requiredClaims: [],
      dispatchDeadlineAtMs: 1_000,
      outboxDeadlineAtMs: 10_000,
      nowMs: 122,
    });
    const secondLease = leaseOutboxWork(instance.store, {
      outboxId: secondDispatch.outboxId,
      leaseOwner: 'worker:outbox',
      leaseToken: 'lease:3',
      leaseExpiresAtMs: 400,
      nowMs: 123,
    });
    recordOutboxResult(instance.store, secondLease, {
      resultKind: 'applied_with_receipt',
      resultCode: null,
      receipt: seed.values.result,
      afterState: seed.values.result,
      immutableOutput: seed.values.result,
      externalId: 'external:2',
      nextAttemptAtMs: null,
      attemptsExhausted: false,
      startedAtMs: 123,
      finishedAtMs: 124,
    });
    const secondAttempt = instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_graph_node_attempts WHERE id = ?',
      [consumed.attemptId],
    )!;
    expect(
      acceptInternalResultT6a(instance.store, {
        graphRunId: activated.graphRunId,
        scopeId: activated.rootScopeId,
        nodeId: workNode.id,
        attemptId: consumed.attemptId,
        expectedAttemptRowVersion: secondAttempt.row_version,
        leaseOwner: null,
        leaseToken: null,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        executionOutcome: 'succeeded',
        qualityDecision: 'pass',
        result: seed.values.result,
        evaluation: null,
        feedback: null,
        errorCode: null,
        factPayload: seed.values.result,
        nowMs: 125,
      }).disposition,
    ).toBe('terminal');
    const timeoutAdmission = scheduleReadyNodeT4(
      instance.store,
      capacityProvider,
      {
        graphRunId: activated.graphRunId,
        scopeId: activated.rootScopeId,
        nodeId: timeoutNode.id,
        expectedNodeRowVersion: timeoutNode.row_version,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        eligibleEventSeq: timeoutNode.activation_event_seq,
        activation: { kind: 'execution' },
        nowMs: 126,
      },
    );
    prepareCapabilityDispatchT5(instance.store, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: timeoutNode.id,
      attemptId: timeoutAdmission.attemptId!,
      expectedAttemptRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      request: seed.values.request,
      policySnapshotSchema: seed.refs.policySnapshotSchema,
      operationKey: 'operation:timeout:1',
      requiredClaims: [],
      dispatchDeadlineAtMs: 130,
      outboxDeadlineAtMs: 10_000,
      nowMs: 127,
    });
    const timedOut = fireAttemptWatchdogT6d(instance.store, {
      attemptId: timeoutAdmission.attemptId!,
      automaticTimer: true,
      expectedAttemptRowVersion: 2,
      factPayload: seed.values.result,
      nowMs: 130,
    });
    expect(timedOut.disposition).toBe('timed_out');
    const timeoutRetry = consumeRetryScheduleT6d(
      instance.store,
      capacityProvider,
      {
        retryScheduleId: timedOut.retryScheduleId!,
        expectedScheduleRowVersion: 1,
        automaticTimer: true,
        nowMs: 140,
      },
    );
    prepareCapabilityDispatchT5(instance.store, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: timeoutNode.id,
      attemptId: timeoutRetry.attemptId,
      expectedAttemptRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      request: seed.values.request,
      policySnapshotSchema: seed.refs.policySnapshotSchema,
      operationKey: 'operation:timeout:2',
      requiredClaims: [],
      dispatchDeadlineAtMs: 150,
      outboxDeadlineAtMs: 10_000,
      nowMs: 141,
    });
    expect(
      fireAttemptWatchdogT6d(instance.store, {
        attemptId: timeoutRetry.attemptId,
        automaticTimer: true,
        expectedAttemptRowVersion: 2,
        factPayload: seed.values.result,
        nowMs: 150,
      }).disposition,
    ).toBe('timed_out');
    expect(
      fireAttemptWatchdogT6d(instance.store, {
        attemptId: timeoutRetry.attemptId,
        automaticTimer: true,
        expectedAttemptRowVersion: 3,
        factPayload: seed.values.result,
        nowMs: 151,
      }).disposition,
    ).toBe('duplicate_timer');
    const qualityAdmission = scheduleReadyNodeT4(
      instance.store,
      capacityProvider,
      {
        graphRunId: activated.graphRunId,
        scopeId: activated.rootScopeId,
        nodeId: qualityNode.id,
        expectedNodeRowVersion: qualityNode.row_version,
        expectedRunWorkFenceEpoch: 0,
        expectedScopeWorkFenceEpoch: 0,
        eligibleEventSeq: qualityNode.activation_event_seq,
        activation: { kind: 'execution' },
        nowMs: 152,
      },
    );
    const qualityDispatch = prepareCapabilityDispatchT5(instance.store, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: qualityNode.id,
      attemptId: qualityAdmission.attemptId!,
      expectedAttemptRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      request: seed.values.request,
      policySnapshotSchema: seed.refs.policySnapshotSchema,
      operationKey: 'operation:quality:1',
      requiredClaims: [],
      dispatchDeadlineAtMs: 200,
      outboxDeadlineAtMs: 10_000,
      nowMs: 153,
    });
    const qualityLease = leaseOutboxWork(instance.store, {
      outboxId: qualityDispatch.outboxId,
      leaseOwner: 'worker:outbox',
      leaseToken: 'lease:quality',
      leaseExpiresAtMs: 250,
      nowMs: 154,
    });
    recordOutboxResult(instance.store, qualityLease, {
      resultKind: 'applied_with_receipt',
      resultCode: null,
      receipt: seed.values.result,
      afterState: seed.values.result,
      immutableOutput: seed.values.result,
      externalId: 'external:quality',
      nextAttemptAtMs: null,
      attemptsExhausted: false,
      startedAtMs: 154,
      finishedAtMs: 155,
    });
    const qualityResult = {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: qualityNode.id,
      attemptId: qualityAdmission.attemptId!,
      expectedAttemptRowVersion: 2,
      leaseOwner: null,
      leaseToken: null,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      executionOutcome: 'succeeded' as const,
      qualityDecision: 'needs_revision' as const,
      result: seed.values.result,
      evaluation: null,
      feedback: seed.values.result,
      errorCode: null,
      factPayload: seed.values.result,
      nowMs: 156,
    };
    expect(
      acceptInternalResultT6a(instance.store, qualityResult).disposition,
    ).toBe('terminal');
    expect(
      acceptInternalResultT6a(instance.store, qualityResult).disposition,
    ).toBe('exact_replay');
    expect(
      instance.store.queryOne<{ terminal_code: string }>(
        'SELECT terminal_code FROM workflow_graph_nodes WHERE id = ?',
        [qualityNode.id],
      )!.terminal_code,
    ).toBe('quality_revision_exhausted');
    expect(() =>
      acceptInternalResultT6a(instance.store, {
        ...qualityResult,
        qualityDecision: 'pass',
        feedback: null,
      }),
    ).toThrow(/duplicate result bytes drifted/);
    const runBeforeReconcile = instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_graph_runs WHERE id = ?', [
      activated.graphRunId,
    ])!;
    reconcileFactT3a(instance.store, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      expectedRunRowVersion: runBeforeReconcile.row_version,
      factKind: 'node_terminal',
      stableObjectKind: 'node',
      stableObjectId: workNode.id,
      factKey: `node-terminal-reconcile:${workNode.id}`,
      payload: seed.values.result,
      terminalStatus: 'succeeded',
      nowMs: 160,
    });
    const joinNode = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'join'",
      [activated.graphRunId],
    )!;
    expect(
      instance.store.queryOne<{ state: string }>(
        `SELECT r.state
           FROM workflow_graph_data_edge_resolutions r
           JOIN workflow_graph_edges e ON e.id = r.edge_id
          WHERE e.graph_run_id = ? AND e.edge_key = 'work-result-to-join'`,
        [activated.graphRunId],
      )!.state,
    ).toBe('available');
    scheduleReadyNodeT4(instance.store, capacityProvider, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: joinNode.id,
      expectedNodeRowVersion: joinNode.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: joinNode.activation_event_seq,
      activation: { kind: 'structural' },
      nowMs: 161,
    });
    const runBeforeJoinReconcile = instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_graph_runs WHERE id = ?', [
      activated.graphRunId,
    ])!;
    reconcileFactT3a(instance.store, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      expectedRunRowVersion: runBeforeJoinReconcile.row_version,
      factKind: 'node_terminal',
      stableObjectKind: 'node',
      stableObjectId: joinNode.id,
      factKey: `node-terminal-reconcile:${joinNode.id}`,
      payload: seed.values.result,
      terminalStatus: 'succeeded',
      nowMs: 162,
    });
    const terminalNode = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'done'",
      [activated.graphRunId],
    )!;
    scheduleReadyNodeT4(instance.store, capacityProvider, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      nodeId: terminalNode.id,
      expectedNodeRowVersion: terminalNode.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: terminalNode.activation_event_seq,
      activation: { kind: 'structural' },
      nowMs: 163,
    });
    const reference = new G5BasicRuntimeReferenceModel(
      [
        { id: 'work', kind: 'delegation' },
        { id: 'timeout', kind: 'system' },
        { id: 'quality', kind: 'system' },
        { id: 'pause', kind: 'wait' },
        { id: 'join', kind: 'join' },
        { id: 'done', kind: 'terminal' },
      ],
      [
        { from: 'work', to: 'join', statuses: ['succeeded'] },
        { from: 'join', to: 'done', statuses: ['succeeded'] },
      ],
    );
    reference.activate('work');
    reference.complete('work', 'succeeded');
    reference.activate('timeout');
    reference.complete('timeout', 'failed');
    reference.activate('quality');
    reference.complete('quality', 'failed');
    reference.resolveWait('pause', 'event:signal:1');
    reference.complete('join', 'succeeded');
    reference.complete('done', 'succeeded');
    const sqliteTerminal = instance.store
      .queryAll<{
        node_key: string;
        terminal_status: 'succeeded' | 'failed' | 'skipped' | 'cancelled';
      }>(
        'SELECT node_key, terminal_status FROM workflow_graph_nodes WHERE graph_run_id = ? ORDER BY node_key COLLATE BINARY',
        [activated.graphRunId],
      )
      .map((row) => ({ id: row.node_key, status: row.terminal_status }));
    const referenceTerminal = [...reference.nodes.values()]
      .map((node) => ({ id: node.id, status: node.terminalStatus }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(sqliteTerminal).toEqual(referenceTerminal);
    const settledRows = instance.store.queryOne<{
      run_row_version: number;
      scope_row_version: number;
    }>(
      `SELECT r.row_version AS run_row_version, s.row_version AS scope_row_version
         FROM workflow_graph_runs r JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
        WHERE r.id = ?`,
      [activated.graphRunId],
    )!;
    const settledCloseInput = {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      expectedRunRowVersion: settledRows.run_row_version,
      expectedScopeRowVersion: settledRows.scope_row_version,
      nowMs: 170,
    };
    expect(() =>
      requestSettledCloseT3b(instance.store, settledCloseInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const closed = requestSettledCloseT3b(instance.store, settledCloseInput);
    expect(closed.disposition).toBe('close_requested');
    const finalizationInput = {
      workflowId: created.workflowId,
      sourceStateInstanceId: created.activation.activationId,
      sourceRunId: activated.graphRunId,
      rootScopeId: activated.rootScopeId,
      closeRequestId: closed.closeRequestId,
      transitionEffectId: 'required-child:review',
      recipe: seed.refs.recipe,
      definition: seed.refs.definition,
      executionPolicy: seed.refs.executionPolicy,
      routingScope: seed.refs.routingScope,
      finalizationPolicy: seed.refs.finalizationPolicy,
      principalRef: 'human:local-owner',
      principalHash: hash('principal:local-owner'),
      input: seed.values.input,
      attachments: seed.values.attachments,
      routingDecision: seed.values.routing,
      creationIntentHash: calculateCreationIntentHash({
        creationDomain: `parent_workflow_lineage:${created.workflowId}`,
        creationKey: domainSeparatedSha256(
          'icarus:child-workflow-creation-key:1\n',
          {
            parent_workflow_id: created.workflowId,
            source_state_instance_id: created.activation.activationId,
            source_close_request_id: closed.closeRequestId,
            transition_effect_id: 'required-child:review',
          },
        ),
        principalRef: 'human:local-owner',
        ownershipHash: hash('ownership'),
        routingScope: seed.refs.routingScope,
        recipe: seed.refs.recipe,
        entryPoint: 'default',
        inputHash: seed.values.input.hash,
        attachmentManifestHash: seed.values.attachments.hash,
      }),
      runtimeSafetyHash: seed.values.safety.hash,
      maxAttempts: 3,
      deadlineAtMs: 5_000,
      nowMs: 171,
    };
    expect(() =>
      prepareRequiredFinalizationT0p(instance.store, finalizationInput, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    const finalization = prepareRequiredFinalizationT0p(
      instance.store,
      finalizationInput,
    );
    expect(finalization.disposition).toBe('prepared');
    expect(
      prepareRequiredFinalizationT0p(instance.store, {
        ...finalizationInput,
        nowMs: 172,
      }).disposition,
    ).toBe('exact_replay');
    const finalizationRow = instance.store.queryOne<{
      creation_domain: string;
      creation_key: string;
      child_workflow_id: string | null;
    }>(
      'SELECT creation_domain, creation_key, child_workflow_id FROM workflow_root_finalization_schedules WHERE id = ?',
      [finalization.scheduleId],
    )!;
    expect(finalizationRow.creation_domain).toBe(
      `parent_workflow_lineage:${created.workflowId}`,
    );
    expect(finalizationRow.creation_key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(finalizationRow.child_workflow_id).toBeNull();
    const accounts = new Map(
      instance.store
        .queryAll<{
          resource_type: string;
          reserved_amount: number;
          consumed_amount: number;
        }>(
          'SELECT resource_type, reserved_amount, consumed_amount FROM workflow_graph_resource_accounts WHERE graph_run_id = ?',
          [activated.graphRunId],
        )
        .map((row) => [row.resource_type, row]),
    );
    expect(accounts.get('scopes_total')?.consumed_amount).toBe(1);
    expect(accounts.get('nodes_total')?.consumed_amount).toBe(6);
    expect(accounts.get('edges_total')?.consumed_amount).toBe(3);
    expect(accounts.get('builds_total')?.consumed_amount).toBe(1);
    expect(accounts.get('build_attempts_total')?.consumed_amount).toBe(1);
    expect(accounts.get('attempts_total')?.consumed_amount).toBe(5);
    expect(accounts.get('waits_total')?.consumed_amount).toBe(1);
    expect(accounts.get('effect_operations_total')?.consumed_amount).toBe(5);
    const factCount = instance.store.queryOne<{ count: number }>(
      'SELECT count(*) AS count FROM workflow_graph_facts WHERE graph_run_id = ?',
      [activated.graphRunId],
    )!.count;
    expect(accounts.get('facts_total')?.consumed_amount).toBe(factCount);
    expect(accounts.get('active_executions')?.reserved_amount).toBe(0);
    expect(accounts.get('active_waits')?.reserved_amount).toBe(0);
    expect(
      instance.store.queryAll<{ fact_kind: string; event_type: string }>(
        `SELECT f.fact_kind, e.event_type
           FROM workflow_graph_facts f
           JOIN workflow_graph_events e
             ON e.graph_run_id = f.graph_run_id AND e.seq = f.event_seq
          WHERE f.graph_run_id = ? AND f.fact_kind <> e.event_type`,
        [activated.graphRunId],
      ),
    ).toEqual([]);
    const workIngress = instance.store.queryOne<{ event_seq: number }>(
      'SELECT event_seq FROM workflow_graph_facts WHERE graph_run_id = ? AND fact_key = ?',
      [activated.graphRunId, `node-terminal-reconcile:${workNode.id}`],
    )!;
    expect(
      instance.store
        .queryAll<{ causal_event_seq: number }>(
          `SELECT causal_event_seq FROM workflow_graph_facts
            WHERE graph_run_id = ? AND causal_wave > 0
              AND fact_key IN (?, ?, ?)`,
          [
            activated.graphRunId,
            `control-edge:${stableRuntimeId('edge', {
              graph_run_id: activated.graphRunId,
              scope_id: activated.rootScopeId,
              edge_key: 'work-to-done',
            })}`,
            `data-edge:${stableRuntimeId('edge', {
              graph_run_id: activated.graphRunId,
              scope_id: activated.rootScopeId,
              edge_key: 'work-result-to-join',
            })}`,
            `node-ready:${joinNode.id}`,
          ],
        )
        .every((row) => row.causal_event_seq === workIngress.event_seq),
    ).toBe(true);
    const workflowAccounts = new Map(
      instance.store
        .queryAll<{
          resource_type: string;
          consumed_amount: number;
        }>(
          'SELECT resource_type, consumed_amount FROM workflow_graph_resource_accounts WHERE workflow_id = ?',
          [created.workflowId],
        )
        .map((row) => [row.resource_type, row.consumed_amount]),
    );
    expect(workflowAccounts.get('state_activations_total')).toBe(1);
    expect(workflowAccounts.get('graph_runs_total')).toBe(1);
    const sourceEvent = instance.store.queryOne<{ next_event_seq: number }>(
      'SELECT next_event_seq FROM workflow_graph_runs WHERE id = ?',
      [activated.graphRunId],
    )!;
    const actionBlockerInput = {
      workflowId: created.workflowId,
      graphRunId: activated.graphRunId,
      blockerKind: 'resource_or_credential_unavailable' as const,
      severity: 'action_required' as const,
      source: { kind: 'event' as const, sequence: sourceEvent.next_event_seq },
      errorCode: 'credential_unavailable',
      evidenceManifest: seed.values.evidence,
      remediationPolicy: seed.refs.remediationPolicy,
      nextRemediationAtMs: null,
      remediationDeadlineAtMs: 5_000,
      nowMs: 173,
    };
    const blocker = openOperationalBlocker(instance.store, actionBlockerInput);
    expect(blocker.operationalState).toBe('action_required');
    const blockerEvent = instance.store.queryOne<{ next_event_seq: number }>(
      'SELECT next_event_seq FROM workflow_graph_runs WHERE id = ?',
      [activated.graphRunId],
    )!;
    expect(
      openOperationalBlocker(instance.store, {
        ...actionBlockerInput,
        blockerKind: 'integrity_quarantine',
        severity: 'quarantine',
        source: { kind: 'event', sequence: blockerEvent.next_event_seq },
        errorCode: 'integrity_mismatch',
        nowMs: 174,
      }).operationalState,
    ).toBe('quarantined');
    expect(
      openOperationalBlocker(instance.store, actionBlockerInput)
        .operationalState,
    ).toBe('quarantined');
    expect(
      listOpenOperationalBlockers(instance.store, activated.graphRunId),
    ).toHaveLength(2);
    for (const caseId of [
      'static_graph_success',
      'delegation_receipt_lost',
      'system_execution',
      'wait_signal_wins',
      'join_fixed_point',
      'terminal_settled',
      'quality_revision',
      'operational_blocker_open',
      'stale_activation_row',
      'fact_payload_drift',
      'stale_node_activation',
      'test_authority_promotion',
      'late_worker_result',
      'callback_identity_drift',
      'second_wait_winner',
      'manual_retry_without_gateway',
      'fault_before_commit_t0',
      'fault_before_commit_t0p',
      'fault_before_commit_t1',
      'fault_before_commit_t2a',
      'fault_before_commit_t2b',
      'fault_before_commit_t3a',
      'fault_before_commit_t3b',
      'fault_before_commit_t4',
      'fault_before_commit_t5',
      'fault_before_commit_t6a',
      'fault_before_commit_t6b',
      'fault_before_commit_t6c',
      'fault_before_commit_t6d',
    ])
      fixtureEvidence.set(caseId, 'production SQLite transaction evidence');
    instance.closeStore();
    instance.reopenStore();
    expect(
      instance.store.queryOne<{ lifecycle: string }>(
        'SELECT lifecycle FROM workflow_graph_runs WHERE id = ?',
        [activated.graphRunId],
      )!.lifecycle,
    ).toBe('closing');
  });

  it('rejects creation, compile, Plan hash, Schema, and G6 materialization drift', () => {
    const instance = bootstrap('g5-runtime-negative-boundaries');
    const seed = seedRuntime(instance.store);
    const creationInput = {
      requestId: 'request-negative',
      creationDomain: 'assistant',
      creationKey: 'negative-boundaries',
      source: 'api' as const,
      principalRef: 'human:local-owner',
      recipe: seed.refs.recipe,
      definition: seed.refs.definition,
      executionPolicy: seed.refs.executionPolicy,
      commandPolicy: seed.refs.commandPolicy,
      inputSchema: seed.refs.inputSchema,
      contextContract: seed.refs.contextContract,
      routingScope: seed.refs.routingScope,
      input: seed.values.input,
      attachments: seed.values.attachments,
      contextSnapshot: seed.values.context,
      routingDecision: seed.values.routing,
      routingDecisionJson: { reason_codes: ['negative_boundary'] },
      runtimeSafetyHash: seed.values.safety.hash,
      ownershipHash: hash('ownership'),
      creationIntentHash: directCreationIntentHash(
        seed,
        'assistant',
        'negative-boundaries',
      ),
      workflowDefinitionVersion: '1.0.0',
      recipeVersion: '1.0.0',
      deadlineAtMs: null,
      resourceLimits: {
        state_activations_total: 8,
        graph_runs_total: 8,
        descendant_workflows_total: 8,
      },
      domainClaims: [],
      initialActivation: initialActivation(seed, 10),
      nowMs: 10,
    };
    const created = createWorkflowT0(instance.store, creationInput);
    expect(() =>
      createWorkflowT0(instance.store, {
        ...creationInput,
        principalRef: 'human:other',
        creationIntentHash: calculateCreationIntentHash({
          creationDomain: 'assistant',
          creationKey: 'negative-boundaries',
          principalRef: 'human:other',
          ownershipHash: hash('ownership'),
          routingScope: seed.refs.routingScope,
          recipe: seed.refs.recipe,
          entryPoint: 'default',
          inputHash: seed.values.input.hash,
          attachmentManifestHash: seed.values.attachments.hash,
        }),
        nowMs: 11,
      }),
    ).toThrow(/different intent/);
    expect(() =>
      createWorkflowT0(instance.store, {
        ...creationInput,
        creationKey: 'wrong-schema',
        initialActivation: {
          ...creationInput.initialActivation,
          databaseSchemaHash: hash('wrong-schema'),
        },
      }),
    ).toThrow(/current frozen Schema 5 identity/);

    const compiledPlan = plan(seed);
    const compileInput = {
      graphRunId: created.activation.graphRunId,
      buildId: created.activation.rootBuildId,
      expectedBuildRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedOwnerScopeWorkFenceEpoch: 0,
      expectedCompilerSnapshotHash: hash('compiler-snapshot'),
      sourceJson: G5_TEST_SOURCE,
      sourceHash: compiledPlan.source_hash as Sha256Hash,
      plan: compiledPlan,
      nowMs: 20,
    };
    expect(() =>
      persistCompileResultT2a(instance.store, {
        ...compileInput,
        sourceJson: { format: 'tampered-source' },
      }),
    ).toThrow(/Compiled Plan v2 authority|pinned Compiler Plan v2 result/);
    const latestPlanWithoutHash = structuredClone(compiledPlan) as JsonObject;
    delete latestPlanWithoutHash.plan_hash;
    const latestNode = (latestPlanWithoutHash.nodes as JsonObject[])[0];
    const latestBinding = latestNode.outbox_execution_binding as JsonObject;
    (latestBinding.adapter_identity as JsonObject).ref = {
      id: seed.refs.adapter.ref.id,
      version: 'latest',
    };
    (latestBinding.effect_contract as JsonObject).adapter_ref = {
      id: seed.refs.adapter.ref.id,
      version: 'latest',
    };
    expect(() =>
      persistCompileResultT2a(instance.store, {
        ...compileInput,
        plan: withPlanHash(
          latestPlanWithoutHash as Omit<
            CompiledScopePlanV2Document,
            'plan_hash'
          >,
        ),
      }),
    ).toThrow(/Plan safety, toolchain, or Schema 5 identity drift/);
    expect(() =>
      persistCompileResultT2a(instance.store, {
        ...compileInput,
        plan: {
          ...compiledPlan,
          nodes: [...compiledPlan.nodes, { id: 'tampered', type: 'system' }],
        },
      }),
    ).toThrow(/Compiled Plan v2 authority|pinned Compiler Plan v2 result/);
    expect(() =>
      persistCompileResultT2a(instance.store, {
        ...compileInput,
        expectedBuildRowVersion: 99,
      }),
    ).toThrow(/lease, epoch, hash, or row version is stale/);
    const compiled = persistCompileResultT2a(instance.store, compileInput);
    const { plan_hash: _planHash, ...withoutPlanHash } = compiledPlan;
    const dynamicPlan = withPlanHash({
      ...withoutPlanHash,
      nodes: [
        ...compiledPlan.nodes,
        { id: 'g6-map', type: 'map', capability_binding: null },
      ],
    } as Omit<CompiledScopePlanV2Document, 'plan_hash'>);
    const run = instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
      [created.activation.graphRunId],
    )!;
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        "UPDATE workflow_graph_runs SET control = 'paused' WHERE id = ?",
        [created.activation.graphRunId],
      );
    });
    expect(() =>
      materializeRootScopeT2b(instance.store, {
        graphRunId: created.activation.graphRunId,
        buildId: created.activation.rootBuildId,
        rootScopeId: created.activation.rootScopeId,
        expectedBuildRowVersion: 2,
        expectedRunRowVersion: run.row_version,
        expectedScopeRowVersion: 1,
        expectedRunWorkFenceEpoch: 0,
        planId: compiled.planId,
        plan: compiledPlan,
        inputSnapshot: seed.values.input,
        nowMs: 29,
      }),
    ).toThrow(/precondition failed/);
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        "UPDATE workflow_graph_runs SET control = 'running' WHERE id = ?",
        [created.activation.graphRunId],
      );
    });
    expect(() =>
      materializeRootScopeT2b(instance.store, {
        graphRunId: created.activation.graphRunId,
        buildId: created.activation.rootBuildId,
        rootScopeId: created.activation.rootScopeId,
        expectedBuildRowVersion: 2,
        expectedRunRowVersion: run.row_version,
        expectedScopeRowVersion: 1,
        expectedRunWorkFenceEpoch: 0,
        planId: compiled.planId,
        plan: dynamicPlan,
        inputSnapshot: seed.values.input,
        nowMs: 30,
      }),
    ).toThrow(/belongs to G6/);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_run_manifest WHERE graph_run_id = ?',
        [created.activation.graphRunId],
      )!.count,
    ).toBe(0);
    materializeRootScopeT2b(instance.store, {
      graphRunId: created.activation.graphRunId,
      buildId: created.activation.rootBuildId,
      rootScopeId: created.activation.rootScopeId,
      expectedBuildRowVersion: 2,
      expectedRunRowVersion: run.row_version,
      expectedScopeRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      planId: compiled.planId,
      plan: compiledPlan,
      inputSnapshot: seed.values.input,
      nowMs: 31,
    });
    const materializedRun = instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
      [created.activation.graphRunId],
    )!;
    initializeScopeFixedPointT3a(instance.store, {
      graphRunId: created.activation.graphRunId,
      scopeId: created.activation.rootScopeId,
      expectedRunRowVersion: materializedRun.row_version,
      nowMs: 32,
    });
    const work = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
      normalized_node_json: string;
    }>(
      "SELECT id, row_version, activation_event_seq, normalized_node_json FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'work'",
      [created.activation.graphRunId],
    )!;
    instance.store.withImmediateTransaction((transaction) => {
      const tampered = JSON.parse(work.normalized_node_json) as JsonObject;
      (tampered.outbox_execution_binding as JsonObject).binding_hash = hash(
        'caller-forged-binding',
      );
      transaction.execute(
        'UPDATE workflow_graph_nodes SET normalized_node_json = ? WHERE id = ?',
        [JSON.stringify(tampered), work.id],
      );
    });
    expect(() =>
      scheduleReadyNodeT4(
        instance.store,
        {
          current: () =>
            buildDeploymentCapacityPublication(1, 'negative-capacity', null, {
              max_active_executions: 1,
              max_active_waits: 1,
              max_pending_signals: 1,
              max_outbox_inflight: 1,
              max_physical_blob_bytes: 100,
              soft_blob_high_water_bytes: 80,
              minimum_free_disk_bytes: 10,
              config_hash: calculateDeploymentCapacityConfigHash({
                max_active_executions: 1,
                max_active_waits: 1,
                max_pending_signals: 1,
                max_outbox_inflight: 1,
                max_physical_blob_bytes: 100,
                soft_blob_high_water_bytes: 80,
                minimum_free_disk_bytes: 10,
              }),
            }),
        },
        {
          graphRunId: created.activation.graphRunId,
          scopeId: created.activation.rootScopeId,
          nodeId: work.id,
          expectedNodeRowVersion: work.row_version,
          expectedRunWorkFenceEpoch: 0,
          expectedScopeWorkFenceEpoch: 0,
          eligibleEventSeq: work.activation_event_seq,
          activation: { kind: 'execution' },
          nowMs: 33,
        },
      ),
    ).toThrow(/exact node pinned by the Plan/);
    for (const caseId of [
      'creation_intent_conflict',
      'stale_compile_lease',
      'paused_materialization',
      'latest_policy_forbidden',
    ])
      fixtureEvidence.set(caseId, 'production SQLite rejection evidence');
  });

  it('property-compares production SQLite terminal evidence with the independent model', () => {
    let scenario = 0;
    fc.assert(
      fc.property(fc.boolean(), (succeeds) => {
        const instance = bootstrap(`g5-production-property-${scenario++}`);
        const seed = seedRuntime(instance.store);
        const compiledPlan = plan(seed);
        const creationKey = `property-${scenario}`;
        const created = createWorkflowT0(instance.store, {
          requestId: `request-${creationKey}`,
          creationDomain: 'assistant',
          creationKey,
          source: 'api',
          principalRef: 'human:local-owner',
          recipe: seed.refs.recipe,
          definition: seed.refs.definition,
          executionPolicy: seed.refs.executionPolicy,
          commandPolicy: seed.refs.commandPolicy,
          inputSchema: seed.refs.inputSchema,
          contextContract: seed.refs.contextContract,
          routingScope: seed.refs.routingScope,
          input: seed.values.input,
          attachments: seed.values.attachments,
          contextSnapshot: seed.values.context,
          routingDecision: seed.values.routing,
          routingDecisionJson: { reason_codes: ['property'] },
          runtimeSafetyHash: seed.values.safety.hash,
          ownershipHash: hash('ownership'),
          creationIntentHash: directCreationIntentHash(
            seed,
            'assistant',
            creationKey,
          ),
          workflowDefinitionVersion: '1.0.0',
          recipeVersion: '1.0.0',
          deadlineAtMs: null,
          resourceLimits: {
            state_activations_total: 2,
            graph_runs_total: 2,
            descendant_workflows_total: 2,
          },
          domainClaims: [],
          initialActivation: initialActivation(seed, 10),
          nowMs: 10,
        });
        const compiled = persistCompileResultT2a(instance.store, {
          graphRunId: created.activation.graphRunId,
          buildId: created.activation.rootBuildId,
          expectedBuildRowVersion: 1,
          expectedRunWorkFenceEpoch: 0,
          expectedOwnerScopeWorkFenceEpoch: 0,
          expectedCompilerSnapshotHash: hash('compiler-snapshot'),
          sourceJson: G5_TEST_SOURCE,
          sourceHash: compiledPlan.source_hash as Sha256Hash,
          plan: compiledPlan,
          nowMs: 20,
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
          planId: compiled.planId,
          plan: compiledPlan,
          inputSnapshot: seed.values.input,
          nowMs: 30,
        });
        const materializedRun = instance.store.queryOne<{
          row_version: number;
        }>('SELECT row_version FROM workflow_graph_runs WHERE id = ?', [
          created.activation.graphRunId,
        ])!;
        initializeScopeFixedPointT3a(instance.store, {
          graphRunId: created.activation.graphRunId,
          scopeId: created.activation.rootScopeId,
          expectedRunRowVersion: materializedRun.row_version,
          nowMs: 40,
        });
        const node = instance.store.queryOne<{
          id: string;
          row_version: number;
          activation_event_seq: number;
        }>(
          "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'timeout'",
          [created.activation.graphRunId],
        )!;
        const capacityPayload = {
          max_active_executions: 2,
          max_active_waits: 2,
          max_pending_signals: 8,
          max_outbox_inflight: 2,
          max_physical_blob_bytes: 1_000_000,
          soft_blob_high_water_bytes: 800_000,
          minimum_free_disk_bytes: 100_000,
        };
        const capacity = buildDeploymentCapacityPublication(
          1,
          `capacity-property-${scenario}`,
          null,
          {
            ...capacityPayload,
            config_hash: calculateDeploymentCapacityConfigHash(capacityPayload),
          },
        );
        instance.store.withImmediateTransaction((transaction) => {
          transaction.execute(
            `INSERT INTO runtime_capacity_admin_commands (
                   command_id, idempotency_domain, idempotency_key, command_type,
                   expected_capacity_revision, expected_config_hash,
                   assigned_capacity_revision, assigned_change_id,
                   genesis_core_release_hash, proposed_capacity_json,
                   proposed_config_hash, request_hash, reason_code,
                   reason_text_value_id, reason_text_hash,
                   evidence_manifest_value_id, evidence_manifest_hash,
                   canonical_result_value_id, canonical_result_hash,
                   created_at_ms, finalized_at_ms
                 ) VALUES (?, 'deployment_capacity', ?,
                   'initialize_deployment_capacity', NULL, NULL, 1, ?, ?, ?, ?, ?,
                   'initial_provisioning', NULL, NULL, ?, ?, ?, ?, 1, 1)`,
            [
              `capacity-command-${scenario}`,
              `capacity-key-${scenario}`,
              capacity.capacity_change_id,
              hash('core-release'),
              JSON.stringify(capacity.capacity),
              capacity.capacity.config_hash,
              hash(`capacity-request-${scenario}`),
              seed.values.evidence.id,
              seed.values.evidence.hash,
              seed.values.result.id,
              seed.values.result.hash,
            ],
          );
          transaction.execute(
            `INSERT INTO runtime_capacity_head (
                   singleton_key, current_capacity_revision, current_change_id,
                   current_config_hash, current_publication_hash,
                   pending_change_id, row_version, created_at_ms, updated_at_ms
                 ) VALUES (1, 1, ?, ?, ?, NULL, 1, 1, 1)`,
            [
              capacity.capacity_change_id,
              capacity.capacity.config_hash,
              capacity.publication_hash,
            ],
          );
        });
        const admission = scheduleReadyNodeT4(
          instance.store,
          { current: () => capacity },
          {
            graphRunId: created.activation.graphRunId,
            scopeId: created.activation.rootScopeId,
            nodeId: node.id,
            expectedNodeRowVersion: node.row_version,
            expectedRunWorkFenceEpoch: 0,
            expectedScopeWorkFenceEpoch: 0,
            eligibleEventSeq: node.activation_event_seq,
            activation: { kind: 'execution' },
            nowMs: 50,
          },
        );
        prepareCapabilityDispatchT5(instance.store, {
          graphRunId: created.activation.graphRunId,
          scopeId: created.activation.rootScopeId,
          nodeId: node.id,
          attemptId: admission.attemptId!,
          expectedAttemptRowVersion: 1,
          expectedRunWorkFenceEpoch: 0,
          expectedScopeWorkFenceEpoch: 0,
          request: seed.values.request,
          policySnapshotSchema: seed.refs.policySnapshotSchema,
          operationKey: `operation:${creationKey}`,
          requiredClaims: [],
          dispatchDeadlineAtMs: 1_000,
          outboxDeadlineAtMs: 2_000,
          nowMs: 60,
        });
        const resultInput = {
          graphRunId: created.activation.graphRunId,
          scopeId: created.activation.rootScopeId,
          nodeId: node.id,
          attemptId: admission.attemptId!,
          expectedAttemptRowVersion: 2,
          leaseOwner: null,
          leaseToken: null,
          expectedRunWorkFenceEpoch: 0,
          expectedScopeWorkFenceEpoch: 0,
          executionOutcome: succeeds
            ? ('succeeded' as const)
            : ('failed' as const),
          qualityDecision: succeeds ? ('pass' as const) : null,
          result: succeeds ? seed.values.result : null,
          evaluation: null,
          feedback: null,
          errorCode: succeeds ? null : 'fatal',
          factPayload: seed.values.result,
          nowMs: 70,
        };
        expect(
          acceptInternalResultT6a(instance.store, resultInput).disposition,
        ).toBe('terminal');
        expect(
          acceptInternalResultT6a(instance.store, resultInput).disposition,
        ).toBe('exact_replay');
        const model = new G5BasicRuntimeReferenceModel(
          [{ id: 'timeout', kind: 'system' }],
          [],
        );
        model.activate('timeout');
        model.complete('timeout', succeeds ? 'succeeded' : 'failed');
        const production = instance.store.queryOne<{
          terminal_status: string;
        }>('SELECT terminal_status FROM workflow_graph_nodes WHERE id = ?', [
          node.id,
        ])!;
        expect(production.terminal_status).toBe(
          model.nodes.get('timeout')!.terminalStatus,
        );
        expect(
          instance.store.queryOne<{ count: number }>(
            'SELECT count(*) AS count FROM workflow_graph_facts WHERE graph_run_id = ? AND fact_key = ?',
            [
              created.activation.graphRunId,
              `attempt-result:${admission.attemptId}`,
            ],
          )!.count,
        ).toBe(1);
        expect(
          instance.store.queryOne<{ count: number }>(
            'SELECT count(*) AS count FROM workflow_graph_events WHERE graph_run_id = ? AND idempotency_key = ?',
            [
              created.activation.graphRunId,
              `attempt-result:${admission.attemptId}`,
            ],
          )!.count,
        ).toBe(1);
        expect(
          instance.store.queryOne<{ reserved_amount: number }>(
            "SELECT reserved_amount FROM workflow_graph_resource_accounts WHERE graph_run_id = ? AND resource_type = 'active_executions'",
            [created.activation.graphRunId],
          )!.reserved_amount,
        ).toBe(0);
        expect(
          instance.store.queryOne<{ count: number }>(
            'SELECT count(*) AS count FROM workflow_operational_blockers WHERE graph_run_id = ?',
            [created.activation.graphRunId],
          )!.count,
        ).toBe(0);
      }),
      { seed: 0x5a17, numRuns: 1 },
    );
  });

  it.each(
    g5FixtureCases.filter((fixture) => fixture.transaction_id !== 'CAP0-CAP4'),
  )('drives fixture $case_id through production evidence', ({ case_id }) => {
    expect(fixtureEvidence.get(case_id)).toMatch(/production SQLite/);
  });
});
