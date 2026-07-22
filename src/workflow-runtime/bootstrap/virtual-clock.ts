import { g4VirtualClockProfile } from '../contracts/g4-test-bootstrap-fixtures.js';
import type { G4VirtualClockProfile } from '../contracts/g4-test-bootstrap-types.js';
import { canonicalJson } from '../contracts/hash.js';

export class G4VirtualClockError extends Error {
  constructor(
    readonly code:
      | 'virtual_clock_profile_mismatch'
      | 'virtual_clock_advance_invalid'
      | 'virtual_clock_rollback'
      | 'virtual_clock_drift',
    message: string,
  ) {
    super(message);
    this.name = 'G4VirtualClockError';
  }
}

function assertProfile(
  profile: Readonly<G4VirtualClockProfile>,
): G4VirtualClockProfile {
  const candidate = structuredClone(profile) as G4VirtualClockProfile;
  if (canonicalJson(candidate) !== canonicalJson(g4VirtualClockProfile())) {
    throw new G4VirtualClockError(
      'virtual_clock_profile_mismatch',
      'G4 Virtual Clock requires the exact closed profile',
    );
  }
  return candidate;
}

export class G4VirtualClock {
  readonly profile: Readonly<G4VirtualClockProfile>;
  #nowMs: number;

  constructor(profile: Readonly<G4VirtualClockProfile>) {
    this.profile = Object.freeze(assertProfile(profile));
    this.#nowMs = this.profile.initial_time_ms;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  advanceBy(durationMs: number): number {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
      throw new G4VirtualClockError(
        'virtual_clock_advance_invalid',
        'Virtual Clock advancement must be a positive safe integer',
      );
    }
    const next = this.#nowMs + durationMs;
    if (!Number.isSafeInteger(next)) {
      throw new G4VirtualClockError(
        'virtual_clock_advance_invalid',
        'Virtual Clock advancement exceeds the safe-integer range',
      );
    }
    this.#nowMs = next;
    return this.#nowMs;
  }

  advanceTo(instantMs: number): number {
    if (!Number.isSafeInteger(instantMs) || instantMs < this.#nowMs) {
      throw new G4VirtualClockError(
        'virtual_clock_rollback',
        'Virtual Clock cannot move backward',
      );
    }
    if (instantMs === this.#nowMs) return this.#nowMs;
    return this.advanceBy(instantMs - this.#nowMs);
  }

  assertNow(expectedMs: number): void {
    if (this.#nowMs !== expectedMs) {
      throw new G4VirtualClockError(
        'virtual_clock_drift',
        `Virtual Clock drift: expected ${expectedMs}, observed ${this.#nowMs}`,
      );
    }
  }
}
