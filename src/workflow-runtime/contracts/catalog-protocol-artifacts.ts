import { calculateArtifactHash } from './hash.js';
import {
  COMPILER_ERROR_CATALOG_ENTRIES,
  COMPILER_DIAGNOSTIC_PHASES,
  COMPILER_ERROR_RETRYABILITIES,
  RUNTIME_COMMAND_DENIAL_CATALOG_ENTRIES,
  RUNTIME_COMMAND_REASON_CATALOG_ENTRIES,
  RUNTIME_EVENT_CATALOG_ENTRIES,
  RUNTIME_FACT_CATALOG_ENTRIES,
  RUNTIME_PERMISSION_CATALOG_ENTRIES,
  WORKFLOW_COMPILER_ERROR_CODES,
} from './catalog-protocol-types.js';
import {
  RUNTIME_COMMAND_PROTOCOL_ENTRIES,
  RUNTIME_COMMAND_TARGET_KINDS,
  RUNTIME_STATE_MACHINES,
  RUN_TRANSACTION_PROTOCOL_ENTRIES,
  RUN_TRANSACTION_PROTOCOL_IDS,
} from './protocol-table-types.js';
import { assertJsonObject, strictParseJson } from './strict-json.js';
import type { ContractArtifactEnvelope, JsonObject } from './types.js';

export interface CatalogProtocolArtifactDescriptor {
  artifact_path: string;
  artifact_format: string;
  ref_id: string;
  domain_separator: string;
  artifact_kind: 'catalog' | 'protocol_table';
}

export const CATALOG_PROTOCOL_ARTIFACT_DESCRIPTORS = [
  {
    artifact_path: 'catalogs/workflow-compiler-error-catalog.json',
    artifact_format: 'icarus.workflow-compiler-error-catalog/1',
    ref_id: 'icarus.workflow-compiler-error-catalog',
    domain_separator: 'icarus:workflow-compiler-error-catalog:1\n',
    artifact_kind: 'catalog',
  },
  {
    artifact_path: 'catalogs/workflow-runtime-fact-catalog.json',
    artifact_format: 'icarus.workflow-runtime-fact-catalog/1',
    ref_id: 'icarus.workflow-runtime-fact-catalog',
    domain_separator: 'icarus:workflow-runtime-fact-catalog:1\n',
    artifact_kind: 'catalog',
  },
  {
    artifact_path: 'catalogs/workflow-runtime-event-catalog.json',
    artifact_format: 'icarus.workflow-runtime-event-catalog/1',
    ref_id: 'icarus.workflow-runtime-event-catalog',
    domain_separator: 'icarus:workflow-runtime-event-catalog:1\n',
    artifact_kind: 'catalog',
  },
  {
    artifact_path: 'catalogs/workflow-runtime-permission-catalog.json',
    artifact_format: 'icarus.workflow-runtime-permission-catalog/1',
    ref_id: 'icarus.workflow-runtime-permission-catalog',
    domain_separator: 'icarus:workflow-runtime-permission-catalog:1\n',
    artifact_kind: 'catalog',
  },
  {
    artifact_path: 'catalogs/workflow-runtime-command-reason-catalog.json',
    artifact_format: 'icarus.workflow-runtime-command-reason-catalog/1',
    ref_id: 'icarus.workflow-runtime-command-reason-catalog',
    domain_separator: 'icarus:workflow-runtime-command-reason-catalog:1\n',
    artifact_kind: 'catalog',
  },
  {
    artifact_path: 'catalogs/workflow-runtime-command-denial-catalog.json',
    artifact_format: 'icarus.workflow-runtime-command-denial-catalog/1',
    ref_id: 'icarus.workflow-runtime-command-denial-catalog',
    domain_separator: 'icarus:workflow-runtime-command-denial-catalog:1\n',
    artifact_kind: 'catalog',
  },
  {
    artifact_path: 'protocols/workflow-runtime-state-transition-tables.json',
    artifact_format: 'icarus.workflow-runtime-state-transition-tables/1',
    ref_id: 'icarus.workflow-runtime-state-transition-tables',
    domain_separator: 'icarus:workflow-runtime-state-transition-tables:1\n',
    artifact_kind: 'protocol_table',
  },
  {
    artifact_path: 'protocols/workflow-runtime-command-protocol-table.json',
    artifact_format: 'icarus.workflow-runtime-command-protocol-table/1',
    ref_id: 'icarus.workflow-runtime-command-protocol-table',
    domain_separator: 'icarus:workflow-runtime-command-protocol-table:1\n',
    artifact_kind: 'protocol_table',
  },
  {
    artifact_path: 'protocols/workflow-run-transaction-protocol-table.json',
    artifact_format: 'icarus.workflow-run-transaction-protocol-table/1',
    ref_id: 'icarus.workflow-run-transaction-protocol-table',
    domain_separator: 'icarus:workflow-run-transaction-protocol-table:1\n',
    artifact_kind: 'protocol_table',
  },
] as const satisfies readonly CatalogProtocolArtifactDescriptor[];

