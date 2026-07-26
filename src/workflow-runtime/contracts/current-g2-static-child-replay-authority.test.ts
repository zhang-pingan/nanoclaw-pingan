import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkG2V6FrozenReplay } from '../compiler/g2-v6-frozen-replay.js';
import { evaluateCurrentG2GoldenReplay } from '../compiler/current-g2-golden-replay.js';
import { canonicalJson } from './hash.js';
import {
  buildCurrentG2StaticChildReplayAuthority,
  checkCurrentG2StaticChildReplayAuthority,
  checkCurrentG2StaticChildReplayAuthorityAtRootForTest,
  CURRENT_G2_STATIC_CHILD_REPLAY_AUTHORITY_REF,
  CURRENT_G2_STATIC_CHILD_REPLAY_ROOT,
  validateCurrentG2StaticChildReplayAuthorityPayloadForTest,
  type CurrentG2StaticChildReplayAuthorityBuild,
} from './current-g2-static-child-replay-authority.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
let temporaryRoot: string;
let built: CurrentG2StaticChildReplayAuthorityBuild;

beforeAll(() => {
  temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-current-g2-static-child-replay-'),
  );
  built = buildCurrentG2StaticChildReplayAuthority();
});

afterAll(() => {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

function copyAuthority(name: string): string {
  const target = path.join(temporaryRoot, name);
  fs.cpSync(
    path.join(contractsRoot, CURRENT_G2_STATIC_CHILD_REPLAY_ROOT),
    target,
    {
      recursive: true,
    },
  );
  return target;
}

describe('current G2 Compiler 3.0.6 generated-output schema replay authority', () => {
  it('builds a deterministic closed 40-case authority without fabricating approval or closure', () => {
    const second = buildCurrentG2StaticChildReplayAuthority();
    expect([...second.files]).toEqual([...built.files]);
    expect(second.files).toHaveLength(86);
    expect(built.authoredExactCount).toBe(40);
    expect(built.authority.payload).toMatchObject({
      authority_kind: 'additive_current_replay_not_semantic_seal',
      authority_status:
        'G2_IN_PROGRESS_G3_IN_PROGRESS_G4_IN_PROGRESS_G5_IN_PROGRESS_G6_G9_NOT_READY',
      authority_version: '8.0.0-current',
      approval_status: 'absent_not_fabricated',
      seal_status: 'not_created',
      independent_regression_status: 'not_created_by_directed_repair',
      case_count: 40,
      compiled_count: 11,
      rejected_count: 29,
      expected_result_coverage: 40,
    });
    expect(checkCurrentG2StaticChildReplayAuthority().authority.hash).toBe(
      built.authority.hash,
    );
  }, 30_000);

  it('keeps current 3.0.6, superseded v7 3.0.5, and sealed v6 3.0.4 authorities distinct', () => {
    const current = evaluateCurrentG2GoldenReplay();
    const historical = checkG2V6FrozenReplay();
    expect(current).toMatchObject({
      exact_equal_count: 40,
      mismatch_count: 0,
      passed: true,
      expected_bundle_hash: built.authority.payload.bundle_hash,
    });
    expect(historical).toEqual({
      exactCount: 40,
      bundleHash:
        'sha256:0820328ae1cfdba7d05948d9e36498a5428d997d6eabfb833ef0ba7d84b77db7',
    });
    const predecessorV7 = built.authority.payload.predecessor_v7 as JsonObject;
    const predecessorV7Identity = predecessorV7.compiler_identity as JsonObject;
    const predecessorV6 = built.authority.payload.predecessor_v6 as JsonObject;
    const historicalIdentity = predecessorV6.compiler_identity as JsonObject;
    expect(historicalIdentity.compiler_version).toBe('3.0.4');
    expect(predecessorV7Identity.compiler_version).toBe('3.0.5');
    expect(built.compilerIdentity.compiler_version).toBe('3.0.6');
    expect(predecessorV7.bundle_hash).toBe(
      'sha256:314ceb2f907243288815ddf029fee0b716c16d7b567d0a25da978b94a47f80ab',
    );
    expect(canonicalJson(historicalIdentity)).not.toBe(
      canonicalJson(predecessorV7Identity),
    );
    expect(canonicalJson(predecessorV7Identity)).not.toBe(
      canonicalJson(built.compilerIdentity as unknown as JsonObject),
    );
    expect(built.authority.payload.bundle_hash).not.toBe(historical.bundleHash);
  }, 30_000);

  it('fails closed on expected-result tamper and unknown authority files', () => {
    const tampered = copyAuthority('tampered');
    fs.appendFileSync(
      path.join(tampered, 'expected/positive.condition-route.result.json'),
      '\n',
    );
    expect(() =>
      checkCurrentG2StaticChildReplayAuthorityAtRootForTest(tampered),
    ).toThrow(/bytes drifted/);

    const unknown = copyAuthority('unknown');
    fs.writeFileSync(path.join(unknown, 'unexpected.json'), '{}\n');
    expect(() =>
      checkCurrentG2StaticChildReplayAuthorityAtRootForTest(unknown),
    ).toThrow(/file boundary drifted/);
  }, 30_000);

  it('rejects current compiler identity drift without weakening exact comparison', () => {
    const payload = structuredClone(built.authority.payload);
    const identity = payload.exact_compiler_identity as JsonObject;
    identity.compiler_build_hash = `sha256:${'0'.repeat(64)}`;
    expect(() =>
      validateCurrentG2StaticChildReplayAuthorityPayloadForTest(payload),
    ).toThrow(/Production Compiler identity/);
  });

  it('rejects wrong current-vs-historical authority paths even after semantic field mutation', () => {
    const payload = structuredClone(built.authority.payload);
    const cases = payload.cases as JsonObject[];
    cases[0]!.registry_snapshot_ref =
      cases[0]!.historical_registry_snapshot_ref;
    expect(() =>
      validateCurrentG2StaticChildReplayAuthorityPayloadForTest(payload),
    ).toThrow(/Current snapshot consumed the wrong authority/);

    const wrongExpected = structuredClone(built.authority.payload);
    const wrongCases = wrongExpected.cases as JsonObject[];
    wrongCases[0]!.expected_result = wrongCases[0]!.historical_expected_result;
    expect(() =>
      validateCurrentG2StaticChildReplayAuthorityPayloadForTest(wrongExpected),
    ).toThrow(/Current expected result consumed the wrong authority/);

    const predecessorSnapshot = structuredClone(built.authority.payload);
    const predecessorSnapshotCases = predecessorSnapshot.cases as JsonObject[];
    predecessorSnapshotCases[0]!.registry_snapshot_ref =
      predecessorSnapshotCases[0]!.predecessor_registry_snapshot_ref;
    expect(() =>
      validateCurrentG2StaticChildReplayAuthorityPayloadForTest(
        predecessorSnapshot,
      ),
    ).toThrow(/Current snapshot consumed the wrong authority/);

    const predecessorExpected = structuredClone(built.authority.payload);
    const predecessorExpectedCases = predecessorExpected.cases as JsonObject[];
    predecessorExpectedCases[0]!.expected_result =
      predecessorExpectedCases[0]!.predecessor_expected_result;
    expect(() =>
      validateCurrentG2StaticChildReplayAuthorityPayloadForTest(
        predecessorExpected,
      ),
    ).toThrow(/Current expected result consumed the wrong authority/);
  });

  it('preserves only the intentional integrity-negative identity drift across the 40 current snapshots', () => {
    const cases = built.authority.payload.cases as JsonObject[];
    expect(
      cases
        .filter(
          (entry) =>
            entry.snapshot_compiler_identity_relation ===
            'intentional_integrity_negative_drift',
        )
        .map((entry) => entry.case_id),
    ).toEqual(['negative.compiler-integrity-mismatch']);
    expect(
      cases.every((entry) =>
        String(entry.registry_snapshot_ref).startsWith(
          `${CURRENT_G2_STATIC_CHILD_REPLAY_ROOT}/snapshots/`,
        ),
      ),
    ).toBe(true);
    expect(CURRENT_G2_STATIC_CHILD_REPLAY_AUTHORITY_REF).not.toContain(
      '/sealed/',
    );
  });
});
