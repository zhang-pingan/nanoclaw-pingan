import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export const G4_FAKE_ADAPTER_OUTCOMES = [
  'not_applied',
  'applied_with_receipt',
  'applied_but_receipt_lost',
  'still_running',
  'unknown',
  'cancelled',
  'compensated',
] as const;

export type G4FakeAdapterOutcome = (typeof G4_FAKE_ADAPTER_OUTCOMES)[number];

export interface G4FakeAdapterInvocation extends JsonObject {
  format: 'icarus.workflow-test-fake-adapter-invocation/1';
  fixture_id: string;
  operation_key: string;
  attempt_no: number;
  input: JsonValue;
  invocation_hash: Sha256Hash;
}

export interface G4FakeAdapterResult extends JsonObject {
  format: 'icarus.workflow-test-fake-adapter-result/1';
  fixture_id: string;
  operation_key: string;
  attempt_no: number;
  outcome: G4FakeAdapterOutcome;
  receipt: JsonObject | null;
  result: JsonObject;
  replay_hash: Sha256Hash;
}

export interface G4FakeAdapterBehavior extends JsonObject {
  behavior_id: string;
  invocation: G4FakeAdapterInvocation;
  response: G4FakeAdapterResult;
}

export interface G4VirtualClockProfile extends JsonObject {
  format: 'icarus.workflow-test-virtual-clock-profile/1';
  ref: VersionedRef;
  seed: string;
  initial_time_ms: number;
  tick_quantum_ms: 1;
  authority: 'virtual_only';
  implicit_date_now_allowed: false;
  wall_clock_fallback_allowed: false;
  real_sleep_allowed: false;
  rollback_allowed: false;
}

export interface G4FixtureSet extends JsonObject {
  format: 'icarus.workflow-test-bootstrap-fixture-set/1';
  ref: VersionedRef;
  selection: 'explicit_exact_ref_and_hash';
  fixture_ids: string[];
  synthetic_registry_only: true;
  production_publishable: false;
}

export interface G4TestBootstrapProfile extends JsonObject {
  format: 'icarus.workflow-test-bootstrap-profile/1';
  ref: VersionedRef;
  gate: 'G4';
  profile_kind: 'test_only';
  selection: 'explicit_exact_ref_and_hash';
  default_enabled: false;
  certification_status: 'not_certified';
  production_acceptance: 'reject';
  production_rejection_code: 'test_bootstrap_profile_forbidden';
  managed_toolchain: JsonObject;
  store_binding: JsonObject;
  upstream_contracts: JsonObject;
  fixture_set: JsonObject;
  fake_adapter: JsonObject;
  virtual_clock: JsonObject;
  root_policy: JsonObject;
  isolation_boundary: JsonObject;
  bootstrap_implementation_hash: Sha256Hash;
}

export interface G4IsolationReceipt extends JsonObject {
  format: 'icarus.workflow-test-bootstrap-isolation-receipt/1';
  instance_id: string;
  profile_ref: VersionedRef;
  profile_hash: Sha256Hash;
  fixture_set_ref: VersionedRef;
  fixture_set_hash: Sha256Hash;
  fake_adapter_profile_hash: Sha256Hash;
  virtual_clock_profile_hash: Sha256Hash;
  bootstrap_implementation_hash: Sha256Hash;
  canonical_data_root: string;
  database_path: string;
  owner_marker_hash: Sha256Hash;
  root_device: string;
  root_inode: string;
  database_device: string;
  database_inode: string;
  database_schema_version: 4;
  database_schema_hash: Sha256Hash;
  sqlite_profile_hash: Sha256Hash;
  production_surface_absence_hash: Sha256Hash;
  production_ingress_reachable: false;
  feature_ingress_reachable: false;
  api_ingress_reachable: false;
  automation_ingress_reachable: false;
  active_registry_rows_observed: 0;
  active_release_pointer_rows_observed: 0;
  production_runtime_root_touched: false;
  real_adapter_invoked: false;
  user_data_touched: false;
  authority: 'test_only_bootstrap';
  receipt_hash: Sha256Hash;
}

export const G4_TEST_BOOTSTRAP_PROFILE_REF = {
  id: 'icarus.workflow-test-bootstrap-profile',
  version: '1.0.0',
} as const;

export const G4_TEST_BOOTSTRAP_FIXTURE_SET_REF = {
  id: 'icarus.workflow-test-bootstrap-fixture-set',
  version: '1.0.0',
} as const;

export const G4_FAKE_ADAPTER_PROFILE_REF = {
  id: 'icarus.workflow-test-fake-adapter-profile',
  version: '1.0.0',
} as const;

export const G4_VIRTUAL_CLOCK_PROFILE_REF = {
  id: 'icarus.workflow-test-virtual-clock-profile',
  version: '1.0.0',
} as const;
