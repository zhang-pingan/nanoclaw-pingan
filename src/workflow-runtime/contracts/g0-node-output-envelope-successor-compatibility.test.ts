import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  const bytes = fs.readFileSync(path.join(contractsRoot, relativePath));
  return {
    raw: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    artifact: parseContractArtifactEnvelope(strictParseJsonBytes(bytes)),
  };
}

describe('G0 compatibility with the NodeOutputEnvelope authority successor', () => {
  it('keeps frozen G0.10 and static-absence machine authority byte-exact', () => {
    const capacity = readArtifact(
      'conformance/capacity-control-plane-addendum/contract-pack-capacity-control-plane-addendum.json',
    );
    expect(capacity).toMatchObject({
      raw: 'sha256:c6a24147105f1b5f91a34b35810245387cfa2a6fa243c4d0ee98811faff43b70',
      artifact: {
        hash: 'sha256:d436710893239f01e53d668c23d5ddcfe1a7e4dbee3c00074bc4cd43871c98a6',
      },
    });
    expect(capacity.artifact.payload.artifacts).toHaveLength(25);

    const absence = readArtifact('contract-pack-static-absence.json');
    expect(absence).toMatchObject({
      raw: 'sha256:129dbe486e53126b25d3250424e170698b7fdacf63d263149834f56d75394f4a',
      artifact: {
        hash: 'sha256:058519662cfdff17e7a11a40a6da3b3dfe9d2b27c5d7fc6a81b23a35fd9bd183',
      },
    });
    expect(absence.artifact.payload.artifacts).toHaveLength(9);
  });

  it('admits only the governed successor while keeping later Gates closed', () => {
    const r019 = readArtifact(
      'conformance/generated-schema-join-authority-repair/contract-pack-generated-schema-join-authority-repair.json',
    ).artifact;
    const readiness = readArtifact(
      'contract-pack-node-output-envelope-schema-authority-readiness.json',
    ).artifact;
    expect(r019.payload).toMatchObject({
      status:
        'NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
    });
    expect(readiness.payload).toMatchObject({
      g5: {
        gate_status: 'BLOCKED_BY_SPEC',
        readiness: 'NOT_READY',
        runtime_construction_performed: false,
      },
      g6_through_g9_status: 'NOT_READY',
      certification_or_production_authorized: false,
    });
  });
});
