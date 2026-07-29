import { canonicalJson, domainSeparatedSha256 } from '../../contracts/hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../../contracts/types.js';
import type { WorkflowRuntimeSqlValue } from './index.js';

export const RUNTIME_COMMAND_INGRESS_TERMINAL_BINDING_DOMAIN =
  'icarus:workflow-runtime-command-ingress-terminal-binding:1\n';

interface RuntimeCommandIngressQuery {
  queryAll<T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[];
}

export interface RuntimeCommandIngressTerminalBindingFields {
  readonly id: string;
  readonly idempotency_domain: string;
  readonly idempotency_key: string;
  readonly ingress_no: number;
  readonly submitted_command_id: string;
  readonly canonical_request_json: string;
  readonly submitted_request_hash: Sha256Hash;
  readonly command_type: string;
  readonly claimed_target_kind: string;
  readonly claimed_workflow_id: string | null;
  readonly claimed_run_id: string | null;
  readonly claimed_node_id: string | null;
  readonly claimed_retry_schedule_id: string | null;
  readonly claimed_effect_operation_id: string | null;
  readonly claimed_operational_blocker_id: string | null;
  readonly actor_ref: string;
  readonly actor_kind: string;
  readonly auth_session_ref: string;
  readonly entrypoint: string;
  readonly source_feature_id: string | null;
  readonly delegation_chain_ref: string | null;
  readonly resolution_result: string;
  readonly authorization_result: string;
  readonly execution_result: string;
  readonly denial_code: string | null;
  readonly canonical_result_json: string;
  readonly canonical_result_hash: Sha256Hash;
  readonly resolved_command_id: string | null;
  readonly resolved_invocation_id: string | null;
  readonly requested_at_ms: number;
  readonly decided_at_ms: number;
  readonly applied_at_ms: number | null;
}

interface RuntimeCommandIngressIntegrityRow
  extends RuntimeCommandIngressTerminalBindingFields,
    Record<string, unknown> {
  readonly terminal_binding_hash: Sha256Hash;
  readonly header_command_id: string | null;
  readonly header_idempotency_domain: string | null;
  readonly header_idempotency_key: string | null;
  readonly header_request_hash: Sha256Hash | null;
  readonly header_command_type: string | null;
  readonly header_workflow_id: string | null;
  readonly header_run_id: string | null;
  readonly header_node_id: string | null;
  readonly header_retry_schedule_id: string | null;
  readonly header_effect_operation_id: string | null;
  readonly header_operational_blocker_id: string | null;
  readonly invocation_id: string | null;
  readonly invocation_command_id: string | null;
  readonly invocation_submitted_request_hash: Sha256Hash | null;
  readonly invocation_actor_ref: string | null;
  readonly invocation_actor_kind: string | null;
  readonly invocation_auth_session_ref: string | null;
  readonly invocation_entrypoint: string | null;
  readonly invocation_source_feature_id: string | null;
  readonly invocation_delegation_chain_ref: string | null;
  readonly invocation_authorization_result: string | null;
  readonly invocation_execution_result: string | null;
  readonly invocation_requested_at_ms: number | null;
  readonly invocation_decided_at_ms: number | null;
  readonly invocation_applied_at_ms: number | null;
}

export class RuntimeCommandIngressIntegrityError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = 'RuntimeCommandIngressIntegrityError';
  }
}

function parseCanonicalJson(bytes: string, label: string): JsonValue {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(bytes) as JsonValue;
  } catch (error) {
    throw new RuntimeCommandIngressIntegrityError(`${label} is not valid JSON`, {
      cause: error,
    });
  }
  if (canonicalJson(parsed) !== bytes)
    throw new RuntimeCommandIngressIntegrityError(
      `${label} is not canonical JSON`,
    );
  return parsed;
}

function requestHash(value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-g5-runtime-command-request:1\n',
    value,
  );
}

function resultHash(value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-g5-runtime-command-ingress-result:1\n',
    value,
  );
}

function stableIngressId(
  domain: string,
  key: string,
  ingressNo: number,
): string {
  return `runtime-command-ingress:${domainSeparatedSha256(
    'icarus:workflow-g5-runtime-command-ingress:1\n',
    {
      idempotency_domain: domain,
      idempotency_key: key,
      ingress_no: ingressNo,
    },
  ).slice('sha256:'.length)}`;
}

