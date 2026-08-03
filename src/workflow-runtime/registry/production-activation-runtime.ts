import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  prepareCapacityChangeCAP0CAP1,
  type CapacityAuthenticatedInvocation,
} from '../capacity/admin-gateway.js';
import {
  CapacitySnapshotPublisher,
  CapacitySnapshotWatcher,
} from '../capacity/publication.js';
import { readInstalledG9ProductionCandidateRelease } from '../certification/release-manifest.js';
import {
  buildDeploymentCapacityPublication,
  calculateCapacityAdminRequestHash,
  validateDeploymentCapacitySnapshot,
} from '../contracts/capacity-control-plane-source.js';
import type {
  DeploymentRuntimeCapacityPublication,
  DeploymentRuntimeCapacitySnapshot,
  InitializeDeploymentCapacityCommand,
} from '../contracts/capacity-control-plane-types.js';
import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from '../contracts/hash.js';
import {
  G9_PRODUCTION_RELEASE_MANIFEST_FILENAME,
  type G9DeploymentActivationBinding,
  type G9ProductionActivationRequest,
  type G9ProjectionGenerationBinding,
} from '../contracts/g9-production-activation-types.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { JsonValue, Sha256Hash } from '../contracts/types.js';
import {
  RuntimeStoreWorkflowProjectionRebuildAuthority,
  runtimeCenterProjectionGenerationId,
  type RuntimeCenterView,
} from '../projection/workflow-projection.js';
import { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import { stableRuntimeId } from '../runtime/graph-store.js';
import {
  calculateG9FeaturePointerAggregateHash,
  calculateG9ProjectionGenerationAggregateHash,
  type G9ProductionActivationParticipant,
} from './production-activation.js';

const VIEWS = [
  'workflows',
  'agent_executions',
  'pending',
  'trace',
] as const satisfies readonly RuntimeCenterView[];

function rawSha256(file: string): Sha256Hash {
  return parseSha256Hash(
    `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`,
  );
}

function lstatIfPresent(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureStateDirectory(runtimeHome: string, directory: string): void {
  const relative = path.relative(runtimeHome, directory);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    throw new Error('production_activation_state_path_invalid');
  let current = runtimeHome;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (stat === null) fs.mkdirSync(current, { mode: 0o700 });
    else if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('production_activation_state_directory_invalid');
  }
}

function writeContentAddressedJson(
  runtimeHome: string,
  file: string,
  value: JsonValue,
): void {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  ensureStateDirectory(runtimeHome, path.dirname(file));
  const existing = lstatIfPresent(file);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error(`production_activation_state_collision:${file}`);
    if (fs.readFileSync(file, 'utf8') !== bytes)
      throw new Error(`production_activation_state_collision:${file}`);
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
  runtimeHome: string,
  pointerName: string,
  relativeTarget: string,
): void {
  if (
    path.isAbsolute(relativeTarget) ||
    relativeTarget
      .split('/')
      .some((segment) => !segment || segment === '.' || segment === '..')
  )
    throw new Error('production_activation_pointer_target_invalid');
  const targetStat = lstatIfPresent(path.join(runtimeHome, relativeTarget));
  if (!targetStat?.isDirectory() || targetStat.isSymbolicLink())
    throw new Error('production_activation_pointer_target_missing');
  const pointer = path.join(runtimeHome, pointerName);
  const current = lstatIfPresent(pointer);
  if (current && !current.isSymbolicLink())
    throw new Error('production_activation_pointer_authority_invalid');
  const temporary = path.join(
    runtimeHome,
    `.${pointerName}.${process.pid}.tmp`,
  );
  fs.rmSync(temporary, { force: true });
  fs.symlinkSync(relativeTarget, temporary);
  fs.renameSync(temporary, pointer);
  fsyncDirectory(runtimeHome);
}

function assertCoreBindingPointer(
  runtimeHome: string,
  pointerName: 'activation-core' | 'active-core',
  bindingHash: Sha256Hash,
): void {
  const pointer = path.join(runtimeHome, pointerName);
  if (!fs.existsSync(pointer))
    throw new Error(`${pointerName}_pointer_missing`);
  const expected = `core-bindings/${bindingHash.slice('sha256:'.length)}`;
  if (fs.readlinkSync(pointer) !== expected)
    throw new Error(`${pointerName}_pointer_identity_invalid`);
  const bindingFile = path.join(runtimeHome, expected, 'binding.json');
  const value = strictParseJsonBytes(fs.readFileSync(bindingFile));
  assertJsonObject(value);
  if (value.binding_hash !== bindingHash)
    throw new Error(`${pointerName}_binding_identity_invalid`);
}

function assertProductionReleaseAuthority(
  runtimeHome: string,
  releaseRoot: string,
  store: WorkflowRuntimeStore,
  binding: G9DeploymentActivationBinding,
): void {
  const manifest = readInstalledG9ProductionCandidateRelease(
    runtimeHome,
    binding.release_artifact_hash,
  );
  const identity = store.identityEvidence;
  if (
    identity.identity_mode !== 'production_activation' ||
    identity.validation_status !== 'production_activation' ||
    identity.release_identity_status !== 'observed_for_activation' ||
    identity.core_binding_kind !== 'content_addressed_production_release' ||
    identity.core_binding_hash !== binding.core_binding_hash ||
    identity.core_build_hash !== binding.core_build_hash ||
    identity.release_manifest_hash !== binding.release_manifest_hash ||
    identity.release_artifact_profile_hash !== binding.release_artifact_hash ||
    rawSha256(
      path.join(releaseRoot, G9_PRODUCTION_RELEASE_MANIFEST_FILENAME),
    ) !== binding.release_manifest_hash ||
    manifest.core_build_hash !== binding.core_build_hash ||
    manifest.static_source_core_build_hash !==
      binding.static_authority.source_core_build_hash ||
    manifest.workflow_runtime_absence_baseline_hash !==
      binding.static_authority.absence_baseline_hash ||
    manifest.product_surface_coverage_manifest_hash !==
      binding.static_authority.product_surface_manifest_hash ||
    manifest.migration_candidate_boundary_manifest_hash !==
      binding.static_authority.migration_candidate_boundary_hash
  )
    throw new Error('production_release_activation_authority_drift');
}

function observeFeaturePointers(store: WorkflowRuntimeStore) {
  return store
    .queryAll<{
      feature_id: string;
      release_id: string;
      release_hash: Sha256Hash;
    }>(
      `SELECT feature_id, release_id, release_hash
         FROM workflow_feature_active_releases
        ORDER BY feature_id COLLATE BINARY`,
      [],
    )
    .map((row) => ({ ...row }));
}

function assertFeaturePointers(
  store: WorkflowRuntimeStore,
  binding: G9DeploymentActivationBinding,
): void {
  const observed = observeFeaturePointers(store);
  if (
    canonicalJson(observed as unknown as JsonValue) !==
      canonicalJson(
        binding.feature_registry_pointer.pointers as unknown as JsonValue,
      ) ||
    calculateG9FeaturePointerAggregateHash(observed) !==
      binding.feature_registry_pointer.pointer_aggregate_hash
  )
    throw new Error('production_feature_registry_pointer_drift');
}

function observeProjectionGenerations(
  store: WorkflowRuntimeStore,
  binding: G9DeploymentActivationBinding,
): G9ProjectionGenerationBinding[] {
  const authority = new RuntimeStoreWorkflowProjectionRebuildAuthority(
    store,
    `deployment:${binding.binding_hash}`,
  );
  return VIEWS.map((view) => {
    const exported = authority.export(view);
    return {
      view,
      generation_id: runtimeCenterProjectionGenerationId(
        view,
        exported.sourceHeadSeq,
        exported.rowsHash,
      ),
      source_head_seq: exported.sourceHeadSeq,
      rows_hash: exported.rowsHash,
    };
  });
}

function assertProjectionGenerations(
  store: WorkflowRuntimeStore,
  binding: G9DeploymentActivationBinding,
): G9ProjectionGenerationBinding[] {
  const observed = observeProjectionGenerations(store, binding);
  if (
    canonicalJson(observed as unknown as JsonValue) !==
      canonicalJson(
        binding.runtime_center_projection.generations as unknown as JsonValue,
      ) ||
    calculateG9ProjectionGenerationAggregateHash(observed) !==
      binding.runtime_center_projection.generation_aggregate_hash
  )
    throw new Error('production_projection_generation_drift');
  return observed;
}

interface CapacityHeadRow extends Record<string, unknown> {
  current_capacity_revision: number | null;
  current_change_id: string | null;
  current_config_hash: Sha256Hash | null;
  current_publication_hash: Sha256Hash | null;
  pending_change_id: string | null;
}

interface FreshCapacityCommandRow extends Record<string, unknown> {
  command_type: string;
  idempotency_key: string;
  request_hash: Sha256Hash;
  assigned_capacity_revision: number | null;
  assigned_change_id: string | null;
  genesis_core_release_hash: Sha256Hash | null;
  proposed_capacity_json: string;
  proposed_config_hash: Sha256Hash;
  evidence_manifest_value_id: string;
  evidence_manifest_hash: Sha256Hash;
  canonical_result_value_id: string | null;
  canonical_result_hash: Sha256Hash | null;
  finalized_at_ms: number | null;
}

interface FreshCapacityResultRow extends Record<string, unknown> {
  inline_canonical_json: string | null;
  content_hash: Sha256Hash;
  schema_resource_id: string | null;
  schema_resource_hash: Sha256Hash | null;
  provenance_ref: string;
  retention_class: string;
  payload_state: string;
  created_at_ms: number;
}

function capacityHead(
  store: WorkflowRuntimeStore,
): CapacityHeadRow | undefined {
  return store.queryOne<CapacityHeadRow>(
    `SELECT current_capacity_revision, current_change_id,
            current_config_hash, current_publication_hash, pending_change_id
       FROM runtime_capacity_head WHERE singleton_key = 1`,
    [],
  );
}

function capacityAuditHead(store: WorkflowRuntimeStore): Sha256Hash | null {
  return (
    store.queryOne<{ event_hash: Sha256Hash }>(
      'SELECT event_hash FROM runtime_capacity_change_events ORDER BY event_seq DESC LIMIT 1',
      [],
    )?.event_hash ?? null
  );
}

function readCapacityBaseline(
  releaseRoot: string,
): DeploymentRuntimeCapacitySnapshot {
  const value = strictParseJsonBytes(
    fs.readFileSync(
      path.join(releaseRoot, 'config/workflow-runtime-capacity.json'),
    ),
  );
  assertJsonObject(value);
  const baseline = value as unknown as DeploymentRuntimeCapacitySnapshot;
  // Core prepare already verifies every installed release file against the
  // content-addressed inventory. Capacity owns strict semantic/config identity,
  // not an additional JSON whitespace convention.
  if (validateDeploymentCapacitySnapshot(baseline) !== null)
    throw new Error('production_capacity_baseline_invalid');
  return baseline;
}

function assertExistingCapacity(
  store: WorkflowRuntimeStore,
  capacityFile: string,
  binding: G9DeploymentActivationBinding,
): void {
  const expected = binding.capacity_authority;
  if (expected.mode !== 'existing_preserved')
    throw new Error('existing_capacity_mode_required');
  const head = capacityHead(store);
  if (
    !head ||
    head.pending_change_id !== null ||
    head.current_capacity_revision !== expected.capacity_revision ||
    head.current_change_id !== expected.change_id ||
    head.current_config_hash !== expected.config_hash ||
    head.current_publication_hash !== expected.publication_hash ||
    capacityAuditHead(store) !== expected.audit_head_hash ||
    !lstatIfPresent(capacityFile)?.isFile() ||
    rawSha256(capacityFile) !== expected.publication_file_raw_hash
  )
    throw new Error('existing_capacity_authority_drift');
}

function freshCapacityCommand(
  binding: G9DeploymentActivationBinding,
  baseline: DeploymentRuntimeCapacitySnapshot,
): InitializeDeploymentCapacityCommand {
  const capacity = binding.capacity_authority;
  if (capacity.mode !== 'fresh_genesis')
    throw new Error('fresh_capacity_mode_required');
  return {
    command_type: 'initialize_deployment_capacity',
    command_id: capacity.genesis_command_id,
    idempotency_key: capacity.genesis_idempotency_key,
    proposed_capacity: baseline,
    reason_code: 'initial_provisioning',
    core_release_hash: binding.release_artifact_hash,
    evidence_refs: [
      `core-release:${binding.release_artifact_hash}`,
      `capacity-baseline:${capacity.baseline_config_hash}`,
    ],
  };
}

function freshCapacityInvocation(
  request: G9ProductionActivationRequest,
): CapacityAuthenticatedInvocation {
  const capacity = request.deployment_binding.capacity_authority;
  if (capacity.mode !== 'fresh_genesis')
    throw new Error('fresh_capacity_mode_required');
  return {
    authenticated: true,
    actorRef: 'system:production-activation',
    sessionActorRef: 'system:production-activation',
    actorKind: 'system',
    authSessionRef: capacity.genesis_auth_session_ref,
    entrypoint: 'production_activation',
    delegationChainRef: null,
    permissions: [],
    requestedAtMs: request.requested_at_ms,
    activeCoreReleaseHash: request.deployment_binding.release_artifact_hash,
    baselineConfigHash: capacity.baseline_config_hash,
    genesisGrant: {
      coreReleaseHash: request.deployment_binding.release_artifact_hash,
      baselineConfigHash: capacity.baseline_config_hash,
    },
  };
}

function freshCapacityTerminalIsExact(
  store: WorkflowRuntimeStore,
  capacityFile: string,
  baseline: DeploymentRuntimeCapacitySnapshot,
  request: G9ProductionActivationRequest,
  requestHash: Sha256Hash,
  expected: {
    readonly changeId: string;
    readonly publicationHash: Sha256Hash;
    readonly auditHeadHash: Sha256Hash;
    readonly publication: DeploymentRuntimeCapacityPublication;
    readonly resultId: string;
    readonly resultHash: Sha256Hash;
  },
): boolean {
  const capacity = request.deployment_binding.capacity_authority;
  if (capacity.mode !== 'fresh_genesis')
    throw new Error('fresh_capacity_mode_required');
  const head = capacityHead(store);
  const command = store.queryOne<FreshCapacityCommandRow>(
    `SELECT command_type, idempotency_key, request_hash,
            assigned_capacity_revision, assigned_change_id,
            genesis_core_release_hash, proposed_capacity_json,
            proposed_config_hash, evidence_manifest_value_id,
            evidence_manifest_hash, canonical_result_value_id,
            canonical_result_hash, finalized_at_ms
       FROM runtime_capacity_admin_commands WHERE command_id = ?`,
    [capacity.genesis_command_id],
  );
  if (!command) {
    if (
      head?.current_capacity_revision !== null &&
      head?.current_capacity_revision !== undefined
    )
      throw new Error('fresh_capacity_existing_authority_drift');
    if (
      capacityAuditHead(store) !== null ||
      lstatIfPresent(capacityFile) !== null
    )
      throw new Error('fresh_capacity_terminal_authority_drift');
    return false;
  }
  if (
    head?.current_capacity_revision !== null &&
    head?.current_capacity_revision !== undefined &&
    (head.pending_change_id !== null ||
      head.current_capacity_revision !== 1 ||
      head.current_change_id !== capacity.expected_change_id ||
      head.current_config_hash !== capacity.baseline_config_hash ||
      head.current_publication_hash !== capacity.expected_publication_hash)
  )
    throw new Error('fresh_capacity_existing_authority_drift');
  if (command.finalized_at_ms === null) return false;

  const result = store.queryOne<FreshCapacityResultRow>(
    `SELECT inline_canonical_json, content_hash, schema_resource_id,
            schema_resource_hash, provenance_ref, retention_class,
            payload_state, created_at_ms
       FROM workflow_values WHERE id = ?`,
    [expected.resultId],
  );
  const resultPayload = {
    format: 'icarus.capacity-admin-result/1',
    command_id: capacity.genesis_command_id,
    disposition: 'applied',
    capacity_revision: 1,
    capacity_change_id: capacity.expected_change_id,
    config_hash: capacity.baseline_config_hash,
    publication_hash: capacity.expected_publication_hash,
  } as const;
  const publicationBytes = `${canonicalJson(expected.publication as unknown as JsonValue)}\n`;
  if (
    !head ||
    head.pending_change_id !== null ||
    head.current_capacity_revision !== 1 ||
    head.current_change_id !== capacity.expected_change_id ||
    head.current_config_hash !== capacity.baseline_config_hash ||
    head.current_publication_hash !== capacity.expected_publication_hash ||
    capacityAuditHead(store) !== capacity.expected_audit_head_hash ||
    command.command_type !== 'initialize_deployment_capacity' ||
    command.idempotency_key !== capacity.genesis_idempotency_key ||
    command.request_hash !== requestHash ||
    command.assigned_capacity_revision !== 1 ||
    command.assigned_change_id !== capacity.expected_change_id ||
    command.genesis_core_release_hash !==
      request.deployment_binding.release_artifact_hash ||
    command.proposed_capacity_json !== canonicalJson(baseline) ||
    command.proposed_config_hash !== capacity.baseline_config_hash ||
    command.evidence_manifest_value_id !==
      capacity.genesis_evidence_manifest_id ||
    command.evidence_manifest_hash !==
      capacity.genesis_evidence_manifest_hash ||
    command.canonical_result_value_id !== expected.resultId ||
    command.canonical_result_hash !== expected.resultHash ||
    command.finalized_at_ms !== request.requested_at_ms + 103 ||
    !result ||
    result.inline_canonical_json !== canonicalJson(resultPayload) ||
    result.content_hash !== expected.resultHash ||
    result.schema_resource_id !== capacity.genesis_result_schema_row_id ||
    result.schema_resource_hash !== capacity.genesis_result_schema_hash ||
    result.provenance_ref !== 'icarus.workflow-capacity-admin/1' ||
    result.retention_class !== 'workflow_audit' ||
    result.payload_state !== 'live' ||
    result.created_at_ms !== request.requested_at_ms + 103 ||
    !lstatIfPresent(capacityFile)?.isFile() ||
    fs.readFileSync(capacityFile, 'utf8') !== publicationBytes
  )
    throw new Error('fresh_capacity_terminal_authority_drift');
  return true;
}

function applyFreshCapacity(
  store: WorkflowRuntimeStore,
  capacityFile: string,
  releaseRoot: string,
  request: G9ProductionActivationRequest,
): void {
  const binding = request.deployment_binding;
  const capacity = binding.capacity_authority;
  if (capacity.mode !== 'fresh_genesis')
    throw new Error('fresh_capacity_mode_required');
  const baseline = readCapacityBaseline(releaseRoot);
  if (baseline.config_hash !== capacity.baseline_config_hash)
    throw new Error('fresh_capacity_baseline_hash_drift');
  const command = freshCapacityCommand(binding, baseline);
  const requestHash = calculateCapacityAdminRequestHash(command);
  const expected = expectedFreshCapacityGenesisIdentity({
    commandId: command.command_id,
    requestHash,
    baseline,
    requestedAtMs: request.requested_at_ms,
  });
  if (
    expected.changeId !== capacity.expected_change_id ||
    expected.publicationHash !== capacity.expected_publication_hash ||
    expected.auditHeadHash !== capacity.expected_audit_head_hash
  )
    throw new Error('fresh_capacity_expected_identity_drift');
  if (
    freshCapacityTerminalIsExact(
      store,
      capacityFile,
      baseline,
      request,
      requestHash,
      expected,
    )
  )
    return;
  const prepared = prepareCapacityChangeCAP0CAP1(
    store,
    command,
    freshCapacityInvocation(request),
    {
      evidenceManifest: {
        id: capacity.genesis_evidence_manifest_id,
        hash: capacity.genesis_evidence_manifest_hash,
      },
      reasonText: null,
      resultSchema: {
        rowId: capacity.genesis_result_schema_row_id,
        resourceType: capacity.genesis_result_schema_resource_type,
        ref: capacity.genesis_result_schema_ref,
        hash: capacity.genesis_result_schema_hash,
      },
    },
    request.requested_at_ms + 100,
  );
  if (
    (prepared.disposition !== 'prepared' &&
      prepared.disposition !== 'pending_recovery') ||
    !prepared.publication ||
    prepared.capacityRevision !== 1 ||
    prepared.changeId !== capacity.expected_change_id ||
    prepared.requestHash !== requestHash ||
    prepared.publication.publication_hash !== capacity.expected_publication_hash
  )
    throw new Error('fresh_capacity_prepare_identity_drift');
  const publisher = new CapacitySnapshotPublisher(capacityFile);
  publisher.installCAP2(
    store,
    prepared.publication,
    request.requested_at_ms + 101,
  );
  publisher.commitHeadCAP3(
    store,
    prepared.publication,
    request.requested_at_ms + 102,
  );
  new CapacitySnapshotWatcher().publishCAP4(
    store,
    publisher,
    {
      rowId: capacity.genesis_result_schema_row_id,
      resourceType: capacity.genesis_result_schema_resource_type,
      ref: capacity.genesis_result_schema_ref,
      hash: capacity.genesis_result_schema_hash,
    },
    request.requested_at_ms + 103,
  );
  if (
    !freshCapacityTerminalIsExact(
      store,
      capacityFile,
      baseline,
      request,
      requestHash,
      expected,
    )
  )
    throw new Error('fresh_capacity_roll_forward_identity_drift');
}

export function expectedFreshCapacityGenesisIdentity(input: {
  readonly commandId: string;
  readonly requestHash: Sha256Hash;
  readonly baseline: DeploymentRuntimeCapacitySnapshot;
  readonly requestedAtMs: number;
}): {
  changeId: string;
  publicationHash: Sha256Hash;
  auditHeadHash: Sha256Hash;
  publication: DeploymentRuntimeCapacityPublication;
  resultId: string;
  resultHash: Sha256Hash;
} {
  const changeId = stableRuntimeId('capacity-change', {
    command_id: input.commandId,
    capacity_revision: 1,
    request_hash: input.requestHash,
  });
  const publication = buildDeploymentCapacityPublication(
    1,
    changeId,
    null,
    input.baseline,
  );
  let previousEventHash: Sha256Hash | null = null;
  const eventTypes = [
    'prepared',
    'file_installed',
    'head_committed',
    'watcher_published',
  ] as const;
  eventTypes.forEach((eventType, index) => {
    previousEventHash = domainSeparatedSha256(
      'icarus:runtime-capacity-change-event:1\n',
      {
        event_seq: index + 1,
        change_id: changeId,
        command_id: input.commandId,
        capacity_revision: 1,
        event_type: eventType,
        config_hash: input.baseline.config_hash,
        publication_hash: publication.publication_hash,
        previous_event_hash: previousEventHash,
        detail_value_id: null,
        detail_hash: null,
        created_at_ms: input.requestedAtMs + 100 + index,
      },
    );
  });
  const resultHash = domainSeparatedSha256('icarus:capacity-admin-result:1\n', {
    format: 'icarus.capacity-admin-result/1',
    command_id: input.commandId,
    disposition: 'applied',
    capacity_revision: 1,
    capacity_change_id: changeId,
    config_hash: input.baseline.config_hash,
    publication_hash: publication.publication_hash,
  });
  return {
    changeId,
    publicationHash: publication.publication_hash,
    auditHeadHash: previousEventHash!,
    publication,
    resultId: stableRuntimeId('capacity-result', {
      command_id: input.commandId,
      result_hash: resultHash,
    }),
    resultHash,
  };
}

export function createG9ProductionActivationParticipants(input: {
  readonly runtimeHome: string;
  readonly releaseRoot: string;
  readonly store: WorkflowRuntimeStore;
  readonly request: G9ProductionActivationRequest;
}): readonly G9ProductionActivationParticipant[] {
  const runtimeHome = fs.realpathSync(input.runtimeHome);
  const releaseRoot = fs.realpathSync(input.releaseRoot);
  const binding = input.request.deployment_binding;
  const capacityFile = path.join(
    runtimeHome,
    'data/workflow-runtime/workflow-runtime-capacity.json',
  );
  return [
    {
      name: 'core_binding',
      prepare: () => {
        assertCoreBindingPointer(
          runtimeHome,
          'activation-core',
          binding.core_binding_hash,
        );
        assertProductionReleaseAuthority(
          runtimeHome,
          releaseRoot,
          input.store,
          binding,
        );
      },
      rollback: () => undefined,
      rollForward: () => {
        atomicRelativePointer(
          runtimeHome,
          'active-core',
          `core-bindings/${binding.core_binding_hash.slice('sha256:'.length)}`,
        );
        assertCoreBindingPointer(
          runtimeHome,
          'active-core',
          binding.core_binding_hash,
        );
      },
    },
    {
      name: 'feature_registry',
      prepare: () => assertFeaturePointers(input.store, binding),
      rollback: () => undefined,
      rollForward: () => assertFeaturePointers(input.store, binding),
    },
    {
      name: 'runtime_center_projection',
      prepare: () => void assertProjectionGenerations(input.store, binding),
      rollback: () => undefined,
      rollForward: () => {
        const generations = assertProjectionGenerations(input.store, binding);
        const generationHash =
          binding.runtime_center_projection.generation_aggregate_hash;
        writeContentAddressedJson(
          runtimeHome,
          path.join(
            runtimeHome,
            'runtime-center-projections',
            generationHash.slice('sha256:'.length),
            'projection-generation.json',
          ),
          {
            format: 'icarus.runtime-center-projection-generation/1',
            deployment_binding_hash: binding.binding_hash,
            projection_version: 'g7.1',
            generations,
            generation_aggregate_hash: generationHash,
          } as unknown as JsonValue,
        );
        atomicRelativePointer(
          runtimeHome,
          'active-runtime-center-projection',
          `runtime-center-projections/${generationHash.slice('sha256:'.length)}`,
        );
      },
    },
    {
      name: 'capacity',
      prepare: () => {
        if (binding.capacity_authority.mode === 'fresh_genesis') {
          if (
            capacityHead(input.store) !== undefined ||
            capacityAuditHead(input.store) !== null ||
            lstatIfPresent(capacityFile) !== null ||
            readCapacityBaseline(releaseRoot).config_hash !==
              binding.capacity_authority.baseline_config_hash
          )
            throw new Error('fresh_capacity_precondition_drift');
        } else assertExistingCapacity(input.store, capacityFile, binding);
      },
      rollback: () => undefined,
      rollForward: () => {
        if (binding.capacity_authority.mode === 'fresh_genesis')
          applyFreshCapacity(
            input.store,
            capacityFile,
            releaseRoot,
            input.request,
          );
        else assertExistingCapacity(input.store, capacityFile, binding);
      },
    },
  ];
}
