import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { loadFrozenWorkflowRuntimeStoreInputs } from '../store/runtime-store/profile.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { checkG38AActivationContractRepair } from './g3-8a-activation-contract-repair.js';
import { checkG39FeatureReleaseActivationContracts } from './g3-feature-release-activation-contract.js';
import { G39_UPSTREAM_IDENTITIES } from './g3-feature-release-activation.js';
import { checkG3RetentionExecutorAbiPreflight } from './g3-retention-executor-abi-preflight.js';
import { G3_CURRENT_UPSTREAM_IDENTITY } from './g3-registry-publish-types.js';
import { checkG37WorkflowPublisherContracts } from './g3-workflow-publisher-contract.js';
import {
  g4FakeAdapterBehaviors,
  g4FaultCases,
  g4FixtureSet,
  g4NegativeCases,
  g4PositiveCases,
  G4_FAKE_ADAPTER_INVOCATION_DOMAIN,
  G4_FAKE_ADAPTER_RESULT_DOMAIN,
  g4VirtualClockProfile,
} from './g4-test-bootstrap-fixtures.js';
import {
  assertG4TestBootstrapIsolation,
  G4_BOOTSTRAP_SOURCE_PATHS,
  g4IsolationBoundaryPayload,
} from './g4-test-bootstrap-isolation.js';
import {
  G4_FAKE_ADAPTER_OUTCOMES,
  G4_FAKE_ADAPTER_PROFILE_REF,
  G4_TEST_BOOTSTRAP_FIXTURE_SET_REF,
  G4_TEST_BOOTSTRAP_PROFILE_REF,
  G4_VIRTUAL_CLOCK_PROFILE_REF,
  type G4IsolationReceipt,
  type G4TestBootstrapProfile,
} from './g4-test-bootstrap-types.js';
import {
  calculateArtifactHash,
  domainSeparatedSha256,
  parseSha256Hash,
} from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');
const fixtureRoot = 'conformance/g4-test-bootstrap';

const paths = {
  profileSchema: 'bootstrap/workflow-test-bootstrap-profile-schema@1.json',
  fakeInvocationSchema:
    'bootstrap/workflow-test-fake-adapter-invocation-schema@1.json',
  fakeResultSchema: 'bootstrap/workflow-test-fake-adapter-result-schema@1.json',
  receiptSchema:
    'bootstrap/workflow-test-bootstrap-isolation-receipt-schema@1.json',
  fixtureSet: 'bootstrap/workflow-test-bootstrap-fixture-set@1.json',
  fakeAdapterProfile: 'bootstrap/workflow-test-fake-adapter-profile@1.json',
  virtualClockProfile: 'bootstrap/workflow-test-virtual-clock-profile@1.json',
  implementation: 'bootstrap/workflow-test-bootstrap-implementation@1.json',
  isolationBoundary:
    'bootstrap/workflow-test-bootstrap-isolation-boundary@2.json',
  profile: 'bootstrap/workflow-test-bootstrap-profile@1.json',
  domains: 'bootstrap/workflow-test-bootstrap-domain-separators@1.json',
  positive: `${fixtureRoot}/positive-cases.json`,
  negative: `${fixtureRoot}/negative-cases.json`,
  fault: `${fixtureRoot}/fault-cases.json`,
  manifest: 'contract-pack-g4-test-bootstrap.json',
} as const;

const domains = {
  profileSchema: 'icarus:workflow-test-bootstrap-profile-schema:1\n',
  fakeInvocationSchema:
    'icarus:workflow-test-fake-adapter-invocation-schema:1\n',
  fakeResultSchema: 'icarus:workflow-test-fake-adapter-result-schema:1\n',
  receiptSchema: 'icarus:workflow-test-bootstrap-isolation-receipt-schema:1\n',
  fixtureSet: 'icarus:workflow-test-bootstrap-fixture-set:1\n',
  fakeAdapterProfile: 'icarus:workflow-test-fake-adapter-profile:1\n',
  virtualClockProfile: 'icarus:workflow-test-virtual-clock-profile:1\n',
  implementationArtifact:
    'icarus:workflow-test-bootstrap-implementation-artifact:1\n',
  implementation: 'icarus:workflow-test-bootstrap-implementation:1\n',
  isolationBoundary: 'icarus:workflow-test-bootstrap-isolation-boundary:2\n',
  profile: 'icarus:workflow-test-bootstrap-profile:1\n',
  domains: 'icarus:workflow-test-bootstrap-domain-separators:1\n',
  positive: 'icarus:workflow-test-bootstrap-positive-cases:1\n',
  negative: 'icarus:workflow-test-bootstrap-negative-cases:1\n',
  fault: 'icarus:workflow-test-bootstrap-fault-cases:1\n',
  manifest: 'icarus:workflow-contract-pack-g4-test-bootstrap:1\n',
} as const;

const CURRENT_G3_9_PACK_HASH =
  'sha256:c9aa03bf85e2b358f8b4b01b7dcfecf25ce76d2339688e88fe969d1babe10107';

