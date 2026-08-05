import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import {
  checkG4TestBootstrapContracts,
  type G4TestBootstrapContractSet,
  validateG4IsolationReceipt,
} from '../contracts/g4-test-bootstrap-contract.js';
import { g4FakeAdapterBehaviors } from '../contracts/g4-test-bootstrap-fixtures.js';
import {
  G4_TEST_BOOTSTRAP_FIXTURE_SET_REF,
  G4_TEST_BOOTSTRAP_PROFILE_REF,
  type G4IsolationReceipt,
  type G4TestBootstrapProfile,
  type G4VirtualClockProfile,
} from '../contracts/g4-test-bootstrap-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';
import { CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION } from '../store/runtime-store/config.js';
import { G4FakeAdapter } from './fake-adapter.js';
import { G4VirtualClock } from './virtual-clock.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const ownerMarkerName = '.g4-test-bootstrap-owner.json';
const isolationReceiptName = 'g4-test-bootstrap-isolation-receipt.json';
const failureMarkerName = '.g4-test-bootstrap-failed.json';
const ownerMarkerDomain = 'icarus:workflow-test-bootstrap-owner-marker:1\n';
const instanceDomain = 'icarus:workflow-test-bootstrap-instance:1\n';
const rootNameDomain = 'icarus:workflow-test-bootstrap-data-root-name:1\n';
const receiptDomain = 'icarus:workflow-test-bootstrap-isolation-receipt:1\n';

export type G4BootstrapFaultInjection =
  | 'root_create_failure'
  | 'root_permission_denied'
  | 'store_open_failure'
  | 'interrupt_after_root_create'
  | 'interrupt_after_store_open'
  | 'cleanup_failure';

export interface G4TestBootstrapSelector {
  readonly profileRef: VersionedRef;
  readonly profileHash: Sha256Hash;
  readonly fixtureSetRef: VersionedRef;
  readonly fixtureSetHash: Sha256Hash;
}

export interface CreateG4TestBootstrapOptions extends G4TestBootstrapSelector {
  readonly instanceKey: string;
  readonly dataRoot: string;
  readonly faultInjection?: G4BootstrapFaultInjection;
}

export class G4TestBootstrapError extends Error {
  constructor(
    readonly code:
      | 'bootstrap_options_invalid'
      | 'profile_selection_mismatch'
      | 'fixture_selection_mismatch'
      | 'data_root_invalid'
      | 'data_root_not_temporary'
      | 'data_root_symlink_or_alias'
      | 'data_root_preexisting'
      | 'data_root_preexisting_nonempty'
      | 'production_root_collision'
      | 'data_root_create_failed'
      | 'data_root_permission_denied'
      | 'store_open_failed'
      | 'initialization_interrupted'
      | 'isolation_proof_failed'
      | 'instance_closed'
      | 'cleanup_failed_with_residual',
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'G4TestBootstrapError';
  }
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function assertExactOptions(options: CreateG4TestBootstrapOptions): void {
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new G4TestBootstrapError(
      'bootstrap_options_invalid',
      'G4 bootstrap requires an explicit closed options object',
    );
  }
  const required = [
    'dataRoot',
    'fixtureSetHash',
    'fixtureSetRef',
    'instanceKey',
    'profileHash',
    'profileRef',
  ];
  const allowed = new Set([...required, 'faultInjection']);
  const keys = Object.keys(options);
  if (
    required.some((key) => !Object.hasOwn(options, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.instanceKey)
  ) {
    throw new G4TestBootstrapError(
      'bootstrap_options_invalid',
      'G4 bootstrap requires the exact explicit selector, instance key, and data root',
    );
  }
}

export function currentG4TestBootstrapSelector(): G4TestBootstrapSelector {
  const contracts = checkG4TestBootstrapContracts();
  return {
    profileRef: { ...contracts.profile.ref },
    profileHash: contracts.profile.hash,
    fixtureSetRef: { ...contracts.fixtureSet.ref },
    fixtureSetHash: contracts.fixtureSet.hash,
  };
}

export function deriveG4TestDataRoot(
  canonicalTemporaryParent: string,
  instanceKey: string,
): string {
  const suffix = domainSeparatedSha256(rootNameDomain, {
    instance_key: instanceKey,
  }).slice('sha256:'.length, 'sha256:'.length + 24);
  return path.join(
    canonicalTemporaryParent,
    `icarus-workflow-runtime-g4-${suffix}`,
  );
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return pathContains(left, right) || pathContains(right, left);
}

function existingRootError(root: string): G4TestBootstrapError {
  try {
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) {
      return new G4TestBootstrapError(
        'data_root_symlink_or_alias',
        'G4 data root must not be a symbolic link',
      );
    }
    const entries = stat.isDirectory() ? fs.readdirSync(root) : ['not-dir'];
    return new G4TestBootstrapError(
      entries.length === 0
        ? 'data_root_preexisting'
        : 'data_root_preexisting_nonempty',
      `G4 refuses a pre-existing data root: ${root}`,
    );
  } catch (error) {
    return new G4TestBootstrapError(
      'data_root_create_failed',
      `G4 data root appeared concurrently but could not be inspected: ${root}`,
      { cause: error },
    );
  }
}

