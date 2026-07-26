import fs from 'node:fs';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  G5_REPAIR_FAULT_FIXTURES,
  G5_REPAIR_NEGATIVE_FIXTURES,
  G5_REPAIR_POSITIVE_FIXTURES,
  type G5RepairFixtureCase,
} from './g5-basic-runtime-repair-contract.js';
import {
  G5FixtureExecutionHarness,
  type G5FixtureHandler,
} from './g5-basic-runtime-fixture-harness.js';
import {
  StaticChildPlanBundleFixtureExecutionHarness,
  type StaticChildPlanBundleFixtureArtifacts,
  type StaticChildPlanBundleFixtureHandler,
} from './static-child-plan-bundle-fixture-harness.js';
import {
  calculateStaticChildPlanBundleFixtureBindingHash,
  checkStaticChildPlanBundleRepair,
  STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS,
  type StaticChildPlanBundleFixtureCase,
} from './static-child-plan-bundle-repair.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonValue } from './types.js';

const contractsRoot = import.meta.dirname;

function readCases(relativePath: string): JsonValue[] {
  const artifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
  return artifact.payload.cases as JsonValue[];
}

function fixtureArtifacts(): StaticChildPlanBundleFixtureArtifacts {
  return {
    positive: readCases(STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.positive),
    negative: readCases(STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.negative),
    fault: readCases(STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.fault),
  };
}

function acceptingHandlers(): readonly StaticChildPlanBundleFixtureHandler[] {
  const execute = (fixture: StaticChildPlanBundleFixtureCase) => fixture.oracle;
  return [
    { id: 'compile_workflow_production', execute },
    { id: 'persist_static_child_plan_bundle_t2a_production', execute },
  ];
}

function acceptingG5Handlers(): readonly G5FixtureHandler[] {
  const fixtures = [
    ...G5_REPAIR_POSITIVE_FIXTURES,
    ...G5_REPAIR_NEGATIVE_FIXTURES,
    ...G5_REPAIR_FAULT_FIXTURES,
  ];
  return [...new Set(fixtures.map((fixture) => fixture.handler))].map((id) => ({
    id,
    execute: (fixture: G5RepairFixtureCase) => fixture.oracle,
  }));
}

function cloneArtifacts(): {
  positive: JsonValue[];
  negative: JsonValue[];
  fault: JsonValue[];
} {
  const artifacts = fixtureArtifacts();
  return {
    positive: structuredClone([...artifacts.positive]),
    negative: structuredClone([...artifacts.negative]),
    fault: structuredClone([...artifacts.fault]),
  };
}

