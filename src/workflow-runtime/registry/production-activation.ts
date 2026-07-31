import fs from 'node:fs';
import path from 'node:path';

import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from '../contracts/hash.js';
import {
  G9_DEPLOYMENT_JOURNAL_PHASES,
  G9_DEPLOYMENT_PARTICIPANTS,
  type G9ActivationAudit,
  type G9DeploymentActivationBinding,
  type G9DeploymentActivationJournalEvent,
  type G9DeploymentParticipant,
  type G9FeatureRegistryPointerTarget,
  type G9ProductionActivationRequest,
  type G9ProjectionGenerationBinding,
} from '../contracts/g9-production-activation-types.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';

const PARTICIPANT_ORDER = G9_DEPLOYMENT_PARTICIPANTS.filter(
  (participant) => participant !== 'deployment_pointer',
);
const PROJECTION_VIEW_ORDER = [
  'workflows',
  'agent_executions',
  'pending',
  'trace',
] as const;

export interface G9ProductionActivationParticipant {
  readonly name: Exclude<G9DeploymentParticipant, 'deployment_pointer'>;
  prepare(binding: Readonly<G9DeploymentActivationBinding>): void;
  rollback(binding: Readonly<G9DeploymentActivationBinding>): void;
  rollForward(binding: Readonly<G9DeploymentActivationBinding>): void;
}

export interface G9ProductionActivationOutcome {
  readonly disposition:
    | 'activated'
    | 'recovered_precommit_rollback'
    | 'recovered_postcommit_roll_forward'
    | 'exact_replay';
  readonly binding_hash: Sha256Hash;
  readonly journal_head_hash: Sha256Hash;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  )
    throw new Error(`${label}_field_set_invalid`);
}

function assertSafeIdentity(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value)
  )
    throw new Error(`${label}_invalid`);
  return value;
}

function assertSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`${label}_invalid`);
  return Number(value);
}

function objectHash(
  domain: string,
  value: object,
  hashKey: string,
): Sha256Hash {
  const payload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== hashKey),
  );
  return domainSeparatedSha256(domain, payload as JsonValue);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function calculateG9FeaturePointerAggregateHash(
  pointers: readonly G9FeatureRegistryPointerTarget[],
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:g9-feature-registry-pointer-aggregate:1\n',
    [...pointers]
      .sort((left, right) => compareAscii(left.feature_id, right.feature_id))
      .map((pointer) => ({ ...pointer })),
  );
}

export function calculateG9ProjectionGenerationAggregateHash(
  generations: readonly G9ProjectionGenerationBinding[],
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:g9-runtime-center-projection-generation-aggregate:1\n',
    generations.map((generation) => ({ ...generation })),
  );
}

export function buildG9ActivationAudit(
  input: Omit<G9ActivationAudit, 'format' | 'actor_ref' | 'audit_hash'>,
): G9ActivationAudit {
  const withoutHash = {
    format: 'icarus.production-activation-audit/1',
    activation_id: assertSafeIdentity(input.activation_id, 'activation_id'),
    actor_ref: 'system:production-activation',
    requested_at_ms: assertSafeInteger(
      input.requested_at_ms,
      'requested_at_ms',
    ),
    request_hash: parseSha256Hash(input.request_hash),
    target_release_artifact_hash: parseSha256Hash(
      input.target_release_artifact_hash,
    ),
    previous_deployment_binding_hash:
      input.previous_deployment_binding_hash === null
        ? null
        : parseSha256Hash(input.previous_deployment_binding_hash),
    capacity_mode: input.capacity_mode,
  } as const;
  return {
    ...withoutHash,
    audit_hash: domainSeparatedSha256(
      'icarus:production-activation-audit:1\n',
      withoutHash,
    ),
  };
}

export function parseG9ActivationAudit(value: unknown): G9ActivationAudit {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'format',
      'activation_id',
      'actor_ref',
      'requested_at_ms',
      'request_hash',
      'target_release_artifact_hash',
      'previous_deployment_binding_hash',
      'capacity_mode',
      'audit_hash',
    ],
    'production_activation_audit',
  );
  const audit = value as unknown as G9ActivationAudit;
  assertSafeIdentity(audit.activation_id, 'activation_id');
  assertSafeInteger(audit.requested_at_ms, 'requested_at_ms');
  parseSha256Hash(audit.request_hash);
  parseSha256Hash(audit.target_release_artifact_hash);
  if (audit.previous_deployment_binding_hash !== null)
    parseSha256Hash(audit.previous_deployment_binding_hash);
  if (
    audit.format !== 'icarus.production-activation-audit/1' ||
    audit.actor_ref !== 'system:production-activation' ||
    !['fresh_genesis', 'existing_preserved'].includes(audit.capacity_mode) ||
    parseSha256Hash(audit.audit_hash) !==
      objectHash('icarus:production-activation-audit:1\n', audit, 'audit_hash')
  )
    throw new Error('production_activation_audit_identity_invalid');
  return structuredClone(audit);
}

