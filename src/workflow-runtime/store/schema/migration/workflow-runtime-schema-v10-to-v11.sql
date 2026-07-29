CREATE UNIQUE INDEX "uk:command_invocations:command_id" ON "workflow_runtime_command_invocations" ("command_id", "id");

CREATE TABLE "workflow_runtime_command_ingress_invocations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "idempotency_domain" TEXT NOT NULL /* logical_type=text */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "ingress_no" INTEGER NOT NULL /* logical_type=integer */,
  "submitted_command_id" TEXT NOT NULL /* logical_type=identifier */,
  "canonical_request_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "submitted_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "command_type" TEXT NOT NULL /* logical_type=text */,
  "claimed_target_kind" TEXT NOT NULL /* logical_type=text */,
  "claimed_workflow_id" TEXT /* logical_type=identifier */,
  "claimed_run_id" TEXT /* logical_type=identifier */,
  "claimed_node_id" TEXT /* logical_type=identifier */,
  "claimed_retry_schedule_id" TEXT /* logical_type=identifier */,
  "claimed_effect_operation_id" TEXT /* logical_type=identifier */,
  "claimed_operational_blocker_id" TEXT /* logical_type=identifier */,
  "actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=command_actor_registry reference_domain=command_actor immutable=1 */,
  "actor_kind" TEXT NOT NULL /* logical_type=text */,
  "auth_session_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=authentication_session_registry reference_domain=auth_session immutable=1 */,
  "entrypoint" TEXT NOT NULL /* logical_type=text */,
  "source_feature_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "delegation_chain_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=delegation_authorization_registry reference_domain=delegation_chain immutable=1 */,
  "resolution_result" TEXT NOT NULL /* logical_type=text */,
  "authorization_result" TEXT NOT NULL /* logical_type=text */,
  "execution_result" TEXT NOT NULL /* logical_type=text */,
  "denial_code" TEXT /* logical_type=text */,
  "canonical_result_json" TEXT /* logical_type=canonical_json */,
  "canonical_result_hash" TEXT /* logical_type=hash */,
  "resolved_command_id" TEXT /* logical_type=identifier */,
  "resolved_invocation_id" TEXT /* logical_type=identifier */,
  "requested_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "decided_at_ms" INTEGER /* logical_type=integer */,
  "applied_at_ms" INTEGER /* logical_type=integer */,
  "terminal_binding_hash" TEXT /* logical_type=hash */,
  CONSTRAINT "pk:workflow_runtime_command_ingress_invocations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:command_ingress:resolved_invocation" FOREIGN KEY ("resolved_command_id", "resolved_invocation_id") REFERENCES "workflow_runtime_command_invocations" ("command_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:ingress_no:safe_integer" CHECK (("ingress_no" IS NULL OR "ingress_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=ingress_no */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:submitted_request_hash:hash" CHECK (("submitted_request_hash" IS NULL OR (length("submitted_request_hash") = 71 AND substr("submitted_request_hash", 1, 7) = 'sha256:' AND substr("submitted_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=submitted_request_hash */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:command_type:enum" CHECK ("command_type" IN ('pause_run', 'resume_run', 'cancel_run', 'cancel_workflow', 'skip_node', 'advance_retry_schedule', 'reconcile_effect', 'submit_effect_receipt', 'verify_effect_not_applied', 'remediate_operational_blocker', 'restore_integrity', 'request_administrative_abandon', 'confirm_administrative_abandon')) /* check_kind=enum_membership logical_columns=command_type */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:claimed_target_kind:enum" CHECK ("claimed_target_kind" IN ('workflow', 'run', 'node', 'retry_schedule', 'effect_operation', 'operational_blocker')) /* check_kind=enum_membership logical_columns=claimed_target_kind */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:actor_kind:enum" CHECK ("actor_kind" IN ('human', 'feature_service', 'automation', 'system')) /* check_kind=enum_membership logical_columns=actor_kind */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:entrypoint:enum" CHECK ("entrypoint" IN ('runtime_center', 'feature_page', 'feature_host_api', 'external_api', 'automation', 'card_action', 'deadline_watchdog')) /* check_kind=enum_membership logical_columns=entrypoint */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:resolution_result:enum" CHECK ("resolution_result" IN ('prepared', 'resolved', 'target_not_found', 'target_kind_invalid')) /* check_kind=enum_membership logical_columns=resolution_result */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:authorization_result:enum" CHECK ("authorization_result" IN ('pending', 'not_evaluated', 'allowed', 'denied')) /* check_kind=enum_membership logical_columns=authorization_result */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:execution_result:enum" CHECK ("execution_result" IN ('prepared', 'applied', 'denied', 'conflict', 'duplicate', 'late')) /* check_kind=enum_membership logical_columns=execution_result */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:denial_code:enum" CHECK ("denial_code" IN ('permission_denied', 'feature_ceiling_denied', 'command_policy_denied', 'state_guard_failed', 'target_not_found', 'target_kind_invalid', 'row_version_conflict', 'evidence_invalid', 'confirmation_required', 'idempotency_conflict', 'late_command')) /* check_kind=enum_membership logical_columns=denial_code */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:canonical_result_hash:hash" CHECK (("canonical_result_hash" IS NULL OR (length("canonical_result_hash") = 71 AND substr("canonical_result_hash", 1, 7) = 'sha256:' AND substr("canonical_result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_result_hash */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:terminal_binding_hash:hash" CHECK (("terminal_binding_hash" IS NULL OR (length("terminal_binding_hash") = 71 AND substr("terminal_binding_hash", 1, 7) = 'sha256:' AND substr("terminal_binding_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=terminal_binding_hash */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:requested_at_ms:safe_integer" CHECK (("requested_at_ms" IS NULL OR "requested_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=requested_at_ms */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:decided_at_ms:safe_integer" CHECK (("decided_at_ms" IS NULL OR "decided_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=decided_at_ms */,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:applied_at_ms:safe_integer" CHECK (("applied_at_ms" IS NULL OR "applied_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=applied_at_ms */,
  CONSTRAINT "ck:command_ingress:claimed_target_exactly_one" CHECK ((("claimed_workflow_id" IS NOT NULL) + ("claimed_run_id" IS NOT NULL) + ("claimed_node_id" IS NOT NULL) + ("claimed_retry_schedule_id" IS NOT NULL) + ("claimed_effect_operation_id" IS NOT NULL) + ("claimed_operational_blocker_id" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=claimed_workflow_id,claimed_run_id,claimed_node_id,claimed_retry_schedule_id,claimed_effect_operation_id,claimed_operational_blocker_id */,
  CONSTRAINT "ck:command_ingress:claimed_target_mapping" CHECK ((("claimed_target_kind" = 'workflow' AND "claimed_workflow_id" IS NOT NULL) OR ("claimed_target_kind" = 'run' AND "claimed_run_id" IS NOT NULL) OR ("claimed_target_kind" = 'node' AND "claimed_node_id" IS NOT NULL) OR ("claimed_target_kind" = 'retry_schedule' AND "claimed_retry_schedule_id" IS NOT NULL) OR ("claimed_target_kind" = 'effect_operation' AND "claimed_effect_operation_id" IS NOT NULL) OR ("claimed_target_kind" = 'operational_blocker' AND "claimed_operational_blocker_id" IS NOT NULL))) /* check_kind=closed_target_mapping logical_columns=claimed_target_kind,claimed_workflow_id,claimed_run_id,claimed_node_id,claimed_retry_schedule_id,claimed_effect_operation_id,claimed_operational_blocker_id */,
  CONSTRAINT "ck:command_ingress:canonical_request_json" CHECK (json_valid("canonical_request_json")) /* check_kind=state_field_consistency logical_columns=canonical_request_json */,
  CONSTRAINT "ck:command_ingress:canonical_result_pair" CHECK ((("canonical_result_json" IS NULL AND "canonical_result_hash" IS NULL) OR ("canonical_result_json" IS NOT NULL AND "canonical_result_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=canonical_result_json,canonical_result_hash */,
  CONSTRAINT "ck:command_ingress:resolved_pair" CHECK ((("resolved_command_id" IS NULL AND "resolved_invocation_id" IS NULL) OR ("resolved_command_id" IS NOT NULL AND "resolved_invocation_id" IS NOT NULL))) /* check_kind=all_or_none logical_columns=resolved_command_id,resolved_invocation_id */,
  CONSTRAINT "ck:command_ingress:terminal_shape" CHECK ((("resolution_result" = 'prepared' AND "authorization_result" = 'pending' AND "execution_result" = 'prepared' AND "denial_code" IS NULL AND "canonical_result_json" IS NULL AND "resolved_command_id" IS NULL AND "decided_at_ms" IS NULL AND "applied_at_ms" IS NULL AND "terminal_binding_hash" IS NULL) OR ("resolution_result" IN ('target_not_found', 'target_kind_invalid') AND "authorization_result" = 'not_evaluated' AND "execution_result" = 'denied' AND "denial_code" = "resolution_result" AND "canonical_result_json" IS NOT NULL AND "resolved_command_id" IS NULL AND "decided_at_ms" IS NOT NULL AND "applied_at_ms" IS NULL AND "terminal_binding_hash" IS NOT NULL) OR ("resolution_result" = 'resolved' AND "execution_result" IN ('applied', 'denied', 'conflict', 'duplicate', 'late') AND "canonical_result_json" IS NOT NULL AND "resolved_command_id" IS NOT NULL AND "decided_at_ms" IS NOT NULL AND "terminal_binding_hash" IS NOT NULL AND (("execution_result" = 'applied' AND "authorization_result" = 'allowed' AND "denial_code" IS NULL AND "applied_at_ms" IS NOT NULL) OR ("execution_result" = 'duplicate' AND "authorization_result" = 'not_evaluated' AND "denial_code" IS NULL AND "applied_at_ms" IS NULL) OR ("execution_result" = 'conflict' AND "denial_code" = 'idempotency_conflict' AND "authorization_result" = 'not_evaluated' AND "applied_at_ms" IS NULL) OR ("execution_result" IN ('denied', 'conflict', 'late') AND "denial_code" IS NOT NULL AND "denial_code" <> 'idempotency_conflict' AND "authorization_result" IN ('allowed', 'denied') AND "applied_at_ms" IS NULL))))) /* check_kind=state_field_consistency logical_columns=resolution_result,authorization_result,execution_result,denial_code,canonical_result_json,resolved_command_id,decided_at_ms,applied_at_ms,terminal_binding_hash */,
  CONSTRAINT "ck:command_ingress:chronology" CHECK ((("decided_at_ms" IS NULL AND "applied_at_ms" IS NULL) OR ("decided_at_ms" >= "requested_at_ms" AND ("applied_at_ms" IS NULL OR ("applied_at_ms" >= "requested_at_ms" AND "applied_at_ms" <= "decided_at_ms"))))) /* check_kind=ordered_values logical_columns=requested_at_ms,decided_at_ms,applied_at_ms */
);

CREATE UNIQUE INDEX "uk:command_ingress:domain_number" ON "workflow_runtime_command_ingress_invocations" ("idempotency_domain", "idempotency_key", "ingress_no");

CREATE UNIQUE INDEX "uk:command_ingress:resolved_invocation" ON "workflow_runtime_command_ingress_invocations" ("resolved_command_id", "resolved_invocation_id");

CREATE INDEX "idx:command_ingress:idempotency_history" ON "workflow_runtime_command_ingress_invocations" ("idempotency_domain", "idempotency_key", "ingress_no");

CREATE INDEX "idx:command_ingress:submitted_command" ON "workflow_runtime_command_ingress_invocations" ("submitted_command_id");

CREATE TRIGGER "trg:runtime_commands:pending_insert" BEFORE INSERT ON "workflow_runtime_commands" BEGIN
  SELECT CASE WHEN NEW."canonical_result_value_id" IS NOT NULL OR NEW."canonical_result_hash" IS NOT NULL OR NEW."finalized_at_ms" IS NOT NULL THEN RAISE(ABORT, 'runtime_command_must_start_pending') END;
END;

CREATE TRIGGER "trg:runtime_commands:immutable_identity" BEFORE UPDATE OF "command_id", "idempotency_domain", "idempotency_key", "command_type", "workflow_id", "run_id", "node_id", "retry_schedule_id", "effect_operation_id", "operational_blocker_id", "expected_row_version", "reason_code", "reason_text_value_id", "reason_text_hash", "evidence_manifest_value_id", "evidence_manifest_hash", "request_hash", "created_at_ms" ON "workflow_runtime_commands" BEGIN
  SELECT RAISE(ABORT, 'runtime_command_identity_is_immutable');
END;

CREATE TRIGGER "trg:runtime_commands:terminalization" BEFORE UPDATE OF "canonical_result_value_id", "canonical_result_hash", "finalized_at_ms" ON "workflow_runtime_commands" BEGIN
  SELECT CASE WHEN OLD."canonical_result_value_id" IS NOT NULL OR OLD."canonical_result_hash" IS NOT NULL OR OLD."finalized_at_ms" IS NOT NULL OR NEW."canonical_result_value_id" IS NULL OR NEW."canonical_result_hash" IS NULL OR NEW."finalized_at_ms" IS NULL OR NEW."finalized_at_ms" < NEW."created_at_ms" THEN RAISE(ABORT, 'runtime_command_terminalization_invalid') END;
END;

CREATE TRIGGER "trg:runtime_commands:immutable_delete" BEFORE DELETE ON "workflow_runtime_commands" BEGIN
  SELECT RAISE(ABORT, 'runtime_command_is_immutable');
END;

CREATE TRIGGER "trg:command_invocations:immutable_update" BEFORE UPDATE ON "workflow_runtime_command_invocations" BEGIN
  SELECT RAISE(ABORT, 'runtime_command_invocation_is_immutable');
END;

CREATE TRIGGER "trg:command_invocations:immutable_delete" BEFORE DELETE ON "workflow_runtime_command_invocations" BEGIN
  SELECT RAISE(ABORT, 'runtime_command_invocation_is_immutable');
END;

CREATE TRIGGER "trg:command_ingress:prepared_insert" BEFORE INSERT ON "workflow_runtime_command_ingress_invocations" BEGIN
  SELECT CASE WHEN NEW."resolution_result" <> 'prepared' OR NEW."authorization_result" <> 'pending' OR NEW."execution_result" <> 'prepared' THEN RAISE(ABORT, 'command_ingress_must_start_prepared') END;
END;

CREATE TRIGGER "trg:command_ingress:terminal_transition" BEFORE UPDATE ON "workflow_runtime_command_ingress_invocations" BEGIN
  SELECT CASE WHEN OLD."resolution_result" <> 'prepared' OR NEW."resolution_result" = 'prepared' OR NEW."id" IS NOT OLD."id" OR NEW."idempotency_domain" IS NOT OLD."idempotency_domain" OR NEW."idempotency_key" IS NOT OLD."idempotency_key" OR NEW."ingress_no" IS NOT OLD."ingress_no" OR NEW."submitted_command_id" IS NOT OLD."submitted_command_id" OR NEW."canonical_request_json" IS NOT OLD."canonical_request_json" OR NEW."submitted_request_hash" IS NOT OLD."submitted_request_hash" OR NEW."command_type" IS NOT OLD."command_type" OR NEW."claimed_target_kind" IS NOT OLD."claimed_target_kind" OR NEW."claimed_workflow_id" IS NOT OLD."claimed_workflow_id" OR NEW."claimed_run_id" IS NOT OLD."claimed_run_id" OR NEW."claimed_node_id" IS NOT OLD."claimed_node_id" OR NEW."claimed_retry_schedule_id" IS NOT OLD."claimed_retry_schedule_id" OR NEW."claimed_effect_operation_id" IS NOT OLD."claimed_effect_operation_id" OR NEW."claimed_operational_blocker_id" IS NOT OLD."claimed_operational_blocker_id" OR NEW."actor_ref" IS NOT OLD."actor_ref" OR NEW."actor_kind" IS NOT OLD."actor_kind" OR NEW."auth_session_ref" IS NOT OLD."auth_session_ref" OR NEW."entrypoint" IS NOT OLD."entrypoint" OR NEW."source_feature_id" IS NOT OLD."source_feature_id" OR NEW."delegation_chain_ref" IS NOT OLD."delegation_chain_ref" OR NEW."requested_at_ms" IS NOT OLD."requested_at_ms" THEN RAISE(ABORT, 'command_ingress_terminal_transition_invalid') END;
END;

CREATE TRIGGER "trg:command_ingress:immutable_delete" BEFORE DELETE ON "workflow_runtime_command_ingress_invocations" BEGIN
  SELECT RAISE(ABORT, 'command_ingress_is_immutable');
END;

CREATE TRIGGER "trg:command_confirmations:request_binding" AFTER INSERT ON "workflow_runtime_command_confirmations" BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_runtime_commands" AS command WHERE command."command_id" = NEW."request_command_id" AND command."command_type" = 'request_administrative_abandon' AND command."workflow_id" = NEW."workflow_id" AND command."expected_row_version" = NEW."expected_workflow_row_version" AND command."request_hash" = NEW."request_hash" AND command."evidence_manifest_value_id" = NEW."evidence_manifest_value_id" AND command."evidence_manifest_hash" = NEW."evidence_manifest_hash") THEN RAISE(ABORT, 'command_confirmation_request_binding_invalid') END;
END;

CREATE TRIGGER "trg:command_confirmations:actor_binding" AFTER INSERT ON "workflow_runtime_command_invocations" WHEN NEW."execution_result" = 'applied' AND EXISTS (SELECT 1 FROM "workflow_runtime_command_confirmations" AS confirmation WHERE confirmation."request_command_id" = NEW."command_id") BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_runtime_command_confirmations" AS confirmation WHERE confirmation."request_command_id" = NEW."command_id" AND confirmation."actor_ref" = NEW."actor_ref" AND confirmation."auth_session_ref" = NEW."auth_session_ref") THEN RAISE(ABORT, 'command_confirmation_actor_binding_invalid') END;
END;

CREATE TRIGGER "trg:command_confirmations:immutable_identity" BEFORE UPDATE ON "workflow_runtime_command_confirmations" BEGIN
  SELECT CASE WHEN NEW."id" IS NOT OLD."id" OR NEW."request_command_id" IS NOT OLD."request_command_id" OR NEW."workflow_id" IS NOT OLD."workflow_id" OR NEW."actor_ref" IS NOT OLD."actor_ref" OR NEW."auth_session_ref" IS NOT OLD."auth_session_ref" OR NEW."expected_workflow_row_version" IS NOT OLD."expected_workflow_row_version" OR NEW."request_hash" IS NOT OLD."request_hash" OR NEW."evidence_manifest_value_id" IS NOT OLD."evidence_manifest_value_id" OR NEW."evidence_manifest_hash" IS NOT OLD."evidence_manifest_hash" OR NEW."expires_at_ms" IS NOT OLD."expires_at_ms" THEN RAISE(ABORT, 'command_confirmation_identity_is_immutable') END;
END;

CREATE TRIGGER "trg:command_confirmations:consume_transition" BEFORE UPDATE OF "status", "consumed_at_ms", "row_version" ON "workflow_runtime_command_confirmations" BEGIN
  SELECT CASE WHEN OLD."status" <> 'pending' OR NEW."row_version" <> OLD."row_version" + 1 OR NOT ((NEW."status" = 'consumed' AND NEW."consumed_at_ms" IS NOT NULL AND NEW."consumed_at_ms" < OLD."expires_at_ms") OR (NEW."status" = 'expired' AND NEW."consumed_at_ms" IS NULL)) THEN RAISE(ABORT, 'command_confirmation_consume_transition_invalid') END;
END;

CREATE TRIGGER "trg:command_confirmations:immutable_delete" BEFORE DELETE ON "workflow_runtime_command_confirmations" BEGIN
  SELECT RAISE(ABORT, 'command_confirmation_is_immutable');
END;

PRAGMA user_version = 11;
