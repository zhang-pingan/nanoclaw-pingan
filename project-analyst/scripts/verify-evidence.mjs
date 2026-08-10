#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const contextPath = process.argv[2] || 'context.json';
const resultPath = process.argv[3] || 'analysis-result.json';
const context = JSON.parse(await readFile(contextPath, 'utf8'));
const result = JSON.parse(await readFile(resultPath, 'utf8'));
const allowed = new Set(context.resource_index || []);
const errors = [];
for (const finding of result.findings || [])
  for (const [kind, refs] of [
    ['affected', finding.affected_refs],
    ['evidence', finding.evidence_refs],
  ])
    for (const ref of refs || [])
      if (!allowed.has(ref))
        errors.push(`${finding.finding_id}: ${kind} ref is not in context: ${ref}`);
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write('All evidence refs exist in the frozen context.\n');
