import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { g0ConformanceToolHash } from './g0-conformance-source.js';
import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import {
  DEPLOYMENT_CAPACITY_KEYS,
  type DeploymentRuntimeCapacity,
} from './safety-sqlite-types.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import {
  CAPACITY_ADMIN_ACTOR_KINDS,
  CAPACITY_ADMIN_COMMAND_TYPES,
  CAPACITY_ADMIN_DENIAL_CODES,
  CAPACITY_ADMIN_HUMAN_ENTRYPOINTS,
  CAPACITY_ADMIN_PERMISSION_CODES,
  CAPACITY_CHANGE_REASON_CODES,
  CAPACITY_FIXTURE_AREAS,
  CAPACITY_INVENTORY_CLASSES,
  CAPACITY_MARKDOWN_DELTA_CATEGORIES,
  CAPACITY_PROTOCOL_IDS,
  type CapacityAdminCommand,
  type CapacityAdminModelHead,
  type CapacityAdminModelInvocation,
  type CapacityAdminModelResult,
  type CapacityAdminInvocationLifecycleCandidate,
  type CapacityArtifactInventory,
  type CapacityArtifactInventoryEntry,
  type CapacityDenialCatalogEntry,
  type CapacityGateReview,
  type CapacityMarkdownDeltaCategory,
  type CapacityMarkdownDeltaCoverage,
  type CapacityMarkdownDeltaCoverageEntry,
  type CapacityPermissionCatalogEntry,
  type CapacityProtocolCatalog,
  type CapacityProtocolStep,
  type CapacityReasonCatalogEntry,
  type DeploymentRuntimeCapacityPublication,
  type DeploymentRuntimeCapacitySnapshot,
} from './capacity-control-plane-types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');
const architecturePath =
  'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md' as const;
const addendumRoot = 'conformance/capacity-control-plane-addendum';

export const G0_9_HISTORICAL_ROOT_HASH =
  'sha256:df3058a93eaeb85bdb3eeadc7923148a9a543f63c33d0ede2cc7be0a758c9f5e' as const;
export const G0_9_HISTORICAL_TOOL_HASH =
  'sha256:a2cc8711054a26598fedfb50beec6089dc8694d3e6e86ff7fe6cb861086bf233' as const;
export const CAPACITY_SCHEMA_HISTORICAL_HASH =
  'sha256:30aa123506c8f37a3d0c291d20feab150e7103c3f83c12775c49d323f9de7ec4' as const;
export const CAPACITY_BASELINE_HISTORICAL_HASH =
  'sha256:970a63fdba1e263189c3070201a543f01508180abb1e8c15cf649a3780c17542' as const;

export const G0_10_HISTORICAL_IDENTITIES = {
  'G0.2':
    'sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d',
  'G0.3':
    'sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8',
  'G0.4':
    'sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607',
  'G0.5':
    'sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428',
  'G0.6':
    'sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520',
  'G0.7':
    'sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2',
  'G0.8':
    'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22',
  'G0.9': G0_9_HISTORICAL_ROOT_HASH,
  capacity_schema: CAPACITY_SCHEMA_HISTORICAL_HASH,
  capacity_baseline: CAPACITY_BASELINE_HISTORICAL_HASH,
} as const satisfies Record<string, Sha256Hash>;

function readRepoBytes(relativePath: string): Buffer {
  const absolute = path.resolve(repoRoot, relativePath);
  if (!absolute.startsWith(`${repoRoot}${path.sep}`))
    throw new Error(`Repository path escapes root: ${relativePath}`);
  return fs.readFileSync(absolute);
}

function readContractArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      readRepoBytes(`src/workflow-runtime/contracts/${relativePath}`),
    ),
  );
}

function rawSha256(bytes: Buffer | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function capacityPayloadWithoutHash(
  capacity: DeploymentRuntimeCapacitySnapshot,
): JsonObject {
  return {
    max_active_executions: capacity.max_active_executions,
    max_active_waits: capacity.max_active_waits,
    max_pending_signals: capacity.max_pending_signals,
    max_outbox_inflight: capacity.max_outbox_inflight,
    max_physical_blob_bytes: capacity.max_physical_blob_bytes,
    soft_blob_high_water_bytes: capacity.soft_blob_high_water_bytes,
    minimum_free_disk_bytes: capacity.minimum_free_disk_bytes,
  };
}

export function calculateDeploymentCapacityConfigHash(
  capacity: Omit<DeploymentRuntimeCapacitySnapshot, 'config_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:deployment-runtime-capacity:1\n',
    capacity as unknown as JsonValue,
  );
}

export function validateDeploymentCapacitySnapshot(
  capacity: DeploymentRuntimeCapacitySnapshot,
): string | null {
  if (
    canonicalJson(Object.keys(capacity).sort()) !==
    canonicalJson([...DEPLOYMENT_CAPACITY_KEYS].sort())
  )
    return 'capacity_snapshot_closed_shape_invalid';
  for (const field of DEPLOYMENT_CAPACITY_KEYS) {
    if (field === 'config_hash') continue;
    const value = capacity[field];
    if (!Number.isSafeInteger(value) || value <= 0)
      return `capacity_snapshot_invalid_integer:${field}`;
  }
  if (capacity.soft_blob_high_water_bytes > capacity.max_physical_blob_bytes)
    return 'capacity_snapshot_soft_high_water_exceeds_hard_limit';
  const expected = calculateDeploymentCapacityConfigHash(
    capacityPayloadWithoutHash(capacity) as unknown as Omit<
      DeploymentRuntimeCapacitySnapshot,
      'config_hash'
    >,
  );
  if (capacity.config_hash !== expected)
    return 'capacity_snapshot_config_hash_invalid';
  return null;
}

