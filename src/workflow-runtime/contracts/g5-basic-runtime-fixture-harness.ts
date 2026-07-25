import { canonicalJson } from './hash.js';
import {
  calculateG5RepairFixtureBindingHash,
  G5_REPAIR_FAULT_FIXTURES,
  G5_REPAIR_NEGATIVE_FIXTURES,
  G5_REPAIR_POSITIVE_FIXTURES,
  type G5RepairFixtureCase,
  type G5RepairFixtureCategory,
  type G5RepairFixtureOperationKind,
  type G5RepairFixtureOracle,
} from './g5-basic-runtime-repair-contract.js';
import type { JsonObject, JsonValue } from './types.js';

const fixtureKeys = [
  'assertion',
  'binding_hash',
  'case_id',
  'category',
  'handler',
  'operation',
  'oracle',
  'surface',
] as const;
const operationKeys = [
  'fault',
  'input',
  'kind',
  'scenario_key',
  'transaction',
] as const;
const inputKeys = [
  'expected_surface',
  'fixture_token',
  'idempotency_key',
  'mode',
  'now_ms',
  'payload',
  'rejection_code',
  'reopen_after',
  'replay_count',
] as const;
const faultKeys = ['boundary', 'point'] as const;
const payloadKeys = ['behavior', 'durable_relation', 'operation'] as const;
const oracleKeys = [
  'disposition',
  'exact_error',
  'reopen_required',
  'sqlite_state',
] as const;

function exactKeys(
  value: JsonObject,
  expected: readonly string[],
  label: string,
): void {
  const observed = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(observed) !== canonicalJson(wanted))
    throw new Error(`${label} field set is not closed`);
}

function objectValue(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object')
    throw new Error(`${label} must be an object`);
  return value;
}

const operationSurfaces: Readonly<
  Record<G5RepairFixtureOperationKind, readonly string[]>
> = {
  create_workflow_t0: ['T0'],
  prepare_required_finalization_t0p: ['T0p'],
  activate_workflow_t1: ['T1'],
  persist_compile_result_t2a: ['T2a'],
  materialize_root_scope_t2b: ['T2b'],
  initialize_fixed_point_t3a: ['T3a'],
  request_settled_close_t3b: ['T3b'],
  schedule_ready_node_t4: [
    'T2a',
    'T2a_T3a_T4',
    'T2a_T4',
    'T3a',
    'T3a_T4',
    'T4',
  ],
  prepare_capability_dispatch_t5: ['T5'],
  accept_internal_result_t6a: ['T6a'],
  accept_delegation_callback_t6b: ['T6b'],
  resolve_wait_t6c: ['T6c'],
  fire_attempt_watchdog_t6d: ['T6d'],
  capacity_admin_cap0_cap4: [
    'CAP0_CAP4',
    'CAP1_CAP2',
    'CAP2_CAP3',
    'CAP3_CAP4',
  ],
  open_operational_blocker: ['G5_BLOCKER'],
  node_output_envelope_store: [
    'T2a',
    'T2a_T3a_T4',
    'T2a_T4',
    'T3a',
    'T3a_T4',
    'T4',
    'STORE',
    'SCHEMA7_STORE',
  ],
};

function expectedHandler(kind: string, surface: string): string {
  const surfaces = operationSurfaces[kind as G5RepairFixtureOperationKind];
  if (!surfaces || !surfaces.includes(surface))
    throw new Error(`G5 fixture operation ${kind} is invalid for ${surface}`);
  return `${kind}_production`;
}

function parseFixture(
  value: JsonValue,
  artifactCategory: G5RepairFixtureCategory,
): G5RepairFixtureCase {
  const fixture = objectValue(value, 'G5 fixture');
  exactKeys(fixture, fixtureKeys, 'G5 fixture');
  const operation = objectValue(fixture.operation, 'G5 fixture operation');
  exactKeys(operation, operationKeys, 'G5 fixture operation');
  exactKeys(
    objectValue(operation.input, 'G5 fixture input'),
    inputKeys,
    'G5 fixture input',
  );
  exactKeys(
    objectValue(
      objectValue(operation.input, 'G5 fixture input').payload,
      'G5 fixture payload',
    ),
    payloadKeys,
    'G5 fixture payload',
  );
  if (operation.fault !== null)
    exactKeys(
      objectValue(operation.fault, 'G5 fixture fault'),
      faultKeys,
      'G5 fixture fault',
    );
  exactKeys(
    objectValue(fixture.oracle, 'G5 fixture oracle'),
    oracleKeys,
    'G5 fixture oracle',
  );
  const typed = fixture as G5RepairFixtureCase;
  if (typed.category !== artifactCategory)
    throw new Error(`${typed.case_id} category does not match its artifact`);
  if (typed.operation.transaction !== typed.surface)
    throw new Error(`${typed.case_id} operation surface is not exact`);
  if (typed.operation.input.expected_surface !== typed.surface)
    throw new Error(`${typed.case_id} input surface is not exact`);
  if (typed.handler !== expectedHandler(typed.operation.kind, typed.surface))
    throw new Error(`${typed.case_id} handler binding is invalid`);
  if (
    (typed.category === 'fault') !== (typed.operation.fault !== null) ||
    (typed.category !== 'fault') !== (typed.operation.fault === null)
  )
    throw new Error(`${typed.case_id} fault binding is invalid`);
  if (
    typed.operation.fault !== null &&
    typed.operation.fault.boundary !== typed.surface
  )
    throw new Error(`${typed.case_id} fault boundary is not exact`);
  const { binding_hash: bindingHash, ...withoutBinding } = typed;
  if (calculateG5RepairFixtureBindingHash(withoutBinding) !== bindingHash)
    throw new Error(`${typed.case_id} fixture binding hash drifted`);
  return typed;
}

