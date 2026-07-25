import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkG5BasicRuntimeRepairContracts,
  G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS,
} from './g5-basic-runtime-repair-contract.js';
import { G5_REPAIR_EXIT_STATUS } from './g5-basic-runtime-repair-types.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');

describe('current G5 Basic Runtime repair Contract Pack', () => {
  it('binds only the current repair authority and remains a non-DONE candidate', () => {
    const pack = checkG5BasicRuntimeRepairContracts();
    expect(pack.payload).toMatchObject({
      status: G5_REPAIR_EXIT_STATUS,
      g5_done: false,
      g6_through_g9: 'NOT_READY',
      historical_g5_candidate_authority: 'forbidden',
      positive_case_count: 7,
      negative_case_count: 14,
      fault_case_count: 3,
    });
    expect(JSON.stringify(pack)).not.toContain(
      'contract-pack-g5-basic-runtime.json',
    );
    expect(JSON.stringify(pack)).not.toContain('conformance/g5-basic-runtime/');
  });

  it('binds production sources and preserves forbidden ownership boundaries', () => {
    expect(G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS).toHaveLength(18);
    for (const relativePath of G5_REPAIR_IMPLEMENTATION_SOURCE_PATHS) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toMatch(
        /workflow-runtime\/bootstrap|g4-test-bootstrap/,
      );
      expect(source).not.toMatch(
        /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+["`']?(?:workflow_runtime_commands|workflow_runtime_command_invocations|workflow_graph_completion_cuts|workflow_relations)\b/i,
      );
      expect(source).not.toMatch(/\bworkflow_deadline\b|\bT6e\b/);
      expect(source).not.toMatch(
        /https?:\/\/|registry.*latest|network.*fallback/i,
      );
    }
  });
});
