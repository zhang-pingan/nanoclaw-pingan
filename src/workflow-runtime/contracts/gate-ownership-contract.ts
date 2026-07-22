import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, canonicalJson } from './hash.js';
import {
  RUNTIME_COMMAND_PROTOCOL_ENTRIES,
  RUN_TRANSACTION_PROTOCOL_ENTRIES,
  RUN_TRANSACTION_PROTOCOL_IDS,
  type RunTransactionProtocolId,
} from './protocol-table-types.js';
import { strictParseJsonBytes } from './strict-json.js';
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
  'operational_blocker_create',
  'open_blocker_set_authority',
  'run_operational_state_cache_on_blocker_create',
  'workflow_operational_state_cache_on_blocker_create',
  'open_blocker_cache_bidirectional_consistency',
] as const;

const G7_SEMANTIC_OWNERSHIP = [
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
    'sha256:7c55b3eff2f29e5dfcbb057d5ff014697ba2e9a421287afa19ec850540cce5f0',
  commandProtocol:
    'sha256:b12b07b29e9335593c969033c133d221b244798fc079db5fb398b23fbae10789',
  logicalSchema:
    'sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214',
  g1Root:
    'sha256:6f49451868b7a5cab359d1c21f14f79afbc11b12aa1938039daf5914d9c4d591',
  schemaManifest:
    'sha256:87f6787dd5c6382df97120c2e10dc6624143c67efc35e57cb92ea22f16fa666b',
  schemaHash:
    'sha256:f517a5e7bb8b3ea91bb37cd6a68b32898ceb62b9044687a8103808be6852106a',
} as const satisfies Record<string, Sha256Hash>;

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
  | 'remove_g7_semantic'
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

function writeAtomic(relativePath: string, value: JsonValue): void {
  const target = absoluteContractPath(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, render(value), { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function gateOwnershipModel(): GateOwnershipModel {
  return {
    scope: 'current_construction_g5_g7_t6e_boundary',
    gates: [
      {
        gate: 'G5',
        owned_transaction_protocols: [...G5_TRANSACTION_PROTOCOLS],
        owned_semantics: [...G5_SEMANTIC_OWNERSHIP],
        explicitly_excluded_semantics: [...G7_SEMANTIC_OWNERSHIP],
        exit_evidence: [
          'T0-T6d_model_and_fault_fixtures',
          'operational_blocker_creation_fixtures',
          'open_blocker_set_and_run_workflow_cache_consistency',
          'future_G7_authority_present_but_not_consumed',
        ],
      },
      {
        gate: 'G7',
        owned_transaction_protocols: [...G7_TRANSACTION_PROTOCOLS],
        owned_semantics: [...G7_SEMANTIC_OWNERSHIP],
        explicitly_excluded_semantics: [...G5_SEMANTIC_OWNERSHIP],
        exit_evidence: [
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
  const t6e = RUN_TRANSACTION_PROTOCOL_ENTRIES.find(
    (entry) => entry.transaction_id === 'T6e',
  );
  if (!t6e) {
    throw new GateOwnershipContractError(
      't6e_protocol_drift',
      'Frozen transaction protocol is missing T6e',
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
      'Schema 4 is missing workflow_operational_blockers',
    );
  }
  return {
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

function validateOwnershipModel(model: GateOwnershipModel): void {
  if (model.scope !== 'current_construction_g5_g7_t6e_boundary') {
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
    evidence.schemaVersion !== 4 ||
    evidence.schemaHash !== EXPECTED_BINDINGS.schemaHash
  ) {
    fail('schema4_identity_drift', 'Database Schema 4 identity drifted');
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
      'Schema 4 resolution_command_id FK drifted',
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
      'Frozen protocol or Schema 4 binding drifted',
    );
  }
  validateProtocolSourceAgreement(
    transaction.payload.entries as unknown as JsonValue,
    command.payload.entries as unknown as JsonValue,
  );
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
    case 'remove_g7_semantic':
      g7.owned_semantics.pop();
      return;
    case 'remove_g5_excluded_semantic':
      g5.explicitly_excluded_semantics.pop();
      return;
    case 'remove_g7_excluded_semantic':
      g7.explicitly_excluded_semantics.pop();
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

const POSITIVE_FIXTURES: GateOwnershipFixture[] = [
  {
    case_id: 'exact-g5-g7-t6e-ownership',
    mutation: 'none',
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
  ['missing-g7-semantic', 'remove_g7_semantic', 'semantic_missing'],
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
  for (const fixture of [...POSITIVE_FIXTURES, ...NEGATIVE_FIXTURES]) {
    const actual = evaluateGateOwnershipFixtureForTest(fixture.mutation);
    if (actual !== fixture.expected_code) {
      fail(
        'gate_missing_or_unknown',
        `Gate ownership fixture oracle drift: ${fixture.case_id}: ${actual}`,
      );
    }
  }
  return {
    governance_scope: model.scope,
    status: 'G5_OWNERSHIP_EXIT_CANDIDATE_PENDING_INDEPENDENT_REGRESSION',
    authority_kind: 'current_construction_gate_ownership',
    historical_g0_g1_identity_effect: 'none',
    g4_pack_identity_effect: 'none',
    matrix: model.gates,
    frozen_authority_bindings: {
      workflow_run_transaction_protocol_table_hash:
        EXPECTED_BINDINGS.transactionProtocol,
      workflow_runtime_command_protocol_table_hash:
        EXPECTED_BINDINGS.commandProtocol,
      workflow_runtime_logical_schema_source_hash:
        EXPECTED_BINDINGS.logicalSchema,
      g1_executable_schema_root_hash: EXPECTED_BINDINGS.g1Root,
      database_schema_version: 4,
      workflow_runtime_schema_manifest_hash: EXPECTED_BINDINGS.schemaManifest,
      workflow_runtime_schema_hash: EXPECTED_BINDINGS.schemaHash,
    },
    frozen_invariants: {
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
    next_required_gate: 'independent_ownership_and_affected_chain_regression',
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

export function gateOwnershipFixturesForTest(): {
  positive: GateOwnershipFixture[];
  negative: GateOwnershipFixture[];
} {
  return {
    positive: structuredClone(POSITIVE_FIXTURES),
    negative: structuredClone(NEGATIVE_FIXTURES),
  };
}
