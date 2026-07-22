import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  checkContractPackCatalogProtocols,
  generateContractPackCatalogProtocols,
} from './catalog-protocol-pack.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import {
  RUNTIME_COMMAND_PROTOCOL_ENTRIES,
  RUN_TRANSACTION_PROTOCOL_ENTRIES,
  RUN_TRANSACTION_PROTOCOL_IDS,
  type RunTransactionProtocolId,
} from './protocol-table-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import {
  checkContractPackSafetySqlite,
  generateContractPackSafetySqlite,
} from './safety-sqlite-pack.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

export const GATE_OWNERSHIP_AUTHORITY_PATH =
  'governance/workflow-runtime-gate-ownership@1.json';
export const GATE_OWNERSHIP_POSITIVE_CASES_PATH =
  'conformance/gate-ownership/positive-cases.json';
export const GATE_OWNERSHIP_NEGATIVE_CASES_PATH =
  'conformance/gate-ownership/negative-cases.json';

const AUTHORITY_DOMAIN = 'icarus:workflow-runtime-gate-ownership:1\n';
const POSITIVE_DOMAIN =
  'icarus:workflow-runtime-gate-ownership-positive-cases:1\n';
const NEGATIVE_DOMAIN =
  'icarus:workflow-runtime-gate-ownership-negative-cases:1\n';

const G5_TRANSACTION_PROTOCOLS = [
  'T0',
  'T0p',
  'T1',
  'T2a',
  'T2b',
  'T3a',
  'T3b',
  'T4',
  'T5',
  'T6a',
  'T6b',
  'T6c',
  'T6d',
] as const satisfies readonly RunTransactionProtocolId[];

const G7_TRANSACTION_PROTOCOLS = [
  'T6e',
] as const satisfies readonly RunTransactionProtocolId[];

const G5_SEMANTIC_OWNERSHIP = [
  't6d_automatic_attempt_dispatch_execution_watchdog',
  't6d_automatic_execution_retry_timer',
  't6d_automatic_quality_revision_timer',
  't6d_retry_schedule_consumption_primitive',
  'operational_blocker_create',
  'open_blocker_set_authority',
  'run_operational_state_cache_on_blocker_create',
  'workflow_operational_state_cache_on_blocker_create',
  'open_blocker_cache_bidirectional_consistency',
] as const;

const G7_SEMANTIC_OWNERSHIP = [
  'workflow_deadline_watchdog',
  'workflow_deadline_system_grant',
  'workflow_deadline_gateway_submission',
  'workflow_deadline_t7c_cancel_ingress',
  'workflow_deadline_command_invocation_audit',
  'advance_retry_schedule_authorization_and_audit',
  't6e_authorized_operational_remediation',
  't6e_source_specific_verification',
  'runtime_command_gateway',
  'resolution_command_invocation_event_audit',
  'blocker_open_to_resolved',
  'blocker_open_to_abandoned',
  'last_blocker_operational_state_restoration',
  'administrative_abandon',
  'recovery_and_integrity_restoration',
] as const;

const T6E_COMMAND_TYPES = [
  'reconcile_effect',
  'submit_effect_receipt',
  'verify_effect_not_applied',
  'remediate_operational_blocker',
  'restore_integrity',
] as const;

const EXPECTED_BINDINGS = {
  transactionProtocol:
    'sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79',
  commandProtocol:
    'sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba',
  logicalSchema:
    'sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214',
  g1Root:
    'sha256:f49781e161e00815e08841b2bc3b2b09ee83d60476220c398c9c0824ee4bcfa9',
  schemaManifest:
    'sha256:6ce20c518c13a47bb50f9f884f5faec506b2e50100a92ec3d3eb84f2649147e4',
  schemaHash:
    'sha256:adfcd0462b50991cceb9497412f8af4e0271f6769a9d810ff9e4d58011952cf1',
} as const satisfies Record<string, Sha256Hash>;

const AFFECTED_CURRENT_ROOTS = [
  [
    'protocols/workflow-run-transaction-protocol-table.json',
    'sha256:3d5474096d89fbd723e34e0d2f9d1dadd1b955b5fc36ff447d026257852cac79',
  ],
  [
    'protocols/workflow-runtime-command-protocol-table.json',
    'sha256:43cc8ef247fcba4bac5e9fccdd654fd393928120755a6405bad232043f0c94ba',
  ],
  [
    'safety/local_single_user_safety_enforcement_matrix@1.json',
    'sha256:9143ae6f043c6bc9389af848604070e4cfad6dcea8d293256cb802b01439bc3a',
  ],
  [
    'contract-pack-catalog-protocols.json',
    'sha256:a648dc9326255b109690cb47d58032775825ae065caf8f7cbb0ef73efcf984f7',
  ],
  [
    'contract-pack-safety-sqlite.json',
    'sha256:4f756c9427a9e5fd8f034c2abdab3c614b675af8b8bbb350fc4219917159cd8d',
  ],
  [
    'contract-pack-static-absence.json',
    'sha256:dc7b987416c3c1baed5a5a666960bfd2411a3e3bf76d173bd8ab0a550e51b21a',
  ],
  [
    'contract-pack-g3-retention-executor-abi-preflight.json',
    'sha256:03131d78800718ac1bd326f932e33ca677d9ac617ff00fc090fc7aaefedd85a9',
  ],
  [
    'contract-pack-g3-workflow-publisher.json',
    'sha256:8a67b2516d46da89524045297b261e32305d0803546089048b19d70384e23282',
  ],
  [
    'contract-pack-g3.9-feature-release-activation.json',
    'sha256:7c192a3a4dd10004c2a7bf6da2cf81a38d5745e145717796f86acfc2025fdf91',
  ],
  [
    'contract-pack-g3.8a-activation-contract-repair.json',
    'sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f',
  ],
  [
    'conformance/capacity-control-plane-addendum/contract-pack-capacity-control-plane-addendum.json',
    'sha256:12f9fdfe9739b767440b56b0e55fedb431b27c546326da90285e96e1fc2ea15c',
  ],
] as const satisfies readonly (readonly [string, Sha256Hash])[];

type GateId = 'G5' | 'G7';
type OwnershipErrorCode =
  | 'accepted'
  | 'gate_missing_or_unknown'
  | 'transaction_missing'
  | 'transaction_duplicate'
  | 'transaction_unknown'
  | 'transaction_cross_gate'
  | 't6e_owned_by_g5'
  | 'semantic_missing'
  | 'semantic_duplicate'
  | 'semantic_unknown'
  | 'semantic_cross_gate'
  | 'g5_forbidden_semantic'
  | 't6d_automatic_semantics_drift'
  | 't6d_deadline_command_reintroduced'
  | 'manual_retry_authorization_drift'
  | 'deadline_gateway_protocol_drift'
  | 'deadline_system_grant_drift'
  | 'deadline_stable_key_drift'
  | 'deadline_invocation_audit_drift'
  | 'deadline_query_ownership_drift'
  | 'safety_deadline_ownership_drift'
  | 'schema_deadline_handoff_drift'
  | 't6e_protocol_drift'
  | 't6e_command_mapping_drift'
  | 'schema4_identity_drift'
  | 'schema_resolution_fk_drift'
  | 'schema_resolution_shape_drift'
  | 'schema_cache_trigger_drift';

interface GateOwnershipEntry extends JsonObject {
  gate: GateId;
  owned_transaction_protocols: string[];
  owned_semantics: string[];
  explicitly_excluded_semantics: string[];
  exit_evidence: string[];
}

interface GateOwnershipModel extends JsonObject {
  scope: string;
  gates: GateOwnershipEntry[];
}

interface FrozenEvidence {
  t6dName: string;
  t6dPreconditions: string[];
  t6dCasGuards: string[];
  t6dAtomicWrites: string[];
  t6dIdempotencyConstraints: string[];
  t6dFailureOrLateOutcomes: string[];
  t6dForbidden: string[];
  t6dInvocationContract: JsonObject;
  t7cPreconditions: string[];
  t7cAtomicWrites: string[];
  t7cIdempotencyConstraints: string[];
  t7cFailureOrLateOutcomes: string[];
  deadlineCommand: JsonObject;
  manualRetryCommand: JsonObject;
  deadlineQueryOwner: string;
  commandQueryOwner: string;
  safetyDeadlineEnforcementComponent: string;
  safetyDeadlineReservationPoint: string;
  t6ePreconditions: string[];
  t6eAtomicWrites: string[];
  t6eCommandTypes: string[];
  schemaVersion: number;
  schemaHash: string;
  schemaForeignKeys: Array<{
    relation_id: string;
    source_columns: string[];
    target_table: string;
    target_columns: string[];
  }>;
  schemaChecks: Array<{ check_id: string; expression_sql: string }>;
  schemaTriggers: Array<{ name: string; table: string; sql: string }>;
  schemaTableNames: string[];
}

