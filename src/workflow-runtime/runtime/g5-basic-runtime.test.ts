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
import {
  evaluateReferenceInputContract,
  evaluateReferenceTrigger,
  G5BasicRuntimeReferenceModel,
  type ReferenceTrigger,
} from '../contracts/g5-basic-runtime-reference-model.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import {
  compileTriggerProgram,
  expressionSteps,
  semanticHash,
  sortObjectKeys,
} from '../compiler/normalizer.js';
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
          : resource.resourceType === 'schema'
            ? {}
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

interface TestSchemaAuthority {
  readonly type: 'registry';
  readonly ref: { readonly id: string; readonly version: string };
  readonly schema_hash: Sha256Hash;
  readonly rowId: string;
}

interface InputContractCase {
  readonly id: string;
  readonly list: boolean;
  readonly value: JsonValue;
  readonly second?: JsonValue;
  readonly max: number | null;
  readonly itemMax: number | null;
  readonly schema: 'number' | 'string';
  readonly arrayMaxItems?: number;
}

const inputContractCases: readonly InputContractCase[] = [
  {
    id: 'single-schema',
    list: false,
    value: 'wrong',
    max: null,
    itemMax: null,
    schema: 'number',
  },
  {
    id: 'single-max',
    list: false,
    value: 'too-long',
    max: 3,
    itemMax: null,
    schema: 'string',
  },
  {
    id: 'list-item-schema',
    list: true,
    value: 'wrong',
    max: null,
    itemMax: null,
    schema: 'number',
  },
  {
    id: 'list-item-max',
    list: true,
    value: 'too-long',
    max: null,
    itemMax: 3,
    schema: 'string',
  },
  {
    id: 'list-array-schema',
    list: true,
    value: 'ok',
    second: 'two',
    max: null,
    itemMax: null,
    schema: 'string',
    arrayMaxItems: 1,
  },
  {
    id: 'list-total-max',
    list: true,
    value: 'abc',
    second: 'def',
    max: 5,
    itemMax: null,
    schema: 'string',
  },
];

function compiledTestSchema(schema: TestSchemaAuthority): JsonObject {
  return {
    type: schema.type,
    ref: schema.ref,
    schema_hash: schema.schema_hash,
  };
}

function publishTestSchema(
  store: WorkflowRuntimeStore,
  seed: SeededRuntime,
  label: string,
  schema: JsonObject,
): TestSchemaAuthority {
  const ref = { id: `g5.test.schema.${label}`, version: '1.0.0' };
  const schemaHash = hash(`test-schema:${label}`);
  const rowId = registryResourceId({ resource_type: 'schema', ref });
  const valueId = `value:test-schema:${label}`;
  const content = canonicalJson(schema);
  store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, blob_hash,
         immutable_external_locator, expected_hash, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
         row_version
       ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/schema+json',
         ?, ?, 'g5-test-schema', 'pinned', 'live', NULL, 2, 1)`,
      [
        valueId,
        content,
        schemaHash,
        Buffer.byteLength(content),
        seed.refs.schema.rowId,
        seed.refs.schema.hash,
      ],
    );
    transaction.execute(
      `INSERT INTO workflow_registry_resources (
         id, resource_type, resource_id, resource_version, owner_core_ref,
         owner_feature_id, canonical_value_id, content_hash, publication_state,
         created_at_ms, published_at_ms, retired_at_ms, row_version
       ) VALUES (?, 'schema', ?, ?, 'icarus.core@1.0.0', NULL, ?, ?,
         'published', 2, 2, NULL, 1)`,
      [rowId, ref.id, ref.version, valueId, schemaHash],
    );
  });
  return { type: 'registry', ref, schema_hash: schemaHash, rowId };
}

function insertTestValue(
  store: WorkflowRuntimeStore,
  schema: TestSchemaAuthority,
  label: string,
  value: JsonValue,
): { id: string; hash: Sha256Hash; byteLength: number } {
  const id = `value:test:${label}`;
  const valueHash = hash(`test-value:${label}:${canonicalJson(value)}`);
  const content = canonicalJson(value);
  store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_values (
         id, storage_kind, inline_canonical_json, blob_hash,
         immutable_external_locator, expected_hash, content_hash, byte_length,
         media_type, schema_resource_id, schema_resource_hash, provenance_ref,
         retention_class, payload_state, payload_pruned_at_ms, created_at_ms,
         row_version
       ) VALUES (?, 'inline', ?, NULL, NULL, NULL, ?, ?, 'application/json',
         ?, ?, 'g5-test-value', 'run_recovery', 'live', NULL, 3, 1)`,
      [
        id,
        content,
        valueHash,
        Buffer.byteLength(content),
        schema.rowId,
        schema.schema_hash,
      ],
    );
  });
  return { id, hash: valueHash, byteLength: Buffer.byteLength(content) };
}

function replaceSeedInputContent(
  store: WorkflowRuntimeStore,
  seed: SeededRuntime,
  value: JsonValue,
): void {
  const content = canonicalJson(value);
  store.withImmediateTransaction((transaction) => {
    expect(
      transaction.execute(
        'UPDATE workflow_values SET inline_canonical_json = ?, byte_length = ?, row_version = row_version + 1 WHERE id = ? AND content_hash = ?',
        [
          content,
          Buffer.byteLength(content),
          seed.values.input.id,
          seed.values.input.hash,
        ],
      ).changes,
    ).toBe(1);
  });
}

const G5_TEST_SOURCE: JsonObject = { format: 'g5-test-source' };

function completionPolicy(
  settledRules: Array<{
    id: string;
    phase: 'settled';
    priority: number;
    when: JsonObject;
    selector: JsonObject;
  }>,
  earlyRules: Array<{
    id: string;
    phase: 'early';
    priority: number;
    when: JsonObject;
    selector: JsonObject;
  }> = [],
): JsonObject {
  const compileRule = (
    rule: (typeof settledRules)[number] | (typeof earlyRules)[number],
  ) => {
    const expression = sortObjectKeys(rule.when);
    const selector = sortObjectKeys(rule.selector);
    const withoutHash: JsonObject = {
      id: rule.id,
      phase: rule.phase,
      normalized_fact_expression: expression,
      fact_program_hash: semanticHash(
        'icarus:workflow-completion-fact-program:1\n',
        {
          normalized_fact_expression: expression,
          max_steps: expressionSteps(expression),
        },
      ),
      max_steps: expressionSteps(expression),
      selector,
      selector_contract_hash: semanticHash(
        'icarus:workflow-completion-selector:1\n',
        selector,
      ),
      priority: rule.priority,
      monotonicity_proof: null,
      cancellation_safety_proof: null,
    };
    return {
      ...withoutHash,
      rule_hash: semanticHash(
        'icarus:workflow-completion-rule:1\n',
        withoutHash,
      ),
    };
  };
  const withoutHash: JsonObject = {
    early_rules: earlyRules.map(compileRule),
    settled_rules: settledRules.map(compileRule),
    no_match: 'error',
    early_close: 'cancel_and_fence_remaining',
  };
  return {
    ...withoutHash,
    policy_hash: semanticHash(
      'icarus:workflow-completion-policy:1\n',
      withoutHash,
    ),
  };
}

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
        trigger_program: compileTriggerProgram({ type: 'root' }),
        input_ports: {},
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
        trigger_program: compileTriggerProgram({ type: 'root' }),
        input_ports: {},
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
        trigger_program: compileTriggerProgram({ type: 'root' }),
        input_ports: {},
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
        trigger_program: compileTriggerProgram({ type: 'root' }),
        input_ports: {},
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
        trigger_program: compileTriggerProgram({
          type: 'all',
          edge_ids: ['work-to-done'],
        }),
        input_ports: {
          value: {
            schema: {
              type: 'registry',
              ref: seed.refs.schema.ref,
              schema_hash: seed.refs.schema.hash,
            },
            max_bytes: null,
            aggregation: { type: 'single', select: 'only', required: true },
          },
        },
      },
      {
        id: 'done',
        type: 'terminal',
        capability_binding: null,
        exit: 'done',
        trigger_program: compileTriggerProgram({
          type: 'all',
          edge_ids: ['join-to-done'],
        }),
        input_ports: {},
      },
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
    completion: completionPolicy([
      {
        id: 'select_named_exit',
        phase: 'settled',
        priority: 100,
        when: { fact: 'all_nodes_terminal' },
        selector: {
          exits: ['done'],
          pick: { type: 'lowest_terminal_node_id' },
        },
      },
    ]),
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

interface MaterializedPlanCase {
  readonly graphRunId: string;
  readonly scopeId: string;
  readonly plan: CompiledScopePlanV2Document;
}

