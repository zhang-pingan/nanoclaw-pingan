import fs from 'node:fs';
import path from 'node:path';

import fc from 'fast-check';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type {
  CompiledScopePlanV2Document,
  CompiledStaticChildPlanClosureMemberV1,
} from '../contracts/compiler-contract-repair-types.js';
import {
  COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
  STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
  STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
} from '../contracts/compiler-contract-repair-source.js';
import type { WorkflowCompilerStaticChildPlanBundle } from '../contracts/static-child-plan-bundle-types.js';
import {
  buildDeploymentCapacityPublication,
  calculateDeploymentCapacityConfigHash,
} from '../contracts/capacity-control-plane-source.js';
import type {
  DeploymentRuntimeCapacitySnapshot,
  ReplaceDeploymentCapacityCommand,
} from '../contracts/capacity-control-plane-types.js';
import {
  CAPABILITY_OUTBOX_ADAPTER_DOMAIN,
  CAPABILITY_OUTBOX_EXECUTION_BINDING_DOMAIN,
  CAPABILITY_OUTBOX_POLICY_DOMAIN,
  capabilityOutboxPolicySnapshotHash,
} from '../contracts/capability-outbox-binding-contract.js';
import { registryResourceId } from '../contracts/g3-registry-persistence.js';
import type { G3RegistryResourceType } from '../contracts/g3-registry-persistence-types.js';
import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import {
  G5_REPAIR_FAULT_FIXTURES,
  G5_REPAIR_NEGATIVE_FIXTURES,
  G5_REPAIR_POSITIVE_FIXTURES,
  type G5RepairFixtureCase,
  type G5RepairFixtureOracle,
} from '../contracts/g5-basic-runtime-repair-contract.js';
import { buildDeploymentRuntimeCapacityBaseline } from '../contracts/safety-sqlite-artifacts.js';
import {
  G5FixtureExecutionHarness,
  type G5FixtureArtifacts,
  type G5FixtureHandler,
} from '../contracts/g5-basic-runtime-fixture-harness.js';
import {
  buildGeneratedSchema,
  buildNodeOutputEnvelopeSchema,
} from '../contracts/generated-schema-authority.js';
import {
  evaluateReferenceInputContract,
  evaluateReferenceTrigger,
  G5BasicRuntimeReferenceModel,
  type ReferenceTrigger,
} from '../contracts/g5-basic-runtime-reference-model.js';
import { referenceJoinPublication } from '../contracts/g5-basic-runtime-repair-reference-model.js';
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
import { acquireCurrentDomainClaim } from '../creation/domain-claims.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  NodeOutputEnvelopeAuthorityError,
  NodeOutputEnvelopeValueStore,
  nodeOutputMemberProvenanceRef,
  type NodeOutputEnvelopeValue,
} from '../store/node-output-envelope-value-store.js';
import {
  prepareCapacityChangeCAP0CAP1,
  type CapacityAuthenticatedInvocation,
} from '../capacity/admin-gateway.js';
import {
  CapacitySnapshotPublisher,
  CapacitySnapshotWatcher,
  recoverCapacityPublication,
} from '../capacity/publication.js';
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
import { G5RuntimeError, stableRuntimeId } from './graph-store.js';
import {
  createG5TestBootstrap,
  type G5TestBootstrapInstance,
} from './g5-test-bootstrap.js';

const instances: G5TestBootstrapInstance[] = [];
const hash = (label: string): Sha256Hash =>
  domainSeparatedSha256('icarus:g5-runtime-test:1\n', { label });
const EMPTY_STATIC_CHILD_PLAN_BUNDLE: WorkflowCompilerStaticChildPlanBundle = {
  format: 'icarus.workflow-compiler-static-child-plan-bundle/1',
  entries: [],
};

function g5FenceManifestSchema() {
  const ref = { id: 'g5.schema', version: '1.0.0' };
  return {
    rowId: registryResourceId({ resource_type: 'schema', ref }),
    resourceType: 'schema',
    ref,
    hash: hash('resource:schema'),
  };
}

function bootstrap(key: string): G5TestBootstrapInstance {
  const instance = createG5TestBootstrap(key);
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
      const content = canonicalJson(
        name === 'definition'
          ? {
              compiled_plan_pin: {
                plan_hash: pinnedPlan.plan_hash,
                plan_format: pinnedPlan.format,
                compiler_version: pinnedPlan.compiler_version,
                provenance: 'golden_corpus',
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
         owner_pack_id, canonical_value_id, content_hash, publication_state,
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
      const content = canonicalJson(
        name === 'input'
          ? {
              port_contract_hash: hash('scope-input-port-contract'),
              ports: {
                result: {
                  state: 'present',
                  value_ref: values.result.id,
                  value_hash: values.result.hash,
                  schema_hash: refs.schema.hash,
                  byte_length: Buffer.byteLength(
                    canonicalJson({ name: 'result' }),
                  ),
                },
              },
              envelope_hash: hash('scope-input-envelope'),
            }
          : name === 'ingressAuthorization'
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
       created_at_ms
     ) VALUES (?, ?, ?, ?, ?, 1)`,
      [
        snapshotId,
        snapshotHash,
        closureId,
        closureHash,
        WORKFLOW_COMPILER_VERSION,
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
         owner_pack_id, canonical_value_id, content_hash, publication_state,
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

function runtimeResultOutput(seed: SeededRuntime): JsonObject {
  return {
    result: {
      schema: {
        type: 'registry',
        ref: seed.refs.schema.ref,
        schema_hash: seed.refs.schema.hash,
      },
      max_bytes: null,
      required: true,
    },
  };
}

function waitResolutionOutput(seed: SeededRuntime): JsonObject {
  return {
    resolution: {
      schema: {
        type: 'registry',
        ref: seed.refs.schema.ref,
        schema_hash: seed.refs.schema.hash,
      },
      max_bytes: null,
      required: true,
    },
  };
}

function currentFixtureNodes(nodes: readonly JsonObject[]): JsonObject[] {
  return nodes.map((node) => {
    const outputPorts = (node.output_ports ?? {}) as JsonObject;
    return {
      ...node,
      output_ports: outputPorts,
      output_envelope_schema: buildNodeOutputEnvelopeSchema(
        String(node.id),
        outputPorts,
      ),
    };
  });
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
    compiler_version: WORKFLOW_COMPILER_VERSION,
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
        output_ports: runtimeResultOutput(seed),
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
        output_ports: runtimeResultOutput(seed),
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
        output_ports: runtimeResultOutput(seed),
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
        output_ports: waitResolutionOutput(seed),
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
        expose: { result: { input_port: 'value' } },
        output_ports: {
          result: {
            schema: buildGeneratedSchema(
              'join_expose',
              {
                node_id: 'join',
                output_port: 'result',
                input_port: 'value',
                input_schema: {
                  type: 'registry',
                  ref: seed.refs.schema.ref,
                  schema_hash: seed.refs.schema.hash,
                },
                aggregation: {
                  type: 'single',
                  select: 'only',
                  required: true,
                },
                max_bytes: null,
                required: true,
              },
              {},
            ),
            max_bytes: null,
            required: true,
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
        output_ports: {},
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
    static_child_plan_closure: emptyStaticChildPlanClosure(),
    effective_limits: {},
    effective_usage_budget: {},
    runtime_safety_snapshot: {
      value: { max_single_value_bytes: 16_777_216 },
    },
    runtime_safety_hash: seed.values.safety.hash,
  } as Omit<CompiledScopePlanV2Document, 'plan_hash'>;
  return withPlanHash(withoutHash);
}

function emptyStaticChildPlanClosure() {
  const withoutHash = { members: [], member_count: 0 };
  return {
    ...withoutHash,
    closure_hash: domainSeparatedSha256(
      STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
      withoutHash,
    ),
  };
}

function staticChildClosureMember(input: {
  closureKey: string;
  scopeKey: string;
  source: JsonObject;
  plan: CompiledScopePlanV2Document;
}): CompiledStaticChildPlanClosureMemberV1 {
  const ownerNodePath = input.closureKey.split('/');
  const withoutHash = {
    closure_key: input.closureKey,
    parent_closure_key:
      ownerNodePath.length === 1 ? null : ownerNodePath.slice(0, -1).join('/'),
    scope_key: input.scopeKey,
    owner_node_path: ownerNodePath,
    factory_kind: 'inline' as const,
    source_ref: null,
    source_hash: domainSeparatedSha256(
      'icarus:workflow-graph-source:1\n',
      input.source,
    ),
    plan_ref: `content-addressed:workflow-plan/${input.plan.plan_hash.slice('sha256:'.length)}`,
    plan_hash: input.plan.plan_hash as Sha256Hash,
    interface_snapshot_hash: input.plan.interface_snapshot_hash as Sha256Hash,
  };
  return {
    ...withoutHash,
    member_hash: domainSeparatedSha256(
      STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
      withoutHash,
    ),
  };
}

function staticChildClosure(members: CompiledStaticChildPlanClosureMemberV1[]) {
  const withoutHash = { members, member_count: members.length };
  return {
    ...withoutHash,
    closure_hash: domainSeparatedSha256(
      STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
      withoutHash,
    ),
  };
}

function planWithSourceAndClosure(
  seed: SeededRuntime,
  source: JsonObject,
  members: ReturnType<typeof staticChildClosureMember>[],
): CompiledScopePlanV2Document {
  const { plan_hash: _planHash, ...withoutHash } = plan(seed);
  void _planHash;
  return withPlanHash({
    ...withoutHash,
    source_hash: domainSeparatedSha256(
      'icarus:workflow-graph-source:1\n',
      source,
    ),
    static_child_plan_closure: staticChildClosure(members),
  });
}

function staticChildBundleFixture(seed: SeededRuntime): {
  parentPlan: CompiledScopePlanV2Document;
  bundle: WorkflowCompilerStaticChildPlanBundle;
  uniqueChildPlanHashes: string[];
} {
  const leafSource: JsonObject = {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: 'shared_leaf',
  };
  const nestedSource: JsonObject = {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: 'nested_child',
  };
  const leafPlan = planWithSourceAndClosure(seed, leafSource, []);
  const aLeaf = staticChildClosureMember({
    closureKey: 'a/leaf',
    scopeKey: 'shared_leaf',
    source: leafSource,
    plan: leafPlan,
  });
  const bLeaf = staticChildClosureMember({
    closureKey: 'b/leaf',
    scopeKey: 'shared_leaf',
    source: leafSource,
    plan: leafPlan,
  });
  const aPlan = planWithSourceAndClosure(seed, nestedSource, [aLeaf]);
  const bPlan = planWithSourceAndClosure(seed, nestedSource, [bLeaf]);
  const a = staticChildClosureMember({
    closureKey: 'a',
    scopeKey: 'nested_child',
    source: nestedSource,
    plan: aPlan,
  });
  const b = staticChildClosureMember({
    closureKey: 'b',
    scopeKey: 'nested_child',
    source: nestedSource,
    plan: bPlan,
  });
  const parentPlan = planWithSourceAndClosure(seed, G5_TEST_SOURCE, [
    a,
    aLeaf,
    b,
    bLeaf,
  ]);
  return {
    parentPlan,
    bundle: {
      format: 'icarus.workflow-compiler-static-child-plan-bundle/1',
      entries: [
        { closureKey: 'a', source: nestedSource, plan: aPlan },
        { closureKey: 'a/leaf', source: leafSource, plan: leafPlan },
        { closureKey: 'b', source: nestedSource, plan: bPlan },
        { closureKey: 'b/leaf', source: leafSource, plan: leafPlan },
      ],
    },
    uniqueChildPlanHashes: [
      aPlan.plan_hash,
      bPlan.plan_hash,
      leafPlan.plan_hash,
    ],
  };
}

function withPlanHash(
  value: Omit<CompiledScopePlanV2Document, 'plan_hash'>,
): CompiledScopePlanV2Document {
  const current = {
    ...value,
    nodes: currentFixtureNodes(value.nodes as JsonObject[]),
  } as Omit<CompiledScopePlanV2Document, 'plan_hash'>;
  return {
    ...current,
    plan_hash: domainSeparatedSha256(
      COMPILED_PLAN_V2_DOMAIN_SEPARATOR,
      current as JsonObject,
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
      compiler_version: candidate.compiler_version,
      provenance: 'golden_corpus',
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
  instance: G5TestBootstrapInstance,
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
    actor: 'system',
    launchPolicy: 'auto',
    launchAuthorization: {
      kind: 'trusted_system',
      authorizationRef: `test:${caseId}`,
    },
    entryPoint: 'default',
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
    expectedBuildLease: null,
    sourceJson: G5_TEST_SOURCE,
    sourceHash: candidate.source_hash as Sha256Hash,
    plan: candidate,
    staticChildPlanBundle: EMPTY_STATIC_CHILD_PLAN_BUNDLE,
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
  return buildDeploymentCapacityPublication(
    1,
    'capacity-defaults-change:1',
    null,
    buildDeploymentRuntimeCapacityBaseline() as DeploymentRuntimeCapacitySnapshot,
  );
}

function installFixtureRuntimeCapacity(
  instance: G5TestBootstrapInstance,
  _seed: SeededRuntime,
): void {
  if (
    !instance.store.queryOne(
      'SELECT 1 AS present FROM runtime_capacity_head WHERE singleton_key = 1',
      [],
    )
  ) {
    throw new Error('fresh Store Capacity defaults are missing');
  }
}

function initializePlanCase(
  instance: G5TestBootstrapInstance,
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
      manifestSchema: g5FenceManifestSchema(),
      nowMs,
    },
    fault,
  );
}

function scheduleStructuralNode(
  instance: G5TestBootstrapInstance,
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
  instance: G5TestBootstrapInstance,
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
      manifestSchema: g5FenceManifestSchema(),
      terminalStatus: 'succeeded',
      nowMs,
    },
    fault,
  );
}

function verifyPublishedNodeOutputEnvelope(
  instance: G5TestBootstrapInstance,
  graphRunId: string,
  plan: CompiledScopePlanV2Document,
  nodeKey: string,
): NodeOutputEnvelopeValue {
  const row = instance.store.queryOne<{
    plan_id: string;
    node_id: string;
    value_id: string;
  }>(
    `SELECT p.id AS plan_id, n.id AS node_id,
            n.published_output_envelope_value_id AS value_id
       FROM workflow_graph_scope_plans p
       JOIN workflow_graph_nodes n ON n.graph_run_id = p.graph_run_id
      WHERE p.graph_run_id = ? AND p.plan_hash = ? AND n.node_key = ?`,
    [graphRunId, plan.plan_hash, nodeKey],
  )!;
  return new NodeOutputEnvelopeValueStore(instance.store).read({
    planId: row.plan_id,
    graphRunId,
    planHash: plan.plan_hash as Sha256Hash,
    nodeId: nodeKey,
    valueId: row.value_id,
  });
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

interface ProductionFixtureTarget {
  readonly instance: G5TestBootstrapInstance;
  readonly relation: string;
  invoke(fault: boolean): string;
  replay?(): string;
  verifyAfterReopen?(): void;
}

class ObservedFixtureRejection extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function fixtureObject(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new Error(`${label} must be an object`);
  return value;
}

function fixtureString(value: JsonValue, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function fixtureNumber(value: JsonValue, label: string): number {
  if (!Number.isSafeInteger(value))
    throw new Error(`${label} must be a safe integer`);
  return value as number;
}

function fixtureBoolean(value: JsonValue, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function fixtureBehavior(fixture: G5RepairFixtureCase): {
  readonly behavior: string;
  readonly relation: string;
  readonly key: string;
  readonly nowMs: number;
} {
  const input = fixture.operation.input;
  const payload = fixtureObject(input.payload, 'fixture payload');
  if (
    payload.operation !== fixture.operation.kind ||
    input.expected_surface !== fixture.surface ||
    fixture.operation.transaction !== fixture.surface
  )
    throw new Error(`${fixture.case_id} production operation binding drifted`);
  const behavior = fixtureString(payload.behavior, 'fixture behavior');
  if (behavior === fixture.case_id)
    throw new Error(`${fixture.case_id} behavior cannot alias its case id`);
  const fixtureToken = fixtureString(input.fixture_token, 'fixture token');
  const idempotencyKey = fixtureString(
    input.idempotency_key,
    'idempotency key',
  );
  return {
    behavior,
    relation: fixtureString(payload.durable_relation, 'durable relation'),
    key: domainSeparatedSha256('icarus:workflow-g5-fixture-input-key:1\n', {
      fixture_token: fixtureToken,
      idempotency_key: idempotencyKey,
    }),
    nowMs: fixtureNumber(input.now_ms, 'now_ms'),
  };
}

function transactionFixtureFault(
  fixture: G5RepairFixtureCase,
  enabled: boolean,
): { readonly point: 'before_commit' } | undefined {
  if (!enabled) return undefined;
  const fault = fixtureObject(fixture.operation.fault, 'fixture fault');
  if (fault.boundary !== fixture.surface || fault.point !== 'before_commit')
    throw new Error(`${fixture.case_id} transaction fault binding drifted`);
  return { point: fault.point };
}

function requireFixtureFaultPoint(
  fixture: G5RepairFixtureCase,
  expected: string,
): void {
  const fault = fixtureObject(fixture.operation.fault, 'fixture fault');
  if (fault.boundary !== fixture.surface || fault.point !== expected)
    throw new Error(`${fixture.case_id} fault point is not ${expected}`);
}

function relationFingerprint(
  instance: G5TestBootstrapInstance,
  relation: string,
): Sha256Hash {
  if (!/^[a-z][a-z0-9_]*$/.test(relation))
    throw new Error(`invalid fixture relation ${relation}`);
  const exists = instance.store.queryOne<{ count: number }>(
    "SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = ?",
    [relation],
  );
  if (exists?.count !== 1)
    throw new Error(`fixture relation ${relation} does not exist`);
  const rows = instance.store.queryAll<Record<string, JsonValue>>(
    `SELECT * FROM ${relation} ORDER BY rowid`,
    [],
  );
  return domainSeparatedSha256(
    'icarus:workflow-g5-fixture-relation-state:1\n',
    { relation, rows },
  );
}

function databaseFingerprint(instance: G5TestBootstrapInstance): Sha256Hash {
  const tables = instance.store.queryAll<{ name: string }>(
    `SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name COLLATE BINARY`,
    [],
  );
  const state: JsonObject = {};
  for (const { name } of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(name))
      throw new Error(`invalid Schema 11 table name ${name}`);
    const columns = instance.store.queryAll<{ name: string }>(
      `PRAGMA table_info(${name})`,
      [],
    );
    const order = columns
      .map((column) => `"${column.name.replaceAll('"', '""')}"`)
      .join(', ');
    state[name] = instance.store.queryAll<Record<string, JsonValue>>(
      `SELECT * FROM ${name}${order.length > 0 ? ` ORDER BY ${order}` : ''}`,
      [],
    );
  }
  return domainSeparatedSha256(
    'icarus:workflow-g5-fixture-database-state:1\n',
    state,
  );
}

function creationInput(seed: SeededRuntime, key: string, nowMs: number) {
  return {
    requestId: `request:${key}`,
    creationDomain: 'assistant',
    creationKey: key,
    source: 'api' as const,
    actor: 'system' as const,
    launchPolicy: 'auto' as const,
    launchAuthorization: {
      kind: 'trusted_system' as const,
      authorizationRef: `test:${key}`,
    },
    entryPoint: 'default',
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
    creationIntentHash: directCreationIntentHash(seed, 'assistant', key),
    workflowDefinitionVersion: '1.0.0',
    recipeVersion: '1.0.0',
    deadlineAtMs: null,
    resourceLimits: {
      state_activations_total: 8,
      graph_runs_total: 8,
      descendant_workflows_total: 8,
    },
    domainClaims: [
      {
        namespace: 'workspace',
        keyHash: hash(`claim:${key}`),
        mode: 'exclusive' as const,
      },
    ],
    initialActivation: initialActivation(seed, nowMs),
    nowMs,
  };
}

function compilePrefix(fixture: G5RepairFixtureCase): {
  readonly instance: G5TestBootstrapInstance;
  readonly seed: SeededRuntime;
  readonly candidate: CompiledScopePlanV2Document;
  readonly created: ReturnType<typeof createWorkflowT0>;
  readonly input: Parameters<typeof persistCompileResultT2a>[1];
} {
  const { key, nowMs } = fixtureBehavior(fixture);
  const instance = bootstrap(fixture.operation.scenario_key);
  const seed = seedRuntime(instance.store);
  const candidate = plan(seed);
  pinTestDefinitionPlan(instance.store, seed, candidate);
  const created = createWorkflowT0(
    instance.store,
    creationInput(seed, `${key}:prefix`, nowMs),
  );
  return {
    instance,
    seed,
    candidate,
    created,
    input: {
      graphRunId: created.activation.graphRunId,
      buildId: created.activation.rootBuildId,
      expectedBuildRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedOwnerScopeWorkFenceEpoch: 0,
      expectedCompilerSnapshotHash: hash('compiler-snapshot'),
      expectedBuildLease: null,
      sourceJson: G5_TEST_SOURCE,
      sourceHash: candidate.source_hash as Sha256Hash,
      plan: candidate,
      staticChildPlanBundle: EMPTY_STATIC_CHILD_PLAN_BUNDLE,
      nowMs: nowMs + 1,
    },
  };
}

function materializePrefix(fixture: G5RepairFixtureCase): {
  readonly instance: G5TestBootstrapInstance;
  readonly seed: SeededRuntime;
  readonly candidate: CompiledScopePlanV2Document;
  readonly created: ReturnType<typeof createWorkflowT0>;
  readonly input: Parameters<typeof materializeRootScopeT2b>[1];
} {
  const prefix = compilePrefix(fixture);
  const compiled = persistCompileResultT2a(prefix.instance.store, prefix.input);
  const run = prefix.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [prefix.created.activation.graphRunId],
  )!;
  return {
    ...prefix,
    input: {
      graphRunId: prefix.created.activation.graphRunId,
      buildId: prefix.created.activation.rootBuildId,
      rootScopeId: prefix.created.activation.rootScopeId,
      expectedBuildRowVersion: 2,
      expectedRunRowVersion: run.row_version,
      expectedScopeRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      planId: compiled.planId,
      plan: prefix.candidate,
      inputSnapshot: prefix.seed.values.input,
      nowMs: prefix.input.nowMs + 1,
    },
  };
}

function fixedPointPrefix(fixture: G5RepairFixtureCase): {
  readonly instance: G5TestBootstrapInstance;
  readonly seed: SeededRuntime;
  readonly candidate: CompiledScopePlanV2Document;
  readonly created: ReturnType<typeof createWorkflowT0>;
  readonly input: Parameters<typeof initializeScopeFixedPointT3a>[1];
} {
  const prefix = materializePrefix(fixture);
  materializeRootScopeT2b(prefix.instance.store, prefix.input);
  const run = prefix.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
    [prefix.created.activation.graphRunId],
  )!;
  return {
    ...prefix,
    input: {
      graphRunId: prefix.created.activation.graphRunId,
      scopeId: prefix.created.activation.rootScopeId,
      expectedRunRowVersion: run.row_version,
      manifestSchema: g5FenceManifestSchema(),
      nowMs: prefix.input.nowMs + 1,
    },
  };
}