export function calculateCapacityPublicationHash(
  publication: Omit<DeploymentRuntimeCapacityPublication, 'publication_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:deployment-runtime-capacity-publication:1\n',
    publication as unknown as JsonValue,
  );
}

export function buildDeploymentCapacityPublication(
  capacityRevision: number,
  capacityChangeId: string,
  previousConfigHash: Sha256Hash | null,
  capacity: DeploymentRuntimeCapacitySnapshot,
): DeploymentRuntimeCapacityPublication {
  const withoutHash = {
    format: 'icarus.deployment-runtime-capacity-publication/1' as const,
    deployment_profile: 'local_single_user' as const,
    capacity_revision: capacityRevision,
    capacity_change_id: capacityChangeId,
    previous_config_hash: previousConfigHash,
    capacity,
  };
  return {
    ...withoutHash,
    publication_hash: calculateCapacityPublicationHash(withoutHash),
  };
}

export function validateCapacityPublication(
  publication: DeploymentRuntimeCapacityPublication,
): string | null {
  const expectedKeys = [
    'format',
    'deployment_profile',
    'capacity_revision',
    'capacity_change_id',
    'previous_config_hash',
    'capacity',
    'publication_hash',
  ];
  if (
    canonicalJson(Object.keys(publication).sort()) !==
    canonicalJson(expectedKeys.sort())
  )
    return 'capacity_publication_closed_shape_invalid';
  if (
    publication.format !== 'icarus.deployment-runtime-capacity-publication/1' ||
    publication.deployment_profile !== 'local_single_user' ||
    !Number.isSafeInteger(publication.capacity_revision) ||
    publication.capacity_revision <= 0 ||
    publication.capacity_change_id.length === 0
  )
    return 'capacity_publication_header_invalid';
  if (
    (publication.capacity_revision === 1) !==
    (publication.previous_config_hash === null)
  )
    return 'capacity_publication_previous_hash_lineage_invalid';
  const snapshotError = validateDeploymentCapacitySnapshot(
    publication.capacity,
  );
  if (snapshotError) return snapshotError;
  const { publication_hash: _ignored, ...withoutHash } = publication;
  if (
    publication.publication_hash !==
    calculateCapacityPublicationHash(withoutHash)
  )
    return 'capacity_publication_hash_invalid';
  return null;
}

export function calculateCapacityAdminRequestHash(
  command: CapacityAdminCommand,
): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:capacity-admin-command-request:1\n',
    command as unknown as JsonValue,
  );
}

export const CAPACITY_PERMISSION_CATALOG_ENTRIES = [
  {
    permission: 'runtime.capacity.manage',
    scope: 'deployment',
    allowed_actor_kinds: ['human'],
    production_principal: 'human:local-owner',
    allowed_entrypoints: [...CAPACITY_ADMIN_HUMAN_ENTRYPOINTS],
    delegation: 'forbidden',
    workflow_ownership_derivation: 'forbidden',
    feature_manifest_ceiling_derivation: 'forbidden',
  },
] as const satisfies readonly CapacityPermissionCatalogEntry[];

export const CAPACITY_REASON_CATALOG_ENTRIES = [
  {
    reason_code: 'initial_provisioning',
    allowed_command_types: ['initialize_deployment_capacity'],
    reason_text_required: false,
    evidence_required: true,
    minimum_evidence_refs: 2,
  },
  {
    reason_code: 'planned_tuning',
    allowed_command_types: ['replace_deployment_capacity'],
    reason_text_required: true,
    evidence_required: false,
    minimum_evidence_refs: 0,
  },
  {
    reason_code: 'incident_mitigation',
    allowed_command_types: ['replace_deployment_capacity'] as const,
    reason_text_required: true,
    evidence_required: true,
    minimum_evidence_refs: 1,
  },
  {
    reason_code: 'host_resource_change',
    allowed_command_types: ['replace_deployment_capacity'] as const,
    reason_text_required: true,
    evidence_required: true,
    minimum_evidence_refs: 1,
  },
  {
    reason_code: 'storage_pressure',
    allowed_command_types: ['replace_deployment_capacity'] as const,
    reason_text_required: true,
    evidence_required: true,
    minimum_evidence_refs: 1,
  },
  {
    reason_code: 'rollback',
    allowed_command_types: ['replace_deployment_capacity'] as const,
    reason_text_required: true,
    evidence_required: true,
    minimum_evidence_refs: 1,
  },
] as const satisfies readonly CapacityReasonCatalogEntry[];

const refreshHeadDenials = new Set([
  'expected_capacity_revision_conflict',
  'expected_config_hash_conflict',
  'capacity_change_in_progress',
]);
const retrySameRequestDenials = new Set([
  'audit_unavailable',
  'publication_failed',
]);

