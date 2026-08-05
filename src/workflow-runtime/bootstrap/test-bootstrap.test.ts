import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  G4_FAKE_ADAPTER_INVOCATION_DOMAIN,
  G4_FAKE_ADAPTER_RESULT_DOMAIN,
  g4FakeAdapterBehaviors,
  g4VirtualClockProfile,
} from '../contracts/g4-test-bootstrap-fixtures.js';
import {
  validateG4IsolationReceipt,
  validateG4TestBootstrapProfile,
} from '../contracts/g4-test-bootstrap-contract.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import { G4FakeAdapter, G4FakeAdapterError } from './fake-adapter.js';
import {
  createG4TestBootstrap,
  currentG4TestBootstrapSelector,
  deriveG4TestDataRoot,
  g4BootstrapProfileForTest,
  G4TestBootstrapError,
  type CreateG4TestBootstrapOptions,
  type G4TestBootstrapInstance,
  type G4TestBootstrapSelector,
} from './test-bootstrap.js';
import { G4VirtualClock, G4VirtualClockError } from './virtual-clock.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const canonicalTemporaryRoot = fs.realpathSync(os.tmpdir());
const rootsToRemove = new Set<string>();
const instances = new Set<G4TestBootstrapInstance>();
let selector: G4TestBootstrapSelector;
let sequence = 0;