export function calculateRuntimeCommandIngressTerminalBinding(
  row: RuntimeCommandIngressTerminalBindingFields,
): Sha256Hash {
  const request = parseCanonicalJson(
    row.canonical_request_json,
    'Runtime Command ingress request',
  );
  const result = parseCanonicalJson(
    row.canonical_result_json,
    'Runtime Command ingress result',
  );
  return domainSeparatedSha256(
    RUNTIME_COMMAND_INGRESS_TERMINAL_BINDING_DOMAIN,
    {
      identity: {
        id: row.id,
        idempotency_domain: row.idempotency_domain,
        idempotency_key: row.idempotency_key,
        ingress_no: row.ingress_no,
        submitted_command_id: row.submitted_command_id,
      },
      request: {
        canonical: request,
        hash: row.submitted_request_hash,
        command_type: row.command_type,
        claimed_target_kind: row.claimed_target_kind,
        claimed_workflow_id: row.claimed_workflow_id,
        claimed_run_id: row.claimed_run_id,
        claimed_node_id: row.claimed_node_id,
        claimed_retry_schedule_id: row.claimed_retry_schedule_id,
        claimed_effect_operation_id: row.claimed_effect_operation_id,
        claimed_operational_blocker_id:
          row.claimed_operational_blocker_id,
      },
      trusted_actor: {
        actor_ref: row.actor_ref,
        actor_kind: row.actor_kind,
        auth_session_ref: row.auth_session_ref,
        entrypoint: row.entrypoint,
        source_feature_id: row.source_feature_id,
        delegation_chain_ref: row.delegation_chain_ref,
      },
      terminal: {
        resolution_result: row.resolution_result,
        authorization_result: row.authorization_result,
        execution_result: row.execution_result,
        denial_code: row.denial_code,
        canonical_result: result,
        canonical_result_hash: row.canonical_result_hash,
        resolved_command_id: row.resolved_command_id,
        resolved_invocation_id: row.resolved_invocation_id,
      },
      chronology: {
        requested_at_ms: row.requested_at_ms,
        decided_at_ms: row.decided_at_ms,
        applied_at_ms: row.applied_at_ms,
      },
    } as JsonObject,
  );
}

function claimedTargetId(row: RuntimeCommandIngressIntegrityRow): string | null {
  const columns: Record<string, string | null> = {
    workflow: row.claimed_workflow_id,
    run: row.claimed_run_id,
    node: row.claimed_node_id,
    retry_schedule: row.claimed_retry_schedule_id,
    effect_operation: row.claimed_effect_operation_id,
    operational_blocker: row.claimed_operational_blocker_id,
  };
  return columns[row.claimed_target_kind] ?? null;
}

function headerTargetId(row: RuntimeCommandIngressIntegrityRow): string | null {
  const columns: Record<string, string | null> = {
    workflow: row.header_workflow_id,
    run: row.header_run_id,
    node: row.header_node_id,
    retry_schedule: row.header_retry_schedule_id,
    effect_operation: row.header_effect_operation_id,
    operational_blocker: row.header_operational_blocker_id,
  };
  return columns[row.claimed_target_kind] ?? null;
}

function assertTerminalRow(row: RuntimeCommandIngressIntegrityRow): void {
  const request = parseCanonicalJson(
    row.canonical_request_json,
    'Runtime Command ingress request',
  );
  const result = parseCanonicalJson(
    row.canonical_result_json,
    'Runtime Command ingress result',
  );
  if (
    requestHash(request) !== row.submitted_request_hash ||
    resultHash(result) !== row.canonical_result_hash ||
    calculateRuntimeCommandIngressTerminalBinding(row) !==
      row.terminal_binding_hash
  )
    throw new RuntimeCommandIngressIntegrityError(
      'Runtime Command ingress request, result, or terminal binding drifted',
    );
  if (
    !Number.isSafeInteger(row.requested_at_ms) ||
    !Number.isSafeInteger(row.decided_at_ms) ||
    row.decided_at_ms < row.requested_at_ms ||
    (row.applied_at_ms !== null &&
      (!Number.isSafeInteger(row.applied_at_ms) ||
        row.applied_at_ms < row.requested_at_ms ||
        row.applied_at_ms > row.decided_at_ms)) ||
    (row.execution_result === 'applied') !== (row.applied_at_ms !== null)
  )
    throw new RuntimeCommandIngressIntegrityError(
      'Runtime Command ingress chronology drifted',
    );

  const resolved = row.resolution_result === 'resolved';
  if (!resolved) {
    if (
      row.resolved_command_id !== null ||
      row.resolved_invocation_id !== null ||
      row.header_command_id !== null ||
      row.invocation_id !== null
    )
      throw new RuntimeCommandIngressIntegrityError(
        'Unresolved Runtime Command ingress acquired a resolved identity',
      );
    return;
  }

  if (
    row.header_command_id !== row.resolved_command_id ||
    row.invocation_id !== row.resolved_invocation_id ||
    row.invocation_command_id !== row.resolved_command_id ||
    row.header_idempotency_domain !== row.idempotency_domain ||
    row.header_idempotency_key !== row.idempotency_key ||
    row.invocation_submitted_request_hash !== row.submitted_request_hash ||
    row.invocation_actor_ref !== row.actor_ref ||
    row.invocation_actor_kind !== row.actor_kind ||
    row.invocation_auth_session_ref !== row.auth_session_ref ||
    row.invocation_entrypoint !== row.entrypoint ||
    row.invocation_source_feature_id !== row.source_feature_id ||
    row.invocation_delegation_chain_ref !== row.delegation_chain_ref ||
    row.invocation_execution_result !== row.execution_result ||
    row.invocation_requested_at_ms !== row.requested_at_ms ||
    row.invocation_decided_at_ms !== row.decided_at_ms ||
    row.invocation_applied_at_ms !== row.applied_at_ms
  )
    throw new RuntimeCommandIngressIntegrityError(
      'Runtime Command ingress resolved Invocation binding drifted',
    );
  if (
    row.authorization_result !== 'not_evaluated' &&
    row.invocation_authorization_result !== row.authorization_result
  )
    throw new RuntimeCommandIngressIntegrityError(
      'Runtime Command ingress authorization binding drifted',
    );
  if (row.execution_result === 'duplicate') {
    if (row.header_request_hash !== row.submitted_request_hash)
      throw new RuntimeCommandIngressIntegrityError(
        'Runtime Command duplicate no longer matches its canonical Header',
      );
  } else if (
    row.execution_result === 'conflict' &&
    row.denial_code === 'idempotency_conflict'
  ) {
    if (row.header_request_hash === row.submitted_request_hash)
      throw new RuntimeCommandIngressIntegrityError(
        'Runtime Command conflict now matches its canonical Header',
      );
  } else if (
    row.header_request_hash !== row.submitted_request_hash ||
    row.header_command_type !== row.command_type ||
    headerTargetId(row) !== claimedTargetId(row)
  )
    throw new RuntimeCommandIngressIntegrityError(
      'Runtime Command ingress canonical Header binding drifted',
    );
}

