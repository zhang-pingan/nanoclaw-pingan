import type {
  G3RegistryExactResourceQueryInput,
  G3RegistryExactResourceQueryRecord,
} from '../contracts/g3-registry-exact-resource-query-types.js';
import { queryExactRegistryResource } from '../store/registry-resource-query.js';
import type { WorkflowRuntimeReadConnection } from '../store/runtime-store/index.js';
import { G5RuntimeError } from '../runtime/graph-store.js';

export interface PreparedRecipeRegistry {
  readonly recipe: G3RegistryExactResourceQueryRecord;
  readonly definition: G3RegistryExactResourceQueryRecord;
  readonly executionPolicy: G3RegistryExactResourceQueryRecord;
  readonly commandPolicy: G3RegistryExactResourceQueryRecord;
  readonly inputSchema: G3RegistryExactResourceQueryRecord;
  readonly contextContract: G3RegistryExactResourceQueryRecord;
  readonly routingScope: G3RegistryExactResourceQueryRecord;
}

export function prepareExactRecipeRegistry(
  connection: Pick<WorkflowRuntimeReadConnection, 'queryAll' | 'queryOne'>,
  requests: {
    readonly recipe: G3RegistryExactResourceQueryInput;
    readonly definition: G3RegistryExactResourceQueryInput;
    readonly executionPolicy: G3RegistryExactResourceQueryInput;
    readonly commandPolicy: G3RegistryExactResourceQueryInput;
    readonly inputSchema: G3RegistryExactResourceQueryInput;
    readonly contextContract: G3RegistryExactResourceQueryInput;
    readonly routingScope: G3RegistryExactResourceQueryInput;
  },
): PreparedRecipeRegistry {
  const read = (
    name: keyof typeof requests,
  ): G3RegistryExactResourceQueryRecord => {
    const result = queryExactRegistryResource(connection, requests[name]);
    if (result.outcome !== 'accepted') {
      throw new G5RuntimeError(
        'precondition_failed',
        `Exact ${name} Registry query failed closed: ${result.code}`,
      );
    }
    if (result.resource.publication_state !== 'published') {
      throw new G5RuntimeError(
        'precondition_failed',
        `${name} is not Published`,
      );
    }
    return result.resource;
  };
  return {
    recipe: read('recipe'),
    definition: read('definition'),
    executionPolicy: read('executionPolicy'),
    commandPolicy: read('commandPolicy'),
    inputSchema: read('inputSchema'),
    contextContract: read('contextContract'),
    routingScope: read('routingScope'),
  };
}
