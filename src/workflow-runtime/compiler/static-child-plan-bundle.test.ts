import { describe, expect, it } from 'vitest';

import type { CompiledScopePlanV2Document } from '../contracts/compiler-contract-repair-types.js';
import { canonicalJson } from '../contracts/hash.js';
import type { JsonObject } from '../contracts/types.js';
import { compileWorkflow } from './compiler.js';
import { readGoldenCorpus } from './golden.js';
import type { WorkflowCompilerIdentity } from './types.js';

function fixture(): {
  source: JsonObject;
  snapshot: JsonObject;
  expectedPlan: CompiledScopePlanV2Document;
} {
  const goldenCase = readGoldenCorpus().cases.cases.find(
    (entry) => entry.case_id === 'positive.static-child-closure',
  );
  if (
    !goldenCase ||
    goldenCase.expected_result.outcome !== 'compiled' ||
    !goldenCase.expected_result.normalized_plan
  ) {
    throw new Error('Golden static-child fixture is missing');
  }
  return {
    source: JSON.parse(
      Buffer.from(goldenCase.raw_source_base64, 'base64').toString('utf8'),
    ) as JsonObject,
    snapshot: goldenCase.registry_snapshot,
    expectedPlan: goldenCase.expected_result.normalized_plan,
  };
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
