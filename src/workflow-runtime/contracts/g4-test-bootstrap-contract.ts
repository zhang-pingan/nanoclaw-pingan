import { WORKFLOW_COMPILER_VERSION } from '../compiler/version.js';
import { CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION } from '../store/runtime-store/config.js';
import {
  g4FakeAdapterBehaviors,
  g4FixtureSet,
  g4VirtualClockProfile,
} from './g4-test-bootstrap-fixtures.js';
import {
  G4_FAKE_ADAPTER_OUTCOMES,
  G4_FAKE_ADAPTER_PROFILE_REF,
  G4_TEST_BOOTSTRAP_PROFILE_REF,
  type G4IsolationReceipt,
  type G4TestBootstrapProfile,
} from './g4-test-bootstrap-types.js';
import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from './hash.js';
import { assertJsonObject } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  Sha256Hash,
  VersionedRef,
} from './types.js';
import { parseVersionedRef } from './versioned-ref.js';

const versionedRefSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
  },
};
const hashSchema: JsonObject = {
  type: 'string',
  pattern: '^sha256:[0-9a-f]{64}$',
};

export const G4_TEST_BOOTSTRAP_PROFILE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'ref',
    'profile_kind',
    'selection',
    'default_enabled',
    'production_acceptance',
    'production_rejection_code',
    'managed_toolchain',
    'store_binding',
    'upstream_contracts',
    'fixture_set',
    'fake_adapter',
    'virtual_clock',
    'root_policy',
    'isolation_boundary',
  ],
  properties: {
    format: { const: 'icarus.workflow-test-bootstrap-profile/1' },
    ref: versionedRefSchema,
    profile_kind: { const: 'test_only' },
    selection: { const: 'explicit_exact_ref_and_hash' },
    default_enabled: { const: false },
    production_acceptance: { const: 'reject' },
    production_rejection_code: { const: 'test_bootstrap_profile_forbidden' },
    managed_toolchain: { type: 'object' },
    store_binding: { type: 'object' },
    upstream_contracts: { type: 'object' },
    fixture_set: { type: 'object' },
    fake_adapter: { type: 'object' },
    virtual_clock: { type: 'object' },
    root_policy: { type: 'object' },
    isolation_boundary: { type: 'object' },
  },
};

export const G4_ISOLATION_RECEIPT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'instance_id',
    'profile_ref',
    'profile_hash',
    'fixture_set_ref',
    'fixture_set_hash',
    'fake_adapter_profile_hash',
    'virtual_clock_profile_hash',
    'canonical_data_root',
    'database_path',
    'owner_marker_hash',
    'root_device',
    'root_inode',
    'database_device',
    'database_inode',
    'database_schema_version',
    'production_ingress_reachable',
    'feature_ingress_reachable',
    'api_ingress_reachable',
    'automation_ingress_reachable',
    'active_registry_rows_observed',
    'active_release_pointer_rows_observed',
    'production_runtime_root_touched',
    'real_adapter_invoked',
    'user_data_touched',
    'authority',
    'receipt_hash',
  ],
  properties: {
    format: { const: 'icarus.workflow-test-bootstrap-isolation-receipt/1' },
    instance_id: { type: 'string', minLength: 1 },
    profile_ref: versionedRefSchema,
    profile_hash: hashSchema,
    fixture_set_ref: versionedRefSchema,
    fixture_set_hash: hashSchema,
    fake_adapter_profile_hash: hashSchema,
    virtual_clock_profile_hash: hashSchema,
    canonical_data_root: { type: 'string', minLength: 1 },
    database_path: { type: 'string', minLength: 1 },
    owner_marker_hash: hashSchema,
    root_device: { type: 'string', minLength: 1 },
    root_inode: { type: 'string', minLength: 1 },
    database_device: { type: 'string', minLength: 1 },
    database_inode: { type: 'string', minLength: 1 },
    database_schema_version: {
      const: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
    },
    production_ingress_reachable: { const: false },
    feature_ingress_reachable: { const: false },
    api_ingress_reachable: { const: false },
    automation_ingress_reachable: { const: false },
    active_registry_rows_observed: { const: 0 },
    active_release_pointer_rows_observed: { const: 0 },
    production_runtime_root_touched: { const: false },
    real_adapter_invoked: { const: false },
    user_data_touched: { const: false },
    authority: { const: 'test_only_bootstrap' },
    receipt_hash: hashSchema,
  },
};

