import { canonicalJson } from './hash.js';
import {
  calculateStaticChildPlanBundleFixtureBindingHash,
  STATIC_CHILD_PLAN_BUNDLE_FAULT_FIXTURES,
  STATIC_CHILD_PLAN_BUNDLE_NEGATIVE_FIXTURES,
  STATIC_CHILD_PLAN_BUNDLE_POSITIVE_FIXTURES,
  type StaticChildPlanBundleFixtureCase,
  type StaticChildPlanBundleFixtureCategory,
  type StaticChildPlanBundleFixtureOracle,
  type StaticChildPlanBundleFixtureOperation,
  type StaticChildPlanBundleFixtureSurface,
} from './static-child-plan-bundle-repair.js';
import type { JsonObject, JsonValue } from './types.js';

const fixtureKeys = [
  'assertion',
  'binding_hash',
  'case_id',
  'category',
  'fault',
  'handler',
  'input',
  'operation',
  'oracle',
  'surface',
] as const;
const inputKeys = [
  'behavior',
  'expected_surface',
  'fixture_token',
  'variants',
] as const;
const faultKeys = ['point', 'variants'] as const;
const oracleKeys = [
  'checks',
  'disposition',
  'exact_error',
  'sqlite_state',
] as const;

const operationCatalog: Readonly<
  Record<
    StaticChildPlanBundleFixtureOperation,
    {
      readonly surface: StaticChildPlanBundleFixtureSurface;
      readonly handler: string;
    }
  >
> = {
  compile_workflow: {
    surface: 'Compiler',
    handler: 'compile_workflow_production',
  },
  persist_compile_result_t2a: {
    surface: 'T2a',
    handler: 'persist_static_child_plan_bundle_t2a_production',
  },
};

function objectValue(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  if (
    canonicalJson(Object.keys(value).sort()) !==
    canonicalJson([...expected].sort())
  )
    throw new Error(`${label} field set is not closed`);
}

function nonEmptyString(value: JsonValue, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function closedStringArray(value: JsonValue, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  )
    throw new Error(`${label} must contain unique non-empty strings`);
  return value as string[];
}

function parseFixture(
  value: JsonValue,
  artifactCategory: StaticChildPlanBundleFixtureCategory,
): StaticChildPlanBundleFixtureCase {
  const fixture = objectValue(value, 'Static child Plan bundle fixture');
  exactKeys(fixture, fixtureKeys, 'Static child Plan bundle fixture');
  const input = objectValue(
    fixture.input,
    'Static child Plan bundle fixture input',
  );
  const oracle = objectValue(
    fixture.oracle,
    'Static child Plan bundle fixture oracle',
  );
  exactKeys(input, inputKeys, 'Static child Plan bundle fixture input');
  exactKeys(oracle, oracleKeys, 'Static child Plan bundle fixture oracle');

  const caseId = nonEmptyString(fixture.case_id, 'fixture case_id');
  nonEmptyString(fixture.assertion, `${caseId} assertion`);
  const category = nonEmptyString(
    fixture.category,
    `${caseId} category`,
  ) as StaticChildPlanBundleFixtureCategory;
  if (!['positive', 'negative', 'fault'].includes(category))
    throw new Error(`${caseId} category is unknown`);
  if (category !== artifactCategory)
    throw new Error(`${caseId} category does not match its artifact`);
  const operation = nonEmptyString(
    fixture.operation,
    `${caseId} operation`,
  ) as StaticChildPlanBundleFixtureOperation;
  const binding = operationCatalog[operation];
  if (!binding) throw new Error(`${caseId} operation is unknown`);
  if (
    fixture.surface !== binding.surface ||
    fixture.handler !== binding.handler ||
    input.expected_surface !== binding.surface
  )
    throw new Error(`${caseId} production dispatch binding is invalid`);
  nonEmptyString(input.behavior, `${caseId} behavior`);
  if (input.behavior === caseId)
    throw new Error(`${caseId} behavior cannot alias its case_id`);
  nonEmptyString(input.fixture_token, `${caseId} fixture_token`);
  const variants = closedStringArray(
    input.variants,
    `${caseId} input variants`,
  );
  closedStringArray(oracle.checks, `${caseId} oracle checks`);
  if (
    !['compiled', 'persisted', 'replayed', 'rejected', 'rolled_back'].includes(
      nonEmptyString(oracle.disposition, `${caseId} disposition`),
    ) ||
    !['not_applicable', 'committed', 'unchanged'].includes(
      nonEmptyString(oracle.sqlite_state, `${caseId} sqlite_state`),
    ) ||
    (oracle.exact_error !== null &&
      !['integrity_violation', 'cas_conflict', 'fault_injected'].includes(
        nonEmptyString(oracle.exact_error, `${caseId} exact_error`),
      ))
  )
    throw new Error(`${caseId} oracle is unknown`);

  if (category === 'fault') {
    const fault = objectValue(fixture.fault, `${caseId} fault`);
    exactKeys(fault, faultKeys, `${caseId} fault`);
    nonEmptyString(fault.point, `${caseId} fault point`);
    const faultVariants = closedStringArray(
      fault.variants,
      `${caseId} fault variants`,
    );
    if (canonicalJson(faultVariants) !== canonicalJson(variants))
      throw new Error(
        `${caseId} fault variants do not bind its input variants`,
      );
  } else if (fixture.fault !== null) {
    throw new Error(`${caseId} non-fault fixture has a fault binding`);
  }

  const typed = fixture as StaticChildPlanBundleFixtureCase;
  const { binding_hash: bindingHash, ...withoutBinding } = typed;
  if (
    calculateStaticChildPlanBundleFixtureBindingHash(withoutBinding) !==
    bindingHash
  )
    throw new Error(`${caseId} fixture binding hash drifted`);
  return typed;
}