function pinTestDefinitionPlan(
  store: WorkflowRuntimeStore,
  seed: SeededRuntime,
  candidate: CompiledScopePlanV2Document,
): void {
  const content = canonicalJson({
    compiled_plan_pin: {
      plan_hash: candidate.plan_hash,
      plan_format: candidate.format,
      compiler_toolchain_hash: candidate.compiler_toolchain_hash,
      compiler_build_hash: candidate.compiler_build_hash,
      provenance: 'sealed_g2_expected',
    },
  });
  store.withImmediateTransaction((transaction) => {
    const changed = transaction.execute(
      `UPDATE workflow_values
          SET inline_canonical_json = ?, byte_length = ?, row_version = row_version + 1
        WHERE id = (
          SELECT canonical_value_id FROM workflow_registry_resources WHERE id = ?
        )`,
      [content, Buffer.byteLength(content), seed.refs.definition.rowId],
    ).changes;
    expect(changed).toBe(1);
  });
}

function materializePlanCase(
  instance: G4TestBootstrapInstance,
  seed: SeededRuntime,
  candidate: CompiledScopePlanV2Document,
  caseId: string,
  nowMs: number,
): MaterializedPlanCase {
  pinTestDefinitionPlan(instance.store, seed, candidate);
  const creationKey = `fixed-point-${caseId}`;
  const created = createWorkflowT0(instance.store, {
    requestId: `request-${caseId}`,
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
    routingDecisionJson: { reason_codes: ['explicit_recipe'] },
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
      state_activations_total: 8,
      graph_runs_total: 8,
      descendant_workflows_total: 8,
    },
    domainClaims: [],
    initialActivation: initialActivation(seed, nowMs),
    nowMs,
  });
  const compiled = persistCompileResultT2a(instance.store, {
    graphRunId: created.activation.graphRunId,
    buildId: created.activation.rootBuildId,
    expectedBuildRowVersion: 1,
    expectedRunWorkFenceEpoch: 0,
    expectedOwnerScopeWorkFenceEpoch: 0,
    expectedCompilerSnapshotHash: hash('compiler-snapshot'),
    sourceJson: G5_TEST_SOURCE,
    sourceHash: candidate.source_hash as Sha256Hash,
    plan: candidate,
    nowMs: nowMs + 1,
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
    plan: candidate,
    inputSnapshot: seed.values.input,
    nowMs: nowMs + 2,
  });
  return {
    graphRunId: created.activation.graphRunId,
    scopeId: created.activation.rootScopeId,
    plan: candidate,
  };
}

function planVariant(
  seed: SeededRuntime,
  overrides: Partial<Omit<CompiledScopePlanV2Document, 'plan_hash'>>,
): CompiledScopePlanV2Document {
  const { plan_hash: _planHash, ...base } = plan(seed);
  void _planHash;
  return withPlanHash({
    ...base,
    ...overrides,
  } as Omit<CompiledScopePlanV2Document, 'plan_hash'>);
}

function conditionProgram(expression: JsonObject): JsonObject {
  const normalized = sortObjectKeys(expression);
  const withoutHash: JsonObject = {
    normalized_ast: normalized,
    operand_schema_hashes: {},
    operand_types: [],
    max_steps: expressionSteps(normalized),
  };
  return {
    ...withoutHash,
    program_hash: semanticHash(
      'icarus:workflow-condition-program:2\n',
      withoutHash,
    ),
  };
}

function fixedCapacity() {
  const values = {
    max_active_executions: 32,
    max_active_waits: 32,
    max_pending_signals: 64,
    max_outbox_inflight: 16,
    max_physical_blob_bytes: 21_474_836_480,
    soft_blob_high_water_bytes: 17_179_869_184,
    minimum_free_disk_bytes: 5_368_709_120,
  };
  return buildDeploymentCapacityPublication(
    1,
    'g5-fixed-point-capacity',
    null,
    {
      ...values,
      config_hash: calculateDeploymentCapacityConfigHash(values),
    },
  );
}

function initializePlanCase(
  instance: G4TestBootstrapInstance,
  run: MaterializedPlanCase,
  nowMs: number,
  fault?: { point: 'before_first_write' | 'before_commit' },
) {
  const row = instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [run.graphRunId],
  )!;
  return initializeScopeFixedPointT3a(
    instance.store,
    {
      graphRunId: run.graphRunId,
      scopeId: run.scopeId,
      expectedRunRowVersion: row.row_version,
      nowMs,
    },
    fault,
  );
}

function scheduleStructuralNode(
  instance: G4TestBootstrapInstance,
  run: MaterializedPlanCase,
  nodeKey: string,
  nowMs: number,
): { id: string; output: { id: string; hash: Sha256Hash } } {
  const node = instance.store.queryOne<{
    id: string;
    row_version: number;
    activation_event_seq: number;
  }>(
    'SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = ?',
    [run.graphRunId, nodeKey],
  )!;
  scheduleReadyNodeT4(
    instance.store,
    { current: () => fixedCapacity() },
    {
      graphRunId: run.graphRunId,
      scopeId: run.scopeId,
      nodeId: node.id,
      expectedNodeRowVersion: node.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: node.activation_event_seq,
      activation: { kind: 'structural' },
      nowMs,
    },
  );
  const terminal = instance.store.queryOne<{
    published_output_envelope_value_id: string;
    published_output_envelope_hash: Sha256Hash;
  }>(
    'SELECT published_output_envelope_value_id, published_output_envelope_hash FROM workflow_graph_nodes WHERE id = ?',
    [node.id],
  )!;
  return {
    id: node.id,
    output: {
      id: terminal.published_output_envelope_value_id,
      hash: terminal.published_output_envelope_hash,
    },
  };
}

