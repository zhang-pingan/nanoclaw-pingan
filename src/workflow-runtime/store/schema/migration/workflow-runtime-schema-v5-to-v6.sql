PRAGMA legacy_alter_table = ON;

ALTER TABLE "workflow_values" RENAME TO "workflow_values_schema5";

CREATE TABLE "workflow_generated_schema_contents" (
  "schema_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=generated_schema_ref_validator reference_domain=icarus_generated_schema_content_address immutable=1 */,
  "schema_raw_hash" TEXT NOT NULL /* logical_type=hash */,
  "schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "canonical_schema_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "canonicalizer" TEXT NOT NULL /* logical_type=text */,
  "byte_length" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_generated_schema_contents" PRIMARY KEY ("schema_ref"),
  CONSTRAINT "ck:generated_schema_contents:ref" CHECK ("schema_ref" = 'icarus-generated-schema:' || "schema_raw_hash") /* check_kind=state_field_consistency logical_columns=schema_ref,schema_raw_hash */,
  CONSTRAINT "ck:generated_schema_contents:raw_hash:hash" CHECK (("schema_raw_hash" IS NULL OR (length("schema_raw_hash") = 71 AND substr("schema_raw_hash", 1, 7) = 'sha256:' AND substr("schema_raw_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_raw_hash */,
  CONSTRAINT "ck:generated_schema_contents:schema_hash:hash" CHECK (("schema_hash" IS NULL OR (length("schema_hash") = 71 AND substr("schema_hash", 1, 7) = 'sha256:' AND substr("schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_hash */,
  CONSTRAINT "ck:generated_schema_contents:canonicalizer:enum" CHECK ("canonicalizer" IN ('RFC8785-JCS')) /* check_kind=enum_membership logical_columns=canonicalizer */,
  CONSTRAINT "ck:generated_schema_contents:byte_length:safe_integer" CHECK (("byte_length" IS NULL OR "byte_length" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=byte_length */,
  CONSTRAINT "ck:generated_schema_contents:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_plan_generated_schemas" (
  "plan_id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "plan_hash" TEXT NOT NULL /* logical_type=hash */,
  "schema_ref" TEXT NOT NULL /* logical_type=identifier */,
  "schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "generator" TEXT NOT NULL /* logical_type=text */,
  "parameter_hash" TEXT NOT NULL /* logical_type=hash */,
  "binding_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_plan_generated_schemas" PRIMARY KEY ("plan_id", "schema_ref", "generator", "parameter_hash"),
  CONSTRAINT "fk:plan_generated_schemas:plan" FOREIGN KEY ("plan_id", "graph_run_id", "plan_hash") REFERENCES "workflow_graph_scope_plans" ("id", "graph_run_id", "plan_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:plan_generated_schemas:content" FOREIGN KEY ("schema_ref", "schema_hash") REFERENCES "workflow_generated_schema_contents" ("schema_ref", "schema_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:plan_generated_schemas:plan_hash:hash" CHECK (("plan_hash" IS NULL OR (length("plan_hash") = 71 AND substr("plan_hash", 1, 7) = 'sha256:' AND substr("plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=plan_hash */,
  CONSTRAINT "ck:plan_generated_schemas:schema_hash:hash" CHECK (("schema_hash" IS NULL OR (length("schema_hash") = 71 AND substr("schema_hash", 1, 7) = 'sha256:' AND substr("schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_hash */,
  CONSTRAINT "ck:plan_generated_schemas:parameter_hash:hash" CHECK (("parameter_hash" IS NULL OR (length("parameter_hash") = 71 AND substr("parameter_hash", 1, 7) = 'sha256:' AND substr("parameter_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=parameter_hash */,
  CONSTRAINT "ck:plan_generated_schemas:binding_hash:hash" CHECK (("binding_hash" IS NULL OR (length("binding_hash") = 71 AND substr("binding_hash", 1, 7) = 'sha256:' AND substr("binding_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=binding_hash */,
  CONSTRAINT "ck:plan_generated_schemas:generator:enum" CHECK ("generator" IN ('join_expose', 'child_completion', 'map_result')) /* check_kind=enum_membership logical_columns=generator */,
  CONSTRAINT "ck:plan_generated_schemas:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE UNIQUE INDEX "uk:generated_schema_contents:ref_hash" ON "workflow_generated_schema_contents" ("schema_ref", "schema_hash");

CREATE UNIQUE INDEX "uk:plan_generated_schemas:value_authority" ON "workflow_plan_generated_schemas" ("plan_id", "plan_hash", "schema_ref", "schema_hash", "generator", "parameter_hash");

CREATE INDEX "idx:plan_generated_schemas:resolve" ON "workflow_plan_generated_schemas" ("plan_id", "schema_ref");

CREATE TABLE "workflow_values" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "storage_kind" TEXT NOT NULL /* logical_type=text */,
  "inline_canonical_json" TEXT /* logical_type=canonical_json */,
  "blob_hash" TEXT /* logical_type=hash */,
  "immutable_external_locator" TEXT /* logical_type=external_reference external_ref=1 validator_owner=storage_resolver reference_domain=immutable_external_locator immutable=1 */,
  "expected_hash" TEXT /* logical_type=hash */,
  "content_hash" TEXT NOT NULL /* logical_type=hash */,
  "byte_length" INTEGER NOT NULL /* logical_type=integer */,
  "media_type" TEXT NOT NULL /* logical_type=text */,
  "schema_resource_id" TEXT /* logical_type=identifier */,
  "schema_resource_hash" TEXT /* logical_type=hash */,
  "provenance_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=value_provenance_validator reference_domain=value_provenance immutable=1 */,
  "retention_class" TEXT NOT NULL /* logical_type=text */,
  "payload_state" TEXT NOT NULL /* logical_type=text */,
  "payload_pruned_at_ms" INTEGER /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "schema_authority_kind" TEXT NOT NULL DEFAULT 'registry' /* logical_type=text */,
  "schema_plan_id" TEXT /* logical_type=identifier */,
  "schema_plan_hash" TEXT /* logical_type=hash */,
  "generated_schema_ref" TEXT /* logical_type=identifier */,
  "generated_schema_hash" TEXT /* logical_type=hash */,
  "generated_schema_generator" TEXT /* logical_type=text */,
  "generated_schema_parameter_hash" TEXT /* logical_type=hash */,
  CONSTRAINT "pk:workflow_values" PRIMARY KEY ("id"),
  CONSTRAINT "fk:values:blob" FOREIGN KEY ("blob_hash") REFERENCES "workflow_blob_objects" ("blob_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:values:schema" FOREIGN KEY ("schema_resource_id", "schema_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:values:plan_generated_schema" FOREIGN KEY ("schema_plan_id", "schema_plan_hash", "generated_schema_ref", "generated_schema_hash", "generated_schema_generator", "generated_schema_parameter_hash") REFERENCES "workflow_plan_generated_schemas" ("plan_id", "plan_hash", "schema_ref", "schema_hash", "generator", "parameter_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_values:storage_kind:enum" CHECK ("storage_kind" IN ('inline', 'blob', 'immutable_external')) /* check_kind=enum_membership logical_columns=storage_kind */,
  CONSTRAINT "ck:workflow_values:blob_hash:hash" CHECK (("blob_hash" IS NULL OR (length("blob_hash") = 71 AND substr("blob_hash", 1, 7) = 'sha256:' AND substr("blob_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=blob_hash */,
  CONSTRAINT "ck:workflow_values:expected_hash:hash" CHECK (("expected_hash" IS NULL OR (length("expected_hash") = 71 AND substr("expected_hash", 1, 7) = 'sha256:' AND substr("expected_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=expected_hash */,
  CONSTRAINT "ck:workflow_values:content_hash:hash" CHECK (("content_hash" IS NULL OR (length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=content_hash */,
  CONSTRAINT "ck:workflow_values:byte_length:safe_integer" CHECK (("byte_length" IS NULL OR "byte_length" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=byte_length */,
  CONSTRAINT "ck:workflow_values:schema_resource_hash:hash" CHECK (("schema_resource_hash" IS NULL OR (length("schema_resource_hash") = 71 AND substr("schema_resource_hash", 1, 7) = 'sha256:' AND substr("schema_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_resource_hash */,
  CONSTRAINT "ck:workflow_values:retention_class:enum" CHECK ("retention_class" IN ('transient', 'run_recovery', 'workflow_audit', 'user_artifact', 'pinned')) /* check_kind=enum_membership logical_columns=retention_class */,
  CONSTRAINT "ck:workflow_values:payload_state:enum" CHECK ("payload_state" IN ('live', 'pruned', 'corrupt')) /* check_kind=enum_membership logical_columns=payload_state */,
  CONSTRAINT "ck:workflow_values:payload_pruned_at_ms:safe_integer" CHECK (("payload_pruned_at_ms" IS NULL OR "payload_pruned_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=payload_pruned_at_ms */,
  CONSTRAINT "ck:workflow_values:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_values:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_values:immutable_external_locator:expected_hash:pair" CHECK ((("immutable_external_locator" IS NULL AND "expected_hash" IS NULL) OR ("immutable_external_locator" IS NOT NULL AND "expected_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=immutable_external_locator,expected_hash */,
  CONSTRAINT "ck:workflow_values:inline_canonical_json:blob_hash:immutable_external_locator:exactly_one" CHECK ((("inline_canonical_json" IS NOT NULL) + ("blob_hash" IS NOT NULL) + ("immutable_external_locator" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=inline_canonical_json,blob_hash,immutable_external_locator */,
  CONSTRAINT "ck:values:storage_shape" CHECK ((("storage_kind" = 'inline' AND "inline_canonical_json" IS NOT NULL AND "blob_hash" IS NULL AND "immutable_external_locator" IS NULL AND "expected_hash" IS NULL) OR ("storage_kind" = 'blob' AND "inline_canonical_json" IS NULL AND "blob_hash" IS NOT NULL AND "immutable_external_locator" IS NULL AND "expected_hash" IS NULL) OR ("storage_kind" = 'immutable_external' AND "inline_canonical_json" IS NULL AND "blob_hash" IS NULL AND "immutable_external_locator" IS NOT NULL AND "expected_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=storage_kind,inline_canonical_json,blob_hash,immutable_external_locator,expected_hash */,
  CONSTRAINT "ck:values:payload_state" CHECK ((("payload_state" = 'pruned' AND "payload_pruned_at_ms" IS NOT NULL) OR ("payload_state" IN ('live', 'corrupt') AND "payload_pruned_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=payload_state,payload_pruned_at_ms */,
  CONSTRAINT "ck:workflow_values:schema_authority_kind:enum" CHECK ("schema_authority_kind" IN ('registry', 'plan_generated')) /* check_kind=enum_membership logical_columns=schema_authority_kind */,
  CONSTRAINT "ck:workflow_values:generated_schema_generator:enum" CHECK ("generated_schema_generator" IN ('join_expose', 'child_completion', 'map_result')) /* check_kind=enum_membership logical_columns=generated_schema_generator */,
  CONSTRAINT "ck:values:schema_authority_shape" CHECK ((("schema_authority_kind" = 'registry' AND "schema_resource_id" IS NOT NULL AND "schema_resource_hash" IS NOT NULL AND "schema_plan_id" IS NULL AND "schema_plan_hash" IS NULL AND "generated_schema_ref" IS NULL AND "generated_schema_hash" IS NULL AND "generated_schema_generator" IS NULL AND "generated_schema_parameter_hash" IS NULL) OR ("schema_authority_kind" = 'plan_generated' AND "schema_resource_id" IS NULL AND "schema_resource_hash" IS NULL AND "schema_plan_id" IS NOT NULL AND "schema_plan_hash" IS NOT NULL AND "generated_schema_ref" IS NOT NULL AND "generated_schema_hash" IS NOT NULL AND "generated_schema_generator" IS NOT NULL AND "generated_schema_parameter_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=schema_authority_kind,schema_resource_id,schema_resource_hash,schema_plan_id,schema_plan_hash,generated_schema_ref,generated_schema_hash,generated_schema_generator,generated_schema_parameter_hash */,
  CONSTRAINT "ck:workflow_values:schema_plan_hash:hash" CHECK (("schema_plan_hash" IS NULL OR (length("schema_plan_hash") = 71 AND substr("schema_plan_hash", 1, 7) = 'sha256:' AND substr("schema_plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_plan_hash */,
  CONSTRAINT "ck:workflow_values:generated_schema_hash:hash" CHECK (("generated_schema_hash" IS NULL OR (length("generated_schema_hash") = 71 AND substr("generated_schema_hash", 1, 7) = 'sha256:' AND substr("generated_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=generated_schema_hash */,
  CONSTRAINT "ck:workflow_values:generated_schema_parameter_hash:hash" CHECK (("generated_schema_parameter_hash" IS NULL OR (length("generated_schema_parameter_hash") = 71 AND substr("generated_schema_parameter_hash", 1, 7) = 'sha256:' AND substr("generated_schema_parameter_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=generated_schema_parameter_hash */
);

INSERT INTO "workflow_values" ("id", "storage_kind", "inline_canonical_json", "blob_hash", "immutable_external_locator", "expected_hash", "content_hash", "byte_length", "media_type", "schema_resource_id", "schema_resource_hash", "provenance_ref", "retention_class", "payload_state", "payload_pruned_at_ms", "created_at_ms", "row_version", "schema_authority_kind") SELECT "id", "storage_kind", "inline_canonical_json", "blob_hash", "immutable_external_locator", "expected_hash", "content_hash", "byte_length", "media_type", "schema_resource_id", "schema_resource_hash", "provenance_ref", "retention_class", "payload_state", "payload_pruned_at_ms", "created_at_ms", "row_version", 'registry' FROM "workflow_values_schema5";

DROP TABLE "workflow_values_schema5";

CREATE UNIQUE INDEX "uk:values:id_hash" ON "workflow_values" ("id", "content_hash");

CREATE UNIQUE INDEX "uk:values:id_hash_schema" ON "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash");

PRAGMA legacy_alter_table = OFF;

PRAGMA user_version = 6;