export type GateOwnershipFixtureMutation =
  | 'none'
  | 'remove_g5_transaction'
  | 'duplicate_g5_transaction'
  | 'add_unknown_transaction'
  | 'move_g5_transaction_to_g7'
  | 'put_t6e_in_g5'
  | 'remove_g5_semantic'
  | 'duplicate_g5_semantic'
  | 'add_unknown_semantic'
  | 'move_g5_semantic_to_g7'
  | 'give_g5_resolution_semantic'
  | 'give_g5_deadline_watchdog'
  | 'give_g5_runtime_command_gateway'
  | 'give_g5_command_audit'
  | 'remove_g7_semantic'
  | 'remove_t6d_attempt_timeout_write'
  | 'remove_t6d_retry_schedule_write'
  | 'reintroduce_t6d_deadline_command'
  | 'reintroduce_t6d_deadline_key'
  | 'reintroduce_t6d_late_deadline_outcome'
  | 'remove_t6d_manual_authorization_precondition'
  | 'remove_manual_retry_handoff'
  | 'manual_retry_bypass_gateway'
  | 'remove_deadline_system_grant'
  | 'change_deadline_due_target'
  | 'remove_deadline_stable_key'
  | 'remove_deadline_invocation_audit'
  | 'remove_t7c_authorization'
  | 'remove_t7c_command_invocation_audit'
  | 'remove_t7c_stable_deadline_key'
  | 'change_deadline_query_owner'
  | 'change_command_query_owner'
  | 'move_safety_deadline_back_to_t6d'
  | 'add_schema_deadline_handoff_relation'
  | 'remove_t6e_authorization'
  | 'remove_t6e_command_invocation'
  | 'remove_t6e_command_mapping'
  | 'change_schema_version'
  | 'remove_schema_resolution_fk'
  | 'allow_resolved_without_command'
  | 'remove_schema_cache_trigger';

export type GateOwnershipAuditProbeMutation =
  | GateOwnershipFixtureMutation
  | 'reorder_g5_transactions'
  | 'remove_g5_gate'
  | 'add_extra_gate'
  | 'remove_g5_excluded_semantic'
  | 'remove_g7_excluded_semantic'
  | 'remove_schema_resolution_check'
  | 'remove_schema_insert_cache_trigger'
  | 'mutate_schema_update_cache_trigger';

export type GateOwnershipDependencyProbeMutation =
  | 'transaction_source_generated_divergence'
  | 'command_source_generated_divergence';

export interface GateOwnershipFixture extends JsonObject {
  case_id: string;
  mutation: GateOwnershipFixtureMutation;
  expected_code: OwnershipErrorCode;
}

export type GateOwnershipPositiveScenario =
  | 'automatic_attempt_timeout'
  | 'automatic_execution_or_quality_retry_timer'
  | 'future_g7_authorized_manual_retry_uses_g5_primitive'
  | 'g7_system_deadline_to_t7c_stable_key';

export interface GateOwnershipPositiveFixture extends JsonObject {
  case_id: string;
  scenario: GateOwnershipPositiveScenario;
  expected_code: 'accepted';
}

export class GateOwnershipContractError extends Error {
  constructor(
    readonly code: Exclude<OwnershipErrorCode, 'accepted'>,
    message: string,
  ) {
    super(message);
    this.name = 'GateOwnershipContractError';
  }
}

function artifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const result: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  result.hash = calculateArtifactHash(result);
  return result;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function absoluteContractPath(relativePath: string): string {
  const result = path.resolve(contractsRoot, relativePath);
  if (!result.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new GateOwnershipContractError(
      'gate_missing_or_unknown',
      `Contract path escapes root: ${relativePath}`,
    );
  }
  return result;
}

function readArtifact(absolutePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolutePath)),
  );
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function affectedCurrentRootInventory(): JsonObject {
  const members = AFFECTED_CURRENT_ROOTS.map(([relativePath, expectedHash]) => {
    const absolutePath = absoluteContractPath(relativePath);
    const bytes = fs.readFileSync(absolutePath);
    const current = readArtifact(absolutePath);
    if (current.hash !== expectedHash) {
      fail(
        'gate_missing_or_unknown',
        `Affected current root identity drift: ${relativePath}`,
      );
    }
    return {
      path: relativePath,
      format: current.format,
      semantic_hash: current.hash,
      raw_sha256: rawSha256(bytes),
    };
  });
  return {
    members,
    member_count: members.length,
    tree_digest: domainSeparatedSha256(
      'icarus:workflow-runtime-t6d-ownership-affected-roots:1\n',
      members,
    ),
  };
}