const hashSchema: JsonObject = {
  type: 'string',
  pattern: '^sha256:[0-9a-f]{64}$',
};
const versionedRefSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', minLength: 1 },
    version: { type: 'string', pattern: '^[1-9][0-9]*\\.[0-9]+\\.[0-9]+$' },
  },
};

function closedObject(properties: JsonObject): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

export const G4_TEST_BOOTSTRAP_PROFILE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:workflow-test-bootstrap-profile:1',
  ...closedObject({
    format: { const: 'icarus.workflow-test-bootstrap-profile/1' },
    ref: versionedRefSchema,
    gate: { const: 'G4' },
    profile_kind: { const: 'test_only' },
    selection: { const: 'explicit_exact_ref_and_hash' },
    default_enabled: { const: false },
    certification_status: { const: 'not_certified' },
    production_acceptance: { const: 'reject' },
    production_rejection_code: { const: 'test_bootstrap_profile_forbidden' },
    managed_toolchain: closedObject({
      node_runtime_version: { const: '26.5.0' },
      npm_version: { const: '11.17.0' },
      package_lock_hash: hashSchema,
      managed_distribution_ref: versionedRefSchema,
      managed_distribution_hash: hashSchema,
      node_executable_hash: hashSchema,
      compiler_toolchain_ref: versionedRefSchema,
      compiler_toolchain_hash: hashSchema,
      compiler_build_hash: hashSchema,
    }),
    store_binding: closedObject({
      connection_factory: { const: 'WorkflowRuntimeConnectionFactory' },
      identity_mode: { const: 'candidate_development' },
      database_name: { const: 'workflow-runtime.db' },
      database_schema_version: { const: 6 },
      g1_root_hash: hashSchema,
      schema_dependency_manifest_hash: hashSchema,
      physical_schema_identity: hashSchema,
      database_schema_hash: hashSchema,
      migration_hash: hashSchema,
      schema3_to_4_upgrade_hash: hashSchema,
      schema4_to_5_upgrade_hash: hashSchema,
      schema5_to_6_upgrade_hash: hashSchema,
      sqlite_profile_ref: versionedRefSchema,
      sqlite_profile_hash: hashSchema,
      sqlite_profile_status: { const: 'candidate' },
      certification_status: { const: 'not_certified' },
    }),
    upstream_contracts: closedObject({
      g2_sealed_bundle_hash: hashSchema,
      g3_6_pack_hash: hashSchema,
      g3_7_pack_hash: hashSchema,
      g3_8a_pack_hash: hashSchema,
      g3_9_pack_hash: hashSchema,
    }),
    fixture_set: closedObject({ ref: versionedRefSchema, hash: hashSchema }),
    fake_adapter: closedObject({
      ref: versionedRefSchema,
      hash: hashSchema,
      outcome_count: { const: 7 },
      real_adapter_allowed: { const: false },
      network_allowed: { const: false },
    }),
    virtual_clock: closedObject({
      ref: versionedRefSchema,
      hash: hashSchema,
      seed: { type: 'string', minLength: 1 },
      initial_time_ms: { type: 'integer', minimum: 0 },
      authority: { const: 'virtual_only' },
    }),
    root_policy: closedObject({
      root_kind: { const: 'unique_canonical_os_temp_child' },
      create_mode: { const: 'exclusive_new_directory' },
      preexisting_root: { const: 'reject' },
      nonempty_root: { const: 'reject' },
      symlink_or_alias: { const: 'reject' },
      cross_instance_reuse: { const: 'reject' },
      production_root_collision: { const: 'reject' },
      cleanup: { const: 'close_store_then_remove_owned_root' },
      cleanup_failure: { const: 'write_identifiable_residual_marker' },
    }),
    isolation_boundary: closedObject({
      hash: hashSchema,
      feature_ingress: { const: 'absent' },
      api_ingress: { const: 'absent' },
      automation_ingress: { const: 'absent' },
      active_registry_mutation: { const: 'forbidden' },
      active_release_pointer_mutation: { const: 'forbidden' },
      production_data_root_access: { const: 'forbidden' },
      user_data_access: { const: 'forbidden' },
    }),
    bootstrap_implementation_hash: hashSchema,
  }),
};

export const G4_FAKE_ADAPTER_INVOCATION_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:workflow-test-fake-adapter-invocation:1',
  ...closedObject({
    format: { const: 'icarus.workflow-test-fake-adapter-invocation/1' },
    fixture_id: { type: 'string', minLength: 1 },
    operation_key: { type: 'string', minLength: 1 },
    attempt_no: { type: 'integer', minimum: 1 },
    input: closedObject({
      fixture: { type: 'string', minLength: 1 },
      payload: closedObject({
        sequence: { type: 'integer', minimum: 1, maximum: 7 },
        value: { enum: [...G4_FAKE_ADAPTER_OUTCOMES] },
      }),
    }),
    invocation_hash: hashSchema,
  }),
  oneOf: g4FakeAdapterBehaviors().map(({ invocation }) => ({
    properties: {
      fixture_id: { const: invocation.fixture_id },
      operation_key: { const: invocation.operation_key },
      attempt_no: { const: invocation.attempt_no },
      input: { const: invocation.input },
      invocation_hash: { const: invocation.invocation_hash },
    },
  })),
};

