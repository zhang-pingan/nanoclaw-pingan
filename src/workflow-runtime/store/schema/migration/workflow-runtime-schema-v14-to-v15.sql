PRAGMA legacy_alter_table = ON;

ALTER TABLE "workflow_registry_resources" RENAME TO "workflow_registry_resources_v14";

CREATE TABLE "workflow_registry_resources" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "resource_type" TEXT NOT NULL /* logical_type=text */,
  "resource_id" TEXT NOT NULL /* logical_type=text */,
  "resource_version" TEXT NOT NULL /* logical_type=text */,
  "owner_core_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=core_release_registry reference_domain=core_release immutable=1 */,
  "owner_feature_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "owner_principal_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=principal_identity_resolver reference_domain=principal immutable=1 */,
  "canonical_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "content_hash" TEXT NOT NULL /* logical_type=hash */,
  "publication_state" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "published_at_ms" INTEGER /* logical_type=integer */,
  "retired_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_registry_resources" PRIMARY KEY ("id"),
  CONSTRAINT "fk:registry_resources:canonical_value" FOREIGN KEY ("canonical_value_id", "content_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_resources:content_hash:hash" CHECK (("content_hash" IS NULL OR (length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_registry_resources:publication_state:enum" CHECK ("publication_state" IN ('staged', 'published', 'retired')),
  CONSTRAINT "ck:workflow_registry_resources:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_registry_resources:published_at_ms:safe_integer" CHECK (("published_at_ms" IS NULL OR "published_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_registry_resources:retired_at_ms:safe_integer" CHECK (("retired_at_ms" IS NULL OR "retired_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_registry_resources:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_registry_resources:owner_core_ref:owner_feature_id:owner_principal_ref:exactly_one" CHECK ((("owner_core_ref" IS NOT NULL) + ("owner_feature_id" IS NOT NULL) + ("owner_principal_ref" IS NOT NULL)) = 1),
  CONSTRAINT "ck:registry_resources:publication_time" CHECK ((("publication_state" = 'staged' AND "published_at_ms" IS NULL AND "retired_at_ms" IS NULL) OR ("publication_state" = 'published' AND "published_at_ms" IS NOT NULL AND "retired_at_ms" IS NULL) OR ("publication_state" = 'retired' AND "published_at_ms" IS NOT NULL AND "retired_at_ms" IS NOT NULL)))
);

INSERT INTO "workflow_registry_resources" (
  "id", "resource_type", "resource_id", "resource_version", "owner_core_ref",
  "owner_feature_id", "owner_principal_ref", "canonical_value_id", "content_hash",
  "publication_state", "created_at_ms", "published_at_ms", "retired_at_ms", "row_version"
)
SELECT "id", "resource_type", "resource_id", "resource_version", "owner_core_ref",
       "owner_feature_id", NULL, "canonical_value_id", "content_hash",
       "publication_state", "created_at_ms", "published_at_ms", "retired_at_ms", "row_version"
  FROM "workflow_registry_resources_v14";

DROP TABLE "workflow_registry_resources_v14";

CREATE UNIQUE INDEX "uk:registry_resources:type_ref" ON "workflow_registry_resources" ("resource_type", "resource_id", "resource_version");
CREATE UNIQUE INDEX "uk:registry_resources:id_hash" ON "workflow_registry_resources" ("id", "content_hash");

ALTER TABLE "workflow_runtime_command_ingress_invocations" RENAME TO "workflow_runtime_command_ingress_invocations_v14";

CREATE TABLE "workflow_runtime_command_ingress_invocations" (
  "id" TEXT NOT NULL,
  "idempotency_domain" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "ingress_no" INTEGER NOT NULL,
  "submitted_command_id" TEXT NOT NULL,
  "canonical_request_json" TEXT NOT NULL,
  "submitted_request_hash" TEXT NOT NULL,
  "command_type" TEXT NOT NULL,
  "claimed_target_kind" TEXT NOT NULL,
  "claimed_workflow_id" TEXT,
  "claimed_run_id" TEXT,
  "claimed_node_id" TEXT,
  "claimed_retry_schedule_id" TEXT,
  "claimed_effect_operation_id" TEXT,
  "claimed_operational_blocker_id" TEXT,
  "actor_ref" TEXT NOT NULL,
  "actor_kind" TEXT NOT NULL,
  "auth_session_ref" TEXT NOT NULL,
  "entrypoint" TEXT NOT NULL,
  "source_feature_id" TEXT,
  "delegation_chain_ref" TEXT,
  "resolution_result" TEXT NOT NULL,
  "authorization_result" TEXT NOT NULL,
  "execution_result" TEXT NOT NULL,
  "denial_code" TEXT,
  "canonical_result_json" TEXT,
  "canonical_result_hash" TEXT,
  "resolved_command_id" TEXT,
  "resolved_invocation_id" TEXT,
  "requested_at_ms" INTEGER NOT NULL,
  "decided_at_ms" INTEGER,
  "applied_at_ms" INTEGER,
  "terminal_binding_hash" TEXT,
  CONSTRAINT "pk:workflow_runtime_command_ingress_invocations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:command_ingress:resolved_invocation" FOREIGN KEY ("resolved_command_id", "resolved_invocation_id") REFERENCES "workflow_runtime_command_invocations" ("command_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:ingress_no:safe_integer" CHECK (("ingress_no" IS NULL OR "ingress_no" BETWEEN 1 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:submitted_request_hash:hash" CHECK (("submitted_request_hash" IS NULL OR (length("submitted_request_hash") = 71 AND substr("submitted_request_hash", 1, 7) = 'sha256:' AND substr("submitted_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:command_type:enum" CHECK ("command_type" IN ('pause_run', 'resume_run', 'cancel_run', 'cancel_workflow', 'skip_node', 'advance_retry_schedule', 'reconcile_effect', 'submit_effect_receipt', 'verify_effect_not_applied', 'remediate_operational_blocker', 'restore_integrity', 'request_administrative_abandon', 'confirm_administrative_abandon')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:claimed_target_kind:enum" CHECK ("claimed_target_kind" IN ('workflow', 'run', 'node', 'retry_schedule', 'effect_operation', 'operational_blocker')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:actor_kind:enum" CHECK ("actor_kind" IN ('human', 'feature_service', 'automation', 'system')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:entrypoint:enum" CHECK ("entrypoint" IN ('runtime_center', 'feature_page', 'feature_host_api', 'external_api', 'automation', 'task_workspace', 'card_action', 'deadline_watchdog')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:resolution_result:enum" CHECK ("resolution_result" IN ('prepared', 'resolved', 'target_not_found', 'target_kind_invalid')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:authorization_result:enum" CHECK ("authorization_result" IN ('pending', 'not_evaluated', 'allowed', 'denied')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:execution_result:enum" CHECK ("execution_result" IN ('prepared', 'applied', 'denied', 'conflict', 'duplicate', 'late')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:denial_code:enum" CHECK ("denial_code" IN ('permission_denied', 'feature_ceiling_denied', 'command_policy_denied', 'state_guard_failed', 'target_not_found', 'target_kind_invalid', 'row_version_conflict', 'evidence_invalid', 'confirmation_required', 'idempotency_conflict', 'late_command')),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:canonical_result_hash:hash" CHECK (("canonical_result_hash" IS NULL OR (length("canonical_result_hash") = 71 AND substr("canonical_result_hash", 1, 7) = 'sha256:' AND substr("canonical_result_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:terminal_binding_hash:hash" CHECK (("terminal_binding_hash" IS NULL OR (length("terminal_binding_hash") = 71 AND substr("terminal_binding_hash", 1, 7) = 'sha256:' AND substr("terminal_binding_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:requested_at_ms:safe_integer" CHECK (("requested_at_ms" IS NULL OR "requested_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:decided_at_ms:safe_integer" CHECK (("decided_at_ms" IS NULL OR "decided_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_runtime_command_ingress_invocations:applied_at_ms:safe_integer" CHECK (("applied_at_ms" IS NULL OR "applied_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:command_ingress:claimed_target_exactly_one" CHECK ((("claimed_workflow_id" IS NOT NULL) + ("claimed_run_id" IS NOT NULL) + ("claimed_node_id" IS NOT NULL) + ("claimed_retry_schedule_id" IS NOT NULL) + ("claimed_effect_operation_id" IS NOT NULL) + ("claimed_operational_blocker_id" IS NOT NULL)) = 1),
  CONSTRAINT "ck:command_ingress:claimed_target_mapping" CHECK ((("claimed_target_kind" = 'workflow' AND "claimed_workflow_id" IS NOT NULL) OR ("claimed_target_kind" = 'run' AND "claimed_run_id" IS NOT NULL) OR ("claimed_target_kind" = 'node' AND "claimed_node_id" IS NOT NULL) OR ("claimed_target_kind" = 'retry_schedule' AND "claimed_retry_schedule_id" IS NOT NULL) OR ("claimed_target_kind" = 'effect_operation' AND "claimed_effect_operation_id" IS NOT NULL) OR ("claimed_target_kind" = 'operational_blocker' AND "claimed_operational_blocker_id" IS NOT NULL))),
  CONSTRAINT "ck:command_ingress:canonical_request_json" CHECK (json_valid("canonical_request_json")),
  CONSTRAINT "ck:command_ingress:canonical_result_pair" CHECK ((("canonical_result_json" IS NULL AND "canonical_result_hash" IS NULL) OR ("canonical_result_json" IS NOT NULL AND "canonical_result_hash" IS NOT NULL))),
  CONSTRAINT "ck:command_ingress:resolved_pair" CHECK ((("resolved_command_id" IS NULL AND "resolved_invocation_id" IS NULL) OR ("resolved_command_id" IS NOT NULL AND "resolved_invocation_id" IS NOT NULL))),
  CONSTRAINT "ck:command_ingress:terminal_shape" CHECK ((("resolution_result" = 'prepared' AND "authorization_result" = 'pending' AND "execution_result" = 'prepared' AND "denial_code" IS NULL AND "canonical_result_json" IS NULL AND "resolved_command_id" IS NULL AND "decided_at_ms" IS NULL AND "applied_at_ms" IS NULL AND "terminal_binding_hash" IS NULL) OR ("resolution_result" IN ('target_not_found', 'target_kind_invalid') AND "authorization_result" = 'not_evaluated' AND "execution_result" = 'denied' AND "denial_code" = "resolution_result" AND "canonical_result_json" IS NOT NULL AND "resolved_command_id" IS NULL AND "decided_at_ms" IS NOT NULL AND "applied_at_ms" IS NULL AND "terminal_binding_hash" IS NOT NULL) OR ("resolution_result" = 'resolved' AND "execution_result" IN ('applied', 'denied', 'conflict', 'duplicate', 'late') AND "canonical_result_json" IS NOT NULL AND "resolved_command_id" IS NOT NULL AND "decided_at_ms" IS NOT NULL AND "terminal_binding_hash" IS NOT NULL AND (("execution_result" = 'applied' AND "authorization_result" = 'allowed' AND "denial_code" IS NULL AND "applied_at_ms" IS NOT NULL) OR ("execution_result" = 'duplicate' AND "authorization_result" = 'not_evaluated' AND "denial_code" IS NULL AND "applied_at_ms" IS NULL) OR ("execution_result" = 'conflict' AND "denial_code" = 'idempotency_conflict' AND "authorization_result" = 'not_evaluated' AND "applied_at_ms" IS NULL) OR ("execution_result" IN ('denied', 'conflict', 'late') AND "denial_code" IS NOT NULL AND "denial_code" <> 'idempotency_conflict' AND "authorization_result" IN ('allowed', 'denied') AND "applied_at_ms" IS NULL))))),
  CONSTRAINT "ck:command_ingress:chronology" CHECK ((("decided_at_ms" IS NULL AND "applied_at_ms" IS NULL) OR ("decided_at_ms" >= "requested_at_ms" AND ("applied_at_ms" IS NULL OR ("applied_at_ms" >= "requested_at_ms" AND "applied_at_ms" <= "decided_at_ms")))))
);

INSERT INTO "workflow_runtime_command_ingress_invocations" (
  "id", "idempotency_domain", "idempotency_key", "ingress_no",
  "submitted_command_id", "canonical_request_json", "submitted_request_hash",
  "command_type", "claimed_target_kind", "claimed_workflow_id", "claimed_run_id",
  "claimed_node_id", "claimed_retry_schedule_id", "claimed_effect_operation_id",
  "claimed_operational_blocker_id", "actor_ref", "actor_kind", "auth_session_ref",
  "entrypoint", "source_feature_id", "delegation_chain_ref", "resolution_result",
  "authorization_result", "execution_result", "denial_code", "canonical_result_json",
  "canonical_result_hash", "resolved_command_id", "resolved_invocation_id",
  "requested_at_ms", "decided_at_ms", "applied_at_ms", "terminal_binding_hash"
)
SELECT "id", "idempotency_domain", "idempotency_key", "ingress_no",
       "submitted_command_id", "canonical_request_json", "submitted_request_hash",
       "command_type", "claimed_target_kind", "claimed_workflow_id", "claimed_run_id",
       "claimed_node_id", "claimed_retry_schedule_id", "claimed_effect_operation_id",
       "claimed_operational_blocker_id", "actor_ref", "actor_kind", "auth_session_ref",
       "entrypoint", "source_feature_id", "delegation_chain_ref", "resolution_result",
       "authorization_result", "execution_result", "denial_code", "canonical_result_json",
       "canonical_result_hash", "resolved_command_id", "resolved_invocation_id",
       "requested_at_ms", "decided_at_ms", "applied_at_ms", "terminal_binding_hash"
  FROM "workflow_runtime_command_ingress_invocations_v14";

DROP TABLE "workflow_runtime_command_ingress_invocations_v14";

CREATE UNIQUE INDEX "uk:command_ingress:domain_number" ON "workflow_runtime_command_ingress_invocations" ("idempotency_domain", "idempotency_key", "ingress_no");
CREATE UNIQUE INDEX "uk:command_ingress:resolved_invocation" ON "workflow_runtime_command_ingress_invocations" ("resolved_command_id", "resolved_invocation_id");
CREATE INDEX "idx:command_ingress:idempotency_history" ON "workflow_runtime_command_ingress_invocations" ("idempotency_domain", "idempotency_key", "ingress_no");
CREATE INDEX "idx:command_ingress:submitted_command" ON "workflow_runtime_command_ingress_invocations" ("submitted_command_id");

CREATE TRIGGER "trg:command_ingress:prepared_insert" BEFORE INSERT ON "workflow_runtime_command_ingress_invocations" BEGIN
  SELECT CASE WHEN NEW."resolution_result" <> 'prepared' OR NEW."authorization_result" <> 'pending' OR NEW."execution_result" <> 'prepared' THEN RAISE(ABORT, 'command_ingress_must_start_prepared') END;
END;

CREATE TRIGGER "trg:command_ingress:terminal_transition" BEFORE UPDATE ON "workflow_runtime_command_ingress_invocations" BEGIN
  SELECT CASE WHEN OLD."resolution_result" <> 'prepared' OR NEW."resolution_result" = 'prepared' OR NEW."id" IS NOT OLD."id" OR NEW."idempotency_domain" IS NOT OLD."idempotency_domain" OR NEW."idempotency_key" IS NOT OLD."idempotency_key" OR NEW."ingress_no" IS NOT OLD."ingress_no" OR NEW."submitted_command_id" IS NOT OLD."submitted_command_id" OR NEW."canonical_request_json" IS NOT OLD."canonical_request_json" OR NEW."submitted_request_hash" IS NOT OLD."submitted_request_hash" OR NEW."command_type" IS NOT OLD."command_type" OR NEW."claimed_target_kind" IS NOT OLD."claimed_target_kind" OR NEW."claimed_workflow_id" IS NOT OLD."claimed_workflow_id" OR NEW."claimed_run_id" IS NOT OLD."claimed_run_id" OR NEW."claimed_node_id" IS NOT OLD."claimed_node_id" OR NEW."claimed_retry_schedule_id" IS NOT OLD."claimed_retry_schedule_id" OR NEW."claimed_effect_operation_id" IS NOT OLD."claimed_effect_operation_id" OR NEW."claimed_operational_blocker_id" IS NOT OLD."claimed_operational_blocker_id" OR NEW."actor_ref" IS NOT OLD."actor_ref" OR NEW."actor_kind" IS NOT OLD."actor_kind" OR NEW."auth_session_ref" IS NOT OLD."auth_session_ref" OR NEW."entrypoint" IS NOT OLD."entrypoint" OR NEW."source_feature_id" IS NOT OLD."source_feature_id" OR NEW."delegation_chain_ref" IS NOT OLD."delegation_chain_ref" OR NEW."requested_at_ms" IS NOT OLD."requested_at_ms" THEN RAISE(ABORT, 'command_ingress_terminal_transition_invalid') END;
END;

CREATE TRIGGER "trg:command_ingress:immutable_delete" BEFORE DELETE ON "workflow_runtime_command_ingress_invocations" BEGIN
  SELECT RAISE(ABORT, 'command_ingress_is_immutable');
END;

CREATE TABLE "workflow_personal_releases" (
  "id" TEXT NOT NULL,
  "owner_principal_ref" TEXT NOT NULL,
  "personal_workflow_id" TEXT NOT NULL,
  "release_ref" TEXT NOT NULL,
  "release_version" TEXT NOT NULL,
  "release_hash" TEXT NOT NULL,
  "recipe_resource_id" TEXT NOT NULL,
  "recipe_resource_hash" TEXT NOT NULL,
  "graph_template_resource_id" TEXT NOT NULL,
  "graph_template_resource_hash" TEXT NOT NULL,
  "registry_snapshot_id" TEXT NOT NULL,
  "registry_snapshot_hash" TEXT NOT NULL,
  "compiled_plan_hash" TEXT NOT NULL,
  "compiler_version" TEXT NOT NULL,
  "policy_effect_envelope_json" TEXT NOT NULL,
  "policy_effect_envelope_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "published_at_ms" INTEGER NOT NULL,
  "activated_at_ms" INTEGER,
  "row_version" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_personal_releases" PRIMARY KEY ("id"),
  CONSTRAINT "fk:personal_releases:recipe" FOREIGN KEY ("recipe_resource_id", "recipe_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:personal_releases:graph_template" FOREIGN KEY ("graph_template_resource_id", "graph_template_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:personal_releases:snapshot" FOREIGN KEY ("registry_snapshot_id", "registry_snapshot_hash") REFERENCES "workflow_registry_snapshots" ("id", "snapshot_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_personal_releases:release_hash:hash" CHECK ((length("release_hash") = 71 AND substr("release_hash", 1, 7) = 'sha256:' AND substr("release_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_releases:recipe_resource_hash:hash" CHECK ((length("recipe_resource_hash") = 71 AND substr("recipe_resource_hash", 1, 7) = 'sha256:' AND substr("recipe_resource_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_releases:graph_template_resource_hash:hash" CHECK ((length("graph_template_resource_hash") = 71 AND substr("graph_template_resource_hash", 1, 7) = 'sha256:' AND substr("graph_template_resource_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_releases:registry_snapshot_hash:hash" CHECK ((length("registry_snapshot_hash") = 71 AND substr("registry_snapshot_hash", 1, 7) = 'sha256:' AND substr("registry_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_releases:compiled_plan_hash:hash" CHECK ((length("compiled_plan_hash") = 71 AND substr("compiled_plan_hash", 1, 7) = 'sha256:' AND substr("compiled_plan_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_releases:policy_effect_envelope_hash:hash" CHECK ((length("policy_effect_envelope_hash") = 71 AND substr("policy_effect_envelope_hash", 1, 7) = 'sha256:' AND substr("policy_effect_envelope_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_releases:status:enum" CHECK ("status" IN ('inactive', 'active')),
  CONSTRAINT "ck:workflow_personal_releases:published_at_ms:safe_integer" CHECK ("published_at_ms" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_personal_releases:activated_at_ms:safe_integer" CHECK (("activated_at_ms" IS NULL OR "activated_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_personal_releases:row_version:safe_integer" CHECK ("row_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "ck:personal_releases:status_time" CHECK ((("status" = 'inactive') OR ("status" = 'active' AND "activated_at_ms" IS NOT NULL AND "activated_at_ms" >= "published_at_ms")))
);

CREATE TABLE "workflow_personal_release_resources" (
  "release_id" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "resource_role" TEXT NOT NULL,
  CONSTRAINT "pk:workflow_personal_release_resources" PRIMARY KEY ("release_id", "resource_id"),
  CONSTRAINT "fk:personal_release_resources:release" FOREIGN KEY ("release_id") REFERENCES "workflow_personal_releases" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:personal_release_resources:resource" FOREIGN KEY ("resource_id", "content_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_personal_release_resources:content_hash:hash" CHECK ((length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_release_resources:resource_role:enum" CHECK ("resource_role" IN ('recipe', 'graph_template', 'closure_member'))
);

CREATE TABLE "workflow_personal_active_releases" (
  "owner_principal_ref" TEXT NOT NULL,
  "personal_workflow_id" TEXT NOT NULL,
  "release_id" TEXT NOT NULL,
  "release_hash" TEXT NOT NULL,
  "row_version" INTEGER NOT NULL,
  "activated_at_ms" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_personal_active_releases" PRIMARY KEY ("owner_principal_ref", "personal_workflow_id"),
  CONSTRAINT "fk:personal_active_releases:release" FOREIGN KEY ("release_id", "release_hash") REFERENCES "workflow_personal_releases" ("id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:personal_active_releases:owner_release" FOREIGN KEY ("owner_principal_ref", "personal_workflow_id", "release_id", "release_hash") REFERENCES "workflow_personal_releases" ("owner_principal_ref", "personal_workflow_id", "id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_personal_active_releases:release_hash:hash" CHECK ((length("release_hash") = 71 AND substr("release_hash", 1, 7) = 'sha256:' AND substr("release_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_active_releases:row_version:safe_integer" CHECK ("row_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "ck:workflow_personal_active_releases:activated_at_ms:safe_integer" CHECK ("activated_at_ms" BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE "workflow_personal_release_operations" (
  "operation_id" TEXT NOT NULL,
  "idempotency_domain" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "operation_type" TEXT NOT NULL,
  "owner_principal_ref" TEXT NOT NULL,
  "personal_workflow_id" TEXT NOT NULL,
  "target_release_id" TEXT NOT NULL,
  "target_release_hash" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "disposition" TEXT NOT NULL,
  "result_json" TEXT NOT NULL,
  "failure_code" TEXT,
  "requested_at_ms" INTEGER NOT NULL,
  "completed_at_ms" INTEGER NOT NULL,
  "row_version" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_personal_release_operations" PRIMARY KEY ("operation_id"),
  CONSTRAINT "fk:personal_release_operations:target_release" FOREIGN KEY ("target_release_id", "target_release_hash") REFERENCES "workflow_personal_releases" ("id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_personal_release_operations:operation_type:enum" CHECK ("operation_type" IN ('publish', 'activate')),
  CONSTRAINT "ck:workflow_personal_release_operations:target_release_hash:hash" CHECK ((length("target_release_hash") = 71 AND substr("target_release_hash", 1, 7) = 'sha256:' AND substr("target_release_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_release_operations:request_hash:hash" CHECK ((length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_personal_release_operations:disposition:enum" CHECK ("disposition" IN ('applied', 'failed')),
  CONSTRAINT "ck:workflow_personal_release_operations:requested_at_ms:safe_integer" CHECK ("requested_at_ms" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_personal_release_operations:completed_at_ms:safe_integer" CHECK ("completed_at_ms" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_personal_release_operations:row_version:safe_integer" CHECK ("row_version" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "ck:personal_release_operations:result" CHECK ("completed_at_ms" >= "requested_at_ms" AND (("disposition" = 'applied' AND "failure_code" IS NULL) OR ("disposition" = 'failed' AND "failure_code" IS NOT NULL)))
);

CREATE UNIQUE INDEX "uk:personal_releases:owner_version" ON "workflow_personal_releases" ("owner_principal_ref", "personal_workflow_id", "release_ref", "release_version");
CREATE UNIQUE INDEX "uk:personal_releases:id_hash" ON "workflow_personal_releases" ("id", "release_hash");
CREATE UNIQUE INDEX "uk:personal_releases:owner_identity" ON "workflow_personal_releases" ("owner_principal_ref", "personal_workflow_id", "id", "release_hash");
CREATE UNIQUE INDEX "uk:personal_releases:single_active" ON "workflow_personal_releases" ("owner_principal_ref", "personal_workflow_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "uk:personal_release_resources:role" ON "workflow_personal_release_resources" ("release_id", "resource_role") WHERE "resource_role" IN ('recipe', 'graph_template');
CREATE UNIQUE INDEX "uk:personal_release_operations:idempotency" ON "workflow_personal_release_operations" ("idempotency_domain", "idempotency_key");
CREATE INDEX "idx:personal_releases:principal_status" ON "workflow_personal_releases" ("owner_principal_ref", "status", "personal_workflow_id", "published_at_ms");

PRAGMA legacy_alter_table = OFF;
PRAGMA user_version = 15;