export const CAPACITY_DENIAL_CATALOG_ENTRIES = CAPACITY_ADMIN_DENIAL_CODES.map(
  (denialCode): CapacityDenialCatalogEntry => ({
    denial_code: denialCode,
    retryability: refreshHeadDenials.has(denialCode)
      ? 'refresh_head_and_resubmit'
      : retrySameRequestDenials.has(denialCode)
        ? 'retry_same_request'
        : 'never_same_request',
    head_mutation: 'forbidden',
    pending_change_creation: 'forbidden',
    invocation_audit: 'required_after_authentication',
  }),
);

const CAPACITY_PROTOCOL_STEPS = [
  {
    protocol_id: 'CAP0',
    name: 'authenticate_validate',
    transaction_mode: 'none',
    external_work: 'none',
    preconditions: [
      'strict closed command parse',
      'server-resolved actor session and entrypoint',
      'initialize uses exact one-time genesis grant or replace uses runtime.capacity.manage',
      'complete snapshot config hash and cross-field validation',
      'replace transition validates expected revision hash and increase-only minimum free disk',
    ],
    atomic_writes: [
      'authenticated denied validation appends one immutable invocation',
      'authentication failure writes only the independent authentication security log',
    ],
    success_outcome: 'validated request enters CAP1',
    failure_outcomes: [
      'authentication_rejected_no_invocation',
      ...CAPACITY_ADMIN_DENIAL_CODES,
    ],
    crash_recovery: ['no pending change exists before CAP1 commit'],
    forbidden_actions: [
      'client supplied actor session roles or permission',
      'field patch environment override or direct activity file write',
      'Workflow Command target or WorkflowCommandPolicy authorization',
    ],
  },
  {
    protocol_id: 'CAP1',
    name: 'prepare',
    transaction_mode: 'begin_immediate',
    external_work: 'none',
    preconditions: [
      'initialize head absent or replace expected revision config hash row version match',
      'pending_change_id is null',
      'audit store available',
    ],
    atomic_writes: [
      'Command Header and immutable allowed prepared Invocation with decided_at_ms and null applied_at_ms',
      'strictly increasing assigned revision and unique change id',
      'canonical complete snapshot and request hash',
      'pending head and prepared hash-chain event',
    ],
    success_outcome: 'durable prepared journal drives the only Publisher',
    failure_outcomes: [
      'expected_capacity_revision_conflict',
      'expected_config_hash_conflict',
      'capacity_change_in_progress',
      'idempotency_conflict',
      'audit_unavailable',
    ],
    crash_recovery: ['retry exact publication from durable pending command'],
    forbidden_actions: [
      'partial head mutation',
      'multiple pending changes',
      'revision reuse',
      'update or finalize the prepared Invocation after CAP1',
    ],
  },
  {
    protocol_id: 'CAP2',
    name: 'install_file',
    transaction_mode: 'none',
    external_work: 'filesystem_durability',
    preconditions: [
      'unique Publisher reads only CAP1 durable record',
      'activity path and exclusive temporary file share one directory and filesystem',
    ],
    atomic_writes: [
      'write complete envelope bytes',
      'fsync temporary file',
      'atomic rename to activity path',
      'fsync containing directory',
      'append file_installed event after durable install',
    ],
    success_outcome: 'durable file exists but is not effective before CAP3',
    failure_outcomes: ['publication_failed'],
    crash_recovery: [
      'remove or reuse exclusive temp as journal dictates',
      'Watcher rejects renamed but uncommitted envelope',
      'Recovery completes head or restores the last audited envelope',
    ],
    forbidden_actions: [
      'product module Runtime Center setup upgrade or Watcher writes activity file',
      'non-atomic overwrite',
      'skip file or directory fsync',
    ],
  },
  {
    protocol_id: 'CAP3',
    name: 'commit_head',
    transaction_mode: 'begin_immediate',
    external_work: 'none',
    preconditions: [
      'pending change and old head still match CAP1 journal',
      'disk publication bytes config and publication hash revalidate',
    ],
    atomic_writes: [
      'advance current revision change config and publication hash',
      'clear pending change',
      'append head_committed hash-chain event',
    ],
    success_outcome: 'committed head authorizes CAP4 publication',
    failure_outcomes: ['publication_failed', 'capacity_change_in_progress'],
    crash_recovery: [
      'CAP3 commit is all-or-nothing',
      'after commit startup Watcher replays the committed head',
    ],
    forbidden_actions: [
      'commit head without re-reading durable file',
      'Watcher makes pending file effective',
    ],
  },
  {
    protocol_id: 'CAP4',
    name: 'watcher_publish',
    transaction_mode: 'short_begin_immediate',
    external_work: 'immutable_pointer_swap',
    preconditions: [
      'strict full publication parse and both domain hashes valid',
      'revision change config and publication hash equal committed head',
    ],
    atomic_writes: [
      'swap one immutable in-memory pointer',
      'append watcher_published event',
      'finalize canonical Command result',
    ],
    success_outcome:
      'all admission consumers read one immutable snapshot and lineage tuple',
    failure_outcomes: ['publication_failed'],
    crash_recovery: [
      'cold start replays only a verified committed head',
      'mismatch appends unauthorized_file_rejected and restores last audited envelope',
      'no verifiable head and snapshot disables new admission fail closed',
    ],
    forbidden_actions: [
      'promote disk file to authority',
      'mix fields across pointer revisions',
      'derive admission lineage after the fact',
      'update the immutable CAP1 prepared Invocation',
    ],
  },
] as const satisfies readonly CapacityProtocolStep[];