export const G4_FAKE_ADAPTER_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:workflow-test-fake-adapter-result:1',
  ...closedObject({
    format: { const: 'icarus.workflow-test-fake-adapter-result/1' },
    fixture_id: { type: 'string', minLength: 1 },
    operation_key: { type: 'string', minLength: 1 },
    attempt_no: { type: 'integer', minimum: 1 },
    outcome: { enum: [...G4_FAKE_ADAPTER_OUTCOMES] },
    receipt: { type: ['object', 'null'] },
    result: { type: 'object' },
    replay_hash: hashSchema,
  }),
  oneOf: g4FakeAdapterBehaviors().map(({ response }) => ({
    properties: {
      fixture_id: { const: response.fixture_id },
      operation_key: { const: response.operation_key },
      attempt_no: { const: response.attempt_no },
      outcome: { const: response.outcome },
      receipt: { const: response.receipt },
      result: { const: response.result },
      replay_hash: { const: response.replay_hash },
    },
  })),
};

export const G4_ISOLATION_RECEIPT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:workflow-test-bootstrap-isolation-receipt:1',
  ...closedObject({
    format: { const: 'icarus.workflow-test-bootstrap-isolation-receipt/1' },
    instance_id: { type: 'string', minLength: 1 },
    profile_ref: versionedRefSchema,
    profile_hash: hashSchema,
    fixture_set_ref: versionedRefSchema,
    fixture_set_hash: hashSchema,
    fake_adapter_profile_hash: hashSchema,
    virtual_clock_profile_hash: hashSchema,
    bootstrap_implementation_hash: hashSchema,
    canonical_data_root: { type: 'string', minLength: 1 },
    database_path: { type: 'string', minLength: 1 },
    owner_marker_hash: hashSchema,
    root_device: { type: 'string', minLength: 1 },
    root_inode: { type: 'string', minLength: 1 },
    database_device: { type: 'string', minLength: 1 },
    database_inode: { type: 'string', minLength: 1 },
    database_schema_version: { const: 6 },
    database_schema_hash: hashSchema,
    sqlite_profile_hash: hashSchema,
    production_surface_absence_hash: hashSchema,
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
  }),
};