function rootCreateError(root: string, error: unknown): G4TestBootstrapError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EEXIST') return existingRootError(root);
  if (code === 'EACCES' || code === 'EPERM') {
    return new G4TestBootstrapError(
      'data_root_permission_denied',
      `G4 data root creation was denied: ${root}`,
      { cause: error },
    );
  }
  return new G4TestBootstrapError(
    'data_root_create_failed',
    `G4 data root creation failed: ${root}`,
    { cause: error },
  );
}

function productionRoots(): string[] {
  return [
    path.resolve(repoRoot, 'data/workflow-runtime'),
    path.resolve(
      os.homedir(),
      'Library/Application Support/Icarus/data/workflow-runtime',
    ),
  ];
}

function validateRequestedRoot(options: CreateG4TestBootstrapOptions): string {
  if (!path.isAbsolute(options.dataRoot)) {
    throw new G4TestBootstrapError(
      'data_root_invalid',
      'G4 data root must be an absolute path',
    );
  }
  const requested = path.resolve(options.dataRoot);
  if (options.dataRoot !== requested) {
    throw new G4TestBootstrapError(
      'data_root_symlink_or_alias',
      'G4 data root must use its absolute normalized lexical form',
    );
  }
  if (productionRoots().some((root) => pathsOverlap(root, requested))) {
    throw new G4TestBootstrapError(
      'production_root_collision',
      `G4 data root collides with a protected production root: ${requested}`,
    );
  }
  const parent = path.dirname(requested);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new G4TestBootstrapError(
      'data_root_invalid',
      `G4 data root parent does not exist: ${parent}`,
    );
  }
  const canonicalParent = fs.realpathSync(parent);
  if (canonicalParent !== parent) {
    throw new G4TestBootstrapError(
      'data_root_symlink_or_alias',
      `G4 data root parent is not canonical: ${parent}`,
    );
  }
  const canonicalTemp = fs.realpathSync(os.tmpdir());
  if (!pathContains(canonicalTemp, requested) || requested === canonicalTemp) {
    throw new G4TestBootstrapError(
      'data_root_not_temporary',
      `G4 data root must be an isolated child of ${canonicalTemp}`,
    );
  }
  if (
    requested !== deriveG4TestDataRoot(canonicalParent, options.instanceKey)
  ) {
    throw new G4TestBootstrapError(
      'data_root_invalid',
      'G4 data root does not match the deterministic instance root name',
    );
  }
  if (fs.existsSync(requested)) {
    throw existingRootError(requested);
  }
  if ((fs.statSync(parent).mode & 0o222) === 0) {
    throw new G4TestBootstrapError(
      'data_root_permission_denied',
      `G4 data root parent is not writable: ${parent}`,
    );
  }
  return requested;
}

function assertSelection(
  options: CreateG4TestBootstrapOptions,
  contracts: G4TestBootstrapContractSet,
): void {
  if (
    !sameRef(options.profileRef, contracts.profile.ref) ||
    options.profileHash !== contracts.profile.hash ||
    !sameRef(options.profileRef, G4_TEST_BOOTSTRAP_PROFILE_REF)
  ) {
    throw new G4TestBootstrapError(
      'profile_selection_mismatch',
      'G4 bootstrap requires the exact current test-only profile ref/hash',
    );
  }
  if (
    !sameRef(options.fixtureSetRef, contracts.fixtureSet.ref) ||
    options.fixtureSetHash !== contracts.fixtureSet.hash ||
    !sameRef(options.fixtureSetRef, G4_TEST_BOOTSTRAP_FIXTURE_SET_REF)
  ) {
    throw new G4TestBootstrapError(
      'fixture_selection_mismatch',
      'G4 bootstrap requires the exact registered fixture set ref/hash',
    );
  }
}