export interface StaticChildPlanBundleFixtureArtifacts {
  readonly positive: readonly JsonValue[];
  readonly negative: readonly JsonValue[];
  readonly fault: readonly JsonValue[];
}

export interface StaticChildPlanBundleFixtureHandler {
  readonly id: string;
  execute(
    fixture: StaticChildPlanBundleFixtureCase,
  ): StaticChildPlanBundleFixtureOracle;
}

export interface StaticChildPlanBundleFixtureExecutionReceipt {
  readonly case_id: string;
  readonly category: StaticChildPlanBundleFixtureCategory;
  readonly surface: StaticChildPlanBundleFixtureSurface;
  readonly handler: string;
  readonly operation: StaticChildPlanBundleFixtureOperation;
  readonly binding_hash: string;
  readonly oracle: StaticChildPlanBundleFixtureOracle;
}

export class StaticChildPlanBundleFixtureExecutionHarness {
  readonly fixtures: readonly StaticChildPlanBundleFixtureCase[];
  readonly #handlers: readonly StaticChildPlanBundleFixtureHandler[];
  readonly #handled = new Map<string, number>();

  constructor(
    artifacts: StaticChildPlanBundleFixtureArtifacts,
    handlers: readonly StaticChildPlanBundleFixtureHandler[],
  ) {
    const fixtures = [
      ...artifacts.positive.map((value) => parseFixture(value, 'positive')),
      ...artifacts.negative.map((value) => parseFixture(value, 'negative')),
      ...artifacts.fault.map((value) => parseFixture(value, 'fault')),
    ];
    const expected = [
      ...STATIC_CHILD_PLAN_BUNDLE_POSITIVE_FIXTURES,
      ...STATIC_CHILD_PLAN_BUNDLE_NEGATIVE_FIXTURES,
      ...STATIC_CHILD_PLAN_BUNDLE_FAULT_FIXTURES,
    ];
    const ids = new Set<string>();
    for (const fixture of fixtures) {
      if (ids.has(fixture.case_id))
        throw new Error(
          `duplicate static child Plan bundle fixture id ${fixture.case_id}`,
        );
      ids.add(fixture.case_id);
    }
    if (
      canonicalJson(fixtures.map((fixture) => fixture.case_id).sort()) !==
      canonicalJson(expected.map((fixture) => fixture.case_id).sort())
    )
      throw new Error(
        'Static child Plan bundle fixture inventory is missing or unknown',
      );
    if (
      canonicalJson(fixtures.map((fixture) => fixture.case_id)) !==
      canonicalJson(expected.map((fixture) => fixture.case_id))
    )
      throw new Error(
        'Static child Plan bundle fixture inventory order drifted',
      );
    for (const expectedFixture of expected) {
      const observed = fixtures.find(
        (fixture) => fixture.case_id === expectedFixture.case_id,
      );
      if (
        !observed ||
        canonicalJson(observed) !== canonicalJson(expectedFixture)
      )
        throw new Error(
          `${expectedFixture.case_id} fixture bytes are not current`,
        );
    }
    this.fixtures = fixtures;
    this.#handlers = handlers;
  }

  execute(
    fixture: StaticChildPlanBundleFixtureCase,
  ): StaticChildPlanBundleFixtureExecutionReceipt {
    const checkedIn = this.fixtures.find(
      (candidate) => candidate.case_id === fixture.case_id,
    );
    if (!checkedIn || canonicalJson(checkedIn) !== canonicalJson(fixture))
      throw new Error(`${fixture.case_id} execution record is not checked in`);
    if ((this.#handled.get(fixture.case_id) ?? 0) !== 0)
      throw new Error(`${fixture.case_id} fixture was handled more than once`);
    const handlers = this.#handlers.filter(
      (handler) => handler.id === fixture.handler,
    );
    if (handlers.length !== 1)
      throw new Error(
        `${fixture.case_id} fixture has ${handlers.length} execution handlers`,
      );
    const oracle = handlers[0]!.execute(fixture);
    if (canonicalJson(oracle) !== canonicalJson(fixture.oracle))
      throw new Error(
        `${fixture.case_id} execution oracle mismatched: expected ${canonicalJson(fixture.oracle)}, received ${canonicalJson(oracle)}`,
      );
    this.#handled.set(fixture.case_id, 1);
    return {
      case_id: fixture.case_id,
      category: fixture.category,
      surface: fixture.surface,
      handler: fixture.handler,
      operation: fixture.operation,
      binding_hash: fixture.binding_hash,
      oracle,
    };
  }

  assertComplete(): void {
    const missing = this.fixtures
      .filter((fixture) => this.#handled.get(fixture.case_id) !== 1)
      .map((fixture) => fixture.case_id);
    if (missing.length > 0)
      throw new Error(
        `unhandled static child Plan bundle fixtures: ${missing.join(',')}`,
      );
  }
}
