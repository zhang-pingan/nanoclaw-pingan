import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { collaborationAnalysisJsonSchemas } from '../src/collaboration/analysis-contracts.js';

const output = path.resolve(process.cwd(), 'project-analyst/contracts');
mkdirSync(output, { recursive: true });
const schemas = collaborationAnalysisJsonSchemas();
for (const [name, schema] of [
  ['analysis-input.schema.json', schemas.input],
  ['analysis-result.schema.json', schemas.result],
  ['proposed-action.schema.json', schemas.action],
  ['repository-analysis-input.schema.json', schemas.repositoryInput],
  ['repository-analysis-result.schema.json', schemas.repositoryResult],
  ['repository-verification.schema.json', schemas.repositoryVerification],
] as const)
  writeFileSync(
    path.join(output, name),
    `${JSON.stringify(schema, null, 2)}\n`,
  );