export function assertRuntimeCommandIngressIntegrity(
  query: RuntimeCommandIngressQuery,
  filter: { readonly domain: string; readonly key: string } | null = null,
): void {
  const rows = query.queryAll<RuntimeCommandIngressIntegrityRow>(
    `SELECT ingress.*,
            header.command_id AS header_command_id,
            header.idempotency_domain AS header_idempotency_domain,
            header.idempotency_key AS header_idempotency_key,
            header.request_hash AS header_request_hash,
            header.command_type AS header_command_type,
            header.workflow_id AS header_workflow_id,
            header.run_id AS header_run_id,
            header.node_id AS header_node_id,
            header.retry_schedule_id AS header_retry_schedule_id,
            header.effect_operation_id AS header_effect_operation_id,
            header.operational_blocker_id AS header_operational_blocker_id,
            invocation.id AS invocation_id,
            invocation.command_id AS invocation_command_id,
            invocation.submitted_request_hash AS invocation_submitted_request_hash,
            invocation.actor_ref AS invocation_actor_ref,
            invocation.actor_kind AS invocation_actor_kind,
            invocation.auth_session_ref AS invocation_auth_session_ref,
            invocation.entrypoint AS invocation_entrypoint,
            invocation.source_feature_id AS invocation_source_feature_id,
            invocation.delegation_chain_ref AS invocation_delegation_chain_ref,
            invocation.authorization_result AS invocation_authorization_result,
            invocation.execution_result AS invocation_execution_result,
            invocation.requested_at_ms AS invocation_requested_at_ms,
            invocation.decided_at_ms AS invocation_decided_at_ms,
            invocation.applied_at_ms AS invocation_applied_at_ms
       FROM workflow_runtime_command_ingress_invocations AS ingress
       LEFT JOIN workflow_runtime_commands AS header
         ON header.command_id = ingress.resolved_command_id
       LEFT JOIN workflow_runtime_command_invocations AS invocation
         ON invocation.command_id = ingress.resolved_command_id
        AND invocation.id = ingress.resolved_invocation_id
      ${filter ? 'WHERE ingress.idempotency_domain = ? AND ingress.idempotency_key = ?' : ''}
      ORDER BY ingress.idempotency_domain COLLATE BINARY,
               ingress.idempotency_key COLLATE BINARY, ingress.ingress_no`,
    filter ? [filter.domain, filter.key] : [],
  );
  let group = '';
  let expectedNo = 0;
  for (const row of rows) {
    const nextGroup = `${row.idempotency_domain}\0${row.idempotency_key}`;
    if (nextGroup !== group) {
      group = nextGroup;
      expectedNo = 1;
    } else {
      expectedNo += 1;
    }
    if (
      row.ingress_no !== expectedNo ||
      row.id !==
        stableIngressId(
          row.idempotency_domain,
          row.idempotency_key,
          expectedNo,
        )
    )
      throw new RuntimeCommandIngressIntegrityError(
        'Runtime Command ingress append identity drifted',
      );
    assertTerminalRow(row);
  }
}
