PRAGMA legacy_alter_table = ON;

ALTER TABLE "workflow_task_intakes" RENAME TO "workflow_task_intakes_v13";

CREATE TABLE "workflow_task_intakes" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "request_id" TEXT NOT NULL /* logical_type=text */,
  "creation_domain" TEXT NOT NULL /* logical_type=text */,
  "creation_key" TEXT NOT NULL /* logical_type=text */,
  "source" TEXT NOT NULL /* logical_type=text */,
  "principal_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=principal_identity_resolver reference_domain=principal immutable=1 */,
  "routing_scope_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "routing_scope_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "raw_request_value_id" TEXT /* logical_type=identifier */,
  "raw_request_hash" TEXT /* logical_type=hash */,
  "initial_input_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "initial_input_hash" TEXT NOT NULL /* logical_type=hash */,
  "attachment_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "attachment_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "explicit_task_kind" TEXT /* logical_type=text */,
  "explicit_recipe_resource_id" TEXT /* logical_type=identifier */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "selected_recipe_resource_id" TEXT /* logical_type=identifier */,
  "selected_recipe_hash" TEXT /* logical_type=hash */,
  "current_revision_id" TEXT NOT NULL /* logical_type=identifier */,
  "current_revision_no" INTEGER NOT NULL /* logical_type=integer */,
  "current_revision_hash" TEXT NOT NULL /* logical_type=hash */,
  "workflow_id" TEXT /* logical_type=identifier */,
  "next_attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_task_intakes" PRIMARY KEY ("id"),
  CONSTRAINT "fk:task_intakes:routing_scope" FOREIGN KEY ("routing_scope_resource_id", "routing_scope_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:task_intakes:raw_request" FOREIGN KEY ("raw_request_value_id", "raw_request_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:task_intakes:initial_input" FOREIGN KEY ("initial_input_value_id", "initial_input_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:task_intakes:attachment_manifest" FOREIGN KEY ("attachment_manifest_value_id", "attachment_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:task_intakes:explicit_recipe" FOREIGN KEY ("explicit_recipe_resource_id") REFERENCES "workflow_registry_resources" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:task_intakes:selected_recipe" FOREIGN KEY ("selected_recipe_resource_id", "selected_recipe_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:task_intakes:current_revision" FOREIGN KEY ("id", "current_revision_id", "current_revision_no") REFERENCES "workflow_task_intake_revisions" ("intake_id", "id", "revision_no") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:task_intakes:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_task_intakes:source:enum" CHECK ("source" IN ('global_assistant', 'feature_ui', 'schedule', 'api', 'task_workspace', 'workflow_transition')) /* check_kind=enum_membership logical_columns=source */,
  CONSTRAINT "ck:workflow_task_intakes:routing_scope_resource_hash:hash" CHECK (("routing_scope_resource_hash" IS NULL OR (length("routing_scope_resource_hash") = 71 AND substr("routing_scope_resource_hash", 1, 7) = 'sha256:' AND substr("routing_scope_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=routing_scope_resource_hash */,
  CONSTRAINT "ck:workflow_task_intakes:raw_request_hash:hash" CHECK (("raw_request_hash" IS NULL OR (length("raw_request_hash") = 71 AND substr("raw_request_hash", 1, 7) = 'sha256:' AND substr("raw_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=raw_request_hash */,
  CONSTRAINT "ck:workflow_task_intakes:initial_input_hash:hash" CHECK (("initial_input_hash" IS NULL OR (length("initial_input_hash") = 71 AND substr("initial_input_hash", 1, 7) = 'sha256:' AND substr("initial_input_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=initial_input_hash */,
  CONSTRAINT "ck:workflow_task_intakes:attachment_manifest_hash:hash" CHECK (("attachment_manifest_hash" IS NULL OR (length("attachment_manifest_hash") = 71 AND substr("attachment_manifest_hash", 1, 7) = 'sha256:' AND substr("attachment_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=attachment_manifest_hash */,
  CONSTRAINT "ck:workflow_task_intakes:status:enum" CHECK ("status" IN ('routing', 'needs_clarification', 'awaiting_confirmation', 'ready_to_create', 'created', 'unsupported', 'rejected')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_task_intakes:selected_recipe_hash:hash" CHECK (("selected_recipe_hash" IS NULL OR (length("selected_recipe_hash") = 71 AND substr("selected_recipe_hash", 1, 7) = 'sha256:' AND substr("selected_recipe_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=selected_recipe_hash */,
  CONSTRAINT "ck:workflow_task_intakes:current_revision_no:safe_integer" CHECK (("current_revision_no" IS NULL OR "current_revision_no" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=current_revision_no */,
  CONSTRAINT "ck:workflow_task_intakes:current_revision_hash:hash" CHECK (("current_revision_hash" IS NULL OR (length("current_revision_hash") = 71 AND substr("current_revision_hash", 1, 7) = 'sha256:' AND substr("current_revision_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=current_revision_hash */,
  CONSTRAINT "ck:workflow_task_intakes:next_attempt_no:safe_integer" CHECK (("next_attempt_no" IS NULL OR "next_attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_attempt_no */,
  CONSTRAINT "ck:workflow_task_intakes:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_task_intakes:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_task_intakes:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_task_intakes:raw_request_value_id:raw_request_hash:pair" CHECK ((("raw_request_value_id" IS NULL AND "raw_request_hash" IS NULL) OR ("raw_request_value_id" IS NOT NULL AND "raw_request_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=raw_request_value_id,raw_request_hash */,
  CONSTRAINT "ck:workflow_task_intakes:selected_recipe_resource_id:selected_recipe_hash:pair" CHECK ((("selected_recipe_resource_id" IS NULL AND "selected_recipe_hash" IS NULL) OR ("selected_recipe_resource_id" IS NOT NULL AND "selected_recipe_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=selected_recipe_resource_id,selected_recipe_hash */,
  CONSTRAINT "ck:task_intakes:created_workflow" CHECK ((("status" = 'created' AND "workflow_id" IS NOT NULL) OR ("status" <> 'created' AND "workflow_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,workflow_id */,
  CONSTRAINT "ck:task_intakes:selected_recipe" CHECK ((("status" IN ('awaiting_confirmation', 'ready_to_create', 'created') AND "selected_recipe_resource_id" IS NOT NULL AND "selected_recipe_hash" IS NOT NULL) OR ("status" IN ('routing', 'needs_clarification', 'unsupported', 'rejected') AND "selected_recipe_resource_id" IS NULL AND "selected_recipe_hash" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,selected_recipe_resource_id,selected_recipe_hash */
);

INSERT INTO "workflow_task_intakes" ("id", "request_id", "creation_domain", "creation_key", "source", "principal_ref", "routing_scope_resource_id", "routing_scope_resource_hash", "raw_request_value_id", "raw_request_hash", "initial_input_value_id", "initial_input_hash", "attachment_manifest_value_id", "attachment_manifest_hash", "explicit_task_kind", "explicit_recipe_resource_id", "status", "selected_recipe_resource_id", "selected_recipe_hash", "current_revision_id", "current_revision_no", "current_revision_hash", "workflow_id", "next_attempt_no", "row_version", "created_at_ms", "updated_at_ms")
SELECT "id", "request_id", "creation_domain", "creation_key", "source", "principal_ref", "routing_scope_resource_id", "routing_scope_resource_hash", "raw_request_value_id", "raw_request_hash", "initial_input_value_id", "initial_input_hash", "attachment_manifest_value_id", "attachment_manifest_hash", "explicit_task_kind", "explicit_recipe_resource_id", "status", "selected_recipe_resource_id", "selected_recipe_hash", "current_revision_id", "current_revision_no", "current_revision_hash", "workflow_id", "next_attempt_no", "row_version", "created_at_ms", "updated_at_ms" FROM "workflow_task_intakes_v13";

DROP TABLE "workflow_task_intakes_v13";

CREATE UNIQUE INDEX "uk:task_intakes:request_id" ON "workflow_task_intakes" ("request_id");

CREATE UNIQUE INDEX "uk:task_intakes:creation_key" ON "workflow_task_intakes" ("creation_domain", "creation_key");

PRAGMA legacy_alter_table = OFF;

PRAGMA user_version = 14;