function reconcileTerminalNode(
  instance: G4TestBootstrapInstance,
  run: MaterializedPlanCase,
  terminal: { id: string; output: { id: string; hash: Sha256Hash } },
  factKey: string,
  nowMs: number,
  fault?: { point: 'before_first_write' | 'before_commit' },
) {
  const row = instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [run.graphRunId],
  )!;
  return reconcileFactT3a(
    instance.store,
    {
      graphRunId: run.graphRunId,
      scopeId: run.scopeId,
      expectedRunRowVersion: row.row_version,
      factKind: 'node_terminal',
      stableObjectKind: 'node',
      stableObjectId: terminal.id,
      factKey,
      payload: terminal.output,
      terminalStatus: 'succeeded',
      nowMs,
    },
    fault,
  );
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

  it('derives route decisions and Strong Kleene trigger cuts from the sealed Plan', () => {
    const instance = bootstrap('g5-fixed-point-route-trigger');
    const seed = seedRuntime(instance.store);
    const root = (id: string): JsonObject => ({
      id,
      type: 'join',
      capability_binding: null,
      trigger_program: compileTriggerProgram({ type: 'root' }),
      input_ports: {},
    });
    const target = (id: string, trigger: JsonObject): JsonObject => ({
      id,
      type: 'join',
      capability_binding: null,
      trigger_program: trigger,
      input_ports: {},
    });
    const edge = (
      id: string,
      from: string,
      to: string,
      statuses: string[],
      extra: JsonObject = {},
    ): JsonObject => ({
      id,
      from_node_id: from,
      to_node_id: to,
      outcome_match: { statuses },
      condition_program: null,
      is_default: false,
      priority: null,
      route_group_id: null,
      compiled_edge_hash: hash(`fixed-point-edge:${id}`),
      ...extra,
    });
    const controlEdges = [
      edge('z-not-any', 'z-source', 'any-target', ['failed']),
      edge('a-any', 'a-source', 'any-target', ['succeeded']),
      edge('z-not-quorum', 'z-source', 'quorum-target', ['failed']),
      edge('a-quorum', 'a-source', 'quorum-target', ['succeeded']),
      edge('b-quorum', 'b-source', 'quorum-target', ['succeeded']),
      edge('a-expression', 'a-source', 'expression-target', ['succeeded']),
      edge('b-expression', 'b-source', 'expression-target', ['succeeded']),
      edge('route-false', 'route-source', 'route-false-target', ['succeeded'], {
        condition_program: conditionProgram({
          op: 'eq',
          left: { literal: false },
          right: { literal: true },
        }),
        priority: 30,
        route_group_id: 'first-route',
      }),
      edge('route-true', 'route-source', 'route-true-target', ['succeeded'], {
        condition_program: conditionProgram({
          op: 'eq',
          left: { literal: 'match' },
          right: { literal: 'match' },
        }),
        priority: 20,
        route_group_id: 'first-route',
      }),
      {
        id: 'route-default',
        from_node_id: 'route-source',
        to_node_id: 'route-default-target',
        is_default: true,
        route_group_id: 'first-route',
        condition_program: null,
        priority: null,
        compiled_edge_hash: hash('fixed-point-edge:route-default'),
      },
    ];
    const candidate = planVariant(seed, {
      nodes: [
        root('z-source'),
        root('a-source'),
        root('b-source'),
        root('route-source'),
        target(
          'any-target',
          compileTriggerProgram({
            type: 'any',
            edge_ids: ['z-not-any', 'a-any'],
          }),
        ),
        target(
          'quorum-target',
          compileTriggerProgram({
            type: 'quorum',
            edge_ids: ['z-not-quorum', 'a-quorum', 'b-quorum'],
            min_taken: 2,
          }),
        ),
        target(
          'expression-target',
          compileTriggerProgram({
            type: 'expression',
            expression: {
              op: 'or',
              args: [
                { op: 'edge_is', edge_id: 'a-expression', state: 'taken' },
                { op: 'edge_is', edge_id: 'b-expression', state: 'taken' },
              ],
            },
          }),
        ),
        target(
          'route-false-target',
          compileTriggerProgram({ type: 'all', edge_ids: ['route-false'] }),
        ),
        target(
          'route-true-target',
          compileTriggerProgram({ type: 'all', edge_ids: ['route-true'] }),
        ),
        target(
          'route-default-target',
          compileTriggerProgram({ type: 'all', edge_ids: ['route-default'] }),
        ),
      ],
      route_groups: [
        {
          id: 'first-route',
          from_node_id: 'route-source',
          mode: 'first_matching',
          no_match: 'allow',
          ordered_edge_ids: ['route-false', 'route-true', 'route-default'],
        },
      ],
      control_edges: controlEdges,
      data_edges: [],
      completion: completionPolicy([
        {
          id: 'never-close-during-fixed-point',
          phase: 'settled',
          priority: 1,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            exits: ['unused'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ]),
    });
    const run = materializePlanCase(
      instance,
      seed,
      candidate,
      'route-trigger',
      10,
    );
    initializePlanCase(instance, run, 20);

    const first = scheduleStructuralNode(instance, run, 'z-source', 30);
    reconcileTerminalNode(instance, run, first, 'terminal:z-source', 31);
    expect(
      instance.store.queryOne<{ trigger_state: string }>(
        "SELECT trigger_state FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'any-target'",
        [run.graphRunId],
      )!.trigger_state,
    ).toBe('unknown');
    instance.closeStore();
    instance.reopenStore();

    const second = scheduleStructuralNode(instance, run, 'a-source', 40);
    expect(() =>
      reconcileTerminalNode(instance, run, second, 'terminal:a-source', 41, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    expect(
      instance.store.queryOne<{ state: string }>(
        `SELECT r.state FROM workflow_graph_edges e
           JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
          WHERE e.graph_run_id = ? AND e.edge_key = 'a-any'`,
        [run.graphRunId],
      )!.state,
    ).toBe('unresolved');
    reconcileTerminalNode(instance, run, second, 'terminal:a-source', 41);

    const cutAfterAny = instance.store.queryOne<{
      trigger_cut_json: string;
      trigger_cut_hash: string;
      phase: string;
    }>(
      "SELECT trigger_cut_json, trigger_cut_hash, phase FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'any-target'",
      [run.graphRunId],
    )!;
    expect(cutAfterAny.phase).toBe('ready');
    expect(JSON.parse(cutAfterAny.trigger_cut_json)).toMatchObject({
      truth: 'true',
      witness: [{ edge_id: 'a-any', state: 'taken' }],
    });
    expect(
      JSON.parse(
        instance.store.queryOne<{ trigger_cut_json: string }>(
          "SELECT trigger_cut_json FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'expression-target'",
          [run.graphRunId],
        )!.trigger_cut_json,
      ),
    ).toMatchObject({
      truth: 'true',
      witness: [{ edge_id: 'a-expression', state: 'taken' }],
    });

    const third = scheduleStructuralNode(instance, run, 'b-source', 50);
    reconcileTerminalNode(instance, run, third, 'terminal:b-source', 51);
    const quorumCut = JSON.parse(
      instance.store.queryOne<{ trigger_cut_json: string }>(
        "SELECT trigger_cut_json FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'quorum-target'",
        [run.graphRunId],
      )!.trigger_cut_json,
    ) as { witness: Array<{ edge_id: string; resolution_seq: number }> };
    expect(quorumCut.witness.map((item) => item.edge_id)).toEqual([
      'a-quorum',
      'b-quorum',
    ]);
    expect(quorumCut.witness[0]!.resolution_seq).toBeLessThan(
      quorumCut.witness[1]!.resolution_seq,
    );
    expect(
      instance.store.queryOne<{
        trigger_cut_json: string;
        trigger_cut_hash: string;
      }>(
        "SELECT trigger_cut_json, trigger_cut_hash FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'any-target'",
        [run.graphRunId],
      ),
    ).toEqual({
      trigger_cut_json: cutAfterAny.trigger_cut_json,
      trigger_cut_hash: cutAfterAny.trigger_cut_hash,
    });

    const route = scheduleStructuralNode(instance, run, 'route-source', 60);
    reconcileTerminalNode(instance, run, route, 'terminal:route-source', 61);
    const routeStates = instance.store.queryAll<{
      edge_key: string;
      state: string;
    }>(
      `SELECT e.edge_key, r.state FROM workflow_graph_edges e
         JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
        WHERE e.graph_run_id = ? AND e.edge_key LIKE 'route-%'
        ORDER BY e.edge_key COLLATE BINARY`,
      [run.graphRunId],
    );
    expect(routeStates).toEqual([
      { edge_key: 'route-default', state: 'not_taken' },
      { edge_key: 'route-false', state: 'not_taken' },
      { edge_key: 'route-true', state: 'taken' },
    ]);
    expect(
      instance.store.queryOne<{ phase: string }>(
        "SELECT phase FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'route-true-target'",
        [run.graphRunId],
      )!.phase,
    ).toBe('ready');
  });

  it('seals required, optional, default, list, and literal inputs from Plan contracts', () => {
    const instance = bootstrap('g5-fixed-point-input-seal');
    const seed = seedRuntime(instance.store);
    const inputNode = (id: string, inputPorts: JsonObject): JsonObject => ({
      id,
      type: 'join',
      capability_binding: null,
      trigger_program: compileTriggerProgram({ type: 'root' }),
      input_ports: inputPorts,
    });
    const schema = {
      type: 'registry',
      ref: seed.refs.schema.ref,
      schema_hash: seed.refs.schema.hash,
    };
    const dataEdge = (
      id: string,
      toNode: string,
      port: string,
      from: JsonObject = { type: 'scope_input', port: 'result' },
    ): JsonObject => ({
      id,
      from,
      to: { node_id: toNode, port },
      derived_schema: schema,
      producer_schema_hash: seed.refs.schema.hash,
      consumer_schema_hash: seed.refs.schema.hash,
      on_missing: 'unavailable',
      guard_control_edge_id: null,
      compiled_edge_hash: hash(`input-edge:${id}`),
    });
    const single = (aggregation: JsonObject): JsonObject => ({
      schema,
      max_bytes: null,
      aggregation,
    });
    const candidate = planVariant(seed, {
      nodes: [
        inputNode('required', {
          value: single({ type: 'single', select: 'only', required: true }),
        }),
        inputNode('optional', {
          value: single({ type: 'single', select: 'only', required: false }),
        }),
        inputNode('defaulted', {
          value: single({
            type: 'single',
            select: 'only',
            required: true,
            default: { source: 'plan-default' },
          }),
        }),
        inputNode('listed', {
          values: {
            schema,
            max_bytes: null,
            item_schema: schema,
            item_max_bytes: null,
            aggregation: {
              type: 'list',
              min_items: 2,
              seal: { type: 'all_sources_resolved' },
              order: 'edge_id',
            },
          },
        }),
        inputNode('first-n', {
          values: {
            schema,
            max_bytes: null,
            item_schema: schema,
            item_max_bytes: null,
            aggregation: {
              type: 'list',
              min_items: 1,
              seal: { type: 'first_n_available', count: 1 },
              order: 'resolution_seq',
            },
          },
        }),
        inputNode('literal', {
          value: single({ type: 'single', select: 'only', required: true }),
        }),
      ],
      route_groups: [],
      control_edges: [],
      data_edges: [
        dataEdge('required-value', 'required', 'value'),
        dataEdge('z-list-value', 'listed', 'values'),
        dataEdge('a-list-value', 'listed', 'values'),
        dataEdge('z-first-value', 'first-n', 'values'),
        dataEdge('a-first-value', 'first-n', 'values'),
        dataEdge('literal-value', 'literal', 'value', {
          type: 'literal',
          value: { source: 'sealed-plan-literal' },
        }),
      ],
      completion: completionPolicy([
        {
          id: 'input-no-close',
          phase: 'settled',
          priority: 1,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            exits: ['unused'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ]),
    });
    const run = materializePlanCase(
      instance,
      seed,
      candidate,
      'input-seal',
      100,
    );
    expect(initializePlanCase(instance, run, 110).readyNodeIds).toHaveLength(6);
    const rows = instance.store.queryAll<{
      node_key: string;
      phase: string;
      input_snapshot_json: string;
      input_snapshot_value_id: string | null;
      selected_edges_json: string;
    }>(
      `SELECT node_key, phase, input_snapshot_json, input_snapshot_value_id,
              selected_edges_json
         FROM workflow_graph_nodes WHERE graph_run_id = ?
        ORDER BY node_key COLLATE BINARY`,
      [run.graphRunId],
    );
    expect(rows.every((row) => row.phase === 'ready')).toBe(true);
    const byNode = new Map(rows.map((row) => [row.node_key, row]));
    expect(JSON.parse(byNode.get('optional')!.input_snapshot_json)).toEqual({
      ports: { value: { selected_edges: [], state: 'absent' } },
    });
    const defaultSnapshot = JSON.parse(
      byNode.get('defaulted')!.input_snapshot_json,
    ) as JsonObject;
    expect(defaultSnapshot).toMatchObject({
      ports: {
        value: {
          aggregation: 'default',
          default_value: { source: 'plan-default' },
          selected_edges: [],
          state: 'present',
        },
      },
    });
    expect(
      ((defaultSnapshot.ports as JsonObject).value as JsonObject).logical_value,
    ).toMatchObject({
      value_id: expect.stringMatching(/^g5:input-port-value:/),
      value_hash: expect.stringMatching(/^sha256:/),
    });
    expect(byNode.get('required')!.input_snapshot_value_id).toBe(
      seed.values.input.id,
    );
    expect(JSON.parse(byNode.get('listed')!.selected_edges_json)).toEqual([
      'a-list-value',
      'z-list-value',
    ]);
    const listed = JSON.parse(byNode.get('listed')!.input_snapshot_json) as {
      ports: { values: { values: Array<{ edge_key: string }> } };
    };
    expect(listed.ports.values.values.map((value) => value.edge_key)).toEqual([
      'a-list-value',
      'z-list-value',
    ]);
    expect(JSON.parse(byNode.get('first-n')!.selected_edges_json)).toEqual([
      'a-first-value',
    ]);
    expect(JSON.parse(byNode.get('literal')!.selected_edges_json)).toEqual([
      'literal-value',
    ]);
    const literalValueId = byNode.get('literal')!.input_snapshot_value_id!;
    expect(literalValueId).toMatch(/^g5:selected-data-value:/);
    expect(
      instance.store.queryOne<{
        inline_canonical_json: string;
        schema_resource_hash: string;
      }>(
        'SELECT inline_canonical_json, schema_resource_hash FROM workflow_values WHERE id = ?',
        [literalValueId],
      ),
    ).toEqual({
      inline_canonical_json: '{"source":"sealed-plan-literal"}',
      schema_resource_hash: seed.refs.schema.hash,
    });
  });

  it('binds scope and node data edges to selected immutable Values and persists pointer Values', () => {
    const instance = bootstrap('g5-selected-data-value-authority');
    const seed = seedRuntime(instance.store);
    const objectSchema = publishTestSchema(
      instance.store,
      seed,
      'selected-object',
      {
        type: 'object',
        additionalProperties: false,
        required: ['nested'],
        properties: {
          nested: {
            type: 'object',
            additionalProperties: false,
            required: ['answer'],
            properties: { answer: { type: 'integer' } },
          },
        },
      },
    );
    const numberSchema = publishTestSchema(
      instance.store,
      seed,
      'selected-number',
      { type: 'integer' },
    );
    const selected = insertTestValue(
      instance.store,
      objectSchema,
      'selected-port-value',
      { nested: { answer: 7 } },
    );
    replaceSeedInputContent(instance.store, seed, {
      port_contract_hash: hash('selected-port-contract'),
      ports: {
        result: {
          state: 'present',
          value_ref: selected.id,
          value_hash: selected.hash,
          schema_hash: objectSchema.schema_hash,
          byte_length: selected.byteLength,
        },
        ignored: {
          state: 'absent',
          schema_hash: objectSchema.schema_hash,
        },
      },
      envelope_hash: hash('selected-envelope'),
    });
    const inputPort = (schema: TestSchemaAuthority): JsonObject => ({
      schema: compiledTestSchema(schema),
      max_bytes: 1_024,
      aggregation: { type: 'single', select: 'only', required: true },
    });
    const target = (id: string, schema: TestSchemaAuthority): JsonObject => ({
      id,
      type: 'join',
      capability_binding: null,
      trigger_program: compileTriggerProgram({ type: 'root' }),
      input_ports: { value: inputPort(schema) },
      output_ports: {},
    });
    const dataEdge = (
      id: string,
      nodeId: string,
      from: JsonObject,
      schema: TestSchemaAuthority,
    ): JsonObject => ({
      id,
      from,
      to: { node_id: nodeId, port: 'value' },
      derived_schema: compiledTestSchema(schema),
      producer_schema_hash: objectSchema.schema_hash,
      consumer_schema_hash: schema.schema_hash,
      on_missing: null,
      guard_control_edge_id: null,
      compiled_edge_hash: hash(`selected-edge:${id}`),
    });
    const candidate = planVariant(seed, {
      nodes: [
        {
          id: 'source',
          type: 'join',
          capability_binding: null,
          trigger_program: compileTriggerProgram({ type: 'root' }),
          input_ports: {},
          output_ports: {
            result: {
              schema: compiledTestSchema(objectSchema),
              max_bytes: 1_024,
              required: true,
            },
          },
        },
        target('scope-direct', objectSchema),
        target('scope-pointer', numberSchema),
        target('node-direct', objectSchema),
        target('node-pointer', numberSchema),
      ],
      route_groups: [],
      control_edges: [],
      data_edges: [
        dataEdge(
          'scope-direct-edge',
          'scope-direct',
          { type: 'scope_input', port: 'result' },
          objectSchema,
        ),
        dataEdge(
          'scope-pointer-edge',
          'scope-pointer',
          {
            type: 'scope_input',
            port: 'result',
            pointer: '/nested/answer',
          },
          numberSchema,
        ),
        dataEdge(
          'node-direct-edge',
          'node-direct',
          { type: 'node_output', node_id: 'source', port: 'result' },
          objectSchema,
        ),
        dataEdge(
          'node-pointer-edge',
          'node-pointer',
          {
            type: 'node_output',
            node_id: 'source',
            port: 'result',
            pointer: '/nested/answer',
          },
          numberSchema,
        ),
      ],
      completion: completionPolicy([
        {
          id: 'selected-value-no-close',
          phase: 'settled',
          priority: 1,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            exits: ['unused'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ]),
      runtime_safety_snapshot: {
        value: { max_single_value_bytes: 4_096 },
      },
    });
    const run = materializePlanCase(
      instance,
      seed,
      candidate,
      'selected-values',
      100,
    );
    expect(() =>
      initializePlanCase(instance, run, 110, { point: 'before_commit' }),
    ).toThrow(/Injected (?:G5 )?fault/);
    expect(
      instance.store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_values WHERE provenance_ref LIKE 'plan-data:%'",
        [],
      )!.count,
    ).toBe(0);
    initializePlanCase(instance, run, 111);
    const initializedSequence = initializePlanCase(
      instance,
      run,
      112,
    ).lastEventSequence;
    expect(initializedSequence).toBeGreaterThan(0);
    const source = scheduleStructuralNode(instance, run, 'source', 120);
    expect(() =>
      reconcileTerminalNode(
        instance,
        run,
        source,
        'terminal:selected-source',
        121,
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected (?:G5 )?fault/);
    expect(
      instance.store.queryOne<{ state: string }>(
        `SELECT r.state FROM workflow_graph_edges e
           JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
          WHERE e.graph_run_id = ? AND e.edge_key = 'node-direct-edge'`,
        [run.graphRunId],
      )!.state,
    ).toBe('unresolved');
    expect(
      reconcileTerminalNode(
        instance,
        run,
        source,
        'terminal:selected-source',
        122,
      ).disposition,
    ).toBe('reconciled');
    expect(
      reconcileTerminalNode(
        instance,
        run,
        source,
        'terminal:selected-source',
        123,
      ).disposition,
    ).toBe('exact_replay');
    const resolutions = instance.store.queryAll<{
      edge_key: string;
      value_value_id: string;
      value_hash: Sha256Hash;
    }>(
      `SELECT e.edge_key, r.value_value_id, r.value_hash
         FROM workflow_graph_edges e
         JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
        WHERE e.graph_run_id = ? ORDER BY e.edge_key COLLATE BINARY`,
      [run.graphRunId],
    );
    const byEdge = new Map(resolutions.map((row) => [row.edge_key, row]));
    expect(byEdge.get('scope-direct-edge')).toMatchObject({
      value_value_id: selected.id,
      value_hash: selected.hash,
    });
    expect(byEdge.get('node-direct-edge')).toMatchObject({
      value_value_id: selected.id,
      value_hash: selected.hash,
    });
    for (const edgeId of ['scope-pointer-edge', 'node-pointer-edge']) {
      const resolution = byEdge.get(edgeId)!;
      expect(resolution.value_value_id).toMatch(/^g5:selected-data-value:/);
      expect(resolution.value_value_id).not.toBe(seed.values.input.id);
      expect(
        instance.store.queryOne<{
          inline_canonical_json: string;
          schema_resource_hash: string;
        }>(
          'SELECT inline_canonical_json, schema_resource_hash FROM workflow_values WHERE id = ? AND content_hash = ?',
          [resolution.value_value_id, resolution.value_hash],
        ),
      ).toEqual({
        inline_canonical_json: '7',
        schema_resource_hash: numberSchema.schema_hash,
      });
    }
  });

  it.each(inputContractCases)(
    'enforces single and list schema and byte contracts before readiness: $id',
    (testCase) => {
      const instance = bootstrap(`g5-input-contract-${testCase.id}`);
      const seed = seedRuntime(instance.store);
      const stringSchema = publishTestSchema(
        instance.store,
        seed,
        `${testCase.id}-string`,
        { type: 'string' },
      );
      const numberSchema = publishTestSchema(
        instance.store,
        seed,
        `${testCase.id}-number`,
        { type: 'integer' },
      );
      const itemSchema =
        testCase.schema === 'number' ? numberSchema : stringSchema;
      const arraySchema = publishTestSchema(
        instance.store,
        seed,
        `${testCase.id}-array`,
        {
          type: 'array',
          items: { type: testCase.schema === 'number' ? 'integer' : 'string' },
          ...(testCase.arrayMaxItems === undefined
            ? {}
            : { maxItems: testCase.arrayMaxItems }),
        },
      );
      const first = insertTestValue(
        instance.store,
        stringSchema,
        `${testCase.id}-first`,
        testCase.value,
      );
      const secondValue =
        testCase.second === undefined
          ? null
          : insertTestValue(
              instance.store,
              stringSchema,
              `${testCase.id}-second`,
              testCase.second,
            );
      const ports: JsonObject = {
        first: {
          state: 'present',
          value_ref: first.id,
          value_hash: first.hash,
          schema_hash: stringSchema.schema_hash,
          byte_length: first.byteLength,
        },
      };
      if (secondValue)
        ports.second = {
          state: 'present',
          value_ref: secondValue.id,
          value_hash: secondValue.hash,
          schema_hash: stringSchema.schema_hash,
          byte_length: secondValue.byteLength,
        };
      replaceSeedInputContent(instance.store, seed, {
        port_contract_hash: hash(`contract:${testCase.id}`),
        ports,
        envelope_hash: hash(`envelope:${testCase.id}`),
      });
      const portContract: JsonObject = testCase.list
        ? {
            schema: compiledTestSchema(arraySchema),
            max_bytes: testCase.max,
            item_schema: compiledTestSchema(itemSchema),
            item_max_bytes: testCase.itemMax,
            aggregation: {
              type: 'list',
              min_items: secondValue ? 2 : 1,
              seal: { type: 'all_sources_resolved' },
              order: 'edge_id',
            },
          }
        : {
            schema: compiledTestSchema(itemSchema),
            max_bytes: testCase.max,
            aggregation: { type: 'single', select: 'only', required: true },
          };
      const edge = (port: string): JsonObject => ({
        id: `${testCase.id}-${port}`,
        from: { type: 'scope_input', port },
        to: { node_id: 'target', port: 'value' },
        derived_schema: compiledTestSchema(itemSchema),
        producer_schema_hash: stringSchema.schema_hash,
        consumer_schema_hash: itemSchema.schema_hash,
        on_missing: null,
        guard_control_edge_id: null,
        compiled_edge_hash: hash(`edge:${testCase.id}:${port}`),
      });
      const candidate = planVariant(seed, {
        nodes: [
          {
            id: 'target',
            type: 'join',
            capability_binding: null,
            trigger_program: compileTriggerProgram({ type: 'root' }),
            input_ports: { value: portContract },
            output_ports: {},
          },
        ],
        route_groups: [],
        control_edges: [],
        data_edges: [edge('first'), ...(secondValue ? [edge('second')] : [])],
        completion: completionPolicy([
          {
            id: `no-close-${testCase.id}`,
            phase: 'settled',
            priority: 1,
            when: { fact: 'all_nodes_terminal' },
            selector: {
              exits: ['unused'],
              pick: { type: 'lowest_terminal_node_id' },
            },
          },
        ]),
        runtime_safety_snapshot: {
          value: { max_single_value_bytes: 4_096 },
        },
      });
      const run = materializePlanCase(
        instance,
        seed,
        candidate,
        `input-contract-${testCase.id}`,
        200,
      );
      expect(() => initializePlanCase(instance, run, 210)).not.toThrow();
      expect(
        instance.store.queryOne<{ reason: string; error_code: string }>(
          'SELECT reason, error_code FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
          [run.graphRunId],
        ),
      ).toEqual({
        reason: 'engine_error',
        error_code: 'fixed_point_resolution_error',
      });
      expect(
        instance.store.queryOne<{ lifecycle: string }>(
          'SELECT lifecycle FROM workflow_graph_runs WHERE id = ?',
          [run.graphRunId],
        )!.lifecycle,
      ).toBe('closing');
    },
  );

  it('property-compares production input authority with an independent contract model', () => {
    const instance = bootstrap('g5-input-contract-property-model');
    const seed = seedRuntime(instance.store);
    const schemas = {
      string: publishTestSchema(instance.store, seed, 'property-string', {
        type: 'string',
      }),
      integer: publishTestSchema(instance.store, seed, 'property-integer', {
        type: 'integer',
      }),
    };
    const arrays = {
      string: publishTestSchema(instance.store, seed, 'property-string-array', {
        type: 'array',
        items: { type: 'string' },
      }),
      integer: publishTestSchema(
        instance.store,
        seed,
        'property-integer-array',
        { type: 'array', items: { type: 'integer' } },
      ),
    };
    let caseSequence = 0;
    fc.assert(
      fc.property(
        fc.record({
          aggregation: fc.constantFrom('single' as const, 'list' as const),
          schema: fc.constantFrom('string' as const, 'integer' as const),
          value: fc.oneof(
            fc.string({ minLength: 0, maxLength: 8 }),
            fc.integer({ min: -1_000, max: 1_000 }),
          ),
          maxBytes: fc.option(fc.integer({ min: 0, max: 16 }), {
            nil: null,
          }),
          itemMaxBytes: fc.option(fc.integer({ min: 0, max: 12 }), {
            nil: null,
          }),
        }),
        ({ aggregation, schema, value, maxBytes, itemMaxBytes }) => {
          const current = caseSequence++;
          const actualSchema =
            typeof value === 'string' ? schemas.string : schemas.integer;
          const targetSchema = schemas[schema];
          const stored = insertTestValue(
            instance.store,
            actualSchema,
            `property-input-${current}`,
            value,
          );
          replaceSeedInputContent(instance.store, seed, {
            port_contract_hash: hash(`property-input-contract:${current}`),
            ports: {
              result: {
                state: 'present',
                value_ref: stored.id,
                value_hash: stored.hash,
                schema_hash: actualSchema.schema_hash,
                byte_length: stored.byteLength,
              },
            },
            envelope_hash: hash(`property-input-envelope:${current}`),
          });
          const inputPort: JsonObject =
            aggregation === 'single'
              ? {
                  schema: compiledTestSchema(targetSchema),
                  max_bytes: maxBytes,
                  aggregation: {
                    type: 'single',
                    select: 'only',
                    required: true,
                  },
                }
              : {
                  schema: compiledTestSchema(arrays[schema]),
                  max_bytes: maxBytes,
                  item_schema: compiledTestSchema(targetSchema),
                  item_max_bytes: itemMaxBytes,
                  aggregation: {
                    type: 'list',
                    min_items: 1,
                    seal: { type: 'all_sources_resolved' },
                    order: 'edge_id',
                  },
                };
          const candidate = planVariant(seed, {
            nodes: [
              {
                id: 'target',
                type: 'join',
                capability_binding: null,
                trigger_program: compileTriggerProgram({ type: 'root' }),
                input_ports: { value: inputPort },
                output_ports: {},
              },
            ],
            route_groups: [],
            control_edges: [],
            data_edges: [
              {
                id: `property-input-edge-${current}`,
                from: { type: 'scope_input', port: 'result' },
                to: { node_id: 'target', port: 'value' },
                derived_schema: compiledTestSchema(targetSchema),
                producer_schema_hash: actualSchema.schema_hash,
                consumer_schema_hash: targetSchema.schema_hash,
                on_missing: null,
                guard_control_edge_id: null,
                compiled_edge_hash: hash(`property-input-edge:${current}`),
              },
            ],
            completion: completionPolicy([
              {
                id: `property-input-no-close-${current}`,
                phase: 'settled',
                priority: 1,
                when: { fact: 'all_nodes_terminal' },
                selector: {
                  exits: ['unused'],
                  pick: { type: 'lowest_terminal_node_id' },
                },
              },
            ]),
            runtime_safety_snapshot: {
              value: { max_single_value_bytes: 4_096 },
            },
          });
          const run = materializePlanCase(
            instance,
            seed,
            candidate,
            `property-input-${current}`,
            10_000 + current * 10,
          );
          initializePlanCase(instance, run, 10_003 + current * 10);
          const expected = evaluateReferenceInputContract(value, {
            aggregation,
            schema,
            maxBytes,
            itemMaxBytes,
          });
          const close = instance.store.queryOne<{
            reason: string;
            error_code: string;
          }>(
            'SELECT reason, error_code FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
            [run.graphRunId],
          );
          const node = instance.store.queryOne<{ phase: string }>(
            "SELECT phase FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'target'",
            [run.graphRunId],
          )!;
          const actual = close
            ? 'engine_error'
            : node.phase === 'ready'
              ? 'ready'
              : 'unexpected';
          expect(actual).toBe(expected);
          if (expected === 'engine_error')
            expect(close).toEqual({
              reason: 'engine_error',
              error_code: 'fixed_point_resolution_error',
            });
          else expect(close).toBeUndefined();
          const factKeys = instance.store
            .queryAll<{
              fact_key: string;
            }>(
              'SELECT fact_key FROM workflow_graph_facts WHERE graph_run_id = ?',
              [run.graphRunId],
            )
            .map((row) => row.fact_key);
          const eventKeys = instance.store
            .queryAll<{
              idempotency_key: string;
            }>(
              'SELECT idempotency_key FROM workflow_graph_events WHERE graph_run_id = ?',
              [run.graphRunId],
            )
            .map((row) => row.idempotency_key);
          expect(factKeys.length).toBeGreaterThan(0);
          for (const factKey of factKeys) expect(eventKeys).toContain(factKey);
          expect(
            instance.store.queryOne<{ consumed_amount: number }>(
              "SELECT consumed_amount FROM workflow_graph_resource_accounts WHERE graph_run_id = ? AND resource_type = 'facts_total'",
              [run.graphRunId],
            )!.consumed_amount,
          ).toBe(factKeys.length);
          expect(
            instance.store.queryOne<{ count: number }>(
              'SELECT count(*) AS count FROM workflow_operational_blockers WHERE graph_run_id = ?',
              [run.graphRunId],
            )!.count,
          ).toBe(0);
        },
      ),
      { seed: 0x13a7, numRuns: 12 },
    );
  });

  it('commits initialization data errors as engine-error facts and rolls back before commit', () => {
    const instance = bootstrap('g5-initialization-engine-error');
    const seed = seedRuntime(instance.store);
    const schema = publishTestSchema(
      instance.store,
      seed,
      'initialization-error',
      {},
    );
    const candidate = planVariant(seed, {
      nodes: [
        {
          id: 'target',
          type: 'join',
          capability_binding: null,
          trigger_program: compileTriggerProgram({ type: 'root' }),
          input_ports: {
            value: {
              schema: compiledTestSchema(schema),
              max_bytes: null,
              aggregation: { type: 'single', select: 'only', required: true },
            },
          },
          output_ports: {},
        },
      ],
      route_groups: [],
      control_edges: [],
      data_edges: [
        {
          id: 'missing-pointer',
          from: {
            type: 'scope_input',
            port: 'result',
            pointer: '/missing',
          },
          to: { node_id: 'target', port: 'value' },
          derived_schema: compiledTestSchema(schema),
          producer_schema_hash: seed.refs.schema.hash,
          consumer_schema_hash: schema.schema_hash,
          guard_control_edge_id: null,
          compiled_edge_hash: hash('missing-pointer-edge'),
        },
      ],
      completion: completionPolicy([
        {
          id: 'missing-pointer-no-close',
          phase: 'settled',
          priority: 1,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            exits: ['unused'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ]),
    });
    const run = materializePlanCase(
      instance,
      seed,
      candidate,
      'initialization-engine-error',
      300,
    );
    expect(() =>
      initializePlanCase(instance, run, 310, { point: 'before_commit' }),
    ).toThrow(/Injected (?:G5 )?fault/);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
        [run.graphRunId],
      )!.count,
    ).toBe(0);
    expect(
      instance.store.queryOne<{ state: string }>(
        `SELECT r.state FROM workflow_graph_edges e
           JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
          WHERE e.graph_run_id = ? AND e.edge_key = 'missing-pointer'`,
        [run.graphRunId],
      )!.state,
    ).toBe('unresolved');
    expect(() => initializePlanCase(instance, run, 311)).not.toThrow();
    expect(
      instance.store.queryOne<{ state: string; error_code: string }>(
        `SELECT r.state, r.error_code FROM workflow_graph_edges e
           JOIN workflow_graph_data_edge_resolutions r ON r.edge_id = e.id
          WHERE e.graph_run_id = ? AND e.edge_key = 'missing-pointer'`,
        [run.graphRunId],
      ),
    ).toEqual({ state: 'error', error_code: 'data_pointer_missing' });
    expect(
      instance.store.queryOne<{
        reason: string;
        error_code: string;
      }>(
        'SELECT reason, error_code FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
        [run.graphRunId],
      ),
    ).toEqual({
      reason: 'engine_error',
      error_code: 'fixed_point_resolution_error',
    });
    expect(
      instance.store.queryOne<{
        run_lifecycle: string;
        run_fence: number;
        scope_lifecycle: string;
        scope_fence: number;
      }>(
        `SELECT r.lifecycle AS run_lifecycle, r.work_fence_epoch AS run_fence,
                s.lifecycle AS scope_lifecycle, s.work_fence_epoch AS scope_fence
           FROM workflow_graph_runs r
           JOIN workflow_graph_scopes s ON s.graph_run_id = r.id
          WHERE r.id = ? AND s.id = ?`,
        [run.graphRunId, run.scopeId],
      ),
    ).toEqual({
      run_lifecycle: 'closing',
      run_fence: 1,
      scope_lifecycle: 'closing',
      scope_fence: 1,
    });
    expect(
      instance.store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_graph_events WHERE graph_run_id = ? AND event_type IN ('orchestration_error', 'scope_close_requested')",
        [run.graphRunId],
      )!.count,
    ).toBe(2);
  });

  it('evaluates early and settled completion rules and all selector picks', () => {
    const instance = bootstrap('g5-completion-authority');
    const seed = seedRuntime(instance.store);
    const terminal = (id: string, exit: string): JsonObject => ({
      id,
      type: 'terminal',
      capability_binding: null,
      exit,
      trigger_program: compileTriggerProgram({ type: 'root' }),
      input_ports: {},
    });
    const close = (
      run: MaterializedPlanCase,
      nowMs: number,
      fault?: { point: 'before_first_write' | 'before_commit' },
    ) => {
      const runRow = instance.store.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
        [run.graphRunId],
      )!;
      const scopeRow = instance.store.queryOne<{ row_version: number }>(
        'SELECT row_version FROM workflow_graph_scopes WHERE id = ?',
        [run.scopeId],
      )!;
      return requestSettledCloseT3b(
        instance.store,
        {
          graphRunId: run.graphRunId,
          scopeId: run.scopeId,
          expectedRunRowVersion: runRow.row_version,
          expectedScopeRowVersion: scopeRow.row_version,
          nowMs,
        },
        fault,
      );
    };
    const selected = (run: MaterializedPlanCase) =>
      instance.store.queryOne<{
        selected_rule_id: string | null;
        error_code: string | null;
        node_key: string | null;
        exit_name: string | null;
      }>(
        `SELECT r.selected_rule_id, r.error_code, n.node_key, c.exit_name
           FROM workflow_graph_scope_close_requests r
           LEFT JOIN workflow_graph_terminal_candidates c ON c.id = r.candidate_id
           LEFT JOIN workflow_graph_nodes n ON n.id = c.terminal_node_id
          WHERE r.graph_run_id = ? AND r.scope_id = ?`,
        [run.graphRunId, run.scopeId],
      )!;
    const settledRun = (
      caseId: string,
      rules: Parameters<typeof completionPolicy>[0],
      nowMs: number,
    ) => {
      const candidate = planVariant(seed, {
        nodes: [
          terminal('a-terminal', 'alpha'),
          terminal('z-terminal', 'omega'),
        ],
        route_groups: [],
        control_edges: [],
        data_edges: [],
        completion: completionPolicy(rules),
      });
      const run = materializePlanCase(instance, seed, candidate, caseId, nowMs);
      initializePlanCase(instance, run, nowMs + 3);
      scheduleStructuralNode(instance, run, 'z-terminal', nowMs + 4);
      scheduleStructuralNode(instance, run, 'a-terminal', nowMs + 5);
      return run;
    };

    const firstReached = settledRun(
      'selector-first',
      [
        {
          id: 'pick-first',
          phase: 'settled',
          priority: 10,
          when: { fact: 'all_nodes_terminal' },
          selector: { pick: { type: 'first_reached' } },
        },
      ],
      200,
    );
    expect(() => close(firstReached, 210, { point: 'before_commit' })).toThrow(
      /Injected fault before commit/,
    );
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
        [firstReached.graphRunId],
      )!.count,
    ).toBe(0);
    instance.closeStore();
    instance.reopenStore();
    close(firstReached, 210);
    expect(selected(firstReached)).toMatchObject({
      selected_rule_id: 'pick-first',
      node_key: 'z-terminal',
      exit_name: 'omega',
    });

    const lowest = settledRun(
      'selector-lowest',
      [
        {
          id: 'pick-lowest',
          phase: 'settled',
          priority: 10,
          when: { fact: 'all_nodes_terminal' },
          selector: { pick: { type: 'lowest_terminal_node_id' } },
        },
      ],
      300,
    );
    close(lowest, 310);
    expect(selected(lowest)).toMatchObject({
      selected_rule_id: 'pick-lowest',
      node_key: 'a-terminal',
      exit_name: 'alpha',
    });

    const exitPriority = settledRun(
      'selector-exit-priority',
      [
        {
          id: 'pick-exit-priority',
          phase: 'settled',
          priority: 10,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            pick: {
              type: 'exit_priority_then_first',
              exit_priority: ['alpha', 'omega'],
            },
          },
        },
      ],
      400,
    );
    close(exitPriority, 410);
    expect(selected(exitPriority)).toMatchObject({
      selected_rule_id: 'pick-exit-priority',
      node_key: 'a-terminal',
      exit_name: 'alpha',
    });

    const fallback = settledRun(
      'completion-fallback',
      [
        {
          id: 'high-when-false',
          phase: 'settled',
          priority: 300,
          when: {
            fact: 'candidate_count',
            exits: ['missing'],
            cmp: 'gte',
            value: 1,
          },
          selector: { pick: { type: 'first_reached' } },
        },
        {
          id: 'middle-selector-empty',
          phase: 'settled',
          priority: 200,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            exits: ['missing'],
            pick: { type: 'first_reached' },
          },
        },
        {
          id: 'low-applicable',
          phase: 'settled',
          priority: 100,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            terminal_node_ids: ['z-terminal'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ],
      500,
    );
    close(fallback, 510);
    expect(selected(fallback)).toMatchObject({
      selected_rule_id: 'low-applicable',
      node_key: 'z-terminal',
    });
    expect(
      instance.store.queryOne<{
        run_fence: number;
        scope_fence: number;
      }>(
        `SELECT r.work_fence_epoch AS run_fence,
                s.work_fence_epoch AS scope_fence
           FROM workflow_graph_runs r
           JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
          WHERE r.id = ?`,
        [fallback.graphRunId],
      ),
    ).toEqual({ run_fence: 1, scope_fence: 1 });

    const noExit = settledRun(
      'completion-no-exit',
      [
        {
          id: 'never-applicable',
          phase: 'settled',
          priority: 10,
          when: {
            fact: 'candidate_count',
            exits: ['missing'],
            cmp: 'gte',
            value: 1,
          },
          selector: { pick: { type: 'first_reached' } },
        },
      ],
      600,
    );
    expect(() => close(noExit, 610, { point: 'before_commit' })).toThrow(
      /Injected fault before commit/,
    );
    expect(
      instance.store.queryOne<{ lifecycle: string; work_fence_epoch: number }>(
        'SELECT lifecycle, work_fence_epoch FROM workflow_graph_runs WHERE id = ?',
        [noExit.graphRunId],
      ),
    ).toEqual({ lifecycle: 'executing', work_fence_epoch: 0 });
    close(noExit, 610);
    expect(selected(noExit)).toMatchObject({
      selected_rule_id: null,
      error_code: 'no_exit_selected',
      node_key: null,
    });
    expect(
      instance.store.queryAll<{ event_type: string }>(
        "SELECT event_type FROM workflow_graph_events WHERE graph_run_id = ? AND event_type IN ('orchestration_error', 'scope_close_requested') ORDER BY seq",
        [noExit.graphRunId],
      ),
    ).toEqual([
      { event_type: 'orchestration_error' },
      { event_type: 'scope_close_requested' },
    ]);

    const earlyCandidate = planVariant(seed, {
      nodes: [
        terminal('early-terminal', 'early'),
        {
          id: 'remaining-node',
          type: 'join',
          capability_binding: null,
          trigger_program: compileTriggerProgram({
            type: 'all',
            edge_ids: ['early-to-remaining'],
          }),
          input_ports: {},
        },
      ],
      route_groups: [],
      control_edges: [
        {
          id: 'early-to-remaining',
          from_node_id: 'early-terminal',
          to_node_id: 'remaining-node',
          outcome_match: { statuses: ['succeeded'] },
          condition_program: null,
          is_default: false,
          priority: null,
          route_group_id: null,
          compiled_edge_hash: hash('completion:early-to-remaining'),
        },
      ],
      data_edges: [],
      completion: completionPolicy(
        [
          {
            id: 'settled-fallback',
            phase: 'settled',
            priority: 1,
            when: { fact: 'all_nodes_terminal' },
            selector: { pick: { type: 'first_reached' } },
          },
        ],
        [
          {
            id: 'early-low',
            phase: 'early',
            priority: 10,
            when: { fact: 'candidate_count', cmp: 'gte', value: 1 },
            selector: { pick: { type: 'first_reached' } },
          },
          {
            id: 'early-high',
            phase: 'early',
            priority: 20,
            when: { fact: 'candidate_count', cmp: 'gte', value: 1 },
            selector: { pick: { type: 'first_reached' } },
          },
        ],
      ),
    });
    const early = materializePlanCase(
      instance,
      seed,
      earlyCandidate,
      'completion-early',
      700,
    );
    initializePlanCase(instance, early, 703);
    const earlyTerminal = scheduleStructuralNode(
      instance,
      early,
      'early-terminal',
      704,
    );
    reconcileTerminalNode(
      instance,
      early,
      earlyTerminal,
      'terminal:early-terminal',
      705,
    );
    expect(selected(early)).toMatchObject({
      selected_rule_id: 'early-high',
      node_key: 'early-terminal',
      exit_name: 'early',
    });
    const eligibilities = instance.store.queryAll<{
      rule_id: string;
      phase: string;
      eligibility_event_seq: number;
    }>(
      'SELECT rule_id, phase, eligibility_event_seq FROM workflow_graph_completion_eligibilities WHERE graph_run_id = ? ORDER BY rule_id',
      [early.graphRunId],
    );
    expect(eligibilities.map((row) => row.rule_id)).toEqual([
      'early-high',
      'early-low',
    ]);
    expect(
      new Set(eligibilities.map((row) => row.eligibility_event_seq)).size,
    ).toBe(1);
    expect(eligibilities[0]!.eligibility_event_seq).toBe(
      instance.store.queryOne<{ seq: number }>(
        "SELECT seq FROM workflow_graph_events WHERE graph_run_id = ? AND idempotency_key = 'terminal:early-terminal'",
        [early.graphRunId],
      )!.seq,
    );
  });

  it('applies default, all-matching, and no-match-error route groups atomically', () => {
    const instance = bootstrap('g5-route-group-modes');
    const seed = seedRuntime(instance.store);
    const node = (id: string, edgeIds: string[] = []): JsonObject => ({
      id,
      type: 'join',
      capability_binding: null,
      trigger_program:
        edgeIds.length === 0
          ? compileTriggerProgram({ type: 'root' })
          : compileTriggerProgram({ type: 'all', edge_ids: edgeIds }),
      input_ports: {},
    });
    const conditional = (
      id: string,
      source: string,
      target: string,
      group: string,
      value: boolean,
    ): JsonObject => ({
      id,
      from_node_id: source,
      to_node_id: target,
      outcome_match: { statuses: ['succeeded'] },
      condition_program: conditionProgram({
        op: 'eq',
        left: { literal: value },
        right: { literal: true },
      }),
      is_default: false,
      route_group_id: group,
      priority: group === 'all-group' ? null : 10,
      compiled_edge_hash: hash(`route-mode:${id}`),
    });
    const candidate = planVariant(seed, {
      nodes: [
        node('route-source'),
        node('error-source'),
        node('default-target', ['default-edge']),
        node('false-target', ['false-edge']),
        node('all-true-target', ['all-true']),
        node('all-false-target', ['all-false']),
        node('error-target', ['error-edge']),
      ],
      route_groups: [
        {
          id: 'default-group',
          from_node_id: 'route-source',
          mode: 'first_matching',
          no_match: 'allow',
          ordered_edge_ids: ['false-edge', 'default-edge'],
        },
        {
          id: 'all-group',
          from_node_id: 'route-source',
          mode: 'all_matching',
          no_match: 'allow',
          ordered_edge_ids: ['all-false', 'all-true'],
        },
        {
          id: 'error-group',
          from_node_id: 'error-source',
          mode: 'first_matching',
          no_match: 'error',
          ordered_edge_ids: ['error-edge'],
        },
      ],
      control_edges: [
        conditional(
          'false-edge',
          'route-source',
          'false-target',
          'default-group',
          false,
        ),
        {
          id: 'default-edge',
          from_node_id: 'route-source',
          to_node_id: 'default-target',
          condition_program: null,
          is_default: true,
          route_group_id: 'default-group',
          priority: null,
          compiled_edge_hash: hash('route-mode:default-edge'),
        },
        conditional(
          'all-true',
          'route-source',
          'all-true-target',
          'all-group',
          true,
        ),
        conditional(
          'all-false',
          'route-source',
          'all-false-target',
          'all-group',
          false,
        ),
        conditional(
          'error-edge',
          'error-source',
          'error-target',
          'error-group',
          false,
        ),
      ],
      data_edges: [],
      completion: completionPolicy([
        {
          id: 'route-mode-no-normal-close',
          phase: 'settled',
          priority: 1,
          when: { fact: 'all_nodes_terminal' },
          selector: {
            exits: ['unused'],
            pick: { type: 'lowest_terminal_node_id' },
          },
        },
      ]),
    });
    const run = materializePlanCase(
      instance,
      seed,
      candidate,
      'route-modes',
      800,
    );
    initializePlanCase(instance, run, 803);
    const source = scheduleStructuralNode(instance, run, 'route-source', 804);
    reconcileTerminalNode(instance, run, source, 'terminal:route-source', 805);
    const states = instance.store.queryAll<{ edge_key: string; state: string }>(
      `SELECT e.edge_key, r.state FROM workflow_graph_edges e
         JOIN workflow_graph_control_edge_resolutions r ON r.edge_id = e.id
        WHERE e.graph_run_id = ? AND e.edge_key <> 'error-edge'
        ORDER BY e.edge_key COLLATE BINARY`,
      [run.graphRunId],
    );
    expect(states).toEqual([
      { edge_key: 'all-false', state: 'not_taken' },
      { edge_key: 'all-true', state: 'taken' },
      { edge_key: 'default-edge', state: 'taken' },
      { edge_key: 'false-edge', state: 'not_taken' },
    ]);
    const errorSource = scheduleStructuralNode(
      instance,
      run,
      'error-source',
      806,
    );
    reconcileTerminalNode(
      instance,
      run,
      errorSource,
      'terminal:error-source',
      807,
    );
    expect(
      instance.store.queryOne<{ reason: string; error_code: string }>(
        'SELECT reason, error_code FROM workflow_graph_scope_close_requests WHERE graph_run_id = ?',
        [run.graphRunId],
      ),
    ).toEqual({
      reason: 'engine_error',
      error_code: 'fixed_point_resolution_error',
    });
  });

  it('property-compares production fixed-point rows with an independent trigger model', () => {
    const instance = bootstrap('g5-fixed-point-property-model');
    const seed = seedRuntime(instance.store);
    let caseSequence = 0;
    fc.assert(
      fc.property(
        fc.record({
          taken: fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()),
          kind: fc.constantFrom(
            'all' as const,
            'any' as const,
            'quorum' as const,
            'expression_and' as const,
            'expression_or' as const,
          ),
          minimum: fc.integer({ min: 1, max: 3 }),
        }),
        ({ taken, kind, minimum }) => {
          const current = caseSequence++;
          const edgeIds = ['edge-0', 'edge-1', 'edge-2'];
          const referenceTrigger: ReferenceTrigger =
            kind === 'all' || kind === 'any'
              ? { type: kind, edgeIds }
              : kind === 'quorum'
                ? { type: 'quorum', edgeIds, minimum }
                : {
                    type: 'expression',
                    expression: {
                      op: kind === 'expression_and' ? 'and' : 'or',
                      args: edgeIds.map((edgeId) => ({
                        op: 'edge_is' as const,
                        edgeId,
                        state: 'taken' as const,
                      })),
                    },
                  };
          const compiledTrigger =
            kind === 'all' || kind === 'any'
              ? compileTriggerProgram({
                  type: kind,
                  edge_ids: edgeIds,
                })
              : kind === 'quorum'
                ? compileTriggerProgram({
                    type: 'quorum',
                    edge_ids: edgeIds,
                    min_taken: minimum,
                  })
                : compileTriggerProgram({
                    type: 'expression',
                    expression: {
                      op: kind === 'expression_and' ? 'and' : 'or',
                      args: edgeIds.map((edgeId) => ({
                        op: 'edge_is',
                        edge_id: edgeId,
                        state: 'taken',
                      })),
                    },
                  });
          const nodes: JsonObject[] = edgeIds.map((_, index) => ({
            id: `source-${index}`,
            type: 'join',
            capability_binding: null,
            trigger_program: compileTriggerProgram({ type: 'root' }),
            input_ports: {},
          }));
          nodes.push({
            id: 'target',
            type: 'join',
            capability_binding: null,
            trigger_program: compiledTrigger,
            input_ports: {},
          });
          const controlEdges = edgeIds.map((edgeId, index) => ({
            id: edgeId,
            from_node_id: `source-${index}`,
            to_node_id: 'target',
            outcome_match: {
              statuses: [taken[index] ? 'succeeded' : 'failed'],
            },
            condition_program: null,
            is_default: false,
            priority: null,
            route_group_id: null,
            compiled_edge_hash: hash(`property:${current}:${edgeId}`),
          }));
          const candidate = planVariant(seed, {
            nodes,
            route_groups: [],
            control_edges: controlEdges,
            data_edges: [],
            completion: completionPolicy([
              {
                id: 'property-no-close',
                phase: 'settled',
                priority: 1,
                when: { fact: 'all_nodes_terminal' },
                selector: {
                  exits: ['unused'],
                  pick: { type: 'lowest_terminal_node_id' },
                },
              },
            ]),
          });
          const run = materializePlanCase(
            instance,
            seed,
            candidate,
            `property-${current}`,
            1_000 + current * 20,
          );
          initializePlanCase(instance, run, 1_003 + current * 20);
          edgeIds.forEach((_, index) => {
            const terminalNode = scheduleStructuralNode(
              instance,
              run,
              `source-${index}`,
              1_004 + current * 20 + index * 2,
            );
            reconcileTerminalNode(
              instance,
              run,
              terminalNode,
              `property:${current}:terminal:source-${index}`,
              1_005 + current * 20 + index * 2,
            );
          });
          const resolutions = Object.fromEntries(
            edgeIds.map((edgeId, index) => [
              edgeId,
              taken[index] ? ('taken' as const) : ('not_taken' as const),
            ]),
          );
          const expectedTruth = evaluateReferenceTrigger(
            referenceTrigger,
            resolutions,
          );
          expect(expectedTruth).not.toBe('unknown');
          const targetRow = instance.store.queryOne<{
            id: string;
            phase: string;
            trigger_state: string;
            terminal_status: string | null;
          }>(
            "SELECT id, phase, trigger_state, terminal_status FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'target'",
            [run.graphRunId],
          )!;
          const expectedKeys =
            expectedTruth === 'true'
              ? [
                  `input-sealed:${targetRow.id}`,
                  `node-ready:${targetRow.id}`,
                  `trigger-decided:${targetRow.id}`,
                ]
              : [
                  `node-skipped:${targetRow.id}`,
                  `trigger-decided:${targetRow.id}`,
                ];
          expect(targetRow).toMatchObject(
            expectedTruth === 'true'
              ? { phase: 'ready', trigger_state: 'true', terminal_status: null }
              : {
                  phase: 'terminal',
                  trigger_state: 'false',
                  terminal_status: 'skipped',
                },
          );
          const factKeys = instance.store
            .queryAll<{
              fact_key: string;
            }>(
              'SELECT fact_key FROM workflow_graph_facts WHERE graph_run_id = ? AND stable_object_id = ? ORDER BY fact_key COLLATE BINARY',
              [run.graphRunId, targetRow.id],
            )
            .map((row) => row.fact_key);
          const eventKeys = instance.store
            .queryAll<{
              idempotency_key: string;
            }>(
              'SELECT idempotency_key FROM workflow_graph_events WHERE graph_run_id = ? AND node_id = ? ORDER BY idempotency_key COLLATE BINARY',
              [run.graphRunId, targetRow.id],
            )
            .map((row) => row.idempotency_key);
          expect(factKeys).toEqual(expectedKeys);
          expect(eventKeys).toEqual(expectedKeys);
          const factCount = instance.store.queryOne<{ count: number }>(
            'SELECT count(*) AS count FROM workflow_graph_facts WHERE graph_run_id = ?',
            [run.graphRunId],
          )!.count;
          expect(
            instance.store.queryOne<{ consumed_amount: number }>(
              "SELECT consumed_amount FROM workflow_graph_resource_accounts WHERE graph_run_id = ? AND resource_type = 'facts_total'",
              [run.graphRunId],
            )!.consumed_amount,
          ).toBe(factCount);
          expect(
            instance.store.queryOne<{ count: number }>(
              'SELECT count(*) AS count FROM workflow_operational_blockers WHERE graph_run_id = ?',
              [run.graphRunId],
            )!.count,
          ).toBe(0);
        },
      ),
      { seed: 0x73a5, numRuns: 12 },
    );
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