function writeAtomic(relativePath: string, value: JsonValue): void {
  const target = absoluteContractPath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, render(value), { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function gateOwnershipModel(): GateOwnershipModel {
  return {
    scope: 'current_construction_g5_g7_t6d_t7c_boundary',
    gates: [
      {
        gate: 'G5',
        owned_transaction_protocols: [...G5_TRANSACTION_PROTOCOLS],
        owned_semantics: [...G5_SEMANTIC_OWNERSHIP],
        explicitly_excluded_semantics: [...G7_SEMANTIC_OWNERSHIP],
        exit_evidence: [
          'T0-T6d_automatic_timer_model_and_fault_fixtures',
          'automatic_attempt_watchdog_and_retry_timer_semantics',
          'manual_retry_requires_future_G7_authorization_negative_evidence',
          'operational_blocker_creation_fixtures',
          'open_blocker_set_and_run_workflow_cache_consistency',
          'no_runtime_command_gateway_or_command_audit_writes',
        ],
      },
      {
        gate: 'G7',
        owned_transaction_protocols: [...G7_TRANSACTION_PROTOCOLS],
        owned_semantics: [...G7_SEMANTIC_OWNERSHIP],
        explicitly_excluded_semantics: [...G5_SEMANTIC_OWNERSHIP],
        exit_evidence: [
          'workflow_deadline_watchdog_system_grant_gateway_T7c_fixtures',
          'workflow_deadline_stable_key_and_invocation_audit_fixtures',
          'advance_retry_schedule_authorization_before_T6d_primitive',
          'T6e_model_and_fault_fixtures',
          'runtime_command_authorization_and_audit_fixtures',
          'source_specific_blocker_resolution_and_abandon_fixtures',
          'recovery_and_last_blocker_operational_restoration_fixtures',
        ],
      },
    ],
  };
}

function schemaManifest(): ContractArtifactEnvelope {
  return readArtifact(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/artifacts/workflow-runtime-schema-manifest@1.json',
    ),
  );
}

function frozenEvidence(): FrozenEvidence {
  const t6d = RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
    (entry) => entry.transaction_id === 'T6d',
  );
  const t6e = RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
    (entry) => entry.transaction_id === 'T6e',
  );
  const t7c = RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
    (entry) => entry.transaction_id === 'T7c',
  );
  const deadlineCommand = RUNTIME_COMMAND_PROTOCOL_ENTRIES.find(
    (entry) => entry.command_type === 'cancel_workflow',
  );
  const manualRetryCommand = RUNTIME_COMMAND_PROTOCOL_ENTRIES.find(
    (entry) => entry.command_type === 'advance_retry_schedule',
  );
  if (!t6d || !t6e || !t7c || !deadlineCommand || !manualRetryCommand) {
    throw new GateOwnershipContractError(
      't6e_protocol_drift',
      'Current transaction or command protocol is incomplete',
    );
  }
  const queryCatalog = readArtifact(
    absoluteContractPath('sqlite/workflow-runtime-query-catalog@1.json'),
  );
  const queries = queryCatalog.payload.queries as unknown as Array<{
    query_id: string;
    owner: string;
  }>;
  const deadlineQuery = queries.find(
    (entry) => entry.query_id === 'query:workflow_deadline_due',
  );
  const commandQuery = queries.find(
    (entry) => entry.query_id === 'query:command_idempotency_lookup',
  );
  const safetyMatrix = readArtifact(
    absoluteContractPath(
      'safety/local_single_user_safety_enforcement_matrix@1.json',
    ),
  );
  const safetyRecords = safetyMatrix.payload.records as unknown as Array<{
    limit_path: string;
    enforcement_component: string;
    reservation_point: string;
  }>;
  const safetyDeadline = safetyRecords.find(
    (entry) => entry.limit_path === 'workflow.max_duration_ms',
  );
  if (!deadlineQuery || !commandQuery || !safetyDeadline) {
    throw new GateOwnershipContractError(
      'deadline_gateway_protocol_drift',
      'Deadline query or safety enforcement evidence is incomplete',
    );
  }
  const manifest = schemaManifest();
  const tables = manifest.payload.tables as unknown as Array<{
    name: string;
    foreign_keys: FrozenEvidence['schemaForeignKeys'];
    checks: FrozenEvidence['schemaChecks'];
  }>;
  const blockers = tables.find(
    (table) => table.name === 'workflow_operational_blockers',
  );
  if (!blockers) {
    throw new GateOwnershipContractError(
      'schema4_identity_drift',
      'Schema 5 is missing workflow_operational_blockers',
    );
  }
  return {
    t6dName: t6d.name,
    t6dPreconditions: [...t6d.preconditions],
    t6dCasGuards: [...t6d.cas_guards],
    t6dAtomicWrites: [...t6d.atomic_writes],
    t6dIdempotencyConstraints: [...t6d.idempotency_constraints],
    t6dFailureOrLateOutcomes: [...t6d.failure_or_late_outcomes],
    t6dForbidden: [...t6d.forbidden],
    t6dInvocationContract: structuredClone(
      'invocation_contract' in t6d ? t6d.invocation_contract : {},
    ) as unknown as JsonObject,
    t7cPreconditions: [...t7c.preconditions],
    t7cAtomicWrites: [...t7c.atomic_writes],
    t7cIdempotencyConstraints: [...t7c.idempotency_constraints],
    t7cFailureOrLateOutcomes: [...t7c.failure_or_late_outcomes],
    deadlineCommand: structuredClone(deadlineCommand) as unknown as JsonObject,
    manualRetryCommand: structuredClone(
      manualRetryCommand,
    ) as unknown as JsonObject,
    deadlineQueryOwner: deadlineQuery.owner,
    commandQueryOwner: commandQuery.owner,
    safetyDeadlineEnforcementComponent: safetyDeadline.enforcement_component,
    safetyDeadlineReservationPoint: safetyDeadline.reservation_point,
    t6ePreconditions: [...t6e.preconditions],
    t6eAtomicWrites: [...t6e.atomic_writes],
    t6eCommandTypes: RUNTIME_COMMAND_PROTOCOL_ENTRIES.filter(
      (entry) => entry.transaction_protocol === 'T6e',
    ).map((entry) => entry.command_type),
    schemaVersion: Number(manifest.payload.database_schema_version),
    schemaHash: String(manifest.payload.schema_hash),
    schemaForeignKeys: structuredClone(blockers.foreign_keys),
    schemaChecks: structuredClone(blockers.checks),
    schemaTriggers: structuredClone(
      manifest.payload.triggers as unknown as FrozenEvidence['schemaTriggers'],
    ),
    schemaTableNames: tables.map((table) => table.name),
  };
}

function fail(
  code: Exclude<OwnershipErrorCode, 'accepted'>,
  message: string,
): never {
  throw new GateOwnershipContractError(code, message);
}

function exactSet(
  actual: readonly string[],
  expected: readonly string[],
  missingCode: Exclude<OwnershipErrorCode, 'accepted'>,
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(missingCode, `${label} is not the exact closed ordered set`);
  }
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  code: Exclude<OwnershipErrorCode, 'accepted'>,
  label: string,
): void {
  if (
    Object.keys(value).sort().join('\n') !== [...expected].sort().join('\n')
  ) {
    fail(code, `${label} field set is not closed and exact`);
  }
}

function validateOwnershipModel(model: GateOwnershipModel): void {
  if (model.scope !== 'current_construction_g5_g7_t6d_t7c_boundary') {
    fail('gate_missing_or_unknown', 'Gate ownership scope is unknown');
  }
  if (
    model.gates.length !== 2 ||
    model.gates[0]?.gate !== 'G5' ||
    model.gates[1]?.gate !== 'G7'
  ) {
    fail(
      'gate_missing_or_unknown',
      'Gate ownership must contain exact G5/G7 rows',
    );
  }
  const [g5, g7] = model.gates;
  if (g5.owned_transaction_protocols.includes('T6e')) {
    fail('t6e_owned_by_g5', 'T6e cannot be owned by G5');
  }
  const knownTransactions = new Set<string>(RUN_TRANSACTION_PROTOCOL_IDS);
  const transactionOwners = new Map<string, GateId>();
  for (const gate of model.gates) {
    const local = new Set<string>();
    for (const transaction of gate.owned_transaction_protocols) {
      if (!knownTransactions.has(transaction)) {
        fail('transaction_unknown', `Unknown transaction: ${transaction}`);
      }
      if (local.has(transaction)) {
        fail(
          'transaction_duplicate',
          `Duplicate transaction in ${gate.gate}: ${transaction}`,
        );
      }
      local.add(transaction);
      const priorOwner = transactionOwners.get(transaction);
      if (priorOwner) {
        if (transaction === 'T6e' && gate.gate === 'G5') {
          fail('t6e_owned_by_g5', 'T6e cannot be owned by G5');
        }
        fail(
          'transaction_cross_gate',
          `${transaction} is owned by both ${priorOwner} and ${gate.gate}`,
        );
      }
      transactionOwners.set(transaction, gate.gate);
    }
  }
  for (const transaction of G5_TRANSACTION_PROTOCOLS) {
    if (transactionOwners.get(transaction) === 'G7') {
      fail('transaction_cross_gate', `${transaction} was moved from G5 to G7`);
    }
  }
  exactSet(
    g5.owned_transaction_protocols,
    G5_TRANSACTION_PROTOCOLS,
    'transaction_missing',
    'G5 transaction ownership',
  );
  exactSet(
    g7.owned_transaction_protocols,
    G7_TRANSACTION_PROTOCOLS,
    'transaction_missing',
    'G7 transaction ownership',
  );

  const knownSemantics = new Set<string>([
    ...G5_SEMANTIC_OWNERSHIP,
    ...G7_SEMANTIC_OWNERSHIP,
  ]);
  for (const semantic of G7_SEMANTIC_OWNERSHIP) {
    if (g5.owned_semantics.includes(semantic)) {
      fail('g5_forbidden_semantic', `G5 cannot own ${semantic}`);
    }
  }
  const semanticOwners = new Map<string, GateId>();
  for (const gate of model.gates) {
    const local = new Set<string>();
    for (const semantic of gate.owned_semantics) {
      if (!knownSemantics.has(semantic)) {
        fail('semantic_unknown', `Unknown semantic ownership: ${semantic}`);
      }
      if (local.has(semantic)) {
        fail(
          'semantic_duplicate',
          `Duplicate semantic in ${gate.gate}: ${semantic}`,
        );
      }
      local.add(semantic);
      const priorOwner = semanticOwners.get(semantic);
      if (priorOwner) {
        fail(
          'semantic_cross_gate',
          `${semantic} is owned by both ${priorOwner} and ${gate.gate}`,
        );
      }
      semanticOwners.set(semantic, gate.gate);
    }
  }
  for (const semantic of G5_SEMANTIC_OWNERSHIP) {
    if (semanticOwners.get(semantic) === 'G7') {
      fail('semantic_cross_gate', `${semantic} was moved from G5 to G7`);
    }
  }
  exactSet(
    g5.owned_semantics,
    G5_SEMANTIC_OWNERSHIP,
    'semantic_missing',
    'G5 semantic ownership',
  );
  exactSet(
    g7.owned_semantics,
    G7_SEMANTIC_OWNERSHIP,
    'semantic_missing',
    'G7 semantic ownership',
  );
  exactSet(
    g5.explicitly_excluded_semantics,
    G7_SEMANTIC_OWNERSHIP,
    'semantic_missing',
    'G5 excluded semantics',
  );
  exactSet(
    g7.explicitly_excluded_semantics,
    G5_SEMANTIC_OWNERSHIP,
    'semantic_missing',
    'G7 excluded semantics',
  );
}