function assertFeaturePointers(
  binding: G9DeploymentActivationBinding['feature_registry_pointer'],
): void {
  assertJsonObject(binding);
  exactKeys(
    binding,
    ['state', 'active_release_count', 'pointers', 'pointer_aggregate_hash'],
    'feature_registry_pointer',
  );
  if (!Array.isArray(binding.pointers))
    throw new Error('feature_pointer_targets_invalid');
  for (const pointer of binding.pointers) {
    assertJsonObject(pointer);
    exactKeys(
      pointer,
      ['feature_id', 'release_id', 'release_hash'],
      'feature_registry_pointer_target',
    );
    assertSafeIdentity(pointer.feature_id, 'feature_id');
    assertSafeIdentity(pointer.release_id, 'release_id');
    parseSha256Hash(pointer.release_hash);
  }
  const sorted = [...binding.pointers].sort((left, right) =>
    compareAscii(left.feature_id, right.feature_id),
  );
  if (
    canonicalJson(sorted as unknown as JsonValue) !==
      canonicalJson(binding.pointers as unknown as JsonValue) ||
    new Set(binding.pointers.map((pointer) => pointer.feature_id)).size !==
      binding.pointers.length ||
    binding.active_release_count !== binding.pointers.length ||
    binding.state !== (binding.pointers.length === 0 ? 'empty' : 'present') ||
    binding.pointer_aggregate_hash !==
      calculateG9FeaturePointerAggregateHash(binding.pointers)
  )
    throw new Error('feature_pointer_aggregate_invalid');
}

function assertProjectionGenerations(
  binding: G9DeploymentActivationBinding['runtime_center_projection'],
): void {
  assertJsonObject(binding);
  exactKeys(
    binding,
    ['projection_version', 'generations', 'generation_aggregate_hash'],
    'runtime_center_projection',
  );
  if (
    binding.projection_version !== 'g7.1' ||
    !Array.isArray(binding.generations) ||
    binding.generations.length !== PROJECTION_VIEW_ORDER.length
  )
    throw new Error('projection_generation_set_invalid');
  binding.generations.forEach((generation, index) => {
    assertJsonObject(generation);
    exactKeys(
      generation,
      ['view', 'generation_id', 'source_head_seq', 'rows_hash'],
      'runtime_center_projection_generation',
    );
    if (
      generation.view !== PROJECTION_VIEW_ORDER[index] ||
      assertSafeIdentity(generation.generation_id, 'generation_id').length === 0
    )
      throw new Error('projection_generation_identity_invalid');
    assertSafeInteger(generation.source_head_seq, 'projection_source_head_seq');
    parseSha256Hash(generation.rows_hash);
  });
  if (
    binding.generation_aggregate_hash !==
    calculateG9ProjectionGenerationAggregateHash(binding.generations)
  )
    throw new Error('projection_generation_aggregate_invalid');
}

export function buildG9DeploymentActivationBinding(
  input: Omit<G9DeploymentActivationBinding, 'format' | 'binding_hash'>,
): G9DeploymentActivationBinding {
  const withoutHash = {
    format: 'icarus.deployment-activation-binding/1',
    ...structuredClone(input),
  } as const;
  return parseG9DeploymentActivationBinding({
    ...withoutHash,
    binding_hash: domainSeparatedSha256(
      'icarus:deployment-activation-binding:1\n',
      withoutHash as unknown as JsonValue,
    ),
  });
}

