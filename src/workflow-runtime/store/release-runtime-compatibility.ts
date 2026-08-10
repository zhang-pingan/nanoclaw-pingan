import type { JsonObject } from '../contracts/types.js';

export const SUPPORTED_RELEASE_RUNTIME_ABI_MAJOR = 1;

export type ReleaseRuntimeCompatibilityResult =
  | { compatible: true }
  | {
      compatible: false;
      code: 'runtime_abi_incompatible';
    };

export interface ReleaseRuntimeResource {
  readonly resource_type: string;
  readonly content: JsonObject;
}

export function checkReleaseRuntimeCompatibility(
  resources: readonly ReleaseRuntimeResource[],
): ReleaseRuntimeCompatibilityResult {
  const runtimeResources = resources.filter(
    ({ resource_type }) =>
      resource_type === 'pack_execution_artifact' ||
      resource_type === 'executor_implementation',
  );

  for (const { content } of runtimeResources) {
    if (
      !Number.isSafeInteger(content.runtime_abi_major) ||
      content.runtime_abi_major !== SUPPORTED_RELEASE_RUNTIME_ABI_MAJOR
    ) {
      return { compatible: false, code: 'runtime_abi_incompatible' };
    }
  }

  return { compatible: true };
}