function validateFrozenEvidence(evidence: FrozenEvidence): void {
  exactSet(
    [evidence.t6dName],
    ['attempt_watchdog_and_retry_timers'],
    't6d_automatic_semantics_drift',
    'T6d name',
  );
  exactSet(
    evidence.t6dPreconditions,
    [
      'automatic_due_frozen_attempt_deadline_or_retry_eligible_time',
      'manual_retry_only_after_gateway_authorization',
    ],
    't6d_automatic_semantics_drift',
    'T6d preconditions',
  );
  exactSet(
    evidence.t6dCasGuards,
    [
      'attempt_acceptance_open_for_watchdog',
      'retry_schedule_scheduled_row_version',
    ],
    't6d_automatic_semantics_drift',
    'T6d CAS guards',
  );
  exactSet(
    evidence.t6dAtomicWrites,
    [
      'attempt_timeout_fence_and_fact',
      'cancel_reconcile_or_compensation_effects',
      'schedule_consumed_and_exact_next_attempt',
      'node_retry_wait_to_active',
    ],
    't6d_automatic_semantics_drift',
    'T6d atomic writes',
  );
  exactSet(
    evidence.t6dIdempotencyConstraints,
    ['unique_attempt_timeout_event', 'unique_schedule_source_and_next_attempt'],
    't6d_automatic_semantics_drift',
    'T6d idempotency constraints',
  );
  exactSet(
    evidence.t6dFailureOrLateOutcomes,
    ['duplicate_timer'],
    't6d_automatic_semantics_drift',
    'T6d failure outcomes',
  );
  exactSet(
    evidence.t6dForbidden,
    [
      'recompute_backoff_or_deadline',
      'reseal_node_input',
      'external_cancel_or_reconcile_inside_transaction',
      'workflow_deadline_command_creation',
      'runtime_command_or_invocation_audit_write',
      'manual_retry_without_gateway_authorization',
    ],
    't6d_automatic_semantics_drift',
    'T6d forbidden set',
  );
  exactKeys(
    evidence.t6dInvocationContract,
    ['automatic_timer', 'authorized_manual_retry'],
    'manual_retry_authorization_drift',
    'T6d invocation contract',
  );
  const automaticTimer = evidence.t6dInvocationContract
    .automatic_timer as JsonObject;
  const authorizedManual = evidence.t6dInvocationContract
    .authorized_manual_retry as JsonObject;
  exactKeys(
    automaticTimer,
    ['owner_gate', 'ingress', 'gateway_authorization'],
    't6d_automatic_semantics_drift',
    'T6d automatic invocation',
  );
  if (
    automaticTimer.owner_gate !== 'G5' ||
    automaticTimer.ingress !== 'due_attempt_watchdog_or_retry_schedule_timer' ||
    automaticTimer.gateway_authorization !== 'not_applicable'
  ) {
    fail(
      't6d_automatic_semantics_drift',
      'T6d automatic timer invocation boundary drifted',
    );
  }
  exactKeys(
    authorizedManual,
    [
      'owner_gate',
      'ingress',
      'authorization_boundary',
      'command_invocation_audit',
      'g5_primitive',
    ],
    'manual_retry_authorization_drift',
    'T6d authorized manual invocation',
  );
  if (
    authorizedManual.owner_gate !== 'G7' ||
    authorizedManual.ingress !== 'advance_retry_schedule' ||
    authorizedManual.authorization_boundary !==
      'runtime_command_gateway_before_t6d' ||
    authorizedManual.command_invocation_audit !== 'required_before_primitive' ||
    authorizedManual.g5_primitive !== 'consume_existing_retry_schedule'
  ) {
    fail(
      'manual_retry_authorization_drift',
      'Manual retry no longer requires G7 authorization before T6d',
    );
  }
  const removedDeadlineTokens = [
    ...evidence.t6dCasGuards,
    ...evidence.t6dAtomicWrites,
    ...evidence.t6dIdempotencyConstraints,
    ...evidence.t6dFailureOrLateOutcomes,
  ];
  if (
    removedDeadlineTokens.some((value) =>
      [
        'workflow_deadline_current_run',
        'stable_workflow_deadline_t7c_command',
        'stable_workflow_deadline_command_key',
        'late_deadline_command',
      ].includes(value),
    )
  ) {
    fail(
      't6d_deadline_command_reintroduced',
      'T6d cannot contain workflow deadline command semantics',
    );
  }

  exactKeys(
    evidence.deadlineCommand,
    [
      'command_type',
      'target_kind',
      'permission_rule',
      'allowed_reason_codes',
      'allowed_actor_kinds',
      'system_grant',
      'minimum_evidence_refs',
      'confirmation_ref_required',
      'policy_guard',
      'state_guard',
      'transaction_protocol',
      'denial_codes',
    ],
    'deadline_gateway_protocol_drift',
    'cancel_workflow command protocol',
  );
  if (
    evidence.deadlineCommand.command_type !== 'cancel_workflow' ||
    evidence.deadlineCommand.target_kind !== 'workflow' ||
    evidence.deadlineCommand.transaction_protocol !== 'T7c'
  ) {
    fail(
      'deadline_gateway_protocol_drift',
      'Workflow deadline must use cancel_workflow -> T7c',
    );
  }
  const systemGrant = evidence.deadlineCommand.system_grant as JsonObject;
  exactKeys(
    systemGrant,
    [
      'actor_kind',
      'reason_codes',
      'predicate',
      'authority_scope',
      'idempotency_domain',
      'idempotency_key_template',
      'invocation_audit',
    ],
    'deadline_system_grant_drift',
    'Deadline System Grant',
  );
  if (
    systemGrant.actor_kind !== 'system' ||
    canonicalJson(systemGrant.reason_codes as JsonValue) !==
      canonicalJson(['deadline_enforced', 'safety_enforced']) ||
    systemGrant.predicate !== 'due_target' ||
    systemGrant.authority_scope !== 'cancel_workflow_only'
  ) {
    fail(
      'deadline_system_grant_drift',
      'Deadline System Grant authority drifted',
    );
  }
  if (
    systemGrant.idempotency_domain !== 'system:deadline-watchdog' ||
    systemGrant.idempotency_key_template !==
      'workflow-deadline:<workflow_id>:<deadline_at_ms>'
  ) {
    fail('deadline_stable_key_drift', 'Deadline command key drifted');
  }
  if (systemGrant.invocation_audit !== 'required') {
    fail(
      'deadline_invocation_audit_drift',
      'Deadline command lost Invocation audit',
    );
  }
  if (!evidence.t7cPreconditions.includes('authorized_cancel_command')) {
    fail(
      'deadline_gateway_protocol_drift',
      'T7c no longer requires authorized_cancel_command',
    );
  }
  if (!evidence.t7cAtomicWrites.includes('command_invocation_audit')) {
    fail(
      'deadline_invocation_audit_drift',
      'T7c no longer writes command Invocation audit',
    );
  }
  if (
    !evidence.t7cIdempotencyConstraints.includes(
      'stable_system_deadline_key_workflow-deadline:<workflow_id>:<deadline_at_ms>',
    )
  ) {
    fail('deadline_stable_key_drift', 'T7c lost the stable deadline key');
  }
  if (
    !evidence.t7cFailureOrLateOutcomes.includes(
      'loser_records_late_command_only',
    ) ||
    !evidence.t7cFailureOrLateOutcomes.includes(
      'duplicate_returns_canonical_result_with_invocation_audit',
    )
  ) {
    fail(
      'deadline_gateway_protocol_drift',
      'T7c late or duplicate command semantics drifted',
    );
  }

  exactKeys(
    evidence.manualRetryCommand,
    [
      'command_type',
      'target_kind',
      'permission_rule',
      'allowed_reason_codes',
      'allowed_actor_kinds',
      'minimum_evidence_refs',
      'confirmation_ref_required',
      'policy_guard',
      'state_guard',
      'transaction_protocol',
      'primitive_handoff',
      'denial_codes',
    ],
    'manual_retry_authorization_drift',
    'advance_retry_schedule command protocol',
  );
  const handoff = evidence.manualRetryCommand.primitive_handoff as JsonObject;
  exactKeys(
    handoff,
    [
      'authorization_owner',
      'audit_owner',
      'primitive_owner',
      'primitive_transaction_protocol',
      'invocation_mode',
      'unauthorized_direct_invocation',
    ],
    'manual_retry_authorization_drift',
    'advance_retry_schedule primitive handoff',
  );
  if (
    evidence.manualRetryCommand.command_type !== 'advance_retry_schedule' ||
    evidence.manualRetryCommand.transaction_protocol !== 'T6d' ||
    handoff.authorization_owner !== 'G7_runtime_command_gateway' ||
    handoff.audit_owner !== 'G7_runtime_command_gateway' ||
    handoff.primitive_owner !== 'G5' ||
    handoff.primitive_transaction_protocol !== 'T6d' ||
    handoff.invocation_mode !== 'authorized_manual_retry' ||
    handoff.unauthorized_direct_invocation !== 'forbidden'
  ) {
    fail(
      'manual_retry_authorization_drift',
      'advance_retry_schedule authorization handoff drifted',
    );
  }
  if (
    evidence.deadlineQueryOwner !== 'workflow_watchdog' ||
    evidence.commandQueryOwner !== 'command_gateway'
  ) {
    fail(
      'deadline_query_ownership_drift',
      'Deadline or Command query ownership drifted',
    );
  }
  if (
    evidence.safetyDeadlineEnforcementComponent !==
      'g7_workflow_deadline_watchdog' ||
    evidence.safetyDeadlineReservationPoint !==
      'T0_deadline_freeze_and_G7_gateway_T7c_enforcement'
  ) {
    fail(
      'safety_deadline_ownership_drift',
      'Safety matrix no longer assigns deadline enforcement to G7',
    );
  }
  if (
    !evidence.schemaTableNames.includes('workflow_runtime_commands') ||
    !evidence.schemaTableNames.includes(
      'workflow_runtime_command_invocations',
    ) ||
    evidence.schemaTableNames.some((name) =>
      /deadline.*(?:handoff|intent|command)|(?:handoff|intent|command).*deadline|watchdog/.test(
        name,
      ),
    )
  ) {
    fail(
      'schema_deadline_handoff_drift',
      'Schema 5 deadline/Command relation boundary drifted',
    );
  }

  if (!evidence.t6ePreconditions.includes('authorized_runtime_command')) {
    fail(
      't6e_protocol_drift',
      'T6e no longer requires authorized_runtime_command',
    );
  }
  if (
    !evidence.t6eAtomicWrites.includes('command_invocation_and_runtime_event')
  ) {
    fail(
      't6e_protocol_drift',
      'T6e no longer atomically writes Command Invocation and Runtime Event',
    );
  }
  exactSet(
    evidence.t6eCommandTypes,
    T6E_COMMAND_TYPES,
    't6e_command_mapping_drift',
    'T6e command mapping',
  );
  if (
    evidence.schemaVersion !== 5 ||
    evidence.schemaHash !== EXPECTED_BINDINGS.schemaHash
  ) {
    fail('schema4_identity_drift', 'Database Schema 5 identity drifted');
  }
  const resolutionFk = evidence.schemaForeignKeys.find(
    (candidate) => candidate.relation_id === 'fk:operational_blockers:command',
  );
  if (
    !resolutionFk ||
    resolutionFk.source_columns.length !== 1 ||
    resolutionFk.source_columns[0] !== 'resolution_command_id' ||
    resolutionFk.target_table !== 'workflow_runtime_commands' ||
    resolutionFk.target_columns.length !== 1 ||
    resolutionFk.target_columns[0] !== 'command_id'
  ) {
    fail(
      'schema_resolution_fk_drift',
      'Schema 5 resolution_command_id FK drifted',
    );
  }
  const resolutionShape = evidence.schemaChecks.find(
    (candidate) =>
      candidate.check_id === 'ck:operational_blockers:resolution_shape',
  );
  if (
    !resolutionShape?.expression_sql.includes(
      '"status" = \'resolved\' AND "resolved_at_ms" IS NOT NULL',
    ) ||
    !resolutionShape.expression_sql.includes(
      '"resolution_command_id" IS NOT NULL',
    )
  ) {
    fail(
      'schema_resolution_shape_drift',
      'Resolved blocker no longer requires resolution_command_id',
    );
  }
  for (const triggerName of [
    'trg:operational_blockers:insert_cache',
    'trg:operational_blockers:update_cache',
  ]) {
    const trigger = evidence.schemaTriggers.find(
      (candidate) => candidate.name === triggerName,
    );
    if (
      !trigger ||
      trigger.table !== 'workflow_operational_blockers' ||
      !trigger.sql.includes('"workflow_graph_runs"') ||
      !trigger.sql.includes('"workflows"') ||
      !trigger.sql.includes('"status" = \'open\'') ||
      !trigger.sql.includes("ELSE 'healthy'")
    ) {
      fail('schema_cache_trigger_drift', `${triggerName} drifted`);
    }
  }
}

