import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';
import { G5_REPAIR_DATABASE_SCHEMA_HASH } from '../contracts/g5-basic-runtime-repair-types.js';
import type { JsonObject, Sha256Hash } from '../contracts/types.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  activateWorkflowT1InTransaction,
  type T1ActivationInput,
  type T1ActivationReceipt,
} from '../runtime/lifecycle.js';
import { acquireCurrentDomainClaim } from './domain-claims.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  assertNoDeferredForeignKeyViolations,
  runImmediateG5Transaction,
  stableRuntimeId,
  type G5TransactionFault,
} from '../runtime/graph-store.js';

export interface T0CreationInput {
  readonly requestId: string;
  readonly creationDomain: string;
  readonly creationKey: string;
  readonly source: 'global_assistant' | 'feature_ui' | 'schedule' | 'api';
  readonly principalRef: string;
  readonly recipe: RuntimeRegistryRef;
  readonly definition: RuntimeRegistryRef;
  readonly executionPolicy: RuntimeRegistryRef;
  readonly commandPolicy: RuntimeRegistryRef;
  readonly inputSchema: RuntimeRegistryRef;
  readonly contextContract: RuntimeRegistryRef;
  readonly routingScope: RuntimeRegistryRef;
  readonly input: RuntimeValueRef;
  readonly attachments: RuntimeValueRef;
  readonly contextSnapshot: RuntimeValueRef;
  readonly routingDecision: RuntimeValueRef;
  readonly routingDecisionJson: JsonObject;
  readonly runtimeSafetyHash: Sha256Hash;
  readonly ownershipHash: Sha256Hash;
  readonly creationIntentHash: Sha256Hash;
  readonly workflowDefinitionVersion: string;
  readonly recipeVersion: string;
  readonly deadlineAtMs: number | null;
  readonly resourceLimits: Readonly<Record<string, number>>;
  readonly domainClaims: readonly {
    namespace: string;
    keyHash: Sha256Hash;
    mode: 'shared' | 'exclusive';
  }[];
  readonly initialActivation: Omit<
    T1ActivationInput,
    'workflowId' | 'expectedWorkflowRowVersion'
  >;
  readonly nowMs: number;
}

export interface T0CreationReceipt {
  readonly disposition: 'created' | 'exact_replay';
  readonly workflowId: string;
  readonly intakeId: string;
  readonly creationRequestId: string;
  readonly activation: T1ActivationReceipt;
}

export function calculateCreationIntentHash(input: {
  readonly creationDomain: string;
  readonly creationKey: string;
  readonly principalRef: string;
  readonly ownershipHash: Sha256Hash;
  readonly routingScope: RuntimeRegistryRef;
  readonly recipe: RuntimeRegistryRef;
  readonly entryPoint: string;
  readonly inputHash: Sha256Hash;
  readonly attachmentManifestHash: Sha256Hash;
}): Sha256Hash {
  return domainSeparatedSha256('icarus:workflow-creation-intent:1\n', {
    creation_domain: input.creationDomain,
    creation_key: input.creationKey,
    principal_scope: input.principalRef,
    ownership_hash: input.ownershipHash,
    routing_scope_ref: input.routingScope.ref,
    routing_scope_hash: input.routingScope.hash,
    recipe_ref: input.recipe.ref,
    recipe_hash: input.recipe.hash,
    entry_point: input.entryPoint,
    effective_input_hash: input.inputHash,
    attachment_manifest_hash: input.attachmentManifestHash,
  });
}