function artifact<T extends JsonObject>(
  format: string,
  ref: VersionedRef,
  domain: string,
  payload: T,
): ContractArtifactEnvelope<T> {
  const value: ContractArtifactEnvelope<T> = {
    format,
    ref,
    version: 1,
    domain_separator: domain,
    payload,
    hash: `sha256:${'0'.repeat(64)}`,
  };
  value.hash = calculateArtifactHash(value);
  return value;
}

export interface G4TestBootstrapContractSet {
  readonly profile: ContractArtifactEnvelope<G4TestBootstrapProfile>;
  readonly fixtureSet: ContractArtifactEnvelope;
  readonly fakeAdapterProfile: ContractArtifactEnvelope;
  readonly virtualClockProfile: ContractArtifactEnvelope;
  readonly isolationBoundary: ContractArtifactEnvelope;
}

function buildContractSet(): G4TestBootstrapContractSet {
  const fixtureSet = artifact(
    'icarus.workflow-test-bootstrap-fixture-set/1',
    g4FixtureSet().ref,
    'icarus:workflow-test-bootstrap-fixture-set:1\n',
    g4FixtureSet(),
  );
  const fakeAdapterProfile = artifact(
    'icarus.workflow-test-fake-adapter-profile/1',
    { ...G4_FAKE_ADAPTER_PROFILE_REF },
    'icarus:workflow-test-fake-adapter-profile:1\n',
    {
      ref: { ...G4_FAKE_ADAPTER_PROFILE_REF },
      outcome_count: G4_FAKE_ADAPTER_OUTCOMES.length,
      behaviors: g4FakeAdapterBehaviors(),
    },
  );
  const virtualClock = g4VirtualClockProfile();
  const virtualClockProfile = artifact(
    'icarus.workflow-test-virtual-clock-profile/1',
    virtualClock.ref,
    'icarus:workflow-test-virtual-clock-profile:1\n',
    virtualClock,
  );
  const isolationBoundary = artifact(
    'icarus.workflow-test-bootstrap-isolation-boundary/1',
    {
      id: 'icarus.workflow-test-bootstrap-isolation-boundary',
      version: '1.0.0',
    },
    'icarus:workflow-test-bootstrap-isolation-boundary:1\n',
    {
      temporary_directory_required: true,
      dependency_injection_required: true,
      production_ingress_allowed: false,
      user_data_allowed: false,
    },
  );
  const profilePayload: G4TestBootstrapProfile = {
    format: 'icarus.workflow-test-bootstrap-profile/1',
    ref: { ...G4_TEST_BOOTSTRAP_PROFILE_REF },
    profile_kind: 'test_only',
    selection: 'explicit_exact_ref_and_hash',
    default_enabled: false,
    production_acceptance: 'reject',
    production_rejection_code: 'test_bootstrap_profile_forbidden',
    managed_toolchain: {
      node_major: Number(process.versions.node.split('.')[0]),
      platform: process.platform,
      arch: process.arch,
    },
    store_binding: {
      connection_factory: 'WorkflowRuntimeConnectionFactory',
      database_name: 'workflow-runtime.db',
      database_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION,
    },
    upstream_contracts: { compiler_version: WORKFLOW_COMPILER_VERSION },
    fixture_set: { ref: fixtureSet.ref, hash: fixtureSet.hash },
    fake_adapter: {
      ref: fakeAdapterProfile.ref,
      hash: fakeAdapterProfile.hash,
      outcome_count: G4_FAKE_ADAPTER_OUTCOMES.length,
      real_adapter_allowed: false,
      network_allowed: false,
    },
    virtual_clock: {
      ref: virtualClockProfile.ref,
      hash: virtualClockProfile.hash,
      seed: virtualClock.seed,
      initial_time_ms: virtualClock.initial_time_ms,
      authority: 'virtual_only',
    },
    root_policy: {
      root_kind: 'unique_canonical_os_temp_child',
      create_mode: 'exclusive_new_directory',
      preexisting_root: 'reject',
      symlink_or_alias: 'reject',
      cleanup: 'close_store_then_remove_owned_root',
    },
    isolation_boundary: {
      hash: isolationBoundary.hash,
      feature_ingress: 'absent',
      api_ingress: 'absent',
      automation_ingress: 'absent',
      production_data_root_access: 'forbidden',
      user_data_access: 'forbidden',
    },
  };
  const profile = artifact(
    'icarus.workflow-test-bootstrap-profile/1',
    { ...G4_TEST_BOOTSTRAP_PROFILE_REF },
    'icarus:workflow-test-bootstrap-profile:1\n',
    profilePayload,
  );
  return {
    profile,
    fixtureSet,
    fakeAdapterProfile,
    virtualClockProfile,
    isolationBoundary,
  };
}