beforeAll(() => {
  selector = currentG4TestBootstrapSelector();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const instance of instances) instance.closeStore();
  instances.clear();
  for (const root of [...rootsToRemove].sort(
    (left, right) => right.length - left.length,
  )) {
    try {
      if (!fs.lstatSync(root).isSymbolicLink()) fs.chmodSync(root, 0o700);
      fs.rmSync(root, { force: true, recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  rootsToRemove.clear();
});

function instanceKey(label: string): string {
  sequence += 1;
  return `g4-test-${process.pid}-${sequence}-${label}`;
}

function options(
  label: string,
  parent = canonicalTemporaryRoot,
): CreateG4TestBootstrapOptions {
  const key = instanceKey(label);
  const dataRoot = deriveG4TestDataRoot(parent, key);
  rootsToRemove.add(dataRoot);
  return { ...selector, instanceKey: key, dataRoot };
}

function track(instance: G4TestBootstrapInstance): G4TestBootstrapInstance {
  instances.add(instance);
  rootsToRemove.add(instance.dataRoot);
  return instance;
}

function expectBootstrapCode(
  run: () => unknown,
  code: G4TestBootstrapError['code'],
): void {
  expect(run).toThrowError(
    expect.objectContaining<Partial<G4TestBootstrapError>>({ code }),
  );
}

function expectFakeCode(run: () => unknown, code: G4FakeAdapterError['code']) {
  expect(run).toThrowError(
    expect.objectContaining<Partial<G4FakeAdapterError>>({ code }),
  );
}

describe('G4 Test Bootstrap', () => {
  it('opens only a fresh Schema 11 real-file Store and emits a verifiable isolation receipt', () => {
    const instance = track(createG4TestBootstrap(options('fresh')));
    expect(fs.realpathSync(instance.dataRoot)).toBe(instance.dataRoot);
    expect(instance.databasePath).toBe(
      path.join(instance.dataRoot, 'workflow-runtime.db'),
    );
    expect(fs.statSync(instance.databasePath).isFile()).toBe(true);
    expect(
      instance.store.queryOne<{ version: number }>(
        'SELECT user_version AS version FROM pragma_user_version',
        [],
      ),
    ).toEqual({ version: 6 });

    const tables = instance.store.queryAll<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      [],
    );
    expect(tables).toHaveLength(86);
    for (const { name } of tables) {
      expect(
        instance.store.queryOne<{ count: number }>(
          `SELECT count(*) AS count FROM "${name}"`,
          [],
        ),
      ).toEqual({ count: 0 });
    }

    expect(validateG4IsolationReceipt(instance.receipt)).toEqual(
      instance.receipt,
    );
    expect(instance.receipt).toMatchObject({
      production_ingress_reachable: false,
      feature_ingress_reachable: false,
      api_ingress_reachable: false,
      automation_ingress_reachable: false,
      active_registry_rows_observed: 0,
      active_release_pointer_rows_observed: 0,
      production_runtime_root_touched: false,
      real_adapter_invoked: false,
      user_data_touched: false,
      authority: 'test_only_bootstrap',
    });

    instance.closeStore();
    expect(
      instance.reopenStore().queryOne<{
        count: number;
      }>('SELECT count(*) AS count FROM workflows', []),
    ).toEqual({ count: 0 });
    instance.cleanup();
    instances.delete(instance);
    expect(fs.existsSync(instance.dataRoot)).toBe(false);
  });

  it('creates distinct roots/databases and refuses concurrent root reuse', () => {
    const firstOptions = options('isolation-a');
    const secondOptions = options('isolation-b');
    const first = track(createG4TestBootstrap(firstOptions));
    const second = track(createG4TestBootstrap(secondOptions));
    expect(first.instanceId).not.toBe(second.instanceId);
    expect(first.dataRoot).not.toBe(second.dataRoot);
    expect(first.databasePath).not.toBe(second.databasePath);
    expectBootstrapCode(
      () => createG4TestBootstrap(firstOptions),
      'data_root_preexisting_nonempty',
    );
  });

  it('never deletes a concurrently created root after losing exclusive mkdir', () => {
    const candidate = options('concurrent-mkdir-race');
    const originalMkdirSync = fs.mkdirSync;
    vi.spyOn(fs, 'mkdirSync').mockImplementation(((
      target: fs.PathLike,
      mkdirOptions?: unknown,
    ) => {
      if (target === candidate.dataRoot) {
        originalMkdirSync(candidate.dataRoot, { mode: 0o700 });
        fs.writeFileSync(
          path.join(candidate.dataRoot, 'foreign-winner-data'),
          'winner',
        );
        const error = new Error(
          'exclusive mkdir lost',
        ) as NodeJS.ErrnoException;
        error.code = 'EEXIST';
        throw error;
      }
      return (originalMkdirSync as unknown as (...args: unknown[]) => unknown)(
        target,
        mkdirOptions,
      );
    }) as typeof fs.mkdirSync);

    expectBootstrapCode(
      () => createG4TestBootstrap(candidate),
      'data_root_preexisting_nonempty',
    );
    expect(
      fs.readFileSync(
        path.join(candidate.dataRoot, 'foreign-winner-data'),
        'utf8',
      ),
    ).toBe('winner');
  });

  it('rejects missing/default, unknown, and drifted selectors', () => {
    expectBootstrapCode(
      () =>
        createG4TestBootstrap(
          undefined as unknown as CreateG4TestBootstrapOptions,
        ),
      'bootstrap_options_invalid',
    );

    const extra = { ...options('extra'), unexpected: true };
    expectBootstrapCode(
      () => createG4TestBootstrap(extra as CreateG4TestBootstrapOptions),
      'bootstrap_options_invalid',
    );

    const profileDrift = {
      ...options('profile-drift'),
      profileHash:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const,
    };
    expectBootstrapCode(
      () => createG4TestBootstrap(profileDrift),
      'profile_identity_mismatch',
    );

    const fixtureDrift = {
      ...options('fixture-drift'),
      fixtureSetHash:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const,
    };
    expectBootstrapCode(
      () => createG4TestBootstrap(fixtureDrift),
      'fixture_identity_mismatch',
    );
  });

  it('rejects relative, aliased, escaped, production, pre-existing, nonempty, and symlink roots', () => {
    const relativeBase = options('relative');
    const relative = {
      ...relativeBase,
      dataRoot: path.basename(relativeBase.dataRoot),
    };
    expectBootstrapCode(
      () => createG4TestBootstrap(relative),
      'data_root_invalid',
    );

    const aliasBase = options('alias');
    const alias = {
      ...aliasBase,
      dataRoot: `${path.dirname(aliasBase.dataRoot)}${path.sep}.${path.sep}${path.basename(aliasBase.dataRoot)}`,
    };
    expectBootstrapCode(
      () => createG4TestBootstrap(alias),
      'data_root_symlink_or_alias',
    );

    const escaped = options('escaped', path.join(repoRoot, 'local'));
    expectBootstrapCode(
      () => createG4TestBootstrap(escaped),
      'data_root_not_temporary',
    );

    const production = {
      ...options('production'),
      dataRoot: path.join(repoRoot, 'data', 'workflow-runtime'),
    };
    expectBootstrapCode(
      () => createG4TestBootstrap(production),
      'production_root_collision',
    );

    const preexisting = options('preexisting');
    fs.mkdirSync(preexisting.dataRoot, { mode: 0o700 });
    expectBootstrapCode(
      () => createG4TestBootstrap(preexisting),
      'data_root_preexisting',
    );

    const nonempty = options('nonempty');
    fs.mkdirSync(nonempty.dataRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(nonempty.dataRoot, 'foreign-data'), 'x');
    expectBootstrapCode(
      () => createG4TestBootstrap(nonempty),
      'data_root_preexisting_nonempty',
    );

    const symbolic = options('symbolic');
    const target = fs.mkdtempSync(
      path.join(canonicalTemporaryRoot, 'icarus-g4-symlink-target-'),
    );
    rootsToRemove.add(target);
    fs.symlinkSync(target, symbolic.dataRoot, 'dir');
    expectBootstrapCode(
      () => createG4TestBootstrap(symbolic),
      'data_root_symlink_or_alias',
    );
  });

  it('fails closed for root, Store, Schema/Profile, interruption, and cleanup faults', () => {
    const faults = [
      ['root_create_failure', 'data_root_create_failed'],
      ['root_permission_denied', 'data_root_permission_denied'],
      ['store_open_failure', 'store_open_failed'],
      ['schema_profile_rejection', 'store_identity_rejected'],
      ['interrupt_after_root_create', 'initialization_interrupted'],
      ['interrupt_after_store_open', 'initialization_interrupted'],
    ] as const;
    for (const [faultInjection, code] of faults) {
      const candidate = { ...options(faultInjection), faultInjection };
      expectBootstrapCode(() => createG4TestBootstrap(candidate), code);
      expect(fs.existsSync(candidate.dataRoot)).toBe(false);
    }

    const parent = fs.mkdtempSync(
      path.join(canonicalTemporaryRoot, 'icarus-g4-read-only-parent-'),
    );
    rootsToRemove.add(parent);
    fs.chmodSync(parent, 0o500);
    expectBootstrapCode(
      () => createG4TestBootstrap(options('permission', parent)),
      'data_root_permission_denied',
    );

    const cleanupFailure = {
      ...options('cleanup-failure'),
      faultInjection: 'cleanup_failure' as const,
    };
    expectBootstrapCode(
      () => createG4TestBootstrap(cleanupFailure),
      'cleanup_failed_with_residual',
    );
    expect(
      fs.existsSync(
        path.join(cleanupFailure.dataRoot, '.g4-test-bootstrap-failed.json'),
      ),
    ).toBe(true);
  });

  it('detects isolation receipt drift before reopen', () => {
    const instance = track(createG4TestBootstrap(options('receipt-drift')));
    instance.closeStore();
    const receiptPath = path.join(
      instance.dataRoot,
      'g4-test-bootstrap-isolation-receipt.json',
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<
      string,
      unknown
    >;
    receipt.real_adapter_invoked = true;
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => instance.reopenStore()).toThrow(
      /isolation receipt is invalid/,
    );
  });

  it('rejects replacement of an owned root even when its marker is copied', () => {
    const instance = track(createG4TestBootstrap(options('root-replacement')));
    instance.closeStore();
    const marker = fs.readFileSync(
      path.join(instance.dataRoot, '.g4-test-bootstrap-owner.json'),
    );
    fs.rmSync(instance.dataRoot, { recursive: true });
    fs.mkdirSync(instance.dataRoot, { mode: 0o700 });
    fs.writeFileSync(
      path.join(instance.dataRoot, '.g4-test-bootstrap-owner.json'),
      marker,
    );
    expectBootstrapCode(() => instance.reopenStore(), 'isolation_proof_failed');
  });

  it('rejects replacement of the exact Schema 11 database file', () => {
    const instance = track(
      createG4TestBootstrap(options('database-replacement')),
    );
    instance.closeStore();
    const replacement = path.join(instance.dataRoot, 'replacement.db');
    fs.copyFileSync(instance.databasePath, replacement);
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${instance.databasePath}${suffix}`, { force: true });
    }
    fs.renameSync(replacement, instance.databasePath);

    expectBootstrapCode(() => instance.reopenStore(), 'isolation_proof_failed');
  });
});

describe('G4 Fake Adapter', () => {
  it('replays every closed outcome with exact deterministic bytes', () => {
    const behaviors = g4FakeAdapterBehaviors();
    const adapter = new G4FakeAdapter(behaviors);
    expect(adapter.outcomeCount).toBe(7);
    for (const behavior of behaviors) {
      const first = adapter.invoke(behavior.invocation);
      const second = adapter.invoke(behavior.invocation);
      expect(canonicalJson(second)).toBe(canonicalJson(first));
      expect(first).toEqual(behavior.response);
      expect(first.fixture_id).toBe(behavior.invocation.fixture_id);
      expect(first.operation_key).toBe(behavior.invocation.operation_key);
      expect(first.attempt_no).toBe(behavior.invocation.attempt_no);
    }
  });

  it('rejects undeclared inputs, operation keys, attempts, outcomes, and responses', () => {
    const behaviors = g4FakeAdapterBehaviors();
    const adapter = new G4FakeAdapter(behaviors);
    const invocation = structuredClone(behaviors[0]!.invocation);
    invocation.operation_key = 'g4:operation:not-registered';
    const { invocation_hash: _hash, ...payload } = invocation;
    invocation.invocation_hash = domainSeparatedSha256(
      G4_FAKE_ADAPTER_INVOCATION_DOMAIN,
      payload,
    );
    expectFakeCode(
      () => adapter.invoke(invocation),
      'fake_adapter_invocation_undeclared',
    );

    const attempt = structuredClone(behaviors[0]!.invocation);
    attempt.attempt_no = 2;
    const { invocation_hash: _attemptHash, ...attemptPayload } = attempt;
    attempt.invocation_hash = domainSeparatedSha256(
      G4_FAKE_ADAPTER_INVOCATION_DOMAIN,
      attemptPayload,
    );
    expectFakeCode(
      () => adapter.invoke(attempt),
      'fake_adapter_invocation_undeclared',
    );

    const invalidInput = structuredClone(behaviors[0]!.invocation);
    invalidInput.input = { undeclared: true };
    expectFakeCode(
      () => adapter.invoke(invalidInput),
      'fake_adapter_invocation_invalid',
    );

    const unknownOutcome = structuredClone(behaviors);
    unknownOutcome[0]!.response.outcome = 'succeeded' as never;
    const { replay_hash: _responseHash, ...resultPayload } =
      unknownOutcome[0]!.response;
    unknownOutcome[0]!.response.replay_hash = domainSeparatedSha256(
      G4_FAKE_ADAPTER_RESULT_DOMAIN,
      resultPayload,
    );
    expectFakeCode(
      () => new G4FakeAdapter(unknownOutcome),
      'fake_adapter_outcome_undeclared',
    );

    const responseDrift = structuredClone(behaviors);
    responseDrift[0]!.response.result = { state: 'not_applied', extra: true };
    const { replay_hash: _driftHash, ...driftPayload } =
      responseDrift[0]!.response;
    responseDrift[0]!.response.replay_hash = domainSeparatedSha256(
      G4_FAKE_ADAPTER_RESULT_DOMAIN,
      driftPayload,
    );
    expectFakeCode(
      () => new G4FakeAdapter(responseDrift),
      'fake_adapter_profile_invalid',
    );
  });
});

describe('G4 Virtual Clock', () => {
  it('uses only explicit monotonic advancement without wall-clock authority', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('wall clock accessed');
    });
    const clock = new G4VirtualClock(g4VirtualClockProfile());
    expect(clock.nowMs()).toBe(1_784_764_800_000);
    expect(clock.advanceBy(1)).toBe(1_784_764_800_001);
    expect(clock.advanceTo(1_784_764_800_101)).toBe(1_784_764_800_101);
    expect(() => clock.assertNow(1_784_764_800_101)).not.toThrow();
  });

  it('rejects profile drift, rollback, invalid advancement, and observation drift', () => {
    const profileDrift = g4VirtualClockProfile();
    profileDrift.seed = 'wall-clock-fallback';
    expect(() => new G4VirtualClock(profileDrift)).toThrowError(
      expect.objectContaining<Partial<G4VirtualClockError>>({
        code: 'virtual_clock_profile_mismatch',
      }),
    );

    const clock = new G4VirtualClock(g4VirtualClockProfile());
    expect(() => clock.advanceBy(0)).toThrowError(
      expect.objectContaining<Partial<G4VirtualClockError>>({
        code: 'virtual_clock_advance_invalid',
      }),
    );
    expect(() => clock.advanceTo(clock.nowMs() - 1)).toThrowError(
      expect.objectContaining<Partial<G4VirtualClockError>>({
        code: 'virtual_clock_rollback',
      }),
    );
    expect(() => clock.assertNow(clock.nowMs() + 1)).toThrowError(
      expect.objectContaining<Partial<G4VirtualClockError>>({
        code: 'virtual_clock_drift',
      }),
    );
  });

  it('keeps bootstrap source free of Date.now, real sleep, and wall-clock fallback', () => {
    for (const source of [
      'src/workflow-runtime/bootstrap/fake-adapter.ts',
      'src/workflow-runtime/bootstrap/test-bootstrap.ts',
      'src/workflow-runtime/bootstrap/virtual-clock.ts',
    ]) {
      const bytes = fs.readFileSync(path.join(repoRoot, source), 'utf8');
      expect(bytes).not.toMatch(/Date\.now\s*\(/);
      expect(bytes).not.toMatch(/\b(?:setTimeout|sleep)\s*\(/);
    }
  });
});

describe('G4 profile API', () => {
  it('exposes a non-certified profile only through the explicit test API', () => {
    const profile = g4BootstrapProfileForTest();
    expect(() => validateG4TestBootstrapProfile(profile)).not.toThrow();
    expect(profile).toMatchObject({
      profile_kind: 'test_only',
      default_enabled: false,
      certification_status: 'not_certified',
      production_acceptance: 'reject',
    });
  });
});