export function createWorkflowT0(
  store: WorkflowRuntimeStore,
  input: T0CreationInput,
  fault?: G5TransactionFault,
): T0CreationReceipt {
  if (
    store.frozenInputs.schemaHash !== G5_REPAIR_DATABASE_SCHEMA_HASH ||
    input.initialActivation.databaseSchemaHash !== store.frozenInputs.schemaHash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T0 requires the current frozen Schema 7 identity',
    );
  const observedCreationIntentHash = calculateCreationIntentHash({
    creationDomain: input.creationDomain,
    creationKey: input.creationKey,
    principalRef: input.principalRef,
    ownershipHash: input.ownershipHash,
    routingScope: input.routingScope,
    recipe: input.recipe,
    entryPoint: 'default',
    inputHash: input.input.hash,
    attachmentManifestHash: input.attachments.hash,
  });
  if (input.creationIntentHash !== observedCreationIntentHash)
    throw new G5RuntimeError(
      'contract_invalid',
      'T0 creation_intent_hash does not match the canonical creation intent',
    );
  if (
    input.runtimeSafetyHash !==
    input.initialActivation.runtimeSafetySnapshot.hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'T0 Workflow and initial Run runtime safety identities differ',
    );
  const intakeId = stableRuntimeId('intake', {
    creation_domain: input.creationDomain,
    creation_key: input.creationKey,
  });
  const revisionId = stableRuntimeId('intake-revision', {
    intake_id: intakeId,
    revision_no: 0,
  });
  const routingId = stableRuntimeId('routing', {
    intake_id: intakeId,
    attempt_no: 1,
  });
  const creationRequestId = stableRuntimeId('creation', {
    creation_domain: input.creationDomain,
    creation_key: input.creationKey,
  });
  const workflowId = stableRuntimeId('workflow', {
    creation_domain: input.creationDomain,
    creation_key: input.creationKey,
  });
  const contextSnapshotId = stableRuntimeId('context', {
    workflow_id: workflowId,
    revision: 0,
  });
  const activationId = stableRuntimeId('activation', {
    workflow_id: workflowId,
    activation_no: 1,
  });
  const graphRunId = stableRuntimeId('run', {
    workflow_id: workflowId,
    graph_run_no: 1,
  });
  const replayActivation: T1ActivationReceipt = {
    activationId,
    graphRunId,
    rootScopeId: stableRuntimeId('scope', {
      graph_run_id: graphRunId,
      scope_kind: 'root',
    }),
    rootBuildId: stableRuntimeId('build', {
      graph_run_id: graphRunId,
      invocation_key: 'root',
    }),
    disposition: 'exact_replay',
  };
  const revisionHash = input.input.hash;
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      for (const [label, resource] of Object.entries({
        recipe: input.recipe,
        definition: input.definition,
        executionPolicy: input.executionPolicy,
        commandPolicy: input.commandPolicy,
        inputSchema: input.inputSchema,
        contextContract: input.contextContract,
        routingScope: input.routingScope,
      }))
        assertExactPublishedRegistryResource(
          transaction,
          resource,
          `T0 ${label}`,
        );
      const existing = transaction.queryOne<{
        id: string;
        creation_intent_hash: string;
        workflow_id: string | null;
        status: string;
      }>(
        'SELECT id, creation_intent_hash, workflow_id, status FROM workflow_creation_requests WHERE creation_domain = ? AND creation_key = ?',
        [input.creationDomain, input.creationKey],
      );
      if (existing) {
        if (
          existing.creation_intent_hash !== input.creationIntentHash ||
          existing.workflow_id !== workflowId ||
          existing.status !== 'created'
        ) {
          throw new G5RuntimeError(
            'idempotency_conflict',
            'Creation key already binds a different intent',
          );
        }
        return {
          disposition: 'exact_replay',
          workflowId,
          intakeId,
          creationRequestId,
          activation: replayActivation,
        };
      }
      transaction.execute(
        `INSERT INTO workflow_task_intakes (
       id, request_id, creation_domain, creation_key, source, principal_ref,
       routing_scope_resource_id, routing_scope_resource_hash, raw_request_value_id,
       raw_request_hash, initial_input_value_id, initial_input_hash,
       attachment_manifest_value_id, attachment_manifest_hash, explicit_task_kind,
       explicit_recipe_resource_id, status, selected_recipe_resource_id,
       selected_recipe_hash, current_revision_id, current_revision_no,
       current_revision_hash, workflow_id, next_attempt_no, row_version,
       created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, 'created', ?, ?, ?, 0, ?, ?, 2, 1, ?, ?)`,
        [
          intakeId,
          input.requestId,
          input.creationDomain,
          input.creationKey,
          input.source,
          input.principalRef,
          input.routingScope.rowId,
          input.routingScope.hash,
          input.input.id,
          input.input.hash,
          input.attachments.id,
          input.attachments.hash,
          input.recipe.rowId,
          input.recipe.rowId,
          input.recipe.hash,
          revisionId,
          revisionHash,
          workflowId,
          input.nowMs,
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_task_intake_revisions (
       id, intake_id, revision_no, parent_revision_id, amendment_value_id,
       amendment_hash, effective_input_value_id, effective_input_hash,
       attachment_manifest_value_id, attachment_manifest_hash,
       clarification_contract_resource_id, clarification_contract_resource_hash,
       source_routing_attempt_id, actor_kind, principal_ref, idempotency_key,
       revision_hash, created_at_ms
     ) VALUES (?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, 'human', ?, ?, ?, ?)`,
        [
          revisionId,
          intakeId,
          input.input.id,
          input.input.hash,
          input.attachments.id,
          input.attachments.hash,
          input.principalRef,
          input.requestId,
          revisionHash,
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_routing_attempts (
       id, intake_id, attempt_no, intake_revision_id, input_hash,
       parent_scope_resource_id, parent_scope_resource_hash, scope_resource_id,
       scope_resource_hash, router_capability_resource_id,
       router_capability_resource_hash, input_snapshot_value_id,
       input_snapshot_hash, decision_value_id, decision_hash, decision_kind,
       target_resource_id, target_resource_hash, confidence_micros,
       reason_codes_json, missing_fields_json, created_at_ms
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'recipe_selected', ?, ?, 1000000, ?, '[]', ?)`,
        [
          routingId,
          intakeId,
          revisionId,
          input.input.hash,
          input.routingScope.rowId,
          input.routingScope.hash,
          input.routingScope.rowId,
          input.routingScope.hash,
          input.input.id,
          input.input.hash,
          input.routingDecision.id,
          input.routingDecision.hash,
          input.recipe.rowId,
          input.recipe.hash,
          JSON.stringify(input.routingDecisionJson.reason_codes ?? []),
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_creation_requests (
       id, intake_id, creation_mode, creation_domain, creation_key,
       recipe_resource_id, recipe_resource_hash, definition_resource_id,
       definition_resource_hash, entry_point, execution_policy_resource_id,
       execution_policy_resource_hash, input_snapshot_value_id, input_snapshot_hash,
       attachment_manifest_value_id, attachment_manifest_hash, creation_intent_hash,
       runtime_safety_hash, launch_confirmation_id, launch_confirmation_hash,
       status, workflow_id, error_code, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 'direct', ?, ?, ?, ?, ?, ?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'created', ?, NULL, ?, ?)`,
        [
          creationRequestId,
          intakeId,
          input.creationDomain,
          input.creationKey,
          input.recipe.rowId,
          input.recipe.hash,
          input.definition.rowId,
          input.definition.hash,
          input.executionPolicy.rowId,
          input.executionPolicy.hash,
          input.input.id,
          input.input.hash,
          input.attachments.id,
          input.attachments.hash,
          input.creationIntentHash,
          input.runtimeSafetyHash,
          workflowId,
          input.nowMs,
          input.nowMs,
        ],
      );
      const lifetimeAccountId = stableRuntimeId('account', {
        workflow_id: workflowId,
        resource_type: 'descendant_workflows_total',
      });
      transaction.execute(
        `INSERT INTO workflows (
       id, status, operational_state, recipe_resource_id, recipe_resource_hash,
       recipe_version, creation_request_id, creation_domain, creation_key,
       owner_principal_ref, controlling_feature_id, creator_automation_ref,
       ownership_hash, root_workflow_id, parent_workflow_id, workflow_depth,
       lineage_budget_account_id, workflow_execution_policy_resource_id,
       workflow_execution_policy_resource_hash, workflow_command_policy_resource_id,
       workflow_command_policy_resource_hash, workflow_input_value_id,
       workflow_input_hash, workflow_input_schema_resource_id,
       workflow_input_schema_resource_hash, context_contract_resource_id,
       context_contract_resource_hash, current_context_snapshot_id,
       current_context_snapshot_hash, runtime_safety_hash, state_activation_count,
       graph_run_count, state_transition_count, child_workflow_count, started_at_ms,
       deadline_at_ms, workflow_definition_version, state_instance_id,
       current_graph_run_id, final_outcome_kind, final_output_value_id,
       final_output_hash, final_output_schema_hash, final_error_code,
       final_error_detail_value_id, final_error_detail_hash, final_cancel_reason,
       workflow_revision, row_version, created_at_ms, updated_at_ms, finished_at_ms
     ) VALUES (?, 'active', 'healthy', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, 0,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 1, ?, ?, NULL)`,
        [
          workflowId,
          input.recipe.rowId,
          input.recipe.hash,
          input.recipeVersion,
          creationRequestId,
          input.creationDomain,
          input.creationKey,
          input.principalRef,
          input.ownershipHash,
          workflowId,
          lifetimeAccountId,
          input.executionPolicy.rowId,
          input.executionPolicy.hash,
          input.commandPolicy.rowId,
          input.commandPolicy.hash,
          input.input.id,
          input.input.hash,
          input.inputSchema.rowId,
          input.inputSchema.hash,
          input.contextContract.rowId,
          input.contextContract.hash,
          contextSnapshotId,
          input.contextSnapshot.hash,
          input.runtimeSafetyHash,
          input.nowMs,
          input.deadlineAtMs,
          input.workflowDefinitionVersion,
          activationId,
          input.nowMs,
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_context_snapshots (
       id, workflow_id, revision, contract_resource_id, contract_resource_hash,
       previous_snapshot_id, previous_snapshot_hash, slots_manifest_value_id,
       slots_manifest_hash, snapshot_hash, created_at_ms
     ) VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        [
          contextSnapshotId,
          workflowId,
          input.contextContract.rowId,
          input.contextContract.hash,
          input.contextSnapshot.id,
          input.contextSnapshot.hash,
          input.contextSnapshot.hash,
          input.nowMs,
        ],
      );
      const limits = Object.entries(input.resourceLimits).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      );
      for (const requiredResource of [
        'state_activations_total',
        'graph_runs_total',
        'descendant_workflows_total',
      ]) {
        const entry = limits.find(
          ([resourceType]) => resourceType === requiredResource,
        );
        if (!entry || !Number.isSafeInteger(entry[1]) || entry[1] <= 0)
          throw new G5RuntimeError(
            'contract_invalid',
            `T0 requires a finite positive ${requiredResource} lifetime account`,
          );
      }
      for (const [resourceType, hardLimit] of limits) {
        const accountId = stableRuntimeId('account', {
          workflow_id: workflowId,
          resource_type: resourceType,
        });
        transaction.execute(
          `INSERT INTO workflow_graph_resource_accounts (
         id, deployment_scope_ref, workflow_id, graph_run_id, scope_id, node_id,
         execution_group_resource_id, execution_group_resource_hash,
         resource_type, hard_limit, reserved_amount, consumed_amount, row_version
       ) VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 0, 0, 1)`,
          [accountId, workflowId, resourceType, hardLimit],
        );
      }
      for (const claim of input.domainClaims) {
        acquireCurrentDomainClaim(transaction, {
          ...claim,
          ownerWorkflowId: workflowId,
          recipeResourceId: input.recipe.rowId,
          recipeResourceHash: input.recipe.hash,
          sourceIntakeId: intakeId,
          creationKey: input.creationKey,
          acquiredAtMs: input.nowMs,
        });
      }
      const activation = activateWorkflowT1InTransaction(transaction, {
        ...input.initialActivation,
        workflowId,
        expectedWorkflowRowVersion: 1,
      });
      assertNoDeferredForeignKeyViolations(transaction, 'T0');
      return {
        disposition: 'created',
        workflowId,
        intakeId,
        creationRequestId,
        activation,
      };
    },
    fault,
  );
}

export interface T0pRequiredFinalizationInput {
  readonly workflowId: string;
  readonly sourceStateInstanceId: string;
  readonly sourceRunId: string;
  readonly rootScopeId: string;
  readonly closeRequestId: string;
  readonly transitionEffectId: string;
  readonly recipe: RuntimeRegistryRef;
  readonly definition: RuntimeRegistryRef;
  readonly executionPolicy: RuntimeRegistryRef;
  readonly routingScope: RuntimeRegistryRef;
  readonly finalizationPolicy: RuntimeRegistryRef;
  readonly principalRef: string;
  readonly principalHash: Sha256Hash;
  readonly input: RuntimeValueRef;
  readonly attachments: RuntimeValueRef;
  readonly routingDecision: RuntimeValueRef;
  readonly creationIntentHash: Sha256Hash;
  readonly runtimeSafetyHash: Sha256Hash;
  readonly maxAttempts: number;
  readonly deadlineAtMs: number;
  readonly nowMs: number;
}

export function prepareRequiredFinalizationT0p(
  store: WorkflowRuntimeStore,
  input: T0pRequiredFinalizationInput,
  fault?: G5TransactionFault,
): {
  disposition: 'prepared' | 'exact_replay';
  scheduleId: string;
  creationRequestId: string;
} {
  const scheduleId = stableRuntimeId('root-finalization', {
    source_run_id: input.sourceRunId,
    close_request_id: input.closeRequestId,
    transition_effect_id: input.transitionEffectId,
  });
  return runImmediateG5Transaction(
    store,
    (transaction) => {
      for (const [label, resource] of Object.entries({
        recipe: input.recipe,
        definition: input.definition,
        executionPolicy: input.executionPolicy,
        routingScope: input.routingScope,
        finalizationPolicy: input.finalizationPolicy,
      }))
        assertExactPublishedRegistryResource(
          transaction,
          resource,
          `T0p ${label}`,
        );
      const lineage = transaction.queryOne<{
        root_workflow_id: string;
        ownership_hash: Sha256Hash;
        runtime_safety_hash: Sha256Hash;
        run_workflow_id: string;
        state_instance_id: string;
        root_scope_id: string;
        root_close_request_id: string | null;
        lifecycle: string;
      }>(
        `SELECT w.root_workflow_id, w.ownership_hash, w.runtime_safety_hash,
                r.workflow_id AS run_workflow_id,
                r.state_instance_id, r.root_scope_id, r.root_close_request_id,
                r.lifecycle
           FROM workflows w
           JOIN workflow_graph_runs r ON r.workflow_id = w.id
          WHERE w.id = ? AND r.id = ?`,
        [input.workflowId, input.sourceRunId],
      );
      if (
        !lineage ||
        lineage.run_workflow_id !== input.workflowId ||
        lineage.state_instance_id !== input.sourceStateInstanceId ||
        lineage.root_scope_id !== input.rootScopeId ||
        lineage.root_close_request_id !== input.closeRequestId ||
        lineage.lifecycle !== 'closing' ||
        input.transitionEffectId.length === 0
      )
        throw new G5RuntimeError(
          'precondition_failed',
          'T0p requires trusted transition lineage and the winning root close request',
        );
      if (input.runtimeSafetyHash !== lineage.runtime_safety_hash)
        throw new G5RuntimeError(
          'integrity_violation',
          'T0p runtime safety identity differs from the parent Workflow',
        );
      const creationDomain = `parent_workflow_lineage:${lineage.root_workflow_id}`;
      const creationKey = domainSeparatedSha256(
        'icarus:child-workflow-creation-key:1\n',
        {
          parent_workflow_id: input.workflowId,
          source_state_instance_id: input.sourceStateInstanceId,
          source_close_request_id: input.closeRequestId,
          transition_effect_id: input.transitionEffectId,
        },
      );
      const observedCreationIntentHash = calculateCreationIntentHash({
        creationDomain,
        creationKey,
        principalRef: input.principalRef,
        ownershipHash: lineage.ownership_hash,
        routingScope: input.routingScope,
        recipe: input.recipe,
        entryPoint: 'default',
        inputHash: input.input.hash,
        attachmentManifestHash: input.attachments.hash,
      });
      if (input.creationIntentHash !== observedCreationIntentHash)
        throw new G5RuntimeError(
          'contract_invalid',
          'T0p creation_intent_hash does not match durable parent lineage',
        );
      const trustedLineage = {
        root_workflow_id: lineage.root_workflow_id,
        parent_workflow_id: input.workflowId,
        source_state_instance_id: input.sourceStateInstanceId,
        source_close_request_id: input.closeRequestId,
        transition_effect_id: input.transitionEffectId,
      };
      const intakeId = stableRuntimeId('intake', trustedLineage);
      const revisionId = stableRuntimeId('intake-revision', {
        intake_id: intakeId,
        revision_no: 0,
      });
      const routingId = stableRuntimeId('routing', {
        intake_id: intakeId,
        attempt_no: 1,
      });
      const creationRequestId = stableRuntimeId('creation', {
        creation_domain: creationDomain,
        creation_key: creationKey,
      });
      const existing = transaction.queryOne<{
        id: string;
        creation_request_id: string;
        transition_intake_id: string;
        creation_domain: string;
        creation_key: string;
        creation_intent_hash: string;
      }>(
        'SELECT id, creation_request_id, transition_intake_id, creation_domain, creation_key, creation_intent_hash FROM workflow_root_finalization_schedules WHERE id = ?',
        [scheduleId],
      );
      if (existing) {
        if (
          existing.creation_request_id !== creationRequestId ||
          existing.transition_intake_id !== intakeId ||
          existing.creation_domain !== creationDomain ||
          existing.creation_key !== creationKey ||
          existing.creation_intent_hash !== input.creationIntentHash
        )
          throw new G5RuntimeError(
            'integrity_violation',
            'T0p stable provenance drift',
          );
        return { disposition: 'exact_replay', scheduleId, creationRequestId };
      }
      const close = transaction.queryOne<{ id: string }>(
        'SELECT id FROM workflow_graph_scope_close_requests WHERE id = ? AND graph_run_id = ? AND scope_id = ?',
        [input.closeRequestId, input.sourceRunId, input.rootScopeId],
      );
      if (!close)
        throw new G5RuntimeError(
          'precondition_failed',
          'T0p requires the winning root close request',
        );
      transaction.execute(
        `INSERT INTO workflow_task_intakes (
       id, request_id, creation_domain, creation_key, source, principal_ref,
       routing_scope_resource_id, routing_scope_resource_hash,
       raw_request_value_id, raw_request_hash, initial_input_value_id,
       initial_input_hash, attachment_manifest_value_id,
       attachment_manifest_hash, explicit_task_kind,
       explicit_recipe_resource_id, status, selected_recipe_resource_id,
       selected_recipe_hash, current_revision_id, current_revision_no,
       current_revision_hash, workflow_id, next_attempt_no, row_version,
       created_at_ms, updated_at_ms
     ) VALUES (?, ?, ?, ?, 'workflow_transition', ?, ?, ?, NULL, NULL, ?, ?, ?, ?,
       NULL, ?, 'ready_to_create', ?, ?, ?, 0, ?, NULL, 2, 1, ?, ?)`,
        [
          intakeId,
          `transition:${input.transitionEffectId}`,
          creationDomain,
          creationKey,
          input.principalRef,
          input.routingScope.rowId,
          input.routingScope.hash,
          input.input.id,
          input.input.hash,
          input.attachments.id,
          input.attachments.hash,
          input.recipe.rowId,
          input.recipe.rowId,
          input.recipe.hash,
          revisionId,
          input.input.hash,
          input.nowMs,
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_task_intake_revisions (
       id, intake_id, revision_no, parent_revision_id, amendment_value_id,
       amendment_hash, effective_input_value_id, effective_input_hash,
       attachment_manifest_value_id, attachment_manifest_hash,
       clarification_contract_resource_id, clarification_contract_resource_hash,
       source_routing_attempt_id, actor_kind, principal_ref, idempotency_key,
       revision_hash, created_at_ms
     ) VALUES (?, ?, 0, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL,
       'system', ?, ?, ?, ?)`,
        [
          revisionId,
          intakeId,
          input.input.id,
          input.input.hash,
          input.attachments.id,
          input.attachments.hash,
          input.principalRef,
          `transition:${input.transitionEffectId}`,
          input.input.hash,
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_routing_attempts (
       id, intake_id, attempt_no, intake_revision_id, input_hash,
       parent_scope_resource_id, parent_scope_resource_hash, scope_resource_id,
       scope_resource_hash, router_capability_resource_id,
       router_capability_resource_hash, input_snapshot_value_id,
       input_snapshot_hash, decision_value_id, decision_hash, decision_kind,
       target_resource_id, target_resource_hash, confidence_micros,
       reason_codes_json, missing_fields_json, created_at_ms
     ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?,
       'recipe_selected', ?, ?, 1000000, '["required_transition"]', '[]', ?)`,
        [
          routingId,
          intakeId,
          revisionId,
          input.input.hash,
          input.routingScope.rowId,
          input.routingScope.hash,
          input.routingScope.rowId,
          input.routingScope.hash,
          input.input.id,
          input.input.hash,
          input.routingDecision.id,
          input.routingDecision.hash,
          input.recipe.rowId,
          input.recipe.hash,
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_creation_requests (
       id, intake_id, creation_mode, creation_domain, creation_key,
       recipe_resource_id, recipe_resource_hash, definition_resource_id,
       definition_resource_hash, entry_point, execution_policy_resource_id,
       execution_policy_resource_hash, input_snapshot_value_id,
       input_snapshot_hash, attachment_manifest_value_id,
       attachment_manifest_hash, creation_intent_hash, runtime_safety_hash,
       launch_confirmation_id, launch_confirmation_hash, status, workflow_id,
       error_code, created_at_ms, updated_at_ms
     ) VALUES (?, ?, 'required_finalization', ?, ?, ?, ?, ?, ?, 'default', ?, ?,
       ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', NULL, NULL, ?, ?)`,
        [
          creationRequestId,
          intakeId,
          creationDomain,
          creationKey,
          input.recipe.rowId,
          input.recipe.hash,
          input.definition.rowId,
          input.definition.hash,
          input.executionPolicy.rowId,
          input.executionPolicy.hash,
          input.input.id,
          input.input.hash,
          input.attachments.id,
          input.attachments.hash,
          input.creationIntentHash,
          input.runtimeSafetyHash,
          input.nowMs,
          input.nowMs,
        ],
      );
      transaction.execute(
        `INSERT INTO workflow_root_finalization_schedules (
       id, workflow_id, source_state_instance_id, source_run_id, root_scope_id,
       close_request_id, transition_effect_id, transition_intake_id,
       creation_request_id, effect_type, recipe_resource_id,
       recipe_resource_hash, routing_scope_resource_id,
       routing_scope_resource_hash, principal_ref, principal_hash,
       input_snapshot_value_id, input_snapshot_hash, creation_domain,
       creation_key, creation_intent_hash, finalization_policy_resource_id,
       finalization_policy_resource_hash, status, attempt_count, max_attempts,
       next_eligible_at_ms, deadline_at_ms, child_workflow_id, last_error_code,
       last_error_detail_value_id, last_error_detail_hash, row_version,
       created_at_ms, updated_at_ms, completed_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'required_child_workflow', ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, NULL, NULL,
       NULL, 1, ?, ?, NULL)`,
        [
          scheduleId,
          input.workflowId,
          input.sourceStateInstanceId,
          input.sourceRunId,
          input.rootScopeId,
          input.closeRequestId,
          input.transitionEffectId,
          intakeId,
          creationRequestId,
          input.recipe.rowId,
          input.recipe.hash,
          input.routingScope.rowId,
          input.routingScope.hash,
          input.principalRef,
          input.principalHash,
          input.input.id,
          input.input.hash,
          creationDomain,
          creationKey,
          input.creationIntentHash,
          input.finalizationPolicy.rowId,
          input.finalizationPolicy.hash,
          input.maxAttempts,
          input.nowMs,
          input.deadlineAtMs,
          input.nowMs,
          input.nowMs,
        ],
      );
      return { disposition: 'prepared', scheduleId, creationRequestId };
    },
    fault,
  );
}