function buildT0FixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, key, nowMs } = fixtureBehavior(fixture);
  const instance = bootstrap(fixture.operation.scenario_key);
  const seed = seedRuntime(instance.store);
  const candidate = plan(seed);
  pinTestDefinitionPlan(instance.store, seed, candidate);
  const input = creationInput(seed, key, nowMs);
  if (behavior === 'conflicting_valid_creation_intent') {
    createWorkflowT0(instance.store, input);
    return {
      instance,
      relation,
      invoke: () => {
        createWorkflowT0(instance.store, {
          ...input,
          input: seed.values.result,
          creationIntentHash: calculateCreationIntentHash({
            creationDomain: input.creationDomain,
            creationKey: input.creationKey,
            principalRef: input.principalRef,
            ownershipHash: input.ownershipHash,
            routingScope: input.routingScope,
            recipe: input.recipe,
            entryPoint: 'default',
            inputHash: seed.values.result.hash,
            attachmentManifestHash: input.attachments.hash,
          }),
          nowMs: nowMs + 1,
        });
        return 'unexpected';
      },
    };
  }
  return {
    instance,
    relation,
    invoke: (fault) =>
      createWorkflowT0(
        instance.store,
        input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
    replay: () =>
      createWorkflowT0(instance.store, { ...input, nowMs: nowMs + 1 })
        .disposition,
  };
}

function buildT1FixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, key, nowMs } = fixtureBehavior(fixture);
  if (behavior !== 'stale_workflow_row_version') {
    const instance = bootstrap(fixture.operation.scenario_key);
    const seed = seedRuntime(instance.store);
    const candidate = plan(seed);
    pinTestDefinitionPlan(instance.store, seed, candidate);
    const input = creationInput(seed, key, nowMs);
    return {
      instance,
      relation,
      invoke: (fault) =>
        createWorkflowT0(
          instance.store,
          input,
          transactionFixtureFault(fixture, fault),
        ).activation.disposition,
    };
  }
  const instance = bootstrap(fixture.operation.scenario_key);
  const seed = seedRuntime(instance.store);
  const candidate = plan(seed);
  pinTestDefinitionPlan(instance.store, seed, candidate);
  const created = createWorkflowT0(
    instance.store,
    creationInput(seed, `${key}:prefix`, nowMs),
  );
  const workflow = instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflows WHERE id = ?',
    [created.workflowId],
  )!;
  const input = {
    ...initialActivation(seed, nowMs + 1),
    workflowId: created.workflowId,
    expectedWorkflowRowVersion:
      behavior === 'stale_workflow_row_version'
        ? workflow.row_version - 1
        : workflow.row_version,
    stateKey: `fixture:${key}`,
  };
  return {
    instance,
    relation,
    invoke: (fault) =>
      activateWorkflowT1(
        instance.store,
        input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
  };
}

function buildT2aFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation } = fixtureBehavior(fixture);
  const prefix = compilePrefix(fixture);
  const input =
    behavior === 'stale_build_row_version'
      ? { ...prefix.input, expectedBuildRowVersion: 0 }
      : prefix.input;
  return {
    instance: prefix.instance,
    relation,
    invoke: (fault) =>
      persistCompileResultT2a(
        prefix.instance.store,
        input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
    replay: () =>
      persistCompileResultT2a(prefix.instance.store, prefix.input).disposition,
  };
}

function buildT2bFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation } = fixtureBehavior(fixture);
  const prefix = materializePrefix(fixture);
  if (behavior === 'paused_run_control')
    prefix.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        "UPDATE workflow_graph_runs SET control = 'paused' WHERE id = ?",
        [prefix.created.activation.graphRunId],
      );
    });
  return {
    instance: prefix.instance,
    relation,
    invoke: (fault) =>
      materializeRootScopeT2b(
        prefix.instance.store,
        prefix.input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
    replay: () =>
      materializeRootScopeT2b(prefix.instance.store, prefix.input).disposition,
  };
}

function buildT3aFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, key, nowMs } = fixtureBehavior(fixture);
  const prefix = fixedPointPrefix(fixture);
  if (behavior === 'conflicting_fact_payload') {
    initializeScopeFixedPointT3a(prefix.instance.store, prefix.input);
    const run = prefix.instance.store.queryOne<{ row_version: number }>(
      'SELECT row_version FROM workflow_graph_runs WHERE id = ?',
      [prefix.created.activation.graphRunId],
    )!;
    const factInput: Parameters<typeof reconcileFactT3a>[1] = {
      graphRunId: prefix.created.activation.graphRunId,
      scopeId: prefix.created.activation.rootScopeId,
      expectedRunRowVersion: run.row_version,
      factKind: 'orchestration_error',
      stableObjectKind: 'scope',
      stableObjectId: prefix.created.activation.rootScopeId,
      factKey: `fixture-fact:${key}`,
      payload: prefix.seed.values.input,
      manifestSchema: g5FenceManifestSchema(),
      terminalStatus: undefined,
      nowMs: nowMs + 10,
    };
    reconcileFactT3a(prefix.instance.store, factInput);
    return {
      instance: prefix.instance,
      relation,
      invoke: () => {
        reconcileFactT3a(prefix.instance.store, {
          ...factInput,
          payload: prefix.seed.values.result,
          expectedRunRowVersion: prefix.instance.store.queryOne<{
            row_version: number;
          }>('SELECT row_version FROM workflow_graph_runs WHERE id = ?', [
            prefix.created.activation.graphRunId,
          ])!.row_version,
          nowMs: nowMs + 11,
        });
        return 'unexpected';
      },
    };
  }
  return {
    instance: prefix.instance,
    relation,
    invoke: (fault) => {
      initializeScopeFixedPointT3a(
        prefix.instance.store,
        prefix.input,
        transactionFixtureFault(fixture, fault),
      );
      return 'initialized';
    },
  };
}

function prepareSettledCloseTarget(fixture: G5RepairFixtureCase): {
  readonly instance: G5TestBootstrapInstance;
  readonly seed: SeededRuntime;
  readonly run: MaterializedPlanCase;
  readonly input: Parameters<typeof requestSettledCloseT3b>[1];
} {
  const { key, nowMs } = fixtureBehavior(fixture);
  const instance = bootstrap(fixture.operation.scenario_key);
  const seed = seedRuntime(instance.store);
  const candidate = planVariant(seed, {
    nodes: [
      {
        id: 'done',
        type: 'terminal',
        capability_binding: null,
        exit: 'done',
        trigger_program: compileTriggerProgram({ type: 'root' }),
        input_ports: {},
        output_ports: {},
      },
    ],
    route_groups: [],
    control_edges: [],
    data_edges: [],
    completion: completionPolicy([
      {
        id: 'fixture-settled-exit',
        phase: 'settled',
        priority: 1,
        when: { fact: 'all_nodes_terminal' },
        selector: {
          exits: ['done'],
          pick: { type: 'lowest_terminal_node_id' },
        },
      },
    ]),
  });
  const run = materializePlanCase(instance, seed, candidate, key, nowMs);
  initializePlanCase(instance, run, nowMs + 3);
  const terminal = scheduleStructuralNode(instance, run, 'done', nowMs + 4);
  reconcileTerminalNode(
    instance,
    run,
    terminal,
    `fixture-terminal:${key}`,
    nowMs + 5,
  );
  const rows = instance.store.queryOne<{
    run_row_version: number;
    scope_row_version: number;
  }>(
    `SELECT r.row_version AS run_row_version,
            s.row_version AS scope_row_version
       FROM workflow_graph_runs r
       JOIN workflow_graph_scopes s ON s.id = r.root_scope_id
      WHERE r.id = ?`,
    [run.graphRunId],
  )!;
  return {
    instance,
    seed,
    run,
    input: {
      graphRunId: run.graphRunId,
      scopeId: run.scopeId,
      expectedRunRowVersion: rows.run_row_version,
      expectedScopeRowVersion: rows.scope_row_version,
      manifestSchema: g5FenceManifestSchema(),
      nowMs: nowMs + 6,
    },
  };
}

