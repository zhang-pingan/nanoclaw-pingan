import {
  WorkflowDefinition,
  WorkflowDefinitionRegistry,
  WorkflowDefinitionVersionBundle,
} from './workflow-definition.js';

function compareDefinitionVersion(
  a: WorkflowDefinition,
  b: WorkflowDefinition,
): number {
  return a.version - b.version;
}

function validateBundle(
  bundleKey: string,
  bundle: WorkflowDefinitionVersionBundle,
): string[] {
  const errors: string[] = [];
  const versionSeen = new Set<number>();
  let publishedCount = 0;

  if (bundle.key !== bundleKey) {
    errors.push(
      `workflow definition bundle key mismatch: object key "${bundleKey}" != bundle.key "${bundle.key}"`,
    );
  }

  if (!Array.isArray(bundle.versions) || bundle.versions.length === 0) {
    errors.push(`${bundleKey}.versions must contain at least one version`);
    return errors;
  }

  for (const definition of bundle.versions) {
    if (definition.key !== bundleKey) {
      errors.push(
        `${bundleKey}.versions contains definition with mismatched key "${definition.key}"`,
      );
    }
    if (versionSeen.has(definition.version)) {
      errors.push(
        `${bundleKey}.versions contains duplicate version ${definition.version}`,
      );
    }
    versionSeen.add(definition.version);
    if (definition.status === 'published') publishedCount += 1;
  }

  if (publishedCount > 1) {
    errors.push(`${bundleKey}.versions has more than one published version`);
  }

  return errors;
}

export function getPublishedWorkflowDefinitions(
  registry: WorkflowDefinitionRegistry,
): { definitions: Record<string, WorkflowDefinition>; errors: string[] } {
  const errors: string[] = [];
  const definitions: Record<string, WorkflowDefinition> = {};

  for (const [bundleKey, bundle] of Object.entries(registry.definitions)) {
    errors.push(...validateBundle(bundleKey, bundle));

    const published = bundle.versions
      .filter((definition) => definition.status === 'published')
      .sort(compareDefinitionVersion);

    if (published.length === 0) {
      errors.push(`${bundleKey}.versions has no published version`);
      continue;
    }

    definitions[bundleKey] = published[published.length - 1];
  }

  return { definitions, errors };
}