function validateProtocolSourceAgreement(
  transactionEntries: JsonValue,
  commandEntries: JsonValue,
  transactionSourceEntries: JsonValue = RUN_TRANSACTION_PROTOCOL_ENTRIES as unknown as JsonValue,
  commandSourceEntries: JsonValue = RUNTIME_COMMAND_PROTOCOL_ENTRIES as unknown as JsonValue,
): void {
  if (
    canonicalJson(transactionEntries) !==
    canonicalJson(transactionSourceEntries)
  ) {
    fail(
      't6e_protocol_drift',
      'Generated transaction protocol differs from source',
    );
  }
  if (canonicalJson(commandEntries) !== canonicalJson(commandSourceEntries)) {
    fail(
      't6e_command_mapping_drift',
      'Generated command protocol differs from source',
    );
  }
}

function validateDependencyArtifacts(): void {
  const transaction = readArtifact(
    absoluteContractPath(
      'protocols/workflow-run-transaction-protocol-table.json',
    ),
  );
  const command = readArtifact(
    absoluteContractPath(
      'protocols/workflow-runtime-command-protocol-table.json',
    ),
  );
  const logicalSchema = readArtifact(
    absoluteContractPath(
      'sqlite/workflow-runtime-logical-schema-source@1.json',
    ),
  );
  const g1Root = readArtifact(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/contract-pack-g1-executable-schema.json',
    ),
  );
  const manifest = schemaManifest();
  const bindings = [
    [transaction.hash, EXPECTED_BINDINGS.transactionProtocol],
    [command.hash, EXPECTED_BINDINGS.commandProtocol],
    [logicalSchema.hash, EXPECTED_BINDINGS.logicalSchema],
    [g1Root.hash, EXPECTED_BINDINGS.g1Root],
    [manifest.hash, EXPECTED_BINDINGS.schemaManifest],
  ];
  if (bindings.some(([actual, expected]) => actual !== expected)) {
    fail(
      'schema4_identity_drift',
      'Frozen protocol or Schema 5 binding drifted',
    );
  }
  validateProtocolSourceAgreement(
    transaction.payload.entries as unknown as JsonValue,
    command.payload.entries as unknown as JsonValue,
  );
  affectedCurrentRootInventory();
}