function buildT3bFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { relation } = fixtureBehavior(fixture);
  const target = prepareSettledCloseTarget(fixture);
  return {
    instance: target.instance,
    relation,
    invoke: (fault) =>
      requestSettledCloseT3b(
        target.instance.store,
        target.input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
  };
}

function buildT0pFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { relation, key, nowMs } = fixtureBehavior(fixture);
  const target = prepareSettledCloseTarget(fixture);
  const closed = requestSettledCloseT3b(target.instance.store, target.input);
  const lineage = target.instance.store.queryOne<{
    workflow_id: string;
    state_instance_id: string;
  }>(
    'SELECT workflow_id, state_instance_id FROM workflow_graph_runs WHERE id = ?',
    [target.run.graphRunId],
  )!;
  const transitionEffectId = `required-child:${key}`;
  const creationDomain = `parent_workflow_lineage:${lineage.workflow_id}`;
  const creationKey = domainSeparatedSha256(
    'icarus:child-workflow-creation-key:1\n',
    {
      parent_workflow_id: lineage.workflow_id,
      source_state_instance_id: lineage.state_instance_id,
      source_close_request_id: closed.closeRequestId,
      transition_effect_id: transitionEffectId,
    },
  );
  const input: Parameters<typeof prepareRequiredFinalizationT0p>[1] = {
    workflowId: lineage.workflow_id,
    sourceStateInstanceId: lineage.state_instance_id,
    sourceRunId: target.run.graphRunId,
    rootScopeId: target.run.scopeId,
    closeRequestId: closed.closeRequestId,
    transitionEffectId,
    recipe: target.seed.refs.recipe,
    definition: target.seed.refs.definition,
    executionPolicy: target.seed.refs.executionPolicy,
    routingScope: target.seed.refs.routingScope,
    finalizationPolicy: target.seed.refs.finalizationPolicy,
    principalRef: 'human:local-owner',
    principalHash: hash('principal:local-owner'),
    input: target.seed.values.input,
    attachments: target.seed.values.attachments,
    routingDecision: target.seed.values.routing,
    creationIntentHash: calculateCreationIntentHash({
      creationDomain,
      creationKey,
      principalRef: 'human:local-owner',
      ownershipHash: hash('ownership'),
      routingScope: target.seed.refs.routingScope,
      recipe: target.seed.refs.recipe,
      entryPoint: 'default',
      inputHash: target.seed.values.input.hash,
      attachmentManifestHash: target.seed.values.attachments.hash,
    }),
    runtimeSafetyHash: target.seed.values.safety.hash,
    maxAttempts: 3,
    deadlineAtMs: nowMs + 10_000,
    nowMs: nowMs + 7,
  };
  return {
    instance: target.instance,
    relation,
    invoke: (fault) =>
      prepareRequiredFinalizationT0p(
        target.instance.store,
        input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
    replay: () =>
      prepareRequiredFinalizationT0p(target.instance.store, {
        ...input,
        nowMs: input.nowMs + 1,
      }).disposition,
  };
}

function assertReferenceNodeOutputPort(input: {
  readonly caseId: string;
  readonly modeledPort: JsonObject;
  readonly planContract: JsonObject;
  readonly actualPort: JsonObject;
}): void {
  const schema = fixtureObject(
    input.planContract.schema as JsonValue,
    `${input.caseId} output schema`,
  );
  if (
    input.modeledPort.state === 'absent' &&
    input.planContract.required !== false
  )
    throw new Error(`${input.caseId} required/optional Plan drifted`);
  if (input.actualPort.state !== input.modeledPort.state)
    throw new Error(`${input.caseId} reference publication state drifted`);
  if (
    input.actualPort.schema_hash !== input.modeledPort.schema_hash ||
    input.actualPort.schema_hash !== schema.schema_hash
  )
    throw new Error(`${input.caseId} reference publication schema drifted`);
  if (
    input.modeledPort.state === 'absent'
      ? canonicalJson(input.actualPort) !== canonicalJson(input.modeledPort)
      : input.actualPort.byte_length !== input.modeledPort.byte_length
  )
    throw new Error(`${input.caseId} reference publication envelope drifted`);
}

function buildNodeOutputEnvelopeFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, key, nowMs } = fixtureBehavior(fixture);
  const publishesOptionalAbsent = behavior === 'publish_optional_absent';
  const publishesAbsent =
    publishesOptionalAbsent || behavior === 'absent_required_port';
  const compiledMaxBytes =
    behavior === 'member_exceeds_compiled_max_bytes' ? 1 : 16_384;
  const instance = bootstrap(fixture.operation.scenario_key);
  const seed = seedRuntime(instance.store);
  const valueSchema = publishTestSchema(
    instance.store,
    seed,
    `fixture-envelope-${fixture.case_id}`,
    {},
  );
  const candidate = planVariant(seed, {
    nodes: [
      {
        id: 'fixture-output',
        type: 'system',
        capability_binding: { ref: seed.refs.capability.ref },
        trigger_program: compileTriggerProgram({ type: 'root' }),
        input_ports: {},
        output_ports: {
          result: {
            schema: compiledTestSchema(valueSchema),
            max_bytes: compiledMaxBytes,
            required: !publishesOptionalAbsent,
          },
        },
        outbox_execution_binding: executionBinding(seed),
        effective_retry_policy: {
          backoff: 'fixed',
          effective_node_max_attempts: 1,
          effective_retry_on: [],
          policy_hash: hash(`fixture-envelope-policy:${key}`),
          quality_revision: null,
        },
      },
    ],
    route_groups: [],
    control_edges: [],
    data_edges: [],
    completion: completionPolicy([
      {
        id: 'fixture-output-no-close',
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
  const run = materializePlanCase(instance, seed, candidate, key, nowMs);
  const planRow = instance.store.queryOne<{ id: string }>(
    'SELECT id FROM workflow_graph_scope_plans WHERE graph_run_id = ?',
    [run.graphRunId],
  )!;
  const logicalMemberValue: JsonValue =
    behavior === 'publish_ordered_list'
      ? ['first', 'second']
      : behavior === 'publish_defaulted_single'
        ? 'fallback'
        : behavior === 'publish_selected_immutable_value'
          ? { selected_port: 'result', value: 'immutable' }
          : behavior === 'publish_renamed_single'
            ? 'renamed-value'
            : { fixture: behavior };
  const modeledPublication =
    fixture.category === 'positive'
      ? referenceJoinPublication({
          planHash: candidate.plan_hash as Sha256Hash,
          nodeId: 'fixture-output',
          outputs: {
            result: {
              inputPort: 'source',
              schemaHash: valueSchema.schema_hash,
              required: !publishesOptionalAbsent,
              maxBytes: compiledMaxBytes,
            },
          },
          sealedPorts: {
            source: publishesOptionalAbsent
              ? { state: 'absent' }
              : { state: 'present', value: logicalMemberValue },
          },
        })
      : null;
  const memberLabel = `fixture-envelope-member-${fixture.case_id}`;
  const memberId = `value:test:${memberLabel}`;
  const member = publishesAbsent
    ? null
    : insertTestValue(
        instance.store,
        valueSchema,
        memberLabel,
        logicalMemberValue,
      );
  if (member) {
    const provenance = nodeOutputMemberProvenanceRef({
      planId: planRow.id,
      graphRunId: run.graphRunId,
      planHash: candidate.plan_hash as Sha256Hash,
      nodeId: 'fixture-output',
      portName: 'result',
      valueRef: member.id,
      valueHash: member.hash,
      schemaHash: valueSchema.schema_hash,
      byteLength: member.byteLength,
    });
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_values SET provenance_ref = ?, row_version = 0 WHERE id = ?',
        [
          behavior === 'wrong_member_provenance'
            ? 'g5-fixture-wrong-provenance'
            : provenance,
          member.id,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_value_ownerships (
         value_id, owner_workflow_id, owner_graph_run_id,
         owner_registry_resource_id, owner_pack_release_id,
         system_owner_ref, created_at_ms
       ) VALUES (?, NULL, ?, NULL, NULL, NULL, ?)`,
        [member.id, run.graphRunId, nowMs],
      );
    });
  }
  const ports: JsonObject = {
    result: publishesAbsent
      ? {
          state: 'absent',
          schema_hash: valueSchema.schema_hash,
        }
      : {
          state: 'present',
          value_ref: member!.id,
          value_hash: member!.hash,
          schema_hash:
            behavior === 'wrong_member_schema_hash'
              ? hash('fixture-wrong-output-schema')
              : valueSchema.schema_hash,
          byte_length: member!.byteLength,
        },
  };
  const input = {
    planId: planRow.id,
    graphRunId: run.graphRunId,
    planHash: candidate.plan_hash as Sha256Hash,
    nodeId: 'fixture-output',
    valueId: `value:fixture-envelope:${domainSeparatedSha256(
      'icarus:workflow-g5-fixture-envelope-value:1\n',
      { key },
    ).slice('sha256:'.length)}`,
    ports,
    createdAtMs: nowMs + 3,
  };
  const planNode = (candidate.nodes as JsonObject[]).find(
    (node) => node.id === 'fixture-output',
  )!;
  const outputContract = fixtureObject(
    (planNode.output_ports as JsonObject).result as JsonValue,
    `${fixture.case_id} Plan output contract`,
  );
  const descriptor = fixtureObject(
    planNode.output_envelope_schema as JsonValue,
    `${fixture.case_id} Plan output envelope descriptor`,
  );
  const generated = instance.store.queryOne<{
    plan_id: string;
    graph_run_id: string;
    plan_hash: string;
    schema_ref: string;
    schema_hash: string;
    generator: string;
    parameter_hash: string;
  }>(
    `SELECT plan_id, graph_run_id, plan_hash, schema_ref, schema_hash,
            generator, parameter_hash
       FROM workflow_plan_generated_schemas
      WHERE plan_id = ? AND generator = 'node_output_envelope'`,
    [planRow.id],
  )!;
  const authorityReadBehaviors = new Set([
    'delete_referenced_generated_binding',
    'unknown_envelope_schema_ref',
    'generated_schema_bytes_drift',
    'generated_schema_length_drift',
    'change_referenced_parameter_hash',
    'change_binding_hash',
    'unsupported_schema_canonicalizer',
    'add_unsealed_output_port',
    'moving_registry_schema_ref',
  ]);
  const boundary = new NodeOutputEnvelopeValueStore(instance.store);
  let written: NodeOutputEnvelopeValue | null = null;
  const assertPersistedEvidence = (
    observed: NodeOutputEnvelopeValue,
    stage: string,
  ): void => {
    const actualPort = fixtureObject(
      (observed.content.ports as JsonObject).result as JsonValue,
      `${fixture.case_id} ${stage} result port`,
    );
    if (modeledPublication) {
      const modeledPort = fixtureObject(
        (modeledPublication.ports as JsonObject).result as JsonValue,
        `${fixture.case_id} modeled result port`,
      );
      assertReferenceNodeOutputPort({
        caseId: fixture.case_id,
        modeledPort,
        planContract: outputContract,
        actualPort,
      });
    }
    if (
      observed.planId !== planRow.id ||
      observed.graphRunId !== run.graphRunId ||
      observed.planHash !== candidate.plan_hash ||
      observed.nodeId !== 'fixture-output' ||
      observed.schemaRef !== descriptor.schema_ref ||
      observed.schemaHash !== descriptor.schema_hash ||
      observed.parameterHash !== descriptor.parameter_hash ||
      generated.plan_id !== planRow.id ||
      generated.graph_run_id !== run.graphRunId ||
      generated.plan_hash !== candidate.plan_hash ||
      generated.schema_ref !== descriptor.schema_ref ||
      generated.schema_hash !== descriptor.schema_hash ||
      generated.generator !== 'node_output_envelope' ||
      generated.parameter_hash !== descriptor.parameter_hash
    )
      throw new Error(
        `${fixture.case_id} ${stage} Plan/schema binding drifted`,
      );
    const stored = instance.store.queryOne<{
      inline_canonical_json: string;
      schema_authority_kind: string;
      schema_plan_id: string;
      schema_plan_hash: string;
      generated_schema_ref: string;
      generated_schema_hash: string;
      generated_schema_generator: string;
      generated_schema_parameter_hash: string;
    }>(
      `SELECT inline_canonical_json, schema_authority_kind, schema_plan_id,
              schema_plan_hash, generated_schema_ref, generated_schema_hash,
              generated_schema_generator, generated_schema_parameter_hash
         FROM workflow_values WHERE id = ?`,
      [observed.valueId],
    );
    if (
      !stored ||
      stored.inline_canonical_json !== canonicalJson(observed.content) ||
      stored.schema_authority_kind !== 'plan_generated' ||
      stored.schema_plan_id !== planRow.id ||
      stored.schema_plan_hash !== candidate.plan_hash ||
      stored.generated_schema_ref !== descriptor.schema_ref ||
      stored.generated_schema_hash !== descriptor.schema_hash ||
      stored.generated_schema_generator !== 'node_output_envelope' ||
      stored.generated_schema_parameter_hash !== descriptor.parameter_hash
    )
      throw new Error(
        `${fixture.case_id} ${stage} Stored Value binding drifted`,
      );
    if (publishesOptionalAbsent) {
      if (
        canonicalJson(actualPort) !==
          canonicalJson({
            state: 'absent',
            schema_hash: valueSchema.schema_hash,
          }) ||
        'value_ref' in actualPort ||
        'value_hash' in actualPort ||
        'byte_length' in actualPort
      )
        throw new Error(`${fixture.case_id} ${stage} was not truly absent`);
      const fabricated = instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_values
          WHERE id = ? OR provenance_ref LIKE 'icarus-node-output-member-provenance:%'`,
        [memberId],
      )!.count;
      const fabricatedOwnership = instance.store.queryOne<{ count: number }>(
        `SELECT count(*) AS count FROM workflow_value_ownerships o
          JOIN workflow_values v ON v.id = o.value_id
         WHERE v.id = ? OR v.provenance_ref LIKE 'icarus-node-output-member-provenance:%'`,
        [memberId],
      )!.count;
      if (fabricated !== 0 || fabricatedOwnership !== 0)
        throw new Error(
          `${fixture.case_id} ${stage} fabricated an absent member`,
        );
    } else if (fixture.category === 'positive') {
      const memberValue = instance.store.queryOne<{
        inline_canonical_json: string;
      }>('SELECT inline_canonical_json FROM workflow_values WHERE id = ?', [
        String(actualPort.value_ref),
      ]);
      if (
        !memberValue ||
        memberValue.inline_canonical_json !==
          canonicalJson(logicalMemberValue) ||
        (modeledPublication &&
          memberValue.inline_canonical_json ===
            canonicalJson(modeledPublication))
      )
        throw new Error(
          `${fixture.case_id} ${stage} stored model-as-member data`,
        );
    }
  };
  if (authorityReadBehaviors.has(behavior)) written = boundary.write(input);
  instance.store.withImmediateTransaction((transaction) => {
    if (behavior === 'generated_schema_bytes_drift')
      transaction.execute(
        'UPDATE workflow_generated_schema_contents SET canonical_schema_json = ? WHERE schema_ref = ?',
        ['{}', generated.schema_ref],
      );
    else if (behavior === 'generated_schema_length_drift')
      transaction.execute(
        'UPDATE workflow_generated_schema_contents SET byte_length = byte_length + 1 WHERE schema_ref = ?',
        [generated.schema_ref],
      );
    else if (behavior === 'change_binding_hash')
      transaction.execute(
        'UPDATE workflow_plan_generated_schemas SET binding_hash = ? WHERE plan_id = ? AND schema_ref = ?',
        [
          hash('fixture-generated-binding-drift'),
          planRow.id,
          generated.schema_ref,
        ],
      );
    else if (behavior === 'unexpected_envelope_port')
      ports.extra = {
        state: 'absent',
        schema_hash: valueSchema.schema_hash,
      };
    else if (
      behavior === 'unknown_envelope_schema_ref' ||
      behavior === 'add_unsealed_output_port' ||
      behavior === 'moving_registry_schema_ref'
    ) {
      const planValue = structuredClone(candidate) as JsonObject;
      const node = (planValue.nodes as JsonObject[])[0]!;
      if (behavior === 'unknown_envelope_schema_ref')
        (node.output_envelope_schema as JsonObject).schema_ref =
          `unknown:sha256:${'0'.repeat(64)}`;
      else if (behavior === 'add_unsealed_output_port')
        (node.output_ports as JsonObject).unexpected = {
          schema: compiledTestSchema(valueSchema),
          max_bytes: 16,
          required: false,
        };
      else
        (
          ((node.output_ports as JsonObject).result as JsonObject)
            .schema as JsonObject
        ).ref = { id: valueSchema.ref.id, version: 'latest' };
      transaction.execute(
        'UPDATE workflow_graph_scope_plans SET compiled_plan_json = ? WHERE id = ?',
        [canonicalJson(planValue), planRow.id],
      );
    }
  });
  return {
    instance,
    relation,
    invoke: (fault) => {
      if (
        behavior === 'delete_referenced_generated_binding' ||
        behavior === 'change_referenced_parameter_hash' ||
        behavior === 'unsupported_schema_canonicalizer'
      ) {
        try {
          instance.store.withImmediateTransaction((transaction) => {
            if (behavior === 'delete_referenced_generated_binding')
              transaction.execute(
                `DELETE FROM workflow_plan_generated_schemas
                  WHERE plan_id = ? AND schema_ref = ?`,
                [planRow.id, generated.schema_ref],
              );
            else if (behavior === 'change_referenced_parameter_hash')
              transaction.execute(
                'UPDATE workflow_plan_generated_schemas SET parameter_hash = ? WHERE plan_id = ? AND schema_ref = ?',
                [
                  hash('fixture-generated-parameter-drift'),
                  planRow.id,
                  generated.schema_ref,
                ],
              );
            else
              transaction.execute(
                "UPDATE workflow_generated_schema_contents SET canonicalizer = 'wrong' WHERE schema_ref = ?",
                [generated.schema_ref],
              );
          });
        } catch (error) {
          const message = String(error);
          if (/FOREIGN KEY constraint failed/.test(message))
            throw new ObservedFixtureRejection('sqlite_foreign_key');
          if (/CHECK constraint failed/.test(message))
            throw new ObservedFixtureRejection('sqlite_check');
          throw error;
        }
        return 'unexpected';
      }
      if (authorityReadBehaviors.has(behavior)) {
        boundary.read(input);
        return 'unexpected';
      }
      if (fault) requireFixtureFaultPoint(fixture, 'after_value');
      written = boundary.write({
        ...input,
        ...(fault ? { faultAt: 'after_value' as const } : {}),
      });
      if (canonicalJson(written.content.ports) !== canonicalJson(ports))
        throw new Error(`${fixture.case_id} stored the wrong modeled ports`);
      if (fixture.category === 'positive') {
        assertPersistedEvidence(written, 'write');
        const replayed = boundary.write(input);
        if (
          canonicalJson(replayed as unknown as JsonValue) !==
          canonicalJson(written as unknown as JsonValue)
        )
          throw new Error(`${fixture.case_id} immediate Store replay drifted`);
        assertPersistedEvidence(replayed, 'exact replay');
        const read = boundary.read(input);
        if (
          canonicalJson(read as unknown as JsonValue) !==
          canonicalJson(written as unknown as JsonValue)
        )
          throw new Error(`${fixture.case_id} Store read drifted`);
        assertPersistedEvidence(read, 'read');
        const recovered = boundary
          .verifyReopenAndRecovery()
          .find((value) => value.valueId === input.valueId);
        if (
          !recovered ||
          canonicalJson(recovered as unknown as JsonValue) !==
            canonicalJson(written as unknown as JsonValue)
        )
          throw new Error(`${fixture.case_id} recovery scan drifted`);
        assertPersistedEvidence(recovered, 'recovery');
      }
      return 'written';
    },
    replay: () => {
      const replayed = new NodeOutputEnvelopeValueStore(instance.store).write(
        input,
      );
      if (
        !written ||
        canonicalJson(replayed as unknown as JsonValue) !==
          canonicalJson(written as unknown as JsonValue)
      )
        throw new Error(`${fixture.case_id} Store replay drifted`);
      if (fixture.category === 'positive') {
        assertPersistedEvidence(replayed, 'post-reopen replay');
        const read = new NodeOutputEnvelopeValueStore(instance.store).read(
          input,
        );
        assertPersistedEvidence(read, 'post-reopen replay read');
      }
      const recovered = new NodeOutputEnvelopeValueStore(
        instance.store,
      ).verifyReopenAndRecovery();
      const recoveredValue = recovered.find(
        (value) => value.valueId === input.valueId,
      );
      if (!recoveredValue)
        throw new Error(`${fixture.case_id} was absent from recovery scan`);
      if (fixture.category === 'positive')
        assertPersistedEvidence(recoveredValue, 'post-reopen replay recovery');
      return 'exact_replay';
    },
    verifyAfterReopen: () => {
      if (fixture.category !== 'positive' || !written) return;
      const reopened = new NodeOutputEnvelopeValueStore(instance.store);
      const read = reopened.read(input);
      if (
        canonicalJson(read as unknown as JsonValue) !==
        canonicalJson(written as unknown as JsonValue)
      )
        throw new Error(`${fixture.case_id} reopened Store read drifted`);
      assertPersistedEvidence(read, 'reopen read');
      const recovered = reopened
        .verifyReopenAndRecovery()
        .find((value) => value.valueId === input.valueId);
      if (
        !recovered ||
        canonicalJson(recovered as unknown as JsonValue) !==
          canonicalJson(written as unknown as JsonValue)
      )
        throw new Error(`${fixture.case_id} reopened recovery scan drifted`);
      assertPersistedEvidence(recovered, 'reopen recovery');
    },
  };
}

function prepareExecutionFixture(
  fixture: G5RepairFixtureCase,
  nodeKey: 'work' | 'timeout' = 'work',
): {
  readonly instance: G5TestBootstrapInstance;
  readonly seed: SeededRuntime;
  readonly prefix: ReturnType<typeof fixedPointPrefix>;
  readonly node: {
    readonly id: string;
    readonly row_version: number;
    readonly activation_event_seq: number;
  };
  readonly admission: ReturnType<typeof scheduleReadyNodeT4>;
} {
  const { nowMs } = fixtureBehavior(fixture);
  const prefix = fixedPointPrefix(fixture);
  initializeScopeFixedPointT3a(prefix.instance.store, prefix.input);
  installFixtureRuntimeCapacity(prefix.instance, prefix.seed);
  const node = prefix.instance.store.queryOne<{
    id: string;
    row_version: number;
    activation_event_seq: number;
  }>(
    'SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = ?',
    [prefix.created.activation.graphRunId, nodeKey],
  )!;
  const admission = scheduleReadyNodeT4(
    prefix.instance.store,
    { current: () => fixedCapacity() },
    {
      graphRunId: prefix.created.activation.graphRunId,
      scopeId: prefix.created.activation.rootScopeId,
      nodeId: node.id,
      expectedNodeRowVersion: node.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: node.activation_event_seq,
      activation: { kind: 'execution' },
      nowMs: nowMs + 10,
    },
  );
  return {
    instance: prefix.instance,
    seed: prefix.seed,
    prefix,
    node,
    admission,
  };
}

function capabilityDispatchInput(
  fixture: G5RepairFixtureCase,
  execution: ReturnType<typeof prepareExecutionFixture>,
) {
  const { key, nowMs } = fixtureBehavior(fixture);
  return {
    graphRunId: execution.prefix.created.activation.graphRunId,
    scopeId: execution.prefix.created.activation.rootScopeId,
    nodeId: execution.node.id,
    attemptId: execution.admission.attemptId!,
    expectedAttemptRowVersion: 1,
    expectedRunWorkFenceEpoch: 0,
    expectedScopeWorkFenceEpoch: 0,
    request: execution.seed.values.request,
    policySnapshotSchema: execution.seed.refs.policySnapshotSchema,
    operationKey: `operation:${key}`,
    requiredClaims: [],
    dispatchDeadlineAtMs: nowMs + 100,
    outboxDeadlineAtMs: nowMs + 10_000,
    nowMs: nowMs + 11,
  };
}

function buildT4FixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, nowMs } = fixtureBehavior(fixture);
  const prefix = fixedPointPrefix(fixture);
  initializeScopeFixedPointT3a(prefix.instance.store, prefix.input);
  const node = prefix.instance.store.queryOne<{
    id: string;
    row_version: number;
    activation_event_seq: number;
  }>(
    "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'work'",
    [prefix.created.activation.graphRunId],
  )!;
  const input: Parameters<typeof scheduleReadyNodeT4>[2] = {
    graphRunId: prefix.created.activation.graphRunId,
    scopeId: prefix.created.activation.rootScopeId,
    nodeId: node.id,
    expectedNodeRowVersion:
      behavior === 'stale_node_row_version'
        ? node.row_version - 1
        : node.row_version,
    expectedRunWorkFenceEpoch: 0,
    expectedScopeWorkFenceEpoch: 0,
    eligibleEventSeq: node.activation_event_seq,
    activation: { kind: 'execution' },
    nowMs: nowMs + 10,
  };
  return {
    instance: prefix.instance,
    relation,
    invoke: (fault) =>
      scheduleReadyNodeT4(
        prefix.instance.store,
        { current: () => fixedCapacity() },
        input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
  };
}

function buildT5FixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation } = fixtureBehavior(fixture);
  if (behavior === 'moving_delivery_policy_ref') {
    const prefix = compilePrefix(fixture);
    const planValue = structuredClone(prefix.candidate) as JsonObject;
    delete planValue.plan_hash;
    const node = (planValue.nodes as JsonObject[])[0]!;
    const binding = node.outbox_execution_binding as JsonObject;
    (binding.delivery_policy_identity as JsonObject).ref = {
      id: prefix.seed.refs.outboxPolicy.ref.id,
      version: 'latest',
    };
    (binding.effect_contract as JsonObject).delivery_policy_ref = {
      id: prefix.seed.refs.outboxPolicy.ref.id,
      version: 'latest',
    };
    const invalid = withPlanHash(
      planValue as Omit<CompiledScopePlanV2Document, 'plan_hash'>,
    );
    return {
      instance: prefix.instance,
      relation,
      invoke: () => {
        persistCompileResultT2a(prefix.instance.store, {
          ...prefix.input,
          plan: invalid,
        });
        return 'unexpected';
      },
    };
  }
  const execution = prepareExecutionFixture(fixture);
  const input = capabilityDispatchInput(fixture, execution);
  if (behavior === 'test_only_adapter_authority') {
    const adapter = execution.instance.store.queryOne<{
      canonical_value_id: string;
      inline_canonical_json: string;
    }>(
      `SELECT r.canonical_value_id, v.inline_canonical_json
         FROM workflow_registry_resources r
         JOIN workflow_values v ON v.id = r.canonical_value_id
        WHERE r.id = ?`,
      [execution.seed.refs.adapter.rowId],
    )!;
    const content = JSON.parse(adapter.inline_canonical_json) as JsonObject;
    content.launchability = 'test_only';
    execution.instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_values SET inline_canonical_json = ? WHERE id = ?',
        [canonicalJson(content), adapter.canonical_value_id],
      );
    });
  }
  return {
    instance: execution.instance,
    relation,
    invoke: (fault) =>
      prepareCapabilityDispatchT5(
        execution.instance.store,
        input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
  };
}

function dispatchExecutionFixture(
  fixture: G5RepairFixtureCase,
  nodeKey: 'work' | 'timeout' = 'work',
) {
  const execution = prepareExecutionFixture(fixture, nodeKey);
  const dispatch = prepareCapabilityDispatchT5(
    execution.instance.store,
    capabilityDispatchInput(fixture, execution),
  );
  return { ...execution, dispatch };
}

function buildT6aFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, nowMs } = fixtureBehavior(fixture);
  const execution = dispatchExecutionFixture(fixture, 'timeout');
  const attempt = execution.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_node_attempts WHERE id = ?',
    [execution.admission.attemptId!],
  )!;
  const input: Parameters<typeof acceptInternalResultT6a>[1] = {
    graphRunId: execution.prefix.created.activation.graphRunId,
    scopeId: execution.prefix.created.activation.rootScopeId,
    nodeId: execution.node.id,
    attemptId: execution.admission.attemptId!,
    expectedAttemptRowVersion:
      behavior === 'stale_attempt_row_version'
        ? attempt.row_version + 1
        : attempt.row_version,
    leaseOwner: null,
    leaseToken: null,
    expectedRunWorkFenceEpoch: 0,
    expectedScopeWorkFenceEpoch: 0,
    executionOutcome: 'succeeded',
    qualityDecision: 'pass',
    result: execution.seed.values.result,
    outputPorts: { result: execution.seed.values.result },
    evaluation: null,
    feedback: null,
    errorCode: null,
    factPayload: execution.seed.values.result,
    nowMs: nowMs + 20,
  };
  return {
    instance: execution.instance,
    relation,
    invoke: (fault) =>
      acceptInternalResultT6a(
        execution.instance.store,
        input,
        transactionFixtureFault(fixture, fault),
      ).disposition,
  };
}