export function parseG9DeploymentActivationBinding(
  value: unknown,
): G9DeploymentActivationBinding {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'format',
      'deployment_profile',
      'runtime_surface',
      'release_manifest_hash',
      'release_artifact_hash',
      'core_build_hash',
      'core_binding_hash',
      'applicable_g8_evidence',
      'static_authority',
      'feature_registry_pointer',
      'runtime_center_projection',
      'capacity_authority',
      'activation_audit_hash',
      'binding_hash',
    ],
    'deployment_activation_binding',
  );
  const binding = value as unknown as G9DeploymentActivationBinding;
  assertJsonObject(binding.applicable_g8_evidence);
  exactKeys(
    binding.applicable_g8_evidence,
    [
      'status',
      'release_artifact_hash',
      'startup_report_hash',
      'readiness_report_hash',
      'startup_harness_hash',
      'readiness_harness_hash',
      'sqlite_profile_candidate_hash',
      'node_executable_hash',
      'native_module_hash',
    ],
    'applicable_g8_evidence',
  );
  assertJsonObject(binding.static_authority);
  exactKeys(
    binding.static_authority,
    [
      'source_core_build_hash',
      'absence_baseline_hash',
      'product_surface_manifest_hash',
      'migration_candidate_boundary_hash',
    ],
    'static_activation_authority',
  );
  for (const hash of [
    binding.release_manifest_hash,
    binding.release_artifact_hash,
    binding.core_build_hash,
    binding.core_binding_hash,
    binding.activation_audit_hash,
    binding.binding_hash,
  ])
    parseSha256Hash(hash);
  if (
    binding.format !== 'icarus.deployment-activation-binding/1' ||
    binding.deployment_profile !== 'local_single_user' ||
    binding.runtime_surface !== 'node_service' ||
    binding.applicable_g8_evidence.status !==
      'fresh_independent_boundary_pass' ||
    binding.applicable_g8_evidence.release_artifact_hash !==
      binding.release_artifact_hash
  )
    throw new Error('deployment_activation_binding_identity_invalid');
  for (const hash of [
    binding.applicable_g8_evidence.release_artifact_hash,
    binding.applicable_g8_evidence.startup_report_hash,
    binding.applicable_g8_evidence.readiness_report_hash,
    binding.applicable_g8_evidence.startup_harness_hash,
    binding.applicable_g8_evidence.readiness_harness_hash,
    binding.applicable_g8_evidence.sqlite_profile_candidate_hash,
    binding.applicable_g8_evidence.node_executable_hash,
    binding.applicable_g8_evidence.native_module_hash,
  ])
    parseSha256Hash(hash);
  for (const hash of Object.values(binding.static_authority))
    parseSha256Hash(hash);
  assertFeaturePointers(binding.feature_registry_pointer);
  assertProjectionGenerations(binding.runtime_center_projection);
  assertJsonObject(binding.capacity_authority);
  if (binding.capacity_authority.mode === 'fresh_genesis') {
    exactKeys(
      binding.capacity_authority,
      [
        'mode',
        'expected_head_state',
        'baseline_config_hash',
        'expected_capacity_revision',
        'expected_change_id',
        'expected_publication_hash',
        'expected_audit_head_hash',
        'genesis_core_release_hash',
        'genesis_command_id',
        'genesis_idempotency_key',
        'genesis_auth_session_ref',
        'genesis_evidence_manifest_id',
        'genesis_evidence_manifest_hash',
        'genesis_result_schema_row_id',
        'genesis_result_schema_resource_type',
        'genesis_result_schema_ref',
        'genesis_result_schema_hash',
      ],
      'fresh_capacity_authority',
    );
    if (
      binding.capacity_authority.expected_head_state !== 'absent' ||
      binding.capacity_authority.expected_capacity_revision !== 1 ||
      binding.capacity_authority.genesis_core_release_hash !==
        binding.release_artifact_hash
    )
      throw new Error('fresh_capacity_binding_invalid');
    for (const identity of [
      binding.capacity_authority.expected_change_id,
      binding.capacity_authority.genesis_command_id,
      binding.capacity_authority.genesis_idempotency_key,
      binding.capacity_authority.genesis_auth_session_ref,
      binding.capacity_authority.genesis_evidence_manifest_id,
      binding.capacity_authority.genesis_result_schema_row_id,
    ])
      assertSafeIdentity(identity, 'fresh_capacity_identity');
    assertJsonObject(binding.capacity_authority.genesis_result_schema_ref);
    exactKeys(
      binding.capacity_authority.genesis_result_schema_ref,
      ['id', 'version'],
      'fresh_capacity_result_schema_ref',
    );
    if (
      binding.capacity_authority.genesis_result_schema_resource_type !==
        'schema' ||
      typeof binding.capacity_authority.genesis_result_schema_ref.id !==
        'string' ||
      typeof binding.capacity_authority.genesis_result_schema_ref.version !==
        'string'
    )
      throw new Error('fresh_capacity_result_schema_invalid');
    for (const hash of [
      binding.capacity_authority.baseline_config_hash,
      binding.capacity_authority.expected_publication_hash,
      binding.capacity_authority.expected_audit_head_hash,
      binding.capacity_authority.genesis_evidence_manifest_hash,
      binding.capacity_authority.genesis_result_schema_hash,
    ])
      parseSha256Hash(hash);
  } else if (binding.capacity_authority.mode === 'existing_preserved') {
    exactKeys(
      binding.capacity_authority,
      [
        'mode',
        'capacity_revision',
        'change_id',
        'config_hash',
        'publication_hash',
        'publication_file_raw_hash',
        'audit_head_hash',
      ],
      'existing_capacity_authority',
    );
    assertSafeInteger(
      binding.capacity_authority.capacity_revision,
      'capacity_revision',
    );
    if (binding.capacity_authority.capacity_revision === 0)
      throw new Error('existing_capacity_revision_invalid');
    assertSafeIdentity(
      binding.capacity_authority.change_id,
      'capacity_change_id',
    );
    for (const hash of [
      binding.capacity_authority.config_hash,
      binding.capacity_authority.publication_hash,
      binding.capacity_authority.publication_file_raw_hash,
      binding.capacity_authority.audit_head_hash,
    ])
      parseSha256Hash(hash);
  } else throw new Error('capacity_authority_mode_invalid');
  if (
    parseSha256Hash(binding.binding_hash) !==
    objectHash(
      'icarus:deployment-activation-binding:1\n',
      binding,
      'binding_hash',
    )
  )
    throw new Error('deployment_activation_binding_hash_invalid');
  return structuredClone(binding);
}