function applyMutation(
  model: GateOwnershipModel,
  evidence: FrozenEvidence,
  mutation: GateOwnershipAuditProbeMutation,
): void {
  if (mutation === 'remove_g5_gate') {
    model.gates.shift();
    return;
  }
  if (mutation === 'add_extra_gate') {
    model.gates.push(structuredClone(model.gates[1]));
    return;
  }
  const [g5, g7] = model.gates;
  switch (mutation) {
    case 'none':
      return;
    case 'remove_g5_transaction':
      g5.owned_transaction_protocols.pop();
      return;
    case 'reorder_g5_transactions':
      [g5.owned_transaction_protocols[0], g5.owned_transaction_protocols[1]] = [
        g5.owned_transaction_protocols[1],
        g5.owned_transaction_protocols[0],
      ];
      return;
    case 'duplicate_g5_transaction':
      g5.owned_transaction_protocols.push('T0');
      return;
    case 'add_unknown_transaction':
      g5.owned_transaction_protocols.push('T9');
      return;
    case 'move_g5_transaction_to_g7':
      g5.owned_transaction_protocols.shift();
      g7.owned_transaction_protocols.unshift('T0');
      return;
    case 'put_t6e_in_g5':
      g5.owned_transaction_protocols.push('T6e');
      return;
    case 'remove_g5_semantic':
      g5.owned_semantics.pop();
      return;
    case 'duplicate_g5_semantic':
      g5.owned_semantics.push(G5_SEMANTIC_OWNERSHIP[0]);
      return;
    case 'add_unknown_semantic':
      g5.owned_semantics.push('unknown_semantic');
      return;
    case 'move_g5_semantic_to_g7':
      g5.owned_semantics.shift();
      g7.owned_semantics.unshift(G5_SEMANTIC_OWNERSHIP[0]);
      return;
    case 'give_g5_resolution_semantic':
      g5.owned_semantics.push('blocker_open_to_resolved');
      return;
    case 'give_g5_deadline_watchdog':
      g5.owned_semantics.push('workflow_deadline_watchdog');
      return;
    case 'give_g5_runtime_command_gateway':
      g5.owned_semantics.push('runtime_command_gateway');
      return;
    case 'give_g5_command_audit':
      g5.owned_semantics.push('workflow_deadline_command_invocation_audit');
      return;
    case 'remove_g7_semantic':
      g7.owned_semantics.pop();
      return;
    case 'remove_g5_excluded_semantic':
      g5.explicitly_excluded_semantics.pop();
      return;
    case 'remove_g7_excluded_semantic':
      g7.explicitly_excluded_semantics.pop();
      return;
    case 'remove_t6d_attempt_timeout_write':
      evidence.t6dAtomicWrites = evidence.t6dAtomicWrites.filter(
        (value) => value !== 'attempt_timeout_fence_and_fact',
      );
      return;
    case 'remove_t6d_retry_schedule_write':
      evidence.t6dAtomicWrites = evidence.t6dAtomicWrites.filter(
        (value) => value !== 'schedule_consumed_and_exact_next_attempt',
      );
      return;
    case 'reintroduce_t6d_deadline_command':
      evidence.t6dAtomicWrites.push('stable_workflow_deadline_t7c_command');
      return;
    case 'reintroduce_t6d_deadline_key':
      evidence.t6dIdempotencyConstraints.push(
        'stable_workflow_deadline_command_key',
      );
      return;
    case 'reintroduce_t6d_late_deadline_outcome':
      evidence.t6dFailureOrLateOutcomes.push('late_deadline_command');
      return;
    case 'remove_t6d_manual_authorization_precondition':
      evidence.t6dPreconditions = evidence.t6dPreconditions.filter(
        (value) => value !== 'manual_retry_only_after_gateway_authorization',
      );
      return;
    case 'remove_manual_retry_handoff':
      evidence.manualRetryCommand.primitive_handoff = {};
      return;
    case 'manual_retry_bypass_gateway': {
      const manual = evidence.t6dInvocationContract
        .authorized_manual_retry as JsonObject;
      manual.authorization_boundary = 'direct_t6d';
      return;
    }
    case 'remove_deadline_system_grant':
      evidence.deadlineCommand.system_grant = {};
      return;
    case 'change_deadline_due_target': {
      const grant = evidence.deadlineCommand.system_grant as JsonObject;
      grant.predicate = 'any_active_target';
      return;
    }
    case 'remove_deadline_stable_key': {
      const grant = evidence.deadlineCommand.system_grant as JsonObject;
      delete grant.idempotency_key_template;
      return;
    }
    case 'remove_deadline_invocation_audit': {
      const grant = evidence.deadlineCommand.system_grant as JsonObject;
      delete grant.invocation_audit;
      return;
    }
    case 'remove_t7c_authorization':
      evidence.t7cPreconditions = evidence.t7cPreconditions.filter(
        (value) => value !== 'authorized_cancel_command',
      );
      return;
    case 'remove_t7c_command_invocation_audit':
      evidence.t7cAtomicWrites = evidence.t7cAtomicWrites.filter(
        (value) => value !== 'command_invocation_audit',
      );
      return;
    case 'remove_t7c_stable_deadline_key':
      evidence.t7cIdempotencyConstraints =
        evidence.t7cIdempotencyConstraints.filter(
          (value) =>
            value !==
            'stable_system_deadline_key_workflow-deadline:<workflow_id>:<deadline_at_ms>',
        );
      return;
    case 'change_deadline_query_owner':
      evidence.deadlineQueryOwner = 'attempt_watchdog';
      return;
    case 'change_command_query_owner':
      evidence.commandQueryOwner = 'g5_timer_worker';
      return;
    case 'move_safety_deadline_back_to_t6d':
      evidence.safetyDeadlineEnforcementComponent =
        'workflow_deadline_watchdog';
      evidence.safetyDeadlineReservationPoint =
        'T0_deadline_freeze_and_T6d_watchdog';
      return;
    case 'add_schema_deadline_handoff_relation':
      evidence.schemaTableNames.push('workflow_deadline_command_handoffs');
      return;
    case 'remove_t6e_authorization':
      evidence.t6ePreconditions = evidence.t6ePreconditions.filter(
        (value) => value !== 'authorized_runtime_command',
      );
      return;
    case 'remove_t6e_command_invocation':
      evidence.t6eAtomicWrites = evidence.t6eAtomicWrites.filter(
        (value) => value !== 'command_invocation_and_runtime_event',
      );
      return;
    case 'remove_t6e_command_mapping':
      evidence.t6eCommandTypes.pop();
      return;
    case 'change_schema_version':
      evidence.schemaVersion = 3;
      return;
    case 'remove_schema_resolution_fk':
      evidence.schemaForeignKeys = evidence.schemaForeignKeys.filter(
        (candidate) =>
          candidate.relation_id !== 'fk:operational_blockers:command',
      );
      return;
    case 'allow_resolved_without_command': {
      const check = evidence.schemaChecks.find(
        (candidate) =>
          candidate.check_id === 'ck:operational_blockers:resolution_shape',
      );
      if (check) {
        check.expression_sql = check.expression_sql.replace(
          '"resolution_command_id" IS NOT NULL',
          '"resolution_command_id" IS NULL',
        );
      }
      return;
    }
    case 'remove_schema_resolution_check':
      evidence.schemaChecks = evidence.schemaChecks.filter(
        (candidate) =>
          candidate.check_id !== 'ck:operational_blockers:resolution_shape',
      );
      return;
    case 'remove_schema_insert_cache_trigger':
      evidence.schemaTriggers = evidence.schemaTriggers.filter(
        (candidate) =>
          candidate.name !== 'trg:operational_blockers:insert_cache',
      );
      return;
    case 'mutate_schema_update_cache_trigger': {
      const trigger = evidence.schemaTriggers.find(
        (candidate) =>
          candidate.name === 'trg:operational_blockers:update_cache',
      );
      if (trigger) {
        trigger.sql = trigger.sql.replace('"workflows"', '"workflows_drifted"');
      }
      return;
    }
    case 'remove_schema_cache_trigger':
      evidence.schemaTriggers = evidence.schemaTriggers.filter(
        (candidate) =>
          candidate.name !== 'trg:operational_blockers:update_cache',
      );
  }
}

export function evaluateGateOwnershipFixtureForTest(
  mutation: GateOwnershipFixtureMutation,
): OwnershipErrorCode {
  return evaluateGateOwnershipAuditProbeForTest(mutation);
}

function validatePositiveScenario(
  evidence: FrozenEvidence,
  scenario: GateOwnershipPositiveScenario,
): void {
  switch (scenario) {
    case 'automatic_attempt_timeout':
      if (
        !evidence.t6dAtomicWrites.includes('attempt_timeout_fence_and_fact') ||
        !evidence.t6dCasGuards.includes('attempt_acceptance_open_for_watchdog')
      )
        fail(
          't6d_automatic_semantics_drift',
          'Automatic attempt timeout fixture is incomplete',
        );
      return;
    case 'automatic_execution_or_quality_retry_timer':
      if (
        !evidence.t6dAtomicWrites.includes(
          'schedule_consumed_and_exact_next_attempt',
        ) ||
        !evidence.t6dAtomicWrites.includes('node_retry_wait_to_active')
      )
        fail(
          't6d_automatic_semantics_drift',
          'Automatic retry timer fixture is incomplete',
        );
      return;
    case 'future_g7_authorized_manual_retry_uses_g5_primitive':
      if (
        evidence.manualRetryCommand.transaction_protocol !== 'T6d' ||
        (evidence.manualRetryCommand.primitive_handoff as JsonObject)
          .authorization_owner !== 'G7_runtime_command_gateway'
      )
        fail(
          'manual_retry_authorization_drift',
          'Authorized manual retry fixture is incomplete',
        );
      return;
    case 'g7_system_deadline_to_t7c_stable_key':
      if (
        evidence.deadlineCommand.transaction_protocol !== 'T7c' ||
        (evidence.deadlineCommand.system_grant as JsonObject)
          .idempotency_key_template !==
          'workflow-deadline:<workflow_id>:<deadline_at_ms>'
      )
        fail(
          'deadline_stable_key_drift',
          'System deadline fixture is incomplete',
        );
  }
}