export function checkG4TestBootstrapContracts(): G4TestBootstrapContractSet {
  return buildContractSet();
}

export function validateG4TestBootstrapProfile(value: unknown): void {
  assertJsonObject(value);
  if (
    canonicalJson(value) !== canonicalJson(buildContractSet().profile.payload)
  )
    throw new Error(
      'G4 Test Bootstrap Profile is not the current local profile',
    );
}

function exactKeys(value: JsonObject, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  )
    throw new Error('G4 isolation receipt has unknown or missing fields');
}

export function validateG4IsolationReceipt(value: unknown): G4IsolationReceipt {
  assertJsonObject(value);
  exactKeys(value, (G4_ISOLATION_RECEIPT_SCHEMA.required as string[]) ?? []);
  if (
    value.format !== 'icarus.workflow-test-bootstrap-isolation-receipt/1' ||
    value.database_schema_version !== CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION ||
    value.authority !== 'test_only_bootstrap'
  )
    throw new Error('G4 isolation receipt fields are invalid');
  const receipt = structuredClone(value) as G4IsolationReceipt;
  const contracts = buildContractSet();
  const profileRef = parseVersionedRef(receipt.profile_ref);
  const fixtureRef = parseVersionedRef(receipt.fixture_set_ref);
  const hashes = [
    receipt.profile_hash,
    receipt.fixture_set_hash,
    receipt.fake_adapter_profile_hash,
    receipt.virtual_clock_profile_hash,
    receipt.owner_marker_hash,
    receipt.receipt_hash,
  ];
  hashes.forEach(parseSha256Hash);
  if (
    profileRef.id !== contracts.profile.ref.id ||
    profileRef.version !== contracts.profile.ref.version ||
    receipt.profile_hash !== contracts.profile.hash ||
    fixtureRef.id !== contracts.fixtureSet.ref.id ||
    fixtureRef.version !== contracts.fixtureSet.ref.version ||
    receipt.fixture_set_hash !== contracts.fixtureSet.hash ||
    receipt.fake_adapter_profile_hash !== contracts.fakeAdapterProfile.hash ||
    receipt.virtual_clock_profile_hash !== contracts.virtualClockProfile.hash
  )
    throw new Error('G4 isolation receipt selection does not match');
  const { receipt_hash: receiptHash, ...payload } = receipt;
  const expectedHash = domainSeparatedSha256(
    'icarus:workflow-test-bootstrap-isolation-receipt:1\n',
    payload,
  );
  if (receiptHash !== expectedHash)
    throw new Error('G4 isolation receipt checksum mismatch');
  for (const field of [
    'production_ingress_reachable',
    'feature_ingress_reachable',
    'api_ingress_reachable',
    'automation_ingress_reachable',
    'production_runtime_root_touched',
    'real_adapter_invoked',
    'user_data_touched',
  ] as const) {
    if (receipt[field] !== false)
      throw new Error(`G4 isolation receipt ${field} must be false`);
  }
  if (
    receipt.active_registry_rows_observed !== 0 ||
    receipt.active_release_pointer_rows_observed !== 0
  )
    throw new Error('G4 isolation receipt observed active rows');
  return receipt;
}

export function assertG4ProfileRejectedForProduction(
  surface: 'build' | 'startup' | 'loader',
  profile: unknown,
): never {
  validateG4TestBootstrapProfile(profile);
  throw new Error(
    `test_bootstrap_profile_forbidden: production ${surface} rejects the local test profile`,
  );
}
