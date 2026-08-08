PRAGMA legacy_alter_table = ON;

ALTER TABLE "workflow_state_activations" RENAME TO "workflow_state_activations_v15";

CREATE TABLE "workflow_state_activations" (
  "id" TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "state_key" TEXT NOT NULL,
  "state_type" TEXT NOT NULL,
  "activation_no" INTEGER NOT NULL,
  "workflow_definition_resource_id" TEXT NOT NULL,
  "workflow_definition_resource_hash" TEXT NOT NULL,
  "workflow_definition_version" TEXT NOT NULL,
  "state_config_value_id" TEXT NOT NULL,
  "state_config_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "graph_run_id" TEXT,
  "entered_via_transition_id" TEXT,
  "terminal_kind" TEXT,
  "terminal_output_value_id" TEXT,
  "terminal_output_hash" TEXT,
  "terminal_output_schema_hash" TEXT,
  "terminal_error_code" TEXT,
  "terminal_error_detail_value_id" TEXT,
  "terminal_error_detail_hash" TEXT,
  "started_at_ms" INTEGER NOT NULL,
  "finished_at_ms" INTEGER,
  "row_version" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_state_activations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:state_activations:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:definition" FOREIGN KEY ("workflow_definition_resource_id", "workflow_definition_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:config" FOREIGN KEY ("state_config_value_id", "state_config_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:run" FOREIGN KEY ("workflow_id", "graph_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:transition" FOREIGN KEY ("entered_via_transition_id") REFERENCES "workflow_state_transition_history" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:terminal_output" FOREIGN KEY ("terminal_output_value_id", "terminal_output_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:terminal_error" FOREIGN KEY ("terminal_error_detail_value_id", "terminal_error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_state_activations:state_type:enum" CHECK ("state_type" IN ('delegation', 'system', 'interrupt', 'graph', 'terminal')),
  CONSTRAINT "ck:workflow_state_activations:activation_no:safe_integer" CHECK ("activation_no" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "ck:workflow_state_activations:workflow_definition_resource_hash:hash" CHECK (length("workflow_definition_resource_hash") = 71 AND substr("workflow_definition_resource_hash", 1, 7) = 'sha256:' AND substr("workflow_definition_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT "ck:workflow_state_activations:state_config_hash:hash" CHECK (length("state_config_hash") = 71 AND substr("state_config_hash", 1, 7) = 'sha256:' AND substr("state_config_hash", 8) NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT "ck:workflow_state_activations:status:enum" CHECK ("status" IN ('active', 'completed', 'abandoned')),
  CONSTRAINT "ck:workflow_state_activations:terminal_kind:enum" CHECK ("terminal_kind" IN ('normal', 'errored', 'cancelled')),
  CONSTRAINT "ck:workflow_state_activations:terminal_output_hash:hash" CHECK ("terminal_output_hash" IS NULL OR (length("terminal_output_hash") = 71 AND substr("terminal_output_hash", 1, 7) = 'sha256:' AND substr("terminal_output_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_state_activations:terminal_output_schema_hash:hash" CHECK ("terminal_output_schema_hash" IS NULL OR (length("terminal_output_schema_hash") = 71 AND substr("terminal_output_schema_hash", 1, 7) = 'sha256:' AND substr("terminal_output_schema_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_state_activations:terminal_error_detail_hash:hash" CHECK ("terminal_error_detail_hash" IS NULL OR (length("terminal_error_detail_hash") = 71 AND substr("terminal_error_detail_hash", 1, 7) = 'sha256:' AND substr("terminal_error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_state_activations:started_at_ms:safe_integer" CHECK ("started_at_ms" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_state_activations:finished_at_ms:safe_integer" CHECK ("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_state_activations:row_version:safe_integer" CHECK ("row_version" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_state_activations:terminal_output_value_id:terminal_output_hash:pair" CHECK ((("terminal_output_value_id" IS NULL AND "terminal_output_hash" IS NULL) OR ("terminal_output_value_id" IS NOT NULL AND "terminal_output_hash" IS NOT NULL))),
  CONSTRAINT "ck:workflow_state_activations:terminal_error_detail_value_id:terminal_error_detail_hash:pair" CHECK ((("terminal_error_detail_value_id" IS NULL AND "terminal_error_detail_hash" IS NULL) OR ("terminal_error_detail_value_id" IS NOT NULL AND "terminal_error_detail_hash" IS NOT NULL))),
  CONSTRAINT "ck:state_activations:type_run" CHECK ((("state_type" = 'terminal' AND "status" = 'completed' AND "graph_run_id" IS NULL AND "terminal_kind" IS NOT NULL) OR ("state_type" <> 'terminal' AND "graph_run_id" IS NOT NULL AND "terminal_kind" IS NULL))),
  CONSTRAINT "ck:state_activations:status_time" CHECK ((("status" = 'active' AND "finished_at_ms" IS NULL) OR ("status" IN ('completed', 'abandoned') AND "finished_at_ms" IS NOT NULL))),
  CONSTRAINT "ck:state_activations:terminal_shape" CHECK ((("terminal_kind" = 'normal' AND "terminal_output_value_id" IS NOT NULL AND "terminal_error_code" IS NULL AND "terminal_error_detail_value_id" IS NULL) OR ("terminal_kind" = 'errored' AND "terminal_output_value_id" IS NULL AND "terminal_error_code" IS NOT NULL) OR ("terminal_kind" = 'cancelled' AND "terminal_output_value_id" IS NULL AND "terminal_error_code" IS NULL AND "terminal_error_detail_value_id" IS NULL) OR ("terminal_kind" IS NULL AND "terminal_output_value_id" IS NULL AND "terminal_error_code" IS NULL AND "terminal_error_detail_value_id" IS NULL))),
  CONSTRAINT "ck:state_activations:no_terminal_abandon" CHECK (NOT ("state_type" = 'terminal' AND "status" = 'abandoned'))
);

INSERT INTO "workflow_state_activations" (
  "id", "workflow_id", "state_key", "state_type", "activation_no",
  "workflow_definition_resource_id", "workflow_definition_resource_hash",
  "workflow_definition_version", "state_config_value_id", "state_config_hash",
  "status", "graph_run_id", "entered_via_transition_id", "terminal_kind",
  "terminal_output_value_id", "terminal_output_hash", "terminal_output_schema_hash",
  "terminal_error_code", "terminal_error_detail_value_id",
  "terminal_error_detail_hash", "started_at_ms", "finished_at_ms", "row_version"
)
SELECT
  "id", "workflow_id", "state_key", "state_type", "activation_no",
  "workflow_definition_resource_id", "workflow_definition_resource_hash",
  "workflow_definition_version", "state_config_value_id", "state_config_hash",
  "status", "graph_run_id", "entered_via_transition_id", "terminal_kind",
  "terminal_output_value_id", "terminal_output_hash", "terminal_output_schema_hash",
  "terminal_error_code", "terminal_error_detail_value_id",
  "terminal_error_detail_hash", "started_at_ms", "finished_at_ms", "row_version"
FROM "workflow_state_activations_v15";

DROP TABLE "workflow_state_activations_v15";

CREATE UNIQUE INDEX "uk:state_activations:workflow_activation" ON "workflow_state_activations" ("workflow_id", "activation_no");
CREATE UNIQUE INDEX "uk:state_activations:graph_run" ON "workflow_state_activations" ("graph_run_id") WHERE "graph_run_id" IS NOT NULL;
CREATE UNIQUE INDEX "uk:state_activations:workflow_id" ON "workflow_state_activations" ("workflow_id", "id");

ALTER TABLE "workflow_graph_events" RENAME TO "workflow_graph_events_v15";

CREATE TABLE "workflow_graph_events" (
  "graph_run_id" TEXT NOT NULL,
  "seq" INTEGER NOT NULL,
  "scope_id" TEXT,
  "node_id" TEXT,
  "attempt_id" TEXT,
  "event_type" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "payload_json" TEXT,
  "payload_value_id" TEXT,
  "payload_hash" TEXT,
  "occurred_at_ms" INTEGER NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_graph_events" PRIMARY KEY ("graph_run_id", "seq"),
  CONSTRAINT "fk:events:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:node" FOREIGN KEY ("graph_run_id", "scope_id", "node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:attempt" FOREIGN KEY ("graph_run_id", "attempt_id") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:payload" FOREIGN KEY ("payload_value_id", "payload_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_events:seq:safe_integer" CHECK ("seq" BETWEEN 1 AND 9007199254740991),
  CONSTRAINT "ck:workflow_graph_events:event_type:enum" CHECK ("event_type" IN ('node_terminal', 'node_output_published', 'wait_resolved', 'build_failed', 'control_edge_resolved', 'data_edge_resolved', 'trigger_decided', 'input_sealed', 'node_ready', 'node_skipped', 'terminal_candidate', 'completion_eligibility', 'orchestration_error', 'workflow_created', 'state_activation_created', 'run_created', 'scope_materialized', 'expansion_sealed', 'scheduler_admitted', 'attempt_created', 'attempt_phase_changed', 'retry_schedule_created', 'retry_schedule_consumed', 'wait_armed', 'scope_close_requested', 'subtree_fenced', 'effect_operation_changed', 'compensation_changed', 'provider_cancellation_requested', 'provider_cancellation_retry_scheduled', 'provider_cancellation_acknowledged', 'provider_cancellation_not_required', 'completion_cut_committed', 'child_completion_consumed', 'run_control_changed', 'operational_blocker_changed', 'runtime_command_decided', 'workflow_transition_committed', 'workflow_terminal_committed', 'root_finalization_changed', 'domain_claim_changed', 'ledger_posting_committed', 'recovery_decision_recorded')),
  CONSTRAINT "ck:workflow_graph_events:payload_hash:hash" CHECK ("payload_hash" IS NULL OR (length("payload_hash") = 71 AND substr("payload_hash", 1, 7) = 'sha256:' AND substr("payload_hash", 8) NOT GLOB '*[^0-9a-f]*')),
  CONSTRAINT "ck:workflow_graph_events:occurred_at_ms:safe_integer" CHECK ("occurred_at_ms" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_graph_events:created_at_ms:safe_integer" CHECK ("created_at_ms" BETWEEN 0 AND 9007199254740991),
  CONSTRAINT "ck:workflow_graph_events:payload_json:payload_value_id:at_most_one" CHECK ((("payload_json" IS NOT NULL) + ("payload_value_id" IS NOT NULL)) <= 1)
);

INSERT INTO "workflow_graph_events" (
  "graph_run_id", "seq", "scope_id", "node_id", "attempt_id", "event_type",
  "idempotency_key", "payload_json", "payload_value_id", "payload_hash",
  "occurred_at_ms", "created_at_ms"
)
SELECT
  "graph_run_id", "seq", "scope_id", "node_id", "attempt_id", "event_type",
  "idempotency_key", "payload_json", "payload_value_id", "payload_hash",
  "occurred_at_ms", "created_at_ms"
FROM "workflow_graph_events_v15";

DROP TABLE "workflow_graph_events_v15";

CREATE UNIQUE INDEX "uk:events:idempotency" ON "workflow_graph_events" ("idempotency_key");

CREATE TABLE "workflow_provider_cancellation_requests" (
  "id" TEXT NOT NULL,
  "graph_run_id" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "node_id" TEXT NOT NULL,
  "attempt_id" TEXT NOT NULL,
  "effect_operation_id" TEXT NOT NULL,
  "outbox_id" TEXT NOT NULL,
  "close_request_id" TEXT NOT NULL,
  "adapter_resource_id" TEXT NOT NULL,
  "adapter_resource_hash" TEXT NOT NULL,
  "adapter_ref_id" TEXT NOT NULL,
  "external_execution_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempt_count" INTEGER NOT NULL,
  "next_attempt_at_ms" INTEGER,
  "lease_owner" TEXT,
  "lease_token" TEXT,
  "lease_expires_at_ms" INTEGER,
  "last_error" TEXT,
  "requested_at_ms" INTEGER NOT NULL,
  "settled_at_ms" INTEGER,
  "updated_at_ms" INTEGER NOT NULL,
  "row_version" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_provider_cancellation_requests" PRIMARY KEY ("id"),
  CONSTRAINT "fk:provider_cancellations:attempt" FOREIGN KEY ("graph_run_id", "scope_id", "node_id", "attempt_id") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:provider_cancellations:effect" FOREIGN KEY ("effect_operation_id") REFERENCES "workflow_graph_effect_operations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:provider_cancellations:outbox" FOREIGN KEY ("outbox_id") REFERENCES "workflow_outbox" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:provider_cancellations:close_request" FOREIGN KEY ("graph_run_id", "scope_id", "close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:provider_cancellations:adapter" FOREIGN KEY ("adapter_resource_id", "adapter_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:provider_cancellations:adapter_hash" CHECK (length("adapter_resource_hash") = 71 AND substr("adapter_resource_hash", 1, 7) = 'sha256:' AND substr("adapter_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'),
  CONSTRAINT "ck:provider_cancellations:status" CHECK ("status" IN ('requested', 'processing', 'retry_wait', 'acknowledged', 'not_required')),
  CONSTRAINT "ck:provider_cancellations:lease_pair" CHECK ((("lease_owner" IS NULL AND "lease_token" IS NULL AND "lease_expires_at_ms" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL AND "lease_expires_at_ms" IS NOT NULL))),
  CONSTRAINT "ck:provider_cancellations:state_shape" CHECK ((("status" IN ('requested', 'retry_wait') AND "settled_at_ms" IS NULL AND "lease_owner" IS NULL) OR ("status" = 'processing' AND "settled_at_ms" IS NULL AND "lease_owner" IS NOT NULL) OR ("status" IN ('acknowledged', 'not_required') AND "settled_at_ms" IS NOT NULL AND "lease_owner" IS NULL AND "next_attempt_at_ms" IS NULL)))
);

CREATE UNIQUE INDEX "uk:provider_cancellations:attempt" ON "workflow_provider_cancellation_requests" ("attempt_id");
CREATE UNIQUE INDEX "uk:provider_cancellations:external_execution" ON "workflow_provider_cancellation_requests" ("external_execution_id");
CREATE INDEX "idx:provider_cancellations:due" ON "workflow_provider_cancellation_requests" ("status", "next_attempt_at_ms", "lease_expires_at_ms", "id") WHERE "status" IN ('requested', 'processing', 'retry_wait');

PRAGMA user_version = 16;
