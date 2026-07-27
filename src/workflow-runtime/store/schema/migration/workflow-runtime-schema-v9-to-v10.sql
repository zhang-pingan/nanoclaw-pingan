PRAGMA legacy_alter_table = ON;

ALTER TABLE "workflow_graph_effect_operation_claims" RENAME TO "workflow_graph_effect_operation_claims_schema9";

ALTER TABLE "workflow_domain_resource_claims" RENAME TO "workflow_domain_resource_claims_schema9";

ALTER TABLE "workflow_domain_resource_heads" RENAME TO "workflow_domain_resource_heads_schema9";

CREATE UNIQUE INDEX "uk:effect_operations:id_run" ON "workflow_graph_effect_operations" ("id", "graph_run_id");

CREATE UNIQUE INDEX "uk:root_finalization_schedules:handoff_child" ON "workflow_root_finalization_schedules" ("id", "workflow_id", "creation_request_id", "child_workflow_id", "status");

CREATE UNIQUE INDEX "uk:workflow_relations:id_parent_child" ON "workflow_relations" ("id", "parent_workflow_id", "child_workflow_id");

CREATE TABLE "workflow_domain_resource_claims" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "namespace" TEXT NOT NULL /* logical_type=text */,
  "key_hash" TEXT NOT NULL /* logical_type=hash */,
  "mode" TEXT NOT NULL /* logical_type=text */,
  "owner_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "recipe_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "recipe_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "source_intake_id" TEXT NOT NULL /* logical_type=identifier */,
  "creation_key" TEXT NOT NULL /* logical_type=text */,
  "fencing_token" INTEGER /* logical_type=integer */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "acquired_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "released_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "claim_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "fencing_token_identity" INTEGER NOT NULL /* logical_type=integer */,
  "acquisition_kind" TEXT NOT NULL /* logical_type=text */,
  "predecessor_claim_id" TEXT /* logical_type=identifier */,
  "handoff_id" TEXT /* logical_type=identifier */,
  "active_head_claim_id" TEXT /* logical_type=identifier */,
  CONSTRAINT "pk:workflow_domain_resource_claims" PRIMARY KEY ("id"),
  CONSTRAINT "fk:domain_claims:workflow" FOREIGN KEY ("owner_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claims:recipe" FOREIGN KEY ("recipe_resource_id", "recipe_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claims:intake" FOREIGN KEY ("source_intake_id") REFERENCES "workflow_task_intakes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claims:active_head" FOREIGN KEY ("namespace", "key_hash", "active_head_claim_id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity") REFERENCES "workflow_domain_resource_heads" ("namespace", "key_hash", "active_claim_id", "active_claim_owner_workflow_id", "active_claim_mode", "active_claim_epoch", "active_fencing_token_identity") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claims:predecessor_resource" FOREIGN KEY ("namespace", "key_hash", "predecessor_claim_id") REFERENCES "workflow_domain_resource_claims" ("namespace", "key_hash", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claims:handoff_chain" FOREIGN KEY ("handoff_id", "id", "predecessor_claim_id") REFERENCES "workflow_domain_resource_claim_handoffs" ("id", "child_claim_id", "parent_claim_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_domain_resource_claims:key_hash:hash" CHECK (("key_hash" IS NULL OR (length("key_hash") = 71 AND substr("key_hash", 1, 7) = 'sha256:' AND substr("key_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=key_hash */,
  CONSTRAINT "ck:workflow_domain_resource_claims:mode:enum" CHECK ("mode" IN ('shared', 'exclusive')) /* check_kind=enum_membership logical_columns=mode */,
  CONSTRAINT "ck:workflow_domain_resource_claims:recipe_resource_hash:hash" CHECK (("recipe_resource_hash" IS NULL OR (length("recipe_resource_hash") = 71 AND substr("recipe_resource_hash", 1, 7) = 'sha256:' AND substr("recipe_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=recipe_resource_hash */,
  CONSTRAINT "ck:workflow_domain_resource_claims:fencing_token:safe_integer" CHECK (("fencing_token" IS NULL OR "fencing_token" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=fencing_token */,
  CONSTRAINT "ck:workflow_domain_resource_claims:status:enum" CHECK ("status" IN ('held', 'release_pending', 'released')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_domain_resource_claims:acquired_at_ms:safe_integer" CHECK (("acquired_at_ms" IS NULL OR "acquired_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=acquired_at_ms */,
  CONSTRAINT "ck:workflow_domain_resource_claims:released_at_ms:safe_integer" CHECK (("released_at_ms" IS NULL OR "released_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=released_at_ms */,
  CONSTRAINT "ck:workflow_domain_resource_claims:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:domain_claims:fencing_mode" CHECK ((("mode" = 'exclusive' AND "fencing_token" IS NOT NULL) OR ("mode" = 'shared' AND "fencing_token" IS NULL))) /* check_kind=state_field_consistency logical_columns=mode,fencing_token */,
  CONSTRAINT "ck:domain_claims:release_state" CHECK ((("status" = 'released' AND "released_at_ms" IS NOT NULL) OR ("status" IN ('held', 'release_pending') AND "released_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,released_at_ms */,
  CONSTRAINT "ck:domain_claims:acquisition_kind:enum" CHECK ("acquisition_kind" IN ('direct', 'handoff')) /* check_kind=enum_membership logical_columns=acquisition_kind */,
  CONSTRAINT "ck:workflow_domain_resource_claims:acquisition_kind:enum" CHECK ("acquisition_kind" IN ('direct', 'handoff')) /* check_kind=enum_membership logical_columns=acquisition_kind */,
  CONSTRAINT "ck:domain_claims:fencing_identity" CHECK ((("mode" = 'shared' AND "fencing_token" IS NULL AND "fencing_token_identity" = 0) OR ("mode" = 'exclusive' AND "fencing_token" IS NOT NULL AND "fencing_token" > 0 AND "fencing_token_identity" = "fencing_token"))) /* check_kind=state_field_consistency logical_columns=mode,fencing_token,fencing_token_identity */,
  CONSTRAINT "ck:domain_claims:active_head_state" CHECK ((("status" IN ('held', 'release_pending') AND "active_head_claim_id" = "id" AND "released_at_ms" IS NULL) OR ("status" = 'released' AND "active_head_claim_id" IS NULL AND "released_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=id,status,active_head_claim_id,released_at_ms */,
  CONSTRAINT "ck:domain_claims:acquisition_lineage" CHECK ((("acquisition_kind" = 'direct' AND "predecessor_claim_id" IS NULL AND "handoff_id" IS NULL) OR ("acquisition_kind" = 'handoff' AND "predecessor_claim_id" IS NOT NULL AND "handoff_id" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=acquisition_kind,predecessor_claim_id,handoff_id */
);

CREATE TABLE "workflow_domain_resource_heads" (
  "namespace" TEXT NOT NULL /* logical_type=text */,
  "key_hash" TEXT NOT NULL /* logical_type=hash */,
  "current_fencing_token" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "latest_claim_epoch" INTEGER NOT NULL DEFAULT 0 /* logical_type=integer */,
  "active_claim_id" TEXT /* logical_type=identifier */,
  "active_claim_mode" TEXT /* logical_type=text */,
  "active_claim_owner_workflow_id" TEXT /* logical_type=identifier */,
  "active_claim_epoch" INTEGER /* logical_type=integer */,
  "active_fencing_token_identity" INTEGER /* logical_type=integer */,
  "active_claim_link_id" TEXT /* logical_type=identifier */,
  CONSTRAINT "pk:workflow_domain_resource_heads" PRIMARY KEY ("namespace", "key_hash"),
  CONSTRAINT "fk:domain_resource_heads:active_claim" FOREIGN KEY ("namespace", "key_hash", "active_claim_id", "active_claim_owner_workflow_id", "active_claim_mode", "active_claim_epoch", "active_fencing_token_identity", "active_claim_link_id") REFERENCES "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity", "active_head_claim_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_domain_resource_heads:key_hash:hash" CHECK (("key_hash" IS NULL OR (length("key_hash") = 71 AND substr("key_hash", 1, 7) = 'sha256:' AND substr("key_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=key_hash */,
  CONSTRAINT "ck:workflow_domain_resource_heads:current_fencing_token:safe_integer" CHECK (("current_fencing_token" IS NULL OR "current_fencing_token" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=current_fencing_token */,
  CONSTRAINT "ck:workflow_domain_resource_heads:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:domain_resource_heads:active_claim_mode:enum" CHECK ("active_claim_mode" IN ('shared', 'exclusive')) /* check_kind=enum_membership logical_columns=active_claim_mode */,
  CONSTRAINT "ck:workflow_domain_resource_heads:active_claim_mode:enum" CHECK ("active_claim_mode" IN ('shared', 'exclusive')) /* check_kind=enum_membership logical_columns=active_claim_mode */,
  CONSTRAINT "ck:domain_resource_heads:active_shape" CHECK ((("active_claim_id" IS NULL AND "active_claim_owner_workflow_id" IS NULL AND "active_claim_mode" IS NULL AND "active_claim_epoch" IS NULL AND "active_fencing_token_identity" IS NULL AND "active_claim_link_id" IS NULL) OR ("active_claim_id" IS NOT NULL AND "active_claim_link_id" = "active_claim_id" AND "active_claim_owner_workflow_id" IS NOT NULL AND "active_claim_mode" IS NOT NULL AND "active_claim_epoch" IS NOT NULL AND "active_claim_epoch" > 0 AND "active_claim_epoch" <= "latest_claim_epoch" AND (("active_claim_mode" = 'shared' AND "active_fencing_token_identity" = 0) OR ("active_claim_mode" = 'exclusive' AND "active_fencing_token_identity" = "current_fencing_token" AND "active_fencing_token_identity" > 0))))) /* check_kind=state_field_consistency logical_columns=current_fencing_token,latest_claim_epoch,active_claim_id,active_claim_owner_workflow_id,active_claim_mode,active_claim_epoch,active_fencing_token_identity,active_claim_link_id */
);

CREATE TABLE "workflow_domain_resource_claim_handoffs" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "namespace" TEXT NOT NULL /* logical_type=text */,
  "key_hash" TEXT NOT NULL /* logical_type=hash */,
  "parent_claim_id" TEXT NOT NULL /* logical_type=identifier */,
  "parent_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "parent_claim_mode" TEXT NOT NULL /* logical_type=text */,
  "parent_claim_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "parent_fencing_token" INTEGER NOT NULL /* logical_type=integer */,
  "child_claim_id" TEXT NOT NULL /* logical_type=identifier */,
  "child_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "child_claim_mode" TEXT NOT NULL /* logical_type=text */,
  "child_claim_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "child_fencing_token" INTEGER NOT NULL /* logical_type=integer */,
  "source_root_finalization_schedule_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_creation_request_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_workflow_relation_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_root_finalization_schedule_status" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_domain_resource_claim_handoffs" PRIMARY KEY ("id"),
  CONSTRAINT "fk:domain_claim_handoffs:parent_claim" FOREIGN KEY ("namespace", "key_hash", "parent_claim_id", "parent_workflow_id", "parent_claim_mode", "parent_claim_epoch", "parent_fencing_token") REFERENCES "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claim_handoffs:child_claim" FOREIGN KEY ("namespace", "key_hash", "child_claim_id", "child_workflow_id", "child_claim_mode", "child_claim_epoch", "child_fencing_token") REFERENCES "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claim_handoffs:schedule_child" FOREIGN KEY ("source_root_finalization_schedule_id", "parent_workflow_id", "source_creation_request_id", "child_workflow_id", "source_root_finalization_schedule_status") REFERENCES "workflow_root_finalization_schedules" ("id", "workflow_id", "creation_request_id", "child_workflow_id", "status") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:domain_claim_handoffs:workflow_relation" FOREIGN KEY ("source_workflow_relation_id", "parent_workflow_id", "child_workflow_id") REFERENCES "workflow_relations" ("id", "parent_workflow_id", "child_workflow_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:domain_claim_handoffs:parent_claim_mode:enum" CHECK ("parent_claim_mode" IN ('exclusive')) /* check_kind=enum_membership logical_columns=parent_claim_mode */,
  CONSTRAINT "ck:domain_claim_handoffs:child_claim_mode:enum" CHECK ("child_claim_mode" IN ('exclusive')) /* check_kind=enum_membership logical_columns=child_claim_mode */,
  CONSTRAINT "ck:domain_claim_handoffs:source_root_finalization_schedule_status:enum" CHECK ("source_root_finalization_schedule_status" IN ('succeeded')) /* check_kind=enum_membership logical_columns=source_root_finalization_schedule_status */,
  CONSTRAINT "ck:domain_claim_handoffs:exclusive_token_step" CHECK (("parent_claim_id" <> "child_claim_id" AND "parent_workflow_id" <> "child_workflow_id" AND "parent_claim_mode" = 'exclusive' AND "child_claim_mode" = 'exclusive' AND "parent_fencing_token" < 9007199254740991 AND "child_fencing_token" = "parent_fencing_token" + 1 AND "parent_claim_epoch" < 9007199254740991 AND "child_claim_epoch" = "parent_claim_epoch" + 1)) /* check_kind=state_field_consistency logical_columns=parent_claim_id,child_claim_id,parent_workflow_id,child_workflow_id,parent_claim_mode,child_claim_mode,parent_fencing_token,child_fencing_token,parent_claim_epoch,child_claim_epoch */
);

CREATE TABLE "workflow_graph_effect_operation_claims" (
  "operation_id" TEXT NOT NULL /* logical_type=identifier */,
  "claim_id" TEXT NOT NULL /* logical_type=identifier */,
  "claim_spec_id" TEXT NOT NULL /* logical_type=text */,
  "access" TEXT NOT NULL /* logical_type=text */,
  "fencing_token" INTEGER /* logical_type=integer */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "owner_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "namespace" TEXT NOT NULL /* logical_type=text */,
  "key_hash" TEXT NOT NULL /* logical_type=hash */,
  "claim_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "fencing_token_identity" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_effect_operation_claims" PRIMARY KEY ("operation_id", "claim_id"),
  CONSTRAINT "fk:effect_claims:operation" FOREIGN KEY ("operation_id") REFERENCES "workflow_graph_effect_operations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_claims:claim_exact" FOREIGN KEY ("namespace", "key_hash", "claim_id", "owner_workflow_id", "claim_epoch", "fencing_token_identity") REFERENCES "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "claim_epoch", "fencing_token_identity") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_claims:operation_run" FOREIGN KEY ("operation_id", "graph_run_id") REFERENCES "workflow_graph_effect_operations" ("id", "graph_run_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_claims:run_owner" FOREIGN KEY ("graph_run_id", "owner_workflow_id") REFERENCES "workflow_graph_runs" ("id", "workflow_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_effect_operation_claims:access:enum" CHECK ("access" IN ('read', 'write')) /* check_kind=enum_membership logical_columns=access */,
  CONSTRAINT "ck:workflow_graph_effect_operation_claims:fencing_token:safe_integer" CHECK (("fencing_token" IS NULL OR "fencing_token" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=fencing_token */,
  CONSTRAINT "ck:effect_claims:write_fence" CHECK ((("access" = 'write' AND "fencing_token" IS NOT NULL) OR ("access" = 'read' AND "fencing_token" IS NULL))) /* check_kind=state_field_consistency logical_columns=access,fencing_token */,
  CONSTRAINT "ck:effect_claims:fencing_identity" CHECK ((("access" = 'write' AND "fencing_token" IS NOT NULL AND "fencing_token" > 0 AND "fencing_token_identity" = "fencing_token") OR ("access" = 'read' AND "fencing_token" IS NULL AND "fencing_token_identity" = 0))) /* check_kind=state_field_consistency logical_columns=access,fencing_token,fencing_token_identity */
);

CREATE UNIQUE INDEX "uk:domain_claims:resource_epoch" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "claim_epoch");

CREATE UNIQUE INDEX "uk:domain_claims:exact_identity" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity");

CREATE UNIQUE INDEX "uk:domain_claims:head_identity" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity", "active_head_claim_id");

CREATE UNIQUE INDEX "uk:domain_claims:effect_identity" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "claim_epoch", "fencing_token_identity");

CREATE UNIQUE INDEX "uk:domain_claims:handoff_chain" ON "workflow_domain_resource_claims" ("handoff_id", "id", "predecessor_claim_id");

CREATE UNIQUE INDEX "uk:domain_claims:resource_id" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id");

CREATE UNIQUE INDEX "uk:domain_resource_heads:active_claim" ON "workflow_domain_resource_heads" ("namespace", "key_hash", "active_claim_id", "active_claim_owner_workflow_id", "active_claim_mode", "active_claim_epoch", "active_fencing_token_identity");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:parent_claim" ON "workflow_domain_resource_claim_handoffs" ("parent_claim_id");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:child_claim" ON "workflow_domain_resource_claim_handoffs" ("child_claim_id");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:schedule_resource" ON "workflow_domain_resource_claim_handoffs" ("source_root_finalization_schedule_id", "namespace", "key_hash");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:chain" ON "workflow_domain_resource_claim_handoffs" ("id", "child_claim_id", "parent_claim_id");

CREATE TEMP TABLE "r022_schema9_history_guard" ("violation_count" INTEGER NOT NULL CHECK ("violation_count" = 0));

INSERT INTO "r022_schema9_history_guard" ("violation_count") SELECT count(*) FROM "workflow_domain_resource_claims_schema9" AS claim LEFT JOIN "workflow_domain_resource_heads_schema9" AS head ON head."namespace" = claim."namespace" AND head."key_hash" = claim."key_hash" WHERE (claim."mode" = 'exclusive' AND (head."namespace" IS NULL OR head."current_fencing_token" IS NOT claim."fencing_token")) OR (claim."mode" = 'shared' AND head."namespace" IS NOT NULL);

INSERT INTO "workflow_domain_resource_claims" ("id", "namespace", "key_hash", "mode", "owner_workflow_id", "recipe_resource_id", "recipe_resource_hash", "source_intake_id", "creation_key", "fencing_token", "status", "acquired_at_ms", "released_at_ms", "row_version", "claim_epoch", "fencing_token_identity", "acquisition_kind", "predecessor_claim_id", "handoff_id", "active_head_claim_id") SELECT "id", "namespace", "key_hash", "mode", "owner_workflow_id", "recipe_resource_id", "recipe_resource_hash", "source_intake_id", "creation_key", "fencing_token", "status", "acquired_at_ms", "released_at_ms", "row_version", 1, coalesce("fencing_token", 0), 'direct', NULL, NULL, CASE WHEN "status" IN ('held', 'release_pending') THEN "id" ELSE NULL END FROM "workflow_domain_resource_claims_schema9";

INSERT INTO "workflow_domain_resource_heads" ("namespace", "key_hash", "current_fencing_token", "row_version", "latest_claim_epoch", "active_claim_id", "active_claim_owner_workflow_id", "active_claim_mode", "active_claim_epoch", "active_fencing_token_identity", "active_claim_link_id") SELECT head."namespace", head."key_hash", head."current_fencing_token", head."row_version", CASE WHEN claim."id" IS NULL THEN 0 ELSE 1 END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."id" ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."owner_workflow_id" ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."mode" ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN 1 ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN coalesce(claim."fencing_token", 0) ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."id" ELSE NULL END FROM "workflow_domain_resource_heads_schema9" AS head LEFT JOIN "workflow_domain_resource_claims_schema9" AS claim ON claim."namespace" = head."namespace" AND claim."key_hash" = head."key_hash";

INSERT INTO "workflow_domain_resource_heads" ("namespace", "key_hash", "current_fencing_token", "row_version", "latest_claim_epoch", "active_claim_id", "active_claim_owner_workflow_id", "active_claim_mode", "active_claim_epoch", "active_fencing_token_identity", "active_claim_link_id") SELECT claim."namespace", claim."key_hash", 0, 1, 1, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."id" ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."owner_workflow_id" ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."mode" ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN 1 ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN 0 ELSE NULL END, CASE WHEN claim."status" IN ('held', 'release_pending') THEN claim."id" ELSE NULL END FROM "workflow_domain_resource_claims_schema9" AS claim LEFT JOIN "workflow_domain_resource_heads_schema9" AS head ON head."namespace" = claim."namespace" AND head."key_hash" = claim."key_hash" WHERE claim."mode" = 'shared' AND head."namespace" IS NULL;

INSERT INTO "workflow_graph_effect_operation_claims" ("operation_id", "claim_id", "claim_spec_id", "access", "fencing_token", "graph_run_id", "owner_workflow_id", "namespace", "key_hash", "claim_epoch", "fencing_token_identity") SELECT "effect_claim"."operation_id", "effect_claim"."claim_id", "effect_claim"."claim_spec_id", "effect_claim"."access", "effect_claim"."fencing_token", operation."graph_run_id", claim."owner_workflow_id", claim."namespace", claim."key_hash", 1, coalesce(claim."fencing_token", 0) FROM "workflow_graph_effect_operation_claims_schema9" AS effect_claim JOIN "workflow_domain_resource_claims_schema9" AS claim ON claim."id" = effect_claim."claim_id" JOIN "workflow_graph_effect_operations" AS operation ON operation."id" = effect_claim."operation_id";

INSERT INTO "r022_schema9_history_guard" ("violation_count") SELECT abs((SELECT count(*) FROM "workflow_domain_resource_claims_schema9") - (SELECT count(*) FROM "workflow_domain_resource_claims"));

INSERT INTO "r022_schema9_history_guard" ("violation_count") SELECT abs((SELECT count(*) FROM "workflow_graph_effect_operation_claims_schema9") - (SELECT count(*) FROM "workflow_graph_effect_operation_claims"));

INSERT INTO "r022_schema9_history_guard" ("violation_count") SELECT abs(((SELECT count(*) FROM "workflow_domain_resource_heads_schema9") + (SELECT count(*) FROM "workflow_domain_resource_claims_schema9" AS claim LEFT JOIN "workflow_domain_resource_heads_schema9" AS head ON head."namespace" = claim."namespace" AND head."key_hash" = claim."key_hash" WHERE claim."mode" = 'shared' AND head."namespace" IS NULL)) - (SELECT count(*) FROM "workflow_domain_resource_heads"));

DROP TABLE "r022_schema9_history_guard";

DROP TABLE "workflow_graph_effect_operation_claims_schema9";

DROP TABLE "workflow_domain_resource_heads_schema9";

DROP TABLE "workflow_domain_resource_claims_schema9";

CREATE INDEX "idx:domain_claims:resource_status" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "status", "mode");

CREATE INDEX "idx:domain_claims:resource_history" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "claim_epoch", "id");

CREATE INDEX "idx:domain_claim_handoffs:resource_history" ON "workflow_domain_resource_claim_handoffs" ("namespace", "key_hash", "child_claim_epoch", "id");

CREATE TRIGGER "trg:domain_claims:immutable_identity" BEFORE UPDATE OF "id", "namespace", "key_hash", "mode", "owner_workflow_id", "recipe_resource_id", "recipe_resource_hash", "source_intake_id", "creation_key", "fencing_token", "acquired_at_ms", "claim_epoch", "fencing_token_identity", "acquisition_kind", "predecessor_claim_id", "handoff_id" ON "workflow_domain_resource_claims" BEGIN
  SELECT RAISE(ABORT, 'domain_claim_identity_is_immutable');
END;

CREATE TRIGGER "trg:domain_claims:release_transition" BEFORE UPDATE ON "workflow_domain_resource_claims" BEGIN
  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR NOT ((OLD."status" = 'held' AND NEW."status" = 'release_pending' AND NEW."released_at_ms" IS NULL AND NEW."active_head_claim_id" = NEW."id") OR (OLD."status" IN ('held', 'release_pending') AND NEW."status" = 'released' AND NEW."released_at_ms" IS NOT NULL AND NEW."active_head_claim_id" IS NULL)) THEN RAISE(ABORT, 'domain_claim_release_transition_invalid') END;
END;

CREATE TRIGGER "trg:domain_claims:immutable_delete" BEFORE DELETE ON "workflow_domain_resource_claims" BEGIN
  SELECT RAISE(ABORT, 'domain_claim_history_is_immutable');
END;

CREATE TRIGGER "trg:domain_resource_heads:cas_transition" BEFORE UPDATE ON "workflow_domain_resource_heads" BEGIN
  SELECT CASE WHEN NEW."namespace" IS NOT OLD."namespace" OR NEW."key_hash" IS NOT OLD."key_hash" OR NEW."row_version" <> OLD."row_version" + 1 OR NOT ((OLD."active_claim_id" IS NULL AND OLD."active_claim_link_id" IS NULL AND NEW."active_claim_id" IS NOT NULL AND NEW."active_claim_link_id" = NEW."active_claim_id" AND NEW."latest_claim_epoch" = OLD."latest_claim_epoch" + 1 AND NEW."active_claim_epoch" = NEW."latest_claim_epoch" AND ((NEW."active_claim_mode" = 'shared' AND NEW."current_fencing_token" = OLD."current_fencing_token" AND NEW."active_fencing_token_identity" = 0) OR (NEW."active_claim_mode" = 'exclusive' AND OLD."current_fencing_token" < 9007199254740991 AND NEW."current_fencing_token" = OLD."current_fencing_token" + 1 AND NEW."active_fencing_token_identity" = NEW."current_fencing_token"))) OR (OLD."active_claim_id" IS NOT NULL AND OLD."active_claim_link_id" = OLD."active_claim_id" AND NEW."active_claim_id" IS NULL AND NEW."active_claim_link_id" IS NULL AND NEW."latest_claim_epoch" = OLD."latest_claim_epoch" AND NEW."current_fencing_token" = OLD."current_fencing_token") OR (OLD."active_claim_id" IS NOT NULL AND OLD."active_claim_link_id" = OLD."active_claim_id" AND NEW."active_claim_id" IS NOT NULL AND NEW."active_claim_link_id" = NEW."active_claim_id" AND OLD."active_claim_id" <> NEW."active_claim_id" AND OLD."active_claim_owner_workflow_id" <> NEW."active_claim_owner_workflow_id" AND OLD."active_claim_mode" = 'exclusive' AND NEW."active_claim_mode" = 'exclusive' AND NEW."latest_claim_epoch" = OLD."latest_claim_epoch" + 1 AND NEW."active_claim_epoch" = NEW."latest_claim_epoch" AND OLD."current_fencing_token" < 9007199254740991 AND NEW."current_fencing_token" = OLD."current_fencing_token" + 1 AND NEW."active_fencing_token_identity" = NEW."current_fencing_token")) THEN RAISE(ABORT, 'domain_resource_head_cas_transition_invalid') END;
END;

CREATE TRIGGER "trg:domain_resource_heads:immutable_delete" BEFORE DELETE ON "workflow_domain_resource_heads" BEGIN
  SELECT RAISE(ABORT, 'domain_resource_head_history_is_immutable');
END;

CREATE TRIGGER "trg:domain_claim_handoffs:immutable_update" BEFORE UPDATE ON "workflow_domain_resource_claim_handoffs" BEGIN
  SELECT RAISE(ABORT, 'domain_claim_handoff_is_immutable');
END;

CREATE TRIGGER "trg:domain_claim_handoffs:immutable_delete" BEFORE DELETE ON "workflow_domain_resource_claim_handoffs" BEGIN
  SELECT RAISE(ABORT, 'domain_claim_handoff_is_immutable');
END;

CREATE TRIGGER "trg:effect_claims:immutable_update" BEFORE UPDATE ON "workflow_graph_effect_operation_claims" BEGIN
  SELECT RAISE(ABORT, 'effect_claim_lineage_is_immutable');
END;

CREATE TRIGGER "trg:effect_claims:immutable_delete" BEFORE DELETE ON "workflow_graph_effect_operation_claims" BEGIN
  SELECT RAISE(ABORT, 'effect_claim_lineage_is_immutable');
END;

PRAGMA legacy_alter_table = OFF;

PRAGMA user_version = 10;