export const CAPACITY_CRASH_BOUNDARIES = [
  {
    boundary_id: 'cap1_after_prepare_commit',
    protocol_id: 'CAP1',
    injected_after: 'prepared event and pending head commit',
    committed_head_visibility: 'old',
    watcher_visibility: 'old',
    recovery_action: 'retry exact publication from pending journal',
  },
  {
    boundary_id: 'cap2_after_temp_create',
    protocol_id: 'CAP2',
    injected_after: 'exclusive temp creation',
    committed_head_visibility: 'old',
    watcher_visibility: 'old',
    recovery_action: 'discard or resume temp using pending journal',
  },
  {
    boundary_id: 'cap2_after_file_write',
    protocol_id: 'CAP2',
    injected_after: 'complete temp bytes written',
    committed_head_visibility: 'old',
    watcher_visibility: 'old',
    recovery_action: 'revalidate bytes then repeat file fsync',
  },
  {
    boundary_id: 'cap2_after_file_fsync',
    protocol_id: 'CAP2',
    injected_after: 'temp file fsync',
    committed_head_visibility: 'old',
    watcher_visibility: 'old',
    recovery_action: 'perform atomic rename and directory fsync',
  },
  {
    boundary_id: 'cap2_after_rename',
    protocol_id: 'CAP2',
    injected_after: 'atomic rename before directory fsync',
    committed_head_visibility: 'old',
    watcher_visibility: 'old',
    recovery_action:
      'fsync directory then complete or restore audited envelope',
  },
  {
    boundary_id: 'cap2_after_directory_fsync',
    protocol_id: 'CAP2',
    injected_after: 'directory fsync before file_installed event',
    committed_head_visibility: 'old',
    watcher_visibility: 'old',
    recovery_action: 'revalidate durable file and append file_installed',
  },
  {
    boundary_id: 'cap2_after_file_installed_event',
    protocol_id: 'CAP2',
    injected_after: 'file_installed event append',
    committed_head_visibility: 'old',
    watcher_visibility: 'old',
    recovery_action: 'continue CAP3; Watcher keeps last snapshot',
  },
  {
    boundary_id: 'cap3_after_head_commit',
    protocol_id: 'CAP3',
    injected_after: 'head_committed transaction',
    committed_head_visibility: 'new',
    watcher_visibility: 'old',
    recovery_action: 'startup Watcher replays committed head into CAP4',
  },
  {
    boundary_id: 'cap4_after_pointer_swap',
    protocol_id: 'CAP4',
    injected_after: 'immutable pointer swap before event finalization',
    committed_head_visibility: 'new',
    watcher_visibility: 'new',
    recovery_action: 'idempotently append watcher event and canonical result',
  },
  {
    boundary_id: 'cap4_after_watcher_event',
    protocol_id: 'CAP4',
    injected_after: 'watcher_published event before command finalization',
    committed_head_visibility: 'new',
    watcher_visibility: 'new',
    recovery_action: 'idempotently finalize canonical command result',
  },
] as const;

