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
  it('proves CAP1 requires an allowed Invocation before external publication completes', () => {
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
        'Command Header and allowed Invocation',
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

  it('proves Schema 4 cannot encode that allowed pending/prepared Invocation', () => {
    const manifest = readArtifact(
      '../store/schema/artifacts/workflow-runtime-schema-manifest@1.json',
    );
    expect(manifest.payload.database_schema_version).toBe(4);
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
      "\"execution_result\" IN ('applied', 'denied', 'conflict', 'duplicate', 'failed')",
    );
    expect(String(executionEnum.expression_sql)).not.toMatch(
      /pending|prepared/,
    );
    expect(resultConsistency.expression_sql).toContain(
      '"execution_result" = \'applied\' AND "denial_code" IS NULL AND "applied_at_ms" IS NOT NULL',
    );
    expect(resultConsistency.expression_sql).toContain(
      "\"execution_result\" IN ('conflict', 'duplicate', 'failed') AND \"applied_at_ms\" IS NULL",
    );

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
});
