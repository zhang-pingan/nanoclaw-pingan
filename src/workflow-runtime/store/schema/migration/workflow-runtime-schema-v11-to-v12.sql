PRAGMA legacy_alter_table = ON;

CREATE TEMP TABLE "schema11_run_guard" (
  "row_count" INTEGER NOT NULL CHECK ("row_count" = 0)
);

INSERT INTO "schema11_run_guard" ("row_count")
SELECT count(*) FROM "workflow_graph_runs";

DROP TABLE "schema11_run_guard";

DROP TABLE "workflow_graph_runs";

ALTER TABLE "workflow_registry_snapshots"
RENAME TO "workflow_registry_snapshots_v11";

CREATE TABLE "workflow_registry_snapshots" (
  "id" TEXT NOT NULL,
  "snapshot_hash" TEXT NOT NULL,
  "closure_manifest_id" TEXT NOT NULL,
  "closure_hash" TEXT NOT NULL,
  "compiler_version" TEXT NOT NULL,
  "created_at_ms" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_registry_snapshots" PRIMARY KEY ("id"),
  CONSTRAINT "fk:registry_snapshots:closure" FOREIGN KEY ("closure_manifest_id", "closure_hash") REFERENCES "workflow_registry_closure_manifests" ("id", "closure_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_snapshots:snapshot_hash:hash" CHECK (("snapshot_hash" IS NULL OR (length("snapshot_hash") = 71 AND substr("snapshot_hash", 1, 7) = 'sha256:' AND substr("snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_registry_snapshots:closure_hash:hash" CHECK (("closure_hash" IS NULL OR (length("closure_hash") = 71 AND substr("closure_hash", 1, 7) = 'sha256:' AND substr("closure_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_registry_snapshots:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991))
);

INSERT INTO "workflow_registry_snapshots" (
  "id", "snapshot_hash", "closure_manifest_id", "closure_hash",
  "compiler_version", "created_at_ms"
)
SELECT "id", "snapshot_hash", "closure_manifest_id", "closure_hash",
       "compiler_version", "created_at_ms"
FROM "workflow_registry_snapshots_v11";

DROP TABLE "workflow_registry_snapshots_v11";

CREATE UNIQUE INDEX "uk:registry_snapshots:snapshot_hash"
ON "workflow_registry_snapshots" ("snapshot_hash");

CREATE UNIQUE INDEX "uk:registry_snapshots:id_hash"
ON "workflow_registry_snapshots" ("id", "snapshot_hash");

CREATE TABLE "workflow_graph_runs" (
  "id" TEXT NOT NULL,
  "workflow_id" TEXT NOT NULL,
  "state_key" TEXT NOT NULL,
  "state_instance_id" TEXT NOT NULL,
  "workflow_definition_version" TEXT NOT NULL,
  "state_config_value_id" TEXT NOT NULL,
  "state_config_hash" TEXT NOT NULL,
  "registry_snapshot_id" TEXT NOT NULL,
  "registry_snapshot_hash" TEXT NOT NULL,
  "registry_retention_handle_id" TEXT NOT NULL,
  "runtime_safety_snapshot_value_id" TEXT NOT NULL,
  "runtime_safety_snapshot_hash" TEXT NOT NULL,
  "runtime_supported_limits_resource_id" TEXT NOT NULL,
  "runtime_supported_limits_resource_hash" TEXT NOT NULL,
  "sqlite_execution_profile_resource_id" TEXT NOT NULL,
  "sqlite_execution_profile_resource_hash" TEXT NOT NULL,
  "source_seed_hash" TEXT NOT NULL,
  "root_scope_id" TEXT NOT NULL,
  "root_build_id" TEXT NOT NULL,
  "root_plan_hash" TEXT,
  "manifest_seq" INTEGER NOT NULL,
  "manifest_head_hash" TEXT NOT NULL,
  "ledger_seq" INTEGER NOT NULL,
  "ledger_head_hash" TEXT NOT NULL,
  "lifecycle" TEXT NOT NULL,
  "control" TEXT NOT NULL,
  "operational_state" TEXT NOT NULL,
  "root_cancel_scope" TEXT,
  "root_close_request_id" TEXT,
  "completion_cut_id" TEXT,
  "work_fence_epoch" INTEGER NOT NULL,
  "outcome_kind" TEXT,
  "exit_name" TEXT,
  "output_value_id" TEXT,
  "output_hash" TEXT,
  "error_code" TEXT,
  "error_detail_value_id" TEXT,
  "error_detail_hash" TEXT,
  "next_event_seq" INTEGER NOT NULL,
  "last_admission_seq" INTEGER,
  "row_version" INTEGER NOT NULL,
  "started_at_ms" INTEGER NOT NULL,
  "finished_at_ms" INTEGER,
  "created_at_ms" INTEGER NOT NULL,
  "updated_at_ms" INTEGER NOT NULL,
  CONSTRAINT "pk:workflow_graph_runs" PRIMARY KEY ("id"),
  CONSTRAINT "fk:graph_runs:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:activation" FOREIGN KEY ("workflow_id", "state_instance_id") REFERENCES "workflow_state_activations" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:state_config" FOREIGN KEY ("state_config_value_id", "state_config_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:registry_snapshot" FOREIGN KEY ("registry_snapshot_id", "registry_snapshot_hash") REFERENCES "workflow_registry_snapshots" ("id", "snapshot_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:retention_handle" FOREIGN KEY ("registry_retention_handle_id") REFERENCES "workflow_registry_retention_handles" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:safety_snapshot" FOREIGN KEY ("runtime_safety_snapshot_value_id", "runtime_safety_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:supported_limits" FOREIGN KEY ("runtime_supported_limits_resource_id", "runtime_supported_limits_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:sqlite_profile" FOREIGN KEY ("sqlite_execution_profile_resource_id", "sqlite_execution_profile_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:root_scope" FOREIGN KEY ("id", "root_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:root_build" FOREIGN KEY ("id", "root_build_id") REFERENCES "workflow_graph_scope_builds" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:root_close" FOREIGN KEY ("id", "root_scope_id", "root_close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:completion_cut" FOREIGN KEY ("id", "root_scope_id", "completion_cut_id") REFERENCES "workflow_graph_completion_cuts" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:output" FOREIGN KEY ("output_value_id", "output_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:graph_runs:error_detail" FOREIGN KEY ("error_detail_value_id", "error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_runs:state_config_hash:hash" CHECK (("state_config_hash" IS NULL OR (length("state_config_hash") = 71 AND substr("state_config_hash", 1, 7) = 'sha256:' AND substr("state_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:registry_snapshot_hash:hash" CHECK (("registry_snapshot_hash" IS NULL OR (length("registry_snapshot_hash") = 71 AND substr("registry_snapshot_hash", 1, 7) = 'sha256:' AND substr("registry_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:runtime_safety_snapshot_hash:hash" CHECK (("runtime_safety_snapshot_hash" IS NULL OR (length("runtime_safety_snapshot_hash") = 71 AND substr("runtime_safety_snapshot_hash", 1, 7) = 'sha256:' AND substr("runtime_safety_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:runtime_supported_limits_resource_hash:hash" CHECK (("runtime_supported_limits_resource_hash" IS NULL OR (length("runtime_supported_limits_resource_hash") = 71 AND substr("runtime_supported_limits_resource_hash", 1, 7) = 'sha256:' AND substr("runtime_supported_limits_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:sqlite_execution_profile_resource_hash:hash" CHECK (("sqlite_execution_profile_resource_hash" IS NULL OR (length("sqlite_execution_profile_resource_hash") = 71 AND substr("sqlite_execution_profile_resource_hash", 1, 7) = 'sha256:' AND substr("sqlite_execution_profile_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:source_seed_hash:hash" CHECK (("source_seed_hash" IS NULL OR (length("source_seed_hash") = 71 AND substr("source_seed_hash", 1, 7) = 'sha256:' AND substr("source_seed_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:root_plan_hash:hash" CHECK (("root_plan_hash" IS NULL OR (length("root_plan_hash") = 71 AND substr("root_plan_hash", 1, 7) = 'sha256:' AND substr("root_plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:manifest_seq:safe_integer" CHECK (("manifest_seq" IS NULL OR "manifest_seq" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:manifest_head_hash:hash" CHECK (("manifest_head_hash" IS NULL OR (length("manifest_head_hash") = 71 AND substr("manifest_head_hash", 1, 7) = 'sha256:' AND substr("manifest_head_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:ledger_seq:safe_integer" CHECK (("ledger_seq" IS NULL OR "ledger_seq" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:ledger_head_hash:hash" CHECK (("ledger_head_hash" IS NULL OR (length("ledger_head_hash") = 71 AND substr("ledger_head_hash", 1, 7) = 'sha256:' AND substr("ledger_head_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:lifecycle:enum" CHECK ("lifecycle" IN ('initializing', 'executing', 'closing', 'closed')),
  CONSTRAINT "ck:workflow_graph_runs:control:enum" CHECK ("control" IN ('running', 'paused', 'resuming', 'cancelling')),
  CONSTRAINT "ck:workflow_graph_runs:operational_state:enum" CHECK ("operational_state" IN ('healthy', 'action_required', 'quarantined', 'administratively_abandoned')),
  CONSTRAINT "ck:workflow_graph_runs:root_cancel_scope:enum" CHECK ("root_cancel_scope" IN ('local_graph', 'workflow')),
  CONSTRAINT "ck:workflow_graph_runs:work_fence_epoch:safe_integer" CHECK (("work_fence_epoch" IS NULL OR "work_fence_epoch" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:outcome_kind:enum" CHECK ("outcome_kind" IN ('completed', 'errored', 'cancelled')),
  CONSTRAINT "ck:workflow_graph_runs:output_hash:hash" CHECK (("output_hash" IS NULL OR (length("output_hash") = 71 AND substr("output_hash", 1, 7) = 'sha256:' AND substr("output_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:error_detail_hash:hash" CHECK (("error_detail_hash" IS NULL OR (length("error_detail_hash") = 71 AND substr("error_detail_hash", 1, 7) = 'sha256:' AND substr("error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))),
  CONSTRAINT "ck:workflow_graph_runs:next_event_seq:safe_integer" CHECK (("next_event_seq" IS NULL OR "next_event_seq" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:last_admission_seq:safe_integer" CHECK (("last_admission_seq" IS NULL OR "last_admission_seq" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)),
  CONSTRAINT "ck:workflow_graph_runs:output_value_id:output_hash:pair" CHECK ((("output_value_id" IS NULL AND "output_hash" IS NULL) OR ("output_value_id" IS NOT NULL AND "output_hash" IS NOT NULL))),
  CONSTRAINT "ck:workflow_graph_runs:error_detail_value_id:error_detail_hash:pair" CHECK ((("error_detail_value_id" IS NULL AND "error_detail_hash" IS NULL) OR ("error_detail_value_id" IS NOT NULL AND "error_detail_hash" IS NOT NULL))),
  CONSTRAINT "ck:graph_runs:closed_shape" CHECK ((("lifecycle" = 'closed' AND "completion_cut_id" IS NOT NULL AND "outcome_kind" IS NOT NULL AND "finished_at_ms" IS NOT NULL) OR ("lifecycle" <> 'closed' AND "completion_cut_id" IS NULL))),
  CONSTRAINT "ck:graph_runs:abandon_shape" CHECK (("operational_state" <> 'administratively_abandoned' OR ("lifecycle" <> 'closed' AND "completion_cut_id" IS NULL AND "outcome_kind" IS NULL))),
  CONSTRAINT "ck:graph_runs:outcome_shape" CHECK ((("outcome_kind" = 'completed' AND "exit_name" IS NOT NULL AND "output_value_id" IS NOT NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL AND "root_cancel_scope" IS NULL) OR ("outcome_kind" = 'errored' AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NOT NULL AND "root_cancel_scope" IS NULL) OR ("outcome_kind" = 'cancelled' AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL AND "root_cancel_scope" IS NOT NULL) OR ("outcome_kind" IS NULL AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL)))
);

CREATE UNIQUE INDEX "uk:graph_runs:workflow_activation"
ON "workflow_graph_runs" ("workflow_id", "state_instance_id");

CREATE UNIQUE INDEX "uk:graph_runs:workflow_id"
ON "workflow_graph_runs" ("workflow_id", "id");

CREATE UNIQUE INDEX "uk:graph_runs:id_root_scope"
ON "workflow_graph_runs" ("id", "root_scope_id");

PRAGMA legacy_alter_table = OFF;

PRAGMA user_version = 12;
