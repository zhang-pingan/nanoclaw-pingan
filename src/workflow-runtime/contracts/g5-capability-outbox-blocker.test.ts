import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
const workflowRuntimeRoot = path.resolve(contractsRoot, '..');
const repoRoot = path.resolve(workflowRuntimeRoot, '../..');

function read(relativePath: string): Buffer {
  return fs.readFileSync(path.join(repoRoot, relativePath));
}

describe('G5 Capability to Outbox execution-binding blocker', () => {
  it('proves current closed Compiled Plan has no Adapter or Delivery Policy binding', () => {
    for (const relativePath of [
      'src/workflow-runtime/contracts/schemas/compiled-scope-plan-schema.json',
      'src/workflow-runtime/contracts/conformance/compiler-contract-repair/schemas/compiled-scope-plan-v2-schema.json',
    ]) {
      const source = read(relativePath).toString('utf8');
      expect(source).not.toContain('adapter_ref');
      expect(source).not.toContain('delivery_policy_ref');
    }

    const plan = strictParseJsonBytes(
      read(
        'src/workflow-runtime/contracts/conformance/sealed/g2-production-compiler-replay-repair-v2/expected/positive.static-lowering.plan.json',
      ),
    ) as JsonObject;
    const capability = (plan.nodes as JsonObject[]).find(
      (node) => node.capability_binding !== undefined,
    )?.capability_binding as JsonObject;
    expect(Object.keys(capability).sort()).toEqual([
      'allowed_groups',
      'cancellation',
      'dependency_closure_hash',
      'effect',
      'effect_impact',
      'executor_ref',
      'input_ports',
      'no_artifact_expected',
      'no_evaluation_expected',
      'node_type',
      'output_ports',
      'quality_revision_policy',
      'ref',
      'required_claims',
      'required_file_scopes',
      'required_mcp_methods',
      'required_tools',
      'retry_policy',
      'skill_refs',
      'timeout_ceiling_ms',
    ]);
  });

  it('proves Schema 5 Outbox requires the missing exact Registry identities', () => {
    const migration = read(
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v1.sql',
    ).toString('utf8');
    for (const column of [
      'adapter_resource_id',
      'adapter_resource_hash',
      'delivery_policy_resource_id',
      'delivery_policy_resource_hash',
      'policy_snapshot_value_id',
      'policy_snapshot_hash',
    ]) {
      expect(migration).toMatch(new RegExp(`"${column}" TEXT NOT NULL`, 'u'));
    }
    expect(migration).toContain('CONSTRAINT "fk:outbox:adapter"');
    expect(migration).toContain('CONSTRAINT "fk:outbox:delivery_policy"');
    expect(migration).toContain('CONSTRAINT "fk:outbox:policy_snapshot"');
  });
});