function buildT6bFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, key, nowMs } = fixtureBehavior(fixture);
  const execution = dispatchExecutionFixture(fixture);
  const lease = leaseOutboxWork(execution.instance.store, {
    outboxId: execution.dispatch.outboxId,
    leaseOwner: `worker:${key}`,
    leaseToken: `lease:${key}`,
    leaseExpiresAtMs: nowMs + 100,
    nowMs: nowMs + 12,
  });
  recordOutboxResult(execution.instance.store, lease, {
    resultKind: 'applied_with_receipt',
    resultCode: null,
    receipt: execution.seed.values.result,
    afterState: execution.seed.values.result,
    immutableOutput: execution.seed.values.result,
    externalId: `external:${key}`,
    nextAttemptAtMs: null,
    attemptsExhausted: false,
    startedAtMs: nowMs + 12,
    finishedAtMs: nowMs + 13,
  });
  const input: Parameters<typeof acceptDelegationCallbackT6b>[1] = {
    graphRunId: execution.prefix.created.activation.graphRunId,
    scopeId: execution.prefix.created.activation.rootScopeId,
    nodeId: execution.node.id,
    attemptId: execution.admission.attemptId!,
    delegationId: stableRuntimeId('delegation', {
      attempt_id: execution.admission.attemptId!,
    }),
    externalExecutionId: `external:${key}`,
    providerEventId: `callback:${key}`,
    result: execution.seed.values.result,
    expectedRunWorkFenceEpoch: 0,
    expectedScopeWorkFenceEpoch: 0,
    nowMs: nowMs + 14,
  };
  if (behavior === 'different_external_execution_identity')
    acceptDelegationCallbackT6b(execution.instance.store, input);
  const invoke = (fault: boolean): string => {
    const result = acceptDelegationCallbackT6b(
      execution.instance.store,
      behavior === 'different_external_execution_identity'
        ? {
            ...input,
            externalExecutionId: `external:${key}:drift`,
            providerEventId: `callback:${key}:drift`,
            nowMs: input.nowMs + 1,
          }
        : input,
      transactionFixtureFault(fixture, fault),
    );
    if (behavior === 'different_external_execution_identity') {
      if (result !== 'conflict')
        throw new Error(`${fixture.case_id} did not conflict`);
      throw new ObservedFixtureRejection('idempotency_conflict');
    }
    return result;
  };
  return {
    instance: execution.instance,
    relation,
    invoke,
    replay: () =>
      acceptDelegationCallbackT6b(execution.instance.store, {
        ...input,
        nowMs: input.nowMs + 1,
      }),
  };
}

function buildT6cFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, key, nowMs } = fixtureBehavior(fixture);
  const prefix = fixedPointPrefix(fixture);
  initializeScopeFixedPointT3a(prefix.instance.store, prefix.input);
  installFixtureRuntimeCapacity(prefix.instance, prefix.seed);
  const node = prefix.instance.store.queryOne<{
    id: string;
    row_version: number;
    activation_event_seq: number;
  }>(
    "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'pause'",
    [prefix.created.activation.graphRunId],
  )!;
  const admission = scheduleReadyNodeT4(
    prefix.instance.store,
    { current: () => fixedCapacity() },
    {
      graphRunId: prefix.created.activation.graphRunId,
      scopeId: prefix.created.activation.rootScopeId,
      nodeId: node.id,
      expectedNodeRowVersion: node.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: node.activation_event_seq,
      activation: { kind: 'wait' },
      nowMs: nowMs + 10,
    },
  );
  const input: Parameters<typeof resolveWaitT6c>[1] = {
    waitId: admission.waitId!,
    providerRef: 'provider:g5-fixture',
    providerEventId: `signal:${key}`,
    principalRef: 'human:local-owner',
    workflowId: prefix.created.workflowId,
    resolution: 'signal',
    payload: prefix.seed.values.result,
    payloadByteLength: 17,
    ingressAuthorization: prefix.seed.values.ingressAuthorization,
    bindingAuthorization: prefix.seed.values.bindingAuthorization,
    expectedWaitRowVersion: 1,
    expectedRunWorkFenceEpoch: 0,
    expectedScopeWorkFenceEpoch: 0,
    receivedAtMs: nowMs + 11,
    expiresAtMs: nowMs + 10_000,
  };
  if (behavior === 'timeout_after_signal_winner')
    resolveWaitT6c(prefix.instance.store, input);
  return {
    instance: prefix.instance,
    relation,
    invoke: (fault) => {
      const result = resolveWaitT6c(
        prefix.instance.store,
        behavior === 'timeout_after_signal_winner'
          ? {
              ...input,
              providerEventId: `timeout:${key}`,
              resolution: 'timeout',
              receivedAtMs: input.receivedAtMs + 1,
            }
          : input,
        transactionFixtureFault(fixture, fault),
      ).disposition;
      if (behavior === 'timeout_after_signal_winner') {
        if (result !== 'conflict' && result !== 'late')
          throw new Error(
            `${fixture.case_id} did not reject the second winner`,
          );
        throw new ObservedFixtureRejection(result);
      }
      return result;
    },
  };
}

function buildT6dFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, nowMs } = fixtureBehavior(fixture);
  const execution = dispatchExecutionFixture(fixture, 'timeout');
  const attempt = execution.instance.store.queryOne<{ row_version: number }>(
    'SELECT row_version FROM workflow_graph_node_attempts WHERE id = ?',
    [execution.admission.attemptId!],
  )!;
  const watchdogInput: Parameters<typeof fireAttemptWatchdogT6d>[1] = {
    attemptId: execution.admission.attemptId!,
    automaticTimer: true,
    expectedAttemptRowVersion: attempt.row_version,
    factPayload: execution.seed.values.result,
    nowMs: nowMs + 100,
  };
  let preparedScheduleId: string | null = null;
  if (behavior === 'automatic_timer_false') {
    preparedScheduleId = fireAttemptWatchdogT6d(
      execution.instance.store,
      watchdogInput,
    ).retryScheduleId;
  }
  return {
    instance: execution.instance,
    relation,
    invoke: (fault) => {
      if (behavior === 'automatic_timer_false') {
        consumeRetryScheduleT6d(
          execution.instance.store,
          { current: () => fixedCapacity() },
          {
            retryScheduleId: preparedScheduleId!,
            expectedScheduleRowVersion: 1,
            automaticTimer: false as unknown as true,
            nowMs: nowMs + 110,
          },
        );
        return 'unexpected';
      }
      const timedOut = fireAttemptWatchdogT6d(
        execution.instance.store,
        watchdogInput,
        transactionFixtureFault(fixture, fault),
      );
      if (!timedOut.retryScheduleId)
        throw new Error(`${fixture.case_id} did not create a retry schedule`);
      return consumeRetryScheduleT6d(
        execution.instance.store,
        { current: () => fixedCapacity() },
        {
          retryScheduleId: timedOut.retryScheduleId,
          expectedScheduleRowVersion: 1,
          automaticTimer: true,
          nowMs: nowMs + 110,
        },
      ).disposition;
    },
  };
}

function buildBlockerFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { relation, key, nowMs } = fixtureBehavior(fixture);
  const prefix = compilePrefix(fixture);
  const event = prefix.instance.store.queryOne<{ next_event_seq: number }>(
    'SELECT next_event_seq FROM workflow_graph_runs WHERE id = ?',
    [prefix.created.activation.graphRunId],
  )!;
  return {
    instance: prefix.instance,
    relation,
    invoke: () => {
      const receipt = openOperationalBlocker(prefix.instance.store, {
        workflowId: prefix.created.workflowId,
        graphRunId: prefix.created.activation.graphRunId,
        blockerKind: 'resource_or_credential_unavailable',
        severity: 'action_required',
        source: { kind: 'event', sequence: event.next_event_seq },
        errorCode: `fixture:${key}`,
        evidenceManifest: prefix.seed.values.evidence,
        remediationPolicy: prefix.seed.refs.remediationPolicy,
        nextRemediationAtMs: null,
        remediationDeadlineAtMs: nowMs + 10_000,
        nowMs,
      });
      const open = listOpenOperationalBlockers(
        prefix.instance.store,
        prefix.created.activation.graphRunId,
      );
      if (receipt.operationalState !== 'action_required' || open.length !== 1)
        throw new Error(`${fixture.case_id} blocker cache did not commit`);
      return receipt.disposition;
    },
  };
}

function capacityCommand(key: string): ReplaceDeploymentCapacityCommand {
  const payload = {
    max_active_executions: 5,
    max_active_waits: 256,
    max_pending_signals: 2048,
    max_outbox_inflight: 16,
    max_physical_blob_bytes: 21_474_836_480,
    soft_blob_high_water_bytes: 17_179_869_184,
    minimum_free_disk_bytes: 5_368_709_120,
  };
  const baseline = buildDeploymentRuntimeCapacityBaseline();
  return {
    command_type: 'replace_deployment_capacity',
    command_id: `capacity-command:${key}`,
    idempotency_key: `capacity-key:${key}`,
    expected_capacity_revision: 1,
    expected_config_hash: baseline.config_hash as Sha256Hash,
    proposed_capacity: {
      ...payload,
      config_hash: calculateDeploymentCapacityConfigHash(payload),
    },
    reason_code: 'planned_tuning',
    reason_text: 'exercise local Capacity replacement',
    evidence_refs: [],
  };
}

function capacityInvocation(
  _command: ReplaceDeploymentCapacityCommand,
): CapacityAuthenticatedInvocation {
  return {
    authenticated: true,
    actorRef: 'human:local-owner',
    sessionActorRef: 'human:local-owner',
    actorKind: 'human',
    authSessionRef: 'auth:local-owner',
    entrypoint: 'runtime_center',
    delegationChainRef: null,
    permissions: ['runtime.capacity.manage'],
    requestedAtMs: 10,
  };
}

function buildCapacityFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  const { behavior, relation, key, nowMs } = fixtureBehavior(fixture);
  const instance = bootstrap(fixture.operation.scenario_key);
  const seed = seedRuntime(instance.store);
  const command = capacityCommand(key);
  const persistence = {
    evidenceManifest: seed.values.evidence,
    reasonText: seed.values.evidence,
    resultSchema: seed.refs.schema,
  };
  const prepare = () =>
    prepareCapacityChangeCAP0CAP1(
      instance.store,
      command,
      capacityInvocation(command),
      persistence,
      nowMs,
    );
  const publisher = new CapacitySnapshotPublisher(
    path.join(instance.dataRoot, 'workflow-runtime-capacity.json'),
  );
  if (
    behavior === 'conflicting_capacity_request' ||
    behavior === 'recover_unaudited_file'
  ) {
    const prepared = prepare();
    if (!('publication' in prepared) || !prepared.publication)
      throw new Error(`${fixture.case_id} Capacity prepare failed`);
    if (behavior === 'recover_unaudited_file') {
      publisher.installCAP2(instance.store, prepared.publication, nowMs + 1);
      publisher.commitHeadCAP3(instance.store, prepared.publication, nowMs + 2);
      fs.writeFileSync(
        publisher.publicationPath,
        `${canonicalJson({
          ...prepared.publication,
          capacity_change_id: 'unaudited-fixture-change',
        } as unknown as JsonValue)}\n`,
        'utf8',
      );
    }
  }
  const recover = () =>
    recoverCapacityPublication(
      instance.store,
      publisher,
      new CapacitySnapshotWatcher(),
      seed.refs.schema,
      nowMs + 20,
    );
  if (fixture.category === 'fault')
    requireFixtureFaultPoint(
      fixture,
      {
        recover_after_cap1_prepare: 'capacity_after_prepare',
        recover_after_cap2_rename: 'capacity_after_rename',
        recover_after_cap3_head: 'capacity_after_head',
      }[behavior] ?? '',
    );
  return {
    instance,
    relation,
    invoke: () => {
      if (behavior === 'conflicting_capacity_request') {
        const result = prepareCapacityChangeCAP0CAP1(
          instance.store,
          { ...command, reason_code: 'operator_override' },
          capacityInvocation(command),
          persistence,
          nowMs + 1,
        );
        if (!('disposition' in result) || result.disposition !== 'conflict')
          throw new Error(`${fixture.case_id} did not conflict`);
        throw new ObservedFixtureRejection('idempotency_conflict');
      }
      if (behavior === 'recover_unaudited_file') {
        const restored = recover();
        if (!restored)
          throw new Error(`${fixture.case_id} did not recover authority`);
        throw new ObservedFixtureRejection('publication_not_authoritative');
      }
      const prepared = prepare();
      if (!('publication' in prepared) || !prepared.publication)
        throw new Error(`${fixture.case_id} Capacity prepare failed`);
      const publication = prepared.publication;
      if (behavior === 'recover_after_cap1_prepare') {
        instance.closeStore();
        instance.reopenStore();
      } else if (
        behavior === 'recover_after_rename_response_loss' ||
        behavior === 'recover_after_cap2_rename'
      ) {
        try {
          publisher.installCAP2(
            instance.store,
            publication,
            nowMs + 1,
            'after_rename_before_event',
          );
        } catch (error) {
          if (
            !(error instanceof G5RuntimeError) ||
            error.code !== 'fault_injected'
          )
            throw error;
        }
        instance.closeStore();
        instance.reopenStore();
      } else if (behavior === 'recover_after_cap3_head') {
        publisher.installCAP2(instance.store, publication, nowMs + 1);
        publisher.commitHeadCAP3(instance.store, publication, nowMs + 2);
        instance.closeStore();
        instance.reopenStore();
      }
      const recovered = recover();
      if (
        !recovered ||
        recovered.publication_hash !== publication.publication_hash
      )
        throw new Error(`${fixture.case_id} Capacity recovery drifted`);
      return 'recovered';
    },
    replay: () => {
      const recovered = recover();
      if (!recovered)
        throw new Error(`${fixture.case_id} Capacity replay disappeared`);
      return 'exact_replay';
    },
  };
}

function productionErrorCode(error: unknown): string {
  if (error instanceof ObservedFixtureRejection) return error.code;
  if (error instanceof G5RuntimeError) return error.code;
  if (error instanceof NodeOutputEnvelopeAuthorityError) return error.code;
  throw error;
}

