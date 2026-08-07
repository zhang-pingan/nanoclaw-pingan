import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import { sanitizePersonalWorkflowSource, TaskWorkspaceStore } from './store.js';

const roots: string[] = [];
const stores: TaskWorkspaceStore[] = [];

function sha(char: string): Sha256Hash {
  return `sha256:${char.repeat(64)}` as Sha256Hash;
}

function openStore(): TaskWorkspaceStore {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-personal-workflow-store-'),
  );
  roots.push(root);
  const store = new TaskWorkspaceStore(path.join(root, 'task-workspace.db'));
  stores.push(store);
  return store;
}

function source(label: string): JsonObject {
  return {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: 'child',
    nodes: [{ id: label, type: 'terminal', credential: 'remove-me' }],
    output_path: '/tmp/instance-only',
    metadata: {
      workflow_id: 'workflow:source',
      access_token: 'remove-me',
      reusable: true,
    },
  };
}

function compiled(label: string) {
  return {
    sourceHash: sha(label),
    compiledPlan: { plan_hash: sha(label), nodes: [{ id: label }] },
    compiledPlanHash: sha(label),
    compilerVersion: 'workflow-compiler/1',
    resourceClosureHash: sha('c'),
    policyCeilingHash: sha('p'),
    riskSummary: { effect_ceiling: 'read_only' },
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

describe('TaskWorkspaceStore Personal Workflow', () => {
  it('sanitizes instance data while preserving logical DAG identities', () => {
    expect(sanitizePersonalWorkflowSource(source('logical-node'))).toEqual({
      format: 'icarus.workflow-graph-scope/1',
      scope_key: 'child',
      nodes: [{ id: 'logical-node', type: 'terminal' }],
      metadata: { reusable: true },
    });
  });

  it('persists immutable revisions and recoverable publish/activate operations', () => {
    const store = openStore();
    const session = store.createSession({
      ownerPrincipalRef: 'human:local-owner',
      title: 'Personal Workflow source',
      nowMs: 1,
    });
    const draft = store.createPersonalWorkflowDraft({
      ownerPrincipalRef: 'human:local-owner',
      sourceSessionId: session.session_id,
      sourceWorkflowId: 'workflow:source',
      sourceRunId: 'run:source',
      source: source('v1'),
      ...compiled('a'),
      nowMs: 2,
    });
    const v1Id = String(draft.current_revision_id);
    expect(draft.source).toEqual(sanitizePersonalWorkflowSource(source('v1')));

    const revised = store.revisePersonalWorkflowDraft({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(draft.row_version),
      source: source('v2'),
      ...compiled('b'),
      nowMs: 3,
    });
    expect(revised.current_revision_id).not.toBe(v1Id);
    expect(store.getPersonalWorkflowRevision(v1Id).source).toEqual(
      sanitizePersonalWorkflowSource(source('v1')),
    );

    let current = store.advancePersonalWorkflowDraft({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(revised.row_version),
      status: 'validated',
      nowMs: 4,
    });
    current = store.advancePersonalWorkflowDraft({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(current.row_version),
      status: 'dry_run_passed',
      nowMs: 5,
    });
    current = store.advancePersonalWorkflowDraft({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(current.row_version),
      status: 'reviewed',
      review: { approved: true, display_name: 'Reusable task' },
      nowMs: 6,
    });
    current = store.beginPersonalWorkflowOperation({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(current.row_version),
      operation: 'publish',
      idempotencyKey: 'publish:v2',
      nowMs: 7,
    });
    expect(store.listPendingPersonalWorkflowOperations()).toEqual([current]);
    current = store.resolvePersonalWorkflowPublication({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(current.row_version),
      expectedOperationKey: 'publish:v2',
      releaseId: 'release:v2',
      releaseHash: sha('r'),
      nowMs: 8,
    });
    current = store.beginPersonalWorkflowOperation({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(current.row_version),
      operation: 'activate',
      idempotencyKey: 'activate:v2',
      nowMs: 9,
    });
    current = store.resolvePersonalWorkflowActivation({
      draftId: String(draft.draft_id),
      principalRef: 'human:local-owner',
      expectedRowVersion: Number(current.row_version),
      expectedOperationKey: 'activate:v2',
      pointerRowVersion: 1,
      nowMs: 10,
    });
    expect(current).toMatchObject({
      status: 'active',
      release_id: 'release:v2',
      release_hash: sha('r'),
      pointer_row_version: 1,
      pending_operation_key: null,
    });
  });
});