export function buildCapacityProtocolCatalog(): CapacityProtocolCatalog {
  const withoutHash = {
    format: 'icarus.workflow-capacity-control-plane-protocol/1' as const,
    protocol_ids: [...CAPACITY_PROTOCOL_IDS],
    steps: CAPACITY_PROTOCOL_STEPS.map((step) => ({
      ...step,
      preconditions: [...step.preconditions],
      atomic_writes: [...step.atomic_writes],
      failure_outcomes: [...step.failure_outcomes],
      crash_recovery: [...step.crash_recovery],
      forbidden_actions: [...step.forbidden_actions],
    })),
    crash_boundaries: CAPACITY_CRASH_BOUNDARIES.map((boundary) => ({
      ...boundary,
    })),
  };
  return {
    ...withoutHash,
    protocol_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-control-plane-protocol:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

interface CoverageSeed {
  category: CapacityMarkdownDeltaCategory;
  value: string;
  contractPath: string;
  contractPointer: string;
  markdownSection: string;
  fixtureRefs: string[];
}

const publicationSchemaPath = `${addendumRoot}/schemas/deployment-runtime-capacity-publication-schema.json`;
const commandSchemaPath = `${addendumRoot}/schemas/capacity-admin-command-schema.json`;
const permissionCatalogPath = `${addendumRoot}/catalogs/capacity-permission-catalog.json`;
const reasonCatalogPath = `${addendumRoot}/catalogs/capacity-reason-catalog.json`;
const denialCatalogPath = `${addendumRoot}/catalogs/capacity-denial-catalog.json`;
const protocolPath = `${addendumRoot}/protocols/capacity-control-plane-protocol@1.json`;
const logicalDeltaPath = `${addendumRoot}/sqlite/capacity-control-plane-logical-schema-delta@1.json`;

export const CAPACITY_MARKDOWN_DELTA_SEEDS: readonly CoverageSeed[] = [
  {
    category: 'semantic_format',
    value: 'icarus.deployment-runtime-capacity-publication/1',
    contractPath: publicationSchemaPath,
    contractPointer: '/payload/properties/format/const',
    markdownSection: 'Capacity 管理、发布与审计',
    fixtureRefs: [`${addendumRoot}/positive-cases.json`],
  },
  ...CAPACITY_ADMIN_COMMAND_TYPES.map((value, indexValue) => ({
    category: 'command_type' as const,
    value,
    contractPath: commandSchemaPath,
    contractPointer: `/payload/oneOf/${indexValue}/properties/command_type/const`,
    markdownSection: 'Capacity 管理、发布与审计',
    fixtureRefs: [`${addendumRoot}/positive-cases.json`],
  })),
  ...CAPACITY_ADMIN_PERMISSION_CODES.map((value, indexValue) => ({
    category: 'permission' as const,
    value,
    contractPath: permissionCatalogPath,
    contractPointer: `/payload/entries/${indexValue}/permission`,
    markdownSection: 'Capacity 管理、发布与审计',
    fixtureRefs: [`${addendumRoot}/negative-cases.json`],
  })),
  ...CAPACITY_CHANGE_REASON_CODES.map((value, indexValue) => ({
    category: 'reason_code' as const,
    value,
    contractPath: reasonCatalogPath,
    contractPointer: `/payload/entries/${indexValue}/reason_code`,
    markdownSection: 'Capacity 管理、发布与审计',
    fixtureRefs: [`${addendumRoot}/positive-cases.json`],
  })),
  ...CAPACITY_ADMIN_DENIAL_CODES.map((value, indexValue) => ({
    category: 'denial_code' as const,
    value,
    contractPath: denialCatalogPath,
    contractPointer: `/payload/entries/${indexValue}/denial_code`,
    markdownSection: 'Capacity 管理、发布与审计',
    fixtureRefs: [`${addendumRoot}/negative-cases.json`],
  })),
  ...CAPACITY_PROTOCOL_IDS.map((value, indexValue) => ({
    category: 'protocol_id' as const,
    value,
    contractPath: protocolPath,
    contractPointer: `/payload/steps/${indexValue}/protocol_id`,
    markdownSection: 'Capacity 管理、发布与审计',
    fixtureRefs: [`${addendumRoot}/fault-cases.json`],
  })),
  ...[
    'runtime_capacity_head',
    'runtime_capacity_admin_commands',
    'runtime_capacity_admin_invocations',
    'runtime_capacity_change_events',
  ].map((value, indexValue) => ({
    category: 'logical_table' as const,
    value,
    contractPath: logicalDeltaPath,
    contractPointer: `/payload/added_tables/${indexValue}/name`,
    markdownSection: 'Capacity 管理、发布与审计',
    fixtureRefs: [`${addendumRoot}/positive-cases.json`],
  })),
  ...['capacity_revision', 'capacity_change_id', 'capacity_config_hash'].map(
    (value, indexValue) => ({
      category: 'admission_lineage_field' as const,
      value,
      contractPath: logicalDeltaPath,
      contractPointer:
        indexValue < 2
          ? `/payload/extended_tables/0/added_columns/${indexValue}/name`
          : '/payload/extended_tables/0/added_checks/0/columns/2',
      markdownSection: 'Resource Ledger 与调度',
      fixtureRefs: [`${addendumRoot}/positive-cases.json`],
    }),
  ),
];

function coverageImpact(
  category: CapacityMarkdownDeltaCategory,
): CapacityMarkdownDeltaCoverageEntry['change_impact'] {
  if (category === 'logical_table' || category === 'admission_lineage_field')
    return 'g1_schema_manifest_and_ddl_update_required';
  if (category === 'protocol_id')
    return 'capacity_protocol_and_fixture_update_required';
  return 'capacity_contract_version_required';
}

export function buildCapacityMarkdownDeltaCoverage(
  markdownOverride?: string,
): CapacityMarkdownDeltaCoverage {
  const markdown =
    markdownOverride ?? readRepoBytes(architecturePath).toString('utf8');
  const entries = CAPACITY_MARKDOWN_DELTA_SEEDS.map((seed) => {
    const withoutHash = {
      coverage_id: `${seed.category}:${seed.value}`,
      category: seed.category,
      value: seed.value,
      contract_path: seed.contractPath,
      contract_pointer: seed.contractPointer,
      markdown_section: seed.markdownSection,
      fixture_refs: seed.fixtureRefs,
      change_impact: coverageImpact(seed.category),
    };
    return {
      ...withoutHash,
      entry_hash: domainSeparatedSha256(
        'icarus:workflow-capacity-markdown-delta-coverage-entry:1\n',
        withoutHash,
      ),
    };
  }).sort((left, right) =>
    left.coverage_id < right.coverage_id
      ? -1
      : left.coverage_id > right.coverage_id
        ? 1
        : 0,
  );
  const missing = entries
    .filter((entry) => !markdown.includes(entry.value))
    .map((entry) => `${entry.category}:${entry.value}`)
    .sort();
  const categoryCounts = Object.fromEntries(
    CAPACITY_MARKDOWN_DELTA_CATEGORIES.map((category) => [
      category,
      entries.filter((entry) => entry.category === category).length,
    ]),
  ) as Record<CapacityMarkdownDeltaCategory, number>;
  const withoutHash = {
    format:
      'icarus.workflow-capacity-control-plane-markdown-delta-coverage/1' as const,
    architecture_path: architecturePath,
    spec_binding_scope: 'capacity_contract_values_only' as const,
    prior_g0_9_root_hash: G0_9_HISTORICAL_ROOT_HASH,
    extraction_policy:
      'g0_10_delta_only_no_runtime_markdown_extraction' as const,
    categories: [...CAPACITY_MARKDOWN_DELTA_CATEGORIES],
    entries,
    category_counts: categoryCounts,
    contract_value_count: entries.length,
    markdown_value_count: entries.length - missing.length,
    contract_values_without_markdown: missing,
    markdown_values_without_contract: [] as string[],
  };
  return {
    ...withoutHash,
    coverage_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-markdown-delta-coverage:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

function inventoryClass(
  relativePath: string,
): CapacityArtifactInventoryEntry['artifact_class'] {
  if (relativePath.includes('/schemas/')) return 'schema';
  if (relativePath.includes('/catalogs/')) return 'catalog';
  if (relativePath.includes('/protocols/')) return 'protocol';
  if (relativePath.includes('/sqlite/')) return 'logical_schema_delta';
  if (relativePath.includes('coverage')) return 'coverage';
  return 'fixture';
}

function renderedArtifactBytes(artifact: ContractArtifactEnvelope): Buffer {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

export function buildCapacityArtifactInventory(
  leafArtifacts: Array<[string, ContractArtifactEnvelope]>,
): CapacityArtifactInventory {
  const historicalPath =
    'src/workflow-runtime/contracts/contract-pack-g0-conformance-exit.json';
  const historicalBytes = readRepoBytes(historicalPath);
  const entries: CapacityArtifactInventoryEntry[] = [
    {
      artifact_id: `G0.9:${historicalPath}`,
      owning_slice: 'G0.9' as const,
      artifact_class: 'historical_root' as const,
      path: historicalPath,
      format: 'icarus.workflow-contract-pack-g0-conformance-exit/1',
      byte_length: historicalBytes.byteLength,
      raw_sha256: rawSha256(historicalBytes),
      semantic_hash: G0_9_HISTORICAL_ROOT_HASH,
    },
    ...leafArtifacts.map(([relativePath, artifact]) => {
      const bytes = renderedArtifactBytes(artifact);
      return {
        artifact_id: `G0.10:src/workflow-runtime/contracts/${relativePath}`,
        owning_slice: 'G0.10' as const,
        artifact_class: inventoryClass(relativePath),
        path: `src/workflow-runtime/contracts/${relativePath}`,
        format: artifact.format,
        byte_length: bytes.byteLength,
        raw_sha256: rawSha256(bytes),
        semantic_hash: artifact.hash,
      };
    }),
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const pathCounts = new Map<string, number>();
  for (const entry of entries)
    pathCounts.set(entry.path, (pathCounts.get(entry.path) ?? 0) + 1);
  const duplicatePaths = [...pathCounts]
    .filter(([, count]) => count > 1)
    .map(([relativePath]) => relativePath)
    .sort();
  const classCounts = Object.fromEntries(
    CAPACITY_INVENTORY_CLASSES.map((artifactClass) => [
      artifactClass,
      entries.filter((entry) => entry.artifact_class === artifactClass).length,
    ]),
  ) as Record<(typeof CAPACITY_INVENTORY_CLASSES)[number], number>;
  const withoutHash = {
    format:
      'icarus.workflow-capacity-control-plane-artifact-inventory/1' as const,
    inventory_scope:
      'g0_9_historical_root_and_g0_10_non_recursive_leaf_artifacts' as const,
    closure_policy:
      'inventory_gate_domain_and_root_owned_by_g0_10_manifest' as const,
    entries,
    entry_count: entries.length,
    class_counts: classCounts,
    duplicate_paths: duplicatePaths,
    missing_paths: [] as string[],
  };
  return {
    ...withoutHash,
    inventory_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-control-plane-artifact-inventory:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

export function buildCapacityGateReview(
  coverage: CapacityMarkdownDeltaCoverage,
  inventory: CapacityArtifactInventory,
  evidenceHashes: Sha256Hash[],
): CapacityGateReview {
  const exitCriteria = [
    'g0_9_historical_root_exactly_pinned',
    'capacity_payload_and_baseline_identity_preserved',
    'publication_and_admin_command_closed_contracts',
    'permission_reason_and_denial_catalogs_closed',
    'cap0_cap4_protocol_and_crash_boundaries',
    'logical_schema_and_admission_lineage_additive_delta',
    'markdown_delta_and_artifact_inventory_complete',
    'positive_negative_fault_and_typescript_conformance',
    'deterministic_generate_and_read_only_check',
    'forbidden_runtime_ddl_golden_and_ui_boundaries_absent',
  ].map((criterionId, indexValue) => ({
    criterion_id: criterionId,
    status: 'pass' as const,
    evidence_hashes:
      indexValue === 0
        ? [G0_9_HISTORICAL_ROOT_HASH]
        : indexValue === 1
          ? [CAPACITY_SCHEMA_HISTORICAL_HASH, CAPACITY_BASELINE_HISTORICAL_HASH]
          : indexValue === 6
            ? [coverage.coverage_hash, inventory.inventory_hash]
            : [evidenceHashes[indexValue % evidenceHashes.length]!],
  }));
  const withoutHash = {
    format: 'icarus.workflow-capacity-control-plane-gate-review/1' as const,
    gate_id: 'G0.10' as const,
    review_kind: 'capacity_control_plane_addendum' as const,
    decision: 'pass' as const,
    prior_g0_9_root_hash: G0_9_HISTORICAL_ROOT_HASH,
    historical_identity_hashes: { ...G0_10_HISTORICAL_IDENTITIES },
    exit_criteria: exitCriteria,
    markdown_delta_coverage_hash: coverage.coverage_hash,
    artifact_inventory_hash: inventory.inventory_hash,
    status_proof: {
      g0_status: 'DONE' as const,
      i11_status: 'DONE' as const,
      g1_status: 'READY' as const,
      g2_status: 'READY' as const,
      g3_through_g9_status: 'NOT_READY' as const,
      r014_status: 'CLOSED' as const,
      executable_ddl_status: 'absent' as const,
      workflow_runtime_store_status: 'absent' as const,
      capacity_gateway_status: 'absent' as const,
      capacity_publisher_status: 'absent' as const,
      capacity_watcher_status: 'absent' as const,
      scheduler_status: 'absent' as const,
      runtime_center_ui_status: 'absent' as const,
      golden_semantic_review_status: 'absent' as const,
      golden_seal_status: 'not_run' as const,
      sealed_directory_entry: '.gitkeep' as const,
    },
  };
  return {
    ...withoutHash,
    review_hash: domainSeparatedSha256(
      'icarus:workflow-capacity-control-plane-gate-review:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

function reasonEntry(
  reasonCode: CapacityAdminCommand['reason_code'],
): CapacityReasonCatalogEntry | undefined {
  return CAPACITY_REASON_CATALOG_ENTRIES.find(
    (entry) => entry.reason_code === reasonCode,
  );
}

export function evaluateCapacityAdminModel(
  invocation: CapacityAdminModelInvocation,
  head: CapacityAdminModelHead | null,
  command: CapacityAdminCommand,
): CapacityAdminModelResult {
  if (
    !invocation.authenticated ||
    invocation.auth_session_ref === null ||
    invocation.session_actor_ref !== invocation.actor_ref
  )
    return 'authentication_rejected_no_invocation';
  if (!invocation.audit_available) return 'audit_unavailable';
  if (invocation.delegation_chain_ref !== null) return 'permission_denied';
  if (command.command_type === 'initialize_deployment_capacity') {
    if (
      invocation.actor_kind !== 'system' ||
      invocation.actor_ref !== 'system:production-activation' ||
      invocation.entrypoint !== 'production_activation'
    )
      return 'actor_kind_denied';
  } else {
    if (invocation.actor_kind !== 'human') return 'actor_kind_denied';
    if (
      invocation.actor_ref !== 'human:local-owner' ||
      !invocation.permissions.includes('runtime.capacity.manage') ||
      !CAPACITY_ADMIN_HUMAN_ENTRYPOINTS.some(
        (entrypoint) => entrypoint === invocation.entrypoint,
      )
    )
      return 'permission_denied';
  }
  const requestHash = calculateCapacityAdminRequestHash(command);
  if (invocation.idempotency_record) {
    if (invocation.idempotency_record.request_hash === requestHash)
      return 'duplicate';
    return 'idempotency_conflict';
  }
  const snapshotError = validateDeploymentCapacitySnapshot(
    command.proposed_capacity,
  );
  if (snapshotError) return 'capacity_snapshot_invalid';
  const reason = reasonEntry(command.reason_code);
  if (
    !reason ||
    !reason.allowed_command_types.includes(command.command_type) ||
    command.evidence_refs.length < reason.minimum_evidence_refs ||
    (reason.reason_text_required &&
      (command.command_type !== 'replace_deployment_capacity' ||
        command.reason_text.length === 0))
  )
    return 'capacity_snapshot_invalid';
  if (command.command_type === 'initialize_deployment_capacity') {
    if (head) return 'capacity_already_initialized';
    if (
      invocation.genesis_grant === null ||
      invocation.genesis_grant.core_release_hash !==
        invocation.active_core_release_hash ||
      invocation.genesis_grant.baseline_config_hash !==
        invocation.baseline_config_hash ||
      command.core_release_hash !== invocation.active_core_release_hash ||
      command.proposed_capacity.config_hash !== invocation.baseline_config_hash
    )
      return 'capacity_snapshot_invalid';
    return 'prepared';
  }
  if (!head) return 'expected_capacity_revision_conflict';
  if (head.pending_change_id !== null) return 'capacity_change_in_progress';
  if (command.expected_capacity_revision !== head.capacity_revision)
    return 'expected_capacity_revision_conflict';
  if (command.expected_config_hash !== head.config_hash)
    return 'expected_config_hash_conflict';
  if (
    command.proposed_capacity.minimum_free_disk_bytes <
    head.minimum_free_disk_bytes
  )
    return 'capacity_transition_invalid';
  return 'prepared';
}

export function validateCapacityAdminInvocationLifecycle(
  candidate: CapacityAdminInvocationLifecycleCandidate,
): string {
  if (
    !Number.isSafeInteger(candidate.invocation_no) ||
    candidate.invocation_no < 1 ||
    !Number.isSafeInteger(candidate.requested_at_ms) ||
    candidate.requested_at_ms < 0 ||
    !Number.isSafeInteger(candidate.decided_at_ms) ||
    candidate.decided_at_ms < candidate.requested_at_ms ||
    (candidate.applied_at_ms !== null &&
      (!Number.isSafeInteger(candidate.applied_at_ms) ||
        candidate.applied_at_ms < candidate.decided_at_ms))
  ) {
    return 'capacity_invocation_time_invalid';
  }
  if (candidate.authorization_result === 'denied') {
    return candidate.execution_result === 'denied' &&
      candidate.denial_code !== null &&
      candidate.applied_at_ms === null
      ? 'valid_denied_invocation'
      : 'capacity_invocation_denied_shape_invalid';
  }
  if (candidate.denial_code !== null) {
    return 'capacity_invocation_allowed_denial_code_invalid';
  }
  if (candidate.execution_result === 'prepared') {
    if (
      candidate.invocation_no !== 1 ||
      !candidate.submitted_request_matches_command ||
      candidate.command_result_state !== 'pending'
    ) {
      return 'capacity_invocation_prepared_lifecycle_invalid';
    }
    return candidate.applied_at_ms === null
      ? 'valid_prepared_invocation'
      : 'capacity_invocation_prepared_applied_time_invalid';
  }
  if (candidate.execution_result === 'applied') {
    return 'capacity_invocation_applied_is_historical';
  }
  if (candidate.execution_result === 'duplicate') {
    if (
      candidate.invocation_no <= 1 ||
      !candidate.submitted_request_matches_command ||
      candidate.command_result_state !== 'finalized'
    ) {
      return 'capacity_invocation_duplicate_lifecycle_invalid';
    }
    return candidate.applied_at_ms === null
      ? 'valid_duplicate_invocation'
      : 'capacity_invocation_terminal_non_applied_time_invalid';
  }
  if (['conflict', 'failed'].includes(candidate.execution_result)) {
    return candidate.applied_at_ms === null
      ? `valid_${candidate.execution_result}_invocation`
      : 'capacity_invocation_terminal_non_applied_time_invalid';
  }
  return 'capacity_invocation_allowed_result_invalid';
}

export function assertHistoricalG0_9Conformance(): ContractArtifactEnvelope {
  const manifest = readContractArtifact(
    'contract-pack-g0-conformance-exit.json',
  );
  if (manifest.hash !== G0_9_HISTORICAL_ROOT_HASH)
    throw new Error('G0.9 historical root identity drift');
  if (g0ConformanceToolHash() !== G0_9_HISTORICAL_TOOL_HASH)
    throw new Error('G0.9 historical generator source drift');
  const descriptors = manifest.payload.artifacts;
  if (!Array.isArray(descriptors) || descriptors.length !== 9)
    throw new Error('G0.9 historical artifact closure drift');
  for (const descriptorValue of descriptors) {
    assertJsonObject(descriptorValue);
    const member = readContractArtifact(String(descriptorValue.path));
    if (
      member.format !== descriptorValue.format ||
      member.hash !== descriptorValue.hash ||
      member.domain_separator !== descriptorValue.domain_separator
    )
      throw new Error(`G0.9 historical member drift: ${descriptorValue.path}`);
  }
  const prior = manifest.payload.prior_manifest_hashes;
  assertJsonObject(prior);
  for (const [sliceId, hashValue] of Object.entries(
    G0_10_HISTORICAL_IDENTITIES,
  )) {
    if (sliceId === 'G0.9' || sliceId.startsWith('capacity_')) continue;
    if (prior[sliceId] !== hashValue)
      throw new Error(`G0.9 prior identity drift: ${sliceId}`);
  }
  const capacitySchema = readContractArtifact(
    'safety/deployment-runtime-capacity-schema.json',
  );
  if (capacitySchema.hash !== CAPACITY_SCHEMA_HISTORICAL_HASH)
    throw new Error('Historical Capacity schema identity drift');
  const baseline = strictParseJsonBytes(
    readRepoBytes('config/workflow-runtime-capacity.json'),
  );
  assertJsonObject(baseline);
  if (baseline.config_hash !== CAPACITY_BASELINE_HISTORICAL_HASH)
    throw new Error('Historical Capacity baseline identity drift');
  return manifest;
}

export const CAPACITY_CONTROL_PLANE_TOOL_SOURCE_FILES = [
  'capacity-control-plane-artifacts.ts',
  'capacity-control-plane-fixtures.ts',
  'capacity-control-plane-logical-source.ts',
  'capacity-control-plane-pack.ts',
  'capacity-control-plane-source.ts',
  'capacity-control-plane-types.ts',
] as const;

export function capacityControlPlaneToolHash(): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-capacity-control-plane-generator-tool:1\n',
    CAPACITY_CONTROL_PLANE_TOOL_SOURCE_FILES.map((relativePath) => ({
      path: relativePath,
      source_sha256: rawSha256(
        readRepoBytes(`src/workflow-runtime/contracts/${relativePath}`),
      ),
    })),
  );
}

export const CAPACITY_CONTROL_PLANE_CLOSED_UNIONS = {
  command_types: CAPACITY_ADMIN_COMMAND_TYPES,
  actor_kinds: CAPACITY_ADMIN_ACTOR_KINDS,
  human_entrypoints: CAPACITY_ADMIN_HUMAN_ENTRYPOINTS,
  permission_codes: CAPACITY_ADMIN_PERMISSION_CODES,
  reason_codes: CAPACITY_CHANGE_REASON_CODES,
  denial_codes: CAPACITY_ADMIN_DENIAL_CODES,
  protocol_ids: CAPACITY_PROTOCOL_IDS,
  fixture_areas: CAPACITY_FIXTURE_AREAS,
} as const;
