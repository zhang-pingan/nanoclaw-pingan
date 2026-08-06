CREATE TABLE "workflow_graph_resource_accounts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "deployment_scope_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=deployment_profile_registry reference_domain=deployment_scope immutable=1 */,
  "workflow_id" TEXT /* logical_type=identifier */,
  "graph_run_id" TEXT /* logical_type=identifier */,
  "scope_id" TEXT /* logical_type=identifier */,
  "node_id" TEXT /* logical_type=identifier */,
  "execution_group_resource_id" TEXT /* logical_type=identifier */,
  "execution_group_resource_hash" TEXT /* logical_type=hash */,
  "resource_type" TEXT NOT NULL /* logical_type=text */,
  "hard_limit" INTEGER NOT NULL /* logical_type=integer */,
  "reserved_amount" INTEGER NOT NULL /* logical_type=integer */,
  "consumed_amount" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_resource_accounts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:resource_accounts:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_accounts:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_accounts:scope" FOREIGN KEY ("scope_id") REFERENCES "workflow_graph_scopes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_accounts:node" FOREIGN KEY ("node_id") REFERENCES "workflow_graph_nodes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_accounts:execution_group" FOREIGN KEY ("execution_group_resource_id", "execution_group_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_resource_accounts:execution_group_resource_hash:hash" CHECK (("execution_group_resource_hash" IS NULL OR (length("execution_group_resource_hash") = 71 AND substr("execution_group_resource_hash", 1, 7) = 'sha256:' AND substr("execution_group_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=execution_group_resource_hash */,
  CONSTRAINT "ck:workflow_graph_resource_accounts:resource_type:enum" CHECK ("resource_type" IN ('state_activations_total', 'graph_runs_total', 'state_transitions_total', 'child_workflows_total', 'descendant_workflows_total', 'scopes_total', 'nodes_total', 'edges_total', 'map_items_total', 'builds_total', 'build_attempts_total', 'attempts_total', 'evaluator_attempts_total', 'waits_total', 'effect_operations_total', 'facts_total', 'logical_output_bytes_total', 'stored_bytes_total', 'active_waits', 'active_executions', 'input_tokens_total', 'output_tokens_total', 'tool_calls_total', 'cost_micros_total')) /* check_kind=enum_membership logical_columns=resource_type */,
  CONSTRAINT "ck:workflow_graph_resource_accounts:hard_limit:safe_integer" CHECK (("hard_limit" IS NULL OR "hard_limit" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=hard_limit */,
  CONSTRAINT "ck:workflow_graph_resource_accounts:reserved_amount:safe_integer" CHECK (("reserved_amount" IS NULL OR "reserved_amount" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=reserved_amount */,
  CONSTRAINT "ck:workflow_graph_resource_accounts:consumed_amount:safe_integer" CHECK (("consumed_amount" IS NULL OR "consumed_amount" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=consumed_amount */,
  CONSTRAINT "ck:workflow_graph_resource_accounts:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_resource_accounts:deployment_scope_ref:workflow_id:graph_run_id:scope_id:node_id:execution_group_resource_id:exactly_one" CHECK ((("deployment_scope_ref" IS NOT NULL) + ("workflow_id" IS NOT NULL) + ("graph_run_id" IS NOT NULL) + ("scope_id" IS NOT NULL) + ("node_id" IS NOT NULL) + ("execution_group_resource_id" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=deployment_scope_ref,workflow_id,graph_run_id,scope_id,node_id,execution_group_resource_id */,
  CONSTRAINT "ck:resource_accounts:under_limit" CHECK ("reserved_amount" + "consumed_amount" <= "hard_limit") /* check_kind=ordered_values logical_columns=reserved_amount,consumed_amount,hard_limit */
);

CREATE TABLE "workflow_graph_resource_reservations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "reservation_group_id" TEXT NOT NULL /* logical_type=identifier */,
  "consumer_workflow_id" TEXT /* logical_type=identifier */,
  "consumer_build_id" TEXT /* logical_type=identifier */,
  "consumer_scope_id" TEXT /* logical_type=identifier */,
  "consumer_node_id" TEXT /* logical_type=identifier */,
  "consumer_attempt_id" TEXT /* logical_type=identifier */,
  "consumer_wait_id" TEXT /* logical_type=identifier */,
  "consumer_effect_id" TEXT /* logical_type=identifier */,
  "consumer_fact_id" TEXT /* logical_type=identifier */,
  "resource_type" TEXT NOT NULL /* logical_type=text */,
  "purpose" TEXT NOT NULL /* logical_type=text */,
  "settlement_mode" TEXT NOT NULL /* logical_type=text */,
  "reserved_remaining" INTEGER NOT NULL /* logical_type=integer */,
  "consumed_amount" INTEGER NOT NULL /* logical_type=integer */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "settled_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_resource_reservations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:resource_reservations:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:workflow" FOREIGN KEY ("consumer_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:build" FOREIGN KEY ("consumer_build_id") REFERENCES "workflow_graph_scope_builds" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:scope" FOREIGN KEY ("consumer_scope_id") REFERENCES "workflow_graph_scopes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:node" FOREIGN KEY ("consumer_node_id") REFERENCES "workflow_graph_nodes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:attempt" FOREIGN KEY ("consumer_attempt_id") REFERENCES "workflow_graph_node_attempts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:wait" FOREIGN KEY ("consumer_wait_id") REFERENCES "workflow_graph_waits" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:effect" FOREIGN KEY ("consumer_effect_id") REFERENCES "workflow_graph_effect_operations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:resource_reservations:fact" FOREIGN KEY ("consumer_fact_id") REFERENCES "workflow_graph_facts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_resource_reservations:settlement_mode:enum" CHECK ("settlement_mode" IN ('consume_on_create', 'hold_then_release', 'incremental')) /* check_kind=enum_membership logical_columns=settlement_mode */,
  CONSTRAINT "ck:workflow_graph_resource_reservations:reserved_remaining:safe_integer" CHECK (("reserved_remaining" IS NULL OR "reserved_remaining" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=reserved_remaining */,
  CONSTRAINT "ck:workflow_graph_resource_reservations:consumed_amount:safe_integer" CHECK (("consumed_amount" IS NULL OR "consumed_amount" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=consumed_amount */,
  CONSTRAINT "ck:workflow_graph_resource_reservations:status:enum" CHECK ("status" IN ('held', 'committed', 'released')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_graph_resource_reservations:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_resource_reservations:settled_at_ms:safe_integer" CHECK (("settled_at_ms" IS NULL OR "settled_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=settled_at_ms */,
  CONSTRAINT "ck:workflow_graph_resource_reservations:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_resource_reservations:consumer_workflow_id:consumer_build_id:consumer_scope_id:consumer_node_id:consumer_attempt_id:consumer_wait_id:consumer_effect_id:consumer_fact_id:exactly_one" CHECK ((("consumer_workflow_id" IS NOT NULL) + ("consumer_build_id" IS NOT NULL) + ("consumer_scope_id" IS NOT NULL) + ("consumer_node_id" IS NOT NULL) + ("consumer_attempt_id" IS NOT NULL) + ("consumer_wait_id" IS NOT NULL) + ("consumer_effect_id" IS NOT NULL) + ("consumer_fact_id" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=consumer_workflow_id,consumer_build_id,consumer_scope_id,consumer_node_id,consumer_attempt_id,consumer_wait_id,consumer_effect_id,consumer_fact_id */,
  CONSTRAINT "ck:resource_reservations:settlement_state" CHECK ((("status" = 'held' AND "settled_at_ms" IS NULL) OR ("status" IN ('committed', 'released') AND "settled_at_ms" IS NOT NULL AND "reserved_remaining" = 0))) /* check_kind=state_field_consistency logical_columns=status,settled_at_ms,reserved_remaining */
);

CREATE TABLE "workflow_graph_resource_reservation_postings" (
  "reservation_id" TEXT NOT NULL /* logical_type=identifier */,
  "account_id" TEXT NOT NULL /* logical_type=identifier */,
  "reserved_remaining" INTEGER NOT NULL /* logical_type=integer */,
  "consumed_amount" INTEGER NOT NULL /* logical_type=integer */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_resource_reservation_postings" PRIMARY KEY ("reservation_id", "account_id"),
  CONSTRAINT "fk:reservation_postings:reservation" FOREIGN KEY ("reservation_id") REFERENCES "workflow_graph_resource_reservations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:reservation_postings:account" FOREIGN KEY ("account_id") REFERENCES "workflow_graph_resource_accounts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_resource_reservation_postings:reserved_remaining:safe_integer" CHECK (("reserved_remaining" IS NULL OR "reserved_remaining" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=reserved_remaining */,
  CONSTRAINT "ck:workflow_graph_resource_reservation_postings:consumed_amount:safe_integer" CHECK (("consumed_amount" IS NULL OR "consumed_amount" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=consumed_amount */,
  CONSTRAINT "ck:workflow_graph_resource_reservation_postings:status:enum" CHECK ("status" IN ('held', 'committed', 'released')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_graph_resource_reservation_postings:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */
);

CREATE TABLE "workflow_graph_resource_ledger_entries" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "ledger_seq" INTEGER NOT NULL /* logical_type=integer */,
  "reservation_group_id" TEXT NOT NULL /* logical_type=identifier */,
  "account_id" TEXT NOT NULL /* logical_type=identifier */,
  "reservation_id" TEXT NOT NULL /* logical_type=identifier */,
  "operation" TEXT NOT NULL /* logical_type=text */,
  "delta_reserved" INTEGER NOT NULL /* logical_type=integer */,
  "delta_consumed" INTEGER NOT NULL /* logical_type=integer */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "previous_chain_hash" TEXT NOT NULL /* logical_type=hash */,
  "chain_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_resource_ledger_entries" PRIMARY KEY ("id"),
  CONSTRAINT "fk:ledger_entries:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:ledger_entries:account" FOREIGN KEY ("account_id") REFERENCES "workflow_graph_resource_accounts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:ledger_entries:reservation" FOREIGN KEY ("reservation_id") REFERENCES "workflow_graph_resource_reservations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_resource_ledger_entries:ledger_seq:safe_integer" CHECK (("ledger_seq" IS NULL OR "ledger_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=ledger_seq */,
  CONSTRAINT "ck:workflow_graph_resource_ledger_entries:operation:enum" CHECK ("operation" IN ('reserve', 'commit', 'release', 'charge')) /* check_kind=enum_membership logical_columns=operation */,
  CONSTRAINT "ck:workflow_graph_resource_ledger_entries:delta_reserved:safe_integer" CHECK (("delta_reserved" IS NULL OR "delta_reserved" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=delta_reserved */,
  CONSTRAINT "ck:workflow_graph_resource_ledger_entries:delta_consumed:safe_integer" CHECK (("delta_consumed" IS NULL OR "delta_consumed" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=delta_consumed */,
  CONSTRAINT "ck:workflow_graph_resource_ledger_entries:previous_chain_hash:hash" CHECK (("previous_chain_hash" IS NULL OR (length("previous_chain_hash") = 71 AND substr("previous_chain_hash", 1, 7) = 'sha256:' AND substr("previous_chain_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_chain_hash */,
  CONSTRAINT "ck:workflow_graph_resource_ledger_entries:chain_hash:hash" CHECK (("chain_hash" IS NULL OR (length("chain_hash") = 71 AND substr("chain_hash", 1, 7) = 'sha256:' AND substr("chain_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=chain_hash */,
  CONSTRAINT "ck:workflow_graph_resource_ledger_entries:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_graph_scheduler_admissions" (
  "admission_seq" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL /* logical_type=integer */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "node_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_id" TEXT NOT NULL /* logical_type=identifier */,
  "eligible_event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "execution_reservation_id" TEXT NOT NULL /* logical_type=identifier */,
  "capacity_config_hash" TEXT NOT NULL /* logical_type=hash */,
  "runtime_supported_limits_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "capacity_revision" INTEGER NOT NULL /* logical_type=integer */,
  "capacity_change_id" TEXT NOT NULL /* logical_type=identifier */,
  CONSTRAINT "fk:scheduler_admissions:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scheduler_admissions:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scheduler_admissions:node" FOREIGN KEY ("graph_run_id", "scope_id", "node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scheduler_admissions:attempt" FOREIGN KEY ("graph_run_id", "scope_id", "node_id", "attempt_id") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scheduler_admissions:reservation" FOREIGN KEY ("execution_reservation_id") REFERENCES "workflow_graph_resource_reservations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scheduler_admissions:capacity_lineage" FOREIGN KEY ("capacity_revision", "capacity_change_id", "capacity_config_hash") REFERENCES "runtime_capacity_admin_commands" ("assigned_capacity_revision", "assigned_change_id", "proposed_config_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_scheduler_admissions:admission_seq:safe_integer" CHECK (("admission_seq" IS NULL OR "admission_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=admission_seq */,
  CONSTRAINT "ck:workflow_graph_scheduler_admissions:eligible_event_seq:safe_integer" CHECK (("eligible_event_seq" IS NULL OR "eligible_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=eligible_event_seq */,
  CONSTRAINT "ck:workflow_graph_scheduler_admissions:capacity_config_hash:hash" CHECK (("capacity_config_hash" IS NULL OR (length("capacity_config_hash") = 71 AND substr("capacity_config_hash", 1, 7) = 'sha256:' AND substr("capacity_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=capacity_config_hash */,
  CONSTRAINT "ck:workflow_graph_scheduler_admissions:runtime_supported_limits_hash:hash" CHECK (("runtime_supported_limits_hash" IS NULL OR (length("runtime_supported_limits_hash") = 71 AND substr("runtime_supported_limits_hash", 1, 7) = 'sha256:' AND substr("runtime_supported_limits_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=runtime_supported_limits_hash */,
  CONSTRAINT "ck:workflow_graph_scheduler_admissions:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:scheduler_admissions:capacity_lineage_complete" CHECK ((("capacity_revision" IS NULL AND "capacity_change_id" IS NULL AND "capacity_config_hash" IS NULL) OR ("capacity_revision" IS NOT NULL AND "capacity_change_id" IS NOT NULL AND "capacity_config_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=capacity_revision,capacity_change_id,capacity_config_hash */
);

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
  CONSTRAINT "ck:workflow_values:generated_schema_generator:enum" CHECK ("generated_schema_generator" IN ('join_expose', 'child_completion', 'map_result', 'node_output_envelope')) /* check_kind=enum_membership logical_columns=generated_schema_generator */,
  CONSTRAINT "ck:values:schema_authority_shape" CHECK ((("schema_authority_kind" = 'registry' AND "schema_resource_id" IS NOT NULL AND "schema_resource_hash" IS NOT NULL AND "schema_plan_id" IS NULL AND "schema_plan_hash" IS NULL AND "generated_schema_ref" IS NULL AND "generated_schema_hash" IS NULL AND "generated_schema_generator" IS NULL AND "generated_schema_parameter_hash" IS NULL) OR ("schema_authority_kind" = 'plan_generated' AND "schema_resource_id" IS NULL AND "schema_resource_hash" IS NULL AND "schema_plan_id" IS NOT NULL AND "schema_plan_hash" IS NOT NULL AND "generated_schema_ref" IS NOT NULL AND "generated_schema_hash" IS NOT NULL AND "generated_schema_generator" IS NOT NULL AND "generated_schema_parameter_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=schema_authority_kind,schema_resource_id,schema_resource_hash,schema_plan_id,schema_plan_hash,generated_schema_ref,generated_schema_hash,generated_schema_generator,generated_schema_parameter_hash */,
  CONSTRAINT "ck:workflow_values:schema_plan_hash:hash" CHECK (("schema_plan_hash" IS NULL OR (length("schema_plan_hash") = 71 AND substr("schema_plan_hash", 1, 7) = 'sha256:' AND substr("schema_plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_plan_hash */,
  CONSTRAINT "ck:workflow_values:generated_schema_hash:hash" CHECK (("generated_schema_hash" IS NULL OR (length("generated_schema_hash") = 71 AND substr("generated_schema_hash", 1, 7) = 'sha256:' AND substr("generated_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=generated_schema_hash */,
  CONSTRAINT "ck:workflow_values:generated_schema_parameter_hash:hash" CHECK (("generated_schema_parameter_hash" IS NULL OR (length("generated_schema_parameter_hash") = 71 AND substr("generated_schema_parameter_hash", 1, 7) = 'sha256:' AND substr("generated_schema_parameter_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=generated_schema_parameter_hash */
);

CREATE TABLE "workflow_value_edges" (
  "parent_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "child_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "relation_kind" TEXT NOT NULL /* logical_type=text */,
  "member_key" TEXT /* logical_type=text */,
  "member_index" INTEGER /* logical_type=integer */,
  "child_expected_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_value_edges" PRIMARY KEY ("parent_value_id", "child_value_id", "relation_kind"),
  CONSTRAINT "fk:value_edges:parent" FOREIGN KEY ("parent_value_id") REFERENCES "workflow_values" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:value_edges:child" FOREIGN KEY ("child_value_id", "child_expected_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_value_edges:relation_kind:enum" CHECK ("relation_kind" IN ('manifest_member', 'artifact_file', 'registry_dependency', 'map_result_member')) /* check_kind=enum_membership logical_columns=relation_kind */,
  CONSTRAINT "ck:workflow_value_edges:member_index:safe_integer" CHECK (("member_index" IS NULL OR "member_index" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=member_index */,
  CONSTRAINT "ck:workflow_value_edges:child_expected_hash:hash" CHECK (("child_expected_hash" IS NULL OR (length("child_expected_hash") = 71 AND substr("child_expected_hash", 1, 7) = 'sha256:' AND substr("child_expected_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=child_expected_hash */,
  CONSTRAINT "ck:workflow_value_edges:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_value_edges:member_key:member_index:exactly_one" CHECK ((("member_key" IS NOT NULL) + ("member_index" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=member_key,member_index */
);

CREATE TABLE "workflow_value_ownerships" (
  "value_id" TEXT NOT NULL /* logical_type=identifier */,
  "owner_workflow_id" TEXT /* logical_type=identifier */,
  "owner_graph_run_id" TEXT /* logical_type=identifier */,
  "owner_registry_resource_id" TEXT /* logical_type=identifier */,
  "owner_feature_release_id" TEXT /* logical_type=identifier */,
  "system_owner_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=core_subsystem_registry reference_domain=versioned_core_subsystem immutable=1 */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_value_ownerships" PRIMARY KEY ("value_id"),
  CONSTRAINT "fk:value_ownerships:value" FOREIGN KEY ("value_id") REFERENCES "workflow_values" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:value_ownerships:workflow" FOREIGN KEY ("owner_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:value_ownerships:run" FOREIGN KEY ("owner_graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:value_ownerships:registry_resource" FOREIGN KEY ("owner_registry_resource_id") REFERENCES "workflow_registry_resources" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:value_ownerships:feature_release" FOREIGN KEY ("owner_feature_release_id") REFERENCES "workflow_feature_releases" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_value_ownerships:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_value_ownerships:owner_workflow_id:owner_graph_run_id:owner_registry_resource_id:owner_feature_release_id:system_owner_ref:exactly_one" CHECK ((("owner_workflow_id" IS NOT NULL) + ("owner_graph_run_id" IS NOT NULL) + ("owner_registry_resource_id" IS NOT NULL) + ("owner_feature_release_id" IS NOT NULL) + ("system_owner_ref" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=owner_workflow_id,owner_graph_run_id,owner_registry_resource_id,owner_feature_release_id,system_owner_ref */
);

CREATE TABLE "workflow_blob_write_intents" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "expected_hash" TEXT NOT NULL /* logical_type=hash */,
  "expected_byte_length" INTEGER NOT NULL /* logical_type=integer */,
  "reserved_physical_bytes" INTEGER NOT NULL /* logical_type=integer */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "lease_owner" TEXT /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "lease_token" TEXT /* logical_type=text */,
  "lease_expires_at_ms" INTEGER /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_blob_write_intents" PRIMARY KEY ("id"),
  CONSTRAINT "ck:workflow_blob_write_intents:expected_hash:hash" CHECK (("expected_hash" IS NULL OR (length("expected_hash") = 71 AND substr("expected_hash", 1, 7) = 'sha256:' AND substr("expected_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=expected_hash */,
  CONSTRAINT "ck:workflow_blob_write_intents:expected_byte_length:safe_integer" CHECK (("expected_byte_length" IS NULL OR "expected_byte_length" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expected_byte_length */,
  CONSTRAINT "ck:workflow_blob_write_intents:reserved_physical_bytes:safe_integer" CHECK (("reserved_physical_bytes" IS NULL OR "reserved_physical_bytes" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=reserved_physical_bytes */,
  CONSTRAINT "ck:workflow_blob_write_intents:status:enum" CHECK ("status" IN ('preparing', 'installed', 'committed', 'abandoned')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_blob_write_intents:lease_expires_at_ms:safe_integer" CHECK (("lease_expires_at_ms" IS NULL OR "lease_expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_blob_write_intents:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_blob_write_intents:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_blob_write_intents:lease_owner:lease_token:pair" CHECK ((("lease_owner" IS NULL AND "lease_token" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_token */,
  CONSTRAINT "ck:workflow_blob_write_intents:lease_owner:lease_expires_at_ms:pair" CHECK ((("lease_owner" IS NULL AND "lease_expires_at_ms" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_expires_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_expires_at_ms */
);

CREATE TABLE "workflow_blob_objects" (
  "blob_hash" TEXT NOT NULL /* logical_type=hash */,
  "byte_length" INTEGER NOT NULL /* logical_type=integer */,
  "state" TEXT NOT NULL /* logical_type=text */,
  "gc_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "deleted_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_blob_objects" PRIMARY KEY ("blob_hash"),
  CONSTRAINT "ck:workflow_blob_objects:blob_hash:hash" CHECK (("blob_hash" IS NULL OR (length("blob_hash") = 71 AND substr("blob_hash", 1, 7) = 'sha256:' AND substr("blob_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=blob_hash */,
  CONSTRAINT "ck:workflow_blob_objects:byte_length:safe_integer" CHECK (("byte_length" IS NULL OR "byte_length" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=byte_length */,
  CONSTRAINT "ck:workflow_blob_objects:state:enum" CHECK ("state" IN ('live', 'gc_candidate', 'deleting', 'deleted', 'corrupt')) /* check_kind=enum_membership logical_columns=state */,
  CONSTRAINT "ck:workflow_blob_objects:gc_epoch:safe_integer" CHECK (("gc_epoch" IS NULL OR "gc_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=gc_epoch */,
  CONSTRAINT "ck:workflow_blob_objects:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_blob_objects:deleted_at_ms:safe_integer" CHECK (("deleted_at_ms" IS NULL OR "deleted_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=deleted_at_ms */,
  CONSTRAINT "ck:blob_objects:deleted_time" CHECK ((("state" = 'deleted' AND "deleted_at_ms" IS NOT NULL) OR ("state" <> 'deleted' AND "deleted_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=state,deleted_at_ms */
);

CREATE TABLE "workflow_registry_resources" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "resource_type" TEXT NOT NULL /* logical_type=text */,
  "resource_id" TEXT NOT NULL /* logical_type=text */,
  "resource_version" TEXT NOT NULL /* logical_type=text */,
  "owner_core_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=core_release_registry reference_domain=core_release immutable=1 */,
  "owner_feature_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "canonical_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "content_hash" TEXT NOT NULL /* logical_type=hash */,
  "publication_state" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "published_at_ms" INTEGER /* logical_type=integer */,
  "retired_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_registry_resources" PRIMARY KEY ("id"),
  CONSTRAINT "fk:registry_resources:canonical_value" FOREIGN KEY ("canonical_value_id", "content_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_resources:content_hash:hash" CHECK (("content_hash" IS NULL OR (length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=content_hash */,
  CONSTRAINT "ck:workflow_registry_resources:publication_state:enum" CHECK ("publication_state" IN ('staged', 'published', 'retired')) /* check_kind=enum_membership logical_columns=publication_state */,
  CONSTRAINT "ck:workflow_registry_resources:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_registry_resources:published_at_ms:safe_integer" CHECK (("published_at_ms" IS NULL OR "published_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=published_at_ms */,
  CONSTRAINT "ck:workflow_registry_resources:retired_at_ms:safe_integer" CHECK (("retired_at_ms" IS NULL OR "retired_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=retired_at_ms */,
  CONSTRAINT "ck:workflow_registry_resources:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_registry_resources:owner_core_ref:owner_feature_id:exactly_one" CHECK ((("owner_core_ref" IS NOT NULL) + ("owner_feature_id" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=owner_core_ref,owner_feature_id */,
  CONSTRAINT "ck:registry_resources:publication_time" CHECK ((("publication_state" = 'staged' AND "published_at_ms" IS NULL AND "retired_at_ms" IS NULL) OR ("publication_state" = 'published' AND "published_at_ms" IS NOT NULL AND "retired_at_ms" IS NULL) OR ("publication_state" = 'retired' AND "published_at_ms" IS NOT NULL AND "retired_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=publication_state,published_at_ms,retired_at_ms */
);

CREATE TABLE "workflow_registry_resource_dependencies" (
  "resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "dependency_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "dependency_kind" TEXT NOT NULL /* logical_type=text */,
  "expected_content_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_registry_resource_dependencies" PRIMARY KEY ("resource_id", "dependency_resource_id", "dependency_kind"),
  CONSTRAINT "fk:registry_dependencies:resource" FOREIGN KEY ("resource_id") REFERENCES "workflow_registry_resources" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:registry_dependencies:dependency" FOREIGN KEY ("dependency_resource_id", "expected_content_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_resource_dependencies:expected_content_hash:hash" CHECK (("expected_content_hash" IS NULL OR (length("expected_content_hash") = 71 AND substr("expected_content_hash", 1, 7) = 'sha256:' AND substr("expected_content_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=expected_content_hash */,
  CONSTRAINT "ck:workflow_registry_resource_dependencies:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_registry_closure_manifests" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "closure_hash" TEXT NOT NULL /* logical_type=hash */,
  "manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_registry_closure_manifests" PRIMARY KEY ("id"),
  CONSTRAINT "fk:closure_manifests:value" FOREIGN KEY ("manifest_value_id", "manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_closure_manifests:closure_hash:hash" CHECK (("closure_hash" IS NULL OR (length("closure_hash") = 71 AND substr("closure_hash", 1, 7) = 'sha256:' AND substr("closure_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=closure_hash */,
  CONSTRAINT "ck:workflow_registry_closure_manifests:manifest_hash:hash" CHECK (("manifest_hash" IS NULL OR (length("manifest_hash") = 71 AND substr("manifest_hash", 1, 7) = 'sha256:' AND substr("manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=manifest_hash */,
  CONSTRAINT "ck:workflow_registry_closure_manifests:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_registry_closure_manifests:manifest_value_id:manifest_hash:pair" CHECK ((("manifest_value_id" IS NULL AND "manifest_hash" IS NULL) OR ("manifest_value_id" IS NOT NULL AND "manifest_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=manifest_value_id,manifest_hash */
);

CREATE TABLE "workflow_registry_closure_members" (
  "closure_manifest_id" TEXT NOT NULL /* logical_type=identifier */,
  "resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "resource_type" TEXT NOT NULL /* logical_type=text */,
  "content_hash" TEXT NOT NULL /* logical_type=hash */,
  "member_index" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_registry_closure_members" PRIMARY KEY ("closure_manifest_id", "resource_id"),
  CONSTRAINT "fk:closure_members:manifest" FOREIGN KEY ("closure_manifest_id") REFERENCES "workflow_registry_closure_manifests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:closure_members:resource" FOREIGN KEY ("resource_id", "content_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_closure_members:content_hash:hash" CHECK (("content_hash" IS NULL OR (length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=content_hash */,
  CONSTRAINT "ck:workflow_registry_closure_members:member_index:safe_integer" CHECK (("member_index" IS NULL OR "member_index" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=member_index */
);

CREATE TABLE "workflow_registry_snapshots" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "closure_manifest_id" TEXT NOT NULL /* logical_type=identifier */,
  "closure_hash" TEXT NOT NULL /* logical_type=hash */,
  "compiler_version" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_registry_snapshots" PRIMARY KEY ("id"),
  CONSTRAINT "fk:registry_snapshots:closure" FOREIGN KEY ("closure_manifest_id", "closure_hash") REFERENCES "workflow_registry_closure_manifests" ("id", "closure_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_snapshots:snapshot_hash:hash" CHECK (("snapshot_hash" IS NULL OR (length("snapshot_hash") = 71 AND substr("snapshot_hash", 1, 7) = 'sha256:' AND substr("snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=snapshot_hash */,
  CONSTRAINT "ck:workflow_registry_snapshots:closure_hash:hash" CHECK (("closure_hash" IS NULL OR (length("closure_hash") = 71 AND substr("closure_hash", 1, 7) = 'sha256:' AND substr("closure_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=closure_hash */,
  CONSTRAINT "ck:workflow_registry_snapshots:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_feature_releases" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "feature_id" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "release_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=feature_release_ref_validator reference_domain=feature_release immutable=1 */,
  "release_version" TEXT NOT NULL /* logical_type=text */,
  "release_hash" TEXT NOT NULL /* logical_type=hash */,
  "execution_artifact_resource_id" TEXT /* logical_type=identifier */,
  "execution_artifact_hash" TEXT /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "staged_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "activated_at_ms" INTEGER /* logical_type=integer */,
  "disabled_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_feature_releases" PRIMARY KEY ("id"),
  CONSTRAINT "fk:feature_releases:execution_artifact" FOREIGN KEY ("execution_artifact_resource_id", "execution_artifact_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_feature_releases:release_hash:hash" CHECK (("release_hash" IS NULL OR (length("release_hash") = 71 AND substr("release_hash", 1, 7) = 'sha256:' AND substr("release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=release_hash */,
  CONSTRAINT "ck:workflow_feature_releases:execution_artifact_hash:hash" CHECK (("execution_artifact_hash" IS NULL OR (length("execution_artifact_hash") = 71 AND substr("execution_artifact_hash", 1, 7) = 'sha256:' AND substr("execution_artifact_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=execution_artifact_hash */,
  CONSTRAINT "ck:workflow_feature_releases:status:enum" CHECK ("status" IN ('staged', 'active', 'draining', 'disabled', 'deleting')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_feature_releases:staged_at_ms:safe_integer" CHECK (("staged_at_ms" IS NULL OR "staged_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=staged_at_ms */,
  CONSTRAINT "ck:workflow_feature_releases:activated_at_ms:safe_integer" CHECK (("activated_at_ms" IS NULL OR "activated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=activated_at_ms */,
  CONSTRAINT "ck:workflow_feature_releases:disabled_at_ms:safe_integer" CHECK (("disabled_at_ms" IS NULL OR "disabled_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=disabled_at_ms */,
  CONSTRAINT "ck:workflow_feature_releases:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_feature_releases:execution_artifact_resource_id:execution_artifact_hash:pair" CHECK ((("execution_artifact_resource_id" IS NULL AND "execution_artifact_hash" IS NULL) OR ("execution_artifact_resource_id" IS NOT NULL AND "execution_artifact_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=execution_artifact_resource_id,execution_artifact_hash */,
  CONSTRAINT "ck:feature_releases:lifecycle_timestamps" CHECK ((("status" = 'staged' AND "activated_at_ms" IS NULL AND "disabled_at_ms" IS NULL) OR ("status" IN ('active', 'draining') AND "activated_at_ms" IS NOT NULL AND "disabled_at_ms" IS NULL AND "staged_at_ms" <= "activated_at_ms") OR ("status" IN ('disabled', 'deleting') AND "activated_at_ms" IS NOT NULL AND "disabled_at_ms" IS NOT NULL AND "staged_at_ms" <= "activated_at_ms" AND "activated_at_ms" <= "disabled_at_ms"))) /* check_kind=state_field_consistency logical_columns=status,staged_at_ms,activated_at_ms,disabled_at_ms */
);

CREATE TABLE "workflow_feature_release_resources" (
  "release_id" TEXT NOT NULL /* logical_type=identifier */,
  "resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "content_hash" TEXT NOT NULL /* logical_type=hash */,
  "resource_role" TEXT NOT NULL /* logical_type=text */,
  CONSTRAINT "pk:workflow_feature_release_resources" PRIMARY KEY ("release_id", "resource_id"),
  CONSTRAINT "fk:feature_release_resources:release" FOREIGN KEY ("release_id") REFERENCES "workflow_feature_releases" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:feature_release_resources:resource" FOREIGN KEY ("resource_id", "content_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_feature_release_resources:content_hash:hash" CHECK (("content_hash" IS NULL OR (length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=content_hash */
);

CREATE TABLE "workflow_feature_active_releases" (
  "feature_id" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "release_id" TEXT NOT NULL /* logical_type=identifier */,
  "release_hash" TEXT NOT NULL /* logical_type=hash */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "activated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_feature_active_releases" PRIMARY KEY ("feature_id"),
  CONSTRAINT "fk:feature_active_releases:release" FOREIGN KEY ("release_id", "release_hash") REFERENCES "workflow_feature_releases" ("id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:feature_active_releases:owner_release" FOREIGN KEY ("feature_id", "release_id", "release_hash") REFERENCES "workflow_feature_releases" ("feature_id", "id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_feature_active_releases:release_hash:hash" CHECK (("release_hash" IS NULL OR (length("release_hash") = 71 AND substr("release_hash", 1, 7) = 'sha256:' AND substr("release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=release_hash */,
  CONSTRAINT "ck:workflow_feature_active_releases:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_feature_active_releases:activated_at_ms:safe_integer" CHECK (("activated_at_ms" IS NULL OR "activated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=activated_at_ms */,
  CONSTRAINT "ck:feature_active_releases:positive_row_version" CHECK ("row_version" >= 1) /* check_kind=state_field_consistency logical_columns=row_version */
);

CREATE TABLE "workflow_registry_retention_handles" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "handle_kind" TEXT NOT NULL /* logical_type=text */,
  "feature_release_id" TEXT /* logical_type=identifier */,
  "graph_run_id" TEXT /* logical_type=identifier */,
  "backup_id" TEXT /* logical_type=identifier */,
  "external_actor_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=command_actor_registry reference_domain=command_actor immutable=1 */,
  "closure_manifest_id" TEXT NOT NULL /* logical_type=identifier */,
  "closure_hash" TEXT NOT NULL /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "released_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_registry_retention_handles" PRIMARY KEY ("id"),
  CONSTRAINT "fk:retention_handles:feature_release" FOREIGN KEY ("feature_release_id") REFERENCES "workflow_feature_releases" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:retention_handles:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:retention_handles:backup" FOREIGN KEY ("backup_id") REFERENCES "workflow_backups" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:retention_handles:closure" FOREIGN KEY ("closure_manifest_id", "closure_hash") REFERENCES "workflow_registry_closure_manifests" ("id", "closure_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_retention_handles:handle_kind:enum" CHECK ("handle_kind" IN ('published', 'active_run', 'manual_pin', 'investigation')) /* check_kind=enum_membership logical_columns=handle_kind */,
  CONSTRAINT "ck:workflow_registry_retention_handles:closure_hash:hash" CHECK (("closure_hash" IS NULL OR (length("closure_hash") = 71 AND substr("closure_hash", 1, 7) = 'sha256:' AND substr("closure_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=closure_hash */,
  CONSTRAINT "ck:workflow_registry_retention_handles:status:enum" CHECK ("status" IN ('held', 'released')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_registry_retention_handles:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_registry_retention_handles:released_at_ms:safe_integer" CHECK (("released_at_ms" IS NULL OR "released_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=released_at_ms */,
  CONSTRAINT "ck:workflow_registry_retention_handles:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_registry_retention_handles:feature_release_id:graph_run_id:backup_id:external_actor_ref:exactly_one" CHECK ((("feature_release_id" IS NOT NULL) + ("graph_run_id" IS NOT NULL) + ("backup_id" IS NOT NULL) + ("external_actor_ref" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=feature_release_id,graph_run_id,backup_id,external_actor_ref */,
  CONSTRAINT "ck:retention_handles:kind_root" CHECK ((("handle_kind" = 'published' AND "feature_release_id" IS NOT NULL) OR ("handle_kind" = 'active_run' AND "graph_run_id" IS NOT NULL) OR ("handle_kind" = 'manual_pin' AND ("backup_id" IS NOT NULL OR "external_actor_ref" IS NOT NULL)) OR ("handle_kind" = 'investigation' AND "external_actor_ref" IS NOT NULL))) /* check_kind=closed_target_mapping logical_columns=handle_kind,feature_release_id,graph_run_id,backup_id,external_actor_ref */,
  CONSTRAINT "ck:retention_handles:release_time" CHECK ((("status" = 'held' AND "released_at_ms" IS NULL) OR ("status" = 'released' AND "released_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=status,released_at_ms */
);

CREATE TABLE "workflow_registry_retention_handle_members" (
  "handle_id" TEXT NOT NULL /* logical_type=identifier */,
  "resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "content_hash" TEXT NOT NULL /* logical_type=hash */,
  CONSTRAINT "pk:workflow_registry_retention_handle_members" PRIMARY KEY ("handle_id", "resource_id"),
  CONSTRAINT "fk:retention_handle_members:handle" FOREIGN KEY ("handle_id") REFERENCES "workflow_registry_retention_handles" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:retention_handle_members:resource" FOREIGN KEY ("resource_id", "content_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_registry_retention_handle_members:content_hash:hash" CHECK (("content_hash" IS NULL OR (length("content_hash") = 71 AND substr("content_hash", 1, 7) = 'sha256:' AND substr("content_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=content_hash */
);

CREATE TABLE "workflow_backups" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "database_snapshot_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=backup_coordinator reference_domain=database_snapshot immutable=1 */,
  "database_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "manifest_value_id" TEXT /* logical_type=identifier */,
  "manifest_hash" TEXT /* logical_type=hash */,
  "started_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "completed_at_ms" INTEGER /* logical_type=integer */,
  "expires_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_backups" PRIMARY KEY ("id"),
  CONSTRAINT "fk:backups:manifest" FOREIGN KEY ("manifest_value_id", "manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_backups:status:enum" CHECK ("status" IN ('preparing', 'copying', 'completed', 'failed', 'expired')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_backups:database_snapshot_hash:hash" CHECK (("database_snapshot_hash" IS NULL OR (length("database_snapshot_hash") = 71 AND substr("database_snapshot_hash", 1, 7) = 'sha256:' AND substr("database_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=database_snapshot_hash */,
  CONSTRAINT "ck:workflow_backups:manifest_hash:hash" CHECK (("manifest_hash" IS NULL OR (length("manifest_hash") = 71 AND substr("manifest_hash", 1, 7) = 'sha256:' AND substr("manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=manifest_hash */,
  CONSTRAINT "ck:workflow_backups:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=started_at_ms */,
  CONSTRAINT "ck:workflow_backups:completed_at_ms:safe_integer" CHECK (("completed_at_ms" IS NULL OR "completed_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=completed_at_ms */,
  CONSTRAINT "ck:workflow_backups:expires_at_ms:safe_integer" CHECK (("expires_at_ms" IS NULL OR "expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expires_at_ms */,
  CONSTRAINT "ck:workflow_backups:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_backups:manifest_value_id:manifest_hash:pair" CHECK ((("manifest_value_id" IS NULL AND "manifest_hash" IS NULL) OR ("manifest_value_id" IS NOT NULL AND "manifest_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=manifest_value_id,manifest_hash */,
  CONSTRAINT "ck:backups:status_time" CHECK ((("status" IN ('preparing', 'copying') AND "completed_at_ms" IS NULL) OR ("status" IN ('completed', 'failed', 'expired') AND "completed_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=status,completed_at_ms */
);

CREATE TABLE "workflow_backup_blob_pins" (
  "backup_id" TEXT NOT NULL /* logical_type=identifier */,
  "blob_hash" TEXT NOT NULL /* logical_type=hash */,
  "expected_byte_length" INTEGER NOT NULL /* logical_type=integer */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "pinned_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "copied_at_ms" INTEGER /* logical_type=integer */,
  "released_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_backup_blob_pins" PRIMARY KEY ("backup_id", "blob_hash"),
  CONSTRAINT "fk:backup_blob_pins:backup" FOREIGN KEY ("backup_id") REFERENCES "workflow_backups" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:backup_blob_pins:blob" FOREIGN KEY ("blob_hash") REFERENCES "workflow_blob_objects" ("blob_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_backup_blob_pins:blob_hash:hash" CHECK (("blob_hash" IS NULL OR (length("blob_hash") = 71 AND substr("blob_hash", 1, 7) = 'sha256:' AND substr("blob_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=blob_hash */,
  CONSTRAINT "ck:workflow_backup_blob_pins:expected_byte_length:safe_integer" CHECK (("expected_byte_length" IS NULL OR "expected_byte_length" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expected_byte_length */,
  CONSTRAINT "ck:workflow_backup_blob_pins:status:enum" CHECK ("status" IN ('pinned', 'copied', 'released')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_backup_blob_pins:pinned_at_ms:safe_integer" CHECK (("pinned_at_ms" IS NULL OR "pinned_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=pinned_at_ms */,
  CONSTRAINT "ck:workflow_backup_blob_pins:copied_at_ms:safe_integer" CHECK (("copied_at_ms" IS NULL OR "copied_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=copied_at_ms */,
  CONSTRAINT "ck:workflow_backup_blob_pins:released_at_ms:safe_integer" CHECK (("released_at_ms" IS NULL OR "released_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=released_at_ms */,
  CONSTRAINT "ck:workflow_backup_blob_pins:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:backup_blob_pins:status_time" CHECK ((("status" = 'pinned' AND "copied_at_ms" IS NULL AND "released_at_ms" IS NULL) OR ("status" = 'copied' AND "copied_at_ms" IS NOT NULL AND "released_at_ms" IS NULL) OR ("status" = 'released' AND "released_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=status,copied_at_ms,released_at_ms */
);

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
  CONSTRAINT "ck:workflow_task_intakes:source:enum" CHECK ("source" IN ('global_assistant', 'feature_ui', 'schedule', 'api', 'workflow_transition')) /* check_kind=enum_membership logical_columns=source */,
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

CREATE TABLE "workflow_task_intake_revisions" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "intake_id" TEXT NOT NULL /* logical_type=identifier */,
  "revision_no" INTEGER NOT NULL /* logical_type=integer */,
  "parent_revision_id" TEXT /* logical_type=identifier */,
  "amendment_value_id" TEXT /* logical_type=identifier */,
  "amendment_hash" TEXT /* logical_type=hash */,
  "effective_input_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "effective_input_hash" TEXT NOT NULL /* logical_type=hash */,
  "attachment_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "attachment_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "clarification_contract_resource_id" TEXT /* logical_type=identifier */,
  "clarification_contract_resource_hash" TEXT /* logical_type=hash */,
  "source_routing_attempt_id" TEXT /* logical_type=identifier */,
  "actor_kind" TEXT NOT NULL /* logical_type=text */,
  "principal_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=principal_identity_resolver reference_domain=principal immutable=1 */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "revision_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_task_intake_revisions" PRIMARY KEY ("id"),
  CONSTRAINT "fk:intake_revisions:intake" FOREIGN KEY ("intake_id") REFERENCES "workflow_task_intakes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:intake_revisions:parent" FOREIGN KEY ("intake_id", "parent_revision_id") REFERENCES "workflow_task_intake_revisions" ("intake_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:intake_revisions:amendment" FOREIGN KEY ("amendment_value_id", "amendment_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:intake_revisions:effective_input" FOREIGN KEY ("effective_input_value_id", "effective_input_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:intake_revisions:attachments" FOREIGN KEY ("attachment_manifest_value_id", "attachment_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:intake_revisions:clarification" FOREIGN KEY ("clarification_contract_resource_id", "clarification_contract_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:intake_revisions:routing_attempt" FOREIGN KEY ("source_routing_attempt_id") REFERENCES "workflow_routing_attempts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_task_intake_revisions:revision_no:safe_integer" CHECK (("revision_no" IS NULL OR "revision_no" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=revision_no */,
  CONSTRAINT "ck:workflow_task_intake_revisions:amendment_hash:hash" CHECK (("amendment_hash" IS NULL OR (length("amendment_hash") = 71 AND substr("amendment_hash", 1, 7) = 'sha256:' AND substr("amendment_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=amendment_hash */,
  CONSTRAINT "ck:workflow_task_intake_revisions:effective_input_hash:hash" CHECK (("effective_input_hash" IS NULL OR (length("effective_input_hash") = 71 AND substr("effective_input_hash", 1, 7) = 'sha256:' AND substr("effective_input_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=effective_input_hash */,
  CONSTRAINT "ck:workflow_task_intake_revisions:attachment_manifest_hash:hash" CHECK (("attachment_manifest_hash" IS NULL OR (length("attachment_manifest_hash") = 71 AND substr("attachment_manifest_hash", 1, 7) = 'sha256:' AND substr("attachment_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=attachment_manifest_hash */,
  CONSTRAINT "ck:workflow_task_intake_revisions:clarification_contract_resource_hash:hash" CHECK (("clarification_contract_resource_hash" IS NULL OR (length("clarification_contract_resource_hash") = 71 AND substr("clarification_contract_resource_hash", 1, 7) = 'sha256:' AND substr("clarification_contract_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=clarification_contract_resource_hash */,
  CONSTRAINT "ck:workflow_task_intake_revisions:actor_kind:enum" CHECK ("actor_kind" IN ('human', 'feature_service', 'automation', 'system')) /* check_kind=enum_membership logical_columns=actor_kind */,
  CONSTRAINT "ck:workflow_task_intake_revisions:revision_hash:hash" CHECK (("revision_hash" IS NULL OR (length("revision_hash") = 71 AND substr("revision_hash", 1, 7) = 'sha256:' AND substr("revision_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=revision_hash */,
  CONSTRAINT "ck:workflow_task_intake_revisions:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_task_intake_revisions:amendment_value_id:amendment_hash:pair" CHECK ((("amendment_value_id" IS NULL AND "amendment_hash" IS NULL) OR ("amendment_value_id" IS NOT NULL AND "amendment_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=amendment_value_id,amendment_hash */,
  CONSTRAINT "ck:workflow_task_intake_revisions:clarification_contract_resource_id:clarification_contract_resource_hash:pair" CHECK ((("clarification_contract_resource_id" IS NULL AND "clarification_contract_resource_hash" IS NULL) OR ("clarification_contract_resource_id" IS NOT NULL AND "clarification_contract_resource_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=clarification_contract_resource_id,clarification_contract_resource_hash */,
  CONSTRAINT "ck:intake_revisions:parent_sequence" CHECK ((("revision_no" = 0 AND "parent_revision_id" IS NULL) OR ("revision_no" > 0 AND "parent_revision_id" IS NOT NULL))) /* check_kind=lineage_consistency logical_columns=revision_no,parent_revision_id */
);

CREATE TABLE "workflow_routing_attempts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "intake_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "intake_revision_id" TEXT NOT NULL /* logical_type=identifier */,
  "input_hash" TEXT NOT NULL /* logical_type=hash */,
  "parent_scope_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "parent_scope_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "scope_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "router_capability_resource_id" TEXT /* logical_type=identifier */,
  "router_capability_resource_hash" TEXT /* logical_type=hash */,
  "input_snapshot_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "input_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "decision_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "decision_hash" TEXT NOT NULL /* logical_type=hash */,
  "decision_kind" TEXT NOT NULL /* logical_type=text */,
  "target_resource_id" TEXT /* logical_type=identifier */,
  "target_resource_hash" TEXT /* logical_type=hash */,
  "confidence_micros" INTEGER NOT NULL /* logical_type=integer */,
  "reason_codes_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "missing_fields_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_routing_attempts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:routing_attempts:intake" FOREIGN KEY ("intake_id") REFERENCES "workflow_task_intakes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:routing_attempts:revision" FOREIGN KEY ("intake_id", "intake_revision_id") REFERENCES "workflow_task_intake_revisions" ("intake_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:routing_attempts:parent_scope" FOREIGN KEY ("parent_scope_resource_id", "parent_scope_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:routing_attempts:scope" FOREIGN KEY ("scope_resource_id", "scope_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:routing_attempts:router_capability" FOREIGN KEY ("router_capability_resource_id", "router_capability_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:routing_attempts:input_snapshot" FOREIGN KEY ("input_snapshot_value_id", "input_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:routing_attempts:decision" FOREIGN KEY ("decision_value_id", "decision_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:routing_attempts:target" FOREIGN KEY ("target_resource_id", "target_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_routing_attempts:attempt_no:safe_integer" CHECK (("attempt_no" IS NULL OR "attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_no */,
  CONSTRAINT "ck:workflow_routing_attempts:input_hash:hash" CHECK (("input_hash" IS NULL OR (length("input_hash") = 71 AND substr("input_hash", 1, 7) = 'sha256:' AND substr("input_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_hash */,
  CONSTRAINT "ck:workflow_routing_attempts:parent_scope_resource_hash:hash" CHECK (("parent_scope_resource_hash" IS NULL OR (length("parent_scope_resource_hash") = 71 AND substr("parent_scope_resource_hash", 1, 7) = 'sha256:' AND substr("parent_scope_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=parent_scope_resource_hash */,
  CONSTRAINT "ck:workflow_routing_attempts:scope_resource_hash:hash" CHECK (("scope_resource_hash" IS NULL OR (length("scope_resource_hash") = 71 AND substr("scope_resource_hash", 1, 7) = 'sha256:' AND substr("scope_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=scope_resource_hash */,
  CONSTRAINT "ck:workflow_routing_attempts:router_capability_resource_hash:hash" CHECK (("router_capability_resource_hash" IS NULL OR (length("router_capability_resource_hash") = 71 AND substr("router_capability_resource_hash", 1, 7) = 'sha256:' AND substr("router_capability_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=router_capability_resource_hash */,
  CONSTRAINT "ck:workflow_routing_attempts:input_snapshot_hash:hash" CHECK (("input_snapshot_hash" IS NULL OR (length("input_snapshot_hash") = 71 AND substr("input_snapshot_hash", 1, 7) = 'sha256:' AND substr("input_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_snapshot_hash */,
  CONSTRAINT "ck:workflow_routing_attempts:decision_hash:hash" CHECK (("decision_hash" IS NULL OR (length("decision_hash") = 71 AND substr("decision_hash", 1, 7) = 'sha256:' AND substr("decision_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=decision_hash */,
  CONSTRAINT "ck:workflow_routing_attempts:decision_kind:enum" CHECK ("decision_kind" IN ('recipe_selected', 'child_scope_selected', 'needs_clarification', 'unsupported')) /* check_kind=enum_membership logical_columns=decision_kind */,
  CONSTRAINT "ck:workflow_routing_attempts:target_resource_hash:hash" CHECK (("target_resource_hash" IS NULL OR (length("target_resource_hash") = 71 AND substr("target_resource_hash", 1, 7) = 'sha256:' AND substr("target_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=target_resource_hash */,
  CONSTRAINT "ck:workflow_routing_attempts:confidence_micros:safe_integer" CHECK (("confidence_micros" IS NULL OR "confidence_micros" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=confidence_micros */,
  CONSTRAINT "ck:workflow_routing_attempts:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_routing_attempts:router_capability_resource_id:router_capability_resource_hash:pair" CHECK ((("router_capability_resource_id" IS NULL AND "router_capability_resource_hash" IS NULL) OR ("router_capability_resource_id" IS NOT NULL AND "router_capability_resource_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=router_capability_resource_id,router_capability_resource_hash */,
  CONSTRAINT "ck:routing_attempts:confidence_range" CHECK ("confidence_micros" BETWEEN 0 AND 1000000) /* check_kind=ordered_values logical_columns=confidence_micros */,
  CONSTRAINT "ck:routing_attempts:decision_target" CHECK ((("decision_kind" IN ('recipe_selected', 'child_scope_selected') AND "target_resource_id" IS NOT NULL AND "target_resource_hash" IS NOT NULL) OR ("decision_kind" IN ('needs_clarification', 'unsupported') AND "target_resource_id" IS NULL AND "target_resource_hash" IS NULL))) /* check_kind=state_field_consistency logical_columns=decision_kind,target_resource_id,target_resource_hash */
);

CREATE TABLE "workflow_creation_requests" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "intake_id" TEXT NOT NULL /* logical_type=identifier */,
  "creation_mode" TEXT NOT NULL /* logical_type=text */,
  "creation_domain" TEXT NOT NULL /* logical_type=text */,
  "creation_key" TEXT NOT NULL /* logical_type=text */,
  "recipe_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "recipe_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "definition_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "definition_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "entry_point" TEXT NOT NULL /* logical_type=text */,
  "execution_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "execution_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "input_snapshot_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "input_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "attachment_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "attachment_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "creation_intent_hash" TEXT NOT NULL /* logical_type=hash */,
  "runtime_safety_hash" TEXT NOT NULL /* logical_type=hash */,
  "launch_confirmation_id" TEXT /* logical_type=identifier */,
  "launch_confirmation_hash" TEXT /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "workflow_id" TEXT /* logical_type=identifier */,
  "error_code" TEXT /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_creation_requests" PRIMARY KEY ("id"),
  CONSTRAINT "fk:creation_requests:intake" FOREIGN KEY ("intake_id") REFERENCES "workflow_task_intakes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:creation_requests:recipe" FOREIGN KEY ("recipe_resource_id", "recipe_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:creation_requests:definition" FOREIGN KEY ("definition_resource_id", "definition_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:creation_requests:execution_policy" FOREIGN KEY ("execution_policy_resource_id", "execution_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:creation_requests:input_snapshot" FOREIGN KEY ("input_snapshot_value_id", "input_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:creation_requests:attachments" FOREIGN KEY ("attachment_manifest_value_id", "attachment_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:creation_requests:confirmation" FOREIGN KEY ("launch_confirmation_id", "launch_confirmation_hash") REFERENCES "workflow_launch_confirmations" ("id", "request_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:creation_requests:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_creation_requests:creation_mode:enum" CHECK ("creation_mode" IN ('direct', 'required_finalization', 'best_effort_delivery')) /* check_kind=enum_membership logical_columns=creation_mode */,
  CONSTRAINT "ck:workflow_creation_requests:recipe_resource_hash:hash" CHECK (("recipe_resource_hash" IS NULL OR (length("recipe_resource_hash") = 71 AND substr("recipe_resource_hash", 1, 7) = 'sha256:' AND substr("recipe_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=recipe_resource_hash */,
  CONSTRAINT "ck:workflow_creation_requests:definition_resource_hash:hash" CHECK (("definition_resource_hash" IS NULL OR (length("definition_resource_hash") = 71 AND substr("definition_resource_hash", 1, 7) = 'sha256:' AND substr("definition_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=definition_resource_hash */,
  CONSTRAINT "ck:workflow_creation_requests:execution_policy_resource_hash:hash" CHECK (("execution_policy_resource_hash" IS NULL OR (length("execution_policy_resource_hash") = 71 AND substr("execution_policy_resource_hash", 1, 7) = 'sha256:' AND substr("execution_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=execution_policy_resource_hash */,
  CONSTRAINT "ck:workflow_creation_requests:input_snapshot_hash:hash" CHECK (("input_snapshot_hash" IS NULL OR (length("input_snapshot_hash") = 71 AND substr("input_snapshot_hash", 1, 7) = 'sha256:' AND substr("input_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_snapshot_hash */,
  CONSTRAINT "ck:workflow_creation_requests:attachment_manifest_hash:hash" CHECK (("attachment_manifest_hash" IS NULL OR (length("attachment_manifest_hash") = 71 AND substr("attachment_manifest_hash", 1, 7) = 'sha256:' AND substr("attachment_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=attachment_manifest_hash */,
  CONSTRAINT "ck:workflow_creation_requests:creation_intent_hash:hash" CHECK (("creation_intent_hash" IS NULL OR (length("creation_intent_hash") = 71 AND substr("creation_intent_hash", 1, 7) = 'sha256:' AND substr("creation_intent_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=creation_intent_hash */,
  CONSTRAINT "ck:workflow_creation_requests:runtime_safety_hash:hash" CHECK (("runtime_safety_hash" IS NULL OR (length("runtime_safety_hash") = 71 AND substr("runtime_safety_hash", 1, 7) = 'sha256:' AND substr("runtime_safety_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=runtime_safety_hash */,
  CONSTRAINT "ck:workflow_creation_requests:launch_confirmation_hash:hash" CHECK (("launch_confirmation_hash" IS NULL OR (length("launch_confirmation_hash") = 71 AND substr("launch_confirmation_hash", 1, 7) = 'sha256:' AND substr("launch_confirmation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=launch_confirmation_hash */,
  CONSTRAINT "ck:workflow_creation_requests:status:enum" CHECK ("status" IN ('pending', 'blocked_retryable', 'awaiting_confirmation', 'created', 'rejected_permanent', 'cancelled')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_creation_requests:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_creation_requests:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_creation_requests:launch_confirmation_id:launch_confirmation_hash:pair" CHECK ((("launch_confirmation_id" IS NULL AND "launch_confirmation_hash" IS NULL) OR ("launch_confirmation_id" IS NOT NULL AND "launch_confirmation_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=launch_confirmation_id,launch_confirmation_hash */,
  CONSTRAINT "ck:creation_requests:terminal_fields" CHECK ((("status" = 'created' AND "workflow_id" IS NOT NULL AND "error_code" IS NULL) OR ("status" = 'rejected_permanent' AND "workflow_id" IS NULL AND "error_code" IS NOT NULL) OR ("status" IN ('pending', 'blocked_retryable', 'awaiting_confirmation', 'cancelled') AND "workflow_id" IS NULL AND "error_code" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,workflow_id,error_code */
);

CREATE TABLE "workflow_launch_confirmations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "intake_id" TEXT NOT NULL /* logical_type=identifier */,
  "intake_revision_id" TEXT NOT NULL /* logical_type=identifier */,
  "input_hash" TEXT NOT NULL /* logical_type=hash */,
  "routing_decision_id" TEXT NOT NULL /* logical_type=identifier */,
  "routing_decision_hash" TEXT NOT NULL /* logical_type=hash */,
  "recipe_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "recipe_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "creation_intent_hash" TEXT NOT NULL /* logical_type=hash */,
  "actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=command_actor_registry reference_domain=command_actor immutable=1 */,
  "action" TEXT NOT NULL /* logical_type=text */,
  "expires_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_launch_confirmations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:launch_confirmations:intake" FOREIGN KEY ("intake_id") REFERENCES "workflow_task_intakes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:launch_confirmations:revision" FOREIGN KEY ("intake_id", "intake_revision_id") REFERENCES "workflow_task_intake_revisions" ("intake_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:launch_confirmations:routing_attempt" FOREIGN KEY ("routing_decision_id") REFERENCES "workflow_routing_attempts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:launch_confirmations:recipe" FOREIGN KEY ("recipe_resource_id", "recipe_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_launch_confirmations:input_hash:hash" CHECK (("input_hash" IS NULL OR (length("input_hash") = 71 AND substr("input_hash", 1, 7) = 'sha256:' AND substr("input_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_hash */,
  CONSTRAINT "ck:workflow_launch_confirmations:routing_decision_hash:hash" CHECK (("routing_decision_hash" IS NULL OR (length("routing_decision_hash") = 71 AND substr("routing_decision_hash", 1, 7) = 'sha256:' AND substr("routing_decision_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=routing_decision_hash */,
  CONSTRAINT "ck:workflow_launch_confirmations:recipe_resource_hash:hash" CHECK (("recipe_resource_hash" IS NULL OR (length("recipe_resource_hash") = 71 AND substr("recipe_resource_hash", 1, 7) = 'sha256:' AND substr("recipe_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=recipe_resource_hash */,
  CONSTRAINT "ck:workflow_launch_confirmations:creation_intent_hash:hash" CHECK (("creation_intent_hash" IS NULL OR (length("creation_intent_hash") = 71 AND substr("creation_intent_hash", 1, 7) = 'sha256:' AND substr("creation_intent_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=creation_intent_hash */,
  CONSTRAINT "ck:workflow_launch_confirmations:action:enum" CHECK ("action" IN ('approve', 'decline')) /* check_kind=enum_membership logical_columns=action */,
  CONSTRAINT "ck:workflow_launch_confirmations:expires_at_ms:safe_integer" CHECK (("expires_at_ms" IS NULL OR "expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expires_at_ms */,
  CONSTRAINT "ck:workflow_launch_confirmations:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_launch_confirmations:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_creation_attempts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "creation_request_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "error_code" TEXT /* logical_type=text */,
  "retry_at_ms" INTEGER /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_creation_attempts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:creation_attempts:request" FOREIGN KEY ("creation_request_id") REFERENCES "workflow_creation_requests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_creation_attempts:attempt_no:safe_integer" CHECK (("attempt_no" IS NULL OR "attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_no */,
  CONSTRAINT "ck:workflow_creation_attempts:status:enum" CHECK ("status" IN ('pending', 'retry_wait', 'succeeded', 'rejected')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_creation_attempts:retry_at_ms:safe_integer" CHECK (("retry_at_ms" IS NULL OR "retry_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=retry_at_ms */,
  CONSTRAINT "ck:workflow_creation_attempts:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:creation_attempts:retry_fields" CHECK ((("status" = 'retry_wait' AND "error_code" IS NOT NULL AND "retry_at_ms" IS NOT NULL) OR ("status" IN ('pending', 'succeeded') AND "error_code" IS NULL AND "retry_at_ms" IS NULL) OR ("status" = 'rejected' AND "error_code" IS NOT NULL AND "retry_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,error_code,retry_at_ms */
);

CREATE TABLE "workflows" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "operational_state" TEXT NOT NULL /* logical_type=text */,
  "recipe_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "recipe_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "recipe_version" TEXT NOT NULL /* logical_type=text */,
  "creation_request_id" TEXT NOT NULL /* logical_type=identifier */,
  "creation_domain" TEXT NOT NULL /* logical_type=text */,
  "creation_key" TEXT NOT NULL /* logical_type=text */,
  "owner_principal_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=principal_identity_resolver reference_domain=principal immutable=1 */,
  "controlling_feature_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "creator_automation_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=automation_registry reference_domain=automation immutable=1 */,
  "ownership_hash" TEXT NOT NULL /* logical_type=hash */,
  "root_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "parent_workflow_id" TEXT /* logical_type=identifier */,
  "workflow_depth" INTEGER NOT NULL /* logical_type=integer */,
  "lineage_budget_account_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_execution_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_execution_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "workflow_command_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_command_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "workflow_input_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_input_hash" TEXT NOT NULL /* logical_type=hash */,
  "workflow_input_schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_input_schema_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "context_contract_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "context_contract_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "current_context_snapshot_id" TEXT NOT NULL /* logical_type=identifier */,
  "current_context_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "runtime_safety_hash" TEXT NOT NULL /* logical_type=hash */,
  "state_activation_count" INTEGER NOT NULL /* logical_type=integer */,
  "graph_run_count" INTEGER NOT NULL /* logical_type=integer */,
  "state_transition_count" INTEGER NOT NULL /* logical_type=integer */,
  "child_workflow_count" INTEGER NOT NULL /* logical_type=integer */,
  "started_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "deadline_at_ms" INTEGER /* logical_type=integer */,
  "workflow_definition_version" TEXT NOT NULL /* logical_type=text */,
  "state_instance_id" TEXT NOT NULL /* logical_type=identifier */,
  "current_graph_run_id" TEXT /* logical_type=identifier */,
  "final_outcome_kind" TEXT /* logical_type=text */,
  "final_output_value_id" TEXT /* logical_type=identifier */,
  "final_output_hash" TEXT /* logical_type=hash */,
  "final_output_schema_hash" TEXT /* logical_type=hash */,
  "final_error_code" TEXT /* logical_type=text */,
  "final_error_detail_value_id" TEXT /* logical_type=identifier */,
  "final_error_detail_hash" TEXT /* logical_type=hash */,
  "final_cancel_reason" TEXT /* logical_type=text */,
  "workflow_revision" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflows" PRIMARY KEY ("id"),
  CONSTRAINT "fk:workflows:recipe" FOREIGN KEY ("recipe_resource_id", "recipe_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:creation_request" FOREIGN KEY ("creation_request_id") REFERENCES "workflow_creation_requests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:root" FOREIGN KEY ("root_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:parent" FOREIGN KEY ("parent_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:lineage_account" FOREIGN KEY ("lineage_budget_account_id") REFERENCES "workflow_graph_resource_accounts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:execution_policy" FOREIGN KEY ("workflow_execution_policy_resource_id", "workflow_execution_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:command_policy" FOREIGN KEY ("workflow_command_policy_resource_id", "workflow_command_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:input" FOREIGN KEY ("workflow_input_value_id", "workflow_input_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:input_schema" FOREIGN KEY ("workflow_input_schema_resource_id", "workflow_input_schema_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:context_contract" FOREIGN KEY ("context_contract_resource_id", "context_contract_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:context_snapshot" FOREIGN KEY ("id", "current_context_snapshot_id", "current_context_snapshot_hash") REFERENCES "workflow_context_snapshots" ("workflow_id", "id", "snapshot_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:state_instance" FOREIGN KEY ("id", "state_instance_id") REFERENCES "workflow_state_activations" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:current_run" FOREIGN KEY ("id", "current_graph_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:final_output" FOREIGN KEY ("final_output_value_id", "final_output_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflows:final_error_detail" FOREIGN KEY ("final_error_detail_value_id", "final_error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflows:status:enum" CHECK ("status" IN ('active', 'completed', 'errored', 'cancelled', 'administratively_abandoned')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflows:operational_state:enum" CHECK ("operational_state" IN ('healthy', 'action_required', 'quarantined', 'administratively_abandoned')) /* check_kind=enum_membership logical_columns=operational_state */,
  CONSTRAINT "ck:workflows:recipe_resource_hash:hash" CHECK (("recipe_resource_hash" IS NULL OR (length("recipe_resource_hash") = 71 AND substr("recipe_resource_hash", 1, 7) = 'sha256:' AND substr("recipe_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=recipe_resource_hash */,
  CONSTRAINT "ck:workflows:ownership_hash:hash" CHECK (("ownership_hash" IS NULL OR (length("ownership_hash") = 71 AND substr("ownership_hash", 1, 7) = 'sha256:' AND substr("ownership_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=ownership_hash */,
  CONSTRAINT "ck:workflows:workflow_depth:safe_integer" CHECK (("workflow_depth" IS NULL OR "workflow_depth" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=workflow_depth */,
  CONSTRAINT "ck:workflows:workflow_execution_policy_resource_hash:hash" CHECK (("workflow_execution_policy_resource_hash" IS NULL OR (length("workflow_execution_policy_resource_hash") = 71 AND substr("workflow_execution_policy_resource_hash", 1, 7) = 'sha256:' AND substr("workflow_execution_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=workflow_execution_policy_resource_hash */,
  CONSTRAINT "ck:workflows:workflow_command_policy_resource_hash:hash" CHECK (("workflow_command_policy_resource_hash" IS NULL OR (length("workflow_command_policy_resource_hash") = 71 AND substr("workflow_command_policy_resource_hash", 1, 7) = 'sha256:' AND substr("workflow_command_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=workflow_command_policy_resource_hash */,
  CONSTRAINT "ck:workflows:workflow_input_hash:hash" CHECK (("workflow_input_hash" IS NULL OR (length("workflow_input_hash") = 71 AND substr("workflow_input_hash", 1, 7) = 'sha256:' AND substr("workflow_input_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=workflow_input_hash */,
  CONSTRAINT "ck:workflows:workflow_input_schema_resource_hash:hash" CHECK (("workflow_input_schema_resource_hash" IS NULL OR (length("workflow_input_schema_resource_hash") = 71 AND substr("workflow_input_schema_resource_hash", 1, 7) = 'sha256:' AND substr("workflow_input_schema_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=workflow_input_schema_resource_hash */,
  CONSTRAINT "ck:workflows:context_contract_resource_hash:hash" CHECK (("context_contract_resource_hash" IS NULL OR (length("context_contract_resource_hash") = 71 AND substr("context_contract_resource_hash", 1, 7) = 'sha256:' AND substr("context_contract_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=context_contract_resource_hash */,
  CONSTRAINT "ck:workflows:current_context_snapshot_hash:hash" CHECK (("current_context_snapshot_hash" IS NULL OR (length("current_context_snapshot_hash") = 71 AND substr("current_context_snapshot_hash", 1, 7) = 'sha256:' AND substr("current_context_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=current_context_snapshot_hash */,
  CONSTRAINT "ck:workflows:runtime_safety_hash:hash" CHECK (("runtime_safety_hash" IS NULL OR (length("runtime_safety_hash") = 71 AND substr("runtime_safety_hash", 1, 7) = 'sha256:' AND substr("runtime_safety_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=runtime_safety_hash */,
  CONSTRAINT "ck:workflows:state_activation_count:safe_integer" CHECK (("state_activation_count" IS NULL OR "state_activation_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=state_activation_count */,
  CONSTRAINT "ck:workflows:graph_run_count:safe_integer" CHECK (("graph_run_count" IS NULL OR "graph_run_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=graph_run_count */,
  CONSTRAINT "ck:workflows:state_transition_count:safe_integer" CHECK (("state_transition_count" IS NULL OR "state_transition_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=state_transition_count */,
  CONSTRAINT "ck:workflows:child_workflow_count:safe_integer" CHECK (("child_workflow_count" IS NULL OR "child_workflow_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=child_workflow_count */,
  CONSTRAINT "ck:workflows:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=started_at_ms */,
  CONSTRAINT "ck:workflows:deadline_at_ms:safe_integer" CHECK (("deadline_at_ms" IS NULL OR "deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=deadline_at_ms */,
  CONSTRAINT "ck:workflows:final_outcome_kind:enum" CHECK ("final_outcome_kind" IN ('normal', 'errored', 'cancelled')) /* check_kind=enum_membership logical_columns=final_outcome_kind */,
  CONSTRAINT "ck:workflows:final_output_hash:hash" CHECK (("final_output_hash" IS NULL OR (length("final_output_hash") = 71 AND substr("final_output_hash", 1, 7) = 'sha256:' AND substr("final_output_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=final_output_hash */,
  CONSTRAINT "ck:workflows:final_output_schema_hash:hash" CHECK (("final_output_schema_hash" IS NULL OR (length("final_output_schema_hash") = 71 AND substr("final_output_schema_hash", 1, 7) = 'sha256:' AND substr("final_output_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=final_output_schema_hash */,
  CONSTRAINT "ck:workflows:final_error_detail_hash:hash" CHECK (("final_error_detail_hash" IS NULL OR (length("final_error_detail_hash") = 71 AND substr("final_error_detail_hash", 1, 7) = 'sha256:' AND substr("final_error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=final_error_detail_hash */,
  CONSTRAINT "ck:workflows:workflow_revision:safe_integer" CHECK (("workflow_revision" IS NULL OR "workflow_revision" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=workflow_revision */,
  CONSTRAINT "ck:workflows:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflows:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflows:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflows:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflows:final_output_value_id:final_output_hash:pair" CHECK ((("final_output_value_id" IS NULL AND "final_output_hash" IS NULL) OR ("final_output_value_id" IS NOT NULL AND "final_output_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=final_output_value_id,final_output_hash */,
  CONSTRAINT "ck:workflows:final_error_detail_value_id:final_error_detail_hash:pair" CHECK ((("final_error_detail_value_id" IS NULL AND "final_error_detail_hash" IS NULL) OR ("final_error_detail_value_id" IS NOT NULL AND "final_error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=final_error_detail_value_id,final_error_detail_hash */,
  CONSTRAINT "ck:workflows:status_time" CHECK ((("status" = 'active' AND "finished_at_ms" IS NULL) OR ("status" IN ('completed', 'errored', 'cancelled', 'administratively_abandoned') AND "finished_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=status,finished_at_ms */,
  CONSTRAINT "ck:workflows:abandon_state" CHECK ((("status" = 'administratively_abandoned') = ("operational_state" = 'administratively_abandoned'))) /* check_kind=cross_column_equality logical_columns=status,operational_state */,
  CONSTRAINT "ck:workflows:final_outcome_shape" CHECK ((("status" = 'completed' AND "final_outcome_kind" = 'normal' AND "final_output_value_id" IS NOT NULL AND "final_error_code" IS NULL AND "final_cancel_reason" IS NULL) OR ("status" = 'errored' AND "final_outcome_kind" = 'errored' AND "final_output_value_id" IS NULL AND "final_error_code" IS NOT NULL AND "final_cancel_reason" IS NULL) OR ("status" = 'cancelled' AND "final_outcome_kind" = 'cancelled' AND "final_output_value_id" IS NULL AND "final_error_code" IS NULL AND "final_cancel_reason" IS NOT NULL) OR ("status" IN ('active', 'administratively_abandoned') AND "final_outcome_kind" IS NULL AND "final_output_value_id" IS NULL AND "final_error_code" IS NULL AND "final_cancel_reason" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,final_outcome_kind,final_output_value_id,final_error_code,final_cancel_reason */
);

CREATE TABLE "workflow_state_activations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "state_key" TEXT NOT NULL /* logical_type=text */,
  "state_type" TEXT NOT NULL /* logical_type=text */,
  "activation_no" INTEGER NOT NULL /* logical_type=integer */,
  "workflow_definition_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_definition_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "workflow_definition_version" TEXT NOT NULL /* logical_type=text */,
  "state_config_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "state_config_hash" TEXT NOT NULL /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "graph_run_id" TEXT /* logical_type=identifier */,
  "entered_via_transition_id" TEXT /* logical_type=identifier */,
  "terminal_kind" TEXT /* logical_type=text */,
  "terminal_output_value_id" TEXT /* logical_type=identifier */,
  "terminal_output_hash" TEXT /* logical_type=hash */,
  "terminal_output_schema_hash" TEXT /* logical_type=hash */,
  "terminal_error_code" TEXT /* logical_type=text */,
  "terminal_error_detail_value_id" TEXT /* logical_type=identifier */,
  "terminal_error_detail_hash" TEXT /* logical_type=hash */,
  "started_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_state_activations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:state_activations:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:definition" FOREIGN KEY ("workflow_definition_resource_id", "workflow_definition_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:config" FOREIGN KEY ("state_config_value_id", "state_config_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:run" FOREIGN KEY ("workflow_id", "graph_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:transition" FOREIGN KEY ("entered_via_transition_id") REFERENCES "workflow_state_transition_history" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:terminal_output" FOREIGN KEY ("terminal_output_value_id", "terminal_output_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:state_activations:terminal_error" FOREIGN KEY ("terminal_error_detail_value_id", "terminal_error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_state_activations:state_type:enum" CHECK ("state_type" IN ('delegation', 'system', 'interrupt', 'graph', 'terminal')) /* check_kind=enum_membership logical_columns=state_type */,
  CONSTRAINT "ck:workflow_state_activations:activation_no:safe_integer" CHECK (("activation_no" IS NULL OR "activation_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=activation_no */,
  CONSTRAINT "ck:workflow_state_activations:workflow_definition_resource_hash:hash" CHECK (("workflow_definition_resource_hash" IS NULL OR (length("workflow_definition_resource_hash") = 71 AND substr("workflow_definition_resource_hash", 1, 7) = 'sha256:' AND substr("workflow_definition_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=workflow_definition_resource_hash */,
  CONSTRAINT "ck:workflow_state_activations:state_config_hash:hash" CHECK (("state_config_hash" IS NULL OR (length("state_config_hash") = 71 AND substr("state_config_hash", 1, 7) = 'sha256:' AND substr("state_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=state_config_hash */,
  CONSTRAINT "ck:workflow_state_activations:status:enum" CHECK ("status" IN ('active', 'completed', 'abandoned')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_state_activations:terminal_kind:enum" CHECK ("terminal_kind" IN ('normal', 'errored')) /* check_kind=enum_membership logical_columns=terminal_kind */,
  CONSTRAINT "ck:workflow_state_activations:terminal_output_hash:hash" CHECK (("terminal_output_hash" IS NULL OR (length("terminal_output_hash") = 71 AND substr("terminal_output_hash", 1, 7) = 'sha256:' AND substr("terminal_output_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=terminal_output_hash */,
  CONSTRAINT "ck:workflow_state_activations:terminal_output_schema_hash:hash" CHECK (("terminal_output_schema_hash" IS NULL OR (length("terminal_output_schema_hash") = 71 AND substr("terminal_output_schema_hash", 1, 7) = 'sha256:' AND substr("terminal_output_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=terminal_output_schema_hash */,
  CONSTRAINT "ck:workflow_state_activations:terminal_error_detail_hash:hash" CHECK (("terminal_error_detail_hash" IS NULL OR (length("terminal_error_detail_hash") = 71 AND substr("terminal_error_detail_hash", 1, 7) = 'sha256:' AND substr("terminal_error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=terminal_error_detail_hash */,
  CONSTRAINT "ck:workflow_state_activations:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=started_at_ms */,
  CONSTRAINT "ck:workflow_state_activations:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflow_state_activations:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_state_activations:terminal_output_value_id:terminal_output_hash:pair" CHECK ((("terminal_output_value_id" IS NULL AND "terminal_output_hash" IS NULL) OR ("terminal_output_value_id" IS NOT NULL AND "terminal_output_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=terminal_output_value_id,terminal_output_hash */,
  CONSTRAINT "ck:workflow_state_activations:terminal_error_detail_value_id:terminal_error_detail_hash:pair" CHECK ((("terminal_error_detail_value_id" IS NULL AND "terminal_error_detail_hash" IS NULL) OR ("terminal_error_detail_value_id" IS NOT NULL AND "terminal_error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=terminal_error_detail_value_id,terminal_error_detail_hash */,
  CONSTRAINT "ck:state_activations:type_run" CHECK ((("state_type" = 'terminal' AND "status" = 'completed' AND "graph_run_id" IS NULL AND "terminal_kind" IS NOT NULL) OR ("state_type" <> 'terminal' AND "graph_run_id" IS NOT NULL AND "terminal_kind" IS NULL))) /* check_kind=state_field_consistency logical_columns=state_type,status,graph_run_id,terminal_kind */,
  CONSTRAINT "ck:state_activations:status_time" CHECK ((("status" = 'active' AND "finished_at_ms" IS NULL) OR ("status" IN ('completed', 'abandoned') AND "finished_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=status,finished_at_ms */,
  CONSTRAINT "ck:state_activations:terminal_shape" CHECK ((("terminal_kind" = 'normal' AND "terminal_output_value_id" IS NOT NULL AND "terminal_error_code" IS NULL AND "terminal_error_detail_value_id" IS NULL) OR ("terminal_kind" = 'errored' AND "terminal_output_value_id" IS NULL AND "terminal_error_code" IS NOT NULL) OR ("terminal_kind" IS NULL AND "terminal_output_value_id" IS NULL AND "terminal_error_code" IS NULL AND "terminal_error_detail_value_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=terminal_kind,terminal_output_value_id,terminal_error_code,terminal_error_detail_value_id */,
  CONSTRAINT "ck:state_activations:no_terminal_abandon" CHECK (NOT ("state_type" = 'terminal' AND "status" = 'abandoned')) /* check_kind=state_field_consistency logical_columns=state_type,status */
);

CREATE TABLE "workflow_graph_runs" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "state_key" TEXT NOT NULL /* logical_type=text */,
  "state_instance_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_definition_version" TEXT NOT NULL /* logical_type=text */,
  "state_config_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "state_config_hash" TEXT NOT NULL /* logical_type=hash */,
  "registry_snapshot_id" TEXT NOT NULL /* logical_type=identifier */,
  "registry_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "registry_retention_handle_id" TEXT NOT NULL /* logical_type=identifier */,
  "runtime_safety_snapshot_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "runtime_safety_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "runtime_supported_limits_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "runtime_supported_limits_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "sqlite_execution_profile_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "sqlite_execution_profile_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "source_seed_hash" TEXT NOT NULL /* logical_type=hash */,
  "root_scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "root_build_id" TEXT NOT NULL /* logical_type=identifier */,
  "root_plan_hash" TEXT /* logical_type=hash */,
  "manifest_seq" INTEGER NOT NULL /* logical_type=integer */,
  "manifest_head_hash" TEXT NOT NULL /* logical_type=hash */,
  "ledger_seq" INTEGER NOT NULL /* logical_type=integer */,
  "ledger_head_hash" TEXT NOT NULL /* logical_type=hash */,
  "lifecycle" TEXT NOT NULL /* logical_type=text */,
  "control" TEXT NOT NULL /* logical_type=text */,
  "operational_state" TEXT NOT NULL /* logical_type=text */,
  "root_cancel_scope" TEXT /* logical_type=text */,
  "root_close_request_id" TEXT /* logical_type=identifier */,
  "completion_cut_id" TEXT /* logical_type=identifier */,
  "work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "outcome_kind" TEXT /* logical_type=text */,
  "exit_name" TEXT /* logical_type=text */,
  "output_value_id" TEXT /* logical_type=identifier */,
  "output_hash" TEXT /* logical_type=hash */,
  "error_code" TEXT /* logical_type=text */,
  "error_detail_value_id" TEXT /* logical_type=identifier */,
  "error_detail_hash" TEXT /* logical_type=hash */,
  "next_event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "last_admission_seq" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "started_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
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
  CONSTRAINT "ck:workflow_graph_runs:state_config_hash:hash" CHECK (("state_config_hash" IS NULL OR (length("state_config_hash") = 71 AND substr("state_config_hash", 1, 7) = 'sha256:' AND substr("state_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=state_config_hash */,
  CONSTRAINT "ck:workflow_graph_runs:registry_snapshot_hash:hash" CHECK (("registry_snapshot_hash" IS NULL OR (length("registry_snapshot_hash") = 71 AND substr("registry_snapshot_hash", 1, 7) = 'sha256:' AND substr("registry_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=registry_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_runs:runtime_safety_snapshot_hash:hash" CHECK (("runtime_safety_snapshot_hash" IS NULL OR (length("runtime_safety_snapshot_hash") = 71 AND substr("runtime_safety_snapshot_hash", 1, 7) = 'sha256:' AND substr("runtime_safety_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=runtime_safety_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_runs:runtime_supported_limits_resource_hash:hash" CHECK (("runtime_supported_limits_resource_hash" IS NULL OR (length("runtime_supported_limits_resource_hash") = 71 AND substr("runtime_supported_limits_resource_hash", 1, 7) = 'sha256:' AND substr("runtime_supported_limits_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=runtime_supported_limits_resource_hash */,
  CONSTRAINT "ck:workflow_graph_runs:sqlite_execution_profile_resource_hash:hash" CHECK (("sqlite_execution_profile_resource_hash" IS NULL OR (length("sqlite_execution_profile_resource_hash") = 71 AND substr("sqlite_execution_profile_resource_hash", 1, 7) = 'sha256:' AND substr("sqlite_execution_profile_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=sqlite_execution_profile_resource_hash */,
  CONSTRAINT "ck:workflow_graph_runs:source_seed_hash:hash" CHECK (("source_seed_hash" IS NULL OR (length("source_seed_hash") = 71 AND substr("source_seed_hash", 1, 7) = 'sha256:' AND substr("source_seed_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_seed_hash */,
  CONSTRAINT "ck:workflow_graph_runs:root_plan_hash:hash" CHECK (("root_plan_hash" IS NULL OR (length("root_plan_hash") = 71 AND substr("root_plan_hash", 1, 7) = 'sha256:' AND substr("root_plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=root_plan_hash */,
  CONSTRAINT "ck:workflow_graph_runs:manifest_seq:safe_integer" CHECK (("manifest_seq" IS NULL OR "manifest_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=manifest_seq */,
  CONSTRAINT "ck:workflow_graph_runs:manifest_head_hash:hash" CHECK (("manifest_head_hash" IS NULL OR (length("manifest_head_hash") = 71 AND substr("manifest_head_hash", 1, 7) = 'sha256:' AND substr("manifest_head_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=manifest_head_hash */,
  CONSTRAINT "ck:workflow_graph_runs:ledger_seq:safe_integer" CHECK (("ledger_seq" IS NULL OR "ledger_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=ledger_seq */,
  CONSTRAINT "ck:workflow_graph_runs:ledger_head_hash:hash" CHECK (("ledger_head_hash" IS NULL OR (length("ledger_head_hash") = 71 AND substr("ledger_head_hash", 1, 7) = 'sha256:' AND substr("ledger_head_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=ledger_head_hash */,
  CONSTRAINT "ck:workflow_graph_runs:lifecycle:enum" CHECK ("lifecycle" IN ('initializing', 'executing', 'closing', 'closed')) /* check_kind=enum_membership logical_columns=lifecycle */,
  CONSTRAINT "ck:workflow_graph_runs:control:enum" CHECK ("control" IN ('running', 'paused', 'resuming', 'cancelling')) /* check_kind=enum_membership logical_columns=control */,
  CONSTRAINT "ck:workflow_graph_runs:operational_state:enum" CHECK ("operational_state" IN ('healthy', 'action_required', 'quarantined', 'administratively_abandoned')) /* check_kind=enum_membership logical_columns=operational_state */,
  CONSTRAINT "ck:workflow_graph_runs:root_cancel_scope:enum" CHECK ("root_cancel_scope" IN ('local_graph', 'workflow')) /* check_kind=enum_membership logical_columns=root_cancel_scope */,
  CONSTRAINT "ck:workflow_graph_runs:work_fence_epoch:safe_integer" CHECK (("work_fence_epoch" IS NULL OR "work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_runs:outcome_kind:enum" CHECK ("outcome_kind" IN ('completed', 'errored', 'cancelled')) /* check_kind=enum_membership logical_columns=outcome_kind */,
  CONSTRAINT "ck:workflow_graph_runs:output_hash:hash" CHECK (("output_hash" IS NULL OR (length("output_hash") = 71 AND substr("output_hash", 1, 7) = 'sha256:' AND substr("output_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=output_hash */,
  CONSTRAINT "ck:workflow_graph_runs:error_detail_hash:hash" CHECK (("error_detail_hash" IS NULL OR (length("error_detail_hash") = 71 AND substr("error_detail_hash", 1, 7) = 'sha256:' AND substr("error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_runs:next_event_seq:safe_integer" CHECK (("next_event_seq" IS NULL OR "next_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_event_seq */,
  CONSTRAINT "ck:workflow_graph_runs:last_admission_seq:safe_integer" CHECK (("last_admission_seq" IS NULL OR "last_admission_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=last_admission_seq */,
  CONSTRAINT "ck:workflow_graph_runs:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_runs:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=started_at_ms */,
  CONSTRAINT "ck:workflow_graph_runs:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflow_graph_runs:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_runs:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_runs:output_value_id:output_hash:pair" CHECK ((("output_value_id" IS NULL AND "output_hash" IS NULL) OR ("output_value_id" IS NOT NULL AND "output_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=output_value_id,output_hash */,
  CONSTRAINT "ck:workflow_graph_runs:error_detail_value_id:error_detail_hash:pair" CHECK ((("error_detail_value_id" IS NULL AND "error_detail_hash" IS NULL) OR ("error_detail_value_id" IS NOT NULL AND "error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=error_detail_value_id,error_detail_hash */,
  CONSTRAINT "ck:graph_runs:closed_shape" CHECK ((("lifecycle" = 'closed' AND "completion_cut_id" IS NOT NULL AND "outcome_kind" IS NOT NULL AND "finished_at_ms" IS NOT NULL) OR ("lifecycle" <> 'closed' AND "completion_cut_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=lifecycle,completion_cut_id,outcome_kind,finished_at_ms */,
  CONSTRAINT "ck:graph_runs:abandon_shape" CHECK (("operational_state" <> 'administratively_abandoned' OR ("lifecycle" <> 'closed' AND "completion_cut_id" IS NULL AND "outcome_kind" IS NULL))) /* check_kind=state_field_consistency logical_columns=operational_state,lifecycle,completion_cut_id,outcome_kind */,
  CONSTRAINT "ck:graph_runs:outcome_shape" CHECK ((("outcome_kind" = 'completed' AND "exit_name" IS NOT NULL AND "output_value_id" IS NOT NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL AND "root_cancel_scope" IS NULL) OR ("outcome_kind" = 'errored' AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NOT NULL AND "root_cancel_scope" IS NULL) OR ("outcome_kind" = 'cancelled' AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL AND "root_cancel_scope" IS NOT NULL) OR ("outcome_kind" IS NULL AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "error_code" IS NULL AND "error_detail_value_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=outcome_kind,exit_name,output_value_id,error_code,error_detail_value_id,root_cancel_scope */
);

CREATE TABLE "workflow_operational_blockers" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "blocker_kind" TEXT NOT NULL /* logical_type=text */,
  "severity" TEXT NOT NULL /* logical_type=text */,
  "source_effect_operation_id" TEXT /* logical_type=identifier */,
  "source_outbox_id" TEXT /* logical_type=identifier */,
  "source_root_finalization_schedule_id" TEXT /* logical_type=identifier */,
  "source_claim_id" TEXT /* logical_type=identifier */,
  "source_event_seq" INTEGER /* logical_type=integer */,
  "error_code" TEXT NOT NULL /* logical_type=text */,
  "evidence_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "evidence_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "remediation_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "remediation_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "remediation_attempt_count" INTEGER NOT NULL /* logical_type=integer */,
  "next_remediation_at_ms" INTEGER /* logical_type=integer */,
  "remediation_deadline_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "opened_event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "resolved_event_seq" INTEGER /* logical_type=integer */,
  "resolution_command_id" TEXT /* logical_type=identifier */,
  "resolution_value_id" TEXT /* logical_type=identifier */,
  "resolution_hash" TEXT /* logical_type=hash */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "opened_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "resolved_at_ms" INTEGER /* logical_type=integer */,
  "abandoned_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_operational_blockers" PRIMARY KEY ("id"),
  CONSTRAINT "fk:operational_blockers:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:run" FOREIGN KEY ("workflow_id", "graph_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:effect" FOREIGN KEY ("source_effect_operation_id") REFERENCES "workflow_graph_effect_operations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:outbox" FOREIGN KEY ("source_outbox_id") REFERENCES "workflow_outbox" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:finalization" FOREIGN KEY ("source_root_finalization_schedule_id") REFERENCES "workflow_root_finalization_schedules" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:claim" FOREIGN KEY ("source_claim_id") REFERENCES "workflow_domain_resource_claims" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:event" FOREIGN KEY ("graph_run_id", "source_event_seq") REFERENCES "workflow_graph_events" ("graph_run_id", "seq") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:evidence" FOREIGN KEY ("evidence_manifest_value_id", "evidence_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:policy" FOREIGN KEY ("remediation_policy_resource_id", "remediation_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:command" FOREIGN KEY ("resolution_command_id") REFERENCES "workflow_runtime_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:operational_blockers:resolution" FOREIGN KEY ("resolution_value_id", "resolution_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_operational_blockers:blocker_kind:enum" CHECK ("blocker_kind" IN ('effect_unknown', 'compensation_dead_letter', 'root_finalization_exhausted', 'claim_release_failed', 'resource_or_credential_unavailable', 'integrity_quarantine')) /* check_kind=enum_membership logical_columns=blocker_kind */,
  CONSTRAINT "ck:workflow_operational_blockers:severity:enum" CHECK ("severity" IN ('action_required', 'quarantine')) /* check_kind=enum_membership logical_columns=severity */,
  CONSTRAINT "ck:workflow_operational_blockers:source_event_seq:safe_integer" CHECK (("source_event_seq" IS NULL OR "source_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=source_event_seq */,
  CONSTRAINT "ck:workflow_operational_blockers:evidence_manifest_hash:hash" CHECK (("evidence_manifest_hash" IS NULL OR (length("evidence_manifest_hash") = 71 AND substr("evidence_manifest_hash", 1, 7) = 'sha256:' AND substr("evidence_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=evidence_manifest_hash */,
  CONSTRAINT "ck:workflow_operational_blockers:status:enum" CHECK ("status" IN ('open', 'resolved', 'abandoned')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_operational_blockers:remediation_policy_resource_hash:hash" CHECK (("remediation_policy_resource_hash" IS NULL OR (length("remediation_policy_resource_hash") = 71 AND substr("remediation_policy_resource_hash", 1, 7) = 'sha256:' AND substr("remediation_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=remediation_policy_resource_hash */,
  CONSTRAINT "ck:workflow_operational_blockers:remediation_attempt_count:safe_integer" CHECK (("remediation_attempt_count" IS NULL OR "remediation_attempt_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=remediation_attempt_count */,
  CONSTRAINT "ck:workflow_operational_blockers:next_remediation_at_ms:safe_integer" CHECK (("next_remediation_at_ms" IS NULL OR "next_remediation_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_remediation_at_ms */,
  CONSTRAINT "ck:workflow_operational_blockers:remediation_deadline_at_ms:safe_integer" CHECK (("remediation_deadline_at_ms" IS NULL OR "remediation_deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=remediation_deadline_at_ms */,
  CONSTRAINT "ck:workflow_operational_blockers:opened_event_seq:safe_integer" CHECK (("opened_event_seq" IS NULL OR "opened_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=opened_event_seq */,
  CONSTRAINT "ck:workflow_operational_blockers:resolved_event_seq:safe_integer" CHECK (("resolved_event_seq" IS NULL OR "resolved_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolved_event_seq */,
  CONSTRAINT "ck:workflow_operational_blockers:resolution_hash:hash" CHECK (("resolution_hash" IS NULL OR (length("resolution_hash") = 71 AND substr("resolution_hash", 1, 7) = 'sha256:' AND substr("resolution_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=resolution_hash */,
  CONSTRAINT "ck:workflow_operational_blockers:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_operational_blockers:opened_at_ms:safe_integer" CHECK (("opened_at_ms" IS NULL OR "opened_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=opened_at_ms */,
  CONSTRAINT "ck:workflow_operational_blockers:resolved_at_ms:safe_integer" CHECK (("resolved_at_ms" IS NULL OR "resolved_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolved_at_ms */,
  CONSTRAINT "ck:workflow_operational_blockers:abandoned_at_ms:safe_integer" CHECK (("abandoned_at_ms" IS NULL OR "abandoned_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=abandoned_at_ms */,
  CONSTRAINT "ck:workflow_operational_blockers:resolution_value_id:resolution_hash:pair" CHECK ((("resolution_value_id" IS NULL AND "resolution_hash" IS NULL) OR ("resolution_value_id" IS NOT NULL AND "resolution_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=resolution_value_id,resolution_hash */,
  CONSTRAINT "ck:workflow_operational_blockers:resolution_command_id:resolved_event_seq:pair" CHECK ((("resolution_command_id" IS NULL AND "resolved_event_seq" IS NULL) OR ("resolution_command_id" IS NOT NULL AND "resolved_event_seq" IS NOT NULL))) /* check_kind=all_or_none logical_columns=resolution_command_id,resolved_event_seq */,
  CONSTRAINT "ck:workflow_operational_blockers:source_effect_operation_id:source_outbox_id:source_root_finalization_schedule_id:source_claim_id:source_event_seq:exactly_one" CHECK ((("source_effect_operation_id" IS NOT NULL) + ("source_outbox_id" IS NOT NULL) + ("source_root_finalization_schedule_id" IS NOT NULL) + ("source_claim_id" IS NOT NULL) + ("source_event_seq" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=source_effect_operation_id,source_outbox_id,source_root_finalization_schedule_id,source_claim_id,source_event_seq */,
  CONSTRAINT "ck:operational_blockers:resolution_shape" CHECK ((("status" = 'open' AND "resolved_at_ms" IS NULL AND "abandoned_at_ms" IS NULL AND "resolution_command_id" IS NULL AND "resolution_value_id" IS NULL) OR ("status" = 'resolved' AND "resolved_at_ms" IS NOT NULL AND "abandoned_at_ms" IS NULL AND "resolution_command_id" IS NOT NULL) OR ("status" = 'abandoned' AND "resolved_at_ms" IS NULL AND "abandoned_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=status,resolved_at_ms,abandoned_at_ms,resolution_command_id,resolution_value_id */
);

CREATE TABLE "workflow_operational_blocker_remediation_attempts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "blocker_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "attempt_key" TEXT NOT NULL /* logical_type=text */,
  "command_id" TEXT /* logical_type=identifier */,
  "remediation_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "remediation_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "attempt_kind" TEXT NOT NULL /* logical_type=text */,
  "request_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "result" TEXT NOT NULL /* logical_type=text */,
  "result_value_id" TEXT /* logical_type=identifier */,
  "result_hash" TEXT /* logical_type=hash */,
  "error_code" TEXT /* logical_type=text */,
  "next_eligible_at_ms" INTEGER /* logical_type=integer */,
  "started_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_operational_blocker_remediation_attempts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:blocker_attempts:blocker" FOREIGN KEY ("blocker_id") REFERENCES "workflow_operational_blockers" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:blocker_attempts:command" FOREIGN KEY ("command_id") REFERENCES "workflow_runtime_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:blocker_attempts:policy" FOREIGN KEY ("remediation_policy_resource_id", "remediation_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:blocker_attempts:request" FOREIGN KEY ("request_value_id", "request_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:blocker_attempts:result" FOREIGN KEY ("result_value_id", "result_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:attempt_no:safe_integer" CHECK (("attempt_no" IS NULL OR "attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_no */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:remediation_policy_resource_hash:hash" CHECK (("remediation_policy_resource_hash" IS NULL OR (length("remediation_policy_resource_hash") = 71 AND substr("remediation_policy_resource_hash", 1, 7) = 'sha256:' AND substr("remediation_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=remediation_policy_resource_hash */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:attempt_kind:enum" CHECK ("attempt_kind" IN ('reconcile', 'compensate', 'finalization', 'claim_release', 'resource_preflight', 'integrity_restore')) /* check_kind=enum_membership logical_columns=attempt_kind */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:result:enum" CHECK ("result" IN ('retry_wait', 'resolved', 'rejected')) /* check_kind=enum_membership logical_columns=result */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:result_hash:hash" CHECK (("result_hash" IS NULL OR (length("result_hash") = 71 AND substr("result_hash", 1, 7) = 'sha256:' AND substr("result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=result_hash */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:next_eligible_at_ms:safe_integer" CHECK (("next_eligible_at_ms" IS NULL OR "next_eligible_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_eligible_at_ms */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=started_at_ms */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflow_operational_blocker_remediation_attempts:result_value_id:result_hash:pair" CHECK ((("result_value_id" IS NULL AND "result_hash" IS NULL) OR ("result_value_id" IS NOT NULL AND "result_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=result_value_id,result_hash */,
  CONSTRAINT "ck:blocker_attempts:result_shape" CHECK ((("result" = 'retry_wait' AND "result_value_id" IS NULL AND "error_code" IS NOT NULL AND "next_eligible_at_ms" IS NOT NULL) OR ("result" = 'resolved' AND "result_value_id" IS NOT NULL AND "error_code" IS NULL AND "next_eligible_at_ms" IS NULL) OR ("result" = 'rejected' AND "result_value_id" IS NULL AND "error_code" IS NOT NULL AND "next_eligible_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=result,result_value_id,error_code,next_eligible_at_ms */
);

CREATE TABLE "workflow_state_transition_history" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_state_instance_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "completion_cut_id" TEXT NOT NULL /* logical_type=identifier */,
  "target_state_key" TEXT /* logical_type=text */,
  "target_state_instance_id" TEXT /* logical_type=identifier */,
  "target_run_id" TEXT /* logical_type=identifier */,
  "workflow_revision" INTEGER NOT NULL /* logical_type=integer */,
  "context_patch_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_state_transition_history" PRIMARY KEY ("id"),
  CONSTRAINT "fk:transition_history:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:transition_history:source_activation" FOREIGN KEY ("workflow_id", "source_state_instance_id") REFERENCES "workflow_state_activations" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:transition_history:source_run" FOREIGN KEY ("workflow_id", "source_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:transition_history:cut" FOREIGN KEY ("completion_cut_id") REFERENCES "workflow_graph_completion_cuts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:transition_history:target_activation" FOREIGN KEY ("workflow_id", "target_state_instance_id") REFERENCES "workflow_state_activations" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:transition_history:target_run" FOREIGN KEY ("workflow_id", "target_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_state_transition_history:workflow_revision:safe_integer" CHECK (("workflow_revision" IS NULL OR "workflow_revision" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=workflow_revision */,
  CONSTRAINT "ck:workflow_state_transition_history:context_patch_hash:hash" CHECK (("context_patch_hash" IS NULL OR (length("context_patch_hash") = 71 AND substr("context_patch_hash", 1, 7) = 'sha256:' AND substr("context_patch_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=context_patch_hash */,
  CONSTRAINT "ck:workflow_state_transition_history:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:transition_history:target_shape" CHECK ((("target_state_key" IS NULL AND "target_state_instance_id" IS NULL AND "target_run_id" IS NULL) OR ("target_state_key" IS NOT NULL AND "target_state_instance_id" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=target_state_key,target_state_instance_id,target_run_id */
);

CREATE TABLE "workflow_relations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "parent_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "child_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "root_workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_depth" INTEGER NOT NULL /* logical_type=integer */,
  "lineage_budget_account_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_state_instance_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_completion_cut_id" TEXT NOT NULL /* logical_type=identifier */,
  "transition_effect_id" TEXT NOT NULL /* logical_type=text */,
  "relation_kind" TEXT NOT NULL /* logical_type=text */,
  "recipe_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "recipe_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "creation_key" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_relations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:workflow_relations:parent" FOREIGN KEY ("parent_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflow_relations:child" FOREIGN KEY ("child_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflow_relations:root" FOREIGN KEY ("root_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflow_relations:lineage_account" FOREIGN KEY ("lineage_budget_account_id") REFERENCES "workflow_graph_resource_accounts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflow_relations:source_activation" FOREIGN KEY ("source_state_instance_id") REFERENCES "workflow_state_activations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflow_relations:source_run" FOREIGN KEY ("source_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflow_relations:source_cut" FOREIGN KEY ("source_completion_cut_id") REFERENCES "workflow_graph_completion_cuts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:workflow_relations:recipe" FOREIGN KEY ("recipe_resource_id", "recipe_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_relations:workflow_depth:safe_integer" CHECK (("workflow_depth" IS NULL OR "workflow_depth" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=workflow_depth */,
  CONSTRAINT "ck:workflow_relations:recipe_resource_hash:hash" CHECK (("recipe_resource_hash" IS NULL OR (length("recipe_resource_hash") = 71 AND substr("recipe_resource_hash", 1, 7) = 'sha256:' AND substr("recipe_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=recipe_resource_hash */,
  CONSTRAINT "ck:workflow_relations:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_relations:lineage" CHECK (("parent_workflow_id" <> "child_workflow_id" AND "workflow_depth" > 0 AND "root_workflow_id" IS NOT NULL AND "lineage_budget_account_id" IS NOT NULL)) /* check_kind=lineage_consistency logical_columns=parent_workflow_id,child_workflow_id,root_workflow_id,workflow_depth,lineage_budget_account_id */
);

CREATE TABLE "workflow_root_finalization_schedules" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_state_instance_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "root_scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "close_request_id" TEXT NOT NULL /* logical_type=identifier */,
  "transition_effect_id" TEXT NOT NULL /* logical_type=text */,
  "transition_intake_id" TEXT NOT NULL /* logical_type=identifier */,
  "creation_request_id" TEXT NOT NULL /* logical_type=identifier */,
  "effect_type" TEXT NOT NULL /* logical_type=text */,
  "recipe_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "recipe_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "routing_scope_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "routing_scope_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "principal_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=principal_identity_resolver reference_domain=principal immutable=1 */,
  "principal_hash" TEXT NOT NULL /* logical_type=hash */,
  "input_snapshot_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "input_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "creation_domain" TEXT NOT NULL /* logical_type=text */,
  "creation_key" TEXT NOT NULL /* logical_type=text */,
  "creation_intent_hash" TEXT NOT NULL /* logical_type=hash */,
  "finalization_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "finalization_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "attempt_count" INTEGER NOT NULL /* logical_type=integer */,
  "max_attempts" INTEGER NOT NULL /* logical_type=integer */,
  "next_eligible_at_ms" INTEGER /* logical_type=integer */,
  "deadline_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "child_workflow_id" TEXT /* logical_type=identifier */,
  "last_error_code" TEXT /* logical_type=text */,
  "last_error_detail_value_id" TEXT /* logical_type=identifier */,
  "last_error_detail_hash" TEXT /* logical_type=hash */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "completed_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_root_finalization_schedules" PRIMARY KEY ("id"),
  CONSTRAINT "fk:root_finalization_schedules:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:activation" FOREIGN KEY ("workflow_id", "source_state_instance_id") REFERENCES "workflow_state_activations" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:run" FOREIGN KEY ("workflow_id", "source_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:scope" FOREIGN KEY ("source_run_id", "root_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:close" FOREIGN KEY ("source_run_id", "root_scope_id", "close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:intake" FOREIGN KEY ("transition_intake_id") REFERENCES "workflow_task_intakes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:creation_request" FOREIGN KEY ("creation_request_id") REFERENCES "workflow_creation_requests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:recipe" FOREIGN KEY ("recipe_resource_id", "recipe_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:routing_scope" FOREIGN KEY ("routing_scope_resource_id", "routing_scope_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:input" FOREIGN KEY ("input_snapshot_value_id", "input_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:policy" FOREIGN KEY ("finalization_policy_resource_id", "finalization_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:child" FOREIGN KEY ("child_workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_schedules:last_error" FOREIGN KEY ("last_error_detail_value_id", "last_error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_root_finalization_schedules:effect_type:enum" CHECK ("effect_type" IN ('required_child_workflow')) /* check_kind=enum_membership logical_columns=effect_type */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:recipe_resource_hash:hash" CHECK (("recipe_resource_hash" IS NULL OR (length("recipe_resource_hash") = 71 AND substr("recipe_resource_hash", 1, 7) = 'sha256:' AND substr("recipe_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=recipe_resource_hash */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:routing_scope_resource_hash:hash" CHECK (("routing_scope_resource_hash" IS NULL OR (length("routing_scope_resource_hash") = 71 AND substr("routing_scope_resource_hash", 1, 7) = 'sha256:' AND substr("routing_scope_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=routing_scope_resource_hash */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:principal_hash:hash" CHECK (("principal_hash" IS NULL OR (length("principal_hash") = 71 AND substr("principal_hash", 1, 7) = 'sha256:' AND substr("principal_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=principal_hash */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:input_snapshot_hash:hash" CHECK (("input_snapshot_hash" IS NULL OR (length("input_snapshot_hash") = 71 AND substr("input_snapshot_hash", 1, 7) = 'sha256:' AND substr("input_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_snapshot_hash */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:creation_intent_hash:hash" CHECK (("creation_intent_hash" IS NULL OR (length("creation_intent_hash") = 71 AND substr("creation_intent_hash", 1, 7) = 'sha256:' AND substr("creation_intent_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=creation_intent_hash */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:finalization_policy_resource_hash:hash" CHECK (("finalization_policy_resource_hash" IS NULL OR (length("finalization_policy_resource_hash") = 71 AND substr("finalization_policy_resource_hash", 1, 7) = 'sha256:' AND substr("finalization_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=finalization_policy_resource_hash */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:status:enum" CHECK ("status" IN ('pending', 'retry_wait', 'ready', 'succeeded', 'exhausted', 'cancelled')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:attempt_count:safe_integer" CHECK (("attempt_count" IS NULL OR "attempt_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_count */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:max_attempts:safe_integer" CHECK (("max_attempts" IS NULL OR "max_attempts" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=max_attempts */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:next_eligible_at_ms:safe_integer" CHECK (("next_eligible_at_ms" IS NULL OR "next_eligible_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_eligible_at_ms */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:deadline_at_ms:safe_integer" CHECK (("deadline_at_ms" IS NULL OR "deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=deadline_at_ms */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:last_error_detail_hash:hash" CHECK (("last_error_detail_hash" IS NULL OR (length("last_error_detail_hash") = 71 AND substr("last_error_detail_hash", 1, 7) = 'sha256:' AND substr("last_error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=last_error_detail_hash */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:completed_at_ms:safe_integer" CHECK (("completed_at_ms" IS NULL OR "completed_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=completed_at_ms */,
  CONSTRAINT "ck:workflow_root_finalization_schedules:last_error_detail_value_id:last_error_detail_hash:pair" CHECK ((("last_error_detail_value_id" IS NULL AND "last_error_detail_hash" IS NULL) OR ("last_error_detail_value_id" IS NOT NULL AND "last_error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=last_error_detail_value_id,last_error_detail_hash */,
  CONSTRAINT "ck:root_finalization_schedules:attempt_budget" CHECK (("attempt_count" BETWEEN 0 AND "max_attempts" AND "max_attempts" > 0)) /* check_kind=ordered_values logical_columns=attempt_count,max_attempts */,
  CONSTRAINT "ck:root_finalization_schedules:success_shape" CHECK ((("status" = 'succeeded' AND "child_workflow_id" IS NOT NULL AND "completed_at_ms" IS NOT NULL) OR ("status" <> 'succeeded' AND "child_workflow_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,child_workflow_id,completed_at_ms */
);

CREATE TABLE "workflow_root_finalization_attempts" (
  "schedule_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "attempt_key" TEXT NOT NULL /* logical_type=text */,
  "frozen_resolution_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "frozen_resolution_hash" TEXT NOT NULL /* logical_type=hash */,
  "claim_preflight_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "claim_preflight_hash" TEXT NOT NULL /* logical_type=hash */,
  "result" TEXT NOT NULL /* logical_type=text */,
  "error_code" TEXT /* logical_type=text */,
  "error_detail_value_id" TEXT /* logical_type=identifier */,
  "error_detail_hash" TEXT /* logical_type=hash */,
  "started_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_root_finalization_attempts" PRIMARY KEY ("schedule_id", "attempt_no"),
  CONSTRAINT "fk:root_finalization_attempts:schedule" FOREIGN KEY ("schedule_id") REFERENCES "workflow_root_finalization_schedules" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_attempts:resolution" FOREIGN KEY ("frozen_resolution_value_id", "frozen_resolution_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_attempts:claim_preflight" FOREIGN KEY ("claim_preflight_value_id", "claim_preflight_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:root_finalization_attempts:error_detail" FOREIGN KEY ("error_detail_value_id", "error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_root_finalization_attempts:attempt_no:safe_integer" CHECK (("attempt_no" IS NULL OR "attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_no */,
  CONSTRAINT "ck:workflow_root_finalization_attempts:frozen_resolution_hash:hash" CHECK (("frozen_resolution_hash" IS NULL OR (length("frozen_resolution_hash") = 71 AND substr("frozen_resolution_hash", 1, 7) = 'sha256:' AND substr("frozen_resolution_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=frozen_resolution_hash */,
  CONSTRAINT "ck:workflow_root_finalization_attempts:claim_preflight_hash:hash" CHECK (("claim_preflight_hash" IS NULL OR (length("claim_preflight_hash") = 71 AND substr("claim_preflight_hash", 1, 7) = 'sha256:' AND substr("claim_preflight_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=claim_preflight_hash */,
  CONSTRAINT "ck:workflow_root_finalization_attempts:result:enum" CHECK ("result" IN ('ready', 'retryable_conflict', 'permanent_rejection', 'applied')) /* check_kind=enum_membership logical_columns=result */,
  CONSTRAINT "ck:workflow_root_finalization_attempts:error_detail_hash:hash" CHECK (("error_detail_hash" IS NULL OR (length("error_detail_hash") = 71 AND substr("error_detail_hash", 1, 7) = 'sha256:' AND substr("error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=error_detail_hash */,
  CONSTRAINT "ck:workflow_root_finalization_attempts:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=started_at_ms */,
  CONSTRAINT "ck:workflow_root_finalization_attempts:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflow_root_finalization_attempts:error_detail_value_id:error_detail_hash:pair" CHECK ((("error_detail_value_id" IS NULL AND "error_detail_hash" IS NULL) OR ("error_detail_value_id" IS NOT NULL AND "error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=error_detail_value_id,error_detail_hash */,
  CONSTRAINT "ck:root_finalization_attempts:result_shape" CHECK ((("result" IN ('ready', 'applied') AND "error_code" IS NULL AND "error_detail_value_id" IS NULL) OR ("result" IN ('retryable_conflict', 'permanent_rejection') AND "error_code" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=result,error_code,error_detail_value_id */
);

CREATE TABLE "workflow_context_snapshots" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "revision" INTEGER NOT NULL /* logical_type=integer */,
  "contract_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "contract_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "previous_snapshot_id" TEXT /* logical_type=identifier */,
  "previous_snapshot_hash" TEXT /* logical_type=hash */,
  "slots_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "slots_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_context_snapshots" PRIMARY KEY ("id"),
  CONSTRAINT "fk:context_snapshots:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_snapshots:contract" FOREIGN KEY ("contract_resource_id", "contract_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_snapshots:previous" FOREIGN KEY ("workflow_id", "previous_snapshot_id", "previous_snapshot_hash") REFERENCES "workflow_context_snapshots" ("workflow_id", "id", "snapshot_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_snapshots:slots_manifest" FOREIGN KEY ("slots_manifest_value_id", "slots_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_context_snapshots:revision:safe_integer" CHECK (("revision" IS NULL OR "revision" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=revision */,
  CONSTRAINT "ck:workflow_context_snapshots:contract_resource_hash:hash" CHECK (("contract_resource_hash" IS NULL OR (length("contract_resource_hash") = 71 AND substr("contract_resource_hash", 1, 7) = 'sha256:' AND substr("contract_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=contract_resource_hash */,
  CONSTRAINT "ck:workflow_context_snapshots:previous_snapshot_hash:hash" CHECK (("previous_snapshot_hash" IS NULL OR (length("previous_snapshot_hash") = 71 AND substr("previous_snapshot_hash", 1, 7) = 'sha256:' AND substr("previous_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_snapshot_hash */,
  CONSTRAINT "ck:workflow_context_snapshots:slots_manifest_hash:hash" CHECK (("slots_manifest_hash" IS NULL OR (length("slots_manifest_hash") = 71 AND substr("slots_manifest_hash", 1, 7) = 'sha256:' AND substr("slots_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=slots_manifest_hash */,
  CONSTRAINT "ck:workflow_context_snapshots:snapshot_hash:hash" CHECK (("snapshot_hash" IS NULL OR (length("snapshot_hash") = 71 AND substr("snapshot_hash", 1, 7) = 'sha256:' AND substr("snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=snapshot_hash */,
  CONSTRAINT "ck:workflow_context_snapshots:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_context_snapshots:previous_snapshot_id:previous_snapshot_hash:pair" CHECK ((("previous_snapshot_id" IS NULL AND "previous_snapshot_hash" IS NULL) OR ("previous_snapshot_id" IS NOT NULL AND "previous_snapshot_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=previous_snapshot_id,previous_snapshot_hash */
);

CREATE TABLE "workflow_context_slot_values" (
  "snapshot_id" TEXT NOT NULL /* logical_type=identifier */,
  "slot_name" TEXT NOT NULL /* logical_type=text */,
  "value_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "value_hash" TEXT NOT NULL /* logical_type=hash */,
  "schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "schema_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "byte_length" INTEGER NOT NULL /* logical_type=integer */,
  "provenance_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=value_provenance_validator reference_domain=value_provenance immutable=1 */,
  CONSTRAINT "pk:workflow_context_slot_values" PRIMARY KEY ("snapshot_id", "slot_name"),
  CONSTRAINT "fk:context_slots:snapshot" FOREIGN KEY ("snapshot_id") REFERENCES "workflow_context_snapshots" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_slots:value" FOREIGN KEY ("value_value_id", "value_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_slots:schema" FOREIGN KEY ("schema_resource_id", "schema_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_context_slot_values:value_hash:hash" CHECK (("value_hash" IS NULL OR (length("value_hash") = 71 AND substr("value_hash", 1, 7) = 'sha256:' AND substr("value_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=value_hash */,
  CONSTRAINT "ck:workflow_context_slot_values:schema_resource_hash:hash" CHECK (("schema_resource_hash" IS NULL OR (length("schema_resource_hash") = 71 AND substr("schema_resource_hash", 1, 7) = 'sha256:' AND substr("schema_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_resource_hash */,
  CONSTRAINT "ck:workflow_context_slot_values:byte_length:safe_integer" CHECK (("byte_length" IS NULL OR "byte_length" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=byte_length */
);

CREATE TABLE "workflow_context_patches" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "completion_cut_id" TEXT NOT NULL /* logical_type=identifier */,
  "patch_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "patch_hash" TEXT NOT NULL /* logical_type=hash */,
  "operation_count" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_context_patches" PRIMARY KEY ("id"),
  CONSTRAINT "fk:context_patches:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_patches:run" FOREIGN KEY ("workflow_id", "source_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_patches:cut" FOREIGN KEY ("completion_cut_id") REFERENCES "workflow_graph_completion_cuts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_patches:value" FOREIGN KEY ("patch_value_id", "patch_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_context_patches:patch_hash:hash" CHECK (("patch_hash" IS NULL OR (length("patch_hash") = 71 AND substr("patch_hash", 1, 7) = 'sha256:' AND substr("patch_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=patch_hash */,
  CONSTRAINT "ck:workflow_context_patches:operation_count:safe_integer" CHECK (("operation_count" IS NULL OR "operation_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=operation_count */,
  CONSTRAINT "ck:workflow_context_patches:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_context_patch_operations" (
  "patch_id" TEXT NOT NULL /* logical_type=identifier */,
  "operation_index" INTEGER NOT NULL /* logical_type=integer */,
  "operation" TEXT NOT NULL /* logical_type=text */,
  "source_kind" TEXT /* logical_type=text */,
  "source_port" TEXT /* logical_type=text */,
  "source_slot" TEXT /* logical_type=text */,
  "pointer" TEXT /* logical_type=text */,
  "target_slot" TEXT NOT NULL /* logical_type=text */,
  "old_value_hash" TEXT /* logical_type=hash */,
  "new_value_value_id" TEXT /* logical_type=identifier */,
  "new_value_hash" TEXT /* logical_type=hash */,
  "operation_hash" TEXT NOT NULL /* logical_type=hash */,
  CONSTRAINT "pk:workflow_context_patch_operations" PRIMARY KEY ("patch_id", "operation_index"),
  CONSTRAINT "fk:context_patch_operations:patch" FOREIGN KEY ("patch_id") REFERENCES "workflow_context_patches" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:context_patch_operations:new_value" FOREIGN KEY ("new_value_value_id", "new_value_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_context_patch_operations:operation_index:safe_integer" CHECK (("operation_index" IS NULL OR "operation_index" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=operation_index */,
  CONSTRAINT "ck:workflow_context_patch_operations:operation:enum" CHECK ("operation" IN ('set', 'clear')) /* check_kind=enum_membership logical_columns=operation */,
  CONSTRAINT "ck:workflow_context_patch_operations:old_value_hash:hash" CHECK (("old_value_hash" IS NULL OR (length("old_value_hash") = 71 AND substr("old_value_hash", 1, 7) = 'sha256:' AND substr("old_value_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=old_value_hash */,
  CONSTRAINT "ck:workflow_context_patch_operations:new_value_hash:hash" CHECK (("new_value_hash" IS NULL OR (length("new_value_hash") = 71 AND substr("new_value_hash", 1, 7) = 'sha256:' AND substr("new_value_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=new_value_hash */,
  CONSTRAINT "ck:workflow_context_patch_operations:operation_hash:hash" CHECK (("operation_hash" IS NULL OR (length("operation_hash") = 71 AND substr("operation_hash", 1, 7) = 'sha256:' AND substr("operation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=operation_hash */,
  CONSTRAINT "ck:workflow_context_patch_operations:new_value_value_id:new_value_hash:pair" CHECK ((("new_value_value_id" IS NULL AND "new_value_hash" IS NULL) OR ("new_value_value_id" IS NOT NULL AND "new_value_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=new_value_value_id,new_value_hash */,
  CONSTRAINT "ck:context_patch_operations:operation_shape" CHECK ((("operation" = 'clear' AND "source_kind" IS NULL AND "source_port" IS NULL AND "source_slot" IS NULL AND "pointer" IS NULL AND "new_value_value_id" IS NULL) OR ("operation" = 'set' AND "source_kind" IS NOT NULL AND (("source_port" IS NOT NULL) + ("source_slot" IS NOT NULL) <= 1) AND "new_value_value_id" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=operation,source_kind,source_port,source_slot,pointer,new_value_value_id */
);

CREATE TABLE "workflow_graph_scope_plans" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "plan_hash" TEXT NOT NULL /* logical_type=hash */,
  "format" TEXT NOT NULL /* logical_type=text */,
  "compiler_version" TEXT NOT NULL /* logical_type=text */,
  "source_json" TEXT /* logical_type=canonical_json */,
  "source_value_id" TEXT /* logical_type=identifier */,
  "source_hash" TEXT /* logical_type=hash */,
  "compiled_plan_json" TEXT /* logical_type=canonical_json */,
  "compiled_plan_value_id" TEXT /* logical_type=identifier */,
  "interface_snapshot_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "interface_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "policy_snapshot_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "policy_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "capability_catalog_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_scope_plans" PRIMARY KEY ("id"),
  CONSTRAINT "fk:scope_plans:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_plans:source" FOREIGN KEY ("source_value_id", "source_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_plans:compiled_plan" FOREIGN KEY ("compiled_plan_value_id", "plan_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_scope_plans:plan_hash:hash" CHECK (("plan_hash" IS NULL OR (length("plan_hash") = 71 AND substr("plan_hash", 1, 7) = 'sha256:' AND substr("plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=plan_hash */,
  CONSTRAINT "ck:workflow_graph_scope_plans:source_hash:hash" CHECK (("source_hash" IS NULL OR (length("source_hash") = 71 AND substr("source_hash", 1, 7) = 'sha256:' AND substr("source_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_hash */,
  CONSTRAINT "ck:workflow_graph_scope_plans:interface_snapshot_hash:hash" CHECK (("interface_snapshot_hash" IS NULL OR (length("interface_snapshot_hash") = 71 AND substr("interface_snapshot_hash", 1, 7) = 'sha256:' AND substr("interface_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=interface_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scope_plans:policy_snapshot_hash:hash" CHECK (("policy_snapshot_hash" IS NULL OR (length("policy_snapshot_hash") = 71 AND substr("policy_snapshot_hash", 1, 7) = 'sha256:' AND substr("policy_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=policy_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scope_plans:capability_catalog_hash:hash" CHECK (("capability_catalog_hash" IS NULL OR (length("capability_catalog_hash") = 71 AND substr("capability_catalog_hash", 1, 7) = 'sha256:' AND substr("capability_catalog_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=capability_catalog_hash */,
  CONSTRAINT "ck:workflow_graph_scope_plans:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_scope_plans:source_json:source_value_id:at_most_one" CHECK ((("source_json" IS NOT NULL) + ("source_value_id" IS NOT NULL)) <= 1) /* check_kind=at_most_one logical_columns=source_json,source_value_id */,
  CONSTRAINT "ck:workflow_graph_scope_plans:compiled_plan_json:compiled_plan_value_id:at_most_one" CHECK ((("compiled_plan_json" IS NOT NULL) + ("compiled_plan_value_id" IS NOT NULL)) <= 1) /* check_kind=at_most_one logical_columns=compiled_plan_json,compiled_plan_value_id */
);

CREATE TABLE "workflow_graph_scopes" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "parent_scope_id" TEXT /* logical_type=identifier */,
  "owner_node_id" TEXT /* logical_type=identifier */,
  "child_key" TEXT /* logical_type=text */,
  "scope_kind" TEXT NOT NULL /* logical_type=text */,
  "depth" INTEGER NOT NULL /* logical_type=integer */,
  "plan_id" TEXT /* logical_type=identifier */,
  "plan_hash" TEXT /* logical_type=hash */,
  "input_snapshot_json" TEXT /* logical_type=canonical_json */,
  "input_snapshot_value_id" TEXT /* logical_type=identifier */,
  "input_snapshot_hash" TEXT /* logical_type=hash */,
  "materialization_reservation_group_id" TEXT /* logical_type=identifier */,
  "owner_run_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "owner_scope_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "lifecycle" TEXT NOT NULL /* logical_type=text */,
  "work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "outcome_kind" TEXT /* logical_type=text */,
  "exit_name" TEXT /* logical_type=text */,
  "candidate_node_id" TEXT /* logical_type=identifier */,
  "output_value_id" TEXT /* logical_type=identifier */,
  "output_hash" TEXT /* logical_type=hash */,
  "error_code" TEXT /* logical_type=text */,
  "error_detail_value_id" TEXT /* logical_type=identifier */,
  "error_detail_hash" TEXT /* logical_type=hash */,
  "close_request_id" TEXT /* logical_type=identifier */,
  "completion_cut_id" TEXT /* logical_type=identifier */,
  "next_resolution_seq" INTEGER NOT NULL /* logical_type=integer */,
  "next_candidate_seq" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_scopes" PRIMARY KEY ("id"),
  CONSTRAINT "fk:scopes:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:parent" FOREIGN KEY ("graph_run_id", "parent_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:owner_node" FOREIGN KEY ("graph_run_id", "parent_scope_id", "owner_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:plan" FOREIGN KEY ("plan_id", "graph_run_id", "plan_hash") REFERENCES "workflow_graph_scope_plans" ("id", "graph_run_id", "plan_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:input" FOREIGN KEY ("input_snapshot_value_id", "input_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:candidate_node" FOREIGN KEY ("graph_run_id", "id", "candidate_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:output" FOREIGN KEY ("output_value_id", "output_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:error_detail" FOREIGN KEY ("error_detail_value_id", "error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:close_request" FOREIGN KEY ("graph_run_id", "id", "close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scopes:completion_cut" FOREIGN KEY ("graph_run_id", "id", "completion_cut_id") REFERENCES "workflow_graph_completion_cuts" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_scopes:scope_kind:enum" CHECK ("scope_kind" IN ('root', 'subgraph', 'expansion', 'map_item')) /* check_kind=enum_membership logical_columns=scope_kind */,
  CONSTRAINT "ck:workflow_graph_scopes:depth:safe_integer" CHECK (("depth" IS NULL OR "depth" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=depth */,
  CONSTRAINT "ck:workflow_graph_scopes:plan_hash:hash" CHECK (("plan_hash" IS NULL OR (length("plan_hash") = 71 AND substr("plan_hash", 1, 7) = 'sha256:' AND substr("plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=plan_hash */,
  CONSTRAINT "ck:workflow_graph_scopes:input_snapshot_hash:hash" CHECK (("input_snapshot_hash" IS NULL OR (length("input_snapshot_hash") = 71 AND substr("input_snapshot_hash", 1, 7) = 'sha256:' AND substr("input_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scopes:owner_run_work_fence_epoch:safe_integer" CHECK (("owner_run_work_fence_epoch" IS NULL OR "owner_run_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=owner_run_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_scopes:owner_scope_work_fence_epoch:safe_integer" CHECK (("owner_scope_work_fence_epoch" IS NULL OR "owner_scope_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=owner_scope_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_scopes:lifecycle:enum" CHECK ("lifecycle" IN ('materializing', 'active', 'closing', 'closed')) /* check_kind=enum_membership logical_columns=lifecycle */,
  CONSTRAINT "ck:workflow_graph_scopes:work_fence_epoch:safe_integer" CHECK (("work_fence_epoch" IS NULL OR "work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_scopes:outcome_kind:enum" CHECK ("outcome_kind" IN ('completed', 'errored', 'cancelled')) /* check_kind=enum_membership logical_columns=outcome_kind */,
  CONSTRAINT "ck:workflow_graph_scopes:output_hash:hash" CHECK (("output_hash" IS NULL OR (length("output_hash") = 71 AND substr("output_hash", 1, 7) = 'sha256:' AND substr("output_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=output_hash */,
  CONSTRAINT "ck:workflow_graph_scopes:error_detail_hash:hash" CHECK (("error_detail_hash" IS NULL OR (length("error_detail_hash") = 71 AND substr("error_detail_hash", 1, 7) = 'sha256:' AND substr("error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_scopes:next_resolution_seq:safe_integer" CHECK (("next_resolution_seq" IS NULL OR "next_resolution_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_resolution_seq */,
  CONSTRAINT "ck:workflow_graph_scopes:next_candidate_seq:safe_integer" CHECK (("next_candidate_seq" IS NULL OR "next_candidate_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_candidate_seq */,
  CONSTRAINT "ck:workflow_graph_scopes:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_scopes:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_scopes:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflow_graph_scopes:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_scopes:plan_id:plan_hash:pair" CHECK ((("plan_id" IS NULL AND "plan_hash" IS NULL) OR ("plan_id" IS NOT NULL AND "plan_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=plan_id,plan_hash */,
  CONSTRAINT "ck:workflow_graph_scopes:input_snapshot_value_id:input_snapshot_hash:pair" CHECK ((("input_snapshot_value_id" IS NULL AND "input_snapshot_hash" IS NULL) OR ("input_snapshot_value_id" IS NOT NULL AND "input_snapshot_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=input_snapshot_value_id,input_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scopes:output_value_id:output_hash:pair" CHECK ((("output_value_id" IS NULL AND "output_hash" IS NULL) OR ("output_value_id" IS NOT NULL AND "output_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=output_value_id,output_hash */,
  CONSTRAINT "ck:workflow_graph_scopes:error_detail_value_id:error_detail_hash:pair" CHECK ((("error_detail_value_id" IS NULL AND "error_detail_hash" IS NULL) OR ("error_detail_value_id" IS NOT NULL AND "error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=error_detail_value_id,error_detail_hash */,
  CONSTRAINT "ck:scopes:nullable_plan" CHECK (("plan_id" IS NOT NULL OR ("scope_kind" = 'root' AND "parent_scope_id" IS NULL AND "lifecycle" IN ('materializing', 'closing', 'closed')))) /* check_kind=state_field_consistency logical_columns=scope_kind,parent_scope_id,plan_id,lifecycle */,
  CONSTRAINT "ck:scopes:root_ownership" CHECK ((("scope_kind" = 'root' AND "parent_scope_id" IS NULL AND "owner_node_id" IS NULL AND "child_key" IS NULL AND "depth" = 0) OR ("scope_kind" <> 'root' AND "parent_scope_id" IS NOT NULL AND "owner_node_id" IS NOT NULL AND "child_key" IS NOT NULL AND "depth" > 0))) /* check_kind=state_field_consistency logical_columns=scope_kind,parent_scope_id,owner_node_id,child_key,depth */,
  CONSTRAINT "ck:scopes:closed_shape" CHECK ((("lifecycle" = 'closed' AND "close_request_id" IS NOT NULL AND "completion_cut_id" IS NOT NULL AND "outcome_kind" IS NOT NULL AND "finished_at_ms" IS NOT NULL) OR ("lifecycle" <> 'closed' AND "completion_cut_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=lifecycle,close_request_id,completion_cut_id,outcome_kind,finished_at_ms */
);

CREATE TABLE "workflow_graph_run_manifest" (
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "manifest_seq" INTEGER NOT NULL /* logical_type=integer */,
  "entry_kind" TEXT NOT NULL /* logical_type=text */,
  "scope_id" TEXT /* logical_type=identifier */,
  "expansion_manifest_id" TEXT /* logical_type=identifier */,
  "parent_scope_id" TEXT /* logical_type=identifier */,
  "owner_node_id" TEXT /* logical_type=identifier */,
  "child_key" TEXT /* logical_type=text */,
  "scope_kind" TEXT /* logical_type=text */,
  "source_hash" TEXT /* logical_type=hash */,
  "plan_hash" TEXT /* logical_type=hash */,
  "interface_hash" TEXT /* logical_type=hash */,
  "input_hash" TEXT /* logical_type=hash */,
  "policy_hash" TEXT /* logical_type=hash */,
  "expansion_hash" TEXT /* logical_type=hash */,
  "item_count" INTEGER /* logical_type=integer */,
  "previous_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_run_manifest" PRIMARY KEY ("graph_run_id", "manifest_seq"),
  CONSTRAINT "fk:run_manifest:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:run_manifest:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:run_manifest:expansion" FOREIGN KEY ("expansion_manifest_id") REFERENCES "workflow_graph_expansion_manifests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:run_manifest:parent_scope" FOREIGN KEY ("graph_run_id", "parent_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:run_manifest:owner_node" FOREIGN KEY ("graph_run_id", "parent_scope_id", "owner_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_run_manifest:manifest_seq:safe_integer" CHECK (("manifest_seq" IS NULL OR "manifest_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=manifest_seq */,
  CONSTRAINT "ck:workflow_graph_run_manifest:entry_kind:enum" CHECK ("entry_kind" IN ('scope_materialized', 'expansion_sealed')) /* check_kind=enum_membership logical_columns=entry_kind */,
  CONSTRAINT "ck:workflow_graph_run_manifest:scope_kind:enum" CHECK ("scope_kind" IN ('root', 'subgraph', 'expansion', 'map_item')) /* check_kind=enum_membership logical_columns=scope_kind */,
  CONSTRAINT "ck:workflow_graph_run_manifest:source_hash:hash" CHECK (("source_hash" IS NULL OR (length("source_hash") = 71 AND substr("source_hash", 1, 7) = 'sha256:' AND substr("source_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:plan_hash:hash" CHECK (("plan_hash" IS NULL OR (length("plan_hash") = 71 AND substr("plan_hash", 1, 7) = 'sha256:' AND substr("plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=plan_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:interface_hash:hash" CHECK (("interface_hash" IS NULL OR (length("interface_hash") = 71 AND substr("interface_hash", 1, 7) = 'sha256:' AND substr("interface_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=interface_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:input_hash:hash" CHECK (("input_hash" IS NULL OR (length("input_hash") = 71 AND substr("input_hash", 1, 7) = 'sha256:' AND substr("input_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:policy_hash:hash" CHECK (("policy_hash" IS NULL OR (length("policy_hash") = 71 AND substr("policy_hash", 1, 7) = 'sha256:' AND substr("policy_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=policy_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:expansion_hash:hash" CHECK (("expansion_hash" IS NULL OR (length("expansion_hash") = 71 AND substr("expansion_hash", 1, 7) = 'sha256:' AND substr("expansion_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=expansion_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:item_count:safe_integer" CHECK (("item_count" IS NULL OR "item_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=item_count */,
  CONSTRAINT "ck:workflow_graph_run_manifest:previous_manifest_hash:hash" CHECK (("previous_manifest_hash" IS NULL OR (length("previous_manifest_hash") = 71 AND substr("previous_manifest_hash", 1, 7) = 'sha256:' AND substr("previous_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_manifest_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:manifest_hash:hash" CHECK (("manifest_hash" IS NULL OR (length("manifest_hash") = 71 AND substr("manifest_hash", 1, 7) = 'sha256:' AND substr("manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=manifest_hash */,
  CONSTRAINT "ck:workflow_graph_run_manifest:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:run_manifest:entry_shape" CHECK ((("entry_kind" = 'scope_materialized' AND "scope_id" IS NOT NULL AND "expansion_manifest_id" IS NULL AND "source_hash" IS NOT NULL AND "plan_hash" IS NOT NULL AND "expansion_hash" IS NULL AND "item_count" IS NULL) OR ("entry_kind" = 'expansion_sealed' AND "scope_id" IS NULL AND "expansion_manifest_id" IS NOT NULL AND "source_hash" IS NULL AND "plan_hash" IS NULL AND "expansion_hash" IS NOT NULL AND "item_count" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=entry_kind,scope_id,expansion_manifest_id,source_hash,plan_hash,expansion_hash,item_count */
);

CREATE TABLE "workflow_graph_scope_builds" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "owner_scope_id" TEXT /* logical_type=identifier */,
  "owner_node_id" TEXT /* logical_type=identifier */,
  "target_scope_id" TEXT /* logical_type=identifier */,
  "invocation_key" TEXT NOT NULL /* logical_type=text */,
  "scope_kind" TEXT NOT NULL /* logical_type=text */,
  "item_key_json" TEXT /* logical_type=canonical_json */,
  "item_index" INTEGER /* logical_type=integer */,
  "source_seed_json" TEXT /* logical_type=canonical_json */,
  "source_seed_value_id" TEXT /* logical_type=identifier */,
  "source_seed_hash" TEXT /* logical_type=hash */,
  "source_snapshot_json" TEXT /* logical_type=canonical_json */,
  "source_snapshot_value_id" TEXT /* logical_type=identifier */,
  "source_snapshot_hash" TEXT /* logical_type=hash */,
  "input_snapshot_json" TEXT /* logical_type=canonical_json */,
  "input_snapshot_value_id" TEXT /* logical_type=identifier */,
  "input_snapshot_hash" TEXT /* logical_type=hash */,
  "compiler_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "run_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "owner_scope_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "compiled_plan_id" TEXT /* logical_type=identifier */,
  "compiled_plan_hash" TEXT /* logical_type=hash */,
  "scope_id" TEXT /* logical_type=identifier */,
  "materialization_reservation_group_id" TEXT /* logical_type=identifier */,
  "attempt_count" INTEGER NOT NULL /* logical_type=integer */,
  "next_attempt_at_ms" INTEGER /* logical_type=integer */,
  "deadline_at_ms" INTEGER /* logical_type=integer */,
  "lease_owner" TEXT /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "lease_token" TEXT /* logical_type=text */,
  "lease_expires_at_ms" INTEGER /* logical_type=integer */,
  "error_code" TEXT /* logical_type=text */,
  "error_detail_value_id" TEXT /* logical_type=identifier */,
  "error_detail_hash" TEXT /* logical_type=hash */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_scope_builds" PRIMARY KEY ("id"),
  CONSTRAINT "fk:scope_builds:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:owner_scope" FOREIGN KEY ("graph_run_id", "owner_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:owner_node" FOREIGN KEY ("graph_run_id", "owner_scope_id", "owner_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:target_scope" FOREIGN KEY ("graph_run_id", "target_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:source_seed" FOREIGN KEY ("source_seed_value_id", "source_seed_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:source_snapshot" FOREIGN KEY ("source_snapshot_value_id", "source_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:input_snapshot" FOREIGN KEY ("input_snapshot_value_id", "input_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:plan" FOREIGN KEY ("compiled_plan_id", "graph_run_id", "compiled_plan_hash") REFERENCES "workflow_graph_scope_plans" ("id", "graph_run_id", "plan_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:scope_builds:error_detail" FOREIGN KEY ("error_detail_value_id", "error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_scope_builds:scope_kind:enum" CHECK ("scope_kind" IN ('root', 'subgraph', 'expansion', 'map_item')) /* check_kind=enum_membership logical_columns=scope_kind */,
  CONSTRAINT "ck:workflow_graph_scope_builds:item_index:safe_integer" CHECK (("item_index" IS NULL OR "item_index" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=item_index */,
  CONSTRAINT "ck:workflow_graph_scope_builds:source_seed_hash:hash" CHECK (("source_seed_hash" IS NULL OR (length("source_seed_hash") = 71 AND substr("source_seed_hash", 1, 7) = 'sha256:' AND substr("source_seed_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_seed_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:source_snapshot_hash:hash" CHECK (("source_snapshot_hash" IS NULL OR (length("source_snapshot_hash") = 71 AND substr("source_snapshot_hash", 1, 7) = 'sha256:' AND substr("source_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:input_snapshot_hash:hash" CHECK (("input_snapshot_hash" IS NULL OR (length("input_snapshot_hash") = 71 AND substr("input_snapshot_hash", 1, 7) = 'sha256:' AND substr("input_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:compiler_snapshot_hash:hash" CHECK (("compiler_snapshot_hash" IS NULL OR (length("compiler_snapshot_hash") = 71 AND substr("compiler_snapshot_hash", 1, 7) = 'sha256:' AND substr("compiler_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=compiler_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:run_work_fence_epoch:safe_integer" CHECK (("run_work_fence_epoch" IS NULL OR "run_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=run_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_scope_builds:owner_scope_work_fence_epoch:safe_integer" CHECK (("owner_scope_work_fence_epoch" IS NULL OR "owner_scope_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=owner_scope_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_scope_builds:status:enum" CHECK ("status" IN ('pending_snapshot', 'ready_to_compile', 'compiling', 'compiled', 'materialized', 'failed', 'fenced')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_graph_scope_builds:compiled_plan_hash:hash" CHECK (("compiled_plan_hash" IS NULL OR (length("compiled_plan_hash") = 71 AND substr("compiled_plan_hash", 1, 7) = 'sha256:' AND substr("compiled_plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=compiled_plan_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:attempt_count:safe_integer" CHECK (("attempt_count" IS NULL OR "attempt_count" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_count */,
  CONSTRAINT "ck:workflow_graph_scope_builds:next_attempt_at_ms:safe_integer" CHECK (("next_attempt_at_ms" IS NULL OR "next_attempt_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_attempt_at_ms */,
  CONSTRAINT "ck:workflow_graph_scope_builds:deadline_at_ms:safe_integer" CHECK (("deadline_at_ms" IS NULL OR "deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=deadline_at_ms */,
  CONSTRAINT "ck:workflow_graph_scope_builds:lease_expires_at_ms:safe_integer" CHECK (("lease_expires_at_ms" IS NULL OR "lease_expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_graph_scope_builds:error_detail_hash:hash" CHECK (("error_detail_hash" IS NULL OR (length("error_detail_hash") = 71 AND substr("error_detail_hash", 1, 7) = 'sha256:' AND substr("error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_scope_builds:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_scope_builds:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_scope_builds:compiled_plan_id:compiled_plan_hash:pair" CHECK ((("compiled_plan_id" IS NULL AND "compiled_plan_hash" IS NULL) OR ("compiled_plan_id" IS NOT NULL AND "compiled_plan_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=compiled_plan_id,compiled_plan_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:error_detail_value_id:error_detail_hash:pair" CHECK ((("error_detail_value_id" IS NULL AND "error_detail_hash" IS NULL) OR ("error_detail_value_id" IS NOT NULL AND "error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=error_detail_value_id,error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_scope_builds:lease_owner:lease_token:pair" CHECK ((("lease_owner" IS NULL AND "lease_token" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_token */,
  CONSTRAINT "ck:workflow_graph_scope_builds:lease_owner:lease_expires_at_ms:pair" CHECK ((("lease_owner" IS NULL AND "lease_expires_at_ms" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_expires_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_expires_at_ms */,
  CONSTRAINT "ck:scope_builds:source_shapes" CHECK ((("source_seed_json" IS NOT NULL) + ("source_seed_value_id" IS NOT NULL) <= 1) AND (("source_snapshot_json" IS NOT NULL) + ("source_snapshot_value_id" IS NOT NULL) <= 1) AND (("input_snapshot_json" IS NOT NULL) + ("input_snapshot_value_id" IS NOT NULL) <= 1)) /* check_kind=at_most_one logical_columns=source_seed_json,source_seed_value_id,source_snapshot_json,source_snapshot_value_id,input_snapshot_json,input_snapshot_value_id */,
  CONSTRAINT "ck:scope_builds:status_shape" CHECK ((("status" IN ('pending_snapshot', 'ready_to_compile', 'compiling') AND "compiled_plan_id" IS NULL AND "scope_id" IS NULL AND "error_code" IS NULL) OR ("status" = 'compiled' AND "compiled_plan_id" IS NOT NULL AND "scope_id" IS NULL AND "error_code" IS NULL) OR ("status" = 'materialized' AND "compiled_plan_id" IS NOT NULL AND "scope_id" IS NOT NULL AND "error_code" IS NULL) OR ("status" = 'failed' AND "scope_id" IS NULL AND "error_code" IS NOT NULL) OR ("status" = 'fenced' AND "scope_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,compiled_plan_id,scope_id,error_code */
);

CREATE TABLE "workflow_graph_expansion_manifests" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "owner_node_id" TEXT NOT NULL /* logical_type=identifier */,
  "producer_attempt_id" TEXT /* logical_type=identifier */,
  "mode" TEXT NOT NULL /* logical_type=text */,
  "source_artifact_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_artifact_hash" TEXT NOT NULL /* logical_type=hash */,
  "manifest_json" TEXT /* logical_type=canonical_json */,
  "manifest_value_id" TEXT /* logical_type=identifier */,
  "manifest_hash" TEXT /* logical_type=hash */,
  "item_count" INTEGER NOT NULL /* logical_type=integer */,
  "child_completion_policy_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "child_completion_policy_hash" TEXT NOT NULL /* logical_type=hash */,
  "sealed_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_expansion_manifests" PRIMARY KEY ("id"),
  CONSTRAINT "fk:expansion_manifests:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:expansion_manifests:owner" FOREIGN KEY ("graph_run_id", "scope_id", "owner_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:expansion_manifests:producer_attempt" FOREIGN KEY ("producer_attempt_id") REFERENCES "workflow_graph_node_attempts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:expansion_manifests:source_artifact" FOREIGN KEY ("source_artifact_value_id", "source_artifact_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:expansion_manifests:manifest" FOREIGN KEY ("manifest_value_id", "manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:mode:enum" CHECK ("mode" IN ('subgraph', 'expand', 'map')) /* check_kind=enum_membership logical_columns=mode */,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:source_artifact_hash:hash" CHECK (("source_artifact_hash" IS NULL OR (length("source_artifact_hash") = 71 AND substr("source_artifact_hash", 1, 7) = 'sha256:' AND substr("source_artifact_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_artifact_hash */,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:manifest_hash:hash" CHECK (("manifest_hash" IS NULL OR (length("manifest_hash") = 71 AND substr("manifest_hash", 1, 7) = 'sha256:' AND substr("manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=manifest_hash */,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:item_count:safe_integer" CHECK (("item_count" IS NULL OR "item_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=item_count */,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:child_completion_policy_hash:hash" CHECK (("child_completion_policy_hash" IS NULL OR (length("child_completion_policy_hash") = 71 AND substr("child_completion_policy_hash", 1, 7) = 'sha256:' AND substr("child_completion_policy_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=child_completion_policy_hash */,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:sealed_at_ms:safe_integer" CHECK (("sealed_at_ms" IS NULL OR "sealed_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=sealed_at_ms */,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_expansion_manifests:manifest_json:manifest_value_id:at_most_one" CHECK ((("manifest_json" IS NOT NULL) + ("manifest_value_id" IS NOT NULL)) <= 1) /* check_kind=at_most_one logical_columns=manifest_json,manifest_value_id */
);

CREATE TABLE "workflow_graph_map_item_results" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "owner_scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "owner_node_id" TEXT NOT NULL /* logical_type=identifier */,
  "expansion_manifest_id" TEXT NOT NULL /* logical_type=identifier */,
  "item_index" INTEGER NOT NULL /* logical_type=integer */,
  "item_key_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "item_key_hash" TEXT NOT NULL /* logical_type=hash */,
  "build_id" TEXT /* logical_type=identifier */,
  "scope_id" TEXT /* logical_type=identifier */,
  "outcome_state" TEXT NOT NULL /* logical_type=text */,
  "exit_name" TEXT /* logical_type=text */,
  "error_code" TEXT /* logical_type=text */,
  "reason" TEXT /* logical_type=text */,
  "output_value_id" TEXT /* logical_type=identifier */,
  "output_hash" TEXT /* logical_type=hash */,
  "completion_seq" INTEGER /* logical_type=integer */,
  "fence_event_seq" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "resolved_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_map_item_results" PRIMARY KEY ("id"),
  CONSTRAINT "fk:map_item_results:owner_scope" FOREIGN KEY ("graph_run_id", "owner_scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:map_item_results:owner_node" FOREIGN KEY ("graph_run_id", "owner_scope_id", "owner_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:map_item_results:expansion" FOREIGN KEY ("expansion_manifest_id") REFERENCES "workflow_graph_expansion_manifests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:map_item_results:build" FOREIGN KEY ("graph_run_id", "build_id") REFERENCES "workflow_graph_scope_builds" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:map_item_results:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:map_item_results:output" FOREIGN KEY ("output_value_id", "output_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_map_item_results:item_index:safe_integer" CHECK (("item_index" IS NULL OR "item_index" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=item_index */,
  CONSTRAINT "ck:workflow_graph_map_item_results:item_key_hash:hash" CHECK (("item_key_hash" IS NULL OR (length("item_key_hash") = 71 AND substr("item_key_hash", 1, 7) = 'sha256:' AND substr("item_key_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=item_key_hash */,
  CONSTRAINT "ck:workflow_graph_map_item_results:outcome_state:enum" CHECK ("outcome_state" IN ('open', 'completed', 'errored', 'cancelled', 'fenced')) /* check_kind=enum_membership logical_columns=outcome_state */,
  CONSTRAINT "ck:workflow_graph_map_item_results:output_hash:hash" CHECK (("output_hash" IS NULL OR (length("output_hash") = 71 AND substr("output_hash", 1, 7) = 'sha256:' AND substr("output_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=output_hash */,
  CONSTRAINT "ck:workflow_graph_map_item_results:completion_seq:safe_integer" CHECK (("completion_seq" IS NULL OR "completion_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=completion_seq */,
  CONSTRAINT "ck:workflow_graph_map_item_results:fence_event_seq:safe_integer" CHECK (("fence_event_seq" IS NULL OR "fence_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=fence_event_seq */,
  CONSTRAINT "ck:workflow_graph_map_item_results:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_map_item_results:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_map_item_results:resolved_at_ms:safe_integer" CHECK (("resolved_at_ms" IS NULL OR "resolved_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolved_at_ms */,
  CONSTRAINT "ck:map_item_results:outcome_shape" CHECK ((("outcome_state" = 'open' AND "exit_name" IS NULL AND "error_code" IS NULL AND "reason" IS NULL AND "output_value_id" IS NULL AND "completion_seq" IS NULL AND "fence_event_seq" IS NULL AND "resolved_at_ms" IS NULL) OR ("outcome_state" = 'completed' AND "scope_id" IS NOT NULL AND "exit_name" IS NOT NULL AND "output_value_id" IS NOT NULL AND "completion_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("outcome_state" = 'errored' AND "error_code" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("outcome_state" = 'cancelled' AND "scope_id" IS NOT NULL AND "reason" IS NOT NULL AND "completion_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("outcome_state" = 'fenced' AND "reason" IS NOT NULL AND "fence_event_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=outcome_state,scope_id,exit_name,error_code,reason,output_value_id,completion_seq,fence_event_seq,resolved_at_ms */
);

CREATE TABLE "workflow_graph_nodes" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "node_key" TEXT NOT NULL /* logical_type=text */,
  "node_type" TEXT NOT NULL /* logical_type=text */,
  "capability_resource_id" TEXT /* logical_type=identifier */,
  "capability_version" TEXT /* logical_type=text */,
  "capability_hash" TEXT /* logical_type=hash */,
  "normalized_node_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "phase" TEXT NOT NULL /* logical_type=text */,
  "trigger_state" TEXT NOT NULL /* logical_type=text */,
  "input_state" TEXT NOT NULL /* logical_type=text */,
  "trigger_cut_json" TEXT /* logical_type=canonical_json */,
  "trigger_cut_hash" TEXT /* logical_type=hash */,
  "input_snapshot_json" TEXT /* logical_type=canonical_json */,
  "input_snapshot_value_id" TEXT /* logical_type=identifier */,
  "input_snapshot_hash" TEXT /* logical_type=hash */,
  "selected_edges_json" TEXT /* logical_type=canonical_json */,
  "activation_event_seq" INTEGER /* logical_type=integer */,
  "run_work_fence_epoch_at_activation" INTEGER /* logical_type=integer */,
  "scope_work_fence_epoch_at_activation" INTEGER /* logical_type=integer */,
  "terminal_status" TEXT /* logical_type=text */,
  "terminal_code" TEXT /* logical_type=text */,
  "child_exit" TEXT /* logical_type=text */,
  "published_output_envelope_value_id" TEXT /* logical_type=identifier */,
  "published_output_envelope_hash" TEXT /* logical_type=hash */,
  "port_contract_hash" TEXT /* logical_type=hash */,
  "current_attempt_id" TEXT /* logical_type=identifier */,
  "current_attempt_no" INTEGER /* logical_type=integer */,
  "active_wait_id" TEXT /* logical_type=identifier */,
  "controller_state" TEXT /* logical_type=text */,
  "controller_decision_json" TEXT /* logical_type=canonical_json */,
  "controller_decision_hash" TEXT /* logical_type=hash */,
  "controller_remaining_count" INTEGER /* logical_type=integer */,
  "controller_reservation_group_id" TEXT /* logical_type=identifier */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "ready_at_ms" INTEGER /* logical_type=integer */,
  "terminal_at_ms" INTEGER /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_nodes" PRIMARY KEY ("id"),
  CONSTRAINT "fk:nodes:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:nodes:capability" FOREIGN KEY ("capability_resource_id", "capability_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:nodes:input_snapshot" FOREIGN KEY ("input_snapshot_value_id", "input_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:nodes:output_envelope" FOREIGN KEY ("published_output_envelope_value_id", "published_output_envelope_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:nodes:current_attempt" FOREIGN KEY ("graph_run_id", "scope_id", "id", "current_attempt_id", "current_attempt_no") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id", "attempt_no") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:nodes:active_wait" FOREIGN KEY ("graph_run_id", "scope_id", "id", "active_wait_id") REFERENCES "workflow_graph_waits" ("graph_run_id", "scope_id", "node_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_nodes:node_type:enum" CHECK ("node_type" IN ('delegation', 'system', 'wait', 'join', 'subgraph', 'expand', 'map', 'terminal')) /* check_kind=enum_membership logical_columns=node_type */,
  CONSTRAINT "ck:workflow_graph_nodes:capability_hash:hash" CHECK (("capability_hash" IS NULL OR (length("capability_hash") = 71 AND substr("capability_hash", 1, 7) = 'sha256:' AND substr("capability_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=capability_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:phase:enum" CHECK ("phase" IN ('pending', 'ready', 'active', 'waiting', 'retry_wait', 'terminal')) /* check_kind=enum_membership logical_columns=phase */,
  CONSTRAINT "ck:workflow_graph_nodes:trigger_state:enum" CHECK ("trigger_state" IN ('unknown', 'true', 'false', 'error')) /* check_kind=enum_membership logical_columns=trigger_state */,
  CONSTRAINT "ck:workflow_graph_nodes:input_state:enum" CHECK ("input_state" IN ('open', 'sealed', 'impossible', 'error')) /* check_kind=enum_membership logical_columns=input_state */,
  CONSTRAINT "ck:workflow_graph_nodes:trigger_cut_hash:hash" CHECK (("trigger_cut_hash" IS NULL OR (length("trigger_cut_hash") = 71 AND substr("trigger_cut_hash", 1, 7) = 'sha256:' AND substr("trigger_cut_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=trigger_cut_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:input_snapshot_hash:hash" CHECK (("input_snapshot_hash" IS NULL OR (length("input_snapshot_hash") = 71 AND substr("input_snapshot_hash", 1, 7) = 'sha256:' AND substr("input_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:activation_event_seq:safe_integer" CHECK (("activation_event_seq" IS NULL OR "activation_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=activation_event_seq */,
  CONSTRAINT "ck:workflow_graph_nodes:run_work_fence_epoch_at_activation:safe_integer" CHECK (("run_work_fence_epoch_at_activation" IS NULL OR "run_work_fence_epoch_at_activation" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=run_work_fence_epoch_at_activation */,
  CONSTRAINT "ck:workflow_graph_nodes:scope_work_fence_epoch_at_activation:safe_integer" CHECK (("scope_work_fence_epoch_at_activation" IS NULL OR "scope_work_fence_epoch_at_activation" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=scope_work_fence_epoch_at_activation */,
  CONSTRAINT "ck:workflow_graph_nodes:terminal_status:enum" CHECK ("terminal_status" IN ('succeeded', 'failed', 'skipped', 'cancelled')) /* check_kind=enum_membership logical_columns=terminal_status */,
  CONSTRAINT "ck:workflow_graph_nodes:published_output_envelope_hash:hash" CHECK (("published_output_envelope_hash" IS NULL OR (length("published_output_envelope_hash") = 71 AND substr("published_output_envelope_hash", 1, 7) = 'sha256:' AND substr("published_output_envelope_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=published_output_envelope_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:port_contract_hash:hash" CHECK (("port_contract_hash" IS NULL OR (length("port_contract_hash") = 71 AND substr("port_contract_hash", 1, 7) = 'sha256:' AND substr("port_contract_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=port_contract_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:current_attempt_no:safe_integer" CHECK (("current_attempt_no" IS NULL OR "current_attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=current_attempt_no */,
  CONSTRAINT "ck:workflow_graph_nodes:controller_state:enum" CHECK ("controller_state" IN ('sealing', 'running', 'closing_remaining', 'settled')) /* check_kind=enum_membership logical_columns=controller_state */,
  CONSTRAINT "ck:workflow_graph_nodes:controller_decision_hash:hash" CHECK (("controller_decision_hash" IS NULL OR (length("controller_decision_hash") = 71 AND substr("controller_decision_hash", 1, 7) = 'sha256:' AND substr("controller_decision_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=controller_decision_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:controller_remaining_count:safe_integer" CHECK (("controller_remaining_count" IS NULL OR "controller_remaining_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=controller_remaining_count */,
  CONSTRAINT "ck:workflow_graph_nodes:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_nodes:ready_at_ms:safe_integer" CHECK (("ready_at_ms" IS NULL OR "ready_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=ready_at_ms */,
  CONSTRAINT "ck:workflow_graph_nodes:terminal_at_ms:safe_integer" CHECK (("terminal_at_ms" IS NULL OR "terminal_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=terminal_at_ms */,
  CONSTRAINT "ck:workflow_graph_nodes:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_nodes:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_nodes:capability_resource_id:capability_hash:pair" CHECK ((("capability_resource_id" IS NULL AND "capability_hash" IS NULL) OR ("capability_resource_id" IS NOT NULL AND "capability_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=capability_resource_id,capability_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:trigger_cut_json:trigger_cut_hash:pair" CHECK ((("trigger_cut_json" IS NULL AND "trigger_cut_hash" IS NULL) OR ("trigger_cut_json" IS NOT NULL AND "trigger_cut_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=trigger_cut_json,trigger_cut_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:published_output_envelope_value_id:published_output_envelope_hash:pair" CHECK ((("published_output_envelope_value_id" IS NULL AND "published_output_envelope_hash" IS NULL) OR ("published_output_envelope_value_id" IS NOT NULL AND "published_output_envelope_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=published_output_envelope_value_id,published_output_envelope_hash */,
  CONSTRAINT "ck:workflow_graph_nodes:current_attempt_id:current_attempt_no:pair" CHECK ((("current_attempt_id" IS NULL AND "current_attempt_no" IS NULL) OR ("current_attempt_id" IS NOT NULL AND "current_attempt_no" IS NOT NULL))) /* check_kind=all_or_none logical_columns=current_attempt_id,current_attempt_no */,
  CONSTRAINT "ck:workflow_graph_nodes:controller_decision_json:controller_decision_hash:pair" CHECK ((("controller_decision_json" IS NULL AND "controller_decision_hash" IS NULL) OR ("controller_decision_json" IS NOT NULL AND "controller_decision_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=controller_decision_json,controller_decision_hash */,
  CONSTRAINT "ck:nodes:phase_shape" CHECK ((("phase" = 'pending' AND "ready_at_ms" IS NULL AND "terminal_at_ms" IS NULL AND "terminal_status" IS NULL) OR ("phase" IN ('ready', 'active', 'waiting', 'retry_wait') AND "ready_at_ms" IS NOT NULL AND "terminal_at_ms" IS NULL AND "terminal_status" IS NULL) OR ("phase" = 'terminal' AND "terminal_at_ms" IS NOT NULL AND "terminal_status" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=phase,ready_at_ms,terminal_at_ms,terminal_status */,
  CONSTRAINT "ck:nodes:activation_snapshot" CHECK ((("activation_event_seq" IS NULL AND "run_work_fence_epoch_at_activation" IS NULL AND "scope_work_fence_epoch_at_activation" IS NULL AND "trigger_cut_hash" IS NULL AND "input_snapshot_hash" IS NULL) OR ("activation_event_seq" IS NOT NULL AND "run_work_fence_epoch_at_activation" IS NOT NULL AND "scope_work_fence_epoch_at_activation" IS NOT NULL AND "trigger_cut_hash" IS NOT NULL AND "input_snapshot_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=activation_event_seq,run_work_fence_epoch_at_activation,scope_work_fence_epoch_at_activation,trigger_cut_hash,input_snapshot_hash */,
  CONSTRAINT "ck:nodes:controller_shape" CHECK ((("node_type" NOT IN ('subgraph', 'expand', 'map') AND "controller_state" IS NULL AND "controller_decision_json" IS NULL AND "controller_remaining_count" IS NULL AND "controller_reservation_group_id" IS NULL) OR "node_type" IN ('subgraph', 'expand', 'map'))) /* check_kind=state_field_consistency logical_columns=node_type,controller_state,controller_decision_json,controller_remaining_count,controller_reservation_group_id */
);

CREATE TABLE "workflow_graph_node_attempts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "node_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "continuation_kind" TEXT NOT NULL /* logical_type=text */,
  "parent_attempt_id" TEXT /* logical_type=identifier */,
  "parent_attempt_no" INTEGER /* logical_type=integer */,
  "phase" TEXT NOT NULL /* logical_type=text */,
  "execution_outcome" TEXT /* logical_type=text */,
  "quality_decision" TEXT /* logical_type=text */,
  "input_snapshot_json" TEXT /* logical_type=canonical_json */,
  "input_snapshot_value_id" TEXT /* logical_type=identifier */,
  "input_snapshot_hash" TEXT /* logical_type=hash */,
  "selected_edges_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "context_pack_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "context_pack_hash" TEXT NOT NULL /* logical_type=hash */,
  "delegation_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=delegation_provider_registry reference_domain=delegation_execution immutable=1 */,
  "external_execution_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=executor_adapter_registry reference_domain=external_execution immutable=1 */,
  "action_name" TEXT /* logical_type=text */,
  "query_id" TEXT /* logical_type=text */,
  "dispatch_started_at_ms" INTEGER /* logical_type=integer */,
  "dispatch_deadline_at_ms" INTEGER /* logical_type=integer */,
  "execution_started_at_ms" INTEGER /* logical_type=integer */,
  "execution_deadline_at_ms" INTEGER /* logical_type=integer */,
  "timeout_event_id" TEXT /* logical_type=identifier */,
  "artifact_refs_value_id" TEXT /* logical_type=identifier */,
  "artifact_refs_hash" TEXT /* logical_type=hash */,
  "result_value_id" TEXT /* logical_type=identifier */,
  "result_hash" TEXT /* logical_type=hash */,
  "evaluation_value_id" TEXT /* logical_type=identifier */,
  "evaluation_hash" TEXT /* logical_type=hash */,
  "quality_revision_feedback_value_id" TEXT /* logical_type=identifier */,
  "quality_revision_feedback_hash" TEXT /* logical_type=hash */,
  "retry_reason_code" TEXT /* logical_type=text */,
  "error_code" TEXT /* logical_type=text */,
  "error_detail_value_id" TEXT /* logical_type=identifier */,
  "error_detail_hash" TEXT /* logical_type=hash */,
  "usage_summary_value_id" TEXT /* logical_type=identifier */,
  "usage_summary_hash" TEXT /* logical_type=hash */,
  "acceptance_state" TEXT NOT NULL /* logical_type=text */,
  "run_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "scope_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "resource_reservation_group_id" TEXT NOT NULL /* logical_type=identifier */,
  "lease_owner" TEXT /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "lease_token" TEXT /* logical_type=text */,
  "lease_expires_at_ms" INTEGER /* logical_type=integer */,
  "heartbeat_at_ms" INTEGER /* logical_type=integer */,
  "evaluation_lease_owner" TEXT /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "evaluation_lease_token" TEXT /* logical_type=text */,
  "evaluation_lease_expires_at_ms" INTEGER /* logical_type=integer */,
  "evaluation_attempt_count" INTEGER NOT NULL /* logical_type=integer */,
  "evaluation_next_attempt_at_ms" INTEGER /* logical_type=integer */,
  "evaluation_deadline_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_node_attempts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:node_attempts:node" FOREIGN KEY ("graph_run_id", "scope_id", "node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:parent" FOREIGN KEY ("graph_run_id", "scope_id", "node_id", "parent_attempt_id", "parent_attempt_no") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id", "attempt_no") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:input_snapshot" FOREIGN KEY ("input_snapshot_value_id", "input_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:context_pack" FOREIGN KEY ("context_pack_value_id", "context_pack_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:timeout_event" FOREIGN KEY ("graph_run_id", "timeout_event_id") REFERENCES "workflow_graph_events" ("graph_run_id", "seq") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:artifact_refs" FOREIGN KEY ("artifact_refs_value_id", "artifact_refs_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:result" FOREIGN KEY ("result_value_id", "result_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:evaluation" FOREIGN KEY ("evaluation_value_id", "evaluation_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:feedback" FOREIGN KEY ("quality_revision_feedback_value_id", "quality_revision_feedback_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:error_detail" FOREIGN KEY ("error_detail_value_id", "error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:node_attempts:usage_summary" FOREIGN KEY ("usage_summary_value_id", "usage_summary_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_node_attempts:attempt_no:safe_integer" CHECK (("attempt_no" IS NULL OR "attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_no */,
  CONSTRAINT "ck:workflow_graph_node_attempts:continuation_kind:enum" CHECK ("continuation_kind" IN ('initial', 'execution_retry', 'quality_revision')) /* check_kind=enum_membership logical_columns=continuation_kind */,
  CONSTRAINT "ck:workflow_graph_node_attempts:parent_attempt_no:safe_integer" CHECK (("parent_attempt_no" IS NULL OR "parent_attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=parent_attempt_no */,
  CONSTRAINT "ck:workflow_graph_node_attempts:phase:enum" CHECK ("phase" IN ('preparing', 'dispatch_pending', 'running', 'evaluating', 'terminal')) /* check_kind=enum_membership logical_columns=phase */,
  CONSTRAINT "ck:workflow_graph_node_attempts:execution_outcome:enum" CHECK ("execution_outcome" IN ('succeeded', 'failed', 'cancelled')) /* check_kind=enum_membership logical_columns=execution_outcome */,
  CONSTRAINT "ck:workflow_graph_node_attempts:quality_decision:enum" CHECK ("quality_decision" IN ('pass', 'needs_revision', 'fail', 'pending')) /* check_kind=enum_membership logical_columns=quality_decision */,
  CONSTRAINT "ck:workflow_graph_node_attempts:input_snapshot_hash:hash" CHECK (("input_snapshot_hash" IS NULL OR (length("input_snapshot_hash") = 71 AND substr("input_snapshot_hash", 1, 7) = 'sha256:' AND substr("input_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=input_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:context_pack_hash:hash" CHECK (("context_pack_hash" IS NULL OR (length("context_pack_hash") = 71 AND substr("context_pack_hash", 1, 7) = 'sha256:' AND substr("context_pack_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=context_pack_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:dispatch_started_at_ms:safe_integer" CHECK (("dispatch_started_at_ms" IS NULL OR "dispatch_started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=dispatch_started_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:dispatch_deadline_at_ms:safe_integer" CHECK (("dispatch_deadline_at_ms" IS NULL OR "dispatch_deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=dispatch_deadline_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:execution_started_at_ms:safe_integer" CHECK (("execution_started_at_ms" IS NULL OR "execution_started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=execution_started_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:execution_deadline_at_ms:safe_integer" CHECK (("execution_deadline_at_ms" IS NULL OR "execution_deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=execution_deadline_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:artifact_refs_hash:hash" CHECK (("artifact_refs_hash" IS NULL OR (length("artifact_refs_hash") = 71 AND substr("artifact_refs_hash", 1, 7) = 'sha256:' AND substr("artifact_refs_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=artifact_refs_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:result_hash:hash" CHECK (("result_hash" IS NULL OR (length("result_hash") = 71 AND substr("result_hash", 1, 7) = 'sha256:' AND substr("result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=result_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:evaluation_hash:hash" CHECK (("evaluation_hash" IS NULL OR (length("evaluation_hash") = 71 AND substr("evaluation_hash", 1, 7) = 'sha256:' AND substr("evaluation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=evaluation_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:quality_revision_feedback_hash:hash" CHECK (("quality_revision_feedback_hash" IS NULL OR (length("quality_revision_feedback_hash") = 71 AND substr("quality_revision_feedback_hash", 1, 7) = 'sha256:' AND substr("quality_revision_feedback_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=quality_revision_feedback_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:error_detail_hash:hash" CHECK (("error_detail_hash" IS NULL OR (length("error_detail_hash") = 71 AND substr("error_detail_hash", 1, 7) = 'sha256:' AND substr("error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:usage_summary_hash:hash" CHECK (("usage_summary_hash" IS NULL OR (length("usage_summary_hash") = 71 AND substr("usage_summary_hash", 1, 7) = 'sha256:' AND substr("usage_summary_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=usage_summary_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:acceptance_state:enum" CHECK ("acceptance_state" IN ('open', 'fenced')) /* check_kind=enum_membership logical_columns=acceptance_state */,
  CONSTRAINT "ck:workflow_graph_node_attempts:run_work_fence_epoch:safe_integer" CHECK (("run_work_fence_epoch" IS NULL OR "run_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=run_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_node_attempts:scope_work_fence_epoch:safe_integer" CHECK (("scope_work_fence_epoch" IS NULL OR "scope_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=scope_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_node_attempts:lease_expires_at_ms:safe_integer" CHECK (("lease_expires_at_ms" IS NULL OR "lease_expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:heartbeat_at_ms:safe_integer" CHECK (("heartbeat_at_ms" IS NULL OR "heartbeat_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=heartbeat_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:evaluation_lease_expires_at_ms:safe_integer" CHECK (("evaluation_lease_expires_at_ms" IS NULL OR "evaluation_lease_expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=evaluation_lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:evaluation_attempt_count:safe_integer" CHECK (("evaluation_attempt_count" IS NULL OR "evaluation_attempt_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=evaluation_attempt_count */,
  CONSTRAINT "ck:workflow_graph_node_attempts:evaluation_next_attempt_at_ms:safe_integer" CHECK (("evaluation_next_attempt_at_ms" IS NULL OR "evaluation_next_attempt_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=evaluation_next_attempt_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:evaluation_deadline_at_ms:safe_integer" CHECK (("evaluation_deadline_at_ms" IS NULL OR "evaluation_deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=evaluation_deadline_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_node_attempts:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:parent_attempt_id:parent_attempt_no:pair" CHECK ((("parent_attempt_id" IS NULL AND "parent_attempt_no" IS NULL) OR ("parent_attempt_id" IS NOT NULL AND "parent_attempt_no" IS NOT NULL))) /* check_kind=all_or_none logical_columns=parent_attempt_id,parent_attempt_no */,
  CONSTRAINT "ck:workflow_graph_node_attempts:dispatch_started_at_ms:dispatch_deadline_at_ms:pair" CHECK ((("dispatch_started_at_ms" IS NULL AND "dispatch_deadline_at_ms" IS NULL) OR ("dispatch_started_at_ms" IS NOT NULL AND "dispatch_deadline_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=dispatch_started_at_ms,dispatch_deadline_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:execution_started_at_ms:execution_deadline_at_ms:pair" CHECK ((("execution_started_at_ms" IS NULL AND "execution_deadline_at_ms" IS NULL) OR ("execution_started_at_ms" IS NOT NULL AND "execution_deadline_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=execution_started_at_ms,execution_deadline_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:quality_revision_feedback_value_id:quality_revision_feedback_hash:pair" CHECK ((("quality_revision_feedback_value_id" IS NULL AND "quality_revision_feedback_hash" IS NULL) OR ("quality_revision_feedback_value_id" IS NOT NULL AND "quality_revision_feedback_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=quality_revision_feedback_value_id,quality_revision_feedback_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:error_detail_value_id:error_detail_hash:pair" CHECK ((("error_detail_value_id" IS NULL AND "error_detail_hash" IS NULL) OR ("error_detail_value_id" IS NOT NULL AND "error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=error_detail_value_id,error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_node_attempts:lease_owner:lease_token:pair" CHECK ((("lease_owner" IS NULL AND "lease_token" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_token */,
  CONSTRAINT "ck:workflow_graph_node_attempts:lease_owner:lease_expires_at_ms:pair" CHECK ((("lease_owner" IS NULL AND "lease_expires_at_ms" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_expires_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_graph_node_attempts:evaluation_lease_owner:evaluation_lease_token:pair" CHECK ((("evaluation_lease_owner" IS NULL AND "evaluation_lease_token" IS NULL) OR ("evaluation_lease_owner" IS NOT NULL AND "evaluation_lease_token" IS NOT NULL))) /* check_kind=all_or_none logical_columns=evaluation_lease_owner,evaluation_lease_token */,
  CONSTRAINT "ck:workflow_graph_node_attempts:evaluation_lease_owner:evaluation_lease_expires_at_ms:pair" CHECK ((("evaluation_lease_owner" IS NULL AND "evaluation_lease_expires_at_ms" IS NULL) OR ("evaluation_lease_owner" IS NOT NULL AND "evaluation_lease_expires_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=evaluation_lease_owner,evaluation_lease_expires_at_ms */,
  CONSTRAINT "ck:node_attempts:continuation" CHECK ((("attempt_no" = 1 AND "continuation_kind" = 'initial' AND "parent_attempt_id" IS NULL AND "parent_attempt_no" IS NULL) OR ("attempt_no" > 1 AND "continuation_kind" IN ('execution_retry', 'quality_revision') AND "parent_attempt_id" IS NOT NULL AND "parent_attempt_no" = "attempt_no" - 1))) /* check_kind=lineage_consistency logical_columns=attempt_no,continuation_kind,parent_attempt_id,parent_attempt_no */,
  CONSTRAINT "ck:node_attempts:quality_feedback" CHECK ((("quality_revision_feedback_value_id" IS NOT NULL) = ("quality_decision" = 'needs_revision' OR "continuation_kind" = 'quality_revision'))) /* check_kind=state_field_consistency logical_columns=quality_decision,continuation_kind,quality_revision_feedback_value_id */,
  CONSTRAINT "ck:node_attempts:terminal_shape" CHECK ((("phase" = 'terminal' AND "execution_outcome" IS NOT NULL AND "finished_at_ms" IS NOT NULL AND ("quality_decision" IS NULL OR "quality_decision" IN ('pass', 'needs_revision', 'fail'))) OR ("phase" <> 'terminal' AND "finished_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=phase,execution_outcome,quality_decision,finished_at_ms */
);

CREATE TABLE "workflow_graph_retry_schedules" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "node_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_attempt_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "next_attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "continuation_kind" TEXT NOT NULL /* logical_type=text */,
  "quality_revision_feedback_value_id" TEXT /* logical_type=identifier */,
  "quality_revision_feedback_hash" TEXT /* logical_type=hash */,
  "retry_reason_code" TEXT NOT NULL /* logical_type=text */,
  "retry_policy_hash" TEXT NOT NULL /* logical_type=hash */,
  "backoff_ms" INTEGER NOT NULL /* logical_type=integer */,
  "eligible_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "attempt_reservation_id" TEXT NOT NULL /* logical_type=identifier */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_retry_schedules" PRIMARY KEY ("id"),
  CONSTRAINT "fk:retry_schedules:node" FOREIGN KEY ("graph_run_id", "scope_id", "node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:retry_schedules:attempt" FOREIGN KEY ("graph_run_id", "scope_id", "node_id", "source_attempt_id", "source_attempt_no") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id", "attempt_no") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:retry_schedules:feedback" FOREIGN KEY ("quality_revision_feedback_value_id", "quality_revision_feedback_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:retry_schedules:reservation" FOREIGN KEY ("attempt_reservation_id") REFERENCES "workflow_graph_resource_reservations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_retry_schedules:source_attempt_no:safe_integer" CHECK (("source_attempt_no" IS NULL OR "source_attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=source_attempt_no */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:next_attempt_no:safe_integer" CHECK (("next_attempt_no" IS NULL OR "next_attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_attempt_no */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:continuation_kind:enum" CHECK ("continuation_kind" IN ('execution_retry', 'quality_revision')) /* check_kind=enum_membership logical_columns=continuation_kind */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:quality_revision_feedback_hash:hash" CHECK (("quality_revision_feedback_hash" IS NULL OR (length("quality_revision_feedback_hash") = 71 AND substr("quality_revision_feedback_hash", 1, 7) = 'sha256:' AND substr("quality_revision_feedback_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=quality_revision_feedback_hash */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:retry_policy_hash:hash" CHECK (("retry_policy_hash" IS NULL OR (length("retry_policy_hash") = 71 AND substr("retry_policy_hash", 1, 7) = 'sha256:' AND substr("retry_policy_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=retry_policy_hash */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:backoff_ms:safe_integer" CHECK (("backoff_ms" IS NULL OR "backoff_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=backoff_ms */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:eligible_at_ms:safe_integer" CHECK (("eligible_at_ms" IS NULL OR "eligible_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=eligible_at_ms */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:status:enum" CHECK ("status" IN ('scheduled', 'consumed', 'cancelled')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_retry_schedules:quality_revision_feedback_value_id:quality_revision_feedback_hash:pair" CHECK ((("quality_revision_feedback_value_id" IS NULL AND "quality_revision_feedback_hash" IS NULL) OR ("quality_revision_feedback_value_id" IS NOT NULL AND "quality_revision_feedback_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=quality_revision_feedback_value_id,quality_revision_feedback_hash */,
  CONSTRAINT "ck:retry_schedules:adjacent_attempt" CHECK ("next_attempt_no" = "source_attempt_no" + 1) /* check_kind=lineage_consistency logical_columns=source_attempt_no,next_attempt_no */,
  CONSTRAINT "ck:retry_schedules:feedback_kind" CHECK ((("continuation_kind" = 'quality_revision' AND "quality_revision_feedback_value_id" IS NOT NULL AND "retry_reason_code" = 'quality_needs_revision') OR ("continuation_kind" = 'execution_retry' AND "quality_revision_feedback_value_id" IS NULL AND "retry_reason_code" <> 'quality_needs_revision'))) /* check_kind=state_field_consistency logical_columns=continuation_kind,quality_revision_feedback_value_id,retry_reason_code */
);

CREATE TABLE "workflow_graph_waits" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "node_id" TEXT NOT NULL /* logical_type=identifier */,
  "wait_type" TEXT NOT NULL /* logical_type=text */,
  "contract_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "contract_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "correlation_key" TEXT NOT NULL /* logical_type=text */,
  "correlation_key_hash" TEXT NOT NULL /* logical_type=hash */,
  "registration_key" TEXT NOT NULL /* logical_type=text */,
  "payload_value_id" TEXT /* logical_type=identifier */,
  "payload_hash" TEXT /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "armed_at_ms" INTEGER /* logical_type=integer */,
  "deadline_at_ms" INTEGER /* logical_type=integer */,
  "resolved_at_ms" INTEGER /* logical_type=integer */,
  "registration_lease_owner" TEXT /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "registration_lease_token" TEXT /* logical_type=text */,
  "registration_lease_expires_at_ms" INTEGER /* logical_type=integer */,
  "run_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "scope_work_fence_epoch" INTEGER NOT NULL /* logical_type=integer */,
  "resource_reservation_group_id" TEXT NOT NULL /* logical_type=identifier */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_waits" PRIMARY KEY ("id"),
  CONSTRAINT "fk:waits:node" FOREIGN KEY ("graph_run_id", "scope_id", "node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:waits:contract" FOREIGN KEY ("contract_resource_id", "contract_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:waits:payload" FOREIGN KEY ("payload_value_id", "payload_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_waits:wait_type:enum" CHECK ("wait_type" IN ('signal', 'timer', 'approval')) /* check_kind=enum_membership logical_columns=wait_type */,
  CONSTRAINT "ck:workflow_graph_waits:contract_resource_hash:hash" CHECK (("contract_resource_hash" IS NULL OR (length("contract_resource_hash") = 71 AND substr("contract_resource_hash", 1, 7) = 'sha256:' AND substr("contract_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=contract_resource_hash */,
  CONSTRAINT "ck:workflow_graph_waits:correlation_key_hash:hash" CHECK (("correlation_key_hash" IS NULL OR (length("correlation_key_hash") = 71 AND substr("correlation_key_hash", 1, 7) = 'sha256:' AND substr("correlation_key_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=correlation_key_hash */,
  CONSTRAINT "ck:workflow_graph_waits:payload_hash:hash" CHECK (("payload_hash" IS NULL OR (length("payload_hash") = 71 AND substr("payload_hash", 1, 7) = 'sha256:' AND substr("payload_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=payload_hash */,
  CONSTRAINT "ck:workflow_graph_waits:status:enum" CHECK ("status" IN ('registering', 'armed', 'resolved', 'timed_out', 'cancelled')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_graph_waits:armed_at_ms:safe_integer" CHECK (("armed_at_ms" IS NULL OR "armed_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=armed_at_ms */,
  CONSTRAINT "ck:workflow_graph_waits:deadline_at_ms:safe_integer" CHECK (("deadline_at_ms" IS NULL OR "deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=deadline_at_ms */,
  CONSTRAINT "ck:workflow_graph_waits:resolved_at_ms:safe_integer" CHECK (("resolved_at_ms" IS NULL OR "resolved_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolved_at_ms */,
  CONSTRAINT "ck:workflow_graph_waits:registration_lease_expires_at_ms:safe_integer" CHECK (("registration_lease_expires_at_ms" IS NULL OR "registration_lease_expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=registration_lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_graph_waits:run_work_fence_epoch:safe_integer" CHECK (("run_work_fence_epoch" IS NULL OR "run_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=run_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_waits:scope_work_fence_epoch:safe_integer" CHECK (("scope_work_fence_epoch" IS NULL OR "scope_work_fence_epoch" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=scope_work_fence_epoch */,
  CONSTRAINT "ck:workflow_graph_waits:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_waits:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_waits:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_waits:payload_value_id:payload_hash:pair" CHECK ((("payload_value_id" IS NULL AND "payload_hash" IS NULL) OR ("payload_value_id" IS NOT NULL AND "payload_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=payload_value_id,payload_hash */,
  CONSTRAINT "ck:workflow_graph_waits:registration_lease_owner:registration_lease_token:pair" CHECK ((("registration_lease_owner" IS NULL AND "registration_lease_token" IS NULL) OR ("registration_lease_owner" IS NOT NULL AND "registration_lease_token" IS NOT NULL))) /* check_kind=all_or_none logical_columns=registration_lease_owner,registration_lease_token */,
  CONSTRAINT "ck:workflow_graph_waits:registration_lease_owner:registration_lease_expires_at_ms:pair" CHECK ((("registration_lease_owner" IS NULL AND "registration_lease_expires_at_ms" IS NULL) OR ("registration_lease_owner" IS NOT NULL AND "registration_lease_expires_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=registration_lease_owner,registration_lease_expires_at_ms */,
  CONSTRAINT "ck:waits:status_time" CHECK ((("status" = 'registering' AND "armed_at_ms" IS NULL AND "resolved_at_ms" IS NULL) OR ("status" = 'armed' AND "armed_at_ms" IS NOT NULL AND "resolved_at_ms" IS NULL) OR ("status" IN ('resolved', 'timed_out', 'cancelled') AND "armed_at_ms" IS NOT NULL AND "resolved_at_ms" IS NOT NULL)) AND ("wait_type" <> 'timer' OR "deadline_at_ms" IS NOT NULL)) /* check_kind=state_field_consistency logical_columns=status,armed_at_ms,deadline_at_ms,resolved_at_ms */
);

CREATE TABLE "workflow_graph_edges" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "edge_key" TEXT NOT NULL /* logical_type=text */,
  "edge_kind" TEXT NOT NULL /* logical_type=text */,
  "compiled_edge_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "compiled_edge_hash" TEXT NOT NULL /* logical_type=hash */,
  CONSTRAINT "pk:workflow_graph_edges" PRIMARY KEY ("id"),
  CONSTRAINT "fk:edges:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_edges:edge_kind:enum" CHECK ("edge_kind" IN ('control', 'data')) /* check_kind=enum_membership logical_columns=edge_kind */,
  CONSTRAINT "ck:workflow_graph_edges:compiled_edge_hash:hash" CHECK (("compiled_edge_hash" IS NULL OR (length("compiled_edge_hash") = 71 AND substr("compiled_edge_hash", 1, 7) = 'sha256:' AND substr("compiled_edge_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=compiled_edge_hash */
);

CREATE TABLE "workflow_graph_control_edge_resolutions" (
  "edge_id" TEXT NOT NULL /* logical_type=identifier */,
  "state" TEXT NOT NULL /* logical_type=text */,
  "decision_input_hash" TEXT /* logical_type=hash */,
  "decision_json" TEXT /* logical_type=canonical_json */,
  "error_code" TEXT /* logical_type=text */,
  "resolution_seq" INTEGER /* logical_type=integer */,
  "resolved_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_control_edge_resolutions" PRIMARY KEY ("edge_id"),
  CONSTRAINT "fk:control_resolutions:edge" FOREIGN KEY ("edge_id") REFERENCES "workflow_graph_edges" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_control_edge_resolutions:state:enum" CHECK ("state" IN ('unresolved', 'taken', 'not_taken', 'error')) /* check_kind=enum_membership logical_columns=state */,
  CONSTRAINT "ck:workflow_graph_control_edge_resolutions:decision_input_hash:hash" CHECK (("decision_input_hash" IS NULL OR (length("decision_input_hash") = 71 AND substr("decision_input_hash", 1, 7) = 'sha256:' AND substr("decision_input_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=decision_input_hash */,
  CONSTRAINT "ck:workflow_graph_control_edge_resolutions:resolution_seq:safe_integer" CHECK (("resolution_seq" IS NULL OR "resolution_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolution_seq */,
  CONSTRAINT "ck:workflow_graph_control_edge_resolutions:resolved_at_ms:safe_integer" CHECK (("resolved_at_ms" IS NULL OR "resolved_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolved_at_ms */,
  CONSTRAINT "ck:workflow_graph_control_edge_resolutions:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:control_resolutions:state_shape" CHECK ((("state" = 'unresolved' AND "decision_input_hash" IS NULL AND "decision_json" IS NULL AND "error_code" IS NULL AND "resolution_seq" IS NULL AND "resolved_at_ms" IS NULL) OR ("state" IN ('taken', 'not_taken') AND "decision_input_hash" IS NOT NULL AND "error_code" IS NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("state" = 'error' AND "error_code" IS NOT NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=state,decision_input_hash,decision_json,error_code,resolution_seq,resolved_at_ms */
);

CREATE TABLE "workflow_graph_data_edge_resolutions" (
  "edge_id" TEXT NOT NULL /* logical_type=identifier */,
  "state" TEXT NOT NULL /* logical_type=text */,
  "value_value_id" TEXT /* logical_type=identifier */,
  "value_hash" TEXT /* logical_type=hash */,
  "schema_hash" TEXT /* logical_type=hash */,
  "source_attempt_id" TEXT /* logical_type=identifier */,
  "error_code" TEXT /* logical_type=text */,
  "resolution_seq" INTEGER /* logical_type=integer */,
  "resolved_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_data_edge_resolutions" PRIMARY KEY ("edge_id"),
  CONSTRAINT "fk:data_resolutions:edge" FOREIGN KEY ("edge_id") REFERENCES "workflow_graph_edges" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:data_resolutions:value" FOREIGN KEY ("value_value_id", "value_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:data_resolutions:source_attempt" FOREIGN KEY ("source_attempt_id") REFERENCES "workflow_graph_node_attempts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_data_edge_resolutions:state:enum" CHECK ("state" IN ('unresolved', 'available', 'unavailable', 'error')) /* check_kind=enum_membership logical_columns=state */,
  CONSTRAINT "ck:workflow_graph_data_edge_resolutions:value_hash:hash" CHECK (("value_hash" IS NULL OR (length("value_hash") = 71 AND substr("value_hash", 1, 7) = 'sha256:' AND substr("value_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=value_hash */,
  CONSTRAINT "ck:workflow_graph_data_edge_resolutions:schema_hash:hash" CHECK (("schema_hash" IS NULL OR (length("schema_hash") = 71 AND substr("schema_hash", 1, 7) = 'sha256:' AND substr("schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=schema_hash */,
  CONSTRAINT "ck:workflow_graph_data_edge_resolutions:resolution_seq:safe_integer" CHECK (("resolution_seq" IS NULL OR "resolution_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolution_seq */,
  CONSTRAINT "ck:workflow_graph_data_edge_resolutions:resolved_at_ms:safe_integer" CHECK (("resolved_at_ms" IS NULL OR "resolved_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolved_at_ms */,
  CONSTRAINT "ck:workflow_graph_data_edge_resolutions:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_data_edge_resolutions:value_value_id:value_hash:pair" CHECK ((("value_value_id" IS NULL AND "value_hash" IS NULL) OR ("value_value_id" IS NOT NULL AND "value_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=value_value_id,value_hash */,
  CONSTRAINT "ck:data_resolutions:state_shape" CHECK ((("state" = 'unresolved' AND "value_value_id" IS NULL AND "schema_hash" IS NULL AND "source_attempt_id" IS NULL AND "error_code" IS NULL AND "resolution_seq" IS NULL AND "resolved_at_ms" IS NULL) OR ("state" = 'available' AND "value_value_id" IS NOT NULL AND "schema_hash" IS NOT NULL AND "error_code" IS NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("state" = 'unavailable' AND "value_value_id" IS NULL AND "error_code" IS NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL) OR ("state" = 'error' AND "value_value_id" IS NULL AND "error_code" IS NOT NULL AND "resolution_seq" IS NOT NULL AND "resolved_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=state,value_value_id,schema_hash,source_attempt_id,error_code,resolution_seq,resolved_at_ms */
);

CREATE TABLE "workflow_graph_terminal_candidates" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "terminal_node_id" TEXT NOT NULL /* logical_type=identifier */,
  "exit_name" TEXT NOT NULL /* logical_type=text */,
  "output_snapshot_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "output_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "candidate_seq" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_terminal_candidates" PRIMARY KEY ("id"),
  CONSTRAINT "fk:terminal_candidates:node" FOREIGN KEY ("graph_run_id", "scope_id", "terminal_node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:terminal_candidates:output" FOREIGN KEY ("output_snapshot_value_id", "output_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_terminal_candidates:output_snapshot_hash:hash" CHECK (("output_snapshot_hash" IS NULL OR (length("output_snapshot_hash") = 71 AND substr("output_snapshot_hash", 1, 7) = 'sha256:' AND substr("output_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=output_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_terminal_candidates:candidate_seq:safe_integer" CHECK (("candidate_seq" IS NULL OR "candidate_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=candidate_seq */,
  CONSTRAINT "ck:workflow_graph_terminal_candidates:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_graph_completion_eligibilities" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "rule_id" TEXT NOT NULL /* logical_type=text */,
  "phase" TEXT NOT NULL /* logical_type=text */,
  "eligibility_event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "selected_candidate_id" TEXT NOT NULL /* logical_type=identifier */,
  "fact_snapshot_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "fact_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_completion_eligibilities" PRIMARY KEY ("id"),
  CONSTRAINT "fk:completion_eligibilities:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:completion_eligibilities:candidate" FOREIGN KEY ("scope_id", "selected_candidate_id") REFERENCES "workflow_graph_terminal_candidates" ("scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:completion_eligibilities:event" FOREIGN KEY ("graph_run_id", "eligibility_event_seq") REFERENCES "workflow_graph_events" ("graph_run_id", "seq") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_completion_eligibilities:phase:enum" CHECK ("phase" IN ('early', 'settled')) /* check_kind=enum_membership logical_columns=phase */,
  CONSTRAINT "ck:workflow_graph_completion_eligibilities:eligibility_event_seq:safe_integer" CHECK (("eligibility_event_seq" IS NULL OR "eligibility_event_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=eligibility_event_seq */,
  CONSTRAINT "ck:workflow_graph_completion_eligibilities:fact_snapshot_hash:hash" CHECK (("fact_snapshot_hash" IS NULL OR (length("fact_snapshot_hash") = 71 AND substr("fact_snapshot_hash", 1, 7) = 'sha256:' AND substr("fact_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=fact_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_completion_eligibilities:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_graph_scope_close_requests" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "selected_rule_id" TEXT /* logical_type=text */,
  "candidate_id" TEXT /* logical_type=identifier */,
  "eligibility_event_seq" INTEGER /* logical_type=integer */,
  "fact_snapshot_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "fact_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "node_frontier_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "node_frontier_hash" TEXT NOT NULL /* logical_type=hash */,
  "edge_frontier_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "edge_frontier_hash" TEXT NOT NULL /* logical_type=hash */,
  "trigger_event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "fenced_work_epoch_at_creation" INTEGER NOT NULL /* logical_type=integer */,
  "reason" TEXT NOT NULL /* logical_type=text */,
  "error_code" TEXT /* logical_type=text */,
  "error_detail_value_id" TEXT /* logical_type=identifier */,
  "error_detail_hash" TEXT /* logical_type=hash */,
  "cancel_payload_json" TEXT /* logical_type=canonical_json */,
  "cancel_payload_hash" TEXT /* logical_type=hash */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_scope_close_requests" PRIMARY KEY ("id"),
  CONSTRAINT "fk:close_requests:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:close_requests:candidate" FOREIGN KEY ("scope_id", "candidate_id") REFERENCES "workflow_graph_terminal_candidates" ("scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:close_requests:eligibility" FOREIGN KEY ("scope_id", "selected_rule_id") REFERENCES "workflow_graph_completion_eligibilities" ("scope_id", "rule_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:close_requests:trigger_event" FOREIGN KEY ("graph_run_id", "trigger_event_seq") REFERENCES "workflow_graph_events" ("graph_run_id", "seq") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:close_requests:error_detail" FOREIGN KEY ("error_detail_value_id", "error_detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:eligibility_event_seq:safe_integer" CHECK (("eligibility_event_seq" IS NULL OR "eligibility_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=eligibility_event_seq */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:fact_snapshot_hash:hash" CHECK (("fact_snapshot_hash" IS NULL OR (length("fact_snapshot_hash") = 71 AND substr("fact_snapshot_hash", 1, 7) = 'sha256:' AND substr("fact_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=fact_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:node_frontier_hash:hash" CHECK (("node_frontier_hash" IS NULL OR (length("node_frontier_hash") = 71 AND substr("node_frontier_hash", 1, 7) = 'sha256:' AND substr("node_frontier_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=node_frontier_hash */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:edge_frontier_hash:hash" CHECK (("edge_frontier_hash" IS NULL OR (length("edge_frontier_hash") = 71 AND substr("edge_frontier_hash", 1, 7) = 'sha256:' AND substr("edge_frontier_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=edge_frontier_hash */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:trigger_event_seq:safe_integer" CHECK (("trigger_event_seq" IS NULL OR "trigger_event_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=trigger_event_seq */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:fenced_work_epoch_at_creation:safe_integer" CHECK (("fenced_work_epoch_at_creation" IS NULL OR "fenced_work_epoch_at_creation" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=fenced_work_epoch_at_creation */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:reason:enum" CHECK ("reason" IN ('normal', 'engine_error', 'local_cancel', 'workflow_cancel', 'parent_close')) /* check_kind=enum_membership logical_columns=reason */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:error_detail_hash:hash" CHECK (("error_detail_hash" IS NULL OR (length("error_detail_hash") = 71 AND substr("error_detail_hash", 1, 7) = 'sha256:' AND substr("error_detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:cancel_payload_hash:hash" CHECK (("cancel_payload_hash" IS NULL OR (length("cancel_payload_hash") = 71 AND substr("cancel_payload_hash", 1, 7) = 'sha256:' AND substr("cancel_payload_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=cancel_payload_hash */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:selected_rule_id:candidate_id:pair" CHECK ((("selected_rule_id" IS NULL AND "candidate_id" IS NULL) OR ("selected_rule_id" IS NOT NULL AND "candidate_id" IS NOT NULL))) /* check_kind=all_or_none logical_columns=selected_rule_id,candidate_id */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:error_detail_value_id:error_detail_hash:pair" CHECK ((("error_detail_value_id" IS NULL AND "error_detail_hash" IS NULL) OR ("error_detail_value_id" IS NOT NULL AND "error_detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=error_detail_value_id,error_detail_hash */,
  CONSTRAINT "ck:workflow_graph_scope_close_requests:cancel_payload_json:cancel_payload_hash:pair" CHECK ((("cancel_payload_json" IS NULL AND "cancel_payload_hash" IS NULL) OR ("cancel_payload_json" IS NOT NULL AND "cancel_payload_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=cancel_payload_json,cancel_payload_hash */,
  CONSTRAINT "ck:close_requests:reason_shape" CHECK ((("reason" = 'normal' AND "selected_rule_id" IS NOT NULL AND "candidate_id" IS NOT NULL AND "eligibility_event_seq" IS NOT NULL AND "error_code" IS NULL AND "cancel_payload_json" IS NULL) OR ("reason" = 'engine_error' AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL AND "error_code" IS NOT NULL AND "cancel_payload_json" IS NULL) OR ("reason" IN ('local_cancel', 'workflow_cancel') AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL AND "error_code" IS NULL AND "cancel_payload_json" IS NOT NULL) OR ("reason" = 'parent_close' AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL AND "error_code" IS NULL))) /* check_kind=state_field_consistency logical_columns=reason,selected_rule_id,candidate_id,eligibility_event_seq,error_code,error_detail_value_id,cancel_payload_json */
);

CREATE TABLE "workflow_graph_completion_cuts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "close_request_id" TEXT NOT NULL /* logical_type=identifier */,
  "selected_rule_id" TEXT /* logical_type=text */,
  "candidate_id" TEXT /* logical_type=identifier */,
  "outcome_kind" TEXT NOT NULL /* logical_type=text */,
  "exit_name" TEXT /* logical_type=text */,
  "output_value_id" TEXT /* logical_type=identifier */,
  "output_hash" TEXT /* logical_type=hash */,
  "completion_policy_hash" TEXT NOT NULL /* logical_type=hash */,
  "cut_event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "cut_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_completion_cuts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:completion_cuts:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:completion_cuts:close" FOREIGN KEY ("graph_run_id", "scope_id", "close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:completion_cuts:candidate" FOREIGN KEY ("scope_id", "candidate_id") REFERENCES "workflow_graph_terminal_candidates" ("scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:completion_cuts:output" FOREIGN KEY ("output_value_id", "output_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:completion_cuts:event" FOREIGN KEY ("graph_run_id", "cut_event_seq") REFERENCES "workflow_graph_events" ("graph_run_id", "seq") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_completion_cuts:outcome_kind:enum" CHECK ("outcome_kind" IN ('completed', 'errored', 'cancelled')) /* check_kind=enum_membership logical_columns=outcome_kind */,
  CONSTRAINT "ck:workflow_graph_completion_cuts:output_hash:hash" CHECK (("output_hash" IS NULL OR (length("output_hash") = 71 AND substr("output_hash", 1, 7) = 'sha256:' AND substr("output_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=output_hash */,
  CONSTRAINT "ck:workflow_graph_completion_cuts:completion_policy_hash:hash" CHECK (("completion_policy_hash" IS NULL OR (length("completion_policy_hash") = 71 AND substr("completion_policy_hash", 1, 7) = 'sha256:' AND substr("completion_policy_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=completion_policy_hash */,
  CONSTRAINT "ck:workflow_graph_completion_cuts:cut_event_seq:safe_integer" CHECK (("cut_event_seq" IS NULL OR "cut_event_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=cut_event_seq */,
  CONSTRAINT "ck:workflow_graph_completion_cuts:cut_hash:hash" CHECK (("cut_hash" IS NULL OR (length("cut_hash") = 71 AND substr("cut_hash", 1, 7) = 'sha256:' AND substr("cut_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=cut_hash */,
  CONSTRAINT "ck:workflow_graph_completion_cuts:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:completion_cuts:outcome_shape" CHECK ((("outcome_kind" = 'completed' AND "exit_name" IS NOT NULL AND "output_value_id" IS NOT NULL AND "selected_rule_id" IS NOT NULL AND "candidate_id" IS NOT NULL) OR ("outcome_kind" IN ('errored', 'cancelled') AND "exit_name" IS NULL AND "output_value_id" IS NULL AND "selected_rule_id" IS NULL AND "candidate_id" IS NULL))) /* check_kind=state_field_consistency logical_columns=outcome_kind,exit_name,output_value_id,selected_rule_id,candidate_id */
);

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

CREATE TABLE "workflow_graph_subtree_fence_manifests" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_close_request_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_epochs_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_epochs_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "fenced_work_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "fenced_work_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "cleanup_effect_keys_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "cleanup_effect_keys_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "subtree_fence_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_subtree_fence_manifests" PRIMARY KEY ("id"),
  CONSTRAINT "fk:subtree_fence_manifests:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:subtree_fence_manifests:close" FOREIGN KEY ("source_close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:subtree_fence_manifests:scope_epochs" FOREIGN KEY ("scope_epochs_manifest_value_id", "scope_epochs_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:subtree_fence_manifests:fenced_work" FOREIGN KEY ("fenced_work_manifest_value_id", "fenced_work_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:subtree_fence_manifests:cleanup_keys" FOREIGN KEY ("cleanup_effect_keys_manifest_value_id", "cleanup_effect_keys_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_subtree_fence_manifests:scope_epochs_manifest_hash:hash" CHECK (("scope_epochs_manifest_hash" IS NULL OR (length("scope_epochs_manifest_hash") = 71 AND substr("scope_epochs_manifest_hash", 1, 7) = 'sha256:' AND substr("scope_epochs_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=scope_epochs_manifest_hash */,
  CONSTRAINT "ck:workflow_graph_subtree_fence_manifests:fenced_work_manifest_hash:hash" CHECK (("fenced_work_manifest_hash" IS NULL OR (length("fenced_work_manifest_hash") = 71 AND substr("fenced_work_manifest_hash", 1, 7) = 'sha256:' AND substr("fenced_work_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=fenced_work_manifest_hash */,
  CONSTRAINT "ck:workflow_graph_subtree_fence_manifests:cleanup_effect_keys_manifest_hash:hash" CHECK (("cleanup_effect_keys_manifest_hash" IS NULL OR (length("cleanup_effect_keys_manifest_hash") = 71 AND substr("cleanup_effect_keys_manifest_hash", 1, 7) = 'sha256:' AND substr("cleanup_effect_keys_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=cleanup_effect_keys_manifest_hash */,
  CONSTRAINT "ck:workflow_graph_subtree_fence_manifests:subtree_fence_hash:hash" CHECK (("subtree_fence_hash" IS NULL OR (length("subtree_fence_hash") = 71 AND substr("subtree_fence_hash", 1, 7) = 'sha256:' AND substr("subtree_fence_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=subtree_fence_hash */,
  CONSTRAINT "ck:workflow_graph_subtree_fence_manifests:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_graph_inbox_events" (
  "inbox_seq" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL /* logical_type=integer */,
  "provider_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=adapter_registry reference_domain=signal_provider immutable=1 */,
  "provider_event_id" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=adapter_registry reference_domain=provider_event immutable=1 */,
  "principal_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=principal_identity_resolver reference_domain=principal immutable=1 */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "contract_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "contract_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "correlation_key" TEXT NOT NULL /* logical_type=text */,
  "correlation_key_hash" TEXT NOT NULL /* logical_type=hash */,
  "target_wait_id" TEXT /* logical_type=identifier */,
  "payload_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "payload_hash" TEXT NOT NULL /* logical_type=hash */,
  "byte_length" INTEGER NOT NULL /* logical_type=integer */,
  "ingress_authorization_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "ingress_authorization_hash" TEXT NOT NULL /* logical_type=hash */,
  "binding_authorization_value_id" TEXT /* logical_type=identifier */,
  "binding_authorization_hash" TEXT /* logical_type=hash */,
  "disposition" TEXT NOT NULL /* logical_type=text */,
  "received_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "expires_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "resolved_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "fk:inbox_events:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:inbox_events:run" FOREIGN KEY ("workflow_id", "graph_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:inbox_events:contract" FOREIGN KEY ("contract_resource_id", "contract_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:inbox_events:wait" FOREIGN KEY ("graph_run_id", "target_wait_id") REFERENCES "workflow_graph_waits" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:inbox_events:payload" FOREIGN KEY ("payload_value_id", "payload_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:inbox_events:ingress_auth" FOREIGN KEY ("ingress_authorization_value_id", "ingress_authorization_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:inbox_events:binding_auth" FOREIGN KEY ("binding_authorization_value_id", "binding_authorization_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_inbox_events:inbox_seq:safe_integer" CHECK (("inbox_seq" IS NULL OR "inbox_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=inbox_seq */,
  CONSTRAINT "ck:workflow_graph_inbox_events:contract_resource_hash:hash" CHECK (("contract_resource_hash" IS NULL OR (length("contract_resource_hash") = 71 AND substr("contract_resource_hash", 1, 7) = 'sha256:' AND substr("contract_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=contract_resource_hash */,
  CONSTRAINT "ck:workflow_graph_inbox_events:correlation_key_hash:hash" CHECK (("correlation_key_hash" IS NULL OR (length("correlation_key_hash") = 71 AND substr("correlation_key_hash", 1, 7) = 'sha256:' AND substr("correlation_key_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=correlation_key_hash */,
  CONSTRAINT "ck:workflow_graph_inbox_events:payload_hash:hash" CHECK (("payload_hash" IS NULL OR (length("payload_hash") = 71 AND substr("payload_hash", 1, 7) = 'sha256:' AND substr("payload_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=payload_hash */,
  CONSTRAINT "ck:workflow_graph_inbox_events:byte_length:safe_integer" CHECK (("byte_length" IS NULL OR "byte_length" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=byte_length */,
  CONSTRAINT "ck:workflow_graph_inbox_events:ingress_authorization_hash:hash" CHECK (("ingress_authorization_hash" IS NULL OR (length("ingress_authorization_hash") = 71 AND substr("ingress_authorization_hash", 1, 7) = 'sha256:' AND substr("ingress_authorization_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=ingress_authorization_hash */,
  CONSTRAINT "ck:workflow_graph_inbox_events:binding_authorization_hash:hash" CHECK (("binding_authorization_hash" IS NULL OR (length("binding_authorization_hash") = 71 AND substr("binding_authorization_hash", 1, 7) = 'sha256:' AND substr("binding_authorization_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=binding_authorization_hash */,
  CONSTRAINT "ck:workflow_graph_inbox_events:disposition:enum" CHECK ("disposition" IN ('pending', 'accepted', 'rejected', 'duplicate', 'conflict', 'late', 'unmatched_expired')) /* check_kind=enum_membership logical_columns=disposition */,
  CONSTRAINT "ck:workflow_graph_inbox_events:received_at_ms:safe_integer" CHECK (("received_at_ms" IS NULL OR "received_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=received_at_ms */,
  CONSTRAINT "ck:workflow_graph_inbox_events:expires_at_ms:safe_integer" CHECK (("expires_at_ms" IS NULL OR "expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expires_at_ms */,
  CONSTRAINT "ck:workflow_graph_inbox_events:resolved_at_ms:safe_integer" CHECK (("resolved_at_ms" IS NULL OR "resolved_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resolved_at_ms */,
  CONSTRAINT "ck:inbox_events:disposition_shape" CHECK ((("disposition" = 'pending' AND "resolved_at_ms" IS NULL) OR ("disposition" <> 'pending' AND "resolved_at_ms" IS NOT NULL)) AND ("disposition" NOT IN ('accepted', 'rejected') OR "binding_authorization_value_id" IS NOT NULL)) /* check_kind=state_field_consistency logical_columns=disposition,target_wait_id,binding_authorization_value_id,resolved_at_ms */
);

CREATE TABLE "workflow_graph_late_results" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "node_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_id" TEXT /* logical_type=identifier */,
  "wait_id" TEXT /* logical_type=identifier */,
  "source_event_id" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=callback_ingress_registry reference_domain=callback_event immutable=1 */,
  "payload_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "payload_hash" TEXT NOT NULL /* logical_type=hash */,
  "fence_reason" TEXT NOT NULL /* logical_type=text */,
  "received_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_late_results" PRIMARY KEY ("id"),
  CONSTRAINT "fk:late_results:node" FOREIGN KEY ("graph_run_id", "scope_id", "node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:late_results:attempt" FOREIGN KEY ("graph_run_id", "attempt_id") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:late_results:wait" FOREIGN KEY ("graph_run_id", "wait_id") REFERENCES "workflow_graph_waits" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:late_results:payload" FOREIGN KEY ("payload_value_id", "payload_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_late_results:payload_hash:hash" CHECK (("payload_hash" IS NULL OR (length("payload_hash") = 71 AND substr("payload_hash", 1, 7) = 'sha256:' AND substr("payload_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=payload_hash */,
  CONSTRAINT "ck:workflow_graph_late_results:received_at_ms:safe_integer" CHECK (("received_at_ms" IS NULL OR "received_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=received_at_ms */,
  CONSTRAINT "ck:workflow_graph_late_results:attempt_id:wait_id:exactly_one" CHECK ((("attempt_id" IS NOT NULL) + ("wait_id" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=attempt_id,wait_id */
);

CREATE TABLE "workflow_graph_effect_operations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "node_id" TEXT NOT NULL /* logical_type=identifier */,
  "attempt_id" TEXT NOT NULL /* logical_type=identifier */,
  "operation_key" TEXT NOT NULL /* logical_type=text */,
  "key_strategy_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "key_strategy_hash" TEXT NOT NULL /* logical_type=hash */,
  "execution_lane" TEXT NOT NULL /* logical_type=text */,
  "close_request_id" TEXT /* logical_type=identifier */,
  "effect_type" TEXT NOT NULL /* logical_type=text */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "request_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "receipt_value_id" TEXT /* logical_type=identifier */,
  "receipt_hash" TEXT /* logical_type=hash */,
  "before_state_value_id" TEXT /* logical_type=identifier */,
  "before_state_hash" TEXT /* logical_type=hash */,
  "after_state_value_id" TEXT /* logical_type=identifier */,
  "after_state_hash" TEXT /* logical_type=hash */,
  "immutable_output_snapshot_value_id" TEXT /* logical_type=identifier */,
  "immutable_output_snapshot_hash" TEXT /* logical_type=hash */,
  "compensation_value_id" TEXT /* logical_type=identifier */,
  "compensation_hash" TEXT /* logical_type=hash */,
  "lease_owner" TEXT /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "lease_token" TEXT /* logical_type=text */,
  "lease_expires_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_effect_operations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:effect_operations:attempt" FOREIGN KEY ("graph_run_id", "scope_id", "node_id", "attempt_id") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_operations:close" FOREIGN KEY ("close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_operations:request" FOREIGN KEY ("request_value_id", "request_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_operations:receipt" FOREIGN KEY ("receipt_value_id", "receipt_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_operations:before" FOREIGN KEY ("before_state_value_id", "before_state_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_operations:after" FOREIGN KEY ("after_state_value_id", "after_state_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_operations:output" FOREIGN KEY ("immutable_output_snapshot_value_id", "immutable_output_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:effect_operations:compensation" FOREIGN KEY ("compensation_value_id", "compensation_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_effect_operations:key_strategy_hash:hash" CHECK (("key_strategy_hash" IS NULL OR (length("key_strategy_hash") = 71 AND substr("key_strategy_hash", 1, 7) = 'sha256:' AND substr("key_strategy_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=key_strategy_hash */,
  CONSTRAINT "ck:workflow_graph_effect_operations:execution_lane:enum" CHECK ("execution_lane" IN ('normal', 'close_cleanup')) /* check_kind=enum_membership logical_columns=execution_lane */,
  CONSTRAINT "ck:workflow_graph_effect_operations:status:enum" CHECK ("status" IN ('intended', 'dispatched', 'succeeded', 'failed', 'compensation_pending', 'compensated', 'compensation_not_required', 'action_required')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_graph_effect_operations:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_graph_effect_operations:receipt_hash:hash" CHECK (("receipt_hash" IS NULL OR (length("receipt_hash") = 71 AND substr("receipt_hash", 1, 7) = 'sha256:' AND substr("receipt_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=receipt_hash */,
  CONSTRAINT "ck:workflow_graph_effect_operations:before_state_hash:hash" CHECK (("before_state_hash" IS NULL OR (length("before_state_hash") = 71 AND substr("before_state_hash", 1, 7) = 'sha256:' AND substr("before_state_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=before_state_hash */,
  CONSTRAINT "ck:workflow_graph_effect_operations:after_state_hash:hash" CHECK (("after_state_hash" IS NULL OR (length("after_state_hash") = 71 AND substr("after_state_hash", 1, 7) = 'sha256:' AND substr("after_state_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=after_state_hash */,
  CONSTRAINT "ck:workflow_graph_effect_operations:immutable_output_snapshot_hash:hash" CHECK (("immutable_output_snapshot_hash" IS NULL OR (length("immutable_output_snapshot_hash") = 71 AND substr("immutable_output_snapshot_hash", 1, 7) = 'sha256:' AND substr("immutable_output_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=immutable_output_snapshot_hash */,
  CONSTRAINT "ck:workflow_graph_effect_operations:compensation_hash:hash" CHECK (("compensation_hash" IS NULL OR (length("compensation_hash") = 71 AND substr("compensation_hash", 1, 7) = 'sha256:' AND substr("compensation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=compensation_hash */,
  CONSTRAINT "ck:workflow_graph_effect_operations:lease_expires_at_ms:safe_integer" CHECK (("lease_expires_at_ms" IS NULL OR "lease_expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_graph_effect_operations:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:workflow_graph_effect_operations:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_effect_operations:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_graph_effect_operations:lease_owner:lease_token:pair" CHECK ((("lease_owner" IS NULL AND "lease_token" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_token */,
  CONSTRAINT "ck:workflow_graph_effect_operations:lease_owner:lease_expires_at_ms:pair" CHECK ((("lease_owner" IS NULL AND "lease_expires_at_ms" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_expires_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_expires_at_ms */,
  CONSTRAINT "ck:effect_operations:lane_close" CHECK ((("execution_lane" = 'normal' AND "close_request_id" IS NULL) OR ("execution_lane" = 'close_cleanup' AND "close_request_id" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=execution_lane,close_request_id */,
  CONSTRAINT "ck:effect_operations:status_shape" CHECK ((("status" IN ('intended', 'dispatched') AND "receipt_value_id" IS NULL AND "compensation_value_id" IS NULL) OR ("status" = 'succeeded' AND "receipt_value_id" IS NOT NULL AND "after_state_value_id" IS NOT NULL AND "immutable_output_snapshot_value_id" IS NOT NULL) OR ("status" IN ('failed', 'action_required')) OR ("status" = 'compensation_pending' AND "compensation_value_id" IS NULL) OR ("status" IN ('compensated', 'compensation_not_required') AND "compensation_value_id" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=status,receipt_value_id,before_state_value_id,after_state_value_id,immutable_output_snapshot_value_id,compensation_value_id */
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

CREATE TABLE "workflow_graph_facts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "scope_id" TEXT NOT NULL /* logical_type=identifier */,
  "event_seq" INTEGER NOT NULL /* logical_type=integer */,
  "causal_event_seq" INTEGER /* logical_type=integer */,
  "causal_wave" INTEGER NOT NULL /* logical_type=integer */,
  "fact_kind" TEXT NOT NULL /* logical_type=text */,
  "stable_object_kind" TEXT NOT NULL /* logical_type=text */,
  "stable_object_id" TEXT NOT NULL /* logical_type=text */,
  "fact_key" TEXT NOT NULL /* logical_type=text */,
  "payload_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "payload_hash" TEXT NOT NULL /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_facts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:facts:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:facts:event" FOREIGN KEY ("graph_run_id", "event_seq") REFERENCES "workflow_graph_events" ("graph_run_id", "seq") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:facts:payload" FOREIGN KEY ("payload_value_id", "payload_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_facts:event_seq:safe_integer" CHECK (("event_seq" IS NULL OR "event_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=event_seq */,
  CONSTRAINT "ck:workflow_graph_facts:causal_event_seq:safe_integer" CHECK (("causal_event_seq" IS NULL OR "causal_event_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=causal_event_seq */,
  CONSTRAINT "ck:workflow_graph_facts:causal_wave:safe_integer" CHECK (("causal_wave" IS NULL OR "causal_wave" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=causal_wave */,
  CONSTRAINT "ck:workflow_graph_facts:fact_kind:enum" CHECK ("fact_kind" IN ('node_terminal', 'node_output_published', 'wait_resolved', 'build_failed', 'control_edge_resolved', 'data_edge_resolved', 'trigger_decided', 'input_sealed', 'node_ready', 'node_skipped', 'terminal_candidate', 'completion_eligibility', 'orchestration_error')) /* check_kind=enum_membership logical_columns=fact_kind */,
  CONSTRAINT "ck:workflow_graph_facts:payload_hash:hash" CHECK (("payload_hash" IS NULL OR (length("payload_hash") = 71 AND substr("payload_hash", 1, 7) = 'sha256:' AND substr("payload_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=payload_hash */,
  CONSTRAINT "ck:workflow_graph_facts:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
);

CREATE TABLE "workflow_graph_events" (
  "graph_run_id" TEXT NOT NULL /* logical_type=identifier */,
  "seq" INTEGER NOT NULL /* logical_type=integer */,
  "scope_id" TEXT /* logical_type=identifier */,
  "node_id" TEXT /* logical_type=identifier */,
  "attempt_id" TEXT /* logical_type=identifier */,
  "event_type" TEXT NOT NULL /* logical_type=text */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "payload_json" TEXT /* logical_type=canonical_json */,
  "payload_value_id" TEXT /* logical_type=identifier */,
  "payload_hash" TEXT /* logical_type=hash */,
  "occurred_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_graph_events" PRIMARY KEY ("graph_run_id", "seq"),
  CONSTRAINT "fk:events:run" FOREIGN KEY ("graph_run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:scope" FOREIGN KEY ("graph_run_id", "scope_id") REFERENCES "workflow_graph_scopes" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:node" FOREIGN KEY ("graph_run_id", "scope_id", "node_id") REFERENCES "workflow_graph_nodes" ("graph_run_id", "scope_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:attempt" FOREIGN KEY ("graph_run_id", "attempt_id") REFERENCES "workflow_graph_node_attempts" ("graph_run_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:events:payload" FOREIGN KEY ("payload_value_id", "payload_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_graph_events:seq:safe_integer" CHECK (("seq" IS NULL OR "seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=seq */,
  CONSTRAINT "ck:workflow_graph_events:event_type:enum" CHECK ("event_type" IN ('node_terminal', 'node_output_published', 'wait_resolved', 'build_failed', 'control_edge_resolved', 'data_edge_resolved', 'trigger_decided', 'input_sealed', 'node_ready', 'node_skipped', 'terminal_candidate', 'completion_eligibility', 'orchestration_error', 'workflow_created', 'state_activation_created', 'run_created', 'scope_materialized', 'expansion_sealed', 'scheduler_admitted', 'attempt_created', 'attempt_phase_changed', 'retry_schedule_created', 'retry_schedule_consumed', 'wait_armed', 'scope_close_requested', 'subtree_fenced', 'effect_operation_changed', 'compensation_changed', 'completion_cut_committed', 'child_completion_consumed', 'run_control_changed', 'operational_blocker_changed', 'runtime_command_decided', 'workflow_transition_committed', 'workflow_terminal_committed', 'root_finalization_changed', 'domain_claim_changed', 'ledger_posting_committed', 'recovery_decision_recorded')) /* check_kind=enum_membership logical_columns=event_type */,
  CONSTRAINT "ck:workflow_graph_events:payload_hash:hash" CHECK (("payload_hash" IS NULL OR (length("payload_hash") = 71 AND substr("payload_hash", 1, 7) = 'sha256:' AND substr("payload_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=payload_hash */,
  CONSTRAINT "ck:workflow_graph_events:occurred_at_ms:safe_integer" CHECK (("occurred_at_ms" IS NULL OR "occurred_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=occurred_at_ms */,
  CONSTRAINT "ck:workflow_graph_events:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_graph_events:payload_json:payload_value_id:at_most_one" CHECK ((("payload_json" IS NOT NULL) + ("payload_value_id" IS NOT NULL)) <= 1) /* check_kind=at_most_one logical_columns=payload_json,payload_value_id */
);

CREATE TABLE "workflow_outbox" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "effect_key" TEXT NOT NULL /* logical_type=text */,
  "workflow_id" TEXT /* logical_type=identifier */,
  "attempt_id" TEXT /* logical_type=identifier */,
  "wait_id" TEXT /* logical_type=identifier */,
  "effect_operation_id" TEXT /* logical_type=identifier */,
  "domain_claim_id" TEXT /* logical_type=identifier */,
  "projection_target_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=projection_target_registry reference_domain=projection_target immutable=1 */,
  "aggregate_row_version" INTEGER /* logical_type=integer */,
  "effect_type" TEXT NOT NULL /* logical_type=text */,
  "adapter_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "adapter_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "delivery_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "delivery_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "policy_snapshot_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "policy_snapshot_hash" TEXT NOT NULL /* logical_type=hash */,
  "delivery_lane" TEXT NOT NULL /* logical_type=text */,
  "delivery_requirement" TEXT NOT NULL /* logical_type=text */,
  "payload_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "payload_hash" TEXT NOT NULL /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "delivery_attempt_count" INTEGER NOT NULL /* logical_type=integer */,
  "reconcile_attempt_count" INTEGER NOT NULL /* logical_type=integer */,
  "next_attempt_at_ms" INTEGER /* logical_type=integer */,
  "deadline_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "lease_owner" TEXT /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "lease_token" TEXT /* logical_type=text */,
  "lease_expires_at_ms" INTEGER /* logical_type=integer */,
  "last_result_kind" TEXT /* logical_type=text */,
  "last_error_code" TEXT /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "delivered_at_ms" INTEGER /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_outbox" PRIMARY KEY ("id"),
  CONSTRAINT "fk:outbox:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:attempt" FOREIGN KEY ("attempt_id") REFERENCES "workflow_graph_node_attempts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:wait" FOREIGN KEY ("wait_id") REFERENCES "workflow_graph_waits" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:effect" FOREIGN KEY ("effect_operation_id") REFERENCES "workflow_graph_effect_operations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:claim" FOREIGN KEY ("domain_claim_id") REFERENCES "workflow_domain_resource_claims" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:adapter" FOREIGN KEY ("adapter_resource_id", "adapter_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:delivery_policy" FOREIGN KEY ("delivery_policy_resource_id", "delivery_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:policy_snapshot" FOREIGN KEY ("policy_snapshot_value_id", "policy_snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox:payload" FOREIGN KEY ("payload_value_id", "payload_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_outbox:aggregate_row_version:safe_integer" CHECK (("aggregate_row_version" IS NULL OR "aggregate_row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=aggregate_row_version */,
  CONSTRAINT "ck:workflow_outbox:adapter_resource_hash:hash" CHECK (("adapter_resource_hash" IS NULL OR (length("adapter_resource_hash") = 71 AND substr("adapter_resource_hash", 1, 7) = 'sha256:' AND substr("adapter_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=adapter_resource_hash */,
  CONSTRAINT "ck:workflow_outbox:delivery_policy_resource_hash:hash" CHECK (("delivery_policy_resource_hash" IS NULL OR (length("delivery_policy_resource_hash") = 71 AND substr("delivery_policy_resource_hash", 1, 7) = 'sha256:' AND substr("delivery_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=delivery_policy_resource_hash */,
  CONSTRAINT "ck:workflow_outbox:policy_snapshot_hash:hash" CHECK (("policy_snapshot_hash" IS NULL OR (length("policy_snapshot_hash") = 71 AND substr("policy_snapshot_hash", 1, 7) = 'sha256:' AND substr("policy_snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=policy_snapshot_hash */,
  CONSTRAINT "ck:workflow_outbox:delivery_lane:enum" CHECK ("delivery_lane" IN ('normal_execution', 'close_cleanup', 'system_projection')) /* check_kind=enum_membership logical_columns=delivery_lane */,
  CONSTRAINT "ck:workflow_outbox:delivery_requirement:enum" CHECK ("delivery_requirement" IN ('required', 'best_effort')) /* check_kind=enum_membership logical_columns=delivery_requirement */,
  CONSTRAINT "ck:workflow_outbox:payload_hash:hash" CHECK (("payload_hash" IS NULL OR (length("payload_hash") = 71 AND substr("payload_hash", 1, 7) = 'sha256:' AND substr("payload_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=payload_hash */,
  CONSTRAINT "ck:workflow_outbox:status:enum" CHECK ("status" IN ('pending', 'processing', 'reconciling', 'succeeded', 'dead_letter', 'action_required')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_outbox:delivery_attempt_count:safe_integer" CHECK (("delivery_attempt_count" IS NULL OR "delivery_attempt_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=delivery_attempt_count */,
  CONSTRAINT "ck:workflow_outbox:reconcile_attempt_count:safe_integer" CHECK (("reconcile_attempt_count" IS NULL OR "reconcile_attempt_count" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=reconcile_attempt_count */,
  CONSTRAINT "ck:workflow_outbox:next_attempt_at_ms:safe_integer" CHECK (("next_attempt_at_ms" IS NULL OR "next_attempt_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_attempt_at_ms */,
  CONSTRAINT "ck:workflow_outbox:deadline_at_ms:safe_integer" CHECK (("deadline_at_ms" IS NULL OR "deadline_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=deadline_at_ms */,
  CONSTRAINT "ck:workflow_outbox:lease_expires_at_ms:safe_integer" CHECK (("lease_expires_at_ms" IS NULL OR "lease_expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_outbox:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_outbox:delivered_at_ms:safe_integer" CHECK (("delivered_at_ms" IS NULL OR "delivered_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=delivered_at_ms */,
  CONSTRAINT "ck:workflow_outbox:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:workflow_outbox:lease_owner:lease_token:pair" CHECK ((("lease_owner" IS NULL AND "lease_token" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_token" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_token */,
  CONSTRAINT "ck:workflow_outbox:lease_owner:lease_expires_at_ms:pair" CHECK ((("lease_owner" IS NULL AND "lease_expires_at_ms" IS NULL) OR ("lease_owner" IS NOT NULL AND "lease_expires_at_ms" IS NOT NULL))) /* check_kind=all_or_none logical_columns=lease_owner,lease_expires_at_ms */,
  CONSTRAINT "ck:workflow_outbox:workflow_id:attempt_id:wait_id:effect_operation_id:domain_claim_id:projection_target_ref:exactly_one" CHECK ((("workflow_id" IS NOT NULL) + ("attempt_id" IS NOT NULL) + ("wait_id" IS NOT NULL) + ("effect_operation_id" IS NOT NULL) + ("domain_claim_id" IS NOT NULL) + ("projection_target_ref" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=workflow_id,attempt_id,wait_id,effect_operation_id,domain_claim_id,projection_target_ref */,
  CONSTRAINT "ck:outbox:aggregate_version" CHECK ((("projection_target_ref" IS NOT NULL AND "aggregate_row_version" IS NULL) OR ("projection_target_ref" IS NULL AND "aggregate_row_version" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=projection_target_ref,aggregate_row_version */,
  CONSTRAINT "ck:outbox:status_time" CHECK ((("status" = 'succeeded' AND "delivered_at_ms" IS NOT NULL AND "last_result_kind" IS NOT NULL AND "last_error_code" IS NULL) OR ("status" <> 'succeeded' AND "delivered_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,delivered_at_ms,last_result_kind,last_error_code */
);

CREATE TABLE "workflow_outbox_attempts" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "outbox_id" TEXT NOT NULL /* logical_type=identifier */,
  "history_seq" INTEGER NOT NULL /* logical_type=integer */,
  "attempt_kind" TEXT NOT NULL /* logical_type=text */,
  "kind_attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "adapter_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "adapter_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "policy_hash" TEXT NOT NULL /* logical_type=hash */,
  "lease_owner" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=runtime_worker_registry reference_domain=worker_lease immutable=0 */,
  "lease_token" TEXT NOT NULL /* logical_type=text */,
  "request_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "result_kind" TEXT NOT NULL /* logical_type=text */,
  "result_code" TEXT /* logical_type=text */,
  "receipt_value_id" TEXT /* logical_type=identifier */,
  "receipt_hash" TEXT /* logical_type=hash */,
  "external_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=adapter_registry reference_domain=provider_result immutable=1 */,
  "started_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finished_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "next_attempt_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_outbox_attempts" PRIMARY KEY ("id"),
  CONSTRAINT "fk:outbox_attempts:outbox" FOREIGN KEY ("outbox_id") REFERENCES "workflow_outbox" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox_attempts:adapter" FOREIGN KEY ("adapter_resource_id", "adapter_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox_attempts:request" FOREIGN KEY ("request_value_id", "request_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:outbox_attempts:receipt" FOREIGN KEY ("receipt_value_id", "receipt_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_outbox_attempts:history_seq:safe_integer" CHECK (("history_seq" IS NULL OR "history_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=history_seq */,
  CONSTRAINT "ck:workflow_outbox_attempts:attempt_kind:enum" CHECK ("attempt_kind" IN ('deliver', 'reconcile')) /* check_kind=enum_membership logical_columns=attempt_kind */,
  CONSTRAINT "ck:workflow_outbox_attempts:kind_attempt_no:safe_integer" CHECK (("kind_attempt_no" IS NULL OR "kind_attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=kind_attempt_no */,
  CONSTRAINT "ck:workflow_outbox_attempts:adapter_resource_hash:hash" CHECK (("adapter_resource_hash" IS NULL OR (length("adapter_resource_hash") = 71 AND substr("adapter_resource_hash", 1, 7) = 'sha256:' AND substr("adapter_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=adapter_resource_hash */,
  CONSTRAINT "ck:workflow_outbox_attempts:policy_hash:hash" CHECK (("policy_hash" IS NULL OR (length("policy_hash") = 71 AND substr("policy_hash", 1, 7) = 'sha256:' AND substr("policy_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=policy_hash */,
  CONSTRAINT "ck:workflow_outbox_attempts:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_outbox_attempts:receipt_hash:hash" CHECK (("receipt_hash" IS NULL OR (length("receipt_hash") = 71 AND substr("receipt_hash", 1, 7) = 'sha256:' AND substr("receipt_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=receipt_hash */,
  CONSTRAINT "ck:workflow_outbox_attempts:started_at_ms:safe_integer" CHECK (("started_at_ms" IS NULL OR "started_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=started_at_ms */,
  CONSTRAINT "ck:workflow_outbox_attempts:finished_at_ms:safe_integer" CHECK (("finished_at_ms" IS NULL OR "finished_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finished_at_ms */,
  CONSTRAINT "ck:workflow_outbox_attempts:next_attempt_at_ms:safe_integer" CHECK (("next_attempt_at_ms" IS NULL OR "next_attempt_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=next_attempt_at_ms */,
  CONSTRAINT "ck:workflow_outbox_attempts:receipt_value_id:receipt_hash:pair" CHECK ((("receipt_value_id" IS NULL AND "receipt_hash" IS NULL) OR ("receipt_value_id" IS NOT NULL AND "receipt_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=receipt_value_id,receipt_hash */
);

CREATE TABLE "workflow_runtime_commands" (
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "idempotency_domain" TEXT NOT NULL /* logical_type=text */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "command_type" TEXT NOT NULL /* logical_type=text */,
  "workflow_id" TEXT /* logical_type=identifier */,
  "run_id" TEXT /* logical_type=identifier */,
  "node_id" TEXT /* logical_type=identifier */,
  "retry_schedule_id" TEXT /* logical_type=identifier */,
  "effect_operation_id" TEXT /* logical_type=identifier */,
  "operational_blocker_id" TEXT /* logical_type=identifier */,
  "expected_row_version" INTEGER NOT NULL /* logical_type=integer */,
  "reason_code" TEXT NOT NULL /* logical_type=text */,
  "reason_text_value_id" TEXT /* logical_type=identifier */,
  "reason_text_hash" TEXT /* logical_type=hash */,
  "evidence_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "evidence_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "canonical_result_value_id" TEXT /* logical_type=identifier */,
  "canonical_result_hash" TEXT /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finalized_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_runtime_commands" PRIMARY KEY ("command_id"),
  CONSTRAINT "fk:runtime_commands:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:run" FOREIGN KEY ("run_id") REFERENCES "workflow_graph_runs" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:node" FOREIGN KEY ("node_id") REFERENCES "workflow_graph_nodes" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:retry" FOREIGN KEY ("retry_schedule_id") REFERENCES "workflow_graph_retry_schedules" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:effect" FOREIGN KEY ("effect_operation_id") REFERENCES "workflow_graph_effect_operations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:blocker" FOREIGN KEY ("operational_blocker_id") REFERENCES "workflow_operational_blockers" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:reason_text" FOREIGN KEY ("reason_text_value_id", "reason_text_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:evidence" FOREIGN KEY ("evidence_manifest_value_id", "evidence_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:runtime_commands:result" FOREIGN KEY ("canonical_result_value_id", "canonical_result_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_runtime_commands:command_type:enum" CHECK ("command_type" IN ('pause_run', 'resume_run', 'cancel_run', 'cancel_workflow', 'skip_node', 'advance_retry_schedule', 'reconcile_effect', 'submit_effect_receipt', 'verify_effect_not_applied', 'remediate_operational_blocker', 'restore_integrity', 'request_administrative_abandon', 'confirm_administrative_abandon')) /* check_kind=enum_membership logical_columns=command_type */,
  CONSTRAINT "ck:workflow_runtime_commands:expected_row_version:safe_integer" CHECK (("expected_row_version" IS NULL OR "expected_row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expected_row_version */,
  CONSTRAINT "ck:workflow_runtime_commands:reason_code:enum" CHECK ("reason_code" IN ('operator_requested', 'investigation', 'superseded', 'invalid_input', 'no_longer_needed', 'dependency_recovered', 'credential_restored', 'receipt_recovered', 'provider_reconciled', 'not_applied_verified', 'backup_restored', 'hash_revalidated', 'deadline_enforced', 'safety_enforced', 'unrecoverable_state', 'external_effect_unverifiable', 'data_loss_accepted')) /* check_kind=enum_membership logical_columns=reason_code */,
  CONSTRAINT "ck:workflow_runtime_commands:reason_text_hash:hash" CHECK (("reason_text_hash" IS NULL OR (length("reason_text_hash") = 71 AND substr("reason_text_hash", 1, 7) = 'sha256:' AND substr("reason_text_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=reason_text_hash */,
  CONSTRAINT "ck:workflow_runtime_commands:evidence_manifest_hash:hash" CHECK (("evidence_manifest_hash" IS NULL OR (length("evidence_manifest_hash") = 71 AND substr("evidence_manifest_hash", 1, 7) = 'sha256:' AND substr("evidence_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=evidence_manifest_hash */,
  CONSTRAINT "ck:workflow_runtime_commands:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_runtime_commands:canonical_result_hash:hash" CHECK (("canonical_result_hash" IS NULL OR (length("canonical_result_hash") = 71 AND substr("canonical_result_hash", 1, 7) = 'sha256:' AND substr("canonical_result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_result_hash */,
  CONSTRAINT "ck:workflow_runtime_commands:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_runtime_commands:finalized_at_ms:safe_integer" CHECK (("finalized_at_ms" IS NULL OR "finalized_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finalized_at_ms */,
  CONSTRAINT "ck:workflow_runtime_commands:reason_text_value_id:reason_text_hash:pair" CHECK ((("reason_text_value_id" IS NULL AND "reason_text_hash" IS NULL) OR ("reason_text_value_id" IS NOT NULL AND "reason_text_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=reason_text_value_id,reason_text_hash */,
  CONSTRAINT "ck:workflow_runtime_commands:canonical_result_value_id:canonical_result_hash:pair" CHECK ((("canonical_result_value_id" IS NULL AND "canonical_result_hash" IS NULL) OR ("canonical_result_value_id" IS NOT NULL AND "canonical_result_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=canonical_result_value_id,canonical_result_hash */,
  CONSTRAINT "ck:workflow_runtime_commands:workflow_id:run_id:node_id:retry_schedule_id:effect_operation_id:operational_blocker_id:exactly_one" CHECK ((("workflow_id" IS NOT NULL) + ("run_id" IS NOT NULL) + ("node_id" IS NOT NULL) + ("retry_schedule_id" IS NOT NULL) + ("effect_operation_id" IS NOT NULL) + ("operational_blocker_id" IS NOT NULL)) = 1) /* check_kind=exactly_one logical_columns=workflow_id,run_id,node_id,retry_schedule_id,effect_operation_id,operational_blocker_id */,
  CONSTRAINT "ck:runtime_commands:target_mapping" CHECK ((("command_type" IN ('cancel_workflow', 'request_administrative_abandon', 'confirm_administrative_abandon') AND "workflow_id" IS NOT NULL) OR ("command_type" IN ('pause_run', 'resume_run', 'cancel_run') AND "run_id" IS NOT NULL) OR ("command_type" = 'skip_node' AND "node_id" IS NOT NULL) OR ("command_type" = 'advance_retry_schedule' AND "retry_schedule_id" IS NOT NULL) OR ("command_type" IN ('reconcile_effect', 'submit_effect_receipt', 'verify_effect_not_applied') AND "effect_operation_id" IS NOT NULL) OR ("command_type" IN ('remediate_operational_blocker', 'restore_integrity') AND "operational_blocker_id" IS NOT NULL))) /* check_kind=closed_target_mapping logical_columns=command_type,workflow_id,run_id,node_id,retry_schedule_id,effect_operation_id,operational_blocker_id */,
  CONSTRAINT "ck:runtime_commands:finalization" CHECK ((("canonical_result_value_id" IS NULL AND "finalized_at_ms" IS NULL) OR ("canonical_result_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=canonical_result_value_id,finalized_at_ms */
);

CREATE TABLE "workflow_runtime_command_invocations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "invocation_no" INTEGER NOT NULL /* logical_type=integer */,
  "submitted_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=command_actor_registry reference_domain=command_actor immutable=1 */,
  "actor_kind" TEXT NOT NULL /* logical_type=text */,
  "auth_session_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=authentication_session_registry reference_domain=auth_session immutable=1 */,
  "entrypoint" TEXT NOT NULL /* logical_type=text */,
  "source_feature_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "delegation_chain_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=delegation_authorization_registry reference_domain=delegation_chain immutable=1 */,
  "required_permission" TEXT NOT NULL /* logical_type=text */,
  "command_policy_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "command_policy_resource_hash" TEXT NOT NULL /* logical_type=hash */,
  "authorization_result" TEXT NOT NULL /* logical_type=text */,
  "execution_result" TEXT NOT NULL /* logical_type=text */,
  "target_before_hash" TEXT /* logical_type=hash */,
  "target_after_hash" TEXT /* logical_type=hash */,
  "resulting_event_seq" INTEGER /* logical_type=integer */,
  "close_request_id" TEXT /* logical_type=identifier */,
  "effect_operation_id" TEXT /* logical_type=identifier */,
  "requested_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "decided_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "applied_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:workflow_runtime_command_invocations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:command_invocations:command" FOREIGN KEY ("command_id") REFERENCES "workflow_runtime_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:command_invocations:policy" FOREIGN KEY ("command_policy_resource_id", "command_policy_resource_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:command_invocations:close" FOREIGN KEY ("close_request_id") REFERENCES "workflow_graph_scope_close_requests" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:command_invocations:effect" FOREIGN KEY ("effect_operation_id") REFERENCES "workflow_graph_effect_operations" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_runtime_command_invocations:invocation_no:safe_integer" CHECK (("invocation_no" IS NULL OR "invocation_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=invocation_no */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:submitted_request_hash:hash" CHECK (("submitted_request_hash" IS NULL OR (length("submitted_request_hash") = 71 AND substr("submitted_request_hash", 1, 7) = 'sha256:' AND substr("submitted_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=submitted_request_hash */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:actor_kind:enum" CHECK ("actor_kind" IN ('human', 'feature_service', 'automation', 'system')) /* check_kind=enum_membership logical_columns=actor_kind */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:required_permission:enum" CHECK ("required_permission" IN ('workflow.operate', 'workflow.cancel.own', 'workflow.cancel.any', 'workflow.node.skip', 'workflow.retry.advance', 'workflow.effect.remediate', 'workflow.blocker.remediate', 'workflow.integrity.restore', 'workflow.administrative_abandon')) /* check_kind=enum_membership logical_columns=required_permission */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:command_policy_resource_hash:hash" CHECK (("command_policy_resource_hash" IS NULL OR (length("command_policy_resource_hash") = 71 AND substr("command_policy_resource_hash", 1, 7) = 'sha256:' AND substr("command_policy_resource_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=command_policy_resource_hash */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:authorization_result:enum" CHECK ("authorization_result" IN ('allowed', 'denied')) /* check_kind=enum_membership logical_columns=authorization_result */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:execution_result:enum" CHECK ("execution_result" IN ('applied', 'denied', 'conflict', 'duplicate', 'late')) /* check_kind=enum_membership logical_columns=execution_result */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:target_before_hash:hash" CHECK (("target_before_hash" IS NULL OR (length("target_before_hash") = 71 AND substr("target_before_hash", 1, 7) = 'sha256:' AND substr("target_before_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=target_before_hash */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:target_after_hash:hash" CHECK (("target_after_hash" IS NULL OR (length("target_after_hash") = 71 AND substr("target_after_hash", 1, 7) = 'sha256:' AND substr("target_after_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=target_after_hash */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:resulting_event_seq:safe_integer" CHECK (("resulting_event_seq" IS NULL OR "resulting_event_seq" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=resulting_event_seq */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:requested_at_ms:safe_integer" CHECK (("requested_at_ms" IS NULL OR "requested_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=requested_at_ms */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:decided_at_ms:safe_integer" CHECK (("decided_at_ms" IS NULL OR "decided_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=decided_at_ms */,
  CONSTRAINT "ck:workflow_runtime_command_invocations:applied_at_ms:safe_integer" CHECK (("applied_at_ms" IS NULL OR "applied_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=applied_at_ms */,
  CONSTRAINT "ck:command_invocations:execution_shape" CHECK ((("authorization_result" = 'denied' AND "execution_result" = 'denied' AND "target_after_hash" IS NULL AND "resulting_event_seq" IS NULL AND "close_request_id" IS NULL AND "effect_operation_id" IS NULL AND "applied_at_ms" IS NULL) OR ("authorization_result" = 'allowed' AND (("execution_result" = 'applied' AND "applied_at_ms" IS NOT NULL) OR ("execution_result" IN ('conflict', 'duplicate', 'late') AND "target_after_hash" IS NULL AND "applied_at_ms" IS NULL))))) /* check_kind=state_field_consistency logical_columns=authorization_result,execution_result,target_before_hash,target_after_hash,resulting_event_seq,close_request_id,effect_operation_id,applied_at_ms */
);

CREATE TABLE "workflow_runtime_command_confirmations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "request_command_id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=command_actor_registry reference_domain=command_actor immutable=1 */,
  "auth_session_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=authentication_session_registry reference_domain=auth_session immutable=1 */,
  "expected_workflow_row_version" INTEGER NOT NULL /* logical_type=integer */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "evidence_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "evidence_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "status" TEXT NOT NULL /* logical_type=text */,
  "expires_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "consumed_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_runtime_command_confirmations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:command_confirmations:command" FOREIGN KEY ("request_command_id") REFERENCES "workflow_runtime_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:command_confirmations:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:command_confirmations:evidence" FOREIGN KEY ("evidence_manifest_value_id", "evidence_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_runtime_command_confirmations:expected_workflow_row_version:safe_integer" CHECK (("expected_workflow_row_version" IS NULL OR "expected_workflow_row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expected_workflow_row_version */,
  CONSTRAINT "ck:workflow_runtime_command_confirmations:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_runtime_command_confirmations:evidence_manifest_hash:hash" CHECK (("evidence_manifest_hash" IS NULL OR (length("evidence_manifest_hash") = 71 AND substr("evidence_manifest_hash", 1, 7) = 'sha256:' AND substr("evidence_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=evidence_manifest_hash */,
  CONSTRAINT "ck:workflow_runtime_command_confirmations:status:enum" CHECK ("status" IN ('pending', 'consumed', 'expired')) /* check_kind=enum_membership logical_columns=status */,
  CONSTRAINT "ck:workflow_runtime_command_confirmations:expires_at_ms:safe_integer" CHECK (("expires_at_ms" IS NULL OR "expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expires_at_ms */,
  CONSTRAINT "ck:workflow_runtime_command_confirmations:consumed_at_ms:safe_integer" CHECK (("consumed_at_ms" IS NULL OR "consumed_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=consumed_at_ms */,
  CONSTRAINT "ck:workflow_runtime_command_confirmations:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:command_confirmations:status_time" CHECK ((("status" = 'consumed' AND "consumed_at_ms" IS NOT NULL) OR ("status" IN ('pending', 'expired') AND "consumed_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=status,expires_at_ms,consumed_at_ms */,
  CONSTRAINT "ck:command_confirmations:ttl" CHECK ("expires_at_ms" >= 300000) /* check_kind=ordered_values logical_columns=expires_at_ms */
);

CREATE TABLE "workflow_checkpoints" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "workflow_id" TEXT NOT NULL /* logical_type=identifier */,
  "checkpoint_version" INTEGER NOT NULL /* logical_type=integer */,
  "workflow_revision" INTEGER NOT NULL /* logical_type=integer */,
  "source_state_instance_id" TEXT /* logical_type=identifier */,
  "source_run_id" TEXT /* logical_type=identifier */,
  "completion_cut_id" TEXT /* logical_type=identifier */,
  "snapshot_json" TEXT /* logical_type=canonical_json */,
  "snapshot_value_id" TEXT /* logical_type=identifier */,
  "snapshot_hash" TEXT /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_checkpoints" PRIMARY KEY ("id"),
  CONSTRAINT "fk:checkpoints:workflow" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:checkpoints:activation" FOREIGN KEY ("workflow_id", "source_state_instance_id") REFERENCES "workflow_state_activations" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:checkpoints:run" FOREIGN KEY ("workflow_id", "source_run_id") REFERENCES "workflow_graph_runs" ("workflow_id", "id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:checkpoints:cut" FOREIGN KEY ("completion_cut_id") REFERENCES "workflow_graph_completion_cuts" ("id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:checkpoints:snapshot" FOREIGN KEY ("snapshot_value_id", "snapshot_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_checkpoints:checkpoint_version:safe_integer" CHECK (("checkpoint_version" IS NULL OR "checkpoint_version" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=checkpoint_version */,
  CONSTRAINT "ck:workflow_checkpoints:workflow_revision:safe_integer" CHECK (("workflow_revision" IS NULL OR "workflow_revision" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=workflow_revision */,
  CONSTRAINT "ck:workflow_checkpoints:snapshot_hash:hash" CHECK (("snapshot_hash" IS NULL OR (length("snapshot_hash") = 71 AND substr("snapshot_hash", 1, 7) = 'sha256:' AND substr("snapshot_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=snapshot_hash */,
  CONSTRAINT "ck:workflow_checkpoints:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_checkpoints:snapshot_json:snapshot_value_id:at_most_one" CHECK ((("snapshot_json" IS NOT NULL) + ("snapshot_value_id" IS NOT NULL)) <= 1) /* check_kind=at_most_one logical_columns=snapshot_json,snapshot_value_id */
);

CREATE TABLE "runtime_capacity_head" (
  "singleton_key" INTEGER NOT NULL /* logical_type=integer */,
  "current_capacity_revision" INTEGER /* logical_type=integer */,
  "current_change_id" TEXT /* logical_type=identifier */,
  "current_config_hash" TEXT /* logical_type=hash */,
  "current_publication_hash" TEXT /* logical_type=hash */,
  "pending_change_id" TEXT /* logical_type=identifier */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "updated_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:runtime_capacity_head" PRIMARY KEY ("singleton_key"),
  CONSTRAINT "fk:capacity_head:current_command_lineage" FOREIGN KEY ("current_capacity_revision", "current_change_id", "current_config_hash") REFERENCES "runtime_capacity_admin_commands" ("assigned_capacity_revision", "assigned_change_id", "proposed_config_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:capacity_head:pending_command" FOREIGN KEY ("pending_change_id") REFERENCES "runtime_capacity_admin_commands" ("assigned_change_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:runtime_capacity_head:singleton_key:safe_integer" CHECK (("singleton_key" IS NULL OR "singleton_key" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=singleton_key */,
  CONSTRAINT "ck:runtime_capacity_head:current_capacity_revision:safe_integer" CHECK (("current_capacity_revision" IS NULL OR "current_capacity_revision" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=current_capacity_revision */,
  CONSTRAINT "ck:runtime_capacity_head:current_config_hash:hash" CHECK (("current_config_hash" IS NULL OR (length("current_config_hash") = 71 AND substr("current_config_hash", 1, 7) = 'sha256:' AND substr("current_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=current_config_hash */,
  CONSTRAINT "ck:runtime_capacity_head:current_publication_hash:hash" CHECK (("current_publication_hash" IS NULL OR (length("current_publication_hash") = 71 AND substr("current_publication_hash", 1, 7) = 'sha256:' AND substr("current_publication_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=current_publication_hash */,
  CONSTRAINT "ck:runtime_capacity_head:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:runtime_capacity_head:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:runtime_capacity_head:updated_at_ms:safe_integer" CHECK (("updated_at_ms" IS NULL OR "updated_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=updated_at_ms */,
  CONSTRAINT "ck:capacity_head:singleton" CHECK ("singleton_key" = 1) /* check_kind=cross_column_equality logical_columns=singleton_key */,
  CONSTRAINT "ck:capacity_head:current_lineage_all_or_none" CHECK ((("current_capacity_revision" IS NULL AND "current_change_id" IS NULL AND "current_config_hash" IS NULL AND "current_publication_hash" IS NULL) OR ("current_capacity_revision" IS NOT NULL AND "current_change_id" IS NOT NULL AND "current_config_hash" IS NOT NULL AND "current_publication_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=current_capacity_revision,current_change_id,current_config_hash,current_publication_hash */,
  CONSTRAINT "ck:capacity_head:pending_differs_from_current" CHECK (("pending_change_id" IS NULL OR "pending_change_id" <> "current_change_id")) /* check_kind=state_field_consistency logical_columns=pending_change_id,current_change_id */
);

CREATE TABLE "runtime_capacity_admin_commands" (
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "idempotency_domain" TEXT NOT NULL /* logical_type=text */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "command_type" TEXT NOT NULL /* logical_type=text */,
  "expected_capacity_revision" INTEGER /* logical_type=integer */,
  "expected_config_hash" TEXT /* logical_type=hash */,
  "assigned_capacity_revision" INTEGER /* logical_type=integer */,
  "assigned_change_id" TEXT /* logical_type=identifier */,
  "proposed_capacity_json" TEXT NOT NULL /* logical_type=canonical_json */,
  "proposed_config_hash" TEXT NOT NULL /* logical_type=hash */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "reason_code" TEXT NOT NULL /* logical_type=text */,
  "reason_text_value_id" TEXT /* logical_type=identifier */,
  "reason_text_hash" TEXT /* logical_type=hash */,
  "evidence_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "evidence_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "canonical_result_value_id" TEXT /* logical_type=identifier */,
  "canonical_result_hash" TEXT /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finalized_at_ms" INTEGER /* logical_type=integer */,
  CONSTRAINT "pk:runtime_capacity_admin_commands" PRIMARY KEY ("command_id"),
  CONSTRAINT "fk:capacity_commands:reason_text_value" FOREIGN KEY ("reason_text_value_id", "reason_text_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:capacity_commands:evidence_value" FOREIGN KEY ("evidence_manifest_value_id", "evidence_manifest_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:capacity_commands:result_value" FOREIGN KEY ("canonical_result_value_id", "canonical_result_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:runtime_capacity_admin_commands:command_type:enum" CHECK ("command_type" IN ('initialize_deployment_capacity', 'replace_deployment_capacity')) /* check_kind=enum_membership logical_columns=command_type */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:expected_capacity_revision:safe_integer" CHECK (("expected_capacity_revision" IS NULL OR "expected_capacity_revision" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expected_capacity_revision */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:expected_config_hash:hash" CHECK (("expected_config_hash" IS NULL OR (length("expected_config_hash") = 71 AND substr("expected_config_hash", 1, 7) = 'sha256:' AND substr("expected_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=expected_config_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:assigned_capacity_revision:safe_integer" CHECK (("assigned_capacity_revision" IS NULL OR "assigned_capacity_revision" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=assigned_capacity_revision */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:proposed_config_hash:hash" CHECK (("proposed_config_hash" IS NULL OR (length("proposed_config_hash") = 71 AND substr("proposed_config_hash", 1, 7) = 'sha256:' AND substr("proposed_config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=proposed_config_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:reason_code:enum" CHECK ("reason_code" IN ('initial_provisioning', 'planned_tuning', 'incident_mitigation', 'host_resource_change', 'storage_pressure', 'rollback')) /* check_kind=enum_membership logical_columns=reason_code */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:reason_text_hash:hash" CHECK (("reason_text_hash" IS NULL OR (length("reason_text_hash") = 71 AND substr("reason_text_hash", 1, 7) = 'sha256:' AND substr("reason_text_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=reason_text_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:evidence_manifest_hash:hash" CHECK (("evidence_manifest_hash" IS NULL OR (length("evidence_manifest_hash") = 71 AND substr("evidence_manifest_hash", 1, 7) = 'sha256:' AND substr("evidence_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=evidence_manifest_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:canonical_result_hash:hash" CHECK (("canonical_result_hash" IS NULL OR (length("canonical_result_hash") = 71 AND substr("canonical_result_hash", 1, 7) = 'sha256:' AND substr("canonical_result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_result_hash */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:runtime_capacity_admin_commands:finalized_at_ms:safe_integer" CHECK (("finalized_at_ms" IS NULL OR "finalized_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finalized_at_ms */,
  CONSTRAINT "ck:capacity_commands:expected_pair" CHECK ((("expected_capacity_revision" IS NULL AND "expected_config_hash" IS NULL) OR ("expected_capacity_revision" IS NOT NULL AND "expected_config_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=expected_capacity_revision,expected_config_hash */,
  CONSTRAINT "ck:capacity_commands:assigned_pair" CHECK ((("assigned_capacity_revision" IS NULL AND "assigned_change_id" IS NULL) OR ("assigned_capacity_revision" IS NOT NULL AND "assigned_change_id" IS NOT NULL))) /* check_kind=all_or_none logical_columns=assigned_capacity_revision,assigned_change_id */,
  CONSTRAINT "ck:capacity_commands:command_mapping" CHECK ((("command_type" = 'initialize_deployment_capacity' AND "expected_capacity_revision" IS NULL AND "expected_config_hash" IS NULL AND "reason_code" = 'initial_provisioning' AND "reason_text_value_id" IS NULL AND "reason_text_hash" IS NULL) OR ("command_type" = 'replace_deployment_capacity' AND "expected_capacity_revision" IS NOT NULL AND "expected_config_hash" IS NOT NULL AND "reason_code" <> 'initial_provisioning' AND "reason_text_value_id" IS NOT NULL AND "reason_text_hash" IS NOT NULL))) /* check_kind=closed_target_mapping logical_columns=command_type,expected_capacity_revision,expected_config_hash,reason_code,reason_text_value_id,reason_text_hash */,
  CONSTRAINT "ck:capacity_commands:reason_text_pair" CHECK ((("reason_text_value_id" IS NULL AND "reason_text_hash" IS NULL) OR ("reason_text_value_id" IS NOT NULL AND "reason_text_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=reason_text_value_id,reason_text_hash */,
  CONSTRAINT "ck:capacity_commands:result_pair" CHECK ((("canonical_result_value_id" IS NULL AND "canonical_result_hash" IS NULL) OR ("canonical_result_value_id" IS NOT NULL AND "canonical_result_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=canonical_result_value_id,canonical_result_hash */,
  CONSTRAINT "ck:capacity_commands:finalization" CHECK ((("canonical_result_value_id" IS NULL AND "finalized_at_ms" IS NULL) OR ("canonical_result_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=canonical_result_value_id,finalized_at_ms */
);

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
  CONSTRAINT "ck:capacity_invocations:result_consistency" CHECK ((("authorization_result" = 'denied' AND "execution_result" = 'denied' AND "denial_code" IS NOT NULL AND "applied_at_ms" IS NULL) OR ("authorization_result" = 'allowed' AND (("execution_result" = 'prepared' AND "invocation_no" = 1 AND "denial_code" IS NULL AND "decided_at_ms" >= "requested_at_ms" AND "applied_at_ms" IS NULL) OR ("execution_result" = 'applied' AND "denial_code" IS NULL AND "applied_at_ms" IS NOT NULL) OR ("execution_result" IN ('conflict', 'duplicate', 'failed') AND "applied_at_ms" IS NULL))))) /* check_kind=state_field_consistency logical_columns=invocation_no,authorization_result,execution_result,denial_code,decided_at_ms,applied_at_ms */
);

CREATE TABLE "runtime_capacity_change_events" (
  "event_seq" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL /* logical_type=integer */,
  "change_id" TEXT NOT NULL /* logical_type=identifier */,
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "capacity_revision" INTEGER NOT NULL /* logical_type=integer */,
  "event_type" TEXT NOT NULL /* logical_type=text */,
  "config_hash" TEXT NOT NULL /* logical_type=hash */,
  "publication_hash" TEXT NOT NULL /* logical_type=hash */,
  "previous_event_hash" TEXT /* logical_type=hash */,
  "event_hash" TEXT NOT NULL /* logical_type=hash */,
  "detail_value_id" TEXT /* logical_type=identifier */,
  "detail_hash" TEXT /* logical_type=hash */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "fk:capacity_events:command" FOREIGN KEY ("command_id") REFERENCES "runtime_capacity_admin_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:capacity_events:command_lineage" FOREIGN KEY ("capacity_revision", "change_id", "config_hash") REFERENCES "runtime_capacity_admin_commands" ("assigned_capacity_revision", "assigned_change_id", "proposed_config_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:capacity_events:detail_value" FOREIGN KEY ("detail_value_id", "detail_hash") REFERENCES "workflow_values" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:runtime_capacity_change_events:event_seq:safe_integer" CHECK (("event_seq" IS NULL OR "event_seq" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=event_seq */,
  CONSTRAINT "ck:runtime_capacity_change_events:capacity_revision:safe_integer" CHECK (("capacity_revision" IS NULL OR "capacity_revision" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=capacity_revision */,
  CONSTRAINT "ck:runtime_capacity_change_events:event_type:enum" CHECK ("event_type" IN ('prepared', 'file_installed', 'head_committed', 'watcher_published', 'recovered', 'failed', 'unauthorized_file_rejected')) /* check_kind=enum_membership logical_columns=event_type */,
  CONSTRAINT "ck:runtime_capacity_change_events:config_hash:hash" CHECK (("config_hash" IS NULL OR (length("config_hash") = 71 AND substr("config_hash", 1, 7) = 'sha256:' AND substr("config_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=config_hash */,
  CONSTRAINT "ck:runtime_capacity_change_events:publication_hash:hash" CHECK (("publication_hash" IS NULL OR (length("publication_hash") = 71 AND substr("publication_hash", 1, 7) = 'sha256:' AND substr("publication_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=publication_hash */,
  CONSTRAINT "ck:runtime_capacity_change_events:previous_event_hash:hash" CHECK (("previous_event_hash" IS NULL OR (length("previous_event_hash") = 71 AND substr("previous_event_hash", 1, 7) = 'sha256:' AND substr("previous_event_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_event_hash */,
  CONSTRAINT "ck:runtime_capacity_change_events:event_hash:hash" CHECK (("event_hash" IS NULL OR (length("event_hash") = 71 AND substr("event_hash", 1, 7) = 'sha256:' AND substr("event_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=event_hash */,
  CONSTRAINT "ck:runtime_capacity_change_events:detail_hash:hash" CHECK (("detail_hash" IS NULL OR (length("detail_hash") = 71 AND substr("detail_hash", 1, 7) = 'sha256:' AND substr("detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=detail_hash */,
  CONSTRAINT "ck:runtime_capacity_change_events:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:capacity_events:detail_pair" CHECK ((("detail_value_id" IS NULL AND "detail_hash" IS NULL) OR ("detail_value_id" IS NOT NULL AND "detail_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=detail_value_id,detail_hash */,
  CONSTRAINT "ck:capacity_events:hash_chain" CHECK ((("event_seq" = 1 AND "previous_event_hash" IS NULL) OR ("event_seq" > 1 AND "previous_event_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=event_seq,previous_event_hash,event_hash */
);

CREATE TABLE "workflow_publisher_commands" (
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "command_type" TEXT NOT NULL /* logical_type=text */,
  "idempotency_domain" TEXT NOT NULL /* logical_type=text */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "request_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "request_schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "request_schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "domain_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "approved_review_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=workflow_authoring_review_registry reference_domain=approved_workflow_review immutable=1 */,
  "approved_review_hash" TEXT NOT NULL /* logical_type=hash */,
  "reviewer_actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=publisher_authentication_gateway reference_domain=authenticated_principal immutable=1 */,
  "reviewer_auth_session_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=authentication_service reference_domain=auth_session immutable=1 */,
  "approved_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "expires_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "source_manifest_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_manifest_hash" TEXT NOT NULL /* logical_type=hash */,
  "source_manifest_schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "source_manifest_schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "compiled_plan_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "compiled_plan_hash" TEXT NOT NULL /* logical_type=hash */,
  "compiled_plan_schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "compiled_plan_schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "execution_artifact_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "execution_artifact_hash" TEXT NOT NULL /* logical_type=hash */,
  "closure_manifest_id" TEXT NOT NULL /* logical_type=identifier */,
  "closure_hash" TEXT NOT NULL /* logical_type=hash */,
  "target_feature_release_id" TEXT NOT NULL /* logical_type=identifier */,
  "target_feature_release_hash" TEXT NOT NULL /* logical_type=hash */,
  "applied_feature_release_id" TEXT /* logical_type=identifier */,
  "applied_feature_release_hash" TEXT /* logical_type=hash */,
  "canonical_receipt_value_id" TEXT /* logical_type=identifier */,
  "canonical_receipt_hash" TEXT /* logical_type=hash */,
  "canonical_receipt_schema_resource_id" TEXT /* logical_type=identifier */,
  "canonical_receipt_schema_hash" TEXT /* logical_type=hash */,
  "lifecycle" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finalized_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_publisher_commands" PRIMARY KEY ("command_id"),
  CONSTRAINT "fk:publisher_commands:request_value" FOREIGN KEY ("request_value_id", "request_hash", "request_schema_resource_id", "request_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_commands:source_manifest_value" FOREIGN KEY ("source_manifest_value_id", "source_manifest_hash", "source_manifest_schema_resource_id", "source_manifest_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_commands:compiled_plan_value" FOREIGN KEY ("compiled_plan_value_id", "compiled_plan_hash", "compiled_plan_schema_resource_id", "compiled_plan_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_commands:execution_artifact" FOREIGN KEY ("execution_artifact_resource_id", "execution_artifact_hash") REFERENCES "workflow_registry_resources" ("id", "content_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_commands:closure" FOREIGN KEY ("closure_manifest_id", "closure_hash") REFERENCES "workflow_registry_closure_manifests" ("id", "closure_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_commands:target_feature_release" FOREIGN KEY ("target_feature_release_id", "target_feature_release_hash") REFERENCES "workflow_feature_releases" ("id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_commands:applied_feature_release" FOREIGN KEY ("applied_feature_release_id", "applied_feature_release_hash") REFERENCES "workflow_feature_releases" ("id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_commands:canonical_receipt_value" FOREIGN KEY ("canonical_receipt_value_id", "canonical_receipt_hash", "canonical_receipt_schema_resource_id", "canonical_receipt_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_publisher_commands:command_type:enum" CHECK ("command_type" IN ('staged_publish')) /* check_kind=enum_membership logical_columns=command_type */,
  CONSTRAINT "ck:workflow_publisher_commands:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:request_schema_hash:hash" CHECK (("request_schema_hash" IS NULL OR (length("request_schema_hash") = 71 AND substr("request_schema_hash", 1, 7) = 'sha256:' AND substr("request_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_schema_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:domain_request_hash:hash" CHECK (("domain_request_hash" IS NULL OR (length("domain_request_hash") = 71 AND substr("domain_request_hash", 1, 7) = 'sha256:' AND substr("domain_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=domain_request_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:approved_review_hash:hash" CHECK (("approved_review_hash" IS NULL OR (length("approved_review_hash") = 71 AND substr("approved_review_hash", 1, 7) = 'sha256:' AND substr("approved_review_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=approved_review_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:approved_at_ms:safe_integer" CHECK (("approved_at_ms" IS NULL OR "approved_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=approved_at_ms */,
  CONSTRAINT "ck:workflow_publisher_commands:expires_at_ms:safe_integer" CHECK (("expires_at_ms" IS NULL OR "expires_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=expires_at_ms */,
  CONSTRAINT "ck:workflow_publisher_commands:source_manifest_hash:hash" CHECK (("source_manifest_hash" IS NULL OR (length("source_manifest_hash") = 71 AND substr("source_manifest_hash", 1, 7) = 'sha256:' AND substr("source_manifest_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_manifest_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:source_manifest_schema_hash:hash" CHECK (("source_manifest_schema_hash" IS NULL OR (length("source_manifest_schema_hash") = 71 AND substr("source_manifest_schema_hash", 1, 7) = 'sha256:' AND substr("source_manifest_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=source_manifest_schema_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:compiled_plan_hash:hash" CHECK (("compiled_plan_hash" IS NULL OR (length("compiled_plan_hash") = 71 AND substr("compiled_plan_hash", 1, 7) = 'sha256:' AND substr("compiled_plan_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=compiled_plan_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:compiled_plan_schema_hash:hash" CHECK (("compiled_plan_schema_hash" IS NULL OR (length("compiled_plan_schema_hash") = 71 AND substr("compiled_plan_schema_hash", 1, 7) = 'sha256:' AND substr("compiled_plan_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=compiled_plan_schema_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:execution_artifact_hash:hash" CHECK (("execution_artifact_hash" IS NULL OR (length("execution_artifact_hash") = 71 AND substr("execution_artifact_hash", 1, 7) = 'sha256:' AND substr("execution_artifact_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=execution_artifact_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:closure_hash:hash" CHECK (("closure_hash" IS NULL OR (length("closure_hash") = 71 AND substr("closure_hash", 1, 7) = 'sha256:' AND substr("closure_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=closure_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:target_feature_release_hash:hash" CHECK (("target_feature_release_hash" IS NULL OR (length("target_feature_release_hash") = 71 AND substr("target_feature_release_hash", 1, 7) = 'sha256:' AND substr("target_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=target_feature_release_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:applied_feature_release_hash:hash" CHECK (("applied_feature_release_hash" IS NULL OR (length("applied_feature_release_hash") = 71 AND substr("applied_feature_release_hash", 1, 7) = 'sha256:' AND substr("applied_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=applied_feature_release_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:canonical_receipt_hash:hash" CHECK (("canonical_receipt_hash" IS NULL OR (length("canonical_receipt_hash") = 71 AND substr("canonical_receipt_hash", 1, 7) = 'sha256:' AND substr("canonical_receipt_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_receipt_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:canonical_receipt_schema_hash:hash" CHECK (("canonical_receipt_schema_hash" IS NULL OR (length("canonical_receipt_schema_hash") = 71 AND substr("canonical_receipt_schema_hash", 1, 7) = 'sha256:' AND substr("canonical_receipt_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_receipt_schema_hash */,
  CONSTRAINT "ck:workflow_publisher_commands:lifecycle:enum" CHECK ("lifecycle" IN ('pending', 'applied', 'failed')) /* check_kind=enum_membership logical_columns=lifecycle */,
  CONSTRAINT "ck:workflow_publisher_commands:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_publisher_commands:finalized_at_ms:safe_integer" CHECK (("finalized_at_ms" IS NULL OR "finalized_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finalized_at_ms */,
  CONSTRAINT "ck:workflow_publisher_commands:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:publisher_commands:idempotency_non_empty" CHECK ((length("idempotency_domain") BETWEEN 1 AND 255 AND length("idempotency_key") BETWEEN 1 AND 512)) /* check_kind=state_field_consistency logical_columns=idempotency_domain,idempotency_key */,
  CONSTRAINT "ck:publisher_commands:review_window" CHECK (("approved_at_ms" <= "created_at_ms" AND "created_at_ms" < "expires_at_ms")) /* check_kind=ordered_values logical_columns=approved_at_ms,created_at_ms,expires_at_ms */,
  CONSTRAINT "ck:publisher_commands:applied_release_pair" CHECK ((("applied_feature_release_id" IS NULL AND "applied_feature_release_hash" IS NULL) OR ("applied_feature_release_id" IS NOT NULL AND "applied_feature_release_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=applied_feature_release_id,applied_feature_release_hash */,
  CONSTRAINT "ck:publisher_commands:receipt_binding" CHECK ((("canonical_receipt_value_id" IS NULL AND "canonical_receipt_hash" IS NULL AND "canonical_receipt_schema_resource_id" IS NULL AND "canonical_receipt_schema_hash" IS NULL) OR ("canonical_receipt_value_id" IS NOT NULL AND "canonical_receipt_hash" IS NOT NULL AND "canonical_receipt_schema_resource_id" IS NOT NULL AND "canonical_receipt_schema_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=canonical_receipt_value_id,canonical_receipt_hash,canonical_receipt_schema_resource_id,canonical_receipt_schema_hash */,
  CONSTRAINT "ck:publisher_commands:lifecycle" CHECK ((("lifecycle" = 'pending' AND "applied_feature_release_id" IS NULL AND "applied_feature_release_hash" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NULL) OR ("lifecycle" = 'applied' AND "applied_feature_release_id" = "target_feature_release_id" AND "applied_feature_release_hash" = "target_feature_release_hash" AND "canonical_receipt_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL) OR ("lifecycle" = 'failed' AND "applied_feature_release_id" IS NULL AND "applied_feature_release_hash" IS NULL AND "canonical_receipt_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=lifecycle,target_feature_release_id,target_feature_release_hash,applied_feature_release_id,applied_feature_release_hash,canonical_receipt_value_id,finalized_at_ms */
);

CREATE TABLE "workflow_publisher_command_invocations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "invocation_no" INTEGER NOT NULL /* logical_type=integer */,
  "command_domain_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "submitted_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=publisher_authentication_gateway reference_domain=authenticated_principal immutable=1 */,
  "auth_session_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=authentication_service reference_domain=auth_session immutable=1 */,
  "requested_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "disposition" TEXT NOT NULL /* logical_type=text */,
  "result_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "result_hash" TEXT NOT NULL /* logical_type=hash */,
  "result_schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "result_schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "decided_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "applied_at_ms" INTEGER /* logical_type=integer */,
  "previous_invocation_hash" TEXT /* logical_type=hash */,
  "invocation_hash" TEXT NOT NULL /* logical_type=hash */,
  CONSTRAINT "pk:workflow_publisher_command_invocations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:publisher_invocations:command_request" FOREIGN KEY ("command_id", "command_domain_request_hash") REFERENCES "workflow_publisher_commands" ("command_id", "domain_request_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_invocations:result_value" FOREIGN KEY ("result_value_id", "result_hash", "result_schema_resource_id", "result_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_publisher_command_invocations:invocation_no:safe_integer" CHECK (("invocation_no" IS NULL OR "invocation_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=invocation_no */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:command_domain_request_hash:hash" CHECK (("command_domain_request_hash" IS NULL OR (length("command_domain_request_hash") = 71 AND substr("command_domain_request_hash", 1, 7) = 'sha256:' AND substr("command_domain_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=command_domain_request_hash */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:submitted_request_hash:hash" CHECK (("submitted_request_hash" IS NULL OR (length("submitted_request_hash") = 71 AND substr("submitted_request_hash", 1, 7) = 'sha256:' AND substr("submitted_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=submitted_request_hash */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:requested_at_ms:safe_integer" CHECK (("requested_at_ms" IS NULL OR "requested_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=requested_at_ms */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:disposition:enum" CHECK ("disposition" IN ('applied', 'duplicate', 'conflict', 'failed')) /* check_kind=enum_membership logical_columns=disposition */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:result_hash:hash" CHECK (("result_hash" IS NULL OR (length("result_hash") = 71 AND substr("result_hash", 1, 7) = 'sha256:' AND substr("result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=result_hash */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:result_schema_hash:hash" CHECK (("result_schema_hash" IS NULL OR (length("result_schema_hash") = 71 AND substr("result_schema_hash", 1, 7) = 'sha256:' AND substr("result_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=result_schema_hash */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:decided_at_ms:safe_integer" CHECK (("decided_at_ms" IS NULL OR "decided_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=decided_at_ms */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:applied_at_ms:safe_integer" CHECK (("applied_at_ms" IS NULL OR "applied_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=applied_at_ms */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:previous_invocation_hash:hash" CHECK (("previous_invocation_hash" IS NULL OR (length("previous_invocation_hash") = 71 AND substr("previous_invocation_hash", 1, 7) = 'sha256:' AND substr("previous_invocation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_invocation_hash */,
  CONSTRAINT "ck:workflow_publisher_command_invocations:invocation_hash:hash" CHECK (("invocation_hash" IS NULL OR (length("invocation_hash") = 71 AND substr("invocation_hash", 1, 7) = 'sha256:' AND substr("invocation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=invocation_hash */,
  CONSTRAINT "ck:publisher_invocations:result_consistency" CHECK ("decided_at_ms" >= "requested_at_ms" AND (("disposition" = 'applied' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NOT NULL) OR ("disposition" IN ('duplicate', 'failed') AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NULL) OR ("disposition" = 'conflict' AND "submitted_request_hash" <> "command_domain_request_hash" AND "applied_at_ms" IS NULL))) /* check_kind=state_field_consistency logical_columns=disposition,command_domain_request_hash,submitted_request_hash,requested_at_ms,decided_at_ms,applied_at_ms */,
  CONSTRAINT "ck:publisher_invocations:hash_chain" CHECK ((("invocation_no" = 1 AND "previous_invocation_hash" IS NULL) OR ("invocation_no" > 1 AND "previous_invocation_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=invocation_no,previous_invocation_hash,invocation_hash */
);

CREATE TABLE "workflow_publisher_events" (
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "event_no" INTEGER NOT NULL /* logical_type=integer */,
  "attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "phase" TEXT NOT NULL /* logical_type=text */,
  "event_type" TEXT NOT NULL /* logical_type=text */,
  "failure_code" TEXT /* logical_type=text */,
  "related_feature_release_id" TEXT /* logical_type=identifier */,
  "related_feature_release_hash" TEXT /* logical_type=hash */,
  "detail_value_id" TEXT /* logical_type=identifier */,
  "detail_hash" TEXT /* logical_type=hash */,
  "detail_schema_resource_id" TEXT /* logical_type=identifier */,
  "detail_schema_hash" TEXT /* logical_type=hash */,
  "previous_event_hash" TEXT /* logical_type=hash */,
  "event_hash" TEXT NOT NULL /* logical_type=hash */,
  "occurred_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_publisher_events" PRIMARY KEY ("command_id", "event_no"),
  CONSTRAINT "fk:publisher_events:command" FOREIGN KEY ("command_id") REFERENCES "workflow_publisher_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_events:attempt_invocation" FOREIGN KEY ("command_id", "attempt_no") REFERENCES "workflow_publisher_command_invocations" ("command_id", "invocation_no") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_events:related_feature_release" FOREIGN KEY ("related_feature_release_id", "related_feature_release_hash") REFERENCES "workflow_feature_releases" ("id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:publisher_events:detail_value" FOREIGN KEY ("detail_value_id", "detail_hash", "detail_schema_resource_id", "detail_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_publisher_events:event_no:safe_integer" CHECK (("event_no" IS NULL OR "event_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=event_no */,
  CONSTRAINT "ck:workflow_publisher_events:attempt_no:safe_integer" CHECK (("attempt_no" IS NULL OR "attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_no */,
  CONSTRAINT "ck:workflow_publisher_events:phase:enum" CHECK ("phase" IN ('authenticate', 'validate', 'review', 'preflight', 'publish_transaction', 'recovery', 'finalize')) /* check_kind=enum_membership logical_columns=phase */,
  CONSTRAINT "ck:workflow_publisher_events:event_type:enum" CHECK ("event_type" IN ('attempt_started', 'phase_succeeded', 'pre_transaction_failed', 'publish_transaction_started', 'publish_committed', 'recovery_started', 'recovery_succeeded', 'recovery_failed', 'terminal_failed')) /* check_kind=enum_membership logical_columns=event_type */,
  CONSTRAINT "ck:workflow_publisher_events:related_feature_release_hash:hash" CHECK (("related_feature_release_hash" IS NULL OR (length("related_feature_release_hash") = 71 AND substr("related_feature_release_hash", 1, 7) = 'sha256:' AND substr("related_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=related_feature_release_hash */,
  CONSTRAINT "ck:workflow_publisher_events:detail_hash:hash" CHECK (("detail_hash" IS NULL OR (length("detail_hash") = 71 AND substr("detail_hash", 1, 7) = 'sha256:' AND substr("detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=detail_hash */,
  CONSTRAINT "ck:workflow_publisher_events:detail_schema_hash:hash" CHECK (("detail_schema_hash" IS NULL OR (length("detail_schema_hash") = 71 AND substr("detail_schema_hash", 1, 7) = 'sha256:' AND substr("detail_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=detail_schema_hash */,
  CONSTRAINT "ck:workflow_publisher_events:previous_event_hash:hash" CHECK (("previous_event_hash" IS NULL OR (length("previous_event_hash") = 71 AND substr("previous_event_hash", 1, 7) = 'sha256:' AND substr("previous_event_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_event_hash */,
  CONSTRAINT "ck:workflow_publisher_events:event_hash:hash" CHECK (("event_hash" IS NULL OR (length("event_hash") = 71 AND substr("event_hash", 1, 7) = 'sha256:' AND substr("event_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=event_hash */,
  CONSTRAINT "ck:workflow_publisher_events:occurred_at_ms:safe_integer" CHECK (("occurred_at_ms" IS NULL OR "occurred_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=occurred_at_ms */,
  CONSTRAINT "ck:publisher_events:related_release_pair" CHECK ((("related_feature_release_id" IS NULL AND "related_feature_release_hash" IS NULL) OR ("related_feature_release_id" IS NOT NULL AND "related_feature_release_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=related_feature_release_id,related_feature_release_hash */,
  CONSTRAINT "ck:publisher_events:detail_binding" CHECK ((("detail_value_id" IS NULL AND "detail_hash" IS NULL AND "detail_schema_resource_id" IS NULL AND "detail_schema_hash" IS NULL) OR ("detail_value_id" IS NOT NULL AND "detail_hash" IS NOT NULL AND "detail_schema_resource_id" IS NOT NULL AND "detail_schema_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=detail_value_id,detail_hash,detail_schema_resource_id,detail_schema_hash */,
  CONSTRAINT "ck:publisher_events:hash_chain" CHECK ((("event_no" = 1 AND "previous_event_hash" IS NULL) OR ("event_no" > 1 AND "previous_event_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=event_no,previous_event_hash,event_hash */,
  CONSTRAINT "ck:publisher_events:event_mapping" CHECK ((("event_type" = 'attempt_started' AND "phase" = 'authenticate' AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = 'phase_succeeded' AND "phase" IN ('validate', 'review', 'preflight', 'finalize') AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = 'pre_transaction_failed' AND "phase" IN ('authenticate', 'validate', 'review', 'preflight') AND "failure_code" IS NOT NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = 'publish_transaction_started' AND "phase" = 'publish_transaction' AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = 'publish_committed' AND "phase" = 'publish_transaction' AND "failure_code" IS NULL AND "related_feature_release_id" IS NOT NULL) OR ("event_type" = 'recovery_started' AND "phase" = 'recovery' AND "failure_code" IS NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = 'recovery_succeeded' AND "phase" = 'recovery' AND "failure_code" IS NULL AND "related_feature_release_id" IS NOT NULL) OR ("event_type" = 'recovery_failed' AND "phase" = 'recovery' AND "failure_code" IS NOT NULL AND "related_feature_release_id" IS NULL) OR ("event_type" = 'terminal_failed' AND "phase" = 'finalize' AND "failure_code" IS NOT NULL AND "related_feature_release_id" IS NULL))) /* check_kind=closed_target_mapping logical_columns=phase,event_type,failure_code,related_feature_release_id */
);

CREATE TABLE "workflow_feature_release_activation_commands" (
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "command_type" TEXT NOT NULL /* logical_type=text */,
  "idempotency_domain" TEXT NOT NULL /* logical_type=text */,
  "idempotency_key" TEXT NOT NULL /* logical_type=text */,
  "request_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "request_hash" TEXT NOT NULL /* logical_type=hash */,
  "request_schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "request_schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "domain_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "verified_feature_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "verified_target_feature_release_id" TEXT /* logical_type=identifier */,
  "verified_target_feature_release_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_release_ref_validator reference_domain=feature_release immutable=1 */,
  "verified_target_feature_release_version" TEXT /* logical_type=text */,
  "verified_target_feature_release_hash" TEXT /* logical_type=hash */,
  "verified_previous_feature_release_id" TEXT /* logical_type=identifier */,
  "verified_previous_feature_release_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_release_ref_validator reference_domain=feature_release immutable=1 */,
  "verified_previous_feature_release_version" TEXT /* logical_type=text */,
  "verified_previous_feature_release_hash" TEXT /* logical_type=hash */,
  "verified_target_retention_handle_id" TEXT /* logical_type=identifier */,
  "verified_target_retention_handle_kind" TEXT /* logical_type=text */,
  "verified_target_retention_feature_release_id" TEXT /* logical_type=identifier */,
  "verified_target_retention_closure_manifest_id" TEXT /* logical_type=identifier */,
  "verified_target_retention_closure_hash" TEXT /* logical_type=hash */,
  "verified_target_retention_observed_status" TEXT /* logical_type=text */,
  "verified_target_retention_observed_row_version" INTEGER /* logical_type=integer */,
  "verified_previous_retention_handle_id" TEXT /* logical_type=identifier */,
  "verified_previous_retention_handle_kind" TEXT /* logical_type=text */,
  "verified_previous_retention_feature_release_id" TEXT /* logical_type=identifier */,
  "verified_previous_retention_closure_manifest_id" TEXT /* logical_type=identifier */,
  "verified_previous_retention_closure_hash" TEXT /* logical_type=hash */,
  "verified_previous_retention_observed_status" TEXT /* logical_type=text */,
  "verified_previous_retention_observed_row_version" INTEGER /* logical_type=integer */,
  "observed_pointer_state" TEXT /* logical_type=text */,
  "observed_pointer_row_version" INTEGER /* logical_type=integer */,
  "observed_feature_release_id" TEXT /* logical_type=identifier */,
  "observed_feature_release_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_release_ref_validator reference_domain=feature_release immutable=1 */,
  "observed_feature_release_version" TEXT /* logical_type=text */,
  "observed_feature_release_hash" TEXT /* logical_type=hash */,
  "terminal_disposition" TEXT /* logical_type=text */,
  "canonical_terminal_result_value_id" TEXT /* logical_type=identifier */,
  "canonical_terminal_result_hash" TEXT /* logical_type=hash */,
  "canonical_terminal_result_schema_resource_id" TEXT /* logical_type=identifier */,
  "canonical_terminal_result_schema_hash" TEXT /* logical_type=hash */,
  "canonical_terminal_invocation_id" TEXT /* logical_type=identifier */,
  "canonical_terminal_invocation_no" INTEGER /* logical_type=integer */,
  "canonical_terminal_invocation_hash" TEXT /* logical_type=hash */,
  "canonical_terminal_submitted_request_hash" TEXT /* logical_type=hash */,
  "applied_pointer_row_version" INTEGER /* logical_type=integer */,
  "canonical_receipt_value_id" TEXT /* logical_type=identifier */,
  "canonical_receipt_hash" TEXT /* logical_type=hash */,
  "canonical_receipt_schema_resource_id" TEXT /* logical_type=identifier */,
  "canonical_receipt_schema_hash" TEXT /* logical_type=hash */,
  "lifecycle" TEXT NOT NULL /* logical_type=text */,
  "created_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "finalized_at_ms" INTEGER /* logical_type=integer */,
  "row_version" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_feature_release_activation_commands" PRIMARY KEY ("command_id"),
  CONSTRAINT "fk:activation_commands:request_value" FOREIGN KEY ("request_value_id", "request_hash", "request_schema_resource_id", "request_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:verified_target_release" FOREIGN KEY ("verified_feature_id", "verified_target_feature_release_id", "verified_target_feature_release_hash") REFERENCES "workflow_feature_releases" ("feature_id", "id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:verified_previous_release" FOREIGN KEY ("verified_feature_id", "verified_previous_feature_release_id", "verified_previous_feature_release_hash") REFERENCES "workflow_feature_releases" ("feature_id", "id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:observed_release" FOREIGN KEY ("verified_feature_id", "observed_feature_release_id", "observed_feature_release_hash") REFERENCES "workflow_feature_releases" ("feature_id", "id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:verified_target_retention" FOREIGN KEY ("verified_target_retention_handle_id", "verified_target_retention_handle_kind", "verified_target_retention_feature_release_id", "verified_target_retention_closure_manifest_id", "verified_target_retention_closure_hash") REFERENCES "workflow_registry_retention_handles" ("id", "handle_kind", "feature_release_id", "closure_manifest_id", "closure_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:verified_previous_retention" FOREIGN KEY ("verified_previous_retention_handle_id", "verified_previous_retention_handle_kind", "verified_previous_retention_feature_release_id", "verified_previous_retention_closure_manifest_id", "verified_previous_retention_closure_hash") REFERENCES "workflow_registry_retention_handles" ("id", "handle_kind", "feature_release_id", "closure_manifest_id", "closure_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:canonical_terminal_result" FOREIGN KEY ("canonical_terminal_result_value_id", "canonical_terminal_result_hash", "canonical_terminal_result_schema_resource_id", "canonical_terminal_result_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:canonical_terminal_invocation" FOREIGN KEY ("canonical_terminal_invocation_id", "command_id", "canonical_terminal_invocation_no", "domain_request_hash", "terminal_disposition", "canonical_terminal_invocation_hash", "canonical_terminal_submitted_request_hash", "canonical_terminal_result_value_id", "canonical_terminal_result_hash", "canonical_terminal_result_schema_resource_id", "canonical_terminal_result_schema_hash") REFERENCES "workflow_feature_release_activation_invocations" ("id", "command_id", "invocation_no", "command_domain_request_hash", "disposition", "invocation_hash", "submitted_request_hash", "result_value_id", "result_hash", "result_schema_resource_id", "result_schema_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_commands:canonical_receipt_value" FOREIGN KEY ("canonical_receipt_value_id", "canonical_receipt_hash", "canonical_receipt_schema_resource_id", "canonical_receipt_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:command_type:enum" CHECK ("command_type" IN ('activate_feature_release')) /* check_kind=enum_membership logical_columns=command_type */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:request_hash:hash" CHECK (("request_hash" IS NULL OR (length("request_hash") = 71 AND substr("request_hash", 1, 7) = 'sha256:' AND substr("request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:request_schema_hash:hash" CHECK (("request_schema_hash" IS NULL OR (length("request_schema_hash") = 71 AND substr("request_schema_hash", 1, 7) = 'sha256:' AND substr("request_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=request_schema_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:domain_request_hash:hash" CHECK (("domain_request_hash" IS NULL OR (length("domain_request_hash") = 71 AND substr("domain_request_hash", 1, 7) = 'sha256:' AND substr("domain_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=domain_request_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_target_feature_release_hash:hash" CHECK (("verified_target_feature_release_hash" IS NULL OR (length("verified_target_feature_release_hash") = 71 AND substr("verified_target_feature_release_hash", 1, 7) = 'sha256:' AND substr("verified_target_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=verified_target_feature_release_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_previous_feature_release_hash:hash" CHECK (("verified_previous_feature_release_hash" IS NULL OR (length("verified_previous_feature_release_hash") = 71 AND substr("verified_previous_feature_release_hash", 1, 7) = 'sha256:' AND substr("verified_previous_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=verified_previous_feature_release_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_target_retention_handle_kind:enum" CHECK ("verified_target_retention_handle_kind" IN ('published')) /* check_kind=enum_membership logical_columns=verified_target_retention_handle_kind */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_target_retention_closure_hash:hash" CHECK (("verified_target_retention_closure_hash" IS NULL OR (length("verified_target_retention_closure_hash") = 71 AND substr("verified_target_retention_closure_hash", 1, 7) = 'sha256:' AND substr("verified_target_retention_closure_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=verified_target_retention_closure_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_target_retention_observed_status:enum" CHECK ("verified_target_retention_observed_status" IN ('held')) /* check_kind=enum_membership logical_columns=verified_target_retention_observed_status */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_target_retention_observed_row_version:safe_integer" CHECK (("verified_target_retention_observed_row_version" IS NULL OR "verified_target_retention_observed_row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=verified_target_retention_observed_row_version */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_previous_retention_handle_kind:enum" CHECK ("verified_previous_retention_handle_kind" IN ('published')) /* check_kind=enum_membership logical_columns=verified_previous_retention_handle_kind */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_previous_retention_closure_hash:hash" CHECK (("verified_previous_retention_closure_hash" IS NULL OR (length("verified_previous_retention_closure_hash") = 71 AND substr("verified_previous_retention_closure_hash", 1, 7) = 'sha256:' AND substr("verified_previous_retention_closure_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=verified_previous_retention_closure_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_previous_retention_observed_status:enum" CHECK ("verified_previous_retention_observed_status" IN ('held')) /* check_kind=enum_membership logical_columns=verified_previous_retention_observed_status */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:verified_previous_retention_observed_row_version:safe_integer" CHECK (("verified_previous_retention_observed_row_version" IS NULL OR "verified_previous_retention_observed_row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=verified_previous_retention_observed_row_version */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:observed_pointer_state:enum" CHECK ("observed_pointer_state" IN ('absent', 'present')) /* check_kind=enum_membership logical_columns=observed_pointer_state */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:observed_pointer_row_version:safe_integer" CHECK (("observed_pointer_row_version" IS NULL OR "observed_pointer_row_version" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=observed_pointer_row_version */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:observed_feature_release_hash:hash" CHECK (("observed_feature_release_hash" IS NULL OR (length("observed_feature_release_hash") = 71 AND substr("observed_feature_release_hash", 1, 7) = 'sha256:' AND substr("observed_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=observed_feature_release_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:terminal_disposition:enum" CHECK ("terminal_disposition" IN ('applied', 'failed', 'conflict')) /* check_kind=enum_membership logical_columns=terminal_disposition */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:canonical_terminal_result_hash:hash" CHECK (("canonical_terminal_result_hash" IS NULL OR (length("canonical_terminal_result_hash") = 71 AND substr("canonical_terminal_result_hash", 1, 7) = 'sha256:' AND substr("canonical_terminal_result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_terminal_result_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:canonical_terminal_result_schema_hash:hash" CHECK (("canonical_terminal_result_schema_hash" IS NULL OR (length("canonical_terminal_result_schema_hash") = 71 AND substr("canonical_terminal_result_schema_hash", 1, 7) = 'sha256:' AND substr("canonical_terminal_result_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_terminal_result_schema_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:canonical_terminal_invocation_no:safe_integer" CHECK (("canonical_terminal_invocation_no" IS NULL OR "canonical_terminal_invocation_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=canonical_terminal_invocation_no */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:canonical_terminal_invocation_hash:hash" CHECK (("canonical_terminal_invocation_hash" IS NULL OR (length("canonical_terminal_invocation_hash") = 71 AND substr("canonical_terminal_invocation_hash", 1, 7) = 'sha256:' AND substr("canonical_terminal_invocation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_terminal_invocation_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:canonical_terminal_submitted_request_hash:hash" CHECK (("canonical_terminal_submitted_request_hash" IS NULL OR (length("canonical_terminal_submitted_request_hash") = 71 AND substr("canonical_terminal_submitted_request_hash", 1, 7) = 'sha256:' AND substr("canonical_terminal_submitted_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_terminal_submitted_request_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:applied_pointer_row_version:safe_integer" CHECK (("applied_pointer_row_version" IS NULL OR "applied_pointer_row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=applied_pointer_row_version */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:canonical_receipt_hash:hash" CHECK (("canonical_receipt_hash" IS NULL OR (length("canonical_receipt_hash") = 71 AND substr("canonical_receipt_hash", 1, 7) = 'sha256:' AND substr("canonical_receipt_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_receipt_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:canonical_receipt_schema_hash:hash" CHECK (("canonical_receipt_schema_hash" IS NULL OR (length("canonical_receipt_schema_hash") = 71 AND substr("canonical_receipt_schema_hash", 1, 7) = 'sha256:' AND substr("canonical_receipt_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=canonical_receipt_schema_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:lifecycle:enum" CHECK ("lifecycle" IN ('pending', 'applied', 'failed', 'conflict')) /* check_kind=enum_membership logical_columns=lifecycle */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:finalized_at_ms:safe_integer" CHECK (("finalized_at_ms" IS NULL OR "finalized_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=finalized_at_ms */,
  CONSTRAINT "ck:workflow_feature_release_activation_commands:row_version:safe_integer" CHECK (("row_version" IS NULL OR "row_version" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=row_version */,
  CONSTRAINT "ck:activation_commands:idempotency_non_empty" CHECK ((length("idempotency_domain") BETWEEN 1 AND 255 AND length("idempotency_key") BETWEEN 1 AND 512)) /* check_kind=state_field_consistency logical_columns=idempotency_domain,idempotency_key */,
  CONSTRAINT "ck:activation_commands:verified_target_release" CHECK ((("verified_feature_id" IS NULL AND "verified_target_feature_release_id" IS NULL AND "verified_target_feature_release_ref" IS NULL AND "verified_target_feature_release_version" IS NULL AND "verified_target_feature_release_hash" IS NULL) OR ("verified_feature_id" IS NOT NULL AND "verified_target_feature_release_id" IS NOT NULL AND "verified_target_feature_release_ref" IS NOT NULL AND "verified_target_feature_release_version" IS NOT NULL AND "verified_target_feature_release_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=verified_feature_id,verified_target_feature_release_id,verified_target_feature_release_ref,verified_target_feature_release_version,verified_target_feature_release_hash */,
  CONSTRAINT "ck:activation_commands:verified_previous_release" CHECK ((("verified_previous_feature_release_id" IS NULL AND "verified_previous_feature_release_ref" IS NULL AND "verified_previous_feature_release_version" IS NULL AND "verified_previous_feature_release_hash" IS NULL) OR ("verified_previous_feature_release_id" IS NOT NULL AND "verified_previous_feature_release_ref" IS NOT NULL AND "verified_previous_feature_release_version" IS NOT NULL AND "verified_previous_feature_release_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=verified_previous_feature_release_id,verified_previous_feature_release_ref,verified_previous_feature_release_version,verified_previous_feature_release_hash */,
  CONSTRAINT "ck:activation_commands:verified_target_retention_identity" CHECK ((("verified_target_retention_handle_id" IS NULL AND "verified_target_retention_handle_kind" IS NULL AND "verified_target_retention_feature_release_id" IS NULL AND "verified_target_retention_closure_manifest_id" IS NULL AND "verified_target_retention_closure_hash" IS NULL) OR ("verified_target_retention_handle_id" IS NOT NULL AND "verified_target_retention_handle_kind" IS NOT NULL AND "verified_target_retention_feature_release_id" IS NOT NULL AND "verified_target_retention_closure_manifest_id" IS NOT NULL AND "verified_target_retention_closure_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=verified_target_retention_handle_id,verified_target_retention_handle_kind,verified_target_retention_feature_release_id,verified_target_retention_closure_manifest_id,verified_target_retention_closure_hash */,
  CONSTRAINT "ck:activation_commands:verified_target_retention_observation" CHECK ((("verified_target_retention_observed_status" IS NULL AND "verified_target_retention_observed_row_version" IS NULL) OR ("verified_target_retention_observed_status" IS NOT NULL AND "verified_target_retention_observed_row_version" IS NOT NULL))) /* check_kind=all_or_none logical_columns=verified_target_retention_observed_status,verified_target_retention_observed_row_version */,
  CONSTRAINT "ck:activation_commands:verified_previous_retention_identity" CHECK ((("verified_previous_retention_handle_id" IS NULL AND "verified_previous_retention_handle_kind" IS NULL AND "verified_previous_retention_feature_release_id" IS NULL AND "verified_previous_retention_closure_manifest_id" IS NULL AND "verified_previous_retention_closure_hash" IS NULL) OR ("verified_previous_retention_handle_id" IS NOT NULL AND "verified_previous_retention_handle_kind" IS NOT NULL AND "verified_previous_retention_feature_release_id" IS NOT NULL AND "verified_previous_retention_closure_manifest_id" IS NOT NULL AND "verified_previous_retention_closure_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=verified_previous_retention_handle_id,verified_previous_retention_handle_kind,verified_previous_retention_feature_release_id,verified_previous_retention_closure_manifest_id,verified_previous_retention_closure_hash */,
  CONSTRAINT "ck:activation_commands:verified_previous_retention_observation" CHECK ((("verified_previous_retention_observed_status" IS NULL AND "verified_previous_retention_observed_row_version" IS NULL) OR ("verified_previous_retention_observed_status" IS NOT NULL AND "verified_previous_retention_observed_row_version" IS NOT NULL))) /* check_kind=all_or_none logical_columns=verified_previous_retention_observed_status,verified_previous_retention_observed_row_version */,
  CONSTRAINT "ck:activation_commands:canonical_terminal_result" CHECK ((("canonical_terminal_result_value_id" IS NULL AND "canonical_terminal_result_hash" IS NULL AND "canonical_terminal_result_schema_resource_id" IS NULL AND "canonical_terminal_result_schema_hash" IS NULL) OR ("canonical_terminal_result_value_id" IS NOT NULL AND "canonical_terminal_result_hash" IS NOT NULL AND "canonical_terminal_result_schema_resource_id" IS NOT NULL AND "canonical_terminal_result_schema_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=canonical_terminal_result_value_id,canonical_terminal_result_hash,canonical_terminal_result_schema_resource_id,canonical_terminal_result_schema_hash */,
  CONSTRAINT "ck:activation_commands:canonical_terminal_invocation" CHECK ((("canonical_terminal_invocation_id" IS NULL AND "canonical_terminal_invocation_no" IS NULL AND "canonical_terminal_invocation_hash" IS NULL AND "canonical_terminal_submitted_request_hash" IS NULL) OR ("canonical_terminal_invocation_id" IS NOT NULL AND "canonical_terminal_invocation_no" IS NOT NULL AND "canonical_terminal_invocation_hash" IS NOT NULL AND "canonical_terminal_submitted_request_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=canonical_terminal_invocation_id,canonical_terminal_invocation_no,canonical_terminal_invocation_hash,canonical_terminal_submitted_request_hash */,
  CONSTRAINT "ck:activation_commands:receipt_binding" CHECK ((("canonical_receipt_value_id" IS NULL AND "canonical_receipt_hash" IS NULL AND "canonical_receipt_schema_resource_id" IS NULL AND "canonical_receipt_schema_hash" IS NULL) OR ("canonical_receipt_value_id" IS NOT NULL AND "canonical_receipt_hash" IS NOT NULL AND "canonical_receipt_schema_resource_id" IS NOT NULL AND "canonical_receipt_schema_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=canonical_receipt_value_id,canonical_receipt_hash,canonical_receipt_schema_resource_id,canonical_receipt_schema_hash */,
  CONSTRAINT "ck:activation_commands:pointer_observation_shape" CHECK ((("observed_pointer_state" IS NULL AND "observed_pointer_row_version" IS NULL AND "observed_feature_release_id" IS NULL AND "observed_feature_release_ref" IS NULL AND "observed_feature_release_version" IS NULL AND "observed_feature_release_hash" IS NULL) OR ("observed_pointer_state" = 'absent' AND "observed_pointer_row_version" IS NULL AND "observed_feature_release_id" IS NULL AND "observed_feature_release_ref" IS NULL AND "observed_feature_release_version" IS NULL AND "observed_feature_release_hash" IS NULL) OR ("observed_pointer_state" = 'present' AND "observed_pointer_row_version" IS NOT NULL AND "observed_feature_release_id" IS NOT NULL AND "observed_feature_release_ref" IS NOT NULL AND "observed_feature_release_version" IS NOT NULL AND "observed_feature_release_hash" IS NOT NULL))) /* check_kind=closed_target_mapping logical_columns=observed_pointer_state,observed_pointer_row_version,observed_feature_release_id,observed_feature_release_ref,observed_feature_release_version,observed_feature_release_hash */,
  CONSTRAINT "ck:activation_commands:target_previous_distinct" CHECK (("verified_previous_feature_release_id" IS NULL OR "verified_target_feature_release_id" <> "verified_previous_feature_release_id")) /* check_kind=cross_column_equality logical_columns=verified_target_feature_release_id,verified_previous_feature_release_id */,
  CONSTRAINT "ck:activation_commands:verified_prefix" CHECK (("verified_previous_feature_release_id" IS NULL OR "verified_target_feature_release_id" IS NOT NULL) AND ("verified_target_retention_handle_id" IS NULL OR ("verified_target_feature_release_id" IS NOT NULL AND "verified_target_retention_feature_release_id" = "verified_target_feature_release_id")) AND ("verified_target_retention_observed_status" IS NULL OR "verified_target_retention_handle_id" IS NOT NULL) AND ("verified_previous_retention_handle_id" IS NULL OR ("verified_previous_feature_release_id" IS NOT NULL AND "verified_target_retention_observed_status" = 'held' AND "verified_previous_retention_feature_release_id" = "verified_previous_feature_release_id")) AND ("verified_previous_retention_observed_status" IS NULL OR "verified_previous_retention_handle_id" IS NOT NULL) AND ("observed_pointer_state" IS NULL OR ("verified_target_retention_observed_status" = 'held' AND ("verified_previous_feature_release_id" IS NULL OR "verified_previous_retention_observed_status" = 'held')))),
  CONSTRAINT "ck:activation_commands:lifecycle" CHECK ((("lifecycle" = 'pending' AND "terminal_disposition" IS NULL AND "canonical_terminal_result_value_id" IS NULL AND "canonical_terminal_invocation_id" IS NULL AND "applied_pointer_row_version" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NULL AND ("row_version" <> 0 OR ("verified_target_feature_release_id" IS NULL AND "verified_previous_feature_release_id" IS NULL AND "verified_target_retention_handle_id" IS NULL AND "verified_previous_retention_handle_id" IS NULL AND "observed_pointer_state" IS NULL))) OR ("lifecycle" = 'applied' AND "terminal_disposition" = 'applied' AND "observed_pointer_state" IS NOT NULL AND "canonical_terminal_result_value_id" IS NOT NULL AND "canonical_terminal_invocation_id" IS NOT NULL AND "applied_pointer_row_version" IS NOT NULL AND "canonical_receipt_value_id" IS NOT NULL AND "finalized_at_ms" IS NOT NULL) OR ("lifecycle" IN ('failed', 'conflict') AND "terminal_disposition" = "lifecycle" AND "canonical_terminal_result_value_id" IS NOT NULL AND "canonical_terminal_invocation_id" IS NOT NULL AND "applied_pointer_row_version" IS NULL AND "canonical_receipt_value_id" IS NULL AND "finalized_at_ms" IS NOT NULL)))
);

CREATE TABLE "workflow_feature_release_activation_invocations" (
  "id" TEXT NOT NULL /* logical_type=identifier */,
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "invocation_no" INTEGER NOT NULL /* logical_type=integer */,
  "invocation_kind" TEXT NOT NULL /* logical_type=text */,
  "command_domain_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "submitted_request_hash" TEXT NOT NULL /* logical_type=hash */,
  "actor_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=feature_release_activation_authentication_gateway reference_domain=authenticated_principal immutable=1 */,
  "auth_session_ref" TEXT NOT NULL /* logical_type=external_reference external_ref=1 validator_owner=authentication_service reference_domain=auth_session immutable=1 */,
  "requested_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "disposition" TEXT NOT NULL /* logical_type=text */,
  "result_value_id" TEXT NOT NULL /* logical_type=identifier */,
  "result_hash" TEXT NOT NULL /* logical_type=hash */,
  "result_schema_resource_id" TEXT NOT NULL /* logical_type=identifier */,
  "result_schema_hash" TEXT NOT NULL /* logical_type=hash */,
  "referenced_terminal_result_value_id" TEXT /* logical_type=identifier */,
  "referenced_terminal_result_hash" TEXT /* logical_type=hash */,
  "referenced_terminal_result_schema_resource_id" TEXT /* logical_type=identifier */,
  "referenced_terminal_result_schema_hash" TEXT /* logical_type=hash */,
  "decided_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  "applied_at_ms" INTEGER /* logical_type=integer */,
  "previous_invocation_hash" TEXT /* logical_type=hash */,
  "invocation_hash" TEXT NOT NULL /* logical_type=hash */,
  CONSTRAINT "pk:workflow_feature_release_activation_invocations" PRIMARY KEY ("id"),
  CONSTRAINT "fk:activation_invocations:command_request" FOREIGN KEY ("command_id", "command_domain_request_hash") REFERENCES "workflow_feature_release_activation_commands" ("command_id", "domain_request_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_invocations:result_value" FOREIGN KEY ("result_value_id", "result_hash", "result_schema_resource_id", "result_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_invocations:referenced_terminal_result" FOREIGN KEY ("referenced_terminal_result_value_id", "referenced_terminal_result_hash", "referenced_terminal_result_schema_resource_id", "referenced_terminal_result_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:invocation_no:safe_integer" CHECK (("invocation_no" IS NULL OR "invocation_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=invocation_no */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:invocation_kind:enum" CHECK ("invocation_kind" IN ('submit', 'recovery')) /* check_kind=enum_membership logical_columns=invocation_kind */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:command_domain_request_hash:hash" CHECK (("command_domain_request_hash" IS NULL OR (length("command_domain_request_hash") = 71 AND substr("command_domain_request_hash", 1, 7) = 'sha256:' AND substr("command_domain_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=command_domain_request_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:submitted_request_hash:hash" CHECK (("submitted_request_hash" IS NULL OR (length("submitted_request_hash") = 71 AND substr("submitted_request_hash", 1, 7) = 'sha256:' AND substr("submitted_request_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=submitted_request_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:requested_at_ms:safe_integer" CHECK (("requested_at_ms" IS NULL OR "requested_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=requested_at_ms */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:disposition:enum" CHECK ("disposition" IN ('applied', 'duplicate', 'conflict', 'failed')) /* check_kind=enum_membership logical_columns=disposition */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:result_hash:hash" CHECK (("result_hash" IS NULL OR (length("result_hash") = 71 AND substr("result_hash", 1, 7) = 'sha256:' AND substr("result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=result_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:result_schema_hash:hash" CHECK (("result_schema_hash" IS NULL OR (length("result_schema_hash") = 71 AND substr("result_schema_hash", 1, 7) = 'sha256:' AND substr("result_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=result_schema_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:referenced_terminal_result_hash:hash" CHECK (("referenced_terminal_result_hash" IS NULL OR (length("referenced_terminal_result_hash") = 71 AND substr("referenced_terminal_result_hash", 1, 7) = 'sha256:' AND substr("referenced_terminal_result_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=referenced_terminal_result_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:referenced_terminal_result_schema_hash:hash" CHECK (("referenced_terminal_result_schema_hash" IS NULL OR (length("referenced_terminal_result_schema_hash") = 71 AND substr("referenced_terminal_result_schema_hash", 1, 7) = 'sha256:' AND substr("referenced_terminal_result_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=referenced_terminal_result_schema_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:decided_at_ms:safe_integer" CHECK (("decided_at_ms" IS NULL OR "decided_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=decided_at_ms */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:applied_at_ms:safe_integer" CHECK (("applied_at_ms" IS NULL OR "applied_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=applied_at_ms */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:previous_invocation_hash:hash" CHECK (("previous_invocation_hash" IS NULL OR (length("previous_invocation_hash") = 71 AND substr("previous_invocation_hash", 1, 7) = 'sha256:' AND substr("previous_invocation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_invocation_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_invocations:invocation_hash:hash" CHECK (("invocation_hash" IS NULL OR (length("invocation_hash") = 71 AND substr("invocation_hash", 1, 7) = 'sha256:' AND substr("invocation_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=invocation_hash */,
  CONSTRAINT "ck:activation_invocations:referenced_terminal_result" CHECK ((("referenced_terminal_result_value_id" IS NULL AND "referenced_terminal_result_hash" IS NULL AND "referenced_terminal_result_schema_resource_id" IS NULL AND "referenced_terminal_result_schema_hash" IS NULL) OR ("referenced_terminal_result_value_id" IS NOT NULL AND "referenced_terminal_result_hash" IS NOT NULL AND "referenced_terminal_result_schema_resource_id" IS NOT NULL AND "referenced_terminal_result_schema_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=referenced_terminal_result_value_id,referenced_terminal_result_hash,referenced_terminal_result_schema_resource_id,referenced_terminal_result_schema_hash */,
  CONSTRAINT "ck:activation_invocations:result_consistency" CHECK ("decided_at_ms" >= "requested_at_ms" AND (("disposition" = 'applied' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NOT NULL AND "referenced_terminal_result_value_id" = "result_value_id" AND "referenced_terminal_result_hash" = "result_hash" AND "referenced_terminal_result_schema_resource_id" = "result_schema_resource_id" AND "referenced_terminal_result_schema_hash" = "result_schema_hash") OR ("disposition" = 'failed' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NULL AND "referenced_terminal_result_value_id" = "result_value_id" AND "referenced_terminal_result_hash" = "result_hash" AND "referenced_terminal_result_schema_resource_id" = "result_schema_resource_id" AND "referenced_terminal_result_schema_hash" = "result_schema_hash") OR ("disposition" = 'duplicate' AND "submitted_request_hash" = "command_domain_request_hash" AND "applied_at_ms" IS NULL AND "referenced_terminal_result_value_id" IS NOT NULL) OR ("disposition" = 'conflict' AND "applied_at_ms" IS NULL AND (("submitted_request_hash" = "command_domain_request_hash" AND "referenced_terminal_result_value_id" = "result_value_id" AND "referenced_terminal_result_hash" = "result_hash" AND "referenced_terminal_result_schema_resource_id" = "result_schema_resource_id" AND "referenced_terminal_result_schema_hash" = "result_schema_hash") OR "submitted_request_hash" <> "command_domain_request_hash")))) /* check_kind=state_field_consistency logical_columns=id,command_id,invocation_no,invocation_kind,command_domain_request_hash,submitted_request_hash,actor_ref,auth_session_ref,requested_at_ms,disposition,result_value_id,result_hash,result_schema_resource_id,result_schema_hash,referenced_terminal_result_value_id,referenced_terminal_result_hash,referenced_terminal_result_schema_resource_id,referenced_terminal_result_schema_hash,decided_at_ms,applied_at_ms,previous_invocation_hash,invocation_hash */,
  CONSTRAINT "ck:activation_invocations:hash_chain" CHECK ((("invocation_no" = 1 AND "previous_invocation_hash" IS NULL) OR ("invocation_no" > 1 AND "previous_invocation_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=invocation_no,previous_invocation_hash,invocation_hash */
);

CREATE TABLE "workflow_feature_release_activation_events" (
  "command_id" TEXT NOT NULL /* logical_type=identifier */,
  "event_no" INTEGER NOT NULL /* logical_type=integer */,
  "attempt_no" INTEGER NOT NULL /* logical_type=integer */,
  "phase" TEXT NOT NULL /* logical_type=text */,
  "event_type" TEXT NOT NULL /* logical_type=text */,
  "failure_code" TEXT /* logical_type=text */,
  "verified_feature_id" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_registry reference_domain=feature immutable=1 */,
  "verified_target_feature_release_id" TEXT /* logical_type=identifier */,
  "verified_target_feature_release_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_release_ref_validator reference_domain=feature_release immutable=1 */,
  "verified_target_feature_release_version" TEXT /* logical_type=text */,
  "verified_target_feature_release_hash" TEXT /* logical_type=hash */,
  "verified_previous_feature_release_id" TEXT /* logical_type=identifier */,
  "verified_previous_feature_release_ref" TEXT /* logical_type=external_reference external_ref=1 validator_owner=feature_release_ref_validator reference_domain=feature_release immutable=1 */,
  "verified_previous_feature_release_version" TEXT /* logical_type=text */,
  "verified_previous_feature_release_hash" TEXT /* logical_type=hash */,
  "detail_value_id" TEXT /* logical_type=identifier */,
  "detail_hash" TEXT /* logical_type=hash */,
  "detail_schema_resource_id" TEXT /* logical_type=identifier */,
  "detail_schema_hash" TEXT /* logical_type=hash */,
  "previous_event_hash" TEXT /* logical_type=hash */,
  "event_hash" TEXT NOT NULL /* logical_type=hash */,
  "occurred_at_ms" INTEGER NOT NULL /* logical_type=integer */,
  CONSTRAINT "pk:workflow_feature_release_activation_events" PRIMARY KEY ("command_id", "event_no"),
  CONSTRAINT "fk:activation_events:command" FOREIGN KEY ("command_id") REFERENCES "workflow_feature_release_activation_commands" ("command_id") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_events:attempt_invocation" FOREIGN KEY ("command_id", "attempt_no") REFERENCES "workflow_feature_release_activation_invocations" ("command_id", "invocation_no") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_events:verified_target_release" FOREIGN KEY ("verified_feature_id", "verified_target_feature_release_id", "verified_target_feature_release_hash") REFERENCES "workflow_feature_releases" ("feature_id", "id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_events:verified_previous_release" FOREIGN KEY ("verified_feature_id", "verified_previous_feature_release_id", "verified_previous_feature_release_hash") REFERENCES "workflow_feature_releases" ("feature_id", "id", "release_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "fk:activation_events:detail_value" FOREIGN KEY ("detail_value_id", "detail_hash", "detail_schema_resource_id", "detail_schema_hash") REFERENCES "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash") ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "ck:workflow_feature_release_activation_events:event_no:safe_integer" CHECK (("event_no" IS NULL OR "event_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=event_no */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:attempt_no:safe_integer" CHECK (("attempt_no" IS NULL OR "attempt_no" BETWEEN 1 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=attempt_no */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:phase:enum" CHECK ("phase" IN ('authenticate', 'validate', 'preflight', 'activation_transaction', 'recovery', 'finalize')) /* check_kind=enum_membership logical_columns=phase */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:event_type:enum" CHECK ("event_type" IN ('attempt_started', 'phase_succeeded', 'pre_transaction_failed', 'activation_transaction_started', 'activation_committed', 'domain_request_conflicted', 'pointer_cas_conflicted', 'terminal_result_committed', 'terminal_replayed', 'recovery_started', 'recovery_succeeded', 'recovery_failed', 'integrity_failed')) /* check_kind=enum_membership logical_columns=event_type */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:verified_target_feature_release_hash:hash" CHECK (("verified_target_feature_release_hash" IS NULL OR (length("verified_target_feature_release_hash") = 71 AND substr("verified_target_feature_release_hash", 1, 7) = 'sha256:' AND substr("verified_target_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=verified_target_feature_release_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:verified_previous_feature_release_hash:hash" CHECK (("verified_previous_feature_release_hash" IS NULL OR (length("verified_previous_feature_release_hash") = 71 AND substr("verified_previous_feature_release_hash", 1, 7) = 'sha256:' AND substr("verified_previous_feature_release_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=verified_previous_feature_release_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:detail_hash:hash" CHECK (("detail_hash" IS NULL OR (length("detail_hash") = 71 AND substr("detail_hash", 1, 7) = 'sha256:' AND substr("detail_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=detail_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:detail_schema_hash:hash" CHECK (("detail_schema_hash" IS NULL OR (length("detail_schema_hash") = 71 AND substr("detail_schema_hash", 1, 7) = 'sha256:' AND substr("detail_schema_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=detail_schema_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:previous_event_hash:hash" CHECK (("previous_event_hash" IS NULL OR (length("previous_event_hash") = 71 AND substr("previous_event_hash", 1, 7) = 'sha256:' AND substr("previous_event_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=previous_event_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:event_hash:hash" CHECK (("event_hash" IS NULL OR (length("event_hash") = 71 AND substr("event_hash", 1, 7) = 'sha256:' AND substr("event_hash", 8) NOT GLOB '*[^0-9a-f]*'))) /* check_kind=hash_format logical_columns=event_hash */,
  CONSTRAINT "ck:workflow_feature_release_activation_events:occurred_at_ms:safe_integer" CHECK (("occurred_at_ms" IS NULL OR "occurred_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=occurred_at_ms */,
  CONSTRAINT "ck:activation_events:verified_release_binding" CHECK ((("verified_feature_id" IS NULL AND "verified_target_feature_release_id" IS NULL AND "verified_target_feature_release_ref" IS NULL AND "verified_target_feature_release_version" IS NULL AND "verified_target_feature_release_hash" IS NULL AND "verified_previous_feature_release_id" IS NULL AND "verified_previous_feature_release_ref" IS NULL AND "verified_previous_feature_release_version" IS NULL AND "verified_previous_feature_release_hash" IS NULL) OR ("verified_feature_id" IS NOT NULL AND "verified_target_feature_release_id" IS NOT NULL AND "verified_target_feature_release_ref" IS NOT NULL AND "verified_target_feature_release_version" IS NOT NULL AND "verified_target_feature_release_hash" IS NOT NULL AND (("verified_previous_feature_release_id" IS NULL AND "verified_previous_feature_release_ref" IS NULL AND "verified_previous_feature_release_version" IS NULL AND "verified_previous_feature_release_hash" IS NULL) OR ("verified_previous_feature_release_id" IS NOT NULL AND "verified_previous_feature_release_ref" IS NOT NULL AND "verified_previous_feature_release_version" IS NOT NULL AND "verified_previous_feature_release_hash" IS NOT NULL))))) /* check_kind=closed_target_mapping logical_columns=verified_feature_id,verified_target_feature_release_id,verified_target_feature_release_ref,verified_target_feature_release_version,verified_target_feature_release_hash,verified_previous_feature_release_id,verified_previous_feature_release_ref,verified_previous_feature_release_version,verified_previous_feature_release_hash */,
  CONSTRAINT "ck:activation_events:detail_binding" CHECK ((("detail_value_id" IS NULL AND "detail_hash" IS NULL AND "detail_schema_resource_id" IS NULL AND "detail_schema_hash" IS NULL) OR ("detail_value_id" IS NOT NULL AND "detail_hash" IS NOT NULL AND "detail_schema_resource_id" IS NOT NULL AND "detail_schema_hash" IS NOT NULL))) /* check_kind=all_or_none logical_columns=detail_value_id,detail_hash,detail_schema_resource_id,detail_schema_hash */,
  CONSTRAINT "ck:activation_events:hash_chain" CHECK ((("event_no" = 1 AND "previous_event_hash" IS NULL) OR ("event_no" > 1 AND "previous_event_hash" IS NOT NULL))) /* check_kind=state_field_consistency logical_columns=event_no,previous_event_hash,event_hash */,
  CONSTRAINT "ck:activation_events:event_mapping" CHECK ((("event_type" = 'attempt_started' AND "phase" = 'authenticate' AND "failure_code" IS NULL) OR ("event_type" = 'phase_succeeded' AND "phase" IN ('authenticate', 'validate', 'preflight', 'finalize') AND "failure_code" IS NULL) OR ("event_type" = 'pre_transaction_failed' AND "phase" IN ('authenticate', 'validate', 'preflight') AND "failure_code" IS NOT NULL) OR ("event_type" IN ('activation_transaction_started', 'activation_committed') AND "phase" = 'activation_transaction' AND "failure_code" IS NULL) OR ("event_type" = 'domain_request_conflicted' AND "phase" = 'validate' AND "failure_code" IS NOT NULL) OR ("event_type" = 'pointer_cas_conflicted' AND "phase" = 'activation_transaction' AND "failure_code" IS NOT NULL) OR ("event_type" IN ('terminal_result_committed', 'terminal_replayed') AND "phase" = 'finalize' AND "failure_code" IS NULL) OR ("event_type" IN ('recovery_started', 'recovery_succeeded') AND "phase" = 'recovery' AND "failure_code" IS NULL) OR ("event_type" IN ('recovery_failed', 'integrity_failed') AND "phase" = 'recovery' AND "failure_code" IS NOT NULL))) /* check_kind=closed_target_mapping logical_columns=phase,event_type,failure_code */
);

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
  CONSTRAINT "ck:plan_generated_schemas:generator:enum" CHECK ("generator" IN ('join_expose', 'child_completion', 'map_result', 'node_output_envelope')) /* check_kind=enum_membership logical_columns=generator */,
  CONSTRAINT "ck:plan_generated_schemas:created_at_ms:safe_integer" CHECK (("created_at_ms" IS NULL OR "created_at_ms" BETWEEN 0 AND 9007199254740991)) /* check_kind=safe_integer logical_columns=created_at_ms */
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

CREATE UNIQUE INDEX "uk:resource_accounts:deployment" ON "workflow_graph_resource_accounts" ("deployment_scope_ref", "resource_type") WHERE "deployment_scope_ref" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_accounts:workflow" ON "workflow_graph_resource_accounts" ("workflow_id", "resource_type") WHERE "workflow_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_accounts:run" ON "workflow_graph_resource_accounts" ("graph_run_id", "resource_type") WHERE "graph_run_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_accounts:scope" ON "workflow_graph_resource_accounts" ("scope_id", "resource_type") WHERE "scope_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_accounts:node" ON "workflow_graph_resource_accounts" ("node_id", "resource_type") WHERE "node_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_accounts:execution_group" ON "workflow_graph_resource_accounts" ("execution_group_resource_id", "resource_type") WHERE "execution_group_resource_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:workflow_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_workflow_id", "resource_type", "purpose") WHERE "consumer_workflow_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:build_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_build_id", "resource_type", "purpose") WHERE "consumer_build_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:scope_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_scope_id", "resource_type", "purpose") WHERE "consumer_scope_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:node_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_node_id", "resource_type", "purpose") WHERE "consumer_node_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:attempt_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_attempt_id", "resource_type", "purpose") WHERE "consumer_attempt_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:wait_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_wait_id", "resource_type", "purpose") WHERE "consumer_wait_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:effect_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_effect_id", "resource_type", "purpose") WHERE "consumer_effect_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:resource_reservations:fact_consumer" ON "workflow_graph_resource_reservations" ("graph_run_id", "consumer_fact_id", "resource_type", "purpose") WHERE "consumer_fact_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:ledger_entries:idempotency_key" ON "workflow_graph_resource_ledger_entries" ("idempotency_key");

CREATE UNIQUE INDEX "uk:ledger_entries:run_seq" ON "workflow_graph_resource_ledger_entries" ("graph_run_id", "ledger_seq");

CREATE UNIQUE INDEX "uk:domain_claims:resource_epoch" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "claim_epoch");

CREATE UNIQUE INDEX "uk:domain_claims:exact_identity" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity");

CREATE UNIQUE INDEX "uk:domain_claims:head_identity" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "mode", "claim_epoch", "fencing_token_identity", "active_head_claim_id");

CREATE UNIQUE INDEX "uk:domain_claims:effect_identity" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id", "owner_workflow_id", "claim_epoch", "fencing_token_identity");

CREATE UNIQUE INDEX "uk:domain_claims:handoff_chain" ON "workflow_domain_resource_claims" ("handoff_id", "id", "predecessor_claim_id");

CREATE UNIQUE INDEX "uk:domain_claims:resource_id" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "id");

CREATE UNIQUE INDEX "uk:domain_resource_heads:active_claim" ON "workflow_domain_resource_heads" ("namespace", "key_hash", "active_claim_id", "active_claim_owner_workflow_id", "active_claim_mode", "active_claim_epoch", "active_fencing_token_identity");

CREATE UNIQUE INDEX "uk:values:id_hash" ON "workflow_values" ("id", "content_hash");

CREATE UNIQUE INDEX "uk:values:id_hash_schema" ON "workflow_values" ("id", "content_hash", "schema_resource_id", "schema_resource_hash");

CREATE UNIQUE INDEX "uk:value_edges:member_key" ON "workflow_value_edges" ("parent_value_id", "relation_kind", "member_key") WHERE "member_key" IS NOT NULL;

CREATE UNIQUE INDEX "uk:value_edges:member_index" ON "workflow_value_edges" ("parent_value_id", "relation_kind", "member_index") WHERE "member_index" IS NOT NULL;

CREATE UNIQUE INDEX "uk:registry_resources:type_ref" ON "workflow_registry_resources" ("resource_type", "resource_id", "resource_version");

CREATE UNIQUE INDEX "uk:registry_resources:id_hash" ON "workflow_registry_resources" ("id", "content_hash");

CREATE UNIQUE INDEX "uk:closure_manifests:closure_hash" ON "workflow_registry_closure_manifests" ("closure_hash");

CREATE UNIQUE INDEX "uk:closure_manifests:id_hash" ON "workflow_registry_closure_manifests" ("id", "closure_hash");

CREATE UNIQUE INDEX "uk:closure_members:manifest_index" ON "workflow_registry_closure_members" ("closure_manifest_id", "member_index");

CREATE UNIQUE INDEX "uk:registry_snapshots:snapshot_hash" ON "workflow_registry_snapshots" ("snapshot_hash");

CREATE UNIQUE INDEX "uk:registry_snapshots:id_hash" ON "workflow_registry_snapshots" ("id", "snapshot_hash");

CREATE UNIQUE INDEX "uk:feature_releases:feature_ref" ON "workflow_feature_releases" ("feature_id", "release_ref", "release_version");

CREATE UNIQUE INDEX "uk:feature_releases:id_hash" ON "workflow_feature_releases" ("id", "release_hash");

CREATE UNIQUE INDEX "uk:feature_releases:owner_identity" ON "workflow_feature_releases" ("feature_id", "id", "release_hash");

CREATE UNIQUE INDEX "uk:feature_releases:single_active" ON "workflow_feature_releases" ("feature_id") WHERE "status" = 'active';

CREATE UNIQUE INDEX "uk:retention_handles:feature" ON "workflow_registry_retention_handles" ("handle_kind", "feature_release_id", "closure_manifest_id") WHERE "feature_release_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:retention_handles:run" ON "workflow_registry_retention_handles" ("handle_kind", "graph_run_id", "closure_manifest_id") WHERE "graph_run_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:retention_handles:backup" ON "workflow_registry_retention_handles" ("handle_kind", "backup_id", "closure_manifest_id") WHERE "backup_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:retention_handles:actor" ON "workflow_registry_retention_handles" ("handle_kind", "external_actor_ref", "closure_manifest_id") WHERE "external_actor_ref" IS NOT NULL;

CREATE UNIQUE INDEX "uk:retention_handles:published_identity" ON "workflow_registry_retention_handles" ("id", "handle_kind", "feature_release_id", "closure_manifest_id", "closure_hash");

CREATE UNIQUE INDEX "uk:task_intakes:request_id" ON "workflow_task_intakes" ("request_id");

CREATE UNIQUE INDEX "uk:task_intakes:creation_key" ON "workflow_task_intakes" ("creation_domain", "creation_key");

CREATE UNIQUE INDEX "uk:intake_revisions:intake_revision" ON "workflow_task_intake_revisions" ("intake_id", "revision_no");

CREATE UNIQUE INDEX "uk:intake_revisions:intake_id" ON "workflow_task_intake_revisions" ("intake_id", "id");

CREATE UNIQUE INDEX "uk:intake_revisions:intake_id_no" ON "workflow_task_intake_revisions" ("intake_id", "id", "revision_no");

CREATE UNIQUE INDEX "uk:intake_revisions:idempotency" ON "workflow_task_intake_revisions" ("intake_id", "idempotency_key");

CREATE UNIQUE INDEX "uk:routing_attempts:intake_attempt" ON "workflow_routing_attempts" ("intake_id", "attempt_no");

CREATE UNIQUE INDEX "uk:creation_requests:creation_key" ON "workflow_creation_requests" ("creation_domain", "creation_key");

CREATE UNIQUE INDEX "uk:creation_requests:intake_created" ON "workflow_creation_requests" ("intake_id") WHERE "status" = 'created';

CREATE UNIQUE INDEX "uk:launch_confirmations:intake_idempotency" ON "workflow_launch_confirmations" ("intake_id", "idempotency_key");

CREATE UNIQUE INDEX "uk:launch_confirmations:id_hash" ON "workflow_launch_confirmations" ("id", "request_hash");

CREATE UNIQUE INDEX "uk:creation_attempts:request_attempt" ON "workflow_creation_attempts" ("creation_request_id", "attempt_no");

CREATE UNIQUE INDEX "uk:workflows:creation_key" ON "workflows" ("creation_domain", "creation_key");

CREATE UNIQUE INDEX "uk:workflows:id_state" ON "workflows" ("id", "state_instance_id");

CREATE UNIQUE INDEX "uk:workflows:id_run" ON "workflows" ("id", "current_graph_run_id");

CREATE UNIQUE INDEX "uk:state_activations:workflow_activation" ON "workflow_state_activations" ("workflow_id", "activation_no");

CREATE UNIQUE INDEX "uk:state_activations:graph_run" ON "workflow_state_activations" ("graph_run_id") WHERE "graph_run_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:state_activations:workflow_id" ON "workflow_state_activations" ("workflow_id", "id");

CREATE UNIQUE INDEX "uk:graph_runs:workflow_activation" ON "workflow_graph_runs" ("workflow_id", "state_instance_id");

CREATE UNIQUE INDEX "uk:graph_runs:workflow_id" ON "workflow_graph_runs" ("workflow_id", "id");

CREATE UNIQUE INDEX "uk:graph_runs:id_root_scope" ON "workflow_graph_runs" ("id", "root_scope_id");

CREATE UNIQUE INDEX "uk:operational_blockers:effect_source" ON "workflow_operational_blockers" ("graph_run_id", "blocker_kind", "source_effect_operation_id") WHERE "source_effect_operation_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:operational_blockers:outbox_source" ON "workflow_operational_blockers" ("graph_run_id", "blocker_kind", "source_outbox_id") WHERE "source_outbox_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:operational_blockers:finalization_source" ON "workflow_operational_blockers" ("graph_run_id", "blocker_kind", "source_root_finalization_schedule_id") WHERE "source_root_finalization_schedule_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:operational_blockers:claim_source" ON "workflow_operational_blockers" ("graph_run_id", "blocker_kind", "source_claim_id") WHERE "source_claim_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:operational_blockers:event_source" ON "workflow_operational_blockers" ("graph_run_id", "blocker_kind", "source_event_seq") WHERE "source_event_seq" IS NOT NULL;

CREATE UNIQUE INDEX "uk:blocker_attempts:blocker_attempt" ON "workflow_operational_blocker_remediation_attempts" ("blocker_id", "attempt_no");

CREATE UNIQUE INDEX "uk:blocker_attempts:key" ON "workflow_operational_blocker_remediation_attempts" ("attempt_key");

CREATE UNIQUE INDEX "uk:transition_history:source_activation" ON "workflow_state_transition_history" ("source_state_instance_id");

CREATE UNIQUE INDEX "uk:transition_history:completion_cut" ON "workflow_state_transition_history" ("completion_cut_id");

CREATE UNIQUE INDEX "uk:workflow_relations:source_effect" ON "workflow_relations" ("parent_workflow_id", "source_completion_cut_id", "transition_effect_id");

CREATE UNIQUE INDEX "uk:workflow_relations:child" ON "workflow_relations" ("child_workflow_id");

CREATE UNIQUE INDEX "uk:workflow_relations:id_parent_child" ON "workflow_relations" ("id", "parent_workflow_id", "child_workflow_id");

CREATE UNIQUE INDEX "uk:root_finalization_schedules:close_effect" ON "workflow_root_finalization_schedules" ("close_request_id", "transition_effect_id");

CREATE UNIQUE INDEX "uk:root_finalization_schedules:creation_key" ON "workflow_root_finalization_schedules" ("creation_domain", "creation_key");

CREATE UNIQUE INDEX "uk:root_finalization_schedules:intake" ON "workflow_root_finalization_schedules" ("transition_intake_id");

CREATE UNIQUE INDEX "uk:root_finalization_schedules:creation_request" ON "workflow_root_finalization_schedules" ("creation_request_id");

CREATE UNIQUE INDEX "uk:root_finalization_schedules:handoff_child" ON "workflow_root_finalization_schedules" ("id", "workflow_id", "creation_request_id", "child_workflow_id", "status");

CREATE UNIQUE INDEX "uk:root_finalization_attempts:key" ON "workflow_root_finalization_attempts" ("attempt_key");

CREATE UNIQUE INDEX "uk:context_snapshots:workflow_revision" ON "workflow_context_snapshots" ("workflow_id", "revision");

CREATE UNIQUE INDEX "uk:context_snapshots:workflow_id_hash" ON "workflow_context_snapshots" ("workflow_id", "id", "snapshot_hash");

CREATE UNIQUE INDEX "uk:context_patches:completion_cut" ON "workflow_context_patches" ("completion_cut_id");

CREATE UNIQUE INDEX "uk:context_patch_operations:target_slot" ON "workflow_context_patch_operations" ("patch_id", "target_slot");

CREATE UNIQUE INDEX "uk:scope_plans:run_hash" ON "workflow_graph_scope_plans" ("graph_run_id", "plan_hash");

CREATE UNIQUE INDEX "uk:scope_plans:id_run_hash" ON "workflow_graph_scope_plans" ("id", "graph_run_id", "plan_hash");

CREATE UNIQUE INDEX "uk:scopes:child_key" ON "workflow_graph_scopes" ("graph_run_id", "parent_scope_id", "owner_node_id", "child_key");

CREATE UNIQUE INDEX "uk:scopes:root" ON "workflow_graph_scopes" ("graph_run_id") WHERE "parent_scope_id" IS NULL;

CREATE UNIQUE INDEX "uk:scopes:run_id" ON "workflow_graph_scopes" ("graph_run_id", "id");

CREATE UNIQUE INDEX "uk:scopes:run_id_parent_owner" ON "workflow_graph_scopes" ("graph_run_id", "id", "parent_scope_id", "owner_node_id");

CREATE UNIQUE INDEX "uk:scope_builds:invocation" ON "workflow_graph_scope_builds" ("graph_run_id", "owner_node_id", "invocation_key");

CREATE UNIQUE INDEX "uk:scope_builds:root" ON "workflow_graph_scope_builds" ("graph_run_id") WHERE "scope_kind" = 'root';

CREATE UNIQUE INDEX "uk:scope_builds:run_id" ON "workflow_graph_scope_builds" ("graph_run_id", "id");

CREATE UNIQUE INDEX "uk:expansion_manifests:owner" ON "workflow_graph_expansion_manifests" ("owner_node_id");

CREATE UNIQUE INDEX "uk:map_item_results:index" ON "workflow_graph_map_item_results" ("owner_node_id", "item_index");

CREATE UNIQUE INDEX "uk:map_item_results:key" ON "workflow_graph_map_item_results" ("owner_node_id", "item_key_hash");

CREATE UNIQUE INDEX "uk:map_item_results:consumption_lineage" ON "workflow_graph_map_item_results" ("graph_run_id", "owner_scope_id", "owner_node_id", "id", "scope_id", "outcome_state");

CREATE UNIQUE INDEX "uk:map_item_results:child_scope" ON "workflow_graph_map_item_results" ("graph_run_id", "owner_scope_id", "owner_node_id", "scope_id");

CREATE UNIQUE INDEX "uk:nodes:scope_key" ON "workflow_graph_nodes" ("scope_id", "node_key");

CREATE UNIQUE INDEX "uk:nodes:scope_id" ON "workflow_graph_nodes" ("scope_id", "id");

CREATE UNIQUE INDEX "uk:nodes:run_scope_id" ON "workflow_graph_nodes" ("graph_run_id", "scope_id", "id");

CREATE UNIQUE INDEX "uk:node_attempts:node_attempt" ON "workflow_graph_node_attempts" ("node_id", "attempt_no");

CREATE UNIQUE INDEX "uk:node_attempts:delegation" ON "workflow_graph_node_attempts" ("delegation_id") WHERE "delegation_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:node_attempts:parent" ON "workflow_graph_node_attempts" ("parent_attempt_id") WHERE "parent_attempt_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:node_attempts:composite" ON "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id", "attempt_no");

CREATE UNIQUE INDEX "uk:node_attempts:run_scope_node_id" ON "workflow_graph_node_attempts" ("graph_run_id", "scope_id", "node_id", "id");

CREATE UNIQUE INDEX "uk:node_attempts:run_id" ON "workflow_graph_node_attempts" ("graph_run_id", "id");

CREATE UNIQUE INDEX "uk:retry_schedules:node_next" ON "workflow_graph_retry_schedules" ("node_id", "next_attempt_no");

CREATE UNIQUE INDEX "uk:retry_schedules:source_attempt" ON "workflow_graph_retry_schedules" ("source_attempt_id");

CREATE UNIQUE INDEX "uk:waits:correlation" ON "workflow_graph_waits" ("graph_run_id", "contract_resource_id", "correlation_key_hash");

CREATE UNIQUE INDEX "uk:waits:node" ON "workflow_graph_waits" ("node_id");

CREATE UNIQUE INDEX "uk:waits:composite" ON "workflow_graph_waits" ("graph_run_id", "scope_id", "node_id", "id");

CREATE UNIQUE INDEX "uk:waits:run_id" ON "workflow_graph_waits" ("graph_run_id", "id");

CREATE UNIQUE INDEX "uk:edges:scope_key" ON "workflow_graph_edges" ("scope_id", "edge_key");

CREATE UNIQUE INDEX "uk:edges:run_scope_id" ON "workflow_graph_edges" ("graph_run_id", "scope_id", "id");

CREATE UNIQUE INDEX "uk:terminal_candidates:scope_node" ON "workflow_graph_terminal_candidates" ("scope_id", "terminal_node_id");

CREATE UNIQUE INDEX "uk:terminal_candidates:scope_id" ON "workflow_graph_terminal_candidates" ("scope_id", "id");

CREATE UNIQUE INDEX "uk:completion_eligibilities:scope_rule" ON "workflow_graph_completion_eligibilities" ("scope_id", "rule_id");

CREATE UNIQUE INDEX "uk:close_requests:scope" ON "workflow_graph_scope_close_requests" ("scope_id");

CREATE UNIQUE INDEX "uk:close_requests:scope_id" ON "workflow_graph_scope_close_requests" ("scope_id", "id");

CREATE UNIQUE INDEX "uk:close_requests:run_scope_id" ON "workflow_graph_scope_close_requests" ("graph_run_id", "scope_id", "id");

CREATE UNIQUE INDEX "uk:completion_cuts:scope" ON "workflow_graph_completion_cuts" ("scope_id");

CREATE UNIQUE INDEX "uk:completion_cuts:close" ON "workflow_graph_completion_cuts" ("close_request_id");

CREATE UNIQUE INDEX "uk:completion_cuts:run_scope_id" ON "workflow_graph_completion_cuts" ("graph_run_id", "scope_id", "id");

CREATE UNIQUE INDEX "uk:child_consumptions:child_scope" ON "workflow_graph_child_completion_consumptions" ("child_scope_id");

CREATE UNIQUE INDEX "uk:child_consumptions:run_child_scope" ON "workflow_graph_child_completion_consumptions" ("graph_run_id", "child_scope_id");

CREATE UNIQUE INDEX "uk:subtree_fence_manifests:close" ON "workflow_graph_subtree_fence_manifests" ("source_close_request_id");

CREATE UNIQUE INDEX "uk:inbox_events:provider_event" ON "workflow_graph_inbox_events" ("provider_ref", "provider_event_id");

CREATE UNIQUE INDEX "uk:late_results:source_event" ON "workflow_graph_late_results" ("source_event_id");

CREATE UNIQUE INDEX "uk:effect_operations:key" ON "workflow_graph_effect_operations" ("operation_key");

CREATE UNIQUE INDEX "uk:effect_operations:id_run" ON "workflow_graph_effect_operations" ("id", "graph_run_id");

CREATE UNIQUE INDEX "uk:facts:key" ON "workflow_graph_facts" ("graph_run_id", "fact_key");

CREATE UNIQUE INDEX "uk:facts:event_seq" ON "workflow_graph_facts" ("graph_run_id", "event_seq");

CREATE UNIQUE INDEX "uk:events:idempotency" ON "workflow_graph_events" ("idempotency_key");

CREATE UNIQUE INDEX "uk:outbox:effect_key" ON "workflow_outbox" ("effect_key");

CREATE UNIQUE INDEX "uk:outbox_attempts:history" ON "workflow_outbox_attempts" ("outbox_id", "history_seq");

CREATE UNIQUE INDEX "uk:outbox_attempts:kind_no" ON "workflow_outbox_attempts" ("outbox_id", "attempt_kind", "kind_attempt_no");

CREATE UNIQUE INDEX "uk:runtime_commands:idempotency" ON "workflow_runtime_commands" ("idempotency_domain", "idempotency_key");

CREATE UNIQUE INDEX "uk:runtime_commands:id_hash" ON "workflow_runtime_commands" ("command_id", "request_hash");

CREATE UNIQUE INDEX "uk:command_invocations:number" ON "workflow_runtime_command_invocations" ("command_id", "invocation_no");

CREATE UNIQUE INDEX "uk:command_invocations:command_id" ON "workflow_runtime_command_invocations" ("command_id", "id");

CREATE UNIQUE INDEX "uk:command_confirmations:request" ON "workflow_runtime_command_confirmations" ("request_command_id");

CREATE UNIQUE INDEX "uk:checkpoints:workflow_version" ON "workflow_checkpoints" ("workflow_id", "checkpoint_version");

CREATE UNIQUE INDEX "uk:checkpoints:completion_cut" ON "workflow_checkpoints" ("completion_cut_id") WHERE "completion_cut_id" IS NOT NULL;

CREATE UNIQUE INDEX "uk:capacity_commands:idempotency" ON "runtime_capacity_admin_commands" ("idempotency_domain", "idempotency_key");

CREATE UNIQUE INDEX "uk:capacity_commands:assigned_revision" ON "runtime_capacity_admin_commands" ("assigned_capacity_revision") WHERE "assigned_capacity_revision" IS NOT NULL;

CREATE UNIQUE INDEX "uk:capacity_commands:assigned_change" ON "runtime_capacity_admin_commands" ("assigned_change_id");

CREATE UNIQUE INDEX "uk:capacity_commands:assigned_lineage" ON "runtime_capacity_admin_commands" ("assigned_capacity_revision", "assigned_change_id", "proposed_config_hash");

CREATE UNIQUE INDEX "uk:capacity_invocations:command_no" ON "runtime_capacity_admin_invocations" ("command_id", "invocation_no");

CREATE UNIQUE INDEX "uk:capacity_events:single_commit_milestone" ON "runtime_capacity_change_events" ("change_id", "event_type") WHERE "event_type" IN ('prepared', 'file_installed', 'head_committed', 'watcher_published');

CREATE UNIQUE INDEX "uk:capacity_events:event_hash" ON "runtime_capacity_change_events" ("event_hash");

CREATE UNIQUE INDEX "uk:publisher_commands:idempotency" ON "workflow_publisher_commands" ("idempotency_domain", "idempotency_key");

CREATE UNIQUE INDEX "uk:publisher_commands:id_domain_request" ON "workflow_publisher_commands" ("command_id", "domain_request_hash");

CREATE UNIQUE INDEX "uk:publisher_invocations:command_no" ON "workflow_publisher_command_invocations" ("command_id", "invocation_no");

CREATE UNIQUE INDEX "uk:publisher_invocations:invocation_hash" ON "workflow_publisher_command_invocations" ("invocation_hash");

CREATE UNIQUE INDEX "uk:publisher_events:attempt_phase_type" ON "workflow_publisher_events" ("command_id", "attempt_no", "phase", "event_type");

CREATE UNIQUE INDEX "uk:publisher_events:event_hash" ON "workflow_publisher_events" ("event_hash");

CREATE UNIQUE INDEX "uk:activation_commands:idempotency" ON "workflow_feature_release_activation_commands" ("idempotency_domain", "idempotency_key");

CREATE UNIQUE INDEX "uk:activation_commands:id_domain_request" ON "workflow_feature_release_activation_commands" ("command_id", "domain_request_hash");

CREATE UNIQUE INDEX "uk:activation_invocations:command_no" ON "workflow_feature_release_activation_invocations" ("command_id", "invocation_no");

CREATE UNIQUE INDEX "uk:activation_invocations:invocation_hash" ON "workflow_feature_release_activation_invocations" ("invocation_hash");

CREATE UNIQUE INDEX "uk:activation_invocations:terminal_binding" ON "workflow_feature_release_activation_invocations" ("id", "command_id", "invocation_no", "command_domain_request_hash", "disposition", "invocation_hash", "submitted_request_hash", "result_value_id", "result_hash", "result_schema_resource_id", "result_schema_hash");

CREATE UNIQUE INDEX "uk:activation_events:attempt_phase_type" ON "workflow_feature_release_activation_events" ("command_id", "attempt_no", "phase", "event_type");

CREATE UNIQUE INDEX "uk:activation_events:event_hash" ON "workflow_feature_release_activation_events" ("event_hash");

CREATE UNIQUE INDEX "uk:generated_schema_contents:ref_hash" ON "workflow_generated_schema_contents" ("schema_ref", "schema_hash");

CREATE UNIQUE INDEX "uk:plan_generated_schemas:value_authority" ON "workflow_plan_generated_schemas" ("plan_id", "plan_hash", "schema_ref", "schema_hash", "generator", "parameter_hash");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:parent_claim" ON "workflow_domain_resource_claim_handoffs" ("parent_claim_id");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:child_claim" ON "workflow_domain_resource_claim_handoffs" ("child_claim_id");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:schedule_resource" ON "workflow_domain_resource_claim_handoffs" ("source_root_finalization_schedule_id", "namespace", "key_hash");

CREATE UNIQUE INDEX "uk:domain_claim_handoffs:chain" ON "workflow_domain_resource_claim_handoffs" ("id", "child_claim_id", "parent_claim_id");

CREATE UNIQUE INDEX "uk:command_ingress:domain_number" ON "workflow_runtime_command_ingress_invocations" ("idempotency_domain", "idempotency_key", "ingress_no");

CREATE UNIQUE INDEX "uk:command_ingress:resolved_invocation" ON "workflow_runtime_command_ingress_invocations" ("resolved_command_id", "resolved_invocation_id");

CREATE INDEX "idx:domain_claims:resource_status" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "status", "mode");

CREATE INDEX "idx:domain_claims:resource_history" ON "workflow_domain_resource_claims" ("namespace", "key_hash", "claim_epoch", "id");

CREATE INDEX "idx:value_edges:parent" ON "workflow_value_edges" ("parent_value_id", "relation_kind", "member_index", "member_key");

CREATE INDEX "idx:blob_write_intents:expiry" ON "workflow_blob_write_intents" ("lease_expires_at_ms", "id") WHERE "status" IN ('preparing','installed');

CREATE INDEX "idx:blob_objects:gc_state" ON "workflow_blob_objects" ("state", "gc_epoch", "blob_hash") WHERE "state" IN ('live','gc_candidate','deleting');

CREATE INDEX "idx:feature_releases:activation_preflight" ON "workflow_feature_releases" ("feature_id", "id", "release_hash", "status");

CREATE INDEX "idx:feature_active_releases:activation_cas" ON "workflow_feature_active_releases" ("feature_id", "row_version", "release_id", "release_hash");

CREATE INDEX "idx:retention_handles:activation_preflight" ON "workflow_registry_retention_handles" ("feature_release_id", "handle_kind", "status", "closure_manifest_id", "closure_hash", "row_version", "id");

CREATE INDEX "idx:workflows:deadline" ON "workflows" ("deadline_at_ms", "id") WHERE "finished_at_ms" IS NULL AND "deadline_at_ms" IS NOT NULL;

CREATE INDEX "idx:operational_blockers:open" ON "workflow_operational_blockers" ("graph_run_id", "severity", "status", "id") WHERE "status" = 'open';

CREATE INDEX "idx:operational_blockers:remediation_due" ON "workflow_operational_blockers" ("next_remediation_at_ms", "id") WHERE "status" = 'open' AND "next_remediation_at_ms" IS NOT NULL;

CREATE INDEX "idx:root_finalization_schedules:due" ON "workflow_root_finalization_schedules" ("status", "next_eligible_at_ms", "id") WHERE "status" IN ('pending','retry_wait');

CREATE INDEX "idx:scopes:parent" ON "workflow_graph_scopes" ("graph_run_id", "parent_scope_id", "depth", "id");

CREATE INDEX "idx:nodes:ready" ON "workflow_graph_nodes" ("phase", "activation_event_seq", "id") WHERE "phase" = 'ready';

CREATE INDEX "idx:node_attempts:execution_deadline" ON "workflow_graph_node_attempts" ("execution_deadline_at_ms", "id") WHERE "phase" = 'running';

CREATE INDEX "idx:node_attempts:lease_expiry" ON "workflow_graph_node_attempts" ("lease_expires_at_ms", "id") WHERE "lease_owner" IS NOT NULL;

CREATE INDEX "idx:node_attempts:evaluation_due" ON "workflow_graph_node_attempts" ("evaluation_next_attempt_at_ms", "id") WHERE "phase" = 'evaluating' AND "evaluation_next_attempt_at_ms" IS NOT NULL;

CREATE INDEX "idx:retry_schedules:due" ON "workflow_graph_retry_schedules" ("eligible_at_ms", "id") WHERE "status" = 'scheduled';

CREATE INDEX "idx:waits:deadline" ON "workflow_graph_waits" ("deadline_at_ms", "id") WHERE "status" = 'armed' AND "deadline_at_ms" IS NOT NULL;

CREATE INDEX "idx:edges:scope_kind" ON "workflow_graph_edges" ("scope_id", "edge_kind", "id");

CREATE INDEX "idx:completion_eligibilities:arbitration" ON "workflow_graph_completion_eligibilities" ("graph_run_id", "eligibility_event_seq", "rule_id", "scope_id");

CREATE INDEX "idx:inbox_events:correlation" ON "workflow_graph_inbox_events" ("graph_run_id", "contract_resource_id", "correlation_key_hash", "disposition", "inbox_seq");

CREATE INDEX "idx:inbox_events:expiry" ON "workflow_graph_inbox_events" ("expires_at_ms", "inbox_seq") WHERE "disposition" = 'pending';

CREATE INDEX "idx:facts:scope_event" ON "workflow_graph_facts" ("graph_run_id", "scope_id", "event_seq");

CREATE INDEX "idx:facts:queue" ON "workflow_graph_facts" ("graph_run_id", "causal_wave", "fact_kind", "stable_object_id");

CREATE INDEX "idx:outbox:due" ON "workflow_outbox" ("next_attempt_at_ms", "id") WHERE "status" IN ('pending','reconciling');

CREATE INDEX "idx:outbox:lease_expiry" ON "workflow_outbox" ("lease_expires_at_ms", "id") WHERE "status" IN ('processing','reconciling');

CREATE INDEX "idx:runtime_commands:idempotency" ON "workflow_runtime_commands" ("idempotency_domain", "idempotency_key");

CREATE INDEX "idx:checkpoints:workflow_version" ON "workflow_checkpoints" ("workflow_id", "checkpoint_version");

CREATE INDEX "idx:capacity_head:singleton" ON "runtime_capacity_head" ("singleton_key");

CREATE INDEX "idx:capacity_head:pending" ON "runtime_capacity_head" ("pending_change_id") WHERE "pending_change_id" IS NOT NULL;

CREATE INDEX "idx:capacity_commands:idempotency" ON "runtime_capacity_admin_commands" ("idempotency_domain", "idempotency_key");

CREATE INDEX "idx:capacity_commands:assigned_change" ON "runtime_capacity_admin_commands" ("assigned_change_id") WHERE "assigned_change_id" IS NOT NULL;

CREATE INDEX "idx:capacity_invocations:command_history" ON "runtime_capacity_admin_invocations" ("command_id", "invocation_no");

CREATE INDEX "idx:capacity_events:change_history" ON "runtime_capacity_change_events" ("change_id", "event_seq");

CREATE INDEX "idx:capacity_events:global_chain" ON "runtime_capacity_change_events" ("event_seq");

CREATE INDEX "idx:publisher_commands:idempotency" ON "workflow_publisher_commands" ("idempotency_domain", "idempotency_key");

CREATE INDEX "idx:publisher_commands:pending_recovery" ON "workflow_publisher_commands" ("created_at_ms", "command_id") WHERE "lifecycle" = 'pending';

CREATE INDEX "idx:publisher_invocations:command_history" ON "workflow_publisher_command_invocations" ("command_id", "invocation_no");

CREATE INDEX "idx:publisher_events:command_history" ON "workflow_publisher_events" ("command_id", "event_no");

CREATE INDEX "idx:activation_commands:idempotency" ON "workflow_feature_release_activation_commands" ("idempotency_domain", "idempotency_key");

CREATE INDEX "idx:activation_commands:terminal_result" ON "workflow_feature_release_activation_commands" ("command_id", "terminal_disposition", "canonical_terminal_invocation_no") WHERE "lifecycle" IN ('applied', 'failed', 'conflict');

CREATE INDEX "idx:activation_commands:pending_recovery" ON "workflow_feature_release_activation_commands" ("created_at_ms", "command_id") WHERE "lifecycle" = 'pending';

CREATE INDEX "idx:activation_invocations:command_history" ON "workflow_feature_release_activation_invocations" ("command_id", "invocation_no");

CREATE INDEX "idx:activation_events:command_history" ON "workflow_feature_release_activation_events" ("command_id", "event_no");

CREATE INDEX "idx:plan_generated_schemas:resolve" ON "workflow_plan_generated_schemas" ("plan_id", "schema_ref");

CREATE INDEX "idx:domain_claim_handoffs:resource_history" ON "workflow_domain_resource_claim_handoffs" ("namespace", "key_hash", "child_claim_epoch", "id");

CREATE INDEX "idx:command_ingress:idempotency_history" ON "workflow_runtime_command_ingress_invocations" ("idempotency_domain", "idempotency_key", "ingress_no");

CREATE INDEX "idx:command_ingress:submitted_command" ON "workflow_runtime_command_ingress_invocations" ("submitted_command_id");

CREATE TRIGGER "trg:operational_blockers:insert_cache" AFTER INSERT ON "workflow_operational_blockers" BEGIN
  UPDATE "workflow_graph_runs"
     SET "operational_state" = CASE WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'quarantine') THEN 'quarantined' WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'action_required') THEN 'action_required' ELSE 'healthy' END,
         "row_version" = "row_version" + 1
   WHERE "id" = NEW."graph_run_id"
     AND "operational_state" <> 'administratively_abandoned';
  UPDATE "workflows"
     SET "operational_state" = CASE WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'quarantine') THEN 'quarantined' WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'action_required') THEN 'action_required' ELSE 'healthy' END,
         "row_version" = "row_version" + 1,
         "updated_at_ms" = CASE WHEN "updated_at_ms" < NEW."opened_at_ms" THEN NEW."opened_at_ms" ELSE "updated_at_ms" END
   WHERE "id" = NEW."workflow_id"
     AND "operational_state" <> 'administratively_abandoned';
END;

CREATE TRIGGER "trg:operational_blockers:update_cache" AFTER UPDATE OF "status", "severity" ON "workflow_operational_blockers" WHEN OLD."status" IS NOT NEW."status" OR OLD."severity" IS NOT NEW."severity" BEGIN
  UPDATE "workflow_graph_runs"
     SET "operational_state" = CASE WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'quarantine') THEN 'quarantined' WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'action_required') THEN 'action_required' ELSE 'healthy' END,
         "row_version" = "row_version" + 1
   WHERE "id" = NEW."graph_run_id"
     AND "operational_state" <> 'administratively_abandoned';
  UPDATE "workflows"
     SET "operational_state" = CASE WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'quarantine') THEN 'quarantined' WHEN EXISTS (SELECT 1 FROM "workflow_operational_blockers" AS b WHERE b."graph_run_id" = NEW."graph_run_id" AND b."status" = 'open' AND b."severity" = 'action_required') THEN 'action_required' ELSE 'healthy' END,
         "row_version" = "row_version" + 1,
         "updated_at_ms" = CASE WHEN "updated_at_ms" < NEW."opened_at_ms" THEN NEW."opened_at_ms" ELSE "updated_at_ms" END
   WHERE "id" = NEW."workflow_id"
     AND "operational_state" <> 'administratively_abandoned';
END;

CREATE TRIGGER "trg:intake_revisions:adjacent_parent" AFTER INSERT ON "workflow_task_intake_revisions" WHEN NEW."revision_no" > 0 BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_task_intake_revisions" AS parent WHERE parent."id" = NEW."parent_revision_id" AND parent."intake_id" = NEW."intake_id" AND parent."revision_no" = NEW."revision_no" - 1) THEN RAISE(ABORT, 'intake_revision_parent_not_adjacent') END;
END;

CREATE TRIGGER "trg:scopes:nullable_plan_close" BEFORE UPDATE OF "lifecycle", "plan_id" ON "workflow_graph_scopes" WHEN NEW."plan_id" IS NULL AND NEW."lifecycle" IN ('closing', 'closed') BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_graph_scope_close_requests" AS request WHERE request."scope_id" = NEW."id" AND request."graph_run_id" = NEW."graph_run_id" AND request."reason" IN ('engine_error', 'local_cancel', 'workflow_cancel')) THEN RAISE(ABORT, 'planless_root_close_without_setup_error_or_cancel') END;
END;

CREATE TRIGGER "trg:command_confirmations:ttl_insert" AFTER INSERT ON "workflow_runtime_command_confirmations" BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM "workflow_runtime_commands" AS command WHERE command."command_id" = NEW."request_command_id" AND NEW."expires_at_ms" = command."created_at_ms" + 300000) THEN RAISE(ABORT, 'command_confirmation_ttl_invalid') END;
END;

CREATE TRIGGER "trg:command_confirmations:ttl_update" BEFORE UPDATE OF "request_command_id", "expires_at_ms" ON "workflow_runtime_command_confirmations" BEGIN
  SELECT CASE WHEN NEW."request_command_id" IS NOT OLD."request_command_id" OR NEW."expires_at_ms" IS NOT OLD."expires_at_ms" THEN RAISE(ABORT, 'command_confirmation_ttl_is_immutable') END;
END;

CREATE TRIGGER "trg:capacity_events:hash_chain" AFTER INSERT ON "runtime_capacity_change_events" BEGIN
  SELECT CASE WHEN (NEW."event_seq" = 1 AND NEW."previous_event_hash" IS NOT NULL) OR (NEW."event_seq" > 1 AND (SELECT previous."event_hash" FROM "runtime_capacity_change_events" AS previous WHERE previous."event_seq" = NEW."event_seq" - 1) IS NOT NEW."previous_event_hash") THEN RAISE(ABORT, 'capacity_event_hash_chain_invalid') END;
END;

CREATE TRIGGER "trg:capacity_events:immutable_update" BEFORE UPDATE ON "runtime_capacity_change_events" BEGIN
  SELECT RAISE(ABORT, 'capacity_event_is_immutable');
END;

CREATE TRIGGER "trg:capacity_events:immutable_delete" BEFORE DELETE ON "runtime_capacity_change_events" BEGIN
  SELECT RAISE(ABORT, 'capacity_event_is_immutable');
END;

CREATE TRIGGER "trg:capacity_head:commit_transition" BEFORE UPDATE OF "current_capacity_revision", "current_change_id", "current_config_hash", "current_publication_hash" ON "runtime_capacity_head" WHEN NEW."current_change_id" IS NOT OLD."current_change_id" BEGIN
  SELECT CASE WHEN OLD."pending_change_id" IS NOT NEW."current_change_id" OR NEW."pending_change_id" IS NOT NULL OR NEW."current_capacity_revision" <> COALESCE(OLD."current_capacity_revision", 0) + 1 THEN RAISE(ABORT, 'capacity_head_commit_transition_invalid') END;
END;

CREATE TRIGGER "trg:publisher_commands:immutable_identity" BEFORE UPDATE OF "command_type", "idempotency_domain", "idempotency_key", "request_value_id", "request_hash", "request_schema_resource_id", "request_schema_hash", "domain_request_hash", "approved_review_ref", "approved_review_hash", "reviewer_actor_ref", "reviewer_auth_session_ref", "approved_at_ms", "expires_at_ms", "source_manifest_value_id", "source_manifest_hash", "source_manifest_schema_resource_id", "source_manifest_schema_hash", "compiled_plan_value_id", "compiled_plan_hash", "compiled_plan_schema_resource_id", "compiled_plan_schema_hash", "execution_artifact_resource_id", "execution_artifact_hash", "closure_manifest_id", "closure_hash", "target_feature_release_id", "target_feature_release_hash", "created_at_ms" ON "workflow_publisher_commands" BEGIN
  SELECT RAISE(ABORT, 'publisher_command_identity_is_immutable');
END;

CREATE TRIGGER "trg:publisher_commands:lifecycle_transition" BEFORE UPDATE ON "workflow_publisher_commands" BEGIN
  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR (NEW."lifecycle" IS NOT OLD."lifecycle" AND OLD."lifecycle" <> 'pending') THEN RAISE(ABORT, 'publisher_command_lifecycle_transition_invalid') END;
END;

CREATE TRIGGER "trg:publisher_commands:immutable_delete" BEFORE DELETE ON "workflow_publisher_commands" BEGIN
  SELECT RAISE(ABORT, 'publisher_command_is_immutable');
END;

CREATE TRIGGER "trg:publisher_invocations:hash_chain" AFTER INSERT ON "workflow_publisher_command_invocations" BEGIN
  SELECT CASE WHEN (NEW."invocation_no" = 1 AND NEW."previous_invocation_hash" IS NOT NULL) OR (NEW."invocation_no" > 1 AND (SELECT previous."invocation_hash" FROM "workflow_publisher_command_invocations" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."invocation_no" = NEW."invocation_no" - 1) IS NOT NEW."previous_invocation_hash") THEN RAISE(ABORT, 'publisher_invocation_hash_chain_invalid') END;
END;

CREATE TRIGGER "trg:publisher_invocations:immutable_update" BEFORE UPDATE ON "workflow_publisher_command_invocations" BEGIN
  SELECT RAISE(ABORT, 'publisher_invocation_is_immutable');
END;

CREATE TRIGGER "trg:publisher_invocations:immutable_delete" BEFORE DELETE ON "workflow_publisher_command_invocations" BEGIN
  SELECT RAISE(ABORT, 'publisher_invocation_is_immutable');
END;

CREATE TRIGGER "trg:publisher_events:hash_chain" AFTER INSERT ON "workflow_publisher_events" BEGIN
  SELECT CASE WHEN (NEW."event_no" = 1 AND NEW."previous_event_hash" IS NOT NULL) OR (NEW."event_no" > 1 AND (SELECT previous."event_hash" FROM "workflow_publisher_events" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."event_no" = NEW."event_no" - 1) IS NOT NEW."previous_event_hash") THEN RAISE(ABORT, 'publisher_event_hash_chain_invalid') END;
END;

CREATE TRIGGER "trg:publisher_events:immutable_update" BEFORE UPDATE ON "workflow_publisher_events" BEGIN
  SELECT RAISE(ABORT, 'publisher_event_is_immutable');
END;

CREATE TRIGGER "trg:publisher_events:immutable_delete" BEFORE DELETE ON "workflow_publisher_events" BEGIN
  SELECT RAISE(ABORT, 'publisher_event_is_immutable');
END;

CREATE TRIGGER "trg:feature_releases:immutable_identity" BEFORE UPDATE OF "id", "feature_id", "release_ref", "release_version", "release_hash", "execution_artifact_resource_id", "execution_artifact_hash", "staged_at_ms" ON "workflow_feature_releases" BEGIN
  SELECT RAISE(ABORT, 'feature_release_identity_is_immutable');
END;

CREATE TRIGGER "trg:feature_releases:lifecycle_transition" BEFORE UPDATE OF "status", "activated_at_ms", "disabled_at_ms", "row_version" ON "workflow_feature_releases" BEGIN
  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR NOT ((OLD."status" = 'staged' AND NEW."status" = 'active' AND NEW."activated_at_ms" IS NOT NULL AND NEW."disabled_at_ms" IS NULL) OR (OLD."status" = 'active' AND NEW."status" = 'draining' AND NEW."activated_at_ms" IS OLD."activated_at_ms" AND NEW."disabled_at_ms" IS NULL) OR (OLD."status" = 'draining' AND NEW."status" = 'disabled' AND NEW."activated_at_ms" IS OLD."activated_at_ms" AND NEW."disabled_at_ms" IS NOT NULL) OR (OLD."status" = 'disabled' AND NEW."status" = 'deleting' AND NEW."activated_at_ms" IS OLD."activated_at_ms" AND NEW."disabled_at_ms" IS OLD."disabled_at_ms")) THEN RAISE(ABORT, 'feature_release_lifecycle_transition_invalid') END;
END;

CREATE TRIGGER "trg:feature_releases:protected_delete" BEFORE DELETE ON "workflow_feature_releases" WHEN OLD."status" IN ('active', 'draining') BEGIN
  SELECT RAISE(ABORT, 'active_or_draining_feature_release_delete_forbidden');
END;

CREATE TRIGGER "trg:feature_active_releases:target_active_insert" AFTER INSERT ON "workflow_feature_active_releases" BEGIN
  SELECT CASE WHEN NEW."row_version" <> 1 OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."feature_id" AND release."id" = NEW."release_id" AND release."release_hash" = NEW."release_hash" AND release."status" = 'active') THEN RAISE(ABORT, 'feature_active_release_insert_invalid') END;
END;

CREATE TRIGGER "trg:feature_active_releases:cas_update" BEFORE UPDATE ON "workflow_feature_active_releases" BEGIN
  SELECT CASE WHEN NEW."feature_id" IS NOT OLD."feature_id" OR NEW."row_version" <> OLD."row_version" + 1 OR (NEW."release_id" IS OLD."release_id" AND NEW."release_hash" IS OLD."release_hash") OR NEW."activated_at_ms" < OLD."activated_at_ms" OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."feature_id" AND release."id" = NEW."release_id" AND release."release_hash" = NEW."release_hash" AND release."status" = 'active') THEN RAISE(ABORT, 'feature_active_release_cas_invalid') END;
END;

CREATE TRIGGER "trg:feature_active_releases:immutable_delete" BEFORE DELETE ON "workflow_feature_active_releases" BEGIN
  SELECT RAISE(ABORT, 'feature_active_release_delete_forbidden');
END;

CREATE TRIGGER "trg:retention_handles:immutable_published_identity" BEFORE UPDATE OF "id", "handle_kind", "feature_release_id", "graph_run_id", "backup_id", "external_actor_ref", "closure_manifest_id", "closure_hash", "created_at_ms" ON "workflow_registry_retention_handles" BEGIN
  SELECT RAISE(ABORT, 'retention_handle_identity_is_immutable');
END;

CREATE TRIGGER "trg:retention_handles:release_transition" BEFORE UPDATE OF "status", "released_at_ms", "row_version" ON "workflow_registry_retention_handles" BEGIN
  SELECT CASE WHEN NEW."row_version" <> OLD."row_version" + 1 OR OLD."status" <> 'held' OR NEW."status" <> 'released' OR (OLD."handle_kind" = 'published' AND EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."id" = OLD."feature_release_id" AND release."status" IN ('active', 'draining'))) THEN RAISE(ABORT, 'retention_handle_release_transition_invalid') END;
END;

CREATE TRIGGER "trg:retention_handles:protected_delete" BEFORE DELETE ON "workflow_registry_retention_handles" WHEN OLD."handle_kind" = 'published' AND EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."id" = OLD."feature_release_id" AND release."status" IN ('active', 'draining')) BEGIN
  SELECT RAISE(ABORT, 'active_or_draining_release_retention_delete_forbidden');
END;

CREATE TRIGGER "trg:activation_commands:immutable_identity" BEFORE UPDATE OF "command_type", "idempotency_domain", "idempotency_key", "request_value_id", "request_hash", "request_schema_resource_id", "request_schema_hash", "domain_request_hash", "created_at_ms" ON "workflow_feature_release_activation_commands" BEGIN
  SELECT RAISE(ABORT, 'activation_command_identity_is_immutable');
END;

CREATE TRIGGER "trg:activation_commands:verified_fact_transition" BEFORE UPDATE ON "workflow_feature_release_activation_commands" BEGIN
  SELECT CASE WHEN OLD."lifecycle" <> 'pending' OR NEW."row_version" <> OLD."row_version" + 1 OR (OLD."verified_target_feature_release_id" IS NOT NULL AND (NEW."verified_feature_id" IS NOT OLD."verified_feature_id" OR NEW."verified_target_feature_release_id" IS NOT OLD."verified_target_feature_release_id" OR NEW."verified_target_feature_release_ref" IS NOT OLD."verified_target_feature_release_ref" OR NEW."verified_target_feature_release_version" IS NOT OLD."verified_target_feature_release_version" OR NEW."verified_target_feature_release_hash" IS NOT OLD."verified_target_feature_release_hash")) OR (OLD."verified_previous_feature_release_id" IS NOT NULL AND (NEW."verified_previous_feature_release_id" IS NOT OLD."verified_previous_feature_release_id" OR NEW."verified_previous_feature_release_ref" IS NOT OLD."verified_previous_feature_release_ref" OR NEW."verified_previous_feature_release_version" IS NOT OLD."verified_previous_feature_release_version" OR NEW."verified_previous_feature_release_hash" IS NOT OLD."verified_previous_feature_release_hash")) OR (OLD."verified_target_retention_handle_id" IS NOT NULL AND (NEW."verified_target_retention_handle_id" IS NOT OLD."verified_target_retention_handle_id" OR NEW."verified_target_retention_handle_kind" IS NOT OLD."verified_target_retention_handle_kind" OR NEW."verified_target_retention_feature_release_id" IS NOT OLD."verified_target_retention_feature_release_id" OR NEW."verified_target_retention_closure_manifest_id" IS NOT OLD."verified_target_retention_closure_manifest_id" OR NEW."verified_target_retention_closure_hash" IS NOT OLD."verified_target_retention_closure_hash")) OR (OLD."verified_target_retention_observed_status" IS NOT NULL AND (NEW."verified_target_retention_observed_status" IS NOT OLD."verified_target_retention_observed_status" OR NEW."verified_target_retention_observed_row_version" IS NOT OLD."verified_target_retention_observed_row_version")) OR (OLD."verified_previous_retention_handle_id" IS NOT NULL AND (NEW."verified_previous_retention_handle_id" IS NOT OLD."verified_previous_retention_handle_id" OR NEW."verified_previous_retention_handle_kind" IS NOT OLD."verified_previous_retention_handle_kind" OR NEW."verified_previous_retention_feature_release_id" IS NOT OLD."verified_previous_retention_feature_release_id" OR NEW."verified_previous_retention_closure_manifest_id" IS NOT OLD."verified_previous_retention_closure_manifest_id" OR NEW."verified_previous_retention_closure_hash" IS NOT OLD."verified_previous_retention_closure_hash")) OR (OLD."verified_previous_retention_observed_status" IS NOT NULL AND (NEW."verified_previous_retention_observed_status" IS NOT OLD."verified_previous_retention_observed_status" OR NEW."verified_previous_retention_observed_row_version" IS NOT OLD."verified_previous_retention_observed_row_version")) OR (OLD."observed_pointer_state" IS NOT NULL AND (NEW."observed_pointer_state" IS NOT OLD."observed_pointer_state" OR NEW."observed_pointer_row_version" IS NOT OLD."observed_pointer_row_version" OR NEW."observed_feature_release_id" IS NOT OLD."observed_feature_release_id" OR NEW."observed_feature_release_ref" IS NOT OLD."observed_feature_release_ref" OR NEW."observed_feature_release_version" IS NOT OLD."observed_feature_release_version" OR NEW."observed_feature_release_hash" IS NOT OLD."observed_feature_release_hash")) THEN RAISE(ABORT, 'activation_command_verified_fact_transition_invalid') END;
END;

CREATE TRIGGER "trg:activation_commands:terminalization" BEFORE UPDATE OF "lifecycle" ON "workflow_feature_release_activation_commands" WHEN NEW."lifecycle" <> OLD."lifecycle" BEGIN
  SELECT CASE WHEN NEW."lifecycle" NOT IN ('applied', 'failed', 'conflict') OR NEW."terminal_disposition" IS NOT NEW."lifecycle" OR NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_invocations" AS invocation WHERE invocation."id" = NEW."canonical_terminal_invocation_id" AND invocation."command_id" = NEW."command_id" AND invocation."invocation_no" = NEW."canonical_terminal_invocation_no" AND invocation."command_domain_request_hash" = NEW."domain_request_hash" AND invocation."submitted_request_hash" = NEW."canonical_terminal_submitted_request_hash" AND invocation."disposition" = NEW."terminal_disposition" AND invocation."invocation_hash" = NEW."canonical_terminal_invocation_hash" AND invocation."result_value_id" = NEW."canonical_terminal_result_value_id" AND invocation."result_hash" = NEW."canonical_terminal_result_hash" AND invocation."result_schema_resource_id" = NEW."canonical_terminal_result_schema_resource_id" AND invocation."result_schema_hash" = NEW."canonical_terminal_result_schema_hash") OR (NEW."lifecycle" = 'applied' AND (NEW."observed_pointer_state" IS NULL OR NEW."verified_target_feature_release_id" IS NULL OR NEW."verified_target_retention_observed_status" <> 'held' OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS release WHERE release."feature_id" = NEW."verified_feature_id" AND release."id" = NEW."verified_target_feature_release_id" AND release."release_ref" = NEW."verified_target_feature_release_ref" AND release."release_version" = NEW."verified_target_feature_release_version" AND release."release_hash" = NEW."verified_target_feature_release_hash" AND release."status" = 'active') OR NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS handle WHERE handle."id" = NEW."verified_target_retention_handle_id" AND handle."handle_kind" = 'published' AND handle."feature_release_id" = NEW."verified_target_retention_feature_release_id" AND handle."closure_manifest_id" = NEW."verified_target_retention_closure_manifest_id" AND handle."closure_hash" = NEW."verified_target_retention_closure_hash" AND handle."status" = 'held' AND handle."row_version" = NEW."verified_target_retention_observed_row_version") OR NOT EXISTS (SELECT 1 FROM "workflow_feature_active_releases" AS pointer WHERE pointer."feature_id" = NEW."verified_feature_id" AND pointer."release_id" = NEW."verified_target_feature_release_id" AND pointer."release_hash" = NEW."verified_target_feature_release_hash" AND pointer."row_version" = NEW."applied_pointer_row_version") OR (NEW."observed_pointer_state" = 'absent' AND (NEW."applied_pointer_row_version" <> 1 OR NEW."verified_previous_feature_release_id" IS NOT NULL OR NEW."verified_previous_retention_handle_id" IS NOT NULL)) OR (NEW."observed_pointer_state" = 'present' AND (NEW."applied_pointer_row_version" <> NEW."observed_pointer_row_version" + 1 OR NEW."verified_previous_feature_release_id" IS NULL OR NEW."verified_previous_retention_observed_status" <> 'held' OR NEW."observed_feature_release_id" IS NOT NEW."verified_previous_feature_release_id" OR NEW."observed_feature_release_ref" IS NOT NEW."verified_previous_feature_release_ref" OR NEW."observed_feature_release_version" IS NOT NEW."verified_previous_feature_release_version" OR NEW."observed_feature_release_hash" IS NOT NEW."verified_previous_feature_release_hash" OR NOT EXISTS (SELECT 1 FROM "workflow_feature_releases" AS previous_release WHERE previous_release."feature_id" = NEW."verified_feature_id" AND previous_release."id" = NEW."verified_previous_feature_release_id" AND previous_release."release_ref" = NEW."verified_previous_feature_release_ref" AND previous_release."release_version" = NEW."verified_previous_feature_release_version" AND previous_release."release_hash" = NEW."verified_previous_feature_release_hash" AND previous_release."status" = 'draining') OR NOT EXISTS (SELECT 1 FROM "workflow_registry_retention_handles" AS previous_handle WHERE previous_handle."id" = NEW."verified_previous_retention_handle_id" AND previous_handle."handle_kind" = 'published' AND previous_handle."feature_release_id" = NEW."verified_previous_retention_feature_release_id" AND previous_handle."closure_manifest_id" = NEW."verified_previous_retention_closure_manifest_id" AND previous_handle."closure_hash" = NEW."verified_previous_retention_closure_hash" AND previous_handle."status" = 'held' AND previous_handle."row_version" = NEW."verified_previous_retention_observed_row_version"))))) OR (NEW."lifecycle" = 'conflict' AND (NEW."observed_pointer_state" IS NULL OR NEW."verified_target_feature_release_id" IS NULL OR NEW."verified_target_retention_observed_status" <> 'held')) THEN RAISE(ABORT, 'activation_command_terminalization_invalid') END;
END;

CREATE TRIGGER "trg:activation_commands:immutable_delete" BEFORE DELETE ON "workflow_feature_release_activation_commands" BEGIN
  SELECT RAISE(ABORT, 'activation_command_is_immutable');
END;

CREATE TRIGGER "trg:activation_invocations:hash_chain" AFTER INSERT ON "workflow_feature_release_activation_invocations" BEGIN
  SELECT CASE WHEN (NEW."invocation_no" = 1 AND NEW."previous_invocation_hash" IS NOT NULL) OR (NEW."invocation_no" > 1 AND (SELECT previous."invocation_hash" FROM "workflow_feature_release_activation_invocations" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."invocation_no" = NEW."invocation_no" - 1) IS NOT NEW."previous_invocation_hash") THEN RAISE(ABORT, 'activation_invocation_hash_chain_invalid') END;
END;

CREATE TRIGGER "trg:activation_invocations:terminal_reference" AFTER INSERT ON "workflow_feature_release_activation_invocations" BEGIN
  SELECT CASE WHEN (NEW."disposition" = 'duplicate' AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."domain_request_hash" = NEW."submitted_request_hash" AND command."lifecycle" IN ('applied', 'failed', 'conflict') AND command."canonical_terminal_result_value_id" = NEW."referenced_terminal_result_value_id" AND command."canonical_terminal_result_hash" = NEW."referenced_terminal_result_hash" AND command."canonical_terminal_result_schema_resource_id" = NEW."referenced_terminal_result_schema_resource_id" AND command."canonical_terminal_result_schema_hash" = NEW."referenced_terminal_result_schema_hash")) OR (NEW."disposition" IN ('applied', 'failed') AND (NEW."referenced_terminal_result_value_id" IS NOT NEW."result_value_id" OR NEW."referenced_terminal_result_hash" IS NOT NEW."result_hash" OR NEW."referenced_terminal_result_schema_resource_id" IS NOT NEW."result_schema_resource_id" OR NEW."referenced_terminal_result_schema_hash" IS NOT NEW."result_schema_hash")) OR (NEW."disposition" = 'conflict' AND NEW."submitted_request_hash" = NEW."command_domain_request_hash" AND (NEW."referenced_terminal_result_value_id" IS NOT NEW."result_value_id" OR NEW."referenced_terminal_result_hash" IS NOT NEW."result_hash" OR NEW."referenced_terminal_result_schema_resource_id" IS NOT NEW."result_schema_resource_id" OR NEW."referenced_terminal_result_schema_hash" IS NOT NEW."result_schema_hash")) OR (NEW."disposition" = 'conflict' AND NEW."submitted_request_hash" <> NEW."command_domain_request_hash" AND NEW."referenced_terminal_result_value_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."lifecycle" IN ('applied', 'failed', 'conflict') AND command."canonical_terminal_result_value_id" = NEW."referenced_terminal_result_value_id" AND command."canonical_terminal_result_hash" = NEW."referenced_terminal_result_hash" AND command."canonical_terminal_result_schema_resource_id" = NEW."referenced_terminal_result_schema_resource_id" AND command."canonical_terminal_result_schema_hash" = NEW."referenced_terminal_result_schema_hash")) THEN RAISE(ABORT, 'activation_invocation_terminal_reference_invalid') END;
END;

CREATE TRIGGER "trg:activation_invocations:closed_replay_disposition" AFTER INSERT ON "workflow_feature_release_activation_invocations" WHEN NEW."disposition" IN ('applied', 'failed') OR (NEW."disposition" = 'conflict' AND NEW."submitted_request_hash" = NEW."command_domain_request_hash") BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."lifecycle" IN ('applied', 'failed', 'conflict')) THEN RAISE(ABORT, 'activation_invocation_closed_replay_must_be_duplicate') END;
END;

CREATE TRIGGER "trg:activation_invocations:immutable_update" BEFORE UPDATE ON "workflow_feature_release_activation_invocations" BEGIN
  SELECT RAISE(ABORT, 'activation_invocation_is_immutable');
END;

CREATE TRIGGER "trg:activation_invocations:immutable_delete" BEFORE DELETE ON "workflow_feature_release_activation_invocations" BEGIN
  SELECT RAISE(ABORT, 'activation_invocation_is_immutable');
END;

CREATE TRIGGER "trg:activation_events:command_binding" AFTER INSERT ON "workflow_feature_release_activation_events" BEGIN
  SELECT CASE WHEN (NEW."verified_target_feature_release_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."verified_feature_id" = NEW."verified_feature_id" AND command."verified_target_feature_release_id" = NEW."verified_target_feature_release_id" AND command."verified_target_feature_release_ref" = NEW."verified_target_feature_release_ref" AND command."verified_target_feature_release_version" = NEW."verified_target_feature_release_version" AND command."verified_target_feature_release_hash" = NEW."verified_target_feature_release_hash")) OR (NEW."verified_previous_feature_release_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "workflow_feature_release_activation_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."verified_feature_id" = NEW."verified_feature_id" AND command."verified_previous_feature_release_id" = NEW."verified_previous_feature_release_id" AND command."verified_previous_feature_release_ref" = NEW."verified_previous_feature_release_ref" AND command."verified_previous_feature_release_version" = NEW."verified_previous_feature_release_version" AND command."verified_previous_feature_release_hash" = NEW."verified_previous_feature_release_hash")) THEN RAISE(ABORT, 'activation_event_command_binding_invalid') END;
END;

CREATE TRIGGER "trg:activation_events:hash_chain" AFTER INSERT ON "workflow_feature_release_activation_events" BEGIN
  SELECT CASE WHEN (NEW."event_no" = 1 AND NEW."previous_event_hash" IS NOT NULL) OR (NEW."event_no" > 1 AND (SELECT previous."event_hash" FROM "workflow_feature_release_activation_events" AS previous WHERE previous."command_id" = NEW."command_id" AND previous."event_no" = NEW."event_no" - 1) IS NOT NEW."previous_event_hash") THEN RAISE(ABORT, 'activation_event_hash_chain_invalid') END;
END;

CREATE TRIGGER "trg:activation_events:immutable_update" BEFORE UPDATE ON "workflow_feature_release_activation_events" BEGIN
  SELECT RAISE(ABORT, 'activation_event_is_immutable');
END;

CREATE TRIGGER "trg:activation_events:immutable_delete" BEFORE DELETE ON "workflow_feature_release_activation_events" BEGIN
  SELECT RAISE(ABORT, 'activation_event_is_immutable');
END;

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

CREATE TRIGGER "trg:capacity_invocations:prepared_insert" BEFORE INSERT ON "runtime_capacity_admin_invocations" WHEN NEW."execution_result" = 'prepared' BEGIN
  SELECT CASE WHEN NEW."invocation_no" <> 1 OR NOT EXISTS (SELECT 1 FROM "runtime_capacity_admin_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."request_hash" = NEW."submitted_request_hash" AND command."assigned_capacity_revision" IS NOT NULL AND command."assigned_change_id" IS NOT NULL AND command."canonical_result_value_id" IS NULL AND command."canonical_result_hash" IS NULL AND command."finalized_at_ms" IS NULL) THEN RAISE(ABORT, 'capacity_prepared_invocation_invalid') END;
END;

CREATE TRIGGER "trg:capacity_invocations:applied_insert" BEFORE INSERT ON "runtime_capacity_admin_invocations" WHEN NEW."execution_result" = 'applied' BEGIN
  SELECT RAISE(ABORT, 'capacity_applied_invocation_is_historical');
END;

CREATE TRIGGER "trg:capacity_invocations:terminal_insert" BEFORE INSERT ON "runtime_capacity_admin_invocations" WHEN NEW."execution_result" IN ('denied', 'conflict', 'failed') BEGIN
  SELECT CASE WHEN NEW."decided_at_ms" < NEW."requested_at_ms" OR (NEW."authorization_result" = 'allowed' AND NEW."denial_code" IS NOT NULL) THEN RAISE(ABORT, 'capacity_terminal_invocation_invalid') END;
END;

CREATE TRIGGER "trg:capacity_invocations:duplicate_insert" BEFORE INSERT ON "runtime_capacity_admin_invocations" WHEN NEW."execution_result" = 'duplicate' BEGIN
  SELECT CASE WHEN NEW."invocation_no" <= 1 OR NEW."denial_code" IS NOT NULL OR NEW."decided_at_ms" < NEW."requested_at_ms" OR NOT EXISTS (SELECT 1 FROM "runtime_capacity_admin_commands" AS command WHERE command."command_id" = NEW."command_id" AND command."request_hash" = NEW."submitted_request_hash" AND command."canonical_result_value_id" IS NOT NULL AND command."canonical_result_hash" IS NOT NULL AND command."finalized_at_ms" IS NOT NULL) THEN RAISE(ABORT, 'capacity_duplicate_invocation_invalid') END;
END;

CREATE TRIGGER "trg:capacity_invocations:immutable_update" BEFORE UPDATE ON "runtime_capacity_admin_invocations" BEGIN
  SELECT RAISE(ABORT, 'capacity_invocation_is_immutable');
END;

CREATE TRIGGER "trg:capacity_invocations:immutable_delete" BEFORE DELETE ON "runtime_capacity_admin_invocations" BEGIN
  SELECT RAISE(ABORT, 'capacity_invocation_is_immutable');
END;

PRAGMA user_version = 13;
