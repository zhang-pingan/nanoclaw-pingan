import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import {
  CURRENT_TASK_WORKSPACE_SCHEMA_VERSION,
  TaskWorkspaceStore,
} from './store.js';

const roots: string[] = [];
const stores: TaskWorkspaceStore[] = [];

function databasePath(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'icarus-task-workspace-replan-'),
  );
  roots.push(root);
  return path.join(root, 'task-workspace.db');
}

function openStore(target = databasePath()): TaskWorkspaceStore {
  const store = new TaskWorkspaceStore(target);
  stores.push(store);
  return store;
}

function closeStore(store: TaskWorkspaceStore): void {
  store.close();
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
}

function sha(char: string): Sha256Hash {
  return `sha256:${char.repeat(64)}` as Sha256Hash;
}

function session(store: TaskWorkspaceStore): string {
  return store.createSession({
    ownerPrincipalRef: 'human:local-owner',
    title: 'Replan store test',
    nowMs: 1,
  }).session_id;
}

function createReplan(
  store: TaskWorkspaceStore,
  sessionId: string,
  overrides: Partial<{
    sourceFrontier: JsonObject;
    proposal: JsonObject;
    idempotencyKey: string;
  }> = {},
) {
  return store.createReplanRequest({
    sessionId,
    sourceWorkflowId: 'workflow:source',
    sourceActivationId: 'activation:source',
    sourceRunId: 'run:source',
    sourceFrontier: overrides.sourceFrontier ?? {
      active_nodes: ['node:active'],
      known_effects: [],
    },
    proposal: overrides.proposal ?? {
      old_plan_hash: sha('1'),
      new_plan_hash: sha('2'),
      diff: { added: ['node:new'] },
    },
    idempotencyKey: overrides.idempotencyKey ?? 'replan:create',
    nowMs: 2,
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('TaskWorkspaceStore Temporary Replan', () => {
  it('binds create idempotency to exact proposal and frontier hashes', () => {
    const target = databasePath();
    const store = openStore(target);
    const sessionId = session(store);
    const created = createReplan(store, sessionId);

    const fresh = new Database(target, { readonly: true });
    try {
      expect(fresh.pragma('user_version', { simple: true })).toBe(
        CURRENT_TASK_WORKSPACE_SCHEMA_VERSION,
      );
    } finally {
      fresh.close();
    }

    expect(createReplan(store, sessionId)).toEqual(created);
    expect(created).toMatchObject({
      source_workflow_id: 'workflow:source',
      source_activation_id: 'activation:source',
      source_run_id: 'run:source',
      status: 'awaiting_confirmation',
      confirmation_ref: null,
      target_activation_id: null,
      target_run_id: null,
      canonical_receipt: null,
    });
    expect(created.source_frontier_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(store.getSession(sessionId).attention_state).toBe('waiting_user');

    expect(() =>
      createReplan(store, sessionId, {
        proposal: { old_plan_hash: sha('1'), new_plan_hash: sha('3') },
      }),
    ).toThrow(/different proposal or source frontier/);
    expect(() =>
      createReplan(store, sessionId, {
        sourceFrontier: { active_nodes: ['node:different'] },
      }),
    ).toThrow(/different proposal or source frontier/);
  });

  it('durably replays applying progress and only applies after target lineage exists', () => {
    const target = databasePath();
    let store = openStore(target);
    const created = createReplan(store, session(store));
    const confirmationRef = 'message:confirmation';
    const confirmationHash = sha('4');
    const applying = store.beginReplanApplication({
      replanId: String(created.replan_id),
      expectedRowVersion: Number(created.row_version),
      expectedProposalHash: created.proposal_hash as Sha256Hash,
      confirmationRef,
      confirmationHash,
      nowMs: 3,
    });

    expect(
      store.beginReplanApplication({
        replanId: String(created.replan_id),
        expectedRowVersion: Number(created.row_version),
        expectedProposalHash: created.proposal_hash as Sha256Hash,
        confirmationRef,
        confirmationHash,
        nowMs: 4,
      }),
    ).toEqual(applying);
    expect(store.getSession(String(created.session_id)).attention_state).toBe(
      'none',
    );
    expect(() =>
      store.beginReplanApplication({
        replanId: String(created.replan_id),
        expectedRowVersion: Number(created.row_version),
        expectedProposalHash: created.proposal_hash as Sha256Hash,
        confirmationRef: 'message:different',
        confirmationHash,
      }),
    ).toThrow(/different confirmation/);

    closeStore(store);
    store = openStore(target);
    expect(store.listApplyingReplans()).toEqual([applying]);

    const fencedReceipt: JsonObject = {
      phase: 'source_fenced',
      fence_id: 'fence:source',
    };
    const fenced = store.updateReplanApplication({
      replanId: String(created.replan_id),
      expectedRowVersion: Number(applying.row_version),
      expectedProposalHash: created.proposal_hash as Sha256Hash,
      expectedConfirmationRef: confirmationRef,
      expectedConfirmationHash: confirmationHash,
      sourceFenceReceipt: fencedReceipt,
      canonicalReceipt: { phase: 'source_fenced' },
      nowMs: 5,
    });
    expect(fenced).toMatchObject({
      status: 'applying',
      source_fence_receipt: fencedReceipt,
      target_activation_id: null,
      target_run_id: null,
    });
    expect(
      store.updateReplanApplication({
        replanId: String(created.replan_id),
        expectedRowVersion: Number(applying.row_version),
        expectedProposalHash: created.proposal_hash as Sha256Hash,
        expectedConfirmationRef: confirmationRef,
        expectedConfirmationHash: confirmationHash,
        sourceFenceReceipt: fencedReceipt,
        canonicalReceipt: { phase: 'source_fenced' },
        nowMs: 6,
      }),
    ).toEqual(fenced);
    expect(() =>
      store.updateReplanApplication({
        replanId: String(created.replan_id),
        expectedRowVersion: Number(fenced.row_version),
        expectedProposalHash: created.proposal_hash as Sha256Hash,
        expectedConfirmationRef: confirmationRef,
        expectedConfirmationHash: confirmationHash,
        sourceFenceReceipt: {
          phase: 'source_fenced',
          fence_id: 'fence:different',
        },
        canonicalReceipt: { phase: 'source_fenced' },
      }),
    ).toThrow(/fence receipt cannot be replaced/);
    expect(() =>
      store.resolveReplanApplication({
        replanId: String(created.replan_id),
        expectedRowVersion: Number(fenced.row_version),
        expectedProposalHash: created.proposal_hash as Sha256Hash,
        expectedConfirmationRef: confirmationRef,
        expectedConfirmationHash: confirmationHash,
        status: 'applied',
        canonicalReceipt: { phase: 'complete' },
      }),
    ).toThrow(/target Activation and Run/);

    const targetCreated = store.updateReplanApplication({
      replanId: String(created.replan_id),
      expectedRowVersion: Number(fenced.row_version),
      expectedProposalHash: created.proposal_hash as Sha256Hash,
      expectedConfirmationRef: confirmationRef,
      expectedConfirmationHash: confirmationHash,
      targetActivationId: 'activation:target',
      targetRunId: 'run:target',
      canonicalReceipt: { phase: 'target_created' },
      nowMs: 7,
    });
    expect(() =>
      store.updateReplanApplication({
        replanId: String(created.replan_id),
        expectedRowVersion: Number(targetCreated.row_version),
        expectedProposalHash: created.proposal_hash as Sha256Hash,
        expectedConfirmationRef: confirmationRef,
        expectedConfirmationHash: confirmationHash,
        targetActivationId: 'activation:other',
        canonicalReceipt: { phase: 'target_created' },
      }),
    ).toThrow(/lineage cannot be replaced/);

    const receipt: JsonObject = {
      phase: 'complete',
      source_workflow_id: 'workflow:source',
      target_activation_id: 'activation:target',
      target_run_id: 'run:target',
    };
    const applied = store.resolveReplanApplication({
      replanId: String(created.replan_id),
      expectedRowVersion: Number(targetCreated.row_version),
      expectedProposalHash: created.proposal_hash as Sha256Hash,
      expectedConfirmationRef: confirmationRef,
      expectedConfirmationHash: confirmationHash,
      status: 'applied',
      canonicalReceipt: receipt,
      nowMs: 8,
    });
    expect(applied).toMatchObject({
      status: 'applied',
      target_activation_id: 'activation:target',
      target_run_id: 'run:target',
      canonical_receipt: receipt,
    });
    expect(store.listApplyingReplans()).toEqual([]);
    expect(store.getSession(String(created.session_id)).attention_state).toBe(
      'none',
    );
    expect(
      store.resolveReplanApplication({
        replanId: String(created.replan_id),
        expectedRowVersion: Number(targetCreated.row_version),
        expectedProposalHash: created.proposal_hash as Sha256Hash,
        expectedConfirmationRef: confirmationRef,
        expectedConfirmationHash: confirmationHash,
        status: 'applied',
        canonicalReceipt: receipt,
        nowMs: 9,
      }),
    ).toEqual(applied);
  });

  it('rebuilds Replan attention from the latest authority per source Workflow', () => {
    const store = openStore();
    const sessionId = session(store);
    const failedCandidate = createReplan(store, sessionId);
    expect(store.getSession(sessionId).attention_state).toBe('waiting_user');
    const applying = store.beginReplanApplication({
      replanId: String(failedCandidate.replan_id),
      expectedRowVersion: Number(failedCandidate.row_version),
      expectedProposalHash: failedCandidate.proposal_hash as Sha256Hash,
      confirmationRef: 'confirmation:failed',
      confirmationHash: sha('5'),
      nowMs: 3,
    });
    expect(store.getSession(sessionId).attention_state).toBe('none');
    store.resolveReplanApplication({
      replanId: String(failedCandidate.replan_id),
      expectedRowVersion: Number(applying.row_version),
      expectedProposalHash: failedCandidate.proposal_hash as Sha256Hash,
      expectedConfirmationRef: 'confirmation:failed',
      expectedConfirmationHash: sha('5'),
      status: 'failed',
      canonicalReceipt: { disposition: 'denied' },
      lastErrorCode: 'replan_denied',
      nowMs: 4,
    });
    expect(store.getSession(sessionId).attention_state).toBe('failed');

    const replacement = createReplan(store, sessionId, {
      proposal: { old_plan_hash: sha('1'), new_plan_hash: sha('6') },
      idempotencyKey: 'replan:replacement',
    });
    expect(store.getSession(sessionId).attention_state).toBe('waiting_user');
    store.cancelReplanRequest({
      replanId: String(replacement.replan_id),
      expectedRowVersion: Number(replacement.row_version),
      expectedProposalHash: replacement.proposal_hash as Sha256Hash,
      nowMs: 5,
    });
    expect(store.getSession(sessionId).attention_state).toBe('none');
  });

  it('migrates v1 replan rows in place without retaining replacement Workflow identity', () => {
    const target = databasePath();
    let store = openStore(target);
    const created = createReplan(store, session(store));
    closeStore(store);

    const legacy = new Database(target);
    legacy.pragma('foreign_keys = OFF');
    legacy.transaction(() => {
      legacy.exec(`
        ALTER TABLE task_workspace_replan_requests
          RENAME TO task_workspace_replan_requests_v2_source;
        CREATE TABLE task_workspace_replan_requests (
          replan_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES task_workspace_sessions(session_id),
          source_workflow_id TEXT NOT NULL,
          source_run_id TEXT NOT NULL,
          source_frontier_json TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          proposal_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('drafting','awaiting_confirmation','applying','applied','cancelled','failed')),
          replacement_workflow_id TEXT,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          row_version INTEGER NOT NULL
        );
        INSERT INTO task_workspace_replan_requests (
          replan_id, session_id, source_workflow_id, source_run_id,
          source_frontier_json, proposal_json, proposal_hash, status,
          replacement_workflow_id, idempotency_key, created_at_ms,
          updated_at_ms, row_version
        )
        SELECT replan_id, session_id, source_workflow_id, source_run_id,
               source_frontier_json, proposal_json, proposal_hash, 'applying',
               'workflow:obsolete-replacement', idempotency_key, created_at_ms,
               updated_at_ms, row_version
          FROM task_workspace_replan_requests_v2_source;
        DROP TABLE task_workspace_replan_requests_v2_source;
      `);
      legacy.pragma('user_version = 1');
    })();
    legacy.close();

    store = openStore(target);
    const migrated = store.getReplanRequest(String(created.replan_id));
    expect(migrated).toMatchObject({
      replan_id: created.replan_id,
      session_id: created.session_id,
      source_workflow_id: 'workflow:source',
      source_activation_id: null,
      source_run_id: 'run:source',
      source_frontier: created.source_frontier,
      source_frontier_hash: created.source_frontier_hash,
      proposal: created.proposal,
      proposal_hash: created.proposal_hash,
      status: 'applying',
      confirmation_ref: null,
      confirmation_hash: null,
      source_fence_receipt: null,
      target_activation_id: null,
      target_run_id: null,
      canonical_receipt: null,
      last_error_code: null,
      row_version: created.row_version,
    });
    expect(store.listApplyingReplans()).toEqual([migrated]);
    const inspected = new Database(target, { readonly: true });
    try {
      expect(inspected.pragma('user_version', { simple: true })).toBe(
        CURRENT_TASK_WORKSPACE_SCHEMA_VERSION,
      );
      const columns = inspected
        .prepare('PRAGMA table_info(task_workspace_replan_requests)')
        .all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain(
        'replacement_workflow_id',
      );
    } finally {
      inspected.close();
    }
  });
});
