import type {
  LogicalCheckMetadata,
  LogicalColumnMetadata,
} from '../../contracts/logical-schema-types.js';

const MAX_SAFE_INTEGER = '9007199254740991';

function q(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function present(column: string): string {
  return `${q(column)} IS NOT NULL`;
}

function absent(column: string): string {
  return `${q(column)} IS NULL`;
}

function allPresent(columns: string[]): string {
  return columns.map(present).join(' AND ');
}

function allAbsent(columns: string[]): string {
  return columns.map(absent).join(' AND ');
}

function oneOf(column: string, values: string[]): string {
  return `${q(column)} IN (${values.map((value) => `'${value}'`).join(', ')})`;
}

const CUSTOM_CHECKS: Readonly<Record<string, string>> = {
  'ck:command_ingress:claimed_target_mapping':
    '(("claimed_target_kind" = \'workflow\' AND "claimed_workflow_id" IS NOT NULL) OR ("claimed_target_kind" = \'run\' AND "claimed_run_id" IS NOT NULL) OR ("claimed_target_kind" = \'node\' AND "claimed_node_id" IS NOT NULL) OR ("claimed_target_kind" = \'retry_schedule\' AND "claimed_retry_schedule_id" IS NOT NULL) OR ("claimed_target_kind" = \'effect_operation\' AND "claimed_effect_operation_id" IS NOT NULL) OR ("claimed_target_kind" = \'operational_blocker\' AND "claimed_operational_blocker_id" IS NOT NULL))',
  'ck:command_ingress:canonical_request_json':
    'json_valid("canonical_request_json")',
  'ck:command_ingress:terminal_shape':
    '(("resolution_result" = \'prepared\' AND "authorization_result" = \'pending\' AND "execution_result" = \'prepared\' AND "denial_code" IS NULL AND "canonical_result_json" IS NULL AND "resolved_command_id" IS NULL AND "decided_at_ms" IS NULL AND "applied_at_ms" IS NULL AND "terminal_binding_hash" IS NULL) OR ("resolution_result" IN (\'target_not_found\', \'target_kind_invalid\') AND "authorization_result" = \'not_evaluated\' AND "execution_result" = \'denied\' AND "denial_code" = "resolution_result" AND "canonical_result_json" IS NOT NULL AND "resolved_command_id" IS NULL AND "decided_at_ms" IS NOT NULL AND "applied_at_ms" IS NULL AND "terminal_binding_hash" IS NOT NULL) OR ("resolution_result" = \'resolved\' AND "execution_result" IN (\'applied\', \'denied\', \'conflict\', \'duplicate\', \'late\') AND "canonical_result_json" IS NOT NULL AND "resolved_command_id" IS NOT NULL AND "decided_at_ms" IS NOT NULL AND "terminal_binding_hash" IS NOT NULL AND (("execution_result" = \'applied\' AND "authorization_result" = \'allowed\' AND "denial_code" IS NULL AND "applied_at_ms" IS NOT NULL) OR ("execution_result" = \'duplicate\' AND "authorization_result" = \'not_evaluated\' AND "denial_code" IS NULL AND "applied_at_ms" IS NULL) OR ("execution_result" = \'conflict\' AND "denial_code" = \'idempotency_conflict\' AND "authorization_result" = \'not_evaluated\' AND "applied_at_ms" IS NULL) OR ("execution_result" IN (\'denied\', \'conflict\', \'late\') AND "denial_code" IS NOT NULL AND "denial_code" <> \'idempotency_conflict\' AND "authorization_result" IN (\'allowed\', \'denied\') AND "applied_at_ms" IS NULL))))',
  'ck:command_ingress:chronology':
    '(("decided_at_ms" IS NULL AND "applied_at_ms" IS NULL) OR ("decided_at_ms" >= "requested_at_ms" AND ("applied_at_ms" IS NULL OR ("applied_at_ms" >= "requested_at_ms" AND "applied_at_ms" <= "decided_at_ms"))))',
  'ck:scope_builds:source_shapes':
    '(("source_seed_json" IS NOT NULL) + ("source_seed_value_id" IS NOT NULL) <= 1) AND (("source_snapshot_json" IS NOT NULL) + ("source_snapshot_value_id" IS NOT NULL) <= 1) AND (("input_snapshot_json" IS NOT NULL) + ("input_snapshot_value_id" IS NOT NULL) <= 1)',
  'ck:resource_accounts:under_limit':
    '"reserved_amount" + "consumed_amount" <= "hard_limit"',
  'ck:resource_reservations:settlement_state':
    '(("status" = \'held\' AND "settled_at_ms" IS NULL) OR ("status" IN (\'committed\', \'released\') AND "settled_at_ms" IS NOT NULL AND "reserved_remaining" = 0))',
  'ck:domain_claims:fencing_mode':
    '(("mode" = \'exclusive\' AND "fencing_token" IS NOT NULL) OR ("mode" = \'shared\' AND "fencing_token" IS NULL))',
  'ck:domain_claims:release_state':
    '(("status" = \'released\' AND "released_at_ms" IS NOT NULL) OR ("status" IN (\'held\', \'release_pending\') AND "released_at_ms" IS NULL))',
  'ck:domain_claims:fencing_identity':
    '(("mode" = \'shared\' AND "fencing_token" IS NULL AND "fencing_token_identity" = 0) OR ("mode" = \'exclusive\' AND "fencing_token" IS NOT NULL AND "fencing_token" > 0 AND "fencing_token_identity" = "fencing_token"))',
  'ck:domain_claims:active_head_state':
    '(("status" IN (\'held\', \'release_pending\') AND "active_head_claim_id" = "id" AND "released_at_ms" IS NULL) OR ("status" = \'released\' AND "active_head_claim_id" IS NULL AND "released_at_ms" IS NOT NULL))',
  'ck:domain_claims:acquisition_lineage':
    '(("acquisition_kind" = \'direct\' AND "predecessor_claim_id" IS NULL AND "handoff_id" IS NULL) OR ("acquisition_kind" = \'handoff\' AND "predecessor_claim_id" IS NOT NULL AND "handoff_id" IS NOT NULL))',
  'ck:domain_resource_heads:active_shape':
    '(("active_claim_id" IS NULL AND "active_claim_owner_workflow_id" IS NULL AND "active_claim_mode" IS NULL AND "active_claim_epoch" IS NULL AND "active_fencing_token_identity" IS NULL AND "active_claim_link_id" IS NULL) OR ("active_claim_id" IS NOT NULL AND "active_claim_link_id" = "active_claim_id" AND "active_claim_owner_workflow_id" IS NOT NULL AND "active_claim_mode" IS NOT NULL AND "active_claim_epoch" IS NOT NULL AND "active_claim_epoch" > 0 AND "active_claim_epoch" <= "latest_claim_epoch" AND (("active_claim_mode" = \'shared\' AND "active_fencing_token_identity" = 0) OR ("active_claim_mode" = \'exclusive\' AND "active_fencing_token_identity" = "current_fencing_token" AND "active_fencing_token_identity" > 0))))',
  'ck:domain_claim_handoffs:exclusive_token_step':
    '("parent_claim_id" <> "child_claim_id" AND "parent_workflow_id" <> "child_workflow_id" AND "parent_claim_mode" = \'exclusive\' AND "child_claim_mode" = \'exclusive\' AND "parent_fencing_token" < 9007199254740991 AND "child_fencing_token" = "parent_fencing_token" + 1 AND "parent_claim_epoch" < 9007199254740991 AND "child_claim_epoch" = "parent_claim_epoch" + 1)',
  'ck:values:storage_shape':
    '(("storage_kind" = \'inline\' AND "inline_canonical_json" IS NOT NULL AND "blob_hash" IS NULL AND "immutable_external_locator" IS NULL AND "expected_hash" IS NULL) OR ("storage_kind" = \'blob\' AND "inline_canonical_json" IS NULL AND "blob_hash" IS NOT NULL AND "immutable_external_locator" IS NULL AND "expected_hash" IS NULL) OR ("storage_kind" = \'immutable_external\' AND "inline_canonical_json" IS NULL AND "blob_hash" IS NULL AND "immutable_external_locator" IS NOT NULL AND "expected_hash" IS NOT NULL))',
  'ck:values:payload_state':
    '(("payload_state" = \'pruned\' AND "payload_pruned_at_ms" IS NOT NULL) OR ("payload_state" IN (\'live\', \'corrupt\') AND "payload_pruned_at_ms" IS NULL))',
  'ck:values:schema_authority_shape':
    '(("schema_authority_kind" = \'registry\' AND "schema_resource_id" IS NOT NULL AND "schema_resource_hash" IS NOT NULL AND "schema_plan_id" IS NULL AND "schema_plan_hash" IS NULL AND "generated_schema_ref" IS NULL AND "generated_schema_hash" IS NULL AND "generated_schema_generator" IS NULL AND "generated_schema_parameter_hash" IS NULL) OR ("schema_authority_kind" = \'plan_generated\' AND "schema_resource_id" IS NULL AND "schema_resource_hash" IS NULL AND "schema_plan_id" IS NOT NULL AND "schema_plan_hash" IS NOT NULL AND "generated_schema_ref" IS NOT NULL AND "generated_schema_hash" IS NOT NULL AND "generated_schema_generator" IS NOT NULL AND "generated_schema_parameter_hash" IS NOT NULL))',
  'ck:generated_schema_contents:ref':
    '"schema_ref" = \'icarus-generated-schema:\' || "schema_raw_hash"',
  'ck:blob_objects:deleted_time':
    '(("state" = \'deleted\' AND "deleted_at_ms" IS NOT NULL) OR ("state" <> \'deleted\' AND "deleted_at_ms" IS NULL))',
  'ck:registry_resources:publication_time':
    '(("publication_state" = \'staged\' AND "published_at_ms" IS NULL AND "retired_at_ms" IS NULL) OR ("publication_state" = \'published\' AND "published_at_ms" IS NOT NULL AND "retired_at_ms" IS NULL) OR ("publication_state" = \'retired\' AND "published_at_ms" IS NOT NULL AND "retired_at_ms" IS NOT NULL))',
  'ck:retention_handles:kind_root':
    '(("handle_kind" = \'published\' AND "feature_release_id" IS NOT NULL) OR ("handle_kind" = \'active_run\' AND "graph_run_id" IS NOT NULL) OR ("handle_kind" = \'manual_pin\' AND ("backup_id" IS NOT NULL OR "external_actor_ref" IS NOT NULL)) OR ("handle_kind" = \'investigation\' AND "external_actor_ref" IS NOT NULL))',
  'ck:retention_handles:release_time':
    '(("status" = \'held\' AND "released_at_ms" IS NULL) OR ("status" = \'released\' AND "released_at_ms" IS NOT NULL))',
  'ck:backups:status_time':
    "((\"status\" IN ('preparing', 'copying') AND \"completed_at_ms\" IS NULL) OR (\"status\" IN ('completed', 'failed', 'expired') AND \"completed_at_ms\" IS NOT NULL))",
  'ck:backup_blob_pins:status_time':
    '(("status" = \'pinned\' AND "copied_at_ms" IS NULL AND "released_at_ms" IS NULL) OR ("status" = \'copied\' AND "copied_at_ms" IS NOT NULL AND "released_at_ms" IS NULL) OR ("status" = \'released\' AND "released_at_ms" IS NOT NULL))',
  'ck:task_intakes:created_workflow':
    '(("status" = \'created\' AND "workflow_id" IS NOT NULL) OR ("status" <> \'created\' AND "workflow_id" IS NULL))',
  'ck:task_intakes:selected_recipe':
    "((\"status\" IN ('awaiting_confirmation', 'ready_to_create', 'created') AND \"selected_recipe_resource_id\" IS NOT NULL AND \"selected_recipe_hash\" IS NOT NULL) OR (\"status\" IN ('routing', 'needs_clarification', 'unsupported', 'rejected') AND \"selected_recipe_resource_id\" IS NULL AND \"selected_recipe_hash\" IS NULL))",
  'ck:intake_revisions:parent_sequence':
    '(("revision_no" = 0 AND "parent_revision_id" IS NULL) OR ("revision_no" > 0 AND "parent_revision_id" IS NOT NULL))',
  'ck:routing_attempts:confidence_range':
    '"confidence_micros" BETWEEN 0 AND 1000000',
  'ck:routing_attempts:decision_target':
    '(("decision_kind" IN (\'recipe_selected\', \'child_scope_selected\') AND "target_resource_id" IS NOT NULL AND "target_resource_hash" IS NOT NULL) OR ("decision_kind" IN (\'needs_clarification\', \'unsupported\') AND "target_resource_id" IS NULL AND "target_resource_hash" IS NULL))',
  'ck:creation_requests:terminal_fields':
    '(("status" = \'created\' AND "workflow_id" IS NOT NULL AND "error_code" IS NULL) OR ("status" = \'rejected_permanent\' AND "workflow_id" IS NULL AND "error_code" IS NOT NULL) OR ("status" IN (\'pending\', \'blocked_retryable\', \'awaiting_confirmation\', \'cancelled\') AND "workflow_id" IS NULL AND "error_code" IS NULL))',
  'ck:creation_attempts:retry_fields':
    '(("status" = \'retry_wait\' AND "error_code" IS NOT NULL AND "retry_at_ms" IS NOT NULL) OR ("status" IN (\'pending\', \'succeeded\') AND "error_code" IS NULL AND "retry_at_ms" IS NULL) OR ("status" = \'rejected\' AND "error_code" IS NOT NULL AND "retry_at_ms" IS NULL))',
  'ck:workflows:status_time':
    "((\"status\" = 'active' AND \"finished_at_ms\" IS NULL) OR (\"status\" IN ('completed', 'errored', 'cancelled', 'administratively_abandoned') AND \"finished_at_ms\" IS NOT NULL))",
  'ck:workflows:abandon_state':
    '(("status" = \'administratively_abandoned\') = ("operational_state" = \'administratively_abandoned\'))',
  'ck:workflows:final_outcome_shape':
    '(("status" = \'completed\' AND "final_outcome_kind" = \'normal\' AND "final_output_value_id" IS NOT NULL AND "final_error_code" IS NULL AND "final_cancel_reason" IS NULL) OR ("status" = \'errored\' AND "final_outcome_kind" = \'errored\' AND "final_output_value_id" IS NULL AND "final_error_code" IS NOT NULL AND "final_cancel_reason" IS NULL) OR ("status" = \'cancelled\' AND "final_outcome_kind" = \'cancelled\' AND "final_output_value_id" IS NULL AND "final_error_code" IS NULL AND "final_cancel_reason" IS NOT NULL) OR ("status" IN (\'active\', \'administratively_abandoned\') AND "final_outcome_kind" IS NULL AND "final_output_value_id" IS NULL AND "final_error_code" IS NULL AND "final_cancel_reason" IS NULL))',
  'ck:state_activations:type_run':
    '(("state_type" = \'terminal\' AND "status" = \'completed\' AND "graph_run_id" IS NULL AND "terminal_kind" IS NOT NULL) OR ("state_type" <> \'terminal\' AND "graph_run_id" IS NOT NULL AND "terminal_kind" IS NULL))',
  'ck:state_activations:status_time':
    '(("status" = \'active\' AND "finished_at_ms" IS NULL) OR ("status" IN (\'completed\', \'abandoned\') AND "finished_at_ms" IS NOT NULL))',
  'ck:state_activations:terminal_shape':
    '(("terminal_kind" = \'normal\' AND "terminal_output_value_id" IS NOT NULL AND "terminal_error_code" IS NULL AND "terminal_error_detail_value_id" IS NULL) OR ("terminal_kind" = \'errored\' AND "terminal_output_value_id" IS NULL AND "terminal_error_code" IS NOT NULL) OR ("terminal_kind" IS NULL AND "terminal_output_value_id" IS NULL AND "terminal_error_code" IS NULL AND "terminal_error_detail_value_id" IS NULL))',
  'ck:state_activations:no_terminal_abandon':
    'NOT ("state_type" = \'terminal\' AND "status" = \'abandoned\')',
  'ck:graph_runs:closed_shape':
    '(("lifecycle" = \'closed\' AND "completion_cut_id" IS NOT NULL AND "outcome_kind" IS NOT NULL AND "finished_at_ms" IS NOT NULL) OR ("lifecycle" <> \'closed\' AND "completion_cut_id" IS NULL))',
  'ck:graph_runs:abandon_shape':
    '("operational_state" <> \'administratively_abandoned\' OR ("lifecycle" <> \'closed\' AND "completion_cut_id" IS NULL AND "outcome_kind" IS NULL))',
  'ck:graph_runs:outcome_shape':
    '(("outcome_kind" = \'completed\' AND "exit_name" IS NOT NULL AND "output_value_id" IS NOT NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL AND "root_cancel_scope" IS NULL) OR ("outcome_kind" = \'errored\' AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NOT NULL AND "root_cancel_scope" IS NULL) OR ("outcome_kind" = \'cancelled\' AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL AND "root_cancel_scope" IS NOT NULL) OR ("outcome_kind" IS NULL AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL))',
  'ck:operational_blockers:resolution_shape':
    '(("status" = \'open\' AND "resolved_at_ms" IS NULL AND "abandoned_at_ms" IS NULL AND "resolution_command_id" IS NULL AND "resolution_value_id" IS NULL) OR ("status" = \'resolved\' AND "resolved_at_ms" IS NOT NULL AND "abandoned_at_ms" IS NULL AND "resolution_command_id" IS NOT NULL) OR ("status" = \'abandoned\' AND "resolved_at_ms" IS NULL AND "abandoned_at_ms" IS NOT NULL))',
  'ck:blocker_attempts:result_shape':
    '(("result" = \'retry_wait\' AND "result_value_id" IS NULL AND "error_code" IS NOT NULL AND "next_eligible_at_ms" IS NOT NULL) OR ("result" = \'resolved\' AND "result_value_id" IS NOT NULL AND "error_code" IS NULL AND "next_eligible_at_ms" IS NULL) OR ("result" = \'rejected\' AND "result_value_id" IS NULL AND "error_code" IS NOT NULL AND "next_eligible_at_ms" IS NULL))',
  'ck:transition_history:target_shape':
    '(("target_state_key" IS NULL AND "target_state_instance_id" IS NULL AND "target_run_id" IS NULL) OR ("target_state_key" IS NOT NULL AND "target_state_instance_id" IS NOT NULL))',
  'ck:workflow_relations:lineage':
    '("parent_workflow_id" <> "child_workflow_id" AND "workflow_depth" > 0 AND "root_workflow_id" IS NOT NULL AND "lineage_budget_account_id" IS NOT NULL)',
  'ck:root_finalization_schedules:attempt_budget':
    '("attempt_count" BETWEEN 0 AND "max_attempts" AND "max_attempts" > 0)',
  'ck:root_finalization_schedules:success_shape':
    '(("status" = \'succeeded\' AND "child_workflow_id" IS NOT NULL AND "completed_at_ms" IS NOT NULL) OR ("status" <> \'succeeded\' AND "child_workflow_id" IS NULL))',
  'ck:root_finalization_attempts:result_shape':
    '(("result" IN (\'ready\', \'applied\') AND "error_code" IS NULL AND "error_detail_value_id" IS NULL) OR ("result" IN (\'retryable_conflict\', \'permanent_rejection\') AND "error_code" IS NOT NULL))',
  'ck:context_patch_operations:operation_shape':
    '(("operation" = \'clear\' AND "source_kind" IS NULL AND "source_port" IS NULL AND "source_slot" IS NULL AND "pointer" IS NULL AND "new_value_value_id" IS NULL) OR ("operation" = \'set\' AND "source_kind" IS NOT NULL AND (("source_port" IS NOT NULL) + ("source_slot" IS NOT NULL) <= 1) AND "new_value_value_id" IS NOT NULL))',
  'ck:scopes:nullable_plan':
    '("plan_id" IS NOT NULL OR ("scope_kind" = \'root\' AND "parent_scope_id" IS NULL AND "lifecycle" IN (\'materializing\', \'closing\', \'closed\')))',
  'ck:scopes:root_ownership':
    '(("scope_kind" = \'root\' AND "parent_scope_id" IS NULL AND "owner_node_id" IS NULL AND "child_key" IS NULL AND "depth" = 0) OR ("scope_kind" <> \'root\' AND "parent_scope_id" IS NOT NULL AND "owner_node_id" IS NOT NULL AND "child_key" IS NOT NULL AND "depth" > 0))',
  'ck:scopes:closed_shape':
    '(("lifecycle" = \'closed\' AND "close_request_id" IS NOT NULL AND "completion_cut_id" IS NOT NULL AND "outcome_kind" IS NOT NULL AND "finished_at_ms" IS NOT NULL) OR ("lifecycle" <> \'closed\' AND "completion_cut_id" IS NULL))',
  'ck:run_manifest:entry_shape':
    '(("entry_kind" = \'scope_materialized\' AND "scope_id" IS NOT NULL AND "expansion_manifest_id" IS NULL AND "source_hash" IS NOT NULL AND "plan_hash" IS NOT NULL AND "expansion_hash" IS NULL AND "item_count" IS NULL) OR ("entry_kind" = \'expansion_sealed\' AND "scope_id" IS NULL AND "expansion_manifest_id" IS NOT NULL AND "source_hash" IS NULL AND "plan_hash" IS NULL AND "expansion_hash" IS NOT NULL AND "item_count" IS NOT NULL))',
  'ck:scope_builds:status_shape':
    '(("status" IN (\'pending_snapshot\', \'ready_to_compile\', \'compiling\') AND "compiled_plan_id" IS NULL AND "scope_id" IS NULL AND "error_code" IS NULL) OR ("status" = \'compiled\' AND "compiled_plan_id" IS NOT NULL AND "scope_id" IS NULL AND "error_code" IS NULL) OR ("status" = \'materialized\' AND "compiled_plan_id" IS NOT NULL AND "scope_id" IS NOT NULL AND "error_code" IS NULL) OR ("status" = \'failed\' AND "scope_id" IS NULL AND "error_code" IS NOT NULL) OR ("status" = \'fenced\' AND "scope_id" IS NULL))',
  'ck:map_item_results:outcome_shape':
    '(("outcome_state" = \'open\' AND "exit_name" IS NULL AND "error_code" IS NULL AND "reason" IS NULL AND "output_value_id" IS NULL AND "completion_seq" IS NULL AND "fence_event_seq" IS NULL AND "resolved_at_ms" IS NULL) OR ("outcome_state" = \'completed\' AND "scope_id" IS NOT NULL AND "exit_name" IS NOT NULL AND "output_value_id" IS NOT NULL AND "completion_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("outcome_state" = \'errored\' AND "error_code" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("outcome_state" = \'cancelled\' AND "scope_id" IS NOT NULL AND "reason" IS NOT NULL AND "completion_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("outcome_state" = \'fenced\' AND "reason" IS NOT NULL AND "fence_event_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL))',
  'ck:nodes:phase_shape':
    '(("phase" = \'pending\' AND "ready_at_ms" IS NULL AND "terminal_at_ms" IS NULL AND "terminal_status" IS NULL) OR ("phase" IN (\'ready\', \'active\', \'waiting\', \'retry_wait\') AND "ready_at_ms" IS NOT NULL AND "terminal_at_ms" IS NULL AND "terminal_status" IS NULL) OR ("phase" = \'terminal\' AND "terminal_at_ms" IS NOT NULL AND "terminal_status" IS NOT NULL))',
  'ck:nodes:activation_snapshot':
    '(("activation_event_seq" IS NULL AND "run_work_fence_epoch_at_activation" IS NULL AND "scope_work_fence_epoch_at_activation" IS NULL AND "trigger_cut_hash" IS NULL AND "input_snapshot_hash" IS NULL) OR ("activation_event_seq" IS NOT NULL AND "run_work_fence_epoch_at_activation" IS NOT NULL AND "scope_work_fence_epoch_at_activation" IS NOT NULL AND "trigger_cut_hash" IS NOT NULL AND "input_snapshot_hash" IS NOT NULL))',
  'ck:nodes:controller_shape':
    '(("node_type" NOT IN (\'subgraph\', \'expand\', \'map\') AND "controller_state" IS NULL AND "controller_decision_json" IS NULL AND "controller_remaining_count" IS NULL AND "controller_reservation_group_id" IS NULL) OR "node_type" IN (\'subgraph\', \'expand\', \'map\'))',
  'ck:node_attempts:continuation':
    '(("attempt_no" = 1 AND "continuation_kind" = \'initial\' AND "parent_attempt_id" IS NULL AND "parent_attempt_no" IS NULL) OR ("attempt_no" > 1 AND "continuation_kind" IN (\'execution_retry\', \'quality_revision\') AND "parent_attempt_id" IS NOT NULL AND "parent_attempt_no" = "attempt_no" - 1))',
  'ck:node_attempts:quality_feedback':
    '(("quality_revision_feedback_value_id" IS NOT NULL) = ("quality_decision" = \'needs_revision\' OR "continuation_kind" = \'quality_revision\'))',
  'ck:node_attempts:terminal_shape':
    '(("phase" = \'terminal\' AND "execution_outcome" IS NOT NULL AND "finished_at_ms" IS NOT NULL AND ("quality_decision" IS NULL OR "quality_decision" IN (\'pass\', \'needs_revision\', \'fail\'))) OR ("phase" <> \'terminal\' AND "finished_at_ms" IS NULL))',
  'ck:retry_schedules:adjacent_attempt':
    '"next_attempt_no" = "source_attempt_no" + 1',
  'ck:retry_schedules:feedback_kind':
    '(("continuation_kind" = \'quality_revision\' AND "quality_revision_feedback_value_id" IS NOT NULL AND "retry_reason_code" = \'quality_needs_revision\') OR ("continuation_kind" = \'execution_retry\' AND "quality_revision_feedback_value_id" IS NULL AND "retry_reason_code" <> \'quality_needs_revision\'))',
  'ck:waits:status_time':
    '(("status" = \'registering\' AND "armed_at_ms" IS NULL AND "resolved_at_ms" IS NULL) OR ("status" = \'armed\' AND "armed_at_ms" IS NOT NULL AND "resolved_at_ms" IS NULL) OR ("status" IN (\'resolved\', \'timed_out\', \'cancelled\') AND "armed_at_ms" IS NOT NULL AND "resolved_at_ms" IS NOT NULL)) AND ("wait_type" <> \'timer\' OR "deadline_at_ms" IS NOT NULL)',
  'ck:control_resolutions:state_shape':
    '(("state" = \'unresolved\' AND "decision_input_hash" IS NULL AND "decision_json" IS NULL AND "error_code" IS NULL AND "resolution_seq" IS NULL AND "resolved_at_ms" IS NULL) OR ("state" IN (\'taken\', \'not_taken\') AND "decision_input_hash" IS NOT NULL AND "error_code" IS NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("state" = \'error\' AND "error_code" IS NOT NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL))',
  'ck:data_resolutions:state_shape':
    '(("state" = \'unresolved\' AND "value_value_id" IS NULL AND "schema_hash" IS NULL AND "source_attempt_id" IS NULL AND "error_code" IS NULL AND "resolution_seq" IS NULL AND "resolved_at_ms" IS NULL) OR ("state" = \'available\' AND "value_value_id" IS NOT NULL AND "schema_hash" IS NOT NULL AND "error_code" IS NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("state" = \'unavailable\' AND "value_value_id" IS NULL AND "error_code" IS NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("state" = \'error\' AND "value_value_id" IS NULL AND "error_code" IS NOT NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL))',
  'ck:close_requests:reason_shape':
    '(("reason" = \'normal\' AND "selected_rule_id" IS NOT NULL AND "candidate_id" IS NOT NULL AND "eligibility_event_seq" IS NOT NULL AND "error_code" IS NULL AND "cancel_payload_json" IS NULL) OR ("reason" = \'engine_error\' AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL AND "error_code" IS NOT NULL AND "cancel_payload_json" IS NULL) OR ("reason" IN (\'local_cancel\', \'workflow_cancel\') AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL AND "error_code" IS NULL AND "cancel_payload_json" IS NOT NULL) OR ("reason" = \'parent_close\' AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL AND "error_code" IS NULL))',
  'ck:completion_cuts:outcome_shape':
    '(("outcome_kind" = \'completed\' AND "exit_name" IS NOT NULL AND "output_value_id" IS NOT NULL AND "selected_rule_id" IS NOT NULL AND "candidate_id" IS NOT NULL) OR ("outcome_kind" IN (\'errored\', \'cancelled\') AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL))',
  'ck:child_consumptions:map_disposition':
    "((\"disposition\" IN ('map_slot_completed', 'map_slot_fenced') AND \"map_slot_id\" IS NOT NULL) OR (\"disposition\" IN ('owner_output_published', 'non_publish_parent_fenced', 'non_publish_owner_fenced') AND \"map_slot_id\" IS NULL))",
  'ck:child_consumptions:map_disposition_lineage':
    '(("disposition" = \'map_slot_completed\' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" = \'completed\') OR ("disposition" = \'map_slot_fenced\' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" = \'fenced\') OR ("disposition" IN (\'owner_output_published\', \'non_publish_parent_fenced\', \'non_publish_owner_fenced\') AND "map_slot_id" IS NULL AND "map_slot_outcome_state" IS NULL))',
  'ck:child_consumptions:terminal_disposition_lineage':
    '(("disposition" = \'map_slot_completed\' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = \'completed\') OR ("disposition" = \'map_slot_errored\' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = \'errored\') OR ("disposition" = \'map_slot_cancelled\' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = \'cancelled\') OR ("disposition" = \'map_slot_fenced\' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = \'fenced\') OR ("disposition" IN (\'owner_output_published\', \'non_publish_parent_fenced\', \'non_publish_owner_fenced\') AND "map_slot_id" IS NULL AND "map_slot_outcome_state" IS NULL))',
  'ck:inbox_events:disposition_shape':
    '(("disposition" = \'pending\' AND "resolved_at_ms" IS NULL) OR ("disposition" <> \'pending\' AND "resolved_at_ms" IS NOT NULL)) AND ("disposition" NOT IN (\'accepted\', \'rejected\') OR "binding_authorization_value_id" IS NOT NULL)',
  'ck:effect_operations:lane_close':
    '(("execution_lane" = \'normal\' AND "close_request_id" IS NULL) OR ("execution_lane" = \'close_cleanup\' AND "close_request_id" IS NOT NULL))',
  'ck:effect_operations:status_shape':
    '(("status" IN (\'intended\', \'dispatched\') AND "receipt_value_id" IS NULL AND "compensation_value_id" IS NULL) OR ("status" = \'succeeded\' AND "receipt_value_id" IS NOT NULL AND "after_state_value_id" IS NOT NULL AND "immutable_output_snapshot_value_id" IS NOT NULL) OR ("status" IN (\'failed\', \'action_required\')) OR ("status" = \'compensation_pending\' AND "compensation_value_id" IS NULL) OR ("status" IN (\'compensated\', \'compensation_not_required\') AND "compensation_value_id" IS NOT NULL))',
  'ck:effect_claims:write_fence':
    '(("access" = \'write\' AND "fencing_token" IS NOT NULL) OR ("access" = \'read\' AND "fencing_token" IS NULL))',
  'ck:effect_claims:fencing_identity':
    '(("access" = \'write\' AND "fencing_token" IS NOT NULL AND "fencing_token" > 0 AND "fencing_token_identity" = "fencing_token") OR ("access" = \'read\' AND "fencing_token" IS NULL AND "fencing_token_identity" = 0))',
  'ck:outbox:aggregate_version':
    '(("projection_target_ref" IS NOT NULL AND "aggregate_row_version" IS NULL) OR ("projection_target_ref" IS NULL AND "aggregate_row_version" IS NOT NULL))',
  'ck:outbox:status_time':
    '(("status" = \'succeeded\' AND "delivered_at_ms" IS NOT NULL AND "last_result_kind" IS NOT NULL AND "last_error_code" IS NULL) OR ("status" <> \'succeeded\' AND "delivered_at_ms" IS NULL))',
  'ck:runtime_commands:target_mapping':
    "((\"command_type\" IN ('cancel_workflow', 'request_administrative_abandon', 'confirm_administrative_abandon') AND \"workflow_id\" IS NOT NULL) OR (\"command_type\" IN ('pause_run', 'resume_run', 'cancel_run') AND \"run_id\" IS NOT NULL) OR (\"command_type\" = 'skip_node' AND \"node_id\" IS NOT NULL) OR (\"command_type\" = 'advance_retry_schedule' AND \"retry_schedule_id\" IS NOT NULL) OR (\"command_type\" IN ('reconcile_effect', 'submit_effect_receipt', 'verify_effect_not_applied') AND \"effect_operation_id\" IS NOT NULL) OR (\"command_type\" IN ('remediate_operational_blocker', 'restore_integrity') AND \"operational_blocker_id\" IS NOT NULL))",
  'ck:runtime_commands:finalization':
    '(("canonical_result_value_id" IS NULL AND "finalized_at_ms" IS NULL) OR ("canonical_result_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL))',
  'ck:command_invocations:execution_shape':
    '(("authorization_result" = \'denied\' AND "execution_result" = \'denied\' AND "target_after_hash" IS NULL AND "resulting_event_seq" IS NULL AND "close_request_id" IS NULL AND "effect_operation_id" IS NULL AND "applied_at_ms" IS NULL) OR ("authorization_result" = \'allowed\' AND (("execution_result" = \'applied\' AND "applied_at_ms" IS NOT NULL) OR ("execution_result" IN (\'conflict\', \'duplicate\', \'late\') AND "target_after_hash" IS NULL AND "applied_at_ms" IS NULL))))',
  'ck:command_confirmations:status_time':
    '(("status" = \'consumed\' AND "consumed_at_ms" IS NOT NULL) OR ("status" IN (\'pending\', \'expired\') AND "consumed_at_ms" IS NULL))',
  'ck:command_confirmations:ttl': '"expires_at_ms" >= 300000',
  'ck:capacity_head:singleton': '"singleton_key" = 1',
  'ck:capacity_head:pending_differs_from_current':
    '("pending_change_id" IS NULL OR "pending_change_id" <> "current_change_id")',
  'ck:capacity_commands:command_mapping':
    '(("command_type" = \'initialize_deployment_capacity\' AND "expected_capacity_revision" IS NULL AND "expected_config_hash" IS NULL AND "genesis_core_release_hash" IS NOT NULL AND "reason_code" = \'initial_provisioning\' AND "reason_text_value_id" IS NULL AND "reason_text_hash" IS NULL) OR ("command_type" = \'replace_deployment_capacity\' AND "expected_capacity_revision" IS NOT NULL AND "expected_config_hash" IS NOT NULL AND "genesis_core_release_hash" IS NULL AND "reason_code" <> \'initial_provisioning\' AND "reason_text_value_id" IS NOT NULL AND "reason_text_hash" IS NOT NULL))',
  'ck:capacity_commands:finalization':
    '(("canonical_result_value_id" IS NULL AND "finalized_at_ms" IS NULL) OR ("canonical_result_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL))',
  'ck:capacity_invocations:result_consistency':
    '(("authorization_result" = \'denied\' AND "execution_result" = \'denied\' AND "denial_code" IS NOT NULL AND "applied_at_ms" IS NULL) OR ("authorization_result" = \'allowed\' AND (("execution_result" = \'prepared\' AND "invocation_no" = 1 AND "denial_code" IS NULL AND "decided_at_ms" >= "requested_at_ms" AND "applied_at_ms" IS NULL) OR ("execution_result" = \'applied\' AND "denial_code" IS NULL AND "applied_at_ms" IS NOT NULL) OR ("execution_result" IN (\'conflict\', \'duplicate\', \'failed\') AND "applied_at_ms" IS NULL))))',
  'ck:capacity_events:hash_chain':
    '(("event_seq" = 1 AND "previous_event_hash" IS NULL) OR ("event_seq" > 1 AND "previous_event_hash" IS NOT NULL))',
  'ck:publisher_commands:idempotency_non_empty':
    '(length("idempotency_domain") BETWEEN 1 AND 255 AND length("idempotency_key") BETWEEN 1 AND 512)',
  'ck:publisher_commands:review_window':
    '("approved_at_ms" <= "created_at_ms" AND "created_at_ms" < "expires_at_ms")',
  'ck:publisher_commands:lifecycle':
    '(("lifecycle" = \'pending\' AND "applied_feature_release_id" IS NULL AND "applied_feature_release_hash" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NULL) OR ("lifecycle" = \'applied\' AND "applied_feature_release_id" = "target_feature_release_id" AND "applied_feature_release_hash" = "target_feature_release_hash" AND "canonical_receipt_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL) OR ("lifecycle" = \'failed\' AND "applied_feature_release_id" IS NULL AND "applied_feature_release_hash" IS NULL AND "canonical_receipt_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL))',
  'ck:publisher_invocations:result_consistency':
    '"decided_at_ms" >= "requested_at_ms" AND (("disposition" = \'applied\' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NOT NULL) OR ("disposition" IN (\'duplicate\', \'failed\') AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NULL) OR ("disposition" = \'conflict\' AND "submitted_request_hash" <> "command_domain_request_hash" AND "applied_at_ms" IS NULL))',
  'ck:publisher_invocations:hash_chain':
    '(("invocation_no" = 1 AND "previous_invocation_hash" IS NULL) OR ("invocation_no" > 1 AND "previous_invocation_hash" IS NOT NULL))',
  'ck:publisher_events:hash_chain':
    '(("event_no" = 1 AND "previous_event_hash" IS NULL) OR ("event_no" > 1 AND "previous_event_hash" IS NOT NULL))',
  'ck:publisher_events:event_mapping':
    '(("event_type" = \'attempt_started\' AND "phase" = \'authenticate\' AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = \'phase_succeeded\' AND "phase" IN (\'validate\', \'review\', \'preflight\', \'finalize\') AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = \'pre_transaction_failed\' AND "phase" IN (\'authenticate\', \'validate\', \'review\', \'preflight\') AND "failure_code" IS NOT NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = \'publish_transaction_started\' AND "phase" = \'publish_transaction\' AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = \'publish_committed\' AND "phase" = \'publish_transaction\' AND "failure_code" IS NULL AND "related_feature_release_id" IS NOT NULL) OR ("event_type" = \'recovery_started\' AND "phase" = \'recovery\' AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = \'recovery_succeeded\' AND "phase" = \'recovery\' AND "failure_code" IS NULL AND "related_feature_release_id" IS NOT NULL) OR ("event_type" = \'recovery_failed\' AND "phase" = \'recovery\' AND "failure_code" IS NOT NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = \'terminal_failed\' AND "phase" = \'finalize\' AND "failure_code" IS NOT NULL AND "related_feature_release_id" IS NULL))',
  'ck:feature_releases:lifecycle_timestamps':
    '(("status" = \'staged\' AND "activated_at_ms" IS NULL AND "disabled_at_ms" IS NULL) OR ("status" IN (\'active\', \'draining\') AND "activated_at_ms" IS NOT NULL AND "disabled_at_ms" IS NULL AND "staged_at_ms" <= "activated_at_ms") OR ("status" IN (\'disabled\', \'deleting\') AND "activated_at_ms" IS NOT NULL AND "disabled_at_ms" IS NOT NULL AND "staged_at_ms" <= "activated_at_ms" AND "activated_at_ms" <= "disabled_at_ms"))',
  'ck:feature_active_releases:positive_row_version': '"row_version" >= 1',
  'ck:activation_commands:idempotency_non_empty':
    '(length("idempotency_domain") BETWEEN 1 AND 255 AND length("idempotency_key") BETWEEN 1 AND 512)',
  'ck:activation_commands:verified_prefix':
    '(("verified_compatibility_input_value_id" IS NULL) = ("verified_compatibility_result_value_id" IS NULL)) AND ("verified_previous_feature_release_id" IS NULL OR "verified_target_feature_release_id" IS NOT NULL) AND ("verified_target_retention_handle_id" IS NULL OR ("verified_target_feature_release_id" IS NOT NULL AND "verified_compatibility_result_value_id" IS NOT NULL AND "verified_target_retention_feature_release_id" = "verified_target_feature_release_id")) AND ("verified_target_retention_observed_status" IS NULL OR "verified_target_retention_handle_id" IS NOT NULL) AND ("verified_previous_retention_handle_id" IS NULL OR ("verified_previous_feature_release_id" IS NOT NULL AND "verified_target_retention_observed_status" = \'held\' AND "verified_previous_retention_feature_release_id" = "verified_previous_feature_release_id")) AND ("verified_previous_retention_observed_status" IS NULL OR "verified_previous_retention_handle_id" IS NOT NULL) AND ("observed_pointer_state" IS NULL OR ("verified_target_retention_observed_status" = \'held\' AND ("verified_previous_feature_release_id" IS NULL OR "verified_previous_retention_observed_status" = \'held\')))',
  'ck:activation_commands:pointer_observation_shape':
    '(("observed_pointer_state" IS NULL AND "observed_pointer_row_version" IS NULL AND "observed_feature_release_id" IS NULL AND "observed_feature_release_ref" IS NULL AND "observed_feature_release_version" IS NULL AND "observed_feature_release_hash" IS NULL) OR ("observed_pointer_state" = \'absent\' AND "observed_pointer_row_version" IS NULL AND "observed_feature_release_id" IS NULL AND "observed_feature_release_ref" IS NULL AND "observed_feature_release_version" IS NULL AND "observed_feature_release_hash" IS NULL) OR ("observed_pointer_state" = \'present\' AND "observed_pointer_row_version" IS NOT NULL AND "observed_feature_release_id" IS NOT NULL AND "observed_feature_release_ref" IS NOT NULL AND "observed_feature_release_version" IS NOT NULL AND "observed_feature_release_hash" IS NOT NULL))',
  'ck:activation_commands:target_previous_distinct':
    '("verified_previous_feature_release_id" IS NULL OR "verified_target_feature_release_id" <> "verified_previous_feature_release_id")',
  'ck:activation_commands:lifecycle':
    '(("lifecycle" = \'pending\' AND "terminal_disposition" IS NULL AND "canonical_terminal_result_value_id" IS NULL AND "canonical_terminal_invocation_id" IS NULL AND "applied_pointer_row_version" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NULL AND ("row_version" <> 0 OR ("verified_compatibility_input_value_id" IS NULL AND "verified_compatibility_result_value_id" IS NULL AND "verified_target_feature_release_id" IS NULL AND "verified_previous_feature_release_id" IS NULL AND "verified_target_retention_handle_id" IS NULL AND "verified_previous_retention_handle_id" IS NULL AND "observed_pointer_state" IS NULL))) OR ("lifecycle" = \'applied\' AND "terminal_disposition" = \'applied\' AND "observed_pointer_state" IS NOT NULL AND "canonical_terminal_result_value_id" IS NOT NULL AND "canonical_terminal_invocation_id" IS NOT NULL AND "applied_pointer_row_version" IS NOT NULL AND "canonical_receipt_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL) OR ("lifecycle" IN (\'failed\', \'conflict\') AND "terminal_disposition" = "lifecycle" AND "canonical_terminal_result_value_id" IS NOT NULL AND "canonical_terminal_invocation_id" IS NOT NULL AND "applied_pointer_row_version" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NOT NULL))',
  'ck:activation_invocations:result_consistency':
    '"decided_at_ms" >= "requested_at_ms" AND (("disposition" = \'applied\' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NOT NULL AND "referenced_terminal_result_value_id" = "result_value_id" AND "referenced_terminal_result_hash" = "result_hash" AND "referenced_terminal_result_schema_resource_id" = "result_schema_resource_id" AND "referenced_terminal_result_schema_hash" = "result_schema_hash") OR ("disposition" = \'failed\' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NULL AND "referenced_terminal_result_value_id" = "result_value_id" AND "referenced_terminal_result_hash" = "result_hash" AND "referenced_terminal_result_schema_resource_id" = "result_schema_resource_id" AND "referenced_terminal_result_schema_hash" = "result_schema_hash") OR ("disposition" = \'duplicate\' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NULL AND "referenced_terminal_result_value_id" IS NOT NULL) OR ("disposition" = \'conflict\' AND "applied_at_ms" IS NULL AND (("submitted_request_hash" = "command_domain_request_hash" AND "referenced_terminal_result_value_id" = "result_value_id" AND "referenced_terminal_result_hash" = "result_hash" AND "referenced_terminal_result_schema_resource_id" = "result_schema_resource_id" AND "referenced_terminal_result_schema_hash" = "result_schema_hash") OR "submitted_request_hash" <> "command_domain_request_hash")))',
  'ck:activation_invocations:hash_chain':
    '(("invocation_no" = 1 AND "previous_invocation_hash" IS NULL) OR ("invocation_no" > 1 AND "previous_invocation_hash" IS NOT NULL))',
  'ck:activation_events:hash_chain':
    '(("event_no" = 1 AND "previous_event_hash" IS NULL) OR ("event_no" > 1 AND "previous_event_hash" IS NOT NULL))',
  'ck:activation_events:verified_release_binding':
    '(("verified_feature_id" IS NULL AND "verified_target_feature_release_id" IS NULL AND "verified_target_feature_release_ref" IS NULL AND "verified_target_feature_release_version" IS NULL AND "verified_target_feature_release_hash" IS NULL AND "verified_previous_feature_release_id" IS NULL AND "verified_previous_feature_release_ref" IS NULL AND "verified_previous_feature_release_version" IS NULL AND "verified_previous_feature_release_hash" IS NULL) OR ("verified_feature_id" IS NOT NULL AND "verified_target_feature_release_id" IS NOT NULL AND "verified_target_feature_release_ref" IS NOT NULL AND "verified_target_feature_release_version" IS NOT NULL AND "verified_target_feature_release_hash" IS NOT NULL AND (("verified_previous_feature_release_id" IS NULL AND "verified_previous_feature_release_ref" IS NULL AND "verified_previous_feature_release_version" IS NULL AND "verified_previous_feature_release_hash" IS NULL) OR ("verified_previous_feature_release_id" IS NOT NULL AND "verified_previous_feature_release_ref" IS NOT NULL AND "verified_previous_feature_release_version" IS NOT NULL AND "verified_previous_feature_release_hash" IS NOT NULL))))',
  'ck:activation_events:event_mapping':
    '(("event_type" = \'attempt_started\' AND "phase" = \'authenticate\' AND "failure_code" IS NULL) OR ("event_type" = \'phase_succeeded\' AND "phase" IN (\'authenticate\', \'validate\', \'preflight\', \'finalize\') AND "failure_code" IS NULL) OR ("event_type" = \'pre_transaction_failed\' AND "phase" IN (\'authenticate\', \'validate\', \'preflight\') AND "failure_code" IS NOT NULL) OR ("event_type" IN (\'activation_transaction_started\', \'activation_committed\') AND "phase" = \'activation_transaction\' AND "failure_code" IS NULL) OR ("event_type" = \'domain_request_conflicted\' AND "phase" = \'validate\' AND "failure_code" IS NOT NULL) OR ("event_type" = \'pointer_cas_conflicted\' AND "phase" = \'activation_transaction\' AND "failure_code" IS NOT NULL) OR ("event_type" IN (\'terminal_result_committed\', \'terminal_replayed\') AND "phase" = \'finalize\' AND "failure_code" IS NULL) OR ("event_type" IN (\'recovery_started\', \'recovery_succeeded\') AND "phase" = \'recovery\' AND "failure_code" IS NULL) OR ("event_type" IN (\'recovery_failed\', \'integrity_failed\') AND "phase" = \'recovery\' AND "failure_code" IS NOT NULL))',
};

const SCHEMA3_ACTIVATION_CHECKS: Readonly<Record<string, string>> = {
  'ck:activation_commands:expected_pointer_shape':
    '(("expected_pointer_state" = \'absent\' AND "expected_pointer_row_version" IS NULL AND "previous_feature_release_id" IS NULL AND "previous_feature_release_ref" IS NULL AND "previous_feature_release_version" IS NULL AND "previous_feature_release_hash" IS NULL AND "previous_retention_handle_id" IS NULL AND "previous_retention_handle_kind" IS NULL AND "previous_retention_closure_manifest_id" IS NULL AND "previous_retention_closure_hash" IS NULL AND "previous_retention_observed_status" IS NULL AND "previous_retention_observed_row_version" IS NULL) OR ("expected_pointer_state" = \'present\' AND "expected_pointer_row_version" IS NOT NULL AND "previous_feature_release_id" IS NOT NULL AND "previous_feature_release_ref" IS NOT NULL AND "previous_feature_release_version" IS NOT NULL AND "previous_feature_release_hash" IS NOT NULL AND "previous_retention_handle_id" IS NOT NULL AND "previous_retention_handle_kind" = \'published\' AND "previous_retention_closure_manifest_id" IS NOT NULL AND "previous_retention_closure_hash" IS NOT NULL AND "previous_retention_observed_status" = \'held\' AND "previous_retention_observed_row_version" IS NOT NULL))',
  'ck:activation_commands:target_previous_distinct':
    '("previous_feature_release_id" IS NULL OR "target_feature_release_id" <> "previous_feature_release_id")',
  'ck:activation_commands:lifecycle':
    '(("lifecycle" = \'pending\' AND "applied_pointer_row_version" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NULL) OR ("lifecycle" = \'applied\' AND "applied_pointer_row_version" IS NOT NULL AND "canonical_receipt_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL) OR ("lifecycle" = \'failed\' AND "applied_pointer_row_version" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NOT NULL))',
  'ck:activation_invocations:result_consistency':
    '"decided_at_ms" >= "requested_at_ms" AND (("disposition" = \'applied\' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NOT NULL) OR ("disposition" IN (\'duplicate\', \'failed\') AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NULL) OR ("disposition" = \'conflict\' AND "applied_at_ms" IS NULL))',
  'ck:activation_events:event_mapping':
    '(("event_type" = \'attempt_started\' AND "phase" = \'authenticate\' AND "failure_code" IS NULL) OR ("event_type" = \'phase_succeeded\' AND "phase" IN (\'validate\', \'preflight\', \'finalize\') AND "failure_code" IS NULL) OR ("event_type" = \'pre_transaction_failed\' AND "phase" IN (\'authenticate\', \'validate\', \'preflight\') AND "failure_code" IS NOT NULL) OR ("event_type" = \'activation_transaction_started\' AND "phase" = \'activation_transaction\' AND "failure_code" IS NULL) OR ("event_type" = \'activation_committed\' AND "phase" = \'activation_transaction\' AND "failure_code" IS NULL) OR ("event_type" = \'recovery_started\' AND "phase" = \'recovery\' AND "failure_code" IS NULL) OR ("event_type" = \'recovery_succeeded\' AND "phase" = \'recovery\' AND "failure_code" IS NULL) OR ("event_type" = \'recovery_failed\' AND "phase" = \'recovery\' AND "failure_code" IS NOT NULL) OR ("event_type" = \'terminal_failed\' AND "phase" = \'finalize\' AND "failure_code" IS NOT NULL))',
};

export function renderCheckExpression(
  check: LogicalCheckMetadata,
  columns: LogicalColumnMetadata[],
): string {
  const schema3Activation =
    check.check_id.startsWith('ck:activation_') &&
    !columns.some(
      (column) =>
        column.name === 'terminal_disposition' ||
        column.name === 'referenced_terminal_result_value_id' ||
        column.name === 'verified_feature_id',
    );
  const custom = schema3Activation
    ? (SCHEMA3_ACTIVATION_CHECKS[check.check_id] ??
      CUSTOM_CHECKS[check.check_id])
    : CUSTOM_CHECKS[check.check_id];
  if (custom) return custom;
  const selected = check.columns.map((name) => {
    const column = columns.find((candidate) => candidate.name === name);
    if (!column) throw new Error(`Check ${check.check_id} references ${name}`);
    return column;
  });
  switch (check.kind) {
    case 'enum_membership': {
      if (selected.length !== 1 || selected[0].enum_values.length === 0) {
        throw new Error(`Enum check is not executable: ${check.check_id}`);
      }
      return oneOf(selected[0].name, selected[0].enum_values);
    }
    case 'hash_format': {
      if (selected.length !== 1) throw new Error(`Invalid hash check`);
      const column = q(selected[0].name);
      return `(${column} IS NULL OR (length(${column}) = 71 AND substr(${column}, 1, 7) = 'sha256:' AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'))`;
    }
    case 'safe_integer': {
      if (selected.length !== 1) throw new Error(`Invalid integer check`);
      const column = q(selected[0].name);
      const lower = selected[0].safe_integer_intent === 'positive' ? '1' : '0';
      return `(${column} IS NULL OR ${column} BETWEEN ${lower} AND ${MAX_SAFE_INTEGER})`;
    }
    case 'boolean_integer': {
      if (selected.length !== 1) throw new Error(`Invalid boolean check`);
      return `(${q(selected[0].name)} IS NULL OR ${q(selected[0].name)} IN (0, 1))`;
    }
    case 'exactly_one':
      return `(${check.columns.map((column) => `(${present(column)})`).join(' + ')}) = 1`;
    case 'at_most_one':
      return `(${check.columns.map((column) => `(${present(column)})`).join(' + ')}) <= 1`;
    case 'all_or_none':
      return `((${allAbsent(check.columns)}) OR (${allPresent(check.columns)}))`;
    case 'state_field_consistency':
    case 'ordered_values':
    case 'cross_column_equality':
    case 'closed_target_mapping':
    case 'lineage_consistency':
      throw new Error(`Custom check is not translated: ${check.check_id}`);
  }
}