export function buildG9DeploymentJournalEvent(
  input: Omit<G9DeploymentActivationJournalEvent, 'format' | 'event_hash'>,
): G9DeploymentActivationJournalEvent {
  const withoutHash = {
    format: 'icarus.deployment-activation-journal-event/1',
    ...input,
  } as const;
  return parseG9DeploymentJournalEvent({
    ...withoutHash,
    event_hash: domainSeparatedSha256(
      'icarus:deployment-activation-journal-event:1\n',
      withoutHash as unknown as JsonValue,
    ),
  });
}

export function parseG9DeploymentJournalEvent(
  value: unknown,
): G9DeploymentActivationJournalEvent {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'format',
      'activation_id',
      'sequence',
      'phase',
      'participant',
      'previous_event_hash',
      'previous_binding_hash',
      'target_binding_hash',
      'operation_key',
      'occurred_at_ms',
      'event_hash',
    ],
    'deployment_activation_journal_event',
  );
  const event = value as unknown as G9DeploymentActivationJournalEvent;
  assertSafeIdentity(event.activation_id, 'activation_id');
  assertSafeIdentity(event.operation_key, 'operation_key');
  assertSafeInteger(event.sequence, 'journal_sequence');
  assertSafeInteger(event.occurred_at_ms, 'occurred_at_ms');
  if (
    event.sequence < 1 ||
    !G9_DEPLOYMENT_JOURNAL_PHASES.includes(event.phase) ||
    (event.participant !== null &&
      !G9_DEPLOYMENT_PARTICIPANTS.includes(event.participant))
  )
    throw new Error('deployment_activation_journal_shape_invalid');
  const nullParticipantPhase =
    event.phase === 'prepared' ||
    event.phase === 'precommit_rollback_completed' ||
    event.phase === 'completed';
  const deploymentPointerPhase = event.phase === 'active_deployment_committed';
  if (
    (nullParticipantPhase && event.participant !== null) ||
    (deploymentPointerPhase && event.participant !== 'deployment_pointer') ||
    (!nullParticipantPhase &&
      !deploymentPointerPhase &&
      (event.participant === null ||
        event.participant === 'deployment_pointer'))
  )
    throw new Error('deployment_activation_journal_participant_invalid');
  if (event.previous_event_hash !== null)
    parseSha256Hash(event.previous_event_hash);
  if (event.previous_binding_hash !== null)
    parseSha256Hash(event.previous_binding_hash);
  parseSha256Hash(event.target_binding_hash);
  if (
    parseSha256Hash(event.event_hash) !==
    objectHash(
      'icarus:deployment-activation-journal-event:1\n',
      event,
      'event_hash',
    )
  )
    throw new Error('deployment_activation_journal_hash_invalid');
  return structuredClone(event);
}

export function parseG9ProductionActivationRequest(
  value: unknown,
): G9ProductionActivationRequest {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'format',
      'operation',
      'activation_id',
      'operation_key',
      'requested_at_ms',
      'audit',
      'deployment_binding',
    ],
    'production_activation_request',
  );
  const request = value as unknown as G9ProductionActivationRequest;
  const audit = parseG9ActivationAudit(request.audit);
  const binding = parseG9DeploymentActivationBinding(
    request.deployment_binding,
  );
  const {
    activation_audit_hash: _activationAuditHash,
    binding_hash: _bindingHash,
    ...deploymentBindingIntent
  } = binding;
  const expectedRequestHash = domainSeparatedSha256(
    'icarus:production-activation-request:1\n',
    {
      format: request.format,
      operation: request.operation,
      activation_id: request.activation_id,
      operation_key: request.operation_key,
      requested_at_ms: request.requested_at_ms,
      deployment_binding_intent: deploymentBindingIntent,
    } as unknown as JsonValue,
  );
  if (
    request.format !== 'icarus.production-activation-request/1' ||
    request.operation !== 'activate' ||
    assertSafeIdentity(request.activation_id, 'activation_id') !==
      audit.activation_id ||
    assertSafeIdentity(request.operation_key, 'operation_key').length === 0 ||
    assertSafeInteger(request.requested_at_ms, 'requested_at_ms') !==
      audit.requested_at_ms ||
    audit.target_release_artifact_hash !== binding.release_artifact_hash ||
    audit.request_hash !== expectedRequestHash ||
    audit.capacity_mode !== binding.capacity_authority.mode ||
    audit.audit_hash !== binding.activation_audit_hash
  )
    throw new Error('production_activation_request_identity_invalid');
  return { ...structuredClone(request), audit, deployment_binding: binding };
}

