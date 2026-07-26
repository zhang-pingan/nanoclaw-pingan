PRAGMA legacy_alter_table = ON;

ALTER TABLE "workflow_graph_child_completion_consumptions" RENAME TO "workflow_graph_child_completion_consumptions_schema8";

CREATE TABLE "workflow_graph_child_completion_consumptions" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "child_scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "child_completion_cut_id" TEXT NOT NULL /* logical_type=identifier */,
  "parent_scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "owner_node_id" TEXT NOT NULL /* logical_type=identifier */,
  "map_slot_id" TEXT /* logical_type=identifier */,
  "map_slot_outcome_state" TEXT /* logical_type=text */,
  "disposition" TEXT NOT NULL /* logical_type=text */,
  "parent_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "disposition_event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_child_completion_consumptions" PRIMARY KEY ("id"),
  CONSTRAINT "fk:child_consumptions:child_scope_lineage" FOREIGN KEY ("graph_run_id", "child_scope_id", "parent_scope_id", "owner_node_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id", "parent_scope_id", "owner_node_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:child_consumptions:child_cut_lineage" FOREIGN KEY ("graph_run_id", "child_scope_id", "child_completion_cut_id") REFERENCES "workflow_graph_completion_cuts" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:child_consumptions:parent_scope_lineage" FOREIGN KEY ("graph_run_id", "parent_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:child_consumptions:owner_node_lineage" FOREIGN KEY ("graph_run_id", "parent_scope_id", "owner_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:child_consumptions:map_slot_lineage" FOREIGN KEY ("graph_run_id", "parent_scope_id", "owner_node_id", "map_slot_id", "child_scope_id", "map_slot_outcome_state") REFERENCES "workflow_graph_map_item_results" ("graph_run_id", "owner_scope_id", "owner_node_id", "id", "scope_id", "outcome_state") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:child_consumptions:disposition_event_lineage" FOREIGN KEY ("graph_run_id", "disposition_event_seq") REFERENCES "workflow_graph_events" ("graph_run_id", "seq") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_child_completion_consumptions:disposition:enum" CHECK ("disposition" IN ('owner_output_published', 'map_slot_completed', 'map_slot_errored', 'map_slot_cancelled', 'map_slot_fenced', 'non_publish_parent_fenced', 'non_publish_owner_fenced')) /* check_kind=enum_membership logical_columns=disposition */,
  CONSTRAINT "ck:workflow_graph_child_completion_consumptions:parent_work_fence_epoch:safe_integer" CHECK (("parent_work_fence_epoch" IS NULL OR "parent_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=parent_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_child_completion_consumptions:disposition_event_seq:safe_integer" CHECK (("disposition_event_seq" IS NULL OR "disposition_event_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=disposition_event_seq */,
  CONSTRAINT "ck:workflow_graph_child_completion_consumptions:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_child_completion_consumptions:map_slot_outcome_state:enum" CHECK ("map_slot_outcome_state" IN ('completed', 'errored', 'cancelled', 'fenced')) /* check_kind=enum_membership logical_columns=map_slot_outcome_state */,
  CONSTRAINT "ck:child_consumptions:terminal_disposition_lineage" CHECK ((("disposition" = 'map_slot_completed' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = 'completed') OR ("disposition" = 'map_slot_errored' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = 'errored') OR ("disposition" = 'map_slot_cancelled' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = 'cancelled') OR ("disposition" = 'map_slot_fenced' AND "map_slot_id" IS NOT NULL AND "map_slot_outcome_state" IS NOT NULL AND "map_slot_outcome_state" = 'fenced') OR ("disposition" IN ('owner_output_published', 'non_publish_parent_fenced', 'non_publish_owner_fenced') AND "map_slot_id" IS NULL AND "map_slot_outcome_state" IS NULL))) /* check_kind=state_field_consistency logical_columns=disposition,map_slot_id,map_slot_outcome_state */
);

INSERT INTO "workflow_graph_child_completion_consumptions" ("id", "graph_run_id", "child_scope_id", "child_completion_cut_id", "parent_scope_id", "owner_node_id", "map_slot_id", "map_slot_outcome_state", "disposition", "parent_work_fence_epoch", "disposition_event_seq", "created_at_ms") SELECT "id", "graph_run_id", "child_scope_id", "child_completion_cut_id", "parent_scope_id", "owner_node_id", "map_slot_id", "map_slot_outcome_state", "disposition", "parent_work_fence_epoch", "disposition_event_seq", "created_at_ms" FROM "workflow_graph_child_completion_consumptions_schema8";

DROP TABLE "workflow_graph_child_completion_consumptions_schema8";

CREATE UNIQUE INDEX "uk:child_consumptions:child_scope" ON "workflow_graph_child_completion_consumptions" ("child_scope_id");

CREATE UNIQUE INDEX "uk:child_consumptions:run_child_scope" ON "workflow_graph_child_completion_consumptions" ("graph_run_id", "child_scope_id");

PRAGMA legacy_alter_table = OFF;

PRAGMA user_version = 9;
