import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function objects(value: unknown): JsonObject[] {
  expect(Array.isArray(value)).toBe(true);
  return value as JsonObject[];
}

describe('G5 Basic Runtime Capacity Admin readiness audit', () => {
  it('proves CAP1 writes one immutable prepared Invocation before external publication', () => {
    const protocol = readArtifact(
      'conformance/capacity-control-plane-addendum/protocols/capacity-control-plane-protocol@1.json',
    );
    const steps = objects(protocol.payload.steps);
    const cap1 = steps.find((entry) => entry.protocol_id === 'CAP1')!;
    const cap2 = steps.find((entry) => entry.protocol_id === 'CAP2')!;
    const cap3 = steps.find((entry) => entry.protocol_id === 'CAP3')!;
    const cap4 = steps.find((entry) => entry.protocol_id === 'CAP4')!;

    expect(cap1).toMatchObject({
      transaction_mode: 'begin_immediate',
      external_work: 'none',
      atomic_writes: expect.arrayContaining([
        'Command Header and immutable allowed prepared Invocation with decided_at_ms and null applied_at_ms',
        'pending head and prepared hash-chain event',
      ]),
      success_outcome: 'durable prepared journal drives the only Publisher',
    });
    expect(cap2.external_work).toBe('filesystem_durability');
    expect(cap3.atomic_writes).toEqual(
      expect.arrayContaining([
        'advance current revision change config and publication hash',
        'clear pending change',
      ]),
    );
    expect(cap4.atomic_writes).toContain('finalize canonical Command result');
    expect(cap1.forbidden_actions).toContain(
      'update or finalize the prepared Invocation after CAP1',
    );
    expect(cap4.forbidden_actions).toContain(
      'update the immutable CAP1 prepared Invocation',
    );

    const positiveCases = readArtifact(
      'conformance/capacity-control-plane-addendum/positive-cases.json',
    );
    const preparedCases = objects(positiveCases.payload.cases).filter(
      (entry) => entry.expected_result === 'prepared',
    );
    expect(preparedCases).toHaveLength(4);
    expect(
      preparedCases.every(
        (entry) => entry.expected_head_effect === 'pending_prepared',
      ),
    ).toBe(true);
  });

  it('proves Schema 5 encodes only the closed prepared combination and makes Invocation immutable', () => {
    const manifest = readArtifact(
      '../store/schema/artifacts/workflow-runtime-schema-manifest@1.json',
    );
    expect(manifest.payload.database_schema_version).toBe(5);
    const invocation = objects(manifest.payload.tables).find(
      (entry) => entry.name === 'runtime_capacity_admin_invocations',
    )!;
    const checks = objects(invocation.checks);
    const executionEnum = checks.find(
      (entry) =>
        entry.check_id ===
        'ck:runtime_capacity_admin_invocations:execution_result:enum',
    )!;
    const resultConsistency = checks.find(
      (entry) =>
        entry.check_id === 'ck:capacity_invocations:result_consistency',
    )!;

    expect(executionEnum.expression_sql).toBe(
      "\"execution_result\" IN ('prepared', 'applied', 'denied', 'conflict', 'duplicate', 'failed')",
    );
    expect(resultConsistency.expression_sql).toContain(
      '"execution_result" = \'prepared\' AND "invocation_no" = 1 AND "denial_code" IS NULL AND "decided_at_ms" >= "requested_at_ms" AND "applied_at_ms" IS NULL',
    );

    const triggers = objects(manifest.payload.triggers);
    expect(
      triggers
        .filter((entry) =>
          String(entry.name).startsWith('trg:capacity_invocations:'),
        )
        .map((entry) => entry.name),
    ).toEqual([
      'trg:capacity_invocations:prepared_insert',
      'trg:capacity_invocations:applied_insert',
      'trg:capacity_invocations:terminal_insert',
      'trg:capacity_invocations:duplicate_insert',
      'trg:capacity_invocations:immutable_update',
      'trg:capacity_invocations:immutable_delete',
    ]);

    const protocol = readArtifact(
      'conformance/capacity-control-plane-addendum/protocols/capacity-control-plane-protocol@1.json',
    );
    const postPrepareWrites = objects(protocol.payload.steps)
      .filter(
        (entry) => entry.protocol_id !== 'CAP0' && entry.protocol_id !== 'CAP1',
      )
      .flatMap((entry) => entry.atomic_writes as string[]);
    expect(postPrepareWrites.join('\n')).not.toMatch(
      /update.*Invocation|finalize.*Invocation/i,
    );
  });

  it('binds duplicate retry and CAP4 recovery to Command finalization without mutating prepared', () => {
    const positiveCases = readArtifact(
      'conformance/capacity-control-plane-addendum/positive-cases.json',
    );
    expect(
      objects(positiveCases.payload.cases).find(
        (entry) => entry.scenario === 'cap4_retry_duplicate_preserves_prepared',
      ),
    ).toMatchObject({
      expected_result: 'canonical_result_new_duplicate_prepared_unchanged',
      expected_head_effect: 'committed',
    });
    const faultCases = readArtifact(
      'conformance/capacity-control-plane-addendum/fault-cases.json',
    );
    expect(
      objects(faultCases.payload.cases).find(
        (entry) =>
          entry.scenario === 'cap4_recovery_preserves_prepared_invocation',
      ),
    ).toMatchObject({
      expected_result: 'prepared_unchanged_command_finalized_idempotently',
      expected_head_effect: 'committed',
    });
  });
});