export function evaluateGateOwnershipPositiveFixtureForTest(
  scenario: GateOwnershipPositiveScenario,
): OwnershipErrorCode {
  const model = gateOwnershipModel();
  const evidence = frozenEvidence();
  try {
    validateOwnershipModel(model);
    validateFrozenEvidence(evidence);
    validatePositiveScenario(evidence, scenario);
    return 'accepted';
  } catch (error) {
    if (error instanceof GateOwnershipContractError) return error.code;
    throw error;
  }
}

export function evaluateGateOwnershipAuditProbeForTest(
  mutation: GateOwnershipAuditProbeMutation,
): OwnershipErrorCode {
  const model = gateOwnershipModel();
  const evidence = frozenEvidence();
  applyMutation(model, evidence, mutation);
  try {
    validateOwnershipModel(model);
    validateFrozenEvidence(evidence);
    return 'accepted';
  } catch (error) {
    if (error instanceof GateOwnershipContractError) return error.code;
    throw error;
  }
}

export function evaluateGateOwnershipDependencyProbeForTest(
  mutation: GateOwnershipDependencyProbeMutation,
): OwnershipErrorCode {
  const transaction = readArtifact(
    absoluteContractPath(
      'protocols/workflow-run-transaction-protocol-table.json',
    ),
  );
  const command = readArtifact(
    absoluteContractPath(
      'protocols/workflow-runtime-command-protocol-table.json',
    ),
  );
  const transactionSource = structuredClone(
    RUN_TRANSACTION_PROTOCOL_ENTRIES,
  ) as unknown as JsonValue;
  const commandSource = structuredClone(
    RUNTIME_COMMAND_PROTOCOL_ENTRIES,
  ) as unknown as JsonValue;
  if (mutation === 'transaction_source_generated_divergence') {
    const entries = transactionSource as JsonObject[];
    const t6e = entries.find((entry) => entry.transaction_id === 'T6e');
    if (!t6e) throw new Error('T6e source probe entry is missing');
    t6e.name = `${String(t6e.name)}_drifted`;
  } else {
    const entries = commandSource as JsonObject[];
    const t6e = entries.find((entry) => entry.transaction_protocol === 'T6e');
    if (!t6e) throw new Error('T6e command source probe entry is missing');
    t6e.state_guard = `${String(t6e.state_guard)}_drifted`;
  }
  try {
    validateProtocolSourceAgreement(
      transaction.payload.entries as unknown as JsonValue,
      command.payload.entries as unknown as JsonValue,
      transactionSource,
      commandSource,
    );
    return 'accepted';
  } catch (error) {
    if (error instanceof GateOwnershipContractError) return error.code;
    throw error;
  }
}

const POSITIVE_FIXTURES: GateOwnershipPositiveFixture[] = [
  {
    case_id: 'automatic-attempt-timeout',
    scenario: 'automatic_attempt_timeout',
    expected_code: 'accepted',
  },
  {
    case_id: 'automatic-execution-or-quality-retry-timer',
    scenario: 'automatic_execution_or_quality_retry_timer',
    expected_code: 'accepted',
  },
  {
    case_id: 'future-g7-authorized-manual-retry-uses-g5-primitive',
    scenario: 'future_g7_authorized_manual_retry_uses_g5_primitive',
    expected_code: 'accepted',
  },
  {
    case_id: 'g7-system-deadline-to-t7c-stable-key',
    scenario: 'g7_system_deadline_to_t7c_stable_key',
    expected_code: 'accepted',
  },
];

const NEGATIVE_FIXTURES: GateOwnershipFixture[] = [
  ['missing-g5-transaction', 'remove_g5_transaction', 'transaction_missing'],
  [
    'duplicate-g5-transaction',
    'duplicate_g5_transaction',
    'transaction_duplicate',
  ],
  ['unknown-transaction', 'add_unknown_transaction', 'transaction_unknown'],
  [
    'cross-gate-transaction',
    'move_g5_transaction_to_g7',
    'transaction_cross_gate',
  ],
  ['t6e-returned-to-g5', 'put_t6e_in_g5', 't6e_owned_by_g5'],
  ['missing-g5-semantic', 'remove_g5_semantic', 'semantic_missing'],
  ['duplicate-g5-semantic', 'duplicate_g5_semantic', 'semantic_duplicate'],
  ['unknown-semantic', 'add_unknown_semantic', 'semantic_unknown'],
  ['cross-gate-semantic', 'move_g5_semantic_to_g7', 'semantic_cross_gate'],
  [
    'g5-claims-resolution',
    'give_g5_resolution_semantic',
    'g5_forbidden_semantic',
  ],
  [
    'g5-claims-deadline-watchdog',
    'give_g5_deadline_watchdog',
    'g5_forbidden_semantic',
  ],
  [
    'g5-claims-runtime-command-gateway',
    'give_g5_runtime_command_gateway',
    'g5_forbidden_semantic',
  ],
  ['g5-claims-command-audit', 'give_g5_command_audit', 'g5_forbidden_semantic'],
  ['missing-g7-semantic', 'remove_g7_semantic', 'semantic_missing'],
  [
    't6d-attempt-timeout-write-removed',
    'remove_t6d_attempt_timeout_write',
    't6d_automatic_semantics_drift',
  ],
  [
    't6d-retry-schedule-write-removed',
    'remove_t6d_retry_schedule_write',
    't6d_automatic_semantics_drift',
  ],
  [
    't6d-deadline-command-reintroduced',
    'reintroduce_t6d_deadline_command',
    't6d_automatic_semantics_drift',
  ],
  [
    't6d-deadline-key-reintroduced',
    'reintroduce_t6d_deadline_key',
    't6d_automatic_semantics_drift',
  ],
  [
    't6d-late-deadline-outcome-reintroduced',
    'reintroduce_t6d_late_deadline_outcome',
    't6d_automatic_semantics_drift',
  ],
  [
    't6d-manual-authorization-precondition-removed',
    'remove_t6d_manual_authorization_precondition',
    't6d_automatic_semantics_drift',
  ],
  [
    'manual-retry-handoff-removed',
    'remove_manual_retry_handoff',
    'manual_retry_authorization_drift',
  ],
  [
    'manual-retry-bypasses-gateway',
    'manual_retry_bypass_gateway',
    'manual_retry_authorization_drift',
  ],
  [
    'deadline-system-grant-removed',
    'remove_deadline_system_grant',
    'deadline_system_grant_drift',
  ],
  [
    'deadline-due-target-drifted',
    'change_deadline_due_target',
    'deadline_system_grant_drift',
  ],
  [
    'deadline-stable-key-removed',
    'remove_deadline_stable_key',
    'deadline_system_grant_drift',
  ],
  [
    'deadline-invocation-audit-removed',
    'remove_deadline_invocation_audit',
    'deadline_system_grant_drift',
  ],
  [
    't7c-authorization-removed',
    'remove_t7c_authorization',
    'deadline_gateway_protocol_drift',
  ],
  [
    't7c-invocation-audit-removed',
    'remove_t7c_command_invocation_audit',
    'deadline_invocation_audit_drift',
  ],
  [
    't7c-stable-deadline-key-removed',
    'remove_t7c_stable_deadline_key',
    'deadline_stable_key_drift',
  ],
  [
    'deadline-query-owner-drifted',
    'change_deadline_query_owner',
    'deadline_query_ownership_drift',
  ],
  [
    'command-query-owner-drifted',
    'change_command_query_owner',
    'deadline_query_ownership_drift',
  ],
  [
    'safety-deadline-returned-to-t6d',
    'move_safety_deadline_back_to_t6d',
    'safety_deadline_ownership_drift',
  ],
  [
    'schema-temporary-deadline-handoff-added',
    'add_schema_deadline_handoff_relation',
    'schema_deadline_handoff_drift',
  ],
  [
    't6e-authorization-removed',
    'remove_t6e_authorization',
    't6e_protocol_drift',
  ],
  [
    't6e-command-audit-removed',
    'remove_t6e_command_invocation',
    't6e_protocol_drift',
  ],
  [
    't6e-command-mapping-removed',
    'remove_t6e_command_mapping',
    't6e_command_mapping_drift',
  ],
  ['schema4-version-drift', 'change_schema_version', 'schema4_identity_drift'],
  [
    'resolution-command-fk-removed',
    'remove_schema_resolution_fk',
    'schema_resolution_fk_drift',
  ],
  [
    'resolved-command-made-nullable',
    'allow_resolved_without_command',
    'schema_resolution_shape_drift',
  ],
  [
    'blocker-cache-trigger-removed',
    'remove_schema_cache_trigger',
    'schema_cache_trigger_drift',
  ],
].map(([case_id, mutation, expected_code]) => ({
  case_id,
  mutation,
  expected_code,
})) as GateOwnershipFixture[];