function writeExclusive(file: string, value: JsonValue): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function writeResidual(root: string, instanceId: string, error: unknown): void {
  const marker = {
    format: 'icarus.workflow-test-bootstrap-failed-residual/1',
    instance_id: instanceId,
    cleanup_required: true,
    failure_code:
      error instanceof G4TestBootstrapError ? error.code : 'unexpected_failure',
  };
  fs.writeFileSync(
    path.join(root, failureMarkerName),
    `${JSON.stringify(marker, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

function assertOwnedRoot(
  root: string,
  ownerMarkerHash: Sha256Hash,
  expectedIdentity?: { readonly device: string; readonly inode: string },
): void {
  if (
    !fs.existsSync(root) ||
    fs.lstatSync(root).isSymbolicLink() ||
    fs.realpathSync(root) !== root
  ) {
    throw new G4TestBootstrapError(
      'data_root_symlink_or_alias',
      'G4 owned data root identity changed',
    );
  }
  const rootStat = fs.statSync(root);
  if (
    expectedIdentity &&
    (String(rootStat.dev) !== expectedIdentity.device ||
      String(rootStat.ino) !== expectedIdentity.inode)
  ) {
    throw new G4TestBootstrapError(
      'isolation_proof_failed',
      'G4 owned data root device/inode identity changed',
    );
  }
  const ownerMarkerPath = path.join(root, ownerMarkerName);
  if (fs.lstatSync(ownerMarkerPath).isSymbolicLink()) {
    throw new G4TestBootstrapError(
      'data_root_symlink_or_alias',
      'G4 owner marker must not be a symbolic link',
    );
  }
  const marker = strictParseJsonBytes(fs.readFileSync(ownerMarkerPath));
  assertJsonObject(marker);
  if (marker.marker_hash !== ownerMarkerHash) {
    throw new G4TestBootstrapError(
      'isolation_proof_failed',
      'G4 owner marker identity changed',
    );
  }
  const { marker_hash: _hash, ...payload } = marker;
  if (domainSeparatedSha256(ownerMarkerDomain, payload) !== ownerMarkerHash) {
    throw new G4TestBootstrapError(
      'isolation_proof_failed',
      'G4 owner marker hash is invalid',
    );
  }
}

function assertOwnedDatabase(
  databasePath: string,
  expectedIdentity: { readonly device: string; readonly inode: string },
): void {
  try {
    const linkStat = fs.lstatSync(databasePath);
    const databaseStat = fs.statSync(databasePath);
    if (
      linkStat.isSymbolicLink() ||
      !databaseStat.isFile() ||
      fs.realpathSync(databasePath) !== databasePath ||
      String(databaseStat.dev) !== expectedIdentity.device ||
      String(databaseStat.ino) !== expectedIdentity.inode
    ) {
      throw new Error('database file identity changed');
    }
  } catch (error) {
    throw new G4TestBootstrapError(
      'isolation_proof_failed',
      'G4 owned database device/inode identity changed',
      { cause: error },
    );
  }
}

function buildReceipt(
  contracts: G4TestBootstrapContractSet,
  instanceId: string,
  root: string,
  databasePath: string,
  ownerMarkerHash: Sha256Hash,
  store: WorkflowRuntimeStore,
): G4IsolationReceipt {
  const rootStat = fs.statSync(root);
  const databaseStat = fs.statSync(databasePath);
  const activeRegistry = store.queryOne<{ count: number }>(
    "SELECT count(*) AS count FROM workflow_registry_resources WHERE publication_state = 'published' AND resource_id <> ?",
    ['icarus.local-capacity-defaults'],
  )!;
  const activePointers = store.queryOne<{ count: number }>(
    'SELECT count(*) AS count FROM workflow_feature_active_releases',
    [],
  )!;
  if (activeRegistry.count !== 0 || activePointers.count !== 0) {
    throw new G4TestBootstrapError(
      'isolation_proof_failed',
      'Fresh G4 Store unexpectedly contains active Registry or Release facts',
    );
  }
  const receiptWithoutHash = {
    format: 'icarus.workflow-test-bootstrap-isolation-receipt/1' as const,
    instance_id: instanceId,
    profile_ref: { ...contracts.profile.ref },
    profile_hash: contracts.profile.hash,
    fixture_set_ref: { ...contracts.fixtureSet.ref },
    fixture_set_hash: contracts.fixtureSet.hash,
    fake_adapter_profile_hash: contracts.fakeAdapterProfile.hash,
    virtual_clock_profile_hash: contracts.virtualClockProfile.hash,
    canonical_data_root: root,
    database_path: databasePath,
    owner_marker_hash: ownerMarkerHash,
    root_device: String(rootStat.dev),
    root_inode: String(rootStat.ino),
    database_device: String(databaseStat.dev),
    database_inode: String(databaseStat.ino),
    database_schema_version: CURRENT_WORKFLOW_RUNTIME_SCHEMA_VERSION as 12,
    production_ingress_reachable: false as const,
    feature_ingress_reachable: false as const,
    api_ingress_reachable: false as const,
    automation_ingress_reachable: false as const,
    active_registry_rows_observed: 0 as const,
    active_release_pointer_rows_observed: 0 as const,
    production_runtime_root_touched: false as const,
    real_adapter_invoked: false as const,
    user_data_touched: false as const,
    authority: 'test_only_bootstrap' as const,
  };
  return {
    ...receiptWithoutHash,
    receipt_hash: domainSeparatedSha256(receiptDomain, receiptWithoutHash),
  };
}

export class G4TestBootstrapInstance {
  readonly instanceId: string;
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly receipt: Readonly<G4IsolationReceipt>;
  readonly clock: G4VirtualClock;
  readonly fakeAdapter: G4FakeAdapter;
  #store: WorkflowRuntimeStore | null;
  #ownerMarkerHash: Sha256Hash;

  constructor(
    instanceId: string,
    dataRoot: string,
    databasePath: string,
    receipt: G4IsolationReceipt,
    clock: G4VirtualClock,
    fakeAdapter: G4FakeAdapter,
    store: WorkflowRuntimeStore,
    ownerMarkerHash: Sha256Hash,
  ) {
    this.instanceId = instanceId;
    this.dataRoot = dataRoot;
    this.databasePath = databasePath;
    this.receipt = Object.freeze(structuredClone(receipt));
    this.clock = clock;
    this.fakeAdapter = fakeAdapter;
    this.#store = store;
    this.#ownerMarkerHash = ownerMarkerHash;
  }

  get store(): WorkflowRuntimeStore {
    if (!this.#store) {
      throw new G4TestBootstrapError(
        'instance_closed',
        'G4 bootstrap Store is closed',
      );
    }
    return this.#store;
  }

  closeStore(): void {
    this.#store?.close();
    this.#store = null;
  }

  reopenStore(): WorkflowRuntimeStore {
    if (this.#store) return this.#store;
    assertOwnedRoot(this.dataRoot, this.#ownerMarkerHash, {
      device: this.receipt.root_device,
      inode: this.receipt.root_inode,
    });
    const receiptPath = path.join(this.dataRoot, isolationReceiptName);
    if (fs.lstatSync(receiptPath).isSymbolicLink()) {
      throw new G4TestBootstrapError(
        'data_root_symlink_or_alias',
        'G4 isolation receipt must not be a symbolic link',
      );
    }
    const receipt = validateG4IsolationReceipt(
      strictParseJsonBytes(fs.readFileSync(receiptPath)),
    );
    if (canonicalJson(receipt) !== canonicalJson(this.receipt)) {
      throw new G4TestBootstrapError(
        'isolation_proof_failed',
        'G4 isolation receipt drifted before reopen',
      );
    }
    assertOwnedDatabase(this.databasePath, {
      device: this.receipt.database_device,
      inode: this.receipt.database_inode,
    });
    this.#store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: this.databasePath,
      databaseMode: 'open_existing',
    });
    return this.#store;
  }

  cleanup(): void {
    this.closeStore();
    assertOwnedRoot(this.dataRoot, this.#ownerMarkerHash, {
      device: this.receipt.root_device,
      inode: this.receipt.root_inode,
    });
    try {
      fs.rmSync(this.dataRoot, { recursive: true });
    } catch (error) {
      writeResidual(this.dataRoot, this.instanceId, error);
      throw new G4TestBootstrapError(
        'cleanup_failed_with_residual',
        `G4 cleanup failed; residual is identifiable at ${this.dataRoot}`,
        { cause: error },
      );
    }
  }
}

export function createG4TestBootstrap(
  options: CreateG4TestBootstrapOptions,
): G4TestBootstrapInstance {
  assertExactOptions(options);
  const contracts = checkG4TestBootstrapContracts();
  assertSelection(options, contracts);
  const root = validateRequestedRoot(options);
  if (options.faultInjection === 'root_create_failure') {
    throw new G4TestBootstrapError(
      'data_root_create_failed',
      'Injected G4 root creation failure',
    );
  }
  if (options.faultInjection === 'root_permission_denied') {
    throw new G4TestBootstrapError(
      'data_root_permission_denied',
      'Injected G4 root permission denial',
    );
  }
  const instanceId = domainSeparatedSha256(instanceDomain, {
    instance_key: options.instanceKey,
    canonical_data_root: root,
    profile_hash: contracts.profile.hash,
  });
  let store: WorkflowRuntimeStore | undefined;
  let ownerMarkerHash: Sha256Hash | undefined;
  let rootCreated = false;
  try {
    try {
      fs.mkdirSync(root, { recursive: false, mode: 0o700 });
      rootCreated = true;
    } catch (error) {
      throw rootCreateError(root, error);
    }
    if (fs.realpathSync(root) !== root || fs.lstatSync(root).isSymbolicLink()) {
      throw new G4TestBootstrapError(
        'data_root_symlink_or_alias',
        'G4 created data root is not canonical',
      );
    }
    const ownerWithoutHash = {
      format: 'icarus.workflow-test-bootstrap-owner-marker/1',
      instance_id: instanceId,
      canonical_data_root: root,
      profile_hash: contracts.profile.hash,
    };
    ownerMarkerHash = domainSeparatedSha256(
      ownerMarkerDomain,
      ownerWithoutHash,
    );
    writeExclusive(path.join(root, ownerMarkerName), {
      ...ownerWithoutHash,
      marker_hash: ownerMarkerHash,
    });
    if (
      options.faultInjection === 'interrupt_after_root_create' ||
      options.faultInjection === 'cleanup_failure'
    ) {
      throw new G4TestBootstrapError(
        'initialization_interrupted',
        'Injected G4 interruption after root creation',
      );
    }
    if (options.faultInjection === 'store_open_failure') {
      throw new G4TestBootstrapError(
        'store_open_failed',
        'Injected G4 Store open failure',
      );
    }
    const databasePath = path.join(root, 'workflow-runtime.db');
    try {
      store = WorkflowRuntimeConnectionFactory.openStore({
        databasePath,
        databaseMode: 'create',
      });
    } catch (error) {
      throw new G4TestBootstrapError(
        'store_open_failed',
        'G4 Store rejected bootstrap',
        { cause: error },
      );
    }
    if (options.faultInjection === 'interrupt_after_store_open') {
      throw new G4TestBootstrapError(
        'initialization_interrupted',
        'Injected G4 interruption after Store open',
      );
    }
    const clockProfile = contracts.virtualClockProfile
      .payload as unknown as G4VirtualClockProfile;
    const clock = new G4VirtualClock(clockProfile);
    const fakeAdapter = new G4FakeAdapter(g4FakeAdapterBehaviors());
    const receipt = buildReceipt(
      contracts,
      instanceId,
      root,
      databasePath,
      ownerMarkerHash,
      store,
    );
    validateG4IsolationReceipt(receipt);
    writeExclusive(path.join(root, isolationReceiptName), receipt);
    return new G4TestBootstrapInstance(
      instanceId,
      root,
      databasePath,
      receipt,
      clock,
      fakeAdapter,
      store,
      ownerMarkerHash,
    );
  } catch (error) {
    store?.close();
    if (rootCreated && fs.existsSync(root)) {
      if (options.faultInjection === 'cleanup_failure') {
        writeResidual(root, instanceId, error);
        throw new G4TestBootstrapError(
          'cleanup_failed_with_residual',
          `G4 initialization failed and left an identifiable residual at ${root}`,
          { cause: error },
        );
      }
      try {
        fs.rmSync(root, { recursive: true });
      } catch (cleanupError) {
        writeResidual(root, instanceId, cleanupError);
        throw new G4TestBootstrapError(
          'cleanup_failed_with_residual',
          `G4 initialization cleanup failed at ${root}`,
          { cause: cleanupError },
        );
      }
    }
    throw error;
  }
}

export function g4BootstrapProfileForTest(): G4TestBootstrapProfile {
  return structuredClone(
    checkG4TestBootstrapContracts().profile.payload,
  ) as G4TestBootstrapProfile;
}

export function canonicalG4ReceiptBytes(
  receipt: Readonly<G4IsolationReceipt>,
): string {
  return canonicalJson(receipt);
}
