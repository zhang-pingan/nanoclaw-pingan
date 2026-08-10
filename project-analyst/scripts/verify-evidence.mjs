#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const contextPath = process.argv[2] || 'context.json';
const resultPath = process.argv[3] || 'analysis-result.json';
const context = JSON.parse(await readFile(contextPath, 'utf8'));
const result = JSON.parse(await readFile(resultPath, 'utf8'));
if (
  ![
    'icarus.collaboration-analysis-input/1',
    'icarus.collaboration-repository-analysis-input/1',
  ].includes(context.format)
)
  throw new Error(`unsupported analysis context format: ${context.format}`);
if (
  ![
    'icarus.collaboration-analysis-result/1',
    'icarus.collaboration-repository-analysis-result/1',
  ].includes(result.format)
)
  throw new Error(`unsupported analysis result format: ${result.format}`);
const allowed = new Set(context.resource_index || []);
const errors = [];
const findingIds = new Set();
const requireRef = (findingId, kind, ref) => {
  if (!allowed.has(ref))
    errors.push(`${findingId}: ${kind} ref is not in context: ${ref}`);
};
for (const finding of result.findings || []) {
  if (findingIds.has(finding.finding_id))
    errors.push(`duplicate finding_id: ${finding.finding_id}`);
  findingIds.add(finding.finding_id);
  for (const [kind, refs] of [
    ['affected', finding.affected_refs],
    ['evidence', finding.evidence_refs],
  ])
    for (const ref of refs || []) requireRef(finding.finding_id, kind, ref);
  for (const proposal of finding.proposed_actions || []) {
    const parameters = proposal.parameters || {};
    if (proposal.action === 'create_work_item')
      for (const id of parameters.related_work_item_ids || [])
        requireRef(finding.finding_id, 'action', `work_item:${id}`);
    if (proposal.action === 'open_discussion') {
      if (parameters.scope?.type && parameters.scope.type !== 'group')
        requireRef(
          finding.finding_id,
          'action',
          `${parameters.scope.type}:${parameters.scope.ref}`,
        );
      for (const id of parameters.mentions || [])
        requireRef(finding.finding_id, 'action', `principal:${id}`);
    }
    if (proposal.action === 'post_progress') {
      for (const id of parameters.work_item_refs || [])
        requireRef(finding.finding_id, 'action', `work_item:${id}`);
      for (const id of parameters.workflow_instance_refs || [])
        requireRef(finding.finding_id, 'action', `workflow_instance:${id}`);
    }
    if (proposal.action === 'watch_work_item')
      requireRef(
        finding.finding_id,
        'action',
        `work_item:${parameters.work_item_id}`,
      );
    if (proposal.action === 'request_information') {
      for (const ref of parameters.affected_refs || [])
        requireRef(finding.finding_id, 'action', ref);
      for (const id of parameters.mentions || [])
        requireRef(finding.finding_id, 'action', `principal:${id}`);
    }
    if (proposal.action === 'publish_analysis_report')
      for (const id of parameters.include_finding_ids || [])
        if (
          !(result.findings || []).some(
            (candidate) => candidate.finding_id === id,
          )
        )
          errors.push(
            `${finding.finding_id}: action references unknown finding: ${id}`,
          );
  }
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else process.stdout.write('All evidence refs exist in the frozen context.\n');
