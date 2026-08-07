import type { JsonObject } from '../contracts/types.js';

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Binds a dynamic compilation to the policy already sealed into its owner. */
export function dynamicChildCompilerInputSnapshot(
  base: JsonObject,
  ownerNode: JsonObject,
): JsonObject {
  const policySnapshot = object(base.policy_snapshot);
  const completePolicy = object(policySnapshot?.complete_policy);
  const childPolicy = object(ownerNode.child_policy);
  const profileRef = object(childPolicy?.profile_ref);
  const effectivePolicy = object(childPolicy?.effective_policy_snapshot);
  const effectivePolicyHash = childPolicy?.effective_policy_hash;
  if (
    !policySnapshot ||
    !completePolicy ||
    !profileRef ||
    !effectivePolicy ||
    typeof effectivePolicyHash !== 'string'
  ) {
    throw new Error('Dynamic child compiler policy authority is incomplete');
  }
  return {
    ...base,
    policy_snapshot: {
      ...policySnapshot,
      complete_policy: {
        ...completePolicy,
        root_policy_ref: profileRef,
        root_policy: effectivePolicy,
        policy_hash: effectivePolicyHash,
      },
    },
  };
}