export interface G5FixtureArtifacts {
  readonly positive: readonly JsonValue[];
  readonly negative: readonly JsonValue[];
  readonly fault: readonly JsonValue[];
}

export interface G5FixtureHandler {
  readonly id: string;
  execute(fixture: G5RepairFixtureCase): G5RepairFixtureOracle;
}

export interface G5FixtureExecutionReceipt {
  readonly case_id: string;
  readonly category: G5RepairFixtureCategory;
  readonly surface: string;
  readonly handler: string;
  readonly operation_kind: string;
  readonly oracle: G5RepairFixtureOracle;
}

export class G5FixtureExecutionHarness {
  readonly fixtures: readonly G5RepairFixtureCase[];
  readonly #handlers: readonly G5FixtureHandler[];
  readonly #handled = new Map<string, number>();

  constructor(
    artifacts: G5FixtureArtifacts,
    handlers: readonly G5FixtureHandler[],
  ) {
    const fixtures = [
      ...artifacts.positive.map((value) => parseFixture(value, 'positive')),
      ...artifacts.negative.map((value) => parseFixture(value, 'negative')),
      ...artifacts.fault.map((value) => parseFixture(value, 'fault')),
    ];
    const expected = [
      ...G5_REPAIR_POSITIVE_FIXTURES,
      ...G5_REPAIR_NEGATIVE_FIXTURES,
      ...G5_REPAIR_FAULT_FIXTURES,
    ];
    const ids = new Set<string>();
    for (const fixture of fixtures) {
      if (ids.has(fixture.case_id))
        throw new Error(`duplicate G5 fixture id ${fixture.case_id}`);
      ids.add(fixture.case_id);
    }
    if (
      canonicalJson(fixtures.map((fixture) => fixture.case_id).sort()) !==
      canonicalJson(expected.map((fixture) => fixture.case_id).sort())
    )
      throw new Error('G5 fixture inventory is missing or unknown');
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

  execute(fixture: G5RepairFixtureCase): G5FixtureExecutionReceipt {
    const checkedIn = this.fixtures.find(
      (candidate) => candidate.case_id === fixture.case_id,
    );
    if (!checkedIn || canonicalJson(checkedIn) !== canonicalJson(fixture))
      throw new Error(`${fixture.case_id} execution record is not checked in`);
    const count = this.#handled.get(fixture.case_id) ?? 0;
    if (count !== 0)
      throw new Error(`${fixture.case_id} fixture was handled more than once`);
    const handlers = this.#handlers.filter(
      (handler) => handler.id === fixture.handler,
    );
    if (handlers.length !== 1)
      throw new Error(
        `${fixture.case_id} fixture has ${handlers.length} execution handlers`,
      );
    const actual = handlers[0]!.execute(fixture);
    if (canonicalJson(actual) !== canonicalJson(fixture.oracle))
      throw new Error(
        `${fixture.case_id} execution oracle mismatched: expected ${canonicalJson(fixture.oracle)}, received ${canonicalJson(actual)}`,
      );
    this.#handled.set(fixture.case_id, 1);
    return {
      case_id: fixture.case_id,
      category: fixture.category,
      surface: fixture.surface,
      handler: fixture.handler,
      operation_kind: fixture.operation.kind,
      oracle: actual,
    };
  }

  assertComplete(): void {
    const missing = this.fixtures
      .filter((fixture) => this.#handled.get(fixture.case_id) !== 1)
      .map((fixture) => fixture.case_id);
    if (missing.length > 0)
      throw new Error(`unhandled G5 fixtures: ${missing.join(',')}`);
  }
}