function authorityPayload(): JsonObject {
  const model = gateOwnershipModel();
  validateOwnershipModel(model);
  validateDependencyArtifacts();
  const evidence = frozenEvidence();
  validateFrozenEvidence(evidence);
  for (const fixture of POSITIVE_FIXTURES) {
    validatePositiveScenario(evidence, fixture.scenario);
  }
  for (const fixture of NEGATIVE_FIXTURES) {
    const candidateModel = structuredClone(model);
    const candidateEvidence = structuredClone(evidence);
    applyMutation(candidateModel, candidateEvidence, fixture.mutation);
    let actual: OwnershipErrorCode = 'accepted';
    try {
      validateOwnershipModel(candidateModel);
      validateFrozenEvidence(candidateEvidence);
    } catch (error) {
      if (!(error instanceof GateOwnershipContractError)) throw error;
      actual = error.code;
    }
    if (actual !== fixture.expected_code) {
      fail(
        'gate_missing_or_unknown',
        `Gate ownership fixture oracle drift: ${fixture.case_id}: ${actual}`,
      );
    }
  }
  return {
    governance_scope: model.scope,
    status: 'T6D_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION',
    authority_kind: 'current_construction_gate_ownership',
    reopened_from: {
      source_commit: '627d0bc483a971f0d5bdbd59c7fb40c994f90097',
      workflow_run_transaction_protocol_table_hash:
        'sha256:7c55b3eff2f29e5dfcbb057d5ff014697ba2e9a421287afa19ec850540cce5f0',
      workflow_runtime_command_protocol_table_hash:
        'sha256:b12b07b29e9335593c969033c133d221b244798fc079db5fb398b23fbae10789',
      gate_ownership_authority_hash:
        'sha256:36289416db3c8898d9b50c04c5ad43fc6b74ef53bbd3a3c99f9d5f5b72786fa8',
    },
    historical_g0_g1_identity_effect:
      'Capacity_G0.10_repaired_and_G1_advanced_from_Schema_4_to_Schema_5',
    g4_pack_identity_effect: 'direct_G3_run_protocol_dependency_rebuilt',
    matrix: model.gates,
    frozen_authority_bindings: {
      workflow_run_transaction_protocol_table_hash:
        EXPECTED_BINDINGS.transactionProtocol,
      workflow_runtime_command_protocol_table_hash:
        EXPECTED_BINDINGS.commandProtocol,
      workflow_runtime_logical_schema_source_hash:
        EXPECTED_BINDINGS.logicalSchema,
      g1_executable_schema_root_hash: EXPECTED_BINDINGS.g1Root,
      database_schema_version: 5,
      workflow_runtime_schema_manifest_hash: EXPECTED_BINDINGS.schemaManifest,
      workflow_runtime_schema_hash: EXPECTED_BINDINGS.schemaHash,
    },
    affected_current_root_inventory: affectedCurrentRootInventory(),
    frozen_invariants: {
      t6d_name: 'attempt_watchdog_and_retry_timers',
      t6d_automatic_atomic_writes: [
        'attempt_timeout_fence_and_fact',
        'cancel_reconcile_or_compensation_effects',
        'schedule_consumed_and_exact_next_attempt',
        'node_retry_wait_to_active',
      ],
      t6d_gateway_writes: 'forbidden',
      manual_retry_boundary:
        'G7_runtime_command_gateway_authorization_and_audit_before_G5_T6d_primitive',
      workflow_deadline_boundary:
        'G7_deadline_watchdog_to_runtime_command_gateway_to_T7c',
      workflow_deadline_command_key:
        'workflow-deadline:<workflow_id>:<deadline_at_ms>',
      workflow_deadline_system_grant:
        'deadline_enforced|safety_enforced+due_target+cancel_workflow_only',
      t7c_authorization_precondition: 'authorized_cancel_command',
      t7c_atomic_command_audit: 'command_invocation_audit',
      t6e_authorization_precondition: 'authorized_runtime_command',
      t6e_atomic_resolution_audit: 'command_invocation_and_runtime_event',
      t6e_command_types: [...T6E_COMMAND_TYPES],
      resolution_command_fk:
        'workflow_operational_blockers.resolution_command_id -> workflow_runtime_commands.command_id',
      resolved_blocker_requires_resolution_command: true,
      blocker_cache_triggers: [
        'trg:operational_blockers:insert_cache',
        'trg:operational_blockers:update_cache',
      ],
    },
    fixture_counts: {
      positive: POSITIVE_FIXTURES.length,
      negative: NEGATIVE_FIXTURES.length,
    },
    implementation_authorized: false,
    next_required_gate:
      'independent_t6d_ownership_and_affected_chain_regression',
  };
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const positive = artifact(
    'icarus.workflow-runtime-gate-ownership-positive-cases/1',
    'icarus.workflow-runtime-gate-ownership-positive-cases',
    POSITIVE_DOMAIN,
    { cases: POSITIVE_FIXTURES },
  );
  const negative = artifact(
    'icarus.workflow-runtime-gate-ownership-negative-cases/1',
    'icarus.workflow-runtime-gate-ownership-negative-cases',
    NEGATIVE_DOMAIN,
    { cases: NEGATIVE_FIXTURES },
  );
  const authority = artifact(
    'icarus.workflow-runtime-gate-ownership/1',
    'icarus.workflow-runtime-gate-ownership',
    AUTHORITY_DOMAIN,
    {
      ...authorityPayload(),
      positive_cases_hash: positive.hash,
      negative_cases_hash: negative.hash,
    },
  );
  return [
    [GATE_OWNERSHIP_AUTHORITY_PATH, authority],
    [GATE_OWNERSHIP_POSITIVE_CASES_PATH, positive],
    [GATE_OWNERSHIP_NEGATIVE_CASES_PATH, negative],
  ];
}

export function generateGateOwnershipContracts(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  for (const [relativePath, value] of artifacts)
    writeAtomic(relativePath, value);
  return artifacts[0][1];
}

export function checkGateOwnershipContracts(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  for (const [relativePath, expected] of artifacts) {
    const actual = readArtifact(absoluteContractPath(relativePath));
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new GateOwnershipContractError(
        'gate_missing_or_unknown',
        `${relativePath} identity or payload drift`,
      );
    }
    if (
      fs.readFileSync(absoluteContractPath(relativePath), 'utf8') !==
      render(expected)
    ) {
      throw new GateOwnershipContractError(
        'gate_missing_or_unknown',
        `${relativePath} is not generated byte-for-byte`,
      );
    }
  }
  return artifacts[0][1];
}

export function generateGateOwnershipRepairContracts(): ContractArtifactEnvelope {
  generateContractPackCatalogProtocols();
  generateContractPackSafetySqlite();
  return generateGateOwnershipContracts();
}

export function checkGateOwnershipRepairContracts(): ContractArtifactEnvelope {
  checkContractPackCatalogProtocols();
  checkContractPackSafetySqlite();
  return checkGateOwnershipContracts();
}

export function gateOwnershipFixturesForTest(): {
  positive: GateOwnershipPositiveFixture[];
  negative: GateOwnershipFixture[];
} {
  return {
    positive: structuredClone(POSITIVE_FIXTURES),
    negative: structuredClone(NEGATIVE_FIXTURES),
  };
}