function executeProductionFixture(
  fixture: G5RepairFixtureCase,
): G5RepairFixtureOracle {
  const input = fixture.operation.input;
  const mode = fixtureString(input.mode, 'fixture mode');
  const reopenAfter = fixtureBoolean(input.reopen_after, 'reopen_after');
  const replayCount = fixtureNumber(input.replay_count, 'replay_count');
  const expectedMode =
    fixture.category === 'fault' && fixture.oracle.disposition === 'rolled_back'
      ? 'inject_and_rollback'
      : fixture.oracle.disposition === 'replayed'
        ? 'commit_reopen_replay'
        : fixture.category === 'negative'
          ? 'reject_constraint'
          : 'commit';
  if (mode !== expectedMode)
    throw new Error(`${fixture.case_id} execution mode drifted`);
  const target = buildProductionFixtureTarget(fixture);
  const beforeRelation = relationFingerprint(target.instance, target.relation);
  const beforeDatabase = databaseFingerprint(target.instance);
  let errorCode: string | null = null;
  let receipt = '';
  try {
    receipt = target.invoke(mode === 'inject_and_rollback');
  } catch (error) {
    errorCode = productionErrorCode(error);
  }
  const afterRelation = relationFingerprint(target.instance, target.relation);
  const afterDatabase = databaseFingerprint(target.instance);
  const shouldCommit = fixture.oracle.sqlite_state === 'committed';
  if (
    (afterRelation !== beforeRelation) !== shouldCommit ||
    (afterDatabase !== beforeDatabase) !== shouldCommit
  )
    throw new Error(`${fixture.case_id} durable SQLite state mismatched`);
  if (fixture.category === 'positive' && errorCode !== null)
    throw new Error(`${fixture.case_id} unexpectedly rejected: ${errorCode}`);
  if (fixture.category === 'negative' && errorCode === null)
    throw new Error(`${fixture.case_id} did not reject (${receipt})`);
  const declaredRejection = input.rejection_code;
  if (
    fixture.category === 'negative'
      ? typeof declaredRejection !== 'string' || declaredRejection !== errorCode
      : declaredRejection !== null
  )
    throw new Error(`${fixture.case_id} rejection input drifted`);
  if (
    fixture.category === 'fault' &&
    fixture.oracle.disposition === 'rolled_back' &&
    errorCode !== 'fault_injected'
  )
    throw new Error(`${fixture.case_id} did not inject its named fault`);
  if (reopenAfter) {
    target.instance.closeStore();
    target.instance.reopenStore();
    if (
      relationFingerprint(target.instance, target.relation) !== afterRelation ||
      databaseFingerprint(target.instance) !== afterDatabase
    )
      throw new Error(`${fixture.case_id} changed across Store reopen`);
    target.verifyAfterReopen?.();
  }
  if (fixture.oracle.disposition === 'replayed') {
    if (!target.replay)
      throw new Error(`${fixture.case_id} has no production replay`);
    for (let replay = 1; replay < replayCount; replay += 1) target.replay();
    if (
      relationFingerprint(target.instance, target.relation) !== afterRelation ||
      databaseFingerprint(target.instance) !== afterDatabase
    )
      throw new Error(`${fixture.case_id} replay changed durable state`);
  }
  return {
    disposition:
      fixture.category === 'negative'
        ? 'rejected'
        : fixture.category === 'fault' &&
            fixture.oracle.disposition === 'rolled_back'
          ? 'rolled_back'
          : fixture.oracle.disposition === 'replayed'
            ? 'replayed'
            : 'accepted',
    sqlite_state: shouldCommit ? 'committed' : 'unchanged',
    reopen_required: reopenAfter,
    exact_error:
      fixture.category === 'negative'
        ? `sqlite_constraint:${declaredRejection}`
        : fixture.category === 'fault' &&
            fixture.oracle.disposition === 'rolled_back'
          ? 'injected_fault'
          : null,
  };
}

function buildProductionFixtureTarget(
  fixture: G5RepairFixtureCase,
): ProductionFixtureTarget {
  switch (fixture.operation.kind) {
    case 'create_workflow_t0':
      return buildT0FixtureTarget(fixture);
    case 'activate_workflow_t1':
      return buildT1FixtureTarget(fixture);
    case 'persist_compile_result_t2a':
      return buildT2aFixtureTarget(fixture);
    case 'materialize_root_scope_t2b':
      return buildT2bFixtureTarget(fixture);
    case 'initialize_fixed_point_t3a':
      return buildT3aFixtureTarget(fixture);
    case 'request_settled_close_t3b':
      return buildT3bFixtureTarget(fixture);
    case 'prepare_required_finalization_t0p':
      return buildT0pFixtureTarget(fixture);
    case 'node_output_envelope_store':
      return buildNodeOutputEnvelopeFixtureTarget(fixture);
    case 'schedule_ready_node_t4':
      return buildT4FixtureTarget(fixture);
    case 'prepare_capability_dispatch_t5':
      return buildT5FixtureTarget(fixture);
    case 'accept_internal_result_t6a':
      return buildT6aFixtureTarget(fixture);
    case 'accept_delegation_callback_t6b':
      return buildT6bFixtureTarget(fixture);
    case 'resolve_wait_t6c':
      return buildT6cFixtureTarget(fixture);
    case 'fire_attempt_watchdog_t6d':
      return buildT6dFixtureTarget(fixture);
    case 'capacity_admin_cap0_cap4':
      return buildCapacityFixtureTarget(fixture);
    case 'open_operational_blocker':
      return buildBlockerFixtureTarget(fixture);
    default:
      throw new Error(
        `${fixture.case_id} has no production fixture target for ${fixture.operation.kind}`,
      );
  }
}

const productionFixtureArtifacts: G5FixtureArtifacts = {
  positive: G5_REPAIR_POSITIVE_FIXTURES,
  negative: G5_REPAIR_NEGATIVE_FIXTURES,
  fault: G5_REPAIR_FAULT_FIXTURES,
};

const productionFixtureHandlerIds = [
  'create_workflow_t0_production',
  'prepare_required_finalization_t0p_production',
  'activate_workflow_t1_production',
  'persist_compile_result_t2a_production',
  'materialize_root_scope_t2b_production',
  'initialize_fixed_point_t3a_production',
  'request_settled_close_t3b_production',
  'schedule_ready_node_t4_production',
  'prepare_capability_dispatch_t5_production',
  'accept_internal_result_t6a_production',
  'accept_delegation_callback_t6b_production',
  'resolve_wait_t6c_production',
  'fire_attempt_watchdog_t6d_production',
  'capacity_admin_cap0_cap4_production',
  'open_operational_blocker_production',
  'node_output_envelope_store_production',
] as const;

const productionFixtureHandlers: readonly G5FixtureHandler[] =
  productionFixtureHandlerIds.map((id) => ({
    id,
    execute: executeProductionFixture,
  }));
const productionFixtureHarness = new G5FixtureExecutionHarness(
  productionFixtureArtifacts,
  productionFixtureHandlers,
);

afterEach(() => {
  while (instances.length > 0) instances.pop()!.cleanup();
});

