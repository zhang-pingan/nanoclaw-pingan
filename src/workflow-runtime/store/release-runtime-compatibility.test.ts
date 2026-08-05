import { describe, expect, it } from 'vitest';
import {
  checkReleaseRuntimeCompatibility,
  SUPPORTED_RELEASE_RUNTIME_ABI_MAJOR,
} from './release-runtime-compatibility.js';

function resource(
  resourceType: 'feature_execution_artifact' | 'executor_implementation',
  runtimeAbiMajor: number,
) {
  return {
    resource_type: resourceType,
    content: { runtime_abi_major: runtimeAbiMajor },
  };
}

describe('Feature release runtime compatibility', () => {
  it('accepts the supported ABI for artifact and executor resources', () => {
    expect(
      checkReleaseRuntimeCompatibility([
        resource(
          'feature_execution_artifact',
          SUPPORTED_RELEASE_RUNTIME_ABI_MAJOR,
        ),
        resource(
          'executor_implementation',
          SUPPORTED_RELEASE_RUNTIME_ABI_MAJOR,
        ),
      ]),
    ).toEqual({ compatible: true });
  });

  it('rejects an unsupported runtime ABI directly', () => {
    expect(
      checkReleaseRuntimeCompatibility([
        resource('feature_execution_artifact', 2),
      ]),
    ).toEqual({ compatible: false, code: 'runtime_abi_incompatible' });
  });

  it('ignores Registry resources that do not execute code', () => {
    expect(
      checkReleaseRuntimeCompatibility([
        {
          resource_type: 'schema',
          content: {},
        },
      ]),
    ).toEqual({ compatible: true });
  });
});
