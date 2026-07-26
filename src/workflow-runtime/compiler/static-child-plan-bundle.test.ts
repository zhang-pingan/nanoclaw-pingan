import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import { canonicalJson } from '../contracts/hash.js';
import type { JsonObject } from '../contracts/types.js';
import { compileWorkflow } from './compiler.js';
import type { WorkflowCompilerIdentity } from './types.js';

const sealedRoot = path.resolve(
  import.meta.dirname,
  '../contracts/conformance/sealed/g2-generated-schema-join-authority-v6',
);

function fixture(): {
  source: JsonObject;
  snapshot: JsonObject;
  expectedPlan: CompiledScopePlanV2Document;
} {
  const source = JSON.parse(
    fs.readFileSync(
      path.join(sealedRoot, 'inputs/positive.static-child-closure.source.json'),
      'utf8',
    ),
  ) as JsonObject;
  const snapshotArtifact = JSON.parse(
    fs.readFileSync(
      path.join(
        sealedRoot,
        'inputs/positive.static-child-closure.snapshot@2.json',
      ),
      'utf8',
    ),
  ) as { payload: JsonObject };
  const expectedPlan = JSON.parse(
    fs.readFileSync(
      path.join(sealedRoot, 'expected/positive.static-child-closure.plan.json'),
      'utf8',
    ),
  ) as CompiledScopePlanV2Document;
  return { source, snapshot: snapshotArtifact.payload, expectedPlan };
}

function compile(source: JsonObject, snapshot: JsonObject) {
  return compileWorkflow({
    caseId: 'static-child-plan-bundle',
    sourceKind: 'graph_scope',
    rawSourceBytes: Buffer.from(canonicalJson(source), 'utf8'),
    inputSnapshot: snapshot,
    identity: snapshot.compiler_identity as unknown as WorkflowCompilerIdentity,
  });
}

describe('Compiler static child Plan bundle', () => {
  it('returns nested child Plan bytes without changing the sealed parent Plan', () => {
    const input = fixture();
    const outcome = compile(input.source, input.snapshot);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(canonicalJson(outcome.value.plan)).toBe(
      canonicalJson(input.expectedPlan),
    );
    expect(outcome.value.staticChildPlanBundle.format).toBe(
      'icarus.workflow-compiler-static-child-plan-bundle/1',
    );
    expect(
      outcome.value.staticChildPlanBundle.entries.map(
        (entry) => entry.closureKey,
      ),
    ).toEqual(['nested', 'nested/leaf']);
    expect(
      outcome.value.staticChildPlanBundle.entries.map(
        (entry) => entry.plan.plan_hash,
      ),
    ).toEqual(
      input.expectedPlan.static_child_plan_closure.members.map(
        (member) => member.plan_hash,
      ),
    );
    expect(
      outcome.value.staticChildPlanBundle.entries.map(
        (entry) => entry.plan.static_child_plan_closure.member_count,
      ),
    ).toEqual([1, 0]);
  });

  it('keeps repeated content-addressed descendant Plans as exact shared bytes', () => {
    const input = fixture();
    const source = structuredClone(input.source);
    const nodes = source.nodes as JsonObject[];
    const original = nodes.find((node) => node.id === 'nested')!;
    const copy = structuredClone(original);
    copy.id = 'nested_copy';
    nodes.splice(nodes.length - 1, 0, copy);
    const done = nodes.find((node) => node.id === 'done')!;
    (done.trigger as JsonObject).edge_ids = ['edge.nested', 'edge.nested-copy'];
    (source.control_edges as JsonObject[]).push({
      id: 'edge.nested-copy',
      kind: 'control',
      from_node_id: 'nested_copy',
      to_node_id: 'done',
      on: { statuses: ['succeeded'] },
    });

    const outcome = compile(source, input.snapshot);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const entries = outcome.value.staticChildPlanBundle.entries;
    expect(entries.map((entry) => entry.closureKey)).toEqual([
      'nested',
      'nested/leaf',
      'nested_copy',
      'nested_copy/leaf',
    ]);
    const leaves = entries.filter((entry) =>
      entry.closureKey.endsWith('/leaf'),
    );
    expect(leaves).toHaveLength(2);
    expect(leaves[0]!.plan.plan_hash).toBe(leaves[1]!.plan.plan_hash);
    expect(canonicalJson(leaves[0]!.plan)).toBe(canonicalJson(leaves[1]!.plan));
    expect(canonicalJson(leaves[0]!.source)).toBe(
      canonicalJson(leaves[1]!.source),
    );
  });
});
