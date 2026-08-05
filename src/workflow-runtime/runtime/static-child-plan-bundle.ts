import type {
  CompiledScopePlanV2Document,
  CompiledStaticChildPlanClosureMemberV1,
  CompiledStaticChildPlanClosureV1,
} from '../contracts/compiler-contract-repair-types.js';
import {
  STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR,
  STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
} from '../contracts/compiler-contract-repair-source.js';
import { canonicalJson, domainSeparatedSha256 } from '../contracts/hash.js';
import type {
  WorkflowCompilerStaticChildPlanBundle,
  WorkflowCompilerStaticChildPlanBundleEntry,
} from '../contracts/static-child-plan-bundle-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from '../contracts/types.js';
import { G5RuntimeError } from './graph-store.js';
import { verifyCompiledPlanAuthority } from './plan-authority.js';

const SOURCE_DOMAIN = 'icarus:workflow-graph-source:1\n';

const CLOSURE_KEYS = ['closure_hash', 'member_count', 'members'] as const;
const MEMBER_KEYS = [
  'closure_key',
  'factory_kind',
  'interface_snapshot_hash',
  'member_hash',
  'owner_node_path',
  'parent_closure_key',
  'plan_hash',
  'plan_ref',
  'scope_key',
  'source_hash',
  'source_ref',
] as const;
const BUNDLE_KEYS = ['entries', 'format'] as const;
const ENTRY_KEYS = ['closureKey', 'plan', 'source'] as const;

