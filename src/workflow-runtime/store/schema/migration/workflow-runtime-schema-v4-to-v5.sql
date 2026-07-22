ALTER TABLE "runtime_capacity_admin_invocations" RENAME TO "runtime_capacity_admin_invocations_schema4";

CREATE TABLE "runtime_capacity_admin_invocations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "invocation_no" INTEGER NOT NULL /* logical_type=integer */,
  "submitted_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=capacity_admin_gateway reference_domain=principal immutable=1 */,
  "actor_kind" TEXT NOT NULL /* logical_type=text */,
  "auth_session_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=authentication_service reference_domain=auth_session immutable=1 */,
  "entrypoint" TEXT NOT NULL /* logical_type=text */,
  "delegation_chain_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=authorization_service reference_domain=delegation_chain immutable=1 */,
  "required_permission" TEXT /* logical_type=text */,
  "authorization_result" TEXT NOT NULL /* logical_type=text */,
  "execution_result" TEXT NOT NULL /* logical_type=text */,
  "denial_code" TEXT /* logical_type=text */,
  "observed_capacity_revision" INTEGER /* logical_type=integer */,
  "observed_config_hash" TEXT /* logical_type=hash */,
  "requested_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "decided_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "applied_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:runtime_capacity_admin_invocations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:capacity_invocations:command" FOREIGN KEY ("command_id") REFERENCES "runtime_capacity_admin_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:invocation_no:safe_integer" CHECK (("invocation_no" IS NULL OR "invocation_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=invocation_no */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:submitted_request_hash:hash" CHECK (("submitted_request_hash" IS NULL OR (length("submitted_request_hash") = 71 AND substr("submitted_request_hash", 1, 7) = 'sha256:' AND substr("submitted_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=submitted_request_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:actor_kind:enum" CHECK ("actor_kind" IN ('human', 'feature_service', 'automation', 'system')) /* check_kind=enum_membership logical_columns=actor_kind */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:required_permission:enum" CHECK ("required_permission" IN ('runtime.capacity.manage')) /* check_kind=enum_membership logical_columns=required_permission */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:authorization_result:enum" CHECK ("authorization_result" IN ('allowed', 'denied')) /* check_kind=enum_membership logical_columns=authorization_result */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:execution_result:enum" CHECK ("execution_result" IN ('prepared', 'applied', 'denied', 'conflict', 'duplicate', 'failed')) /* check_kind=enum_membership logical_columns=execution_result */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:denial_code:enum" CHECK ("denial_code" IN ('permission_denied', 'actor_kind_denied', 'capacity_already_initialized', 'capacity_snapshot_invalid', 'capacity_transition_invalid', 'expected_capacity_revision_conflict', 'expected_config_hash_conflict', 'capacity_change_in_progress', 'idempotency_conflict', 'audit_unavailable', 'publication_failed')) /* check_kind=enum_membership logical_columns=denial_code */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:observed_capacity_revision:safe_integer" CHECK (("observed_capacity_revision" IS NULL OR "observed_capacity_revision" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=observed_capacity_revision */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:observed_config_hash:hash" CHECK (("observed_config_hash" IS NULL OR (length("observed_config_hash") = 71 AND substr("observed_config_hash", 1, 7) = 'sha256:' AND substr("observed_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=observed_config_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:requested_at_ms:safe_integer" CHECK (("requested_at_ms" IS NULL OR "requested_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=requested_at_ms */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:decided_at_ms:safe_integer" CHECK (("decided_at_ms" IS NULL OR "decided_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=decided_at_ms */,
  CONSTRAINT "ck:runtime_capacity_admin_invocations:applied_at_ms:safe_integer" CHECK (("applied_at_ms" IS NULL OR "applied_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=applied_at_ms */,
  CONSTRAINT "ck:capacity_invocations:observed_pair" CHECK ((("observed_capacity_revision" IS NULL AND "observed_config_hash" IS NULL) OR ("observed_capacity_revision" IS NOT NULL AND "observed_config_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=observed_capacity_revision,observed_config_hash */,
  CONSTRAINT "ck:capacity_invocations:result_consistency" CHECK ("decided_at_ms" >= "requested_at_ms" AND (("authorization_result" = 'denied' AND "execution_result" = 'denied' AND "denial_code" IS NOT NULL AND "applied_at_ms" IS NULL) OR ("authorization_result" = 'allowed' AND "denial_code" IS NULL AND (("execution_result" = 'prepared' AND "invocation_no" = 1 AND "applied_at_ms" IS NULL) OR ("execution_result" = 'applied' AND "applied_at_ms" IS NOT NULL AND "applied_at_ms" >= "decided_at_ms") OR ("execution_result" IN ('conflict', 'duplicate', 'failed') AND "applied_at_ms" IS NULL))))) /* check_kind=state_field_consistency logical_columns=invocation_no,authorization_result,execution_result,denial_code,decided_at_ms,applied_at_ms */
);

INSERT INTO "runtime_capacity_admin_invocations" ("id", "command_id", "invocation_no", "submitted_request_hash", "actor_ref", "actor_kind", "auth_session_ref", "entrypoint", "delegation_chain_ref", "required_permission", "authorization_result", "execution_result", "denial_code", "observed_capacity_revision", "observed_config_hash", "requested_at_ms", "decided_at_ms", "applied_at_ms") SELECT "id", "command_id", "invocation_no", "submitted_request_hash", "actor_ref", "actor_kind", "auth_session_ref", "entrypoint", "delegation_chain_ref", "required_permission", "authorization_result", "execution_result", "denial_code", "observed_capacity_revision", "observed_config_hash", "requested_at_ms", "decided_at_ms", "applied_at_ms" FROM "runtime_capacity_admin_invocations_schema4";

DROP TABLE "runtime_capacity_admin_invocations_schema4";

CREATE UNIQUE INDEX "uk:capacity_invocations:command_no" ON "runtime_capacity_admin_invocations" ("command_id", "invocation_no");

CREATE INDEX "idx:capacity_invocations:command_history" ON "runtime_capacity_admin_invocations" ("command_id", "invocation_no");

CREATE TRIGGER "trg:capacity_invocations:prepared_insert" BEFORE INSERT ON "runtime_capacity_admin_invocations" WHEN NEW."execution_result" = 'prepared' BEGIN
  SELECT CASE WHEN NEW."invocation_no" <> 1 OR NOT EXISTS (SELECT 1 FROM "runtime_capacity_admin_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."request_hash" = NEW."submitted_request_hash" AND command."assigned_capacity_revision" IS NOT NULL AND command."assigned_change_id" IS NOT NULL AND command."canonical_result_value_id" IS NULL AND command."canonical_result_hash" IS NULL AND command."finalized_at_ms" IS NULL) THEN RAISE(ABORT, 'capacity_prepared_invocation_invalid') END;
END;

CREATE TRIGGER "trg:capacity_invocations:applied_insert" BEFORE INSERT ON "runtime_capacity_admin_invocations" WHEN NEW."execution_result" = 'applied' BEGIN
  SELECT RAISE(ABORT, 'capacity_applied_invocation_is_historical');
END;

CREATE TRIGGER "trg:capacity_invocations:duplicate_insert" BEFORE INSERT ON "runtime_capacity_admin_invocations" WHEN NEW."execution_result" = 'duplicate' BEGIN
  SELECT CASE WHEN NEW."invocation_no" <= 1 OR NOT EXISTS (SELECT 1 FROM "runtime_capacity_admin_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."request_hash" = NEW."submitted_request_hash" AND command."canonical_result_value_id" IS NOT NULL AND command."canonical_result_hash" IS NOT NULL AND command."finalized_at_ms" IS NOT NULL) THEN RAISE(ABORT, 'capacity_duplicate_invocation_invalid') END;
END;

CREATE TRIGGER "trg:capacity_invocations:immutable_update" BEFORE UPDATE ON "runtime_capacity_admin_invocations" BEGIN
  SELECT RAISE(ABORT, 'capacity_invocation_is_immutable');
END;

CREATE TRIGGER "trg:capacity_invocations:immutable_delete" BEFORE DELETE ON "runtime_capacity_admin_invocations" BEGIN
  SELECT RAISE(ABORT, 'capacity_invocation_is_immutable');
END;

PRAGMA user_version = 5;
