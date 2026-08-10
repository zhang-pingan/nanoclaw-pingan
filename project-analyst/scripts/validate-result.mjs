#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultPath = path.resolve(process.argv[2] || 'analysis-result.json');
const schema = JSON.parse(
  await readFile(path.join(root, 'contracts/analysis-result.schema.json'), 'utf8'),
);
const value = JSON.parse(await readFile(resultPath, 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);
if (!validate(value)) {
  process.stderr.write(`${ajv.errorsText(validate.errors, { separator: '\n' })}\n`);
  process.exitCode = 1;
} else process.stdout.write('Analysis result schema is valid.\n');
