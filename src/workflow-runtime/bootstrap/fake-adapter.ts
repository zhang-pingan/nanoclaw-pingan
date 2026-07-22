import {
  g4FakeAdapterBehaviors,
  G4_FAKE_ADAPTER_INVOCATION_DOMAIN,
  G4_FAKE_ADAPTER_RESULT_DOMAIN,
} from '../contracts/g4-test-bootstrap-fixtures.js';
import {
  G4_FAKE_ADAPTER_OUTCOMES,
  type G4FakeAdapterBehavior,
  type G4FakeAdapterInvocation,
  type G4FakeAdapterResult,
} from '../contracts/g4-test-bootstrap-types.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';

export class G4FakeAdapterError extends Error {
  constructor(
    readonly code:
      | 'fake_adapter_profile_invalid'
      | 'fake_adapter_invocation_invalid'
      | 'fake_adapter_invocation_undeclared'
      | 'fake_adapter_outcome_undeclared'
      | 'fake_adapter_result_drift',
    message: string,
  ) {
    super(message);
    this.name = 'G4FakeAdapterError';
  }
}

function assertInvocation(invocation: G4FakeAdapterInvocation): void {
  const expectedKeys = [
    'attempt_no',
    'fixture_id',
    'format',
    'input',
    'invocation_hash',
    'operation_key',
  ].sort();
  const actualKeys = Object.keys(invocation).sort();
  const { invocation_hash: _hash, ...payload } = invocation;
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    invocation.format !== 'icarus.workflow-test-fake-adapter-invocation/1' ||
    !Number.isSafeInteger(invocation.attempt_no) ||
    invocation.attempt_no <= 0 ||
    invocation.invocation_hash !==
      domainSeparatedSha256(G4_FAKE_ADAPTER_INVOCATION_DOMAIN, payload)
  ) {
    throw new G4FakeAdapterError(
      'fake_adapter_invocation_invalid',
      'Fake Adapter invocation is not the exact closed canonical request',
    );
  }
}

function assertBehavior(behavior: G4FakeAdapterBehavior): void {
  assertInvocation(behavior.invocation);
  if (!G4_FAKE_ADAPTER_OUTCOMES.includes(behavior.response.outcome)) {
    throw new G4FakeAdapterError(
      'fake_adapter_outcome_undeclared',
      `Fake Adapter outcome is not declared: ${String(behavior.response.outcome)}`,
    );
  }
  const { replay_hash: _hash, ...resultPayload } = behavior.response;
  if (
    behavior.behavior_id !== behavior.invocation.fixture_id ||
    behavior.response.fixture_id !== behavior.invocation.fixture_id ||
    behavior.response.operation_key !== behavior.invocation.operation_key ||
    behavior.response.attempt_no !== behavior.invocation.attempt_no ||
    behavior.response.replay_hash !==
      domainSeparatedSha256(G4_FAKE_ADAPTER_RESULT_DOMAIN, resultPayload)
  ) {
    throw new G4FakeAdapterError(
      'fake_adapter_profile_invalid',
      `Fake Adapter behavior drifted: ${behavior.behavior_id}`,
    );
  }
}

export class G4FakeAdapter {
  readonly outcomeCount = G4_FAKE_ADAPTER_OUTCOMES.length;
  #behaviors: ReadonlyMap<string, G4FakeAdapterBehavior>;

  constructor(behaviors: readonly G4FakeAdapterBehavior[]) {
    if (behaviors.length !== G4_FAKE_ADAPTER_OUTCOMES.length) {
      throw new G4FakeAdapterError(
        'fake_adapter_profile_invalid',
        'Fake Adapter profile must contain exactly seven behaviors',
      );
    }
    const expectedById = new Map(
      g4FakeAdapterBehaviors().map((entry) => [entry.behavior_id, entry]),
    );
    const entries = new Map<string, G4FakeAdapterBehavior>();
    for (const behavior of behaviors) {
      assertBehavior(behavior);
      const expected = expectedById.get(behavior.behavior_id);
      if (!expected || canonicalJson(behavior) !== canonicalJson(expected)) {
        throw new G4FakeAdapterError(
          'fake_adapter_profile_invalid',
          `Fake Adapter behavior is not in the fixed G4 profile: ${behavior.behavior_id}`,
        );
      }
      if (entries.has(behavior.invocation.invocation_hash)) {
        throw new G4FakeAdapterError(
          'fake_adapter_profile_invalid',
          'Fake Adapter profile contains a duplicate invocation identity',
        );
      }
      entries.set(
        behavior.invocation.invocation_hash,
        structuredClone(behavior),
      );
    }
    if (
      new Set([...entries.values()].map((entry) => entry.response.outcome))
        .size !== G4_FAKE_ADAPTER_OUTCOMES.length
    ) {
      throw new G4FakeAdapterError(
        'fake_adapter_outcome_undeclared',
        'Fake Adapter profile must cover each closed outcome exactly once',
      );
    }
    this.#behaviors = entries;
  }

  invoke(invocation: G4FakeAdapterInvocation): G4FakeAdapterResult {
    assertInvocation(invocation);
    const behavior = this.#behaviors.get(invocation.invocation_hash);
    if (!behavior) {
      throw new G4FakeAdapterError(
        'fake_adapter_invocation_undeclared',
        `Fake Adapter invocation is not registered: ${invocation.invocation_hash}`,
      );
    }
    if (JSON.stringify(invocation) !== JSON.stringify(behavior.invocation)) {
      throw new G4FakeAdapterError(
        'fake_adapter_invocation_undeclared',
        'Fake Adapter invocation hash cannot alias different request bytes',
      );
    }
    const response = structuredClone(behavior.response);
    const { replay_hash: _hash, ...payload } = response;
    if (
      response.replay_hash !==
      domainSeparatedSha256(G4_FAKE_ADAPTER_RESULT_DOMAIN, payload)
    ) {
      throw new G4FakeAdapterError(
        'fake_adapter_result_drift',
        'Fake Adapter response identity drifted',
      );
    }
    return response;
  }
}