describe('static child Plan bundle directed repair Contract', () => {
  it('checks the additive candidate and its frozen v6 predecessor binding', () => {
    const pack = checkStaticChildPlanBundleRepair();
    expect(pack.payload.status).toBe(
      'DIRECTED_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
    );
    expect(pack.payload.g2_g5_closed).toBe(false);
    expect(pack.payload.g6_ready).toBe(false);
    expect(pack.payload.independent_review_required).toBe(true);
  });

  it('loads the exact checked-in 4/12/6 inventory into its closed registry', () => {
    const harness = new StaticChildPlanBundleFixtureExecutionHarness(
      fixtureArtifacts(),
      acceptingHandlers(),
    );
    expect(
      harness.fixtures.filter((fixture) => fixture.category === 'positive'),
    ).toHaveLength(4);
    expect(
      harness.fixtures.filter((fixture) => fixture.category === 'negative'),
    ).toHaveLength(12);
    expect(
      harness.fixtures.filter((fixture) => fixture.category === 'fault'),
    ).toHaveLength(6);
    expect(
      new Set(harness.fixtures.map((fixture) => fixture.binding_hash)).size,
    ).toBe(22);
  });

  it('fails closed on missing, duplicate, unknown, malformed, and binding-drifted rows', () => {
    const missing = cloneArtifacts();
    missing.positive.pop();
    expect(
      () =>
        new StaticChildPlanBundleFixtureExecutionHarness(
          missing,
          acceptingHandlers(),
        ),
    ).toThrow(/inventory is missing or unknown/);

    const duplicate = cloneArtifacts();
    duplicate.positive.push(duplicate.positive[0]!);
    expect(
      () =>
        new StaticChildPlanBundleFixtureExecutionHarness(
          duplicate,
          acceptingHandlers(),
        ),
    ).toThrow(/duplicate static child Plan bundle fixture id/);

    const orderDrift = cloneArtifacts();
    [orderDrift.positive[0], orderDrift.positive[1]] = [
      orderDrift.positive[1]!,
      orderDrift.positive[0]!,
    ];
    expect(
      () =>
        new StaticChildPlanBundleFixtureExecutionHarness(
          orderDrift,
          acceptingHandlers(),
        ),
    ).toThrow(/inventory order drifted/);

    const unknown = cloneArtifacts();
    const unknownRecord = unknown
      .positive[0] as StaticChildPlanBundleFixtureCase;
    const { binding_hash: _unknownBindingHash, ...unknownWithoutBinding } =
      unknownRecord;
    void _unknownBindingHash;
    const unknownBinding = {
      ...unknownWithoutBinding,
      case_id: 'unknown_fixture',
    };
    unknown.positive[0] = {
      ...unknownBinding,
      binding_hash:
        calculateStaticChildPlanBundleFixtureBindingHash(unknownBinding),
    };
    expect(
      () =>
        new StaticChildPlanBundleFixtureExecutionHarness(
          unknown,
          acceptingHandlers(),
        ),
    ).toThrow(/inventory is missing or unknown/);

    const malformed = cloneArtifacts();
    malformed.positive[0] = {
      ...(malformed.positive[0] as StaticChildPlanBundleFixtureCase),
      unknown: true,
    };
    expect(
      () =>
        new StaticChildPlanBundleFixtureExecutionHarness(
          malformed,
          acceptingHandlers(),
        ),
    ).toThrow(/field set is not closed/);

    const bindingDrift = cloneArtifacts();
    bindingDrift.positive[0] = {
      ...(bindingDrift.positive[0] as StaticChildPlanBundleFixtureCase),
      binding_hash: `sha256:${'0'.repeat(64)}`,
    };
    expect(
      () =>
        new StaticChildPlanBundleFixtureExecutionHarness(
          bindingDrift,
          acceptingHandlers(),
        ),
    ).toThrow(/binding hash drifted/);
  });

  it('fails closed on unhandled, multiply handled, repeated, non-checked-in, or mismatched execution', () => {
    const artifacts = fixtureArtifacts();
    const unhandled = new StaticChildPlanBundleFixtureExecutionHarness(
      artifacts,
      [],
    );
    expect(() => unhandled.execute(unhandled.fixtures[0]!)).toThrow(
      /has 0 execution handlers/,
    );
    expect(() => unhandled.assertComplete()).toThrow(/unhandled/);

    const duplicateHandlers = acceptingHandlers().filter(
      (handler) => handler.id === 'compile_workflow_production',
    );
    const multiplyHandled = new StaticChildPlanBundleFixtureExecutionHarness(
      artifacts,
      [...duplicateHandlers, ...duplicateHandlers],
    );
    expect(() => multiplyHandled.execute(multiplyHandled.fixtures[0]!)).toThrow(
      /has 2 execution handlers/,
    );

    const repeated = new StaticChildPlanBundleFixtureExecutionHarness(
      artifacts,
      acceptingHandlers(),
    );
    repeated.execute(repeated.fixtures[0]!);
    expect(() => repeated.execute(repeated.fixtures[0]!)).toThrow(
      /handled more than once/,
    );

    const nonCheckedIn = new StaticChildPlanBundleFixtureExecutionHarness(
      artifacts,
      acceptingHandlers(),
    );
    expect(() =>
      nonCheckedIn.execute({
        ...nonCheckedIn.fixtures[0]!,
        assertion: 'not checked in',
      }),
    ).toThrow(/execution record is not checked in/);

    const mismatched = new StaticChildPlanBundleFixtureExecutionHarness(
      artifacts,
      acceptingHandlers().map((handler) => ({
        ...handler,
        execute: (fixture) => ({
          ...fixture.oracle,
          checks: ['wrong_oracle'],
        }),
      })),
    );
    expect(() => mismatched.execute(mismatched.fixtures[0]!)).toThrow(
      /execution oracle mismatched/,
    );
  });

  it('keeps both fixture completeness authorities independent and fail closed', () => {
    const bridgeComplete = new StaticChildPlanBundleFixtureExecutionHarness(
      fixtureArtifacts(),
      acceptingHandlers(),
    );
    for (const fixture of bridgeComplete.fixtures)
      bridgeComplete.execute(fixture);
    expect(() => bridgeComplete.assertComplete()).not.toThrow();

    const g5Incomplete = new G5FixtureExecutionHarness(
      {
        positive: G5_REPAIR_POSITIVE_FIXTURES,
        negative: G5_REPAIR_NEGATIVE_FIXTURES,
        fault: G5_REPAIR_FAULT_FIXTURES,
      },
      acceptingG5Handlers(),
    );
    expect(() => g5Incomplete.assertComplete()).toThrow(
      /unhandled G5 fixtures/,
    );

    const bridgeIncomplete = new StaticChildPlanBundleFixtureExecutionHarness(
      fixtureArtifacts(),
      acceptingHandlers(),
    );
    expect(() => bridgeIncomplete.assertComplete()).toThrow(
      /unhandled static child Plan bundle fixtures/,
    );

    const g5Complete = new G5FixtureExecutionHarness(
      {
        positive: G5_REPAIR_POSITIVE_FIXTURES,
        negative: G5_REPAIR_NEGATIVE_FIXTURES,
        fault: G5_REPAIR_FAULT_FIXTURES,
      },
      acceptingG5Handlers(),
    );
    for (const fixture of g5Complete.fixtures) g5Complete.execute(fixture);
    expect(() => g5Complete.assertComplete()).not.toThrow();
  });

  it('independently rejects honestly rehashed semantic drift across every record', () => {
    const all = [
      ...fixtureArtifacts().positive,
      ...fixtureArtifacts().negative,
      ...fixtureArtifacts().fault,
    ] as StaticChildPlanBundleFixtureCase[];
    fc.assert(
      fc.property(fc.constantFrom(...all), (fixture) => {
        const artifacts = cloneArtifacts();
        const category = artifacts[fixture.category];
        const index = category.findIndex(
          (candidate) =>
            (candidate as StaticChildPlanBundleFixtureCase).case_id ===
            fixture.case_id,
        );
        const { binding_hash: _bindingHash, ...withoutBinding } = fixture;
        void _bindingHash;
        const driftedWithoutBinding = {
          ...withoutBinding,
          oracle: {
            ...withoutBinding.oracle,
            checks: [
              ...withoutBinding.oracle.checks,
              'honestly_rehashed_drift',
            ],
          },
        };
        category[index] = {
          ...driftedWithoutBinding,
          binding_hash: calculateStaticChildPlanBundleFixtureBindingHash(
            driftedWithoutBinding,
          ),
        };
        expect(
          () =>
            new StaticChildPlanBundleFixtureExecutionHarness(
              artifacts,
              acceptingHandlers(),
            ),
        ).toThrow(/fixture bytes are not current/);
      }),
      { numRuns: 44 },
    );
  });
});