function detachPayload(value: unknown): JsonObject {
  const payload = strictParseJson(JSON.stringify(value));
  assertJsonObject(payload);
  return payload;
}

export function buildCatalogProtocolArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: unknown,
): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload: detachPayload(payload),
  };
  return { ...artifact, hash: calculateArtifactHash(artifact) };
}

function compilerErrorEntries(): JsonObject {
  return Object.fromEntries(
    COMPILER_ERROR_CATALOG_ENTRIES.map((entry) => [
      entry.code,
      {
        retryability: entry.retryability,
        default_phase: entry.default_phase,
      },
    ]),
  ) as JsonObject;
}

function semanticPayload(format: string): unknown {
  switch (format) {
    case 'icarus.workflow-compiler-error-catalog/1':
      return {
        diagnostic_phases: COMPILER_DIAGNOSTIC_PHASES,
        retryabilities: COMPILER_ERROR_RETRYABILITIES,
        error_codes: WORKFLOW_COMPILER_ERROR_CODES,
        entries: compilerErrorEntries(),
        diagnostic_sort_key: [
          'instance_pointer',
          'code',
          'stable_object_id',
          'schema_pointer',
        ],
      };
    case 'icarus.workflow-runtime-fact-catalog/1':
      return {
        run_protocol_major: 1,
        queue_order: [
          'causal_wave_asc',
          'fact_kind_rank_asc',
          'stable_object_id_asc',
        ],
        entries: RUNTIME_FACT_CATALOG_ENTRIES,
      };
    case 'icarus.workflow-runtime-event-catalog/1':
      return {
        run_protocol_major: 1,
        sequence_scope: 'graph_run',
        fact_event_rule: 'same_graph_run_and_event_sequence_atomic',
        audit_only_fact_accounting: 'forbidden',
        entries: RUNTIME_EVENT_CATALOG_ENTRIES,
      };
    case 'icarus.workflow-runtime-permission-catalog/1':
      return {
        deployment_profile: 'local_single_user',
        local_human_actor_ref: 'human:local-owner',
        entries: RUNTIME_PERMISSION_CATALOG_ENTRIES,
      };
    case 'icarus.workflow-runtime-command-reason-catalog/1':
      return {
        entries: RUNTIME_COMMAND_REASON_CATALOG_ENTRIES,
      };
    case 'icarus.workflow-runtime-command-denial-catalog/1':
      return {
        entries: RUNTIME_COMMAND_DENIAL_CATALOG_ENTRIES,
      };
    case 'icarus.workflow-runtime-state-transition-tables/1':
      return {
        run_protocol_major: 1,
        transition_policy: 'listed_edges_only',
        terminal_reopen: 'forbidden',
        machines: RUNTIME_STATE_MACHINES,
      };
    case 'icarus.workflow-runtime-command-protocol-table/1':
      return {
        run_protocol_major: 1,
        target_kinds: RUNTIME_COMMAND_TARGET_KINDS,
        authorization_intersection: [
          'actor_permission',
          'resource_scope_or_ownership',
          'feature_ceiling',
          'published_command_policy',
          'state_guard',
          'expected_row_version',
        ],
        confirmation_ttl_ms: 300000,
        entries: RUNTIME_COMMAND_PROTOCOL_ENTRIES,
      };
    case 'icarus.workflow-run-transaction-protocol-table/1':
      return {
        run_protocol_major: 1,
        transaction_host: 'workflow_runtime_store_single_writer',
        transaction_mode: 'begin_immediate',
        external_await_inside_transaction: 'forbidden',
        transaction_ids: RUN_TRANSACTION_PROTOCOL_IDS,
        entries: RUN_TRANSACTION_PROTOCOL_ENTRIES,
      };
    default:
      throw new Error(`Unknown G0.4 artifact format: ${format}`);
  }
}

export function buildCatalogProtocolSemanticArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  return CATALOG_PROTOCOL_ARTIFACT_DESCRIPTORS.map((descriptor) => [
    descriptor.artifact_path,
    buildCatalogProtocolArtifact(
      descriptor.artifact_format,
      descriptor.ref_id,
      descriptor.domain_separator,
      semanticPayload(descriptor.artifact_format),
    ),
  ]);
}