function fail(message: string): never {
  throw new G5RuntimeError('integrity_violation', message);
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} is not an object`);
  }
  return value as JsonObject;
}

function hasExactKeys(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(ascii);
  const sortedExpected = [...expected].sort(ascii);
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function planIdentity(plan: CompiledScopePlanV2Document): JsonObject {
  return {
    compiler_version: plan.compiler_version,
    capability_catalog_hash: plan.capability_catalog_hash,
    wait_contract_catalog_hash: plan.wait_contract_catalog_hash,
    runtime_safety_snapshot: plan.runtime_safety_snapshot,
    runtime_safety_hash: plan.runtime_safety_hash,
  };
}

function verifyClosure(
  value: unknown,
  label: string,
  externalParentKey: string | null = null,
): CompiledStaticChildPlanClosureV1 {
  const closure = object(value, label) as CompiledStaticChildPlanClosureV1;
  if (
    !hasExactKeys(closure, CLOSURE_KEYS) ||
    !Array.isArray(closure.members) ||
    !Number.isSafeInteger(closure.member_count) ||
    closure.member_count !== closure.members.length
  ) {
    fail(`${label} has an invalid closed shape or member count`);
  }

  const byKey = new Map<string, CompiledStaticChildPlanClosureMemberV1>();
  const children = new Map<
    string | null,
    CompiledStaticChildPlanClosureMemberV1[]
  >();
  for (const [index, candidate] of closure.members.entries()) {
    const member = object(
      candidate,
      `${label}.members[${index}]`,
    ) as CompiledStaticChildPlanClosureMemberV1;
    if (
      !hasExactKeys(member, MEMBER_KEYS) ||
      typeof member.closure_key !== 'string' ||
      member.closure_key.length === 0 ||
      (member.parent_closure_key !== null &&
        typeof member.parent_closure_key !== 'string') ||
      !Array.isArray(member.owner_node_path) ||
      member.owner_node_path.length === 0 ||
      member.owner_node_path.some(
        (segment) => typeof segment !== 'string' || segment.length === 0,
      ) ||
      member.owner_node_path.join('/') !== member.closure_key ||
      !['inline', 'template'].includes(member.factory_kind) ||
      typeof member.scope_key !== 'string' ||
      member.scope_key.length === 0
    ) {
      fail(`${label}.members[${index}] has an invalid closed lineage shape`);
    }
    const expectedParent =
      member.owner_node_path.length === 1
        ? null
        : member.owner_node_path.slice(0, -1).join('/');
    if (member.parent_closure_key !== expectedParent) {
      fail(`${label}.members[${index}] parent lineage drifted`);
    }
    if (byKey.has(member.closure_key)) {
      fail(`${label} contains duplicate closure key ${member.closure_key}`);
    }
    const { member_hash: claimedHash, ...withoutHash } = member;
    if (
      claimedHash !==
      domainSeparatedSha256(
        STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR,
        withoutHash as JsonObject,
      )
    ) {
      fail(`${label}.members[${index}] hash drifted`);
    }
    byKey.set(member.closure_key, member);
    const siblings = children.get(member.parent_closure_key) ?? [];
    siblings.push(member);
    children.set(member.parent_closure_key, siblings);
  }

  for (const member of closure.members) {
    if (
      member.parent_closure_key !== null &&
      member.parent_closure_key !== externalParentKey &&
      !byKey.has(member.parent_closure_key)
    ) {
      fail(`${label} contains an orphaned closure member`);
    }
  }
  const orderedKeys: string[] = [];
  const visit = (parent: string | null): void => {
    const siblings = [...(children.get(parent) ?? [])].sort((left, right) =>
      ascii(left.closure_key, right.closure_key),
    );
    for (const member of siblings) {
      orderedKeys.push(member.closure_key);
      visit(member.closure_key);
    }
  };
  visit(externalParentKey);
  if (
    orderedKeys.length !== closure.members.length ||
    orderedKeys.some(
      (closureKey, index) => closureKey !== closure.members[index]?.closure_key,
    )
  ) {
    fail(`${label} is not parent-before-descendant ASCII order`);
  }
  const withoutHash = {
    members: closure.members,
    member_count: closure.member_count,
  };
  if (
    closure.closure_hash !==
    domainSeparatedSha256(STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR, withoutHash)
  ) {
    fail(`${label} hash drifted`);
  }
  return closure;
}

export interface VerifiedStaticChildPlan {
  readonly closureKey: string;
  readonly source: JsonObject;
  readonly sourceHash: Sha256Hash;
  readonly plan: CompiledScopePlanV2Document;
}

export function verifyStaticChildPlanBundle(
  parentPlan: CompiledScopePlanV2Document,
  candidate: WorkflowCompilerStaticChildPlanBundle,
): VerifiedStaticChildPlan[] {
  const bundle = object(candidate, 'Static child Plan bundle');
  if (
    !hasExactKeys(bundle, BUNDLE_KEYS) ||
    bundle.format !== 'icarus.workflow-compiler-static-child-plan-bundle/1' ||
    !Array.isArray(bundle.entries)
  ) {
    fail('Static child Plan bundle has an invalid closed shape');
  }
  const parentClosure = verifyClosure(
    parentPlan.static_child_plan_closure,
    'Parent static child Plan closure',
  );
  if (bundle.entries.length !== parentClosure.members.length) {
    fail('Static child Plan bundle membership is incomplete or excessive');
  }
  const expectedIdentity = canonicalJson(planIdentity(parentPlan));
  const planBytesByHash = new Map<string, string>();
  const sourceBytesByHash = new Map<string, string>();
  const verified: VerifiedStaticChildPlan[] = [];

  for (const [index, candidateEntry] of bundle.entries.entries()) {
    const entry = object(
      candidateEntry,
      `Static child Plan bundle entry ${index}`,
    ) as unknown as WorkflowCompilerStaticChildPlanBundleEntry;
    if (!hasExactKeys(entry as unknown as JsonObject, ENTRY_KEYS)) {
      fail(
        `Static child Plan bundle entry ${index} has unknown or missing fields`,
      );
    }
    const member = parentClosure.members[index];
    if (
      !member ||
      typeof entry.closureKey !== 'string' ||
      entry.closureKey !== member.closure_key
    ) {
      fail(
        `Static child Plan bundle entry ${index} order or closure key drifted`,
      );
    }
    const source = object(
      entry.source,
      `Static child source ${entry.closureKey}`,
    );
    const plan = object(
      entry.plan,
      `Static child Plan ${entry.closureKey}`,
    ) as CompiledScopePlanV2Document;
    const sourceHash = domainSeparatedSha256(SOURCE_DOMAIN, source);
    const planHash = verifyCompiledPlanAuthority(plan);
    const expectedPlanRef = `content-addressed:workflow-plan/${planHash.slice('sha256:'.length)}`;
    if (
      source.format !== 'icarus.workflow-graph-scope/1' ||
      source.scope_key !== member.scope_key ||
      sourceHash !== member.source_hash ||
      plan.source_hash !== sourceHash ||
      planHash !== member.plan_hash ||
      member.plan_ref !== expectedPlanRef ||
      plan.interface_snapshot_hash !== member.interface_snapshot_hash ||
      canonicalJson(planIdentity(plan)) !== expectedIdentity
    ) {
      fail(
        `Static child Plan ${entry.closureKey} content or authority drifted`,
      );
    }
    const childClosure = verifyClosure(
      plan.static_child_plan_closure,
      `Static child Plan ${entry.closureKey} nested closure`,
      entry.closureKey,
    );
    const expectedDescendants = parentClosure.members.filter(
      (candidateMember) =>
        candidateMember.closure_key.startsWith(`${entry.closureKey}/`),
    );
    if (
      canonicalJson(childClosure.members) !== canonicalJson(expectedDescendants)
    ) {
      fail(`Static child Plan ${entry.closureKey} nested lineage drifted`);
    }

    const planBytes = canonicalJson(plan);
    const priorPlanBytes = planBytesByHash.get(planHash);
    if (priorPlanBytes !== undefined && priorPlanBytes !== planBytes) {
      fail(`Static child Plan hash ${planHash} aliases different bytes`);
    }
    planBytesByHash.set(planHash, planBytes);
    const sourceBytes = canonicalJson(source as JsonValue);
    const priorSourceBytes = sourceBytesByHash.get(sourceHash);
    if (priorSourceBytes !== undefined && priorSourceBytes !== sourceBytes) {
      fail(`Static child source hash ${sourceHash} aliases different bytes`);
    }
    sourceBytesByHash.set(sourceHash, sourceBytes);
    verified.push({
      closureKey: entry.closureKey,
      source,
      sourceHash,
      plan,
    });
  }
  return verified;
}