function artifact<T extends JsonObject>(
  format: string,
  ref: string,
  domainSeparator: string,
  payload: T,
  version = 1,
): ContractArtifactEnvelope<T> {
  const withoutHash = {
    format,
    ref: { id: ref, version: `${version}.0.0` },
    version,
    domain_separator: domainSeparator,
    payload,
  };
  return {
    ...withoutHash,
    hash: calculateArtifactHash(withoutHash as ContractArtifactEnvelope<T>),
  };
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function absolute(relativePath: string): string {
  const result = path.resolve(contractsRoot, relativePath);
  if (!result.startsWith(`${contractsRoot}${path.sep}`))
    throw new Error(`G4 Contract path escapes root: ${relativePath}`);
  return result;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(relativePath: string, value: JsonValue): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, render(value), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function buildG4BootstrapImplementationPayload(
  sourceRepoRoot: string,
): JsonObject {
  assertG4TestBootstrapIsolation(sourceRepoRoot);
  const files = G4_BOOTSTRAP_SOURCE_PATHS.map((relativePath) => ({
    path: relativePath,
    raw_sha256: rawSha256(
      fs.readFileSync(path.join(sourceRepoRoot, relativePath)),
    ),
  }));
  return {
    format: 'icarus.workflow-test-bootstrap-implementation/1',
    source_files: files,
    source_file_count: files.length,
    implementation_hash: domainSeparatedSha256(domains.implementation, {
      source_files: files,
      source_file_count: files.length,
    }),
  };
}

function upstreamIdentity(): JsonObject {
  const inputs = loadFrozenWorkflowRuntimeStoreInputs();
  const sealed = readArtifact(
    G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_ref,
  );
  const distribution = strictParseJsonBytes(
    fs.readFileSync(
      path.join(contractsRoot, 'toolchain/node-v26.5.0-darwin-arm64.json'),
    ),
  ) as JsonObject;
  const sealedBundleHash = parseSha256Hash(sealed.payload.bundle_hash);
  if (
    sealed.hash !==
      G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_artifact_hash ||
    sealedBundleHash !== G3_CURRENT_UPSTREAM_IDENTITY.g2_sealed_bundle_hash
  ) {
    throw new Error('G4 G2 sealed successor identity drifted');
  }
  if (
    inputs.g1RootHash !== G39_UPSTREAM_IDENTITIES.g1_root_hash ||
    inputs.schemaHash !== G39_UPSTREAM_IDENTITIES.database_schema_hash ||
    inputs.migrationSha256 !== G39_UPSTREAM_IDENTITIES.schema6_migration_hash ||
    inputs.schema3To4UpgradeSha256 !==
      G39_UPSTREAM_IDENTITIES.schema3_to_4_upgrade_hash ||
    inputs.schema4To5UpgradeSha256 !==
      G39_UPSTREAM_IDENTITIES.schema4_to_5_upgrade_hash ||
    inputs.schema5To6UpgradeSha256 !==
      G39_UPSTREAM_IDENTITIES.schema5_to_6_upgrade_hash
  ) {
    throw new Error('G4 G1 Store identity drifted');
  }
  if (
    checkG3RetentionExecutorAbiPreflight().hash !==
      G39_UPSTREAM_IDENTITIES.g3_6_pack_hash ||
    checkG37WorkflowPublisherContracts().hash !==
      G39_UPSTREAM_IDENTITIES.g3_7_pack_hash ||
    checkG38AActivationContractRepair().hash !==
      G39_UPSTREAM_IDENTITIES.g3_8a_pack_hash ||
    checkG39FeatureReleaseActivationContracts().hash !== CURRENT_G3_9_PACK_HASH
  ) {
    throw new Error('G4 G3 upstream Contract identity drifted');
  }
  return {
    node_runtime_version: '26.5.0',
    npm_version: '11.17.0',
    package_lock_hash: rawSha256(
      fs.readFileSync(path.join(repoRoot, 'package-lock.json')),
    ),
    managed_distribution_ref: distribution.ref as JsonValue,
    managed_distribution_hash: parseSha256Hash(distribution.manifest_hash),
    node_executable_hash: parseSha256Hash(distribution.node_executable_sha256),
    compiler_toolchain_ref:
      G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_toolchain_manifest_ref,
    compiler_toolchain_hash:
      G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_toolchain_hash,
    compiler_build_hash:
      G3_CURRENT_UPSTREAM_IDENTITY.compiler.compiler_build_hash,
    g1_root_hash: inputs.g1RootHash,
    schema_dependency_manifest_hash:
      inputs.schemaDependencyManifestArtifactHash,
    physical_schema_identity: inputs.physicalSchemaIdentity,
    database_schema_hash: inputs.schemaHash,
    migration_hash: inputs.migrationSha256,
    schema3_to_4_upgrade_hash: inputs.schema3To4UpgradeSha256,
    schema4_to_5_upgrade_hash: inputs.schema4To5UpgradeSha256,
    schema5_to_6_upgrade_hash: inputs.schema5To6UpgradeSha256,
    sqlite_profile_ref: {
      id: 'icarus.local-single-user-sqlite',
      version: '1.0.0',
    },
    sqlite_profile_hash: inputs.profileArtifactHash,
    g2_sealed_bundle_hash: sealedBundleHash,
    g3_6_pack_hash: G39_UPSTREAM_IDENTITIES.g3_6_pack_hash,
    g3_7_pack_hash: G39_UPSTREAM_IDENTITIES.g3_7_pack_hash,
    g3_8a_pack_hash: G39_UPSTREAM_IDENTITIES.g3_8a_pack_hash,
    g3_9_pack_hash: CURRENT_G3_9_PACK_HASH,
  };
}

interface BuiltLeafArtifacts {
  artifacts: Array<[string, ContractArtifactEnvelope]>;
  profile: ContractArtifactEnvelope<G4TestBootstrapProfile>;
  fixtureSet: ContractArtifactEnvelope;
  fakeAdapterProfile: ContractArtifactEnvelope;
  virtualClockProfile: ContractArtifactEnvelope;
  implementation: ContractArtifactEnvelope;
  isolationBoundary: ContractArtifactEnvelope;
}

function buildLeafArtifacts(): BuiltLeafArtifacts {
  const upstream = upstreamIdentity();
  const schemas: Array<[string, ContractArtifactEnvelope]> = [
    [
      paths.profileSchema,
      artifact(
        'icarus.workflow-test-bootstrap-profile-schema/1',
        'icarus.workflow-test-bootstrap-profile-schema',
        domains.profileSchema,
        G4_TEST_BOOTSTRAP_PROFILE_SCHEMA,
      ),
    ],
    [
      paths.fakeInvocationSchema,
      artifact(
        'icarus.workflow-test-fake-adapter-invocation-schema/1',
        'icarus.workflow-test-fake-adapter-invocation-schema',
        domains.fakeInvocationSchema,
        G4_FAKE_ADAPTER_INVOCATION_SCHEMA,
      ),
    ],
    [
      paths.fakeResultSchema,
      artifact(
        'icarus.workflow-test-fake-adapter-result-schema/1',
        'icarus.workflow-test-fake-adapter-result-schema',
        domains.fakeResultSchema,
        G4_FAKE_ADAPTER_RESULT_SCHEMA,
      ),
    ],
    [
      paths.receiptSchema,
      artifact(
        'icarus.workflow-test-bootstrap-isolation-receipt-schema/1',
        'icarus.workflow-test-bootstrap-isolation-receipt-schema',
        domains.receiptSchema,
        G4_ISOLATION_RECEIPT_SCHEMA,
      ),
    ],
  ];
  const fixtureSet = artifact(
    'icarus.workflow-test-bootstrap-fixture-set/1',
    G4_TEST_BOOTSTRAP_FIXTURE_SET_REF.id,
    domains.fixtureSet,
    g4FixtureSet(),
  );
  const fakeAdapterProfile = artifact(
    'icarus.workflow-test-fake-adapter-profile/1',
    G4_FAKE_ADAPTER_PROFILE_REF.id,
    domains.fakeAdapterProfile,
    {
      format: 'icarus.workflow-test-fake-adapter-profile/1',
      ref: { ...G4_FAKE_ADAPTER_PROFILE_REF },
      selection: 'exact_invocation_hash_only',
      allowed_outcomes: [...G4_FAKE_ADAPTER_OUTCOMES],
      behavior_count: g4FakeAdapterBehaviors().length,
      behaviors: g4FakeAdapterBehaviors(),
      replay: 'same_invocation_same_result_bytes',
      undeclared_invocation: 'reject',
      undeclared_outcome: 'reject',
      real_adapter_allowed: false,
      network_allowed: false,
    },
  );
  const virtualClockProfile = artifact(
    'icarus.workflow-test-virtual-clock-profile/1',
    G4_VIRTUAL_CLOCK_PROFILE_REF.id,
    domains.virtualClockProfile,
    g4VirtualClockProfile(),
  );
  const implementation = artifact(
    'icarus.workflow-test-bootstrap-implementation-artifact/1',
    'icarus.workflow-test-bootstrap-implementation',
    domains.implementationArtifact,
    buildG4BootstrapImplementationPayload(repoRoot),
  );
  const isolationBoundary = artifact(
    'icarus.workflow-test-bootstrap-isolation-boundary/2',
    'icarus.workflow-test-bootstrap-isolation-boundary',
    domains.isolationBoundary,
    g4IsolationBoundaryPayload(repoRoot),
    2,
  );
  const implementationHash = parseSha256Hash(
    implementation.payload.implementation_hash,
  );
  const profilePayload: G4TestBootstrapProfile = {
    format: 'icarus.workflow-test-bootstrap-profile/1',
    ref: { ...G4_TEST_BOOTSTRAP_PROFILE_REF },
    gate: 'G4',
    profile_kind: 'test_only',
    selection: 'explicit_exact_ref_and_hash',
    default_enabled: false,
    certification_status: 'not_certified',
    production_acceptance: 'reject',
    production_rejection_code: 'test_bootstrap_profile_forbidden',
    managed_toolchain: {
      node_runtime_version: upstream.node_runtime_version!,
      npm_version: upstream.npm_version!,
      package_lock_hash: upstream.package_lock_hash!,
      managed_distribution_ref: upstream.managed_distribution_ref!,
      managed_distribution_hash: upstream.managed_distribution_hash!,
      node_executable_hash: upstream.node_executable_hash!,
      compiler_toolchain_ref: upstream.compiler_toolchain_ref!,
      compiler_toolchain_hash: upstream.compiler_toolchain_hash!,
      compiler_build_hash: upstream.compiler_build_hash!,
    },
    store_binding: {
      connection_factory: 'WorkflowRuntimeConnectionFactory',
      identity_mode: 'candidate_development',
      database_name: 'workflow-runtime.db',
      database_schema_version: 6,
      g1_root_hash: upstream.g1_root_hash!,
      schema_dependency_manifest_hash:
        upstream.schema_dependency_manifest_hash!,
      physical_schema_identity: upstream.physical_schema_identity!,
      database_schema_hash: upstream.database_schema_hash!,
      migration_hash: upstream.migration_hash!,
      schema3_to_4_upgrade_hash: upstream.schema3_to_4_upgrade_hash!,
      schema4_to_5_upgrade_hash: upstream.schema4_to_5_upgrade_hash!,
      schema5_to_6_upgrade_hash: upstream.schema5_to_6_upgrade_hash!,
      sqlite_profile_ref: upstream.sqlite_profile_ref!,
      sqlite_profile_hash: upstream.sqlite_profile_hash!,
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
    },
    upstream_contracts: {
      g2_sealed_bundle_hash: upstream.g2_sealed_bundle_hash!,
      g3_6_pack_hash: upstream.g3_6_pack_hash!,
      g3_7_pack_hash: upstream.g3_7_pack_hash!,
      g3_8a_pack_hash: upstream.g3_8a_pack_hash!,
      g3_9_pack_hash: upstream.g3_9_pack_hash!,
    },
    fixture_set: {
      ref: { ...G4_TEST_BOOTSTRAP_FIXTURE_SET_REF },
      hash: fixtureSet.hash,
    },
    fake_adapter: {
      ref: { ...G4_FAKE_ADAPTER_PROFILE_REF },
      hash: fakeAdapterProfile.hash,
      outcome_count: G4_FAKE_ADAPTER_OUTCOMES.length,
      real_adapter_allowed: false,
      network_allowed: false,
    },
    virtual_clock: {
      ref: { ...G4_VIRTUAL_CLOCK_PROFILE_REF },
      hash: virtualClockProfile.hash,
      seed: g4VirtualClockProfile().seed,
      initial_time_ms: g4VirtualClockProfile().initial_time_ms,
      authority: 'virtual_only',
    },
    root_policy: {
      root_kind: 'unique_canonical_os_temp_child',
      create_mode: 'exclusive_new_directory',
      preexisting_root: 'reject',
      nonempty_root: 'reject',
      symlink_or_alias: 'reject',
      cross_instance_reuse: 'reject',
      production_root_collision: 'reject',
      cleanup: 'close_store_then_remove_owned_root',
      cleanup_failure: 'write_identifiable_residual_marker',
    },
    isolation_boundary: {
      hash: isolationBoundary.hash,
      feature_ingress: 'absent',
      api_ingress: 'absent',
      automation_ingress: 'absent',
      active_registry_mutation: 'forbidden',
      active_release_pointer_mutation: 'forbidden',
      production_data_root_access: 'forbidden',
      user_data_access: 'forbidden',
    },
    bootstrap_implementation_hash: implementationHash,
  };
  const profile = artifact(
    'icarus.workflow-test-bootstrap-profile/1',
    G4_TEST_BOOTSTRAP_PROFILE_REF.id,
    domains.profile,
    profilePayload,
  );
  const fixtures: Array<[string, ContractArtifactEnvelope]> = [
    [
      paths.positive,
      artifact(
        'icarus.workflow-test-bootstrap-positive-cases/1',
        'icarus.workflow-test-bootstrap-positive-cases',
        domains.positive,
        { fixture_scope: 'test_only', cases: g4PositiveCases() },
      ),
    ],
    [
      paths.negative,
      artifact(
        'icarus.workflow-test-bootstrap-negative-cases/1',
        'icarus.workflow-test-bootstrap-negative-cases',
        domains.negative,
        { fixture_scope: 'test_only', cases: g4NegativeCases() },
      ),
    ],
    [
      paths.fault,
      artifact(
        'icarus.workflow-test-bootstrap-fault-cases/1',
        'icarus.workflow-test-bootstrap-fault-cases',
        domains.fault,
        { fixture_scope: 'test_only_real_file_sqlite', cases: g4FaultCases() },
      ),
    ],
  ];
  const artifacts = [
    ...schemas,
    [paths.fixtureSet, fixtureSet] as [string, ContractArtifactEnvelope],
    [paths.fakeAdapterProfile, fakeAdapterProfile] as [
      string,
      ContractArtifactEnvelope,
    ],
    [paths.virtualClockProfile, virtualClockProfile] as [
      string,
      ContractArtifactEnvelope,
    ],
    [paths.implementation, implementation] as [
      string,
      ContractArtifactEnvelope,
    ],
    [paths.isolationBoundary, isolationBoundary] as [
      string,
      ContractArtifactEnvelope,
    ],
    [paths.profile, profile] as [string, ContractArtifactEnvelope],
    ...fixtures,
  ];
  const domainEntries = [
    ...artifacts.map(([, entry]) => ({
      format: entry.format,
      domain_separator: entry.domain_separator,
    })),
    {
      format: 'icarus.workflow-test-fake-adapter-invocation/1',
      domain_separator: G4_FAKE_ADAPTER_INVOCATION_DOMAIN,
    },
    {
      format: 'icarus.workflow-test-fake-adapter-result/1',
      domain_separator: G4_FAKE_ADAPTER_RESULT_DOMAIN,
    },
    {
      format: 'icarus.workflow-test-bootstrap-implementation/1',
      domain_separator: domains.implementation,
    },
    {
      format: 'icarus.workflow-test-bootstrap-isolation-receipt/1',
      domain_separator: 'icarus:workflow-test-bootstrap-isolation-receipt:1\n',
    },
  ].sort((left, right) =>
    left.format < right.format ? -1 : left.format > right.format ? 1 : 0,
  );
  artifacts.push([
    paths.domains,
    artifact(
      'icarus.workflow-test-bootstrap-domain-separators/1',
      'icarus.workflow-test-bootstrap-domain-separators',
      domains.domains,
      { entries: domainEntries },
    ),
  ]);
  return {
    artifacts,
    profile,
    fixtureSet,
    fakeAdapterProfile,
    virtualClockProfile,
    implementation,
    isolationBoundary,
  };
}

function buildManifest(built: BuiltLeafArtifacts): ContractArtifactEnvelope {
  return artifact(
    'icarus.workflow-contract-pack-g4-test-bootstrap/1',
    'icarus.workflow-contract-pack-g4-test-bootstrap',
    domains.manifest,
    {
      gate: 'G4',
      status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_G4_REGRESSION',
      profile_ref: built.profile.ref,
      profile_hash: built.profile.hash,
      fixture_set_ref: built.fixtureSet.ref,
      fixture_set_hash: built.fixtureSet.hash,
      fake_adapter_profile_ref: built.fakeAdapterProfile.ref,
      fake_adapter_profile_hash: built.fakeAdapterProfile.hash,
      virtual_clock_profile_ref: built.virtualClockProfile.ref,
      virtual_clock_profile_hash: built.virtualClockProfile.hash,
      bootstrap_implementation_hash:
        built.implementation.payload.implementation_hash!,
      isolation_boundary_hash: built.isolationBoundary.hash,
      positive_case_count: g4PositiveCases().length,
      negative_case_count: g4NegativeCases().length,
      fault_case_count: g4FaultCases().length,
      fake_adapter_outcome_count: G4_FAKE_ADAPTER_OUTCOMES.length,
      fake_adapter_outcomes: [...G4_FAKE_ADAPTER_OUTCOMES],
      database_schema_version: 6,
      database_schema_hash: G39_UPSTREAM_IDENTITIES.database_schema_hash,
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
      explicit_selection_required: true,
      production_build_acceptance: 'reject',
      production_startup_acceptance: 'reject',
      production_loader_g4_consumption: 'rejected',
      production_startup_g4_consumption: 'rejected',
      production_fail_closed_evidence:
        'structured_source_ownership_and_live_ast_import_graph',
      feature_ingress_g4_reachability: 'unreachable',
      api_ingress_g4_reachability: 'unreachable',
      automation_ingress_g4_reachability: 'unreachable',
      runtime_business_tables_written: false,
      g5_status:
        'BLOCKED_BY_SPEC_NOT_READY_PENDING_GENERATED_SCHEMA_JOIN_AUTHORITY_AFFECTED_CHAIN_REGRESSION',
      g6_through_g9_status: 'NOT_READY',
      artifacts: built.artifacts.map(([artifactPath, entry]) => ({
        path: artifactPath,
        format: entry.format,
        ref: entry.ref,
        version: entry.version,
        domain_separator: entry.domain_separator,
        hash: entry.hash,
      })),
    },
  );
}

function validators(): {
  profile: ReturnType<Ajv2020['compile']>;
  invocation: ReturnType<Ajv2020['compile']>;
  result: ReturnType<Ajv2020['compile']>;
  receipt: ReturnType<Ajv2020['compile']>;
} {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  return {
    profile: ajv.compile(G4_TEST_BOOTSTRAP_PROFILE_SCHEMA as AnySchema),
    invocation: ajv.compile(G4_FAKE_ADAPTER_INVOCATION_SCHEMA as AnySchema),
    result: ajv.compile(G4_FAKE_ADAPTER_RESULT_SCHEMA as AnySchema),
    receipt: ajv.compile(G4_ISOLATION_RECEIPT_SCHEMA as AnySchema),
  };
}

function validateBuilt(
  built: BuiltLeafArtifacts,
  manifest: ContractArtifactEnvelope,
): void {
  const validate = validators();
  if (!validate.profile(built.profile.payload))
    throw new Error(
      `G4 profile schema rejection: ${JSON.stringify(validate.profile.errors)}`,
    );
  for (const behavior of g4FakeAdapterBehaviors()) {
    if (!validate.invocation(behavior.invocation))
      throw new Error(
        `G4 Fake Adapter invocation schema rejection: ${JSON.stringify(validate.invocation.errors)}`,
      );
    if (!validate.result(behavior.response))
      throw new Error(
        `G4 Fake Adapter result schema rejection: ${JSON.stringify(validate.result.errors)}`,
      );
  }
  for (const [, entry] of built.artifacts) parseContractArtifactEnvelope(entry);
  parseContractArtifactEnvelope(manifest);
  const fixtureIds = built.fixtureSet.payload.fixture_ids;
  if (!Array.isArray(fixtureIds) || fixtureIds.length !== 7)
    throw new Error(
      'G4 fixture set no longer covers all seven closed outcomes',
    );
  if (
    built.profile.payload.bootstrap_implementation_hash !==
      built.implementation.payload.implementation_hash ||
    built.profile.payload.isolation_boundary?.hash !==
      built.isolationBoundary.hash
  ) {
    throw new Error('G4 profile implementation/isolation identity drifted');
  }
  const store = built.profile.payload.store_binding as JsonObject;
  const upstream = built.profile.payload.upstream_contracts as JsonObject;
  if (
    store.g1_root_hash !== G39_UPSTREAM_IDENTITIES.g1_root_hash ||
    store.database_schema_hash !==
      G39_UPSTREAM_IDENTITIES.database_schema_hash ||
    store.migration_hash !== G39_UPSTREAM_IDENTITIES.schema6_migration_hash ||
    store.schema3_to_4_upgrade_hash !==
      G39_UPSTREAM_IDENTITIES.schema3_to_4_upgrade_hash ||
    store.schema4_to_5_upgrade_hash !==
      G39_UPSTREAM_IDENTITIES.schema4_to_5_upgrade_hash ||
    store.schema5_to_6_upgrade_hash !==
      G39_UPSTREAM_IDENTITIES.schema5_to_6_upgrade_hash ||
    upstream.g2_sealed_bundle_hash !==
      G39_UPSTREAM_IDENTITIES.g2_sealed_bundle_hash ||
    upstream.g3_6_pack_hash !== G39_UPSTREAM_IDENTITIES.g3_6_pack_hash ||
    upstream.g3_7_pack_hash !== G39_UPSTREAM_IDENTITIES.g3_7_pack_hash ||
    upstream.g3_8a_pack_hash !== G39_UPSTREAM_IDENTITIES.g3_8a_pack_hash ||
    upstream.g3_9_pack_hash !== CURRENT_G3_9_PACK_HASH
  ) {
    throw new Error('G4 profile upstream identity drifted');
  }
}

export interface G4TestBootstrapContractSet {
  readonly pack: ContractArtifactEnvelope;
  readonly profile: ContractArtifactEnvelope<G4TestBootstrapProfile>;
  readonly fixtureSet: ContractArtifactEnvelope;
  readonly fakeAdapterProfile: ContractArtifactEnvelope;
  readonly virtualClockProfile: ContractArtifactEnvelope;
  readonly implementation: ContractArtifactEnvelope;
  readonly isolationBoundary: ContractArtifactEnvelope;
}

function buildContractSet(): G4TestBootstrapContractSet & {
  artifacts: Array<[string, ContractArtifactEnvelope]>;
} {
  const built = buildLeafArtifacts();
  const pack = buildManifest(built);
  validateBuilt(built, pack);
  return { ...built, pack };
}

export function generateG4TestBootstrapContracts(): G4TestBootstrapContractSet {
  const built = buildContractSet();
  for (const [file, entry] of built.artifacts) writeAtomic(file, entry);
  writeAtomic(paths.manifest, built.pack);
  return built;
}

export function checkG4TestBootstrapContracts(): G4TestBootstrapContractSet {
  const built = buildContractSet();
  for (const [file, entry] of built.artifacts) {
    if (fs.readFileSync(absolute(file), 'utf8') !== render(entry))
      throw new Error(`G4 Contract artifact bytes drift: ${file}`);
  }
  if (fs.readFileSync(absolute(paths.manifest), 'utf8') !== render(built.pack))
    throw new Error('G4 Contract Pack manifest bytes drift');
  return built;
}

export function validateG4TestBootstrapProfile(value: unknown): void {
  const validate = validators().profile;
  if (!validate(value))
    throw new Error(
      `G4 Test Bootstrap Profile is invalid: ${JSON.stringify(validate.errors)}`,
    );
  const expected = buildContractSet().profile;
  if (
    calculateArtifactHash({
      format: 'icarus.workflow-test-bootstrap-profile/1',
      ref: { ...G4_TEST_BOOTSTRAP_PROFILE_REF },
      version: 1,
      domain_separator: domains.profile,
      payload: value as JsonObject,
      hash: expected.hash,
    }) !== expected.hash
  ) {
    throw new Error('G4 Test Bootstrap Profile identity mismatch');
  }
}

export function validateG4IsolationReceipt(value: unknown): G4IsolationReceipt {
  const validate = validators().receipt;
  if (!validate(value)) {
    throw new Error(
      `G4 isolation receipt is invalid: ${JSON.stringify(validate.errors)}`,
    );
  }
  const receipt = structuredClone(value) as G4IsolationReceipt;
  const { receipt_hash: receiptHash, ...payload } = receipt;
  if (
    receiptHash !==
    domainSeparatedSha256(
      'icarus:workflow-test-bootstrap-isolation-receipt:1\n',
      payload,
    )
  ) {
    throw new Error('G4 isolation receipt hash mismatch');
  }
  const expected = buildContractSet();
  const storeBinding = expected.profile.payload.store_binding as JsonObject;
  if (
    receipt.profile_ref.id !== expected.profile.ref.id ||
    receipt.profile_ref.version !== expected.profile.ref.version ||
    receipt.profile_hash !== expected.profile.hash ||
    receipt.fixture_set_ref.id !== expected.fixtureSet.ref.id ||
    receipt.fixture_set_ref.version !== expected.fixtureSet.ref.version ||
    receipt.fixture_set_hash !== expected.fixtureSet.hash ||
    receipt.fake_adapter_profile_hash !== expected.fakeAdapterProfile.hash ||
    receipt.virtual_clock_profile_hash !== expected.virtualClockProfile.hash ||
    receipt.bootstrap_implementation_hash !==
      expected.profile.payload.bootstrap_implementation_hash ||
    receipt.database_schema_hash !== storeBinding.database_schema_hash ||
    receipt.sqlite_profile_hash !== storeBinding.sqlite_profile_hash ||
    receipt.production_surface_absence_hash !== expected.isolationBoundary.hash
  ) {
    throw new Error('G4 isolation receipt Contract identity mismatch');
  }
  return receipt;
}

export function assertG4ProfileRejectedForProduction(
  surface: 'build' | 'startup' | 'loader',
  profile: unknown,
): never {
  validateG4TestBootstrapProfile(profile);
  throw new Error(
    `test_bootstrap_profile_forbidden: production ${surface} rejects the non-certified G4 profile`,
  );
}

export function g4ContractCountsForTest(): {
  positive: number;
  negative: number;
  fault: number;
} {
  return {
    positive: g4PositiveCases().length,
    negative: g4NegativeCases().length,
    fault: g4FaultCases().length,
  };
}
