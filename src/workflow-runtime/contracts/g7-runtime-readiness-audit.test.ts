import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { checkG7ControlProjectionContracts } from './g7-control-projection-contract.js';
import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject } from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function objects(value: unknown): JsonObject[] {
  expect(Array.isArray(value)).toBe(true);
  return value as JsonObject[];
}

describe('G7 Control / Card / Projection / Recovery readiness audit', () => {
  it('preserves all 13 commands, six typed targets, and the exact deadline System Grant', () => {
    const command = readArtifact(
      'protocols/workflow-runtime-command-protocol-table.json',
    );
    const entries = objects(command.payload.entries);
    expect(entries).toHaveLength(13);
    expect(new Set(entries.map((entry) => entry.command_type)).size).toBe(13);
    expect(new Set(entries.map((entry) => entry.target_kind))).toEqual(
      new Set([
        'workflow',
        'run',
        'node',
        'retry_schedule',
        'effect_operation',
        'operational_blocker',
      ]),
    );
    expect(
      entries.find((entry) => entry.command_type === 'cancel_workflow')
        ?.system_grant,
    ).toMatchObject({
      actor_kind: 'system',
      reason_codes: ['deadline_enforced', 'safety_enforced'],
      predicate: 'due_target',
      authority_scope: 'cancel_workflow_only',
      idempotency_domain: 'system:deadline-watchdog',
      idempotency_key_template:
        'workflow-deadline:<workflow_id>:<deadline_at_ms>',
      invocation_audit: 'required',
    });
  });

  it('preserves T7c and T6e authorization, atomic audit, and source-specific writes', () => {
    const transactions = readArtifact(
      'protocols/workflow-run-transaction-protocol-table.json',
    );
    const entries = objects(transactions.payload.entries);
    const t7c = entries.find((entry) => entry.transaction_id === 'T7c')!;
    const t6e = entries.find((entry) => entry.transaction_id === 'T6e')!;
    expect(t7c).toMatchObject({
      preconditions: expect.arrayContaining(['authorized_cancel_command']),
      atomic_writes: expect.arrayContaining(['command_invocation_audit']),
    });
    expect(t6e).toMatchObject({
      preconditions: expect.arrayContaining([
        'authorized_runtime_command',
        'source_specific_verification_succeeded',
      ]),
      atomic_writes: expect.arrayContaining([
        'append_only_remediation_attempt_and_evidence',
        'source_effect_schedule_claim_or_integrity_result',
        'exactly_one_blocker_resolved',
        'command_invocation_and_runtime_event',
      ]),
    });
  });

  it('keeps Projection and Renderer outside authoritative Runtime writes and monolith imports', () => {
    const projectionPaths = [
      'src/workflow-runtime/projection/workflow-projection.ts',
      'src/workflow-runtime/projection/runtime-center-api.ts',
      'src/workflow-runtime/projection/runtime-center-renderer/entry.ts',
    ];
    for (const relativePath of projectionPaths) {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
      expect(source).not.toMatch(
        /store\/runtime-store|runtime\/graph-store|WorkflowRuntimeWriteTransaction|withImmediateTransaction/,
      );
      expect(source).not.toMatch(
        /electron\/renderer\/app|feature.*renderer|monolith/i,
      );
    }
    const renderer = fs.readFileSync(
      path.join(
        repoRoot,
        'src/workflow-runtime/projection/runtime-center-renderer/entry.ts',
      ),
      'utf8',
    );
    expect(renderer).toMatch(/createRuntimeCenterRendererState/);
    expect(renderer).toMatch(/createRuntimeCenterCapacityRendererState/);
  });

  it('routes the Capacity subpage through the authoritative Admin Gateway only', () => {
    const source = fs.readFileSync(
      path.join(
        repoRoot,
        'src/workflow-runtime/capacity/runtime-center-api.ts',
      ),
      'utf8',
    );
    expect(source).toMatch(/GET \/api\/runtime-admin\/capacity/);
    expect(source).toMatch(/GET \/api\/runtime-admin\/capacity\/changes/);
    expect(source).toMatch(/POST \/api\/runtime-admin\/capacity\/changes/);
    expect(source).toMatch(/prepareCapacityChangeCAP0CAP1/);
    expect(source).toMatch(/installCAP2/);
    expect(source).toMatch(/commitHeadCAP3/);
    expect(source).toMatch(/publishCAP4/);
    expect(source).toMatch(/command_type !== 'replace_deployment_capacity'/);
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('records the physical unresolved-target audit residual without weakening typed FKs', () => {
    const schema = fs.readFileSync(
      path.join(
        repoRoot,
        'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v10.sql',
      ),
      'utf8',
    );
    expect(schema).toMatch(
      /FOREIGN KEY \("workflow_id"\) REFERENCES "workflows"/,
    );
    expect(schema).toMatch(
      /FOREIGN KEY \("run_id"\) REFERENCES "workflow_graph_runs"/,
    );
    expect(schema).not.toMatch(/opaque_target|unresolved_target/);
    const pack = checkG7ControlProjectionContracts();
    expect(pack.payload).toMatchObject({
      g7_done: false,
      g8_through_g9: 'NOT_READY',
    });
  });

  it('selects G7 generation/check/test scripts in the current global chain', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['contracts:g7:generate']).toContain(
      'g7-control-projection-contract-cli.ts generate',
    );
    expect(packageJson.scripts['contracts:g7:check']).toContain(
      'g7-control-projection-contract-cli.ts check',
    );
    expect(packageJson.scripts['contracts:generate']).toContain(
      'contracts:g7:generate',
    );
    expect(packageJson.scripts['contracts:check']).toContain(
      'contracts:g7:check',
    );
    expect(packageJson.scripts['test:g7']).toContain(
      'g7-control-projection-contract.test.ts',
    );
  });
});