describe('G5 Basic Runtime current-schema repair transaction integration', () => {
  afterAll(() => productionFixtureHarness.assertComplete());

  it.each(productionFixtureHarness.fixtures)(
    '$category $case_id executes $operation.kind and its exact durable oracle',
    (fixture) => {
      const receipt = productionFixtureHarness.execute(fixture);
      expect(receipt).toEqual({
        case_id: fixture.case_id,
        category: fixture.category,
        surface: fixture.surface,
        handler: fixture.handler,
        operation_kind: fixture.operation.kind,
        oracle: fixture.oracle,
      });
    },
  );

  it('atomically persists nested and shared static child Plans with exact replay and reopen', () => {
    const instance = bootstrap('static-child-plan-bundle-atomic');
    const seed = seedRuntime(instance.store);
    const fixture = staticChildBundleFixture(seed);
    pinTestDefinitionPlan(instance.store, seed, fixture.parentPlan);
    const created = createWorkflowT0(
      instance.store,
      creationInput(seed, 'static-child-plan-bundle-atomic', 10),
    );
    const input: Parameters<typeof persistCompileResultT2a>[1] = {
      graphRunId: created.activation.graphRunId,
      buildId: created.activation.rootBuildId,
      expectedBuildRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedOwnerScopeWorkFenceEpoch: 0,
      expectedCompilerSnapshotHash: hash('compiler-snapshot'),
      expectedBuildLease: null,
      sourceJson: G5_TEST_SOURCE,
      sourceHash: fixture.parentPlan.source_hash as Sha256Hash,
      plan: fixture.parentPlan,
      staticChildPlanBundle: fixture.bundle,
      nowMs: 20,
    };

    expect(() =>
      persistCompileResultT2a(instance.store, input, {
        point: 'before_first_write',
      }),
    ).toThrow(/Injected fault before first write/);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_plans WHERE graph_run_id = ?',
        [created.activation.graphRunId],
      )!.count,
    ).toBe(0);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_plan_generated_schemas WHERE graph_run_id = ?',
        [created.activation.graphRunId],
      )!.count,
    ).toBe(0);

    expect(() =>
      persistCompileResultT2a(instance.store, input, {
        point: 'before_commit',
      }),
    ).toThrow(/Injected fault before commit/);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_plans WHERE graph_run_id = ?',
        [created.activation.graphRunId],
      )!.count,
    ).toBe(0);
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_plan_generated_schemas WHERE graph_run_id = ?',
        [created.activation.graphRunId],
      )!.count,
    ).toBe(0);

    const compiled = persistCompileResultT2a(instance.store, input);
    expect(compiled.disposition).toBe('compiled');
    const planRows = instance.store.queryAll<{
      plan_hash: string;
      compiled_plan_json: string;
    }>(
      `SELECT plan_hash, compiled_plan_json
         FROM workflow_graph_scope_plans
        WHERE graph_run_id = ? ORDER BY plan_hash COLLATE BINARY`,
      [created.activation.graphRunId],
    );
    expect(planRows).toHaveLength(4);
    expect(planRows.map((row) => row.plan_hash)).toEqual(
      [fixture.parentPlan.plan_hash, ...fixture.uniqueChildPlanHashes].sort(),
    );
    const bindingCounts = instance.store.queryAll<{
      plan_hash: string;
      count: number;
    }>(
      `SELECT plan_hash, count(*) AS count
         FROM workflow_plan_generated_schemas
        WHERE graph_run_id = ?
        GROUP BY plan_hash ORDER BY plan_hash COLLATE BINARY`,
      [created.activation.graphRunId],
    );
    expect(bindingCounts).toHaveLength(4);
    expect(bindingCounts.every((row) => row.count > 0)).toBe(true);

    const persistedBytes = canonicalJson({ planRows, bindingCounts });
    expect(persistCompileResultT2a(instance.store, input).disposition).toBe(
      'exact_replay',
    );
    expect(
      canonicalJson({
        planRows: instance.store.queryAll<{
          plan_hash: string;
          compiled_plan_json: string;
        }>(
          `SELECT plan_hash, compiled_plan_json
             FROM workflow_graph_scope_plans
            WHERE graph_run_id = ? ORDER BY plan_hash COLLATE BINARY`,
          [created.activation.graphRunId],
        ),
        bindingCounts: instance.store.queryAll<{
          plan_hash: string;
          count: number;
        }>(
          `SELECT plan_hash, count(*) AS count
             FROM workflow_plan_generated_schemas
            WHERE graph_run_id = ?
            GROUP BY plan_hash ORDER BY plan_hash COLLATE BINARY`,
          [created.activation.graphRunId],
        ),
      }),
    ).toBe(persistedBytes);

    instance.closeStore();
    instance.reopenStore();
    expect(persistCompileResultT2a(instance.store, input).disposition).toBe(
      'exact_replay',
    );

    const childHash = fixture.uniqueChildPlanHashes[0]!;
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        "UPDATE workflow_graph_scope_plans SET compiled_plan_json = '{}' WHERE graph_run_id = ? AND plan_hash = ?",
        [created.activation.graphRunId, childHash],
      );
    });
    expect(() => persistCompileResultT2a(instance.store, input)).toThrow(
      /content-addressed Plan collision/,
    );
    const child = fixture.bundle.entries.find(
      (entry) => entry.plan.plan_hash === childHash,
    )!;
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_graph_scope_plans SET compiled_plan_json = ? WHERE graph_run_id = ? AND plan_hash = ?',
        [canonicalJson(child.plan), created.activation.graphRunId, childHash],
      );
      transaction.execute(
        `DELETE FROM workflow_plan_generated_schemas
          WHERE rowid = (
            SELECT min(rowid) FROM workflow_plan_generated_schemas
             WHERE graph_run_id = ? AND plan_hash = ?
          )`,
        [created.activation.graphRunId, childHash],
      );
    });
    expect(() => persistCompileResultT2a(instance.store, input)).toThrow(
      /generated schema binding set drifted/,
    );
  });

  it('rejects partial, extra, duplicate, aliased, tampered, and stale static child bundles without writes', () => {
    const instance = bootstrap('static-child-plan-bundle-negative');
    const seed = seedRuntime(instance.store);
    const fixture = staticChildBundleFixture(seed);
    pinTestDefinitionPlan(instance.store, seed, fixture.parentPlan);
    const created = createWorkflowT0(
      instance.store,
      creationInput(seed, 'static-child-plan-bundle-negative', 10),
    );
    const input: Parameters<typeof persistCompileResultT2a>[1] = {
      graphRunId: created.activation.graphRunId,
      buildId: created.activation.rootBuildId,
      expectedBuildRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedOwnerScopeWorkFenceEpoch: 0,
      expectedCompilerSnapshotHash: hash('compiler-snapshot'),
      expectedBuildLease: null,
      sourceJson: G5_TEST_SOURCE,
      sourceHash: fixture.parentPlan.source_hash as Sha256Hash,
      plan: fixture.parentPlan,
      staticChildPlanBundle: fixture.bundle,
      nowMs: 20,
    };
    const mutations: Array<WorkflowCompilerStaticChildPlanBundle> = [
      { ...fixture.bundle, entries: fixture.bundle.entries.slice(0, -1) },
      {
        ...fixture.bundle,
        entries: [...fixture.bundle.entries, fixture.bundle.entries[0]!],
      },
      {
        ...fixture.bundle,
        entries: [
          fixture.bundle.entries[1]!,
          fixture.bundle.entries[0]!,
          ...fixture.bundle.entries.slice(2),
        ],
      },
      {
        ...fixture.bundle,
        entries: fixture.bundle.entries.map((entry, index) =>
          index === 3 ? fixture.bundle.entries[1]! : entry,
        ),
      },
      {
        ...fixture.bundle,
        entries: fixture.bundle.entries.map((entry, index) =>
          index === 0 ? { ...entry, closureKey: 'alias' } : entry,
        ),
      },
      {
        ...fixture.bundle,
        entries: fixture.bundle.entries.map((entry, index) =>
          index === 0
            ? { ...entry, source: { ...entry.source, tampered: true } }
            : entry,
        ),
      },
      {
        ...fixture.bundle,
        entries: fixture.bundle.entries.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                plan: {
                  ...entry.plan,
                  capability_catalog_hash: hash('tampered-catalog'),
                },
              }
            : entry,
        ),
      },
    ];
    for (const staticChildPlanBundle of mutations) {
      expect(() =>
        persistCompileResultT2a(instance.store, {
          ...input,
          staticChildPlanBundle,
        }),
      ).toThrow();
    }
    for (const staticChildPlanBundle of [
      {
        ...fixture.bundle,
        unknown: true,
      } as unknown as WorkflowCompilerStaticChildPlanBundle,
      {
        ...fixture.bundle,
        entries: fixture.bundle.entries.map((entry, index) =>
          index === 0
            ? ({ ...entry, unknown: true } as unknown as typeof entry)
            : entry,
        ),
      },
    ]) {
      expect(() =>
        persistCompileResultT2a(instance.store, {
          ...input,
          staticChildPlanBundle,
        }),
      ).toThrow(/unknown|closed shape/);
    }
    const replaceChildPlan = (
      entryIndex: number,
      childPlan: CompiledScopePlanV2Document,
    ): {
      parentPlan: CompiledScopePlanV2Document;
      bundle: WorkflowCompilerStaticChildPlanBundle;
    } => {
      const bundle = structuredClone(fixture.bundle);
      bundle.entries[entryIndex] = {
        ...bundle.entries[entryIndex]!,
        plan: childPlan,
      };
      const members = structuredClone(
        fixture.parentPlan.static_child_plan_closure.members,
      );
      const { member_hash: _memberHash, ...memberWithoutHash } =
        members[entryIndex]!;
      void _memberHash;
      const rebuiltMember = {
        ...memberWithoutHash,
        plan_ref: `content-addressed:workflow-plan/${childPlan.plan_hash.slice('sha256:'.length)}`,
        plan_hash: childPlan.plan_hash as Sha256Hash,
        interface_snapshot_hash:
          childPlan.interface_snapshot_hash as Sha256Hash,
      };
      members[entryIndex] = {
        ...rebuiltMember,
        member_hash: domainSeparatedSha256(
          STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
          rebuiltMember,
        ),
      };
      const { plan_hash: _parentHash, ...parentWithoutHash } =
        fixture.parentPlan;
      void _parentHash;
      return {
        parentPlan: withPlanHash({
          ...parentWithoutHash,
          static_child_plan_closure: staticChildClosure(members),
        }),
        bundle,
      };
    };
    const nestedEntry = fixture.bundle.entries[0]!;
    const { plan_hash: _nestedHash, ...nestedWithoutHash } = nestedEntry.plan;
    void _nestedHash;
    const nestedLineageDrift = replaceChildPlan(
      0,
      withPlanHash({
        ...nestedWithoutHash,
        static_child_plan_closure: emptyStaticChildPlanClosure(),
      }),
    );
    const authorityDrifts = (
      [
        ['compiler_version', '0.0.0'],
        ['runtime_safety_hash', hash('tampered-child-safety')],
      ] as const
    ).map(([key, value]) => {
      const { plan_hash: _childHash, ...childWithoutHash } = nestedEntry.plan;
      void _childHash;
      return [
        key,
        replaceChildPlan(
          0,
          withPlanHash({ ...childWithoutHash, [key]: value }),
        ),
      ] as const;
    });
    for (const [label, drift] of [
      ['nested_lineage', nestedLineageDrift] as const,
      ...authorityDrifts,
    ]) {
      expect(
        () =>
          persistCompileResultT2a(instance.store, {
            ...input,
            plan: drift.parentPlan,
            staticChildPlanBundle: drift.bundle,
          }),
        label,
      ).toThrow(/malformed|nested lineage|content or authority drifted/);
    }
    expect(() =>
      persistCompileResultT2a(instance.store, {
        ...input,
        expectedBuildLease: {
          owner: 'stale-owner',
          token: 'stale-token',
          expiresAtMs: input.nowMs + 1_000,
        },
      }),
    ).toThrow(/lease, epoch, hash, or row version is stale/);
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_graph_runs SET work_fence_epoch = 1 WHERE id = ?',
        [created.activation.graphRunId],
      );
    });
    expect(() => persistCompileResultT2a(instance.store, input)).toThrow(
      /lease, epoch, hash, or row version is stale/,
    );
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_graph_runs SET work_fence_epoch = 0 WHERE id = ?',
        [created.activation.graphRunId],
      );
      transaction.execute(
        'UPDATE workflow_graph_scopes SET work_fence_epoch = 1 WHERE id = ?',
        [created.activation.rootScopeId],
      );
    });
    expect(() => persistCompileResultT2a(instance.store, input)).toThrow(
      /lease, epoch, hash, or row version is stale/,
    );
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_graph_scopes SET work_fence_epoch = 0 WHERE id = ?',
        [created.activation.rootScopeId],
      );
    });
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_plans WHERE graph_run_id = ?',
        [created.activation.graphRunId],
      )!.count,
    ).toBe(0);
    expect(
      instance.store.queryOne<{ status: string }>(
        'SELECT status FROM workflow_graph_scope_builds WHERE id = ?',
        [created.activation.rootBuildId],
      )!.status,
    ).toBe('ready_to_compile');
  });

  it('requires an exact live compile lease before persisting the static child bundle', () => {
    const instance = bootstrap('static-child-plan-bundle-lease');
    const seed = seedRuntime(instance.store);
    const fixture = staticChildBundleFixture(seed);
    pinTestDefinitionPlan(instance.store, seed, fixture.parentPlan);
    const created = createWorkflowT0(
      instance.store,
      creationInput(seed, 'static-child-plan-bundle-lease', 10),
    );
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_scope_builds
            SET status = 'compiling', lease_owner = ?, lease_token = ?,
                lease_expires_at_ms = ?, row_version = 2
          WHERE id = ?`,
        [
          'compiler-worker',
          'compile-token',
          20,
          created.activation.rootBuildId,
        ],
      );
    });
    const expiredInput: Parameters<typeof persistCompileResultT2a>[1] = {
      graphRunId: created.activation.graphRunId,
      buildId: created.activation.rootBuildId,
      expectedBuildRowVersion: 2,
      expectedRunWorkFenceEpoch: 0,
      expectedOwnerScopeWorkFenceEpoch: 0,
      expectedCompilerSnapshotHash: hash('compiler-snapshot'),
      expectedBuildLease: {
        owner: 'compiler-worker',
        token: 'compile-token',
        expiresAtMs: 20,
      },
      sourceJson: G5_TEST_SOURCE,
      sourceHash: fixture.parentPlan.source_hash as Sha256Hash,
      plan: fixture.parentPlan,
      staticChildPlanBundle: fixture.bundle,
      nowMs: 20,
    };
    expect(() => persistCompileResultT2a(instance.store, expiredInput)).toThrow(
      /lease, epoch, hash, or row version is stale/,
    );

    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `UPDATE workflow_graph_scope_builds
            SET lease_expires_at_ms = 100, row_version = row_version + 1
          WHERE id = ?`,
        [created.activation.rootBuildId],
      );
    });
    const liveInput: Parameters<typeof persistCompileResultT2a>[1] = {
      ...expiredInput,
      expectedBuildRowVersion: 3,
      expectedBuildLease: {
        owner: 'compiler-worker',
        token: 'compile-token',
        expiresAtMs: 100,
      },
    };
    for (const expectedBuildLease of [
      { ...liveInput.expectedBuildLease!, owner: 'other-worker' },
      { ...liveInput.expectedBuildLease!, token: 'other-token' },
      { ...liveInput.expectedBuildLease!, expiresAtMs: 101 },
    ]) {
      expect(() =>
        persistCompileResultT2a(instance.store, {
          ...liveInput,
          expectedBuildLease,
        }),
      ).toThrow(/lease, epoch, hash, or row version is stale/);
    }
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_graph_scope_plans WHERE graph_run_id = ?',
        [created.activation.graphRunId],
      )!.count,
    ).toBe(0);

    expect(persistCompileResultT2a(instance.store, liveInput).disposition).toBe(
      'compiled',
    );
    expect(
      instance.store.queryOne<{
        status: string;
        lease_owner: string | null;
        lease_token: string | null;
        lease_expires_at_ms: number | null;
        row_version: number;
      }>(
        `SELECT status, lease_owner, lease_token, lease_expires_at_ms, row_version
           FROM workflow_graph_scope_builds WHERE id = ?`,
        [created.activation.rootBuildId],
      ),
    ).toEqual({
      status: 'compiled',
      lease_owner: null,
      lease_token: null,
      lease_expires_at_ms: null,
      row_version: 4,
    });
  });

  it('rejects join_optional_absent model-as-member and required Plan mutations', () => {
    const schemaHash = hash('join-optional-absent-adversarial-schema');
    const modeled = referenceJoinPublication({
      planHash: hash('join-optional-absent-adversarial-plan'),
      nodeId: 'fixture-output',
      outputs: {
        result: {
          inputPort: 'source',
          schemaHash,
          required: false,
          maxBytes: 16_384,
        },
      },
      sealedPorts: { source: { state: 'absent' } },
    });
    const modeledPort = (modeled.ports as JsonObject).result as JsonObject;
    const optionalContract: JsonObject = {
      schema: { schema_hash: schemaHash },
      max_bytes: 16_384,
      required: false,
    };
    const falsePositivePayload = modeled;
    const falsePositiveBytes = canonicalJson(falsePositivePayload);
    expect(() =>
      assertReferenceNodeOutputPort({
        caseId: 'join_optional_absent',
        modeledPort,
        planContract: optionalContract,
        actualPort: {
          state: 'present',
          value_ref: 'value:false-positive-model-member',
          value_hash: hash(`false-positive:${falsePositiveBytes}`),
          schema_hash: schemaHash,
          byte_length: Buffer.byteLength(falsePositiveBytes),
        },
      }),
    ).toThrow(/reference publication state drifted/);
    expect(() =>
      assertReferenceNodeOutputPort({
        caseId: 'join_optional_absent',
        modeledPort,
        planContract: { ...optionalContract, required: true },
        actualPort: modeledPort,
      }),
    ).toThrow(/required\/optional Plan drifted/);
  });

  it('commits T0/T1/T2a/T2b/T3a and exact replays across reopen', () => {
    const instance = bootstrap('g5-runtime-path');
    const seed = seedRuntime(instance.store);
    const creationInput = {
      requestId: 'request-1',
      creationDomain: 'assistant',
      creationKey: 'task-1',
      source: 'api' as const,
      actor: 'system' as const,
      launchPolicy: 'auto' as const,
      launchAuthorization: {
        kind: 'trusted_system' as const,
        authorizationRef: 'test:task-1',
      },
      entryPoint: 'default',
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
        acquireCurrentDomainClaim(transaction, sharedClaimInput).disposition,
      ).toBe('acquired');
    });
    expect(() =>
      instance.store.withImmediateTransaction((transaction) =>
        acquireCurrentDomainClaim(transaction, {
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
        acquireCurrentDomainClaim(transaction, exclusiveClaimInput).disposition,
      ).toBe('acquired');
    });
    expect(() =>
      instance.store.withImmediateTransaction((transaction) =>
        acquireCurrentDomainClaim(transaction, {
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
      actor: 'system',
      launchPolicy: 'auto',
      launchAuthorization: {
        kind: 'trusted_system',
        authorizationRef: 'test:task-1',
      },
      entryPoint: 'default',
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
      expectedBuildLease: null,
      sourceJson: G5_TEST_SOURCE,
      sourceHash: compiledPlan.source_hash as Sha256Hash,
      plan: compiledPlan,
      staticChildPlanBundle: EMPTY_STATIC_CHILD_PLAN_BUNDLE,
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
      manifestSchema: g5FenceManifestSchema(),
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
    const capacity = fixedCapacity();
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
      verifyPublishedNodeOutputEnvelope(
        instance,
        activated.graphRunId,
        compiledPlan,
        'pause',
      ).content.ports,
    ).toMatchObject({
      resolution: {
        state: 'present',
        schema_hash: seed.refs.schema.hash,
      },
    });
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
      outputPorts: null,
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
        outputPorts: { result: seed.values.result },
        evaluation: null,
        feedback: null,
        errorCode: null,
        factPayload: seed.values.result,
        nowMs: 125,
      }).disposition,
    ).toBe('terminal');
    expect(
      verifyPublishedNodeOutputEnvelope(
        instance,
        activated.graphRunId,
        compiledPlan,
        'work',
      ).content.ports,
    ).toMatchObject({
      result: {
        state: 'present',
        schema_hash: seed.refs.schema.hash,
      },
    });
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
      outputPorts: null,
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
        outputPorts: { result: seed.values.result },
      }),
    ).toThrow(/duplicate result bytes drifted/);
    const runBeforeReconcile = instance.store.queryOne<{
      row_version: number;
    }>('SELECT row_version FROM workflow_graph_runs WHERE id = ?', [
      activated.graphRunId,
    ])!;
    const workOutput = instance.store.queryOne<{
      id: string;
      hash: Sha256Hash;
    }>(
      `SELECT published_output_envelope_value_id AS id,
              published_output_envelope_hash AS hash
         FROM workflow_graph_nodes WHERE id = ?`,
      [workNode.id],
    )!;
    reconcileFactT3a(instance.store, {
      graphRunId: activated.graphRunId,
      scopeId: activated.rootScopeId,
      expectedRunRowVersion: runBeforeReconcile.row_version,
      factKind: 'node_terminal',
      stableObjectKind: 'node',
      stableObjectId: workNode.id,
      factKey: `node-terminal-reconcile:${workNode.id}`,
      payload: workOutput,
      manifestSchema: g5FenceManifestSchema(),
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
    const joinOutput = instance.store.queryOne<{
      id: string;
      hash: Sha256Hash;
    }>(
      'SELECT published_output_envelope_value_id AS id, published_output_envelope_hash AS hash FROM workflow_graph_nodes WHERE id = ?',
      [joinNode.id],
    )!;
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
      payload: joinOutput,
      manifestSchema: g5FenceManifestSchema(),
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
      manifestSchema: g5FenceManifestSchema(),
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
      seed.values.result.id,
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
    const objectSchemaJson: JsonObject = {
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
    };
    const objectSchema = publishTestSchema(
      instance.store,
      seed,
      'selected-object',
      objectSchemaJson,
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
    const sourceInput = inputPort(objectSchema);
    const sourceOutputSchema = buildGeneratedSchema(
      'join_expose',
      {
        node_id: 'source',
        output_port: 'result',
        input_port: 'value',
        input_schema: sourceInput.schema as JsonValue,
        aggregation: sourceInput.aggregation as JsonValue,
        max_bytes: sourceInput.max_bytes as JsonValue,
        required: true,
      },
      objectSchemaJson,
    );
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
          input_ports: { value: sourceInput },
          expose: { result: { input_port: 'value' } },
          output_ports: {
            result: {
              schema: sourceOutputSchema,
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
          'source-input-edge',
          'source',
          { type: 'scope_input', port: 'result' },
          objectSchema,
        ),
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
        {
          ...dataEdge(
            'node-direct-edge',
            'node-direct',
            { type: 'node_output', node_id: 'source', port: 'result' },
            objectSchema,
          ),
          derived_schema: sourceOutputSchema,
          producer_schema_hash: sourceOutputSchema.schema_hash,
          compatibility_proof: {
            producer_schema_hash: sourceOutputSchema.schema_hash,
            proof_hash: hash('selected-edge-proof:node-direct-edge'),
          },
        },
        {
          ...dataEdge(
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
          producer_schema_hash: sourceOutputSchema.schema_hash,
          compatibility_proof: {
            producer_schema_hash: sourceOutputSchema.schema_hash,
            proof_hash: hash('selected-edge-proof:node-pointer-edge'),
          },
        },
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
      value_value_id: expect.stringMatching(/^g5:node-output-member:/),
      value_hash: expect.stringMatching(/^sha256:/),
    });
    expect(
      instance.store.queryOne<{
        schema_authority_kind: string;
        schema_resource_id: string | null;
        generated_schema_hash: string;
      }>(
        'SELECT schema_authority_kind, schema_resource_id, generated_schema_hash FROM workflow_values WHERE id = ?',
        [byEdge.get('node-direct-edge')!.value_value_id],
      ),
    ).toEqual({
      schema_authority_kind: 'plan_generated',
      schema_resource_id: null,
      generated_schema_hash: sourceOutputSchema.schema_hash,
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

  it('publishes canonical generated join outputs across rename, optional, default, list, rollback, reopen, and response loss', () => {
    const instance = bootstrap('g5-generated-join-publication');
    const seed = seedRuntime(instance.store);
    const stringJson: JsonObject = { type: 'string' };
    const arrayJson: JsonObject = { type: 'array', items: stringJson };
    const stringSchema = publishTestSchema(
      instance.store,
      seed,
      'generated-join-string',
      stringJson,
    );
    const arraySchema = publishTestSchema(
      instance.store,
      seed,
      'generated-join-array',
      arrayJson,
    );
    const values = {
      renamed: insertTestValue(
        instance.store,
        stringSchema,
        'generated-join-renamed',
        'renamed-value',
      ),
      first: insertTestValue(
        instance.store,
        stringSchema,
        'generated-join-first',
        'first',
      ),
      second: insertTestValue(
        instance.store,
        stringSchema,
        'generated-join-second',
        'second',
      ),
    };
    replaceSeedInputContent(instance.store, seed, {
      port_contract_hash: hash('generated-join-root-contract'),
      ports: Object.fromEntries(
        Object.entries(values).map(([port, value]) => [
          port,
          {
            state: 'present',
            value_ref: value.id,
            value_hash: value.hash,
            schema_hash: stringSchema.schema_hash,
            byte_length: value.byteLength,
          },
        ]),
      ),
      envelope_hash: hash('generated-join-root-envelope'),
    });
    const single = (required: boolean, defaultValue?: string): JsonObject => ({
      schema: compiledTestSchema(stringSchema),
      max_bytes: 128,
      aggregation: {
        type: 'single',
        select: 'only',
        required,
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
      },
    });
    const inputs: JsonObject = {
      original: single(true),
      optional: single(false),
      defaulted: single(false, 'fallback'),
      collected: {
        schema: compiledTestSchema(arraySchema),
        item_schema: compiledTestSchema(stringSchema),
        max_bytes: 256,
        item_max_bytes: 128,
        aggregation: {
          type: 'list',
          order: 'edge_id',
          min_items: 1,
          seal: { type: 'all_sources_resolved' },
        },
      },
    };
    const expose: JsonObject = {
      renamed: { input_port: 'original' },
      optional: { input_port: 'optional' },
      defaulted: { input_port: 'defaulted' },
      collected: { input_port: 'collected' },
    };
    const outputSchema = (
      outputName: string,
      inputName: string,
      schemaJson: JsonObject,
    ): JsonObject => {
      const contract = inputs[inputName] as JsonObject;
      const aggregation = contract.aggregation as JsonObject;
      const required =
        aggregation.type === 'list' ||
        aggregation.required === true ||
        Object.prototype.hasOwnProperty.call(aggregation, 'default');
      return buildGeneratedSchema(
        'join_expose',
        {
          node_id: 'join',
          output_port: outputName,
          input_port: inputName,
          input_schema: contract.schema as JsonValue,
          aggregation,
          max_bytes: contract.max_bytes as JsonValue,
          required,
          ...(aggregation.type === 'list'
            ? {
                item_schema: contract.item_schema as JsonValue,
                item_max_bytes: contract.item_max_bytes as JsonValue,
              }
            : {}),
        },
        schemaJson,
      );
    };
    const outputs: JsonObject = Object.fromEntries(
      Object.entries(expose).map(([outputName, exposure]) => {
        const inputName = String((exposure as JsonObject).input_port);
        const input = inputs[inputName] as JsonObject;
        const aggregation = input.aggregation as JsonObject;
        return [
          outputName,
          {
            schema: outputSchema(
              outputName,
              inputName,
              inputName === 'collected' ? arrayJson : stringJson,
            ),
            max_bytes: input.max_bytes,
            required:
              aggregation.type === 'list' ||
              aggregation.required === true ||
              Object.prototype.hasOwnProperty.call(aggregation, 'default'),
          },
        ];
      }),
    );
    const edge = (
      id: string,
      fromPort: string,
      toPort: string,
    ): JsonObject => ({
      id,
      from: { type: 'scope_input', port: fromPort },
      to: { node_id: 'join', port: toPort },
      derived_schema: compiledTestSchema(stringSchema),
      producer_schema_hash: stringSchema.schema_hash,
      consumer_schema_hash: stringSchema.schema_hash,
      on_missing: 'error',
      guard_control_edge_id: null,
      compiled_edge_hash: hash(`generated-join-edge:${id}`),
    });
    const candidate = planVariant(seed, {
      nodes: [
        {
          id: 'join',
          type: 'join',
          capability_binding: null,
          trigger_program: compileTriggerProgram({ type: 'root' }),
          input_ports: inputs,
          expose,
          output_ports: outputs,
        },
      ],
      route_groups: [],
      control_edges: [],
      data_edges: [
        edge('rename-edge', 'renamed', 'original'),
        edge('a-list-edge', 'first', 'collected'),
        edge('z-list-edge', 'second', 'collected'),
      ],
      completion: completionPolicy([
        {
          id: 'generated-join-no-close',
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
    const invalidCandidate = (
      mutate: (value: CompiledScopePlanV2Document) => void,
    ): CompiledScopePlanV2Document => {
      const value = structuredClone(candidate);
      mutate(value);
      const { plan_hash: _planHash, ...withoutHash } = value;
      void _planHash;
      return withPlanHash(withoutHash);
    };
    expect(() =>
      materializePlanCase(
        instance,
        seed,
        invalidCandidate((value) => {
          const schema = (
            (value.nodes[0] as JsonObject).output_ports as JsonObject
          ).renamed as JsonObject;
          (schema.schema as JsonObject).schema_ref =
            `unknown-generated-schema:sha256:${'0'.repeat(64)}`;
        }),
        'generated-join-unknown-scheme',
        150,
      ),
    ).toThrow(/generated schema authority is invalid/);
    expect(() =>
      materializePlanCase(
        instance,
        seed,
        invalidCandidate((value) => {
          const schema = (
            (value.nodes[0] as JsonObject).output_ports as JsonObject
          ).renamed as JsonObject;
          (schema.schema as JsonObject).parameter_hash = hash(
            'generated-join-parameter-drift',
          );
        }),
        'generated-join-parameter-drift',
        160,
      ),
    ).toThrow(/contract or parameter binding drifted/);
    expect(() =>
      materializePlanCase(
        instance,
        seed,
        invalidCandidate((value) => {
          delete ((value.nodes[0] as JsonObject).expose as JsonObject).optional;
        }),
        'generated-join-shape-drift',
        170,
      ),
    ).toThrow(/expose\/output port shape mismatch/);
    const missingBinding = materializePlanCase(
      instance,
      seed,
      candidate,
      'generated-join-missing-binding',
      180,
    );
    initializePlanCase(instance, missingBinding, 183);
    const missingBindingNode = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'join'",
      [missingBinding.graphRunId],
    )!;
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        `DELETE FROM workflow_plan_generated_schemas
          WHERE plan_id = (
            SELECT compiled_plan_id FROM workflow_graph_scope_builds
             WHERE graph_run_id = ?
          ) AND rowid = (
            SELECT min(rowid) FROM workflow_plan_generated_schemas
             WHERE plan_id = (
               SELECT compiled_plan_id FROM workflow_graph_scope_builds
                WHERE graph_run_id = ?
             )
          )`,
        [missingBinding.graphRunId, missingBinding.graphRunId],
      );
    });
    expect(() =>
      scheduleReadyNodeT4(
        instance.store,
        { current: () => fixedCapacity() },
        {
          graphRunId: missingBinding.graphRunId,
          scopeId: missingBinding.scopeId,
          nodeId: missingBindingNode.id,
          expectedNodeRowVersion: missingBindingNode.row_version,
          expectedRunWorkFenceEpoch: 0,
          expectedScopeWorkFenceEpoch: 0,
          eligibleEventSeq: missingBindingNode.activation_event_seq,
          activation: { kind: 'structural' },
          nowMs: 184,
        },
      ),
    ).toThrow(/binding set drifted/);
    const run = materializePlanCase(
      instance,
      seed,
      candidate,
      'generated-join-publication',
      200,
    );
    initializePlanCase(instance, run, 203);
    const node = instance.store.queryOne<{
      id: string;
      row_version: number;
      activation_event_seq: number;
    }>(
      "SELECT id, row_version, activation_event_seq FROM workflow_graph_nodes WHERE graph_run_id = ? AND node_key = 'join'",
      [run.graphRunId],
    )!;
    const activation = {
      graphRunId: run.graphRunId,
      scopeId: run.scopeId,
      nodeId: node.id,
      expectedNodeRowVersion: node.row_version,
      expectedRunWorkFenceEpoch: 0,
      expectedScopeWorkFenceEpoch: 0,
      eligibleEventSeq: node.activation_event_seq,
      activation: { kind: 'structural' as const },
      nowMs: 204,
    };
    expect(() =>
      scheduleReadyNodeT4(
        instance.store,
        { current: () => fixedCapacity() },
        activation,
        { point: 'before_commit' },
      ),
    ).toThrow(/Injected (?:G5 )?fault/);
    expect(
      instance.store.queryOne<{ count: number }>(
        "SELECT count(*) AS count FROM workflow_values WHERE provenance_ref LIKE 'join-output:%' OR provenance_ref LIKE 'node-output-envelope:%'",
        [],
      )!.count,
    ).toBe(0);
    expect(
      scheduleReadyNodeT4(
        instance.store,
        { current: () => fixedCapacity() },
        activation,
      ).disposition,
    ).toBe('activated');
    expect(
      scheduleReadyNodeT4(
        instance.store,
        { current: () => fixedCapacity() },
        activation,
      ).disposition,
    ).toBe('exact_replay');
    instance.closeStore();
    instance.reopenStore();
    expect(
      scheduleReadyNodeT4(
        instance.store,
        { current: () => fixedCapacity() },
        activation,
      ).disposition,
    ).toBe('exact_replay');
    const publication = instance.store.queryOne<{
      id: string;
      hash: Sha256Hash;
      inline_canonical_json: string;
    }>(
      `SELECT n.published_output_envelope_value_id AS id,
              n.published_output_envelope_hash AS hash, v.inline_canonical_json
         FROM workflow_graph_nodes n JOIN workflow_values v
           ON v.id = n.published_output_envelope_value_id
          AND v.content_hash = n.published_output_envelope_hash
        WHERE n.id = ?`,
      [node.id],
    )!;
    const envelope = JSON.parse(
      publication.inline_canonical_json,
    ) as JsonObject;
    const verifiedEnvelope = verifyPublishedNodeOutputEnvelope(
      instance,
      run.graphRunId,
      run.plan,
      'join',
    );
    expect(verifiedEnvelope.content).toEqual(envelope);
    expect(
      new NodeOutputEnvelopeValueStore(
        instance.store,
      ).verifyReopenAndRecovery(),
    ).toContainEqual(verifiedEnvelope);
    expect(envelope.envelope_hash).toBe(publication.hash);
    const ports = envelope.ports as JsonObject;
    expect((ports.optional as JsonObject).state).toBe('absent');
    const expectedContent: Record<string, JsonValue> = {
      renamed: 'renamed-value',
      defaulted: 'fallback',
      collected: ['first', 'second'],
    };
    for (const [port, content] of Object.entries(expectedContent)) {
      const published = ports[port] as JsonObject;
      const row = instance.store.queryOne<{
        inline_canonical_json: string;
        schema_authority_kind: string;
        schema_resource_id: string | null;
        schema_plan_id: string;
        generated_schema_hash: string;
      }>(
        `SELECT inline_canonical_json, schema_authority_kind,
                schema_resource_id, schema_plan_id, generated_schema_hash
           FROM workflow_values WHERE id = ? AND content_hash = ?`,
        [String(published.value_ref), String(published.value_hash)],
      )!;
      expect(JSON.parse(row.inline_canonical_json)).toEqual(content);
      expect(row).toMatchObject({
        schema_authority_kind: 'plan_generated',
        schema_resource_id: null,
        generated_schema_hash: (outputs[port] as JsonObject).schema
          ? ((outputs[port] as JsonObject).schema as JsonObject).schema_hash
          : undefined,
      });
    }
    expect(
      instance.store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_plan_generated_schemas WHERE plan_id = (SELECT compiled_plan_id FROM workflow_graph_scope_builds WHERE graph_run_id = ?)',
        [run.graphRunId],
      )!.count,
    ).toBe(5);
    const generatedContent = instance.store.queryOne<{
      schema_ref: string;
      canonical_schema_json: string;
    }>(
      'SELECT schema_ref, canonical_schema_json FROM workflow_generated_schema_contents ORDER BY schema_ref COLLATE BINARY LIMIT 1',
      [],
    )!;
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_generated_schema_contents SET canonical_schema_json = ? WHERE schema_ref = ?',
        ['{}', generatedContent.schema_ref],
      );
    });
    expect(() =>
      scheduleReadyNodeT4(
        instance.store,
        { current: () => fixedCapacity() },
        activation,
      ),
    ).toThrow(/generated schema bytes\/hash drifted/);
    instance.store.withImmediateTransaction((transaction) => {
      transaction.execute(
        'UPDATE workflow_generated_schema_contents SET canonical_schema_json = ? WHERE schema_ref = ?',
        [generatedContent.canonical_schema_json, generatedContent.schema_ref],
      );
      transaction.execute(
        'UPDATE workflow_graph_nodes SET port_contract_hash = ? WHERE id = ?',
        [hash('generated-join-port-contract-drift'), node.id],
      );
    });
    expect(() =>
      scheduleReadyNodeT4(
        instance.store,
        { current: () => fixedCapacity() },
        activation,
      ),
    ).toThrow(/output port Contract drifted/);
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
          manifestSchema: g5FenceManifestSchema(),
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
      actor: 'system' as const,
      launchPolicy: 'auto' as const,
      launchAuthorization: {
        kind: 'trusted_system' as const,
        authorizationRef: 'test:negative-boundaries',
      },
      entryPoint: 'default',
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
    const compiledPlan = plan(seed);
    const compileInput = {
      graphRunId: created.activation.graphRunId,
      buildId: created.activation.rootBuildId,
      expectedBuildRowVersion: 1,
      expectedRunWorkFenceEpoch: 0,
      expectedOwnerScopeWorkFenceEpoch: 0,
      expectedCompilerSnapshotHash: hash('compiler-snapshot'),
      expectedBuildLease: null,
      sourceJson: G5_TEST_SOURCE,
      sourceHash: compiledPlan.source_hash as Sha256Hash,
      plan: compiledPlan,
      staticChildPlanBundle: EMPTY_STATIC_CHILD_PLAN_BUNDLE,
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
    ).toThrow(/Plan version or safety compatibility drift/);
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
    ).toThrow(/precondition failed/);
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
      manifestSchema: g5FenceManifestSchema(),
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
          actor: 'system',
          launchPolicy: 'auto',
          launchAuthorization: {
            kind: 'trusted_system',
            authorizationRef: `test:${creationKey}`,
          },
          entryPoint: 'default',
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
          expectedBuildLease: null,
          sourceJson: G5_TEST_SOURCE,
          sourceHash: compiledPlan.source_hash as Sha256Hash,
          plan: compiledPlan,
          staticChildPlanBundle: EMPTY_STATIC_CHILD_PLAN_BUNDLE,
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
          manifestSchema: g5FenceManifestSchema(),
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
        const capacity = fixedCapacity();
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
          outputPorts: succeeds ? { result: seed.values.result } : null,
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
  }, 15_000);
});