export function buildG9ProductionActivationRequest(input: {
  readonly activation_id: string;
  readonly operation_key: string;
  readonly requested_at_ms: number;
  readonly previous_deployment_binding_hash: Sha256Hash | null;
  readonly deployment_binding: Omit<
    G9DeploymentActivationBinding,
    'format' | 'activation_audit_hash' | 'binding_hash'
  >;
}): G9ProductionActivationRequest {
  const requestHash = domainSeparatedSha256(
    'icarus:production-activation-request:1\n',
    {
      format: 'icarus.production-activation-request/1',
      operation: 'activate',
      activation_id: input.activation_id,
      operation_key: input.operation_key,
      requested_at_ms: input.requested_at_ms,
      deployment_binding_intent: {
        format: 'icarus.deployment-activation-binding/1',
        ...input.deployment_binding,
      },
    } as unknown as JsonValue,
  );
  const audit = buildG9ActivationAudit({
    activation_id: input.activation_id,
    requested_at_ms: input.requested_at_ms,
    request_hash: requestHash,
    target_release_artifact_hash:
      input.deployment_binding.release_artifact_hash,
    previous_deployment_binding_hash: input.previous_deployment_binding_hash,
    capacity_mode: input.deployment_binding.capacity_authority.mode,
  });
  const deploymentBinding = buildG9DeploymentActivationBinding({
    ...input.deployment_binding,
    activation_audit_hash: audit.audit_hash,
  });
  return parseG9ProductionActivationRequest({
    format: 'icarus.production-activation-request/1',
    operation: 'activate',
    activation_id: input.activation_id,
    operation_key: input.operation_key,
    requested_at_ms: input.requested_at_ms,
    audit,
    deployment_binding: deploymentBinding,
  });
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function durableWriteExclusive(
  runtimeHome: string,
  file: string,
  value: JsonValue,
): void {
  const relative = path.relative(runtimeHome, file);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('production_activation_state_path_invalid');
  let directory = runtimeHome;
  for (const segment of path.dirname(relative).split(path.sep)) {
    directory = path.join(directory, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(directory, { mode: 0o700 });
      stat = fs.lstatSync(directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('production_activation_state_directory_invalid');
  }
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error(`content_addressed_object_collision:${file}`);
    if (fs.readFileSync(file, 'utf8') !== bytes)
      throw new Error(`content_addressed_object_collision:${file}`);
    return;
  }
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(file));
}

function atomicRelativePointer(
  root: string,
  pointerName: string,
  relativeTarget: string,
): void {
  if (
    path.isAbsolute(relativeTarget) ||
    relativeTarget
      .split('/')
      .some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('activation_pointer_target_invalid');
  const pointer = path.join(root, pointerName);
  const temporary = path.join(root, `.${pointerName}.${process.pid}.tmp`);
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(relativeTarget, temporary);
  fs.renameSync(temporary, pointer);
  fsyncDirectory(root);
}

function readDeploymentPointer(runtimeHome: string): Sha256Hash | null {
  const pointer = path.join(runtimeHome, 'active-deployment');
  let pointerStat: fs.Stats;
  try {
    pointerStat = fs.lstatSync(pointer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!pointerStat.isSymbolicLink())
    throw new Error('active_deployment_pointer_invalid');
  const target = fs.readlinkSync(pointer);
  const match = /^deployment-bindings\/([0-9a-f]{64})$/.exec(target);
  if (!match) throw new Error('active_deployment_pointer_invalid');
  const hash = parseSha256Hash(`sha256:${match[1]}`);
  const binding = parseG9DeploymentActivationBinding(
    strictParseJsonBytes(
      fs.readFileSync(
        path.join(runtimeHome, target, 'deployment-activation-binding.json'),
      ),
    ),
  );
  if (binding.binding_hash !== hash)
    throw new Error('active_deployment_binding_path_invalid');
  return hash;
}

function journalDirectory(runtimeHome: string, activationId: string): string {
  return path.join(runtimeHome, 'deployment-journals', activationId);
}

export function assertG9DeploymentActivationJournalSequence(
  events: readonly G9DeploymentActivationJournalEvent[],
): void {
  if (events.length === 0) return;
  let index = 0;
  if (events[index]?.phase !== 'prepared')
    throw new Error('deployment_activation_journal_phase_order_invalid');
  index += 1;

  let preparedCount = 0;
  while (events[index]?.phase === 'participant_prepared') {
    if (events[index]?.participant !== PARTICIPANT_ORDER[preparedCount])
      throw new Error('deployment_activation_journal_phase_order_invalid');
    preparedCount += 1;
    index += 1;
  }
  if (index === events.length) return;

  if (
    events[index]?.phase === 'precommit_rolled_back' ||
    events[index]?.phase === 'precommit_rollback_completed'
  ) {
    let rollbackIndex = preparedCount - 1;
    while (events[index]?.phase === 'precommit_rolled_back') {
      if (events[index]?.participant !== PARTICIPANT_ORDER[rollbackIndex])
        throw new Error('deployment_activation_journal_phase_order_invalid');
      rollbackIndex -= 1;
      index += 1;
    }
    if (events[index]?.phase === 'precommit_rollback_completed') {
      if (rollbackIndex !== -1)
        throw new Error('deployment_activation_journal_phase_order_invalid');
      index += 1;
    }
    if (index !== events.length)
      throw new Error('deployment_activation_journal_phase_order_invalid');
    return;
  }

  if (
    events[index]?.phase !== 'active_deployment_committed' ||
    preparedCount !== PARTICIPANT_ORDER.length
  )
    throw new Error('deployment_activation_journal_phase_order_invalid');
  index += 1;

  let rollForwardCount = 0;
  while (events[index]?.phase === 'participant_rolled_forward') {
    if (events[index]?.participant !== PARTICIPANT_ORDER[rollForwardCount])
      throw new Error('deployment_activation_journal_phase_order_invalid');
    rollForwardCount += 1;
    index += 1;
  }
  if (events[index]?.phase === 'completed') {
    if (rollForwardCount !== PARTICIPANT_ORDER.length)
      throw new Error('deployment_activation_journal_phase_order_invalid');
    index += 1;
  }
  if (index !== events.length)
    throw new Error('deployment_activation_journal_phase_order_invalid');
}

export function readG9DeploymentActivationJournal(
  runtimeHomeInput: string,
  activationIdInput: string,
): readonly G9DeploymentActivationJournalEvent[] {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const activationId = assertSafeIdentity(activationIdInput, 'activation_id');
  const directory = journalDirectory(runtimeHome, activationId);
  const directoryStat = (() => {
    try {
      return fs.lstatSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  })();
  if (directoryStat === null) return [];
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error('deployment_activation_journal_directory_invalid');
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  if (
    entries.some(
      (entry) =>
        !entry.isFile() || !/^\d{6}-[0-9a-f]{64}\.json$/.test(entry.name),
    )
  )
    throw new Error('deployment_activation_journal_entry_invalid');
  const files = entries.map((entry) => entry.name).sort();
  const events = files.map((file) =>
    parseG9DeploymentJournalEvent(
      strictParseJsonBytes(fs.readFileSync(path.join(directory, file))),
    ),
  );
  events.forEach((event, index) => {
    const expectedSequence = index + 1;
    const expectedPrevious = index === 0 ? null : events[index - 1].event_hash;
    if (
      event.sequence !== expectedSequence ||
      event.previous_event_hash !== expectedPrevious ||
      event.activation_id !== activationId ||
      !files[index].startsWith(String(expectedSequence).padStart(6, '0')) ||
      !files[index].includes(event.event_hash.slice('sha256:'.length))
    )
      throw new Error('deployment_activation_journal_chain_invalid');
  });
  assertG9DeploymentActivationJournalSequence(events);
  return events;
}

function appendJournalEvent(
  runtimeHome: string,
  request: G9ProductionActivationRequest,
  events: readonly G9DeploymentActivationJournalEvent[],
  phase: G9DeploymentActivationJournalEvent['phase'],
  participant: G9DeploymentParticipant | null,
): G9DeploymentActivationJournalEvent {
  const event = buildG9DeploymentJournalEvent({
    activation_id: request.activation_id,
    sequence: events.length + 1,
    phase,
    participant,
    previous_event_hash: events.at(-1)?.event_hash ?? null,
    previous_binding_hash: request.audit.previous_deployment_binding_hash,
    target_binding_hash: request.deployment_binding.binding_hash,
    operation_key: request.operation_key,
    occurred_at_ms: request.requested_at_ms + events.length,
  });
  const file = path.join(
    journalDirectory(runtimeHome, request.activation_id),
    `${String(event.sequence).padStart(6, '0')}-${event.event_hash.slice('sha256:'.length)}.json`,
  );
  durableWriteExclusive(runtimeHome, file, event as unknown as JsonValue);
  return event;
}

function validateParticipants(
  participants: readonly G9ProductionActivationParticipant[],
): ReadonlyMap<
  Exclude<G9DeploymentParticipant, 'deployment_pointer'>,
  G9ProductionActivationParticipant
> {
  const map = new Map(
    participants.map((participant) => [participant.name, participant]),
  );
  if (
    map.size !== PARTICIPANT_ORDER.length ||
    PARTICIPANT_ORDER.some((participant) => !map.has(participant))
  )
    throw new Error('production_activation_participant_set_invalid');
  return map;
}

function persistActivationObjects(
  runtimeHome: string,
  request: G9ProductionActivationRequest,
): void {
  const bindingHash = request.deployment_binding.binding_hash.slice(
    'sha256:'.length,
  );
  const auditHash = request.audit.audit_hash.slice('sha256:'.length);
  durableWriteExclusive(
    runtimeHome,
    path.join(
      runtimeHome,
      'deployment-bindings',
      bindingHash,
      'deployment-activation-binding.json',
    ),
    request.deployment_binding as unknown as JsonValue,
  );
  durableWriteExclusive(
    runtimeHome,
    path.join(
      runtimeHome,
      'activation-audits',
      auditHash,
      'activation-audit.json',
    ),
    request.audit as unknown as JsonValue,
  );
}

function completedOutcome(
  disposition: G9ProductionActivationOutcome['disposition'],
  bindingHash: Sha256Hash,
  events: readonly G9DeploymentActivationJournalEvent[],
): G9ProductionActivationOutcome {
  assertG9DeploymentActivationJournalSequence(events);
  const head = events.at(-1);
  if (!head || head.phase !== 'completed')
    throw new Error('production_activation_completion_missing');
  return {
    disposition,
    binding_hash: bindingHash,
    journal_head_hash: head.event_hash,
  };
}

function assertJournalRequest(
  events: readonly G9DeploymentActivationJournalEvent[],
  request: G9ProductionActivationRequest,
): void {
  if (
    events.some(
      (event) =>
        event.target_binding_hash !== request.deployment_binding.binding_hash ||
        event.previous_binding_hash !==
          request.audit.previous_deployment_binding_hash ||
        event.operation_key !== request.operation_key ||
        event.occurred_at_ms !== request.requested_at_ms + event.sequence - 1,
    )
  )
    throw new Error('production_activation_journal_request_mismatch');
}

function terminalOutcome(
  bindingHash: Sha256Hash,
  events: readonly G9DeploymentActivationJournalEvent[],
): G9ProductionActivationOutcome | null {
  assertG9DeploymentActivationJournalSequence(events);
  const head = events.at(-1);
  if (head?.phase === 'precommit_rollback_completed')
    if (
      events.some((event) => event.phase === 'active_deployment_committed') ||
      events
        .filter((event) => event.phase === 'participant_prepared')
        .some(
          (prepared) =>
            !events.some(
              (event) =>
                event.phase === 'precommit_rolled_back' &&
                event.participant === prepared.participant,
            ),
        )
    )
      throw new Error('production_activation_rollback_completion_invalid');
    else
      return {
        disposition: 'recovered_precommit_rollback',
        binding_hash: bindingHash,
        journal_head_hash: head.event_hash,
      };
  if (head?.phase === 'completed') {
    if (
      !events.some((event) => event.phase === 'active_deployment_committed') ||
      PARTICIPANT_ORDER.some(
        (participant) =>
          !events.some(
            (event) =>
              event.phase === 'participant_rolled_forward' &&
              event.participant === participant,
          ),
      )
    )
      throw new Error('production_activation_completion_without_commit');
    return completedOutcome('exact_replay', bindingHash, events);
  }
  return null;
}

export function runG9ProductionActivation(
  runtimeHomeInput: string,
  requestValue: unknown,
  participantsInput: readonly G9ProductionActivationParticipant[],
): G9ProductionActivationOutcome {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const request = parseG9ProductionActivationRequest(requestValue);
  const participants = validateParticipants(participantsInput);
  persistActivationObjects(runtimeHome, request);
  let events = [
    ...readG9DeploymentActivationJournal(runtimeHome, request.activation_id),
  ];
  assertJournalRequest(events, request);
  const terminal = terminalOutcome(
    request.deployment_binding.binding_hash,
    events,
  );
  if (terminal) return terminal;
  if (events.length > 0)
    return recoverG9ProductionActivation(
      runtimeHome,
      request,
      participantsInput,
    );

  const previous = readDeploymentPointer(runtimeHome);
  if (previous !== request.audit.previous_deployment_binding_hash)
    throw new Error('production_activation_previous_binding_mismatch');
  events.push(
    appendJournalEvent(runtimeHome, request, events, 'prepared', null),
  );
  const prepared: G9ProductionActivationParticipant[] = [];
  try {
    for (const name of PARTICIPANT_ORDER) {
      const participant = participants.get(name)!;
      participant.prepare(request.deployment_binding);
      prepared.push(participant);
      events.push(
        appendJournalEvent(
          runtimeHome,
          request,
          events,
          'participant_prepared',
          name,
        ),
      );
    }
  } catch (error) {
    events.splice(
      0,
      events.length,
      ...readG9DeploymentActivationJournal(runtimeHome, request.activation_id),
    );
    for (const participant of prepared.reverse()) {
      participant.rollback(request.deployment_binding);
      if (
        events.some(
          (event) =>
            event.phase === 'participant_prepared' &&
            event.participant === participant.name,
        )
      )
        events.push(
          appendJournalEvent(
            runtimeHome,
            request,
            events,
            'precommit_rolled_back',
            participant.name,
          ),
        );
    }
    events.push(
      appendJournalEvent(
        runtimeHome,
        request,
        events,
        'precommit_rollback_completed',
        null,
      ),
    );
    throw error;
  }

  atomicRelativePointer(
    runtimeHome,
    'active-deployment',
    `deployment-bindings/${request.deployment_binding.binding_hash.slice('sha256:'.length)}`,
  );
  events.push(
    appendJournalEvent(
      runtimeHome,
      request,
      events,
      'active_deployment_committed',
      'deployment_pointer',
    ),
  );
  for (const name of PARTICIPANT_ORDER) {
    participants.get(name)!.rollForward(request.deployment_binding);
    events.push(
      appendJournalEvent(
        runtimeHome,
        request,
        events,
        'participant_rolled_forward',
        name,
      ),
    );
  }
  events.push(
    appendJournalEvent(runtimeHome, request, events, 'completed', null),
  );
  return completedOutcome(
    'activated',
    request.deployment_binding.binding_hash,
    events,
  );
}

export function recoverG9ProductionActivation(
  runtimeHomeInput: string,
  requestValue: unknown,
  participantsInput: readonly G9ProductionActivationParticipant[],
): G9ProductionActivationOutcome {
  const runtimeHome = fs.realpathSync(runtimeHomeInput);
  const request = parseG9ProductionActivationRequest(requestValue);
  const participants = validateParticipants(participantsInput);
  persistActivationObjects(runtimeHome, request);
  const events = [
    ...readG9DeploymentActivationJournal(runtimeHome, request.activation_id),
  ];
  assertJournalRequest(events, request);
  if (events.length === 0)
    throw new Error('production_activation_recovery_journal_missing');
  const terminal = terminalOutcome(
    request.deployment_binding.binding_hash,
    events,
  );
  if (terminal) return terminal;
  const activeBinding = readDeploymentPointer(runtimeHome);
  if (
    activeBinding !== request.deployment_binding.binding_hash &&
    activeBinding !== request.audit.previous_deployment_binding_hash
  )
    throw new Error('production_activation_recovery_binding_mismatch');
  const targetCommitted =
    activeBinding === request.deployment_binding.binding_hash;
  const prepared = new Set(
    events
      .filter((event) => event.phase === 'participant_prepared')
      .map((event) => event.participant),
  );
  const commitRecorded = events.some(
    (event) => event.phase === 'active_deployment_committed',
  );
  if (!targetCommitted) {
    if (commitRecorded)
      throw new Error('production_activation_recovery_commit_pointer_mismatch');
    for (const name of [...PARTICIPANT_ORDER].reverse()) {
      if (
        prepared.has(name) &&
        !events.some(
          (event) =>
            event.phase === 'precommit_rolled_back' &&
            event.participant === name,
        )
      ) {
        participants.get(name)!.rollback(request.deployment_binding);
        events.push(
          appendJournalEvent(
            runtimeHome,
            request,
            events,
            'precommit_rolled_back',
            name,
          ),
        );
      }
    }
    events.push(
      appendJournalEvent(
        runtimeHome,
        request,
        events,
        'precommit_rollback_completed',
        null,
      ),
    );
    return terminalOutcome(request.deployment_binding.binding_hash, events)!;
  }
  if (prepared.size !== PARTICIPANT_ORDER.length)
    throw new Error('production_activation_recovery_prepare_evidence_missing');
  if (!commitRecorded) {
    events.push(
      appendJournalEvent(
        runtimeHome,
        request,
        events,
        'active_deployment_committed',
        'deployment_pointer',
      ),
    );
    assertG9DeploymentActivationJournalSequence(events);
  }
  for (const name of PARTICIPANT_ORDER) {
    if (
      !events.some(
        (event) =>
          event.phase === 'participant_rolled_forward' &&
          event.participant === name,
      )
    ) {
      participants.get(name)!.rollForward(request.deployment_binding);
      events.push(
        appendJournalEvent(
          runtimeHome,
          request,
          events,
          'participant_rolled_forward',
          name,
        ),
      );
    }
  }
  events.push(
    appendJournalEvent(runtimeHome, request, events, 'completed', null),
  );
  return completedOutcome(
    'recovered_postcommit_roll_forward',
    request.deployment_binding.binding_hash,
    events,
  );
}

export function readG9ProductionActivationRequestFile(
  file: string,
): G9ProductionActivationRequest {
  return parseG9ProductionActivationRequest(
    strictParseJsonBytes(fs.readFileSync(file)),
  );
}
