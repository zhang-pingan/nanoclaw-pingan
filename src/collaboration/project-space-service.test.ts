import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionExecutorRegistry } from './executors/registry.js';
import {
  RunOnceActionExecutor,
  type RunOnceService,
} from './executors/run-once.js';

import type { CollaborationEventSigningIdentity } from './project-space-identity.js';
import { CollaborationProjectSpaceIdentityService } from './project-space-identity.js';
import {
  CollaborationProjectSpaceService,
  type CollaborationLocalGroupCleanup,
  type CollaborationProjectSpaceTransport,
  type ValidatedProjectSpaceHistory,
} from './project-space-service.js';
import {
  CollaborationProjectSpaceStore,
  type CollaborationProjectSpaceGroupRecord,
} from './project-space-store.js';
import { CollaborationScheduler } from './scheduler.js';
import type { CollaborationRuntime } from './runtime.js';
import { CollaborationWebApi } from './web-api.js';
import {
  buildCollaborationEventV3,
  collaborationCanonicalHashV3,
  collaborationDeadlineSnapshotHashV3,
  reduceCollaborationEventV3,
} from './protocol/v3-reducer.js';
import { collaborationCredentialFingerprintV3 } from './protocol/v3-schema.js';

const temporaryDirectories: string[] = [];
const ALICE: CollaborationEventSigningIdentity = {
  principalId: 'principal_00000000-0000-4000-8000-000000000001',
  clientId: 'client_alice_mac',
  credentialId: 'credential_alice_mac',
  privateKeyPath: '/tmp/alice',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice',
  fingerprint: collaborationCredentialFingerprintV3(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice',
  ),
  purpose: 'event_signing',
};
const BOB: CollaborationEventSigningIdentity = {
  principalId: 'principal_00000000-0000-4000-8000-000000000002',
  clientId: 'client_bob_mac',
  credentialId: 'credential_bob_mac',
  privateKeyPath: '/tmp/bob',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview',
  fingerprint: collaborationCredentialFingerprintV3(
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview',
  ),
  purpose: 'event_signing',
};

const DELIVERY_MACHINE = {
  format: 'icarus.collaboration-machine/3' as const,
  initial_state: 'implementation',
  states: {
    implementation: {
      label: 'Implementation',
      description: 'Implement the accepted scope.',
      assignee: {
        type: 'participant_slot' as const,
        slot: 'implementer',
      },
      terminal: false,
      timeout_policy: {
        start_timeout_ms: 60_000,
        execution_timeout_ms: 120_000,
        reminder_interval_ms: 30_000,
        on_timeout: 'notify_only' as const,
      },
      transitions: [
        { outcome: 'complete', label: 'Complete', target_state: 'completed' },
        { outcome: 'cancel', label: 'Cancel', target_state: 'cancelled' },
      ],
    },
    completed: {
      label: 'Completed',
      description: '',
      terminal: true,
      transitions: [],
    },
    cancelled: {
      label: 'Cancelled',
      description: '',
      terminal: true,
      transitions: [],
    },
  },
};

const DELIVERY_LAYOUT = {
  format: 'icarus.collaboration-workflow-layout/1' as const,
  view: 'participants' as const,
  nodes: {
    implementation: { x: 80, y: 120 },
    completed: { x: 420, y: 60 },
    cancelled: { x: 420, y: 220 },
  },
  revision: 1,
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'icarus-v3-service-'));
  temporaryDirectories.push(directory);
  return directory;
}

class MemoryTransport implements CollaborationProjectSpaceTransport {
  readonly histories = new Map<string, ValidatedProjectSpaceHistory>();
  readonly files = new Map<string, Buffer>();
  appendCount = 0;
  reinitializeCount = 0;
  rejectReinitialize = false;
  failRefreshAfterReinitialize = false;
  failNextAppend: Error | null = null;
  readonly refreshAfterReinitializeErrors = new Map<string, Error>();

  async inspect(input: {
    remoteUrl: string;
  }): Promise<ValidatedProjectSpaceHistory> {
    const history = this.histories.get(input.remoteUrl);
    if (!history) throw new Error('Remote does not exist');
    return history;
  }

  async create(input: {
    remoteUrl: string;
    genesisEvent: ValidatedProjectSpaceHistory['eventRecords'][number]['event'];
    genesisProjection: ValidatedProjectSpaceHistory['projection'];
  }): Promise<ValidatedProjectSpaceHistory> {
    if (this.histories.has(input.remoteUrl))
      throw new Error('Remote already exists');
    const head = '1'.repeat(40);
    const history: ValidatedProjectSpaceHistory = {
      head,
      projection: input.genesisProjection,
      eventRecords: [
        { event: input.genesisEvent, commitHash: head, commitOrder: 1 },
      ],
    };
    this.histories.set(input.remoteUrl, history);
    return history;
  }

  async reinitialize(input: {
    remoteUrl: string;
    genesisEvent: ValidatedProjectSpaceHistory['eventRecords'][number]['event'];
    genesisProjection: ValidatedProjectSpaceHistory['projection'];
  }): Promise<ValidatedProjectSpaceHistory> {
    this.reinitializeCount += 1;
    if (this.rejectReinitialize)
      throw new Error('simulated Git server force-push rejection');
    const head = `${this.histories.size + 10}`.padStart(40, '0');
    const history: ValidatedProjectSpaceHistory = {
      head,
      projection: input.genesisProjection,
      eventRecords: [
        { event: input.genesisEvent, commitHash: head, commitOrder: 1 },
      ],
    };
    this.histories.set(input.remoteUrl, history);
    return history;
  }

  async refreshAfterReinitialize(input: {
    remoteUrl: string;
  }): Promise<ValidatedProjectSpaceHistory> {
    const remoteError = this.refreshAfterReinitializeErrors.get(
      input.remoteUrl,
    );
    if (remoteError) throw remoteError;
    if (this.failRefreshAfterReinitialize) {
      this.failRefreshAfterReinitialize = false;
      throw new Error('simulated interruption after force push');
    }
    return this.inspect(input);
  }

  async append(input: {
    remoteUrl: string;
    buildEvent: (history: ValidatedProjectSpaceHistory) =>
      | ValidatedProjectSpaceHistory['eventRecords'][number]['event']
      | {
          event: ValidatedProjectSpaceHistory['eventRecords'][number]['event'];
          materializedFiles: readonly {
            path: string;
            contents: string | Buffer | null;
          }[];
        };
  }): Promise<ValidatedProjectSpaceHistory> {
    if (this.failNextAppend) {
      const error = this.failNextAppend;
      this.failNextAppend = null;
      throw error;
    }
    const current = await this.inspect({ remoteUrl: input.remoteUrl });
    const built = input.buildEvent(current);
    const nextEvent = 'event' in built ? built.event : built;
    if ('event' in built)
      for (const file of built.materializedFiles) {
        if (file.contents === null) this.files.delete(file.path);
        else
          this.files.set(
            file.path,
            Buffer.isBuffer(file.contents)
              ? Buffer.from(file.contents)
              : Buffer.from(file.contents, 'utf8'),
          );
      }
    const order = current.eventRecords.length + 1;
    const head = order.toString(16).padStart(40, '0');
    const history: ValidatedProjectSpaceHistory = {
      head,
      projection: reduceCollaborationEventV3(current.projection, nextEvent),
      eventRecords: [
        ...current.eventRecords,
        { event: nextEvent, commitHash: head, commitOrder: order },
      ],
    };
    this.appendCount += 1;
    this.histories.set(input.remoteUrl, history);
    return history;
  }

  async readVerifiedFile(input: { repositoryFile: string }): Promise<Buffer> {
    const contents = this.files.get(input.repositoryFile);
    if (!contents) throw new Error('Verified file does not exist');
    return Buffer.from(contents);
  }
}

class GatedReinitializeMemoryTransport extends MemoryTransport {
  private reinitializeGate:
    | {
        readonly started: () => void;
        readonly wait: Promise<void>;
      }
    | undefined;

  pauseNextReinitialize(): {
    readonly started: Promise<void>;
    readonly release: () => void;
  } {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.reinitializeGate = { started: markStarted, wait };
    return { started, release };
  }

  override async reinitialize(
    input: Parameters<MemoryTransport['reinitialize']>[0],
  ): Promise<ValidatedProjectSpaceHistory> {
    const gate = this.reinitializeGate;
    if (gate) {
      this.reinitializeGate = undefined;
      gate.started();
      await gate.wait;
    }
    return super.reinitialize(input);
  }
}

class OverlapDetectingMemoryTransport extends MemoryTransport {
  private activeInspections = 0;
  maxConcurrentInspections = 0;

  override async inspect(input: {
    remoteUrl: string;
  }): Promise<ValidatedProjectSpaceHistory> {
    this.activeInspections += 1;
    this.maxConcurrentInspections = Math.max(
      this.maxConcurrentInspections,
      this.activeInspections,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return await super.inspect(input);
    } finally {
      this.activeInspections -= 1;
    }
  }
}

function service(
  root: string,
  transport: MemoryTransport,
  identity: CollaborationEventSigningIdentity,
  now: () => number = () => Date.parse('2026-08-06T12:00:00.000Z'),
  options?: {
    cleanupLocalPaths?: CollaborationLocalGroupCleanup;
    createCredentialIdentity?: (input: {
      principalId: string;
      purpose?: 'event_signing' | 'group_recovery';
      clientId?: string;
      credentialId?: string;
    }) => Promise<CollaborationEventSigningIdentity>;
    loadCredentialIdentity?: (
      credentialId: string,
    ) => Promise<CollaborationEventSigningIdentity>;
    deleteCredentialIdentity?: (credentialId: string) => Promise<boolean>;
  },
) {
  const store = new CollaborationProjectSpaceStore(path.join(root, 'store.db'));
  const identities = {
    createPrincipalIdentity: async (input?: {
      freshClient?: boolean;
      principalId?: string;
      clientId?: string;
      credentialId?: string;
    }) =>
      input?.freshClient
        ? {
            ...identity,
            principalId:
              input.principalId ??
              'principal_00000000-0000-4000-8000-000000000100',
            clientId: input.clientId ?? `${identity.clientId}_initialized`,
            credentialId:
              input.credentialId ?? `${identity.credentialId}_initialized`,
          }
        : identity,
    createCredentialIdentity:
      options?.createCredentialIdentity ??
      (async (input: {
        principalId: string;
        clientId?: string;
        purpose?: string;
        credentialId?: string;
      }) => ({
        ...identity,
        principalId: input.principalId,
        clientId: input.clientId ?? identity.clientId,
        credentialId:
          input.credentialId ??
          (input.purpose === 'group_recovery'
            ? input.principalId === identity.principalId
              ? `${identity.credentialId}_recovery`
              : `credential_${input.principalId}_recovery`
            : identity.credentialId),
        purpose:
          input.purpose === 'group_recovery'
            ? ('group_recovery' as const)
            : ('event_signing' as const),
      })),
    loadCredentialIdentity:
      options?.loadCredentialIdentity ??
      (async (credentialId: string) => {
        if (credentialId === identity.credentialId) return identity;
        if (credentialId === `${identity.credentialId}_recovery`)
          return {
            ...identity,
            credentialId,
            purpose: 'group_recovery' as const,
          };
        throw new Error(`Credential not found: ${credentialId}`);
      }),
    resolveGitSshKeyPath: (value?: string) => value || '/tmp/git-transport',
    resolveGitSshKeyCandidates: (value?: string) => [
      value || '/tmp/git-transport',
    ],
    deleteCredentialIdentity:
      options?.deleteCredentialIdentity ?? (async () => true),
  } as unknown as CollaborationProjectSpaceIdentityService;
  return {
    store,
    service: new CollaborationProjectSpaceService(
      store,
      transport,
      path.join(root, 'repos'),
      identities,
      now,
      options?.cleanupLocalPaths,
    ),
  };
}

function registerOwnerSnapshot(
  target: ReturnType<typeof service>,
  group: CollaborationProjectSpaceGroupRecord,
  history: ValidatedProjectSpaceHistory,
  identity: CollaborationEventSigningIdentity,
): void {
  target.store.registerGroup({
    subscription: {
      format: 'icarus.collaboration-subscription/1',
      group_id: group.groupId,
      remote_url: group.remoteUrl,
      subscription_mode: 'member',
      poll_interval_ms: group.pollIntervalMs,
      last_verified_head: history.head,
      notifications_enabled: true,
      created_at: '2026-08-06T12:00:00.000Z',
    },
    name: group.name,
    lifecycle: group.lifecycle,
    ownerPrincipalId: group.ownerPrincipalId,
    repositoryPath: group.repositoryPath,
    gitSshKeyPath: group.gitSshKeyPath,
    localPrincipalId: identity.principalId,
    localClientId: identity.clientId,
    localCredentialId: identity.credentialId,
    eventPrivateKeyPath: identity.privateKeyPath,
    eventPublicKey: identity.publicKey,
    eventFingerprint: identity.fingerprint,
  });
  target.store.saveVerifiedProjection({
    groupId: group.groupId,
    verifiedHead: history.head,
    projection: history.projection,
    eventRecords: history.eventRecords,
  });
}

async function initializeThenLoseAfterLocalReplacement(
  observerAccess: 'allowed' | 'members_only',
) {
  const transport = new GatedReinitializeMemoryTransport();
  let failFirstCleanup = true;
  const firstOwner = service(tempDirectory(), transport, ALICE, undefined, {
    deleteCredentialIdentity: async () => {
      if (failFirstCleanup) {
        failFirstCleanup = false;
        throw new Error('simulated Credential cleanup interruption');
      }
      return true;
    },
  });
  const old = await firstOwner.service.createGroup({
    remoteUrl: `/tmp/local-replaced-${observerAccess}.git`,
    name: `Local replaced ${observerAccess}`,
    displayName: 'Alice',
    clientDisplayName: 'Alice MacBook',
    membershipPolicy: 'approval',
    observerAccess,
    groupId: `group_local_replaced_${observerAccess}`,
  });
  const original = await transport.inspect({ remoteUrl: old.remoteUrl });
  const secondOwner = service(tempDirectory(), transport, ALICE);
  registerOwnerSnapshot(secondOwner, old, original, ALICE);

  const gate = transport.pauseNextReinitialize();
  const winningInitialization = secondOwner.service.initializeGroup(
    old.groupId,
  );
  await gate.started;
  await expect(firstOwner.service.initializeGroup(old.groupId)).rejects.toThrow(
    /local replacement is pending/u,
  );
  const pending = firstOwner.store.listGroupInitializations()[0]!;
  expect(pending.phase).toBe('local_replaced');
  expect(firstOwner.store.getGroup(pending.newGroupId)).not.toBeNull();
  expect(
    firstOwner.store.getLocalGroupBinding(pending.newGroupId),
  ).toMatchObject({ bindingState: 'attached' });
  expect(
    firstOwner.service.getCachedHistory(pending.newGroupId),
  ).not.toBeNull();

  gate.release();
  const winner = await winningInitialization;
  expect(winner.groupId).not.toBe(old.groupId);
  expect(winner.groupId).not.toBe(pending.newGroupId);
  return { firstOwner, secondOwner, old, pending, winner };
}

async function withServiceApi(
  selected: ReturnType<typeof service>,
  work: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const runtime = {
    status: () => ({
      available: true,
      protocolVersion: 3,
      error: null,
      scheduler: null,
    }),
    databasePath: selected.store.databasePath,
    store: selected.store,
    groups: selected.service,
  } as unknown as CollaborationRuntime;
  const api = new CollaborationWebApi(runtime);
  const server = http.createServer((request, response) => {
    void api.handle(
      request,
      response,
      new URL(request.url ?? '/', 'http://localhost'),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  try {
    await work(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function recoverClient(input: {
  owner: ReturnType<typeof service>;
  recovering: ReturnType<typeof service>;
  remoteUrl: string;
  groupId: string;
  principalId: string;
  clientDisplayName: string;
}) {
  await input.recovering.service.observeGroup({
    remoteUrl: input.remoteUrl,
    gitSshKeyPath: '/tmp/git-transport',
  });
  const requested = await input.recovering.service.requestIdentityRecovery({
    groupId: input.groupId,
    targetPrincipalId: input.principalId,
    type: 'identity_recovery',
    clientDisplayName: input.clientDisplayName,
  });
  const ownerHistory = await input.owner.service.sync(input.groupId);
  const revision =
    ownerHistory.projection.aggregateHeads[`recovery:${requested.requestId}`]
      ?.revision ?? 0;
  await input.owner.service.decideRecovery({
    groupId: input.groupId,
    requestId: requested.requestId,
    expectedRevision: revision,
    decision: 'approve',
    reason: 'Verification code matched on the existing device',
  });
  return input.recovering.service.sync(input.groupId);
}

describe('Collaboration project space v3 Group and identity service', () => {
  it('issues and consumes a one-time Invite before membership approval', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/invite-project.git',
      name: 'Invite project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'invite_only',
      observerAccess: 'allowed',
      groupId: 'group_invite',
    });
    await owner.service.issueInvite({
      groupId: 'group_invite',
      inviteId: 'invite_bob',
      expiresAt: '2026-08-07T12:00:00.000Z',
      expectedRevision: 0,
    });

    const bob = service(tempDirectory(), transport, BOB);
    await expect(
      bob.service.joinGroup({
        remoteUrl: '/tmp/invite-project.git',
        gitSshKeyPath: BOB.privateKeyPath,
        displayName: 'Bob',
        clientDisplayName: 'Bob MacBook',
      }),
    ).rejects.toThrow(/Invite/iu);
    const requested = await bob.service.joinGroup({
      remoteUrl: '/tmp/invite-project.git',
      gitSshKeyPath: BOB.privateKeyPath,
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
      inviteId: 'invite_bob',
    });
    expect(requested.projection?.members[BOB.principalId]?.status).toBe(
      'requested',
    );
    expect(
      requested.projection?.clients[BOB.principalId]?.[BOB.clientId],
    ).toMatchObject({
      status: 'active',
      display_name: 'Bob MacBook',
    });
    await expect(
      bob.service.postProgress({
        groupId: 'group_invite',
        expectedRevision: 0,
        summary: 'Must remain blocked before approval.',
      }),
    ).rejects.toThrow(/Observer subscriptions|active Group member|not active/u);
    expect(requested.projection?.invites.invite_bob).toMatchObject({
      status: 'used',
      used_at_event: expect.stringMatching(/^evt_/u),
    });

    const approved = await owner.service.approveMembership(
      'group_invite',
      BOB.principalId,
      1,
    );
    expect(approved.projection?.members[BOB.principalId]?.status).toBe(
      'active',
    );
    await bob.service.sync('group_invite');
    const firstWrite = await bob.service.postProgress({
      groupId: 'group_invite',
      expectedRevision: 0,
      summary: 'First write after invite approval.',
    });
    expect(
      Object.values(firstWrite.projection?.progressUpdates ?? {}).at(-1),
    ).toMatchObject({
      principal_id: BOB.principalId,
      summary: 'First write after invite approval.',
    });
    owner.store.close();
    bob.store.close();
  });

  it('registers a pending approval Client and enables its first write after sync', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/approval-project.git',
      name: 'Approval project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'approval',
      observerAccess: 'allowed',
      groupId: 'group_approval',
    });
    const bob = service(tempDirectory(), transport, BOB);
    const requested = await bob.service.joinGroup({
      remoteUrl: '/tmp/approval-project.git',
      gitSshKeyPath: BOB.privateKeyPath,
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    expect(requested.projection?.members[BOB.principalId]?.status).toBe(
      'requested',
    );
    expect(
      requested.projection?.clients[BOB.principalId]?.[BOB.clientId],
    ).toMatchObject({ status: 'active', display_name: 'Bob MacBook' });
    await expect(
      bob.service.createWorkItem({
        groupId: 'group_approval',
        workItemId: 'pending_write',
        type: 'task',
        title: 'Must not be created before approval',
      }),
    ).rejects.toThrow(/Observer subscriptions|active Group member|not active/u);

    await owner.service.approveMembership('group_approval', BOB.principalId, 1);
    const synced = await bob.service.sync('group_approval');
    expect(synced.projection.members[BOB.principalId]?.status).toBe('active');
    const firstWrite = await bob.service.postProgress({
      groupId: 'group_approval',
      expectedRevision: 0,
      summary: 'Posted immediately after approval',
    });
    expect(
      Object.values(firstWrite.projection?.progressUpdates ?? {}).at(-1),
    ).toMatchObject({
      principal_id: BOB.principalId,
      summary: 'Posted immediately after approval',
    });
    owner.store.close();
    bob.store.close();
  });

  it('creates an immediately active Group without Roles, Claims, or Workflow', async () => {
    const transport = new MemoryTransport();
    const local = service(tempDirectory(), transport, ALICE);
    const group = await local.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    expect(group).toMatchObject({
      lifecycle: 'active',
      subscriptionMode: 'member',
      localPrincipalId: ALICE.principalId,
      localClientId: ALICE.clientId,
    });
    expect(group.projection?.workflowDefinitions).toEqual({});
    expect(group.projection?.workflowInstances).toEqual({});
    expect(JSON.stringify(group.projection)).not.toMatch(
      /roleClaims|owner_role/u,
    );
    local.store.close();
  });

  it('initializes an Owner Group as a new identity and removes every old local row', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    const old = await owner.service.createGroup({
      remoteUrl: '/tmp/initialize.git',
      name: 'Initialize project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'invite_only',
      observerAccess: 'members_only',
      groupId: 'group_initialize_old',
    });
    await owner.service.issueInvite({
      groupId: old.groupId,
      inviteId: 'invite_old',
      expectedRevision: 0,
    });
    await owner.service.createWorkItem({
      groupId: old.groupId,
      workItemId: 'work_old',
      type: 'task',
      title: 'Old work',
    });
    await owner.service.createDiscussion({
      groupId: old.groupId,
      threadId: 'thread_old',
      title: 'Old discussion',
      scope: { type: 'group' },
    });
    await owner.service.proposeWorkflowDefinition({
      groupId: old.groupId,
      definitionId: 'old_delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Old delivery',
      launchPolicy: {
        group_admin: true,
        work_item_owner: false,
        principals: [],
      },
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    owner.store.addLocalAuditEvidence({
      groupId: old.groupId,
      evidenceType: 'old-evidence',
      resourceType: 'group',
      resourceId: old.groupId,
      evidence: { old: true },
    });

    const initialized = await owner.service.initializeGroup(old.groupId);

    expect(initialized).toMatchObject({
      remoteUrl: old.remoteUrl,
      repositoryPath: old.repositoryPath,
      gitSshKeyPath: old.gitSshKeyPath,
      subscriptionMode: 'member',
      name: old.name,
    });
    expect(initialized.groupId).not.toBe(old.groupId);
    expect(initialized.localPrincipalId).not.toBe(old.localPrincipalId);
    expect(initialized.localClientId).not.toBe(old.localClientId);
    expect(initialized.localCredentialId).not.toBe(old.localCredentialId);
    expect(initialized.projection?.group).toMatchObject({
      control_branch: 'refs/heads/icarus/control',
      membership_policy: { join: 'invite_only' },
      visibility_policy: { observer_access: 'members_only' },
    });
    expect(initialized.projection).toMatchObject({
      invites: {},
      recoveryRequests: {},
      executors: {},
      progressUpdates: {},
      files: {},
      artifacts: {},
      actions: {},
      workItems: {},
      discussions: {},
      workflowDefinitions: {},
      workflowInstances: {},
      turns: {},
      activity: [expect.objectContaining({ eventType: 'group_initialized' })],
    });
    expect(owner.store.listEventRecords(initialized.groupId)).toHaveLength(1);
    expect(owner.store.getGroup(old.groupId)).toBeNull();
    expect(owner.store.listGroupInitializations()).toEqual([]);
    const database = owner.store.rawDatabaseForTests();
    const groupTables = (
      database
        .prepare(
          `SELECT DISTINCT m.name
             FROM sqlite_master m, pragma_table_info(m.name) p
            WHERE m.type = 'table' AND p.name = 'group_id'`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const table of groupTables)
      expect(
        (
          database
            .prepare(
              `SELECT count(*) AS count FROM ${table} WHERE group_id = ?`,
            )
            .get(old.groupId) as { count: number }
        ).count,
        table,
      ).toBe(0);
    owner.store.close();
  });

  it('rejects Member and Observer attempts to initialize through the Service boundary', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-auth.git',
      name: 'Initialize auth',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_auth',
    });
    const member = service(tempDirectory(), transport, BOB);
    await member.service.joinGroup({
      remoteUrl: '/tmp/initialize-auth.git',
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    const observer = service(tempDirectory(), transport, BOB);
    await observer.service.observeGroup({
      remoteUrl: '/tmp/initialize-auth.git',
    });

    await expect(
      member.service.initializeGroup('group_initialize_auth'),
    ).rejects.toThrow(/Only the current Group Owner/u);
    await expect(
      observer.service.initializeGroup('group_initialize_auth'),
    ).rejects.toThrow(/Only the current Group Owner/u);
    expect(
      transport.histories.get('/tmp/initialize-auth.git')?.projection.groupId,
    ).toBe('group_initialize_auth');
    owner.store.close();
    member.store.close();
    observer.store.close();
  });

  it('allows the current active Owner identity to initialize an archived Group', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    const old = await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-archived.git',
      name: 'Initialize archived',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_archived',
    });
    const archived = await owner.service.archiveGroup(
      old.groupId,
      'Archive before rebuilding',
      1,
    );
    expect(archived.lifecycle).toBe('archived');

    const initialized = await owner.service.initializeGroup(old.groupId);

    expect(initialized.groupId).not.toBe(old.groupId);
    expect(initialized.lifecycle).toBe('active');
    expect(owner.store.getGroup(old.groupId)).toBeNull();
    expect(transport.reinitializeCount).toBe(1);
    owner.store.close();
  });

  it('syncs authorization and rejects an Owner device revoked by remote recovery without force push', async () => {
    const transport = new MemoryTransport();
    const staleOwner = service(tempDirectory(), transport, ALICE);
    const old = await staleOwner.service.createGroup({
      remoteUrl: '/tmp/initialize-stale-owner.git',
      name: 'Stale Owner authorization',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_stale_owner',
    });
    const original = await transport.inspect({ remoteUrl: old.remoteUrl });
    const approvingOwner = service(tempDirectory(), transport, ALICE);
    registerOwnerSnapshot(approvingOwner, old, original, ALICE);
    const recoveredIdentity = {
      ...ALICE,
      clientId: 'client_alice_recovered',
      credentialId: 'credential_alice_recovered',
    };
    const recovering = service(tempDirectory(), transport, recoveredIdentity);
    await recovering.service.observeGroup({ remoteUrl: old.remoteUrl });
    const request = await recovering.service.requestIdentityRecovery({
      groupId: old.groupId,
      targetPrincipalId: ALICE.principalId,
      type: 'owner_recovery',
      clientDisplayName: 'Alice recovered device',
      reason: 'The previous Owner device must no longer write',
    });
    const pending = await approvingOwner.service.sync(old.groupId);
    const revision =
      pending.projection.aggregateHeads[`recovery:${request.requestId}`]!
        .revision;
    await approvingOwner.service.decideRecovery({
      groupId: old.groupId,
      requestId: request.requestId,
      expectedRevision: revision,
      decision: 'approve',
      reason: 'Verified recovered Owner identity',
    });
    expect(
      transport.histories.get(old.remoteUrl)?.projection.credentials[
        ALICE.principalId
      ]?.[ALICE.credentialId],
    ).toMatchObject({ status: 'revoked' });

    const forcePushesBefore = transport.reinitializeCount;
    await expect(
      staleOwner.service.initializeGroup(old.groupId),
    ).rejects.toThrow(/Only the current Group Owner/u);
    expect(transport.reinitializeCount).toBe(forcePushesBefore);
    expect(
      staleOwner.store.getGroup(old.groupId)?.projection?.credentials[
        ALICE.principalId
      ]?.[ALICE.credentialId],
    ).toMatchObject({ status: 'revoked' });
    staleOwner.store.close();
    approvingOwner.store.close();
    recovering.store.close();
  });

  it('keeps the old local Group on force-push rejection and recovers a pushed rewrite', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    const old = await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-recovery.git',
      name: 'Initialize recovery',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'approval',
      observerAccess: 'allowed',
      groupId: 'group_initialize_recovery',
    });
    transport.rejectReinitialize = true;
    await expect(owner.service.initializeGroup(old.groupId)).rejects.toThrow(
      /force-push rejection/u,
    );
    expect(owner.store.getGroup(old.groupId)?.lastVerifiedHead).toBe(
      old.lastVerifiedHead,
    );
    expect(owner.store.listGroupInitializations()).toEqual([]);

    transport.rejectReinitialize = false;
    transport.failRefreshAfterReinitialize = true;
    await expect(owner.service.initializeGroup(old.groupId)).rejects.toThrow(
      /local replacement is pending/u,
    );
    expect(owner.store.getGroup(old.groupId)).not.toBeNull();
    expect(owner.store.listGroupInitializations()).toHaveLength(1);
    const [recovered] = await owner.service.recoverInterruptedInitializations();
    expect(recovered?.groupId).not.toBe(old.groupId);
    expect(owner.store.getGroup(old.groupId)).toBeNull();
    expect(owner.store.listGroupInitializations()).toEqual([]);
    owner.store.close();
  });

  it('cleans the reserved event Credential when recovery Credential creation fails', async () => {
    const deletedCredentialIds: string[] = [];
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE, undefined, {
      createCredentialIdentity: async (input) => {
        if (input.principalId !== ALICE.principalId)
          throw new Error('recovery Credential creation failed');
        return {
          ...ALICE,
          credentialId: `${ALICE.credentialId}_recovery`,
          purpose: 'group_recovery',
        };
      },
      deleteCredentialIdentity: async (credentialId) => {
        deletedCredentialIds.push(credentialId);
        return true;
      },
    });
    const old = await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-recovery-identity-failure.git',
      name: 'Recovery identity failure',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_recovery_identity_failure',
    });

    await expect(owner.service.initializeGroup(old.groupId)).rejects.toThrow(
      /recovery Credential creation failed/u,
    );

    expect(owner.store.getGroup(old.groupId)).not.toBeNull();
    expect(owner.store.listGroupInitializations()).toEqual([]);
    expect(deletedCredentialIds).toHaveLength(2);
    expect(
      deletedCredentialIds.every((credentialId) =>
        /^credential_[0-9a-f-]{36}$/u.test(credentialId),
      ),
    ).toBe(true);
    expect(transport.reinitializeCount).toBe(0);
    owner.store.close();
  });

  it('cleans both generated Credentials when initialization materialization fails', async () => {
    const deletedCredentialIds: string[] = [];
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE, undefined, {
      deleteCredentialIdentity: async (credentialId) => {
        deletedCredentialIds.push(credentialId);
        return true;
      },
    });
    const old = await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-begin-failure.git',
      name: 'Begin initialization failure',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_begin_failure',
    });
    vi.spyOn(owner.store, 'beginGroupInitialization').mockImplementationOnce(
      () => {
        throw new Error('begin initialization failed');
      },
    );

    await expect(owner.service.initializeGroup(old.groupId)).rejects.toThrow(
      /begin initialization failed/u,
    );

    expect(owner.store.getGroup(old.groupId)).not.toBeNull();
    expect(owner.store.listGroupInitializations()).toEqual([]);
    expect(deletedCredentialIds).toHaveLength(2);
    expect(transport.reinitializeCount).toBe(0);
    owner.store.close();
  });

  it('retains cleanup responsibility when generated Credential deletion fails', async () => {
    let rejectDeletion = true;
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE, undefined, {
      deleteCredentialIdentity: async () => {
        if (rejectDeletion) throw new Error('Credential directory is busy');
        return true;
      },
    });
    const old = await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-cleanup-retry.git',
      name: 'Initialization cleanup retry',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_cleanup_retry',
    });
    vi.spyOn(owner.store, 'beginGroupInitialization').mockImplementationOnce(
      () => {
        throw new Error('begin initialization failed');
      },
    );

    await expect(owner.service.initializeGroup(old.groupId)).rejects.toThrow(
      /generated Credential cleanup remains pending/u,
    );
    expect(owner.store.listGroupInitializations()).toEqual([
      expect.objectContaining({
        oldGroupId: old.groupId,
        phase: 'prepared',
      }),
    ]);
    expect(owner.store.getGroup(old.groupId)).not.toBeNull();
    expect(transport.reinitializeCount).toBe(0);

    rejectDeletion = false;
    await expect(
      owner.service.recoverInterruptedInitializations(),
    ).resolves.toEqual([]);
    expect(owner.store.listGroupInitializations()).toEqual([]);
    expect(owner.store.getGroup(old.groupId)).not.toBeNull();
    owner.store.close();
  });

  it('recovers as an Observer when another Owner force push wins later', async () => {
    const transport = new MemoryTransport();
    const firstOwner = service(tempDirectory(), transport, ALICE);
    const old = await firstOwner.service.createGroup({
      remoteUrl: '/tmp/initialize-concurrent.git',
      name: 'Concurrent initialization',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_concurrent',
    });
    const secondOwner = service(tempDirectory(), transport, ALICE);
    await secondOwner.service.observeGroup({ remoteUrl: old.remoteUrl });
    secondOwner.store.updateLocalIdentity({
      groupId: old.groupId,
      subscriptionMode: 'member',
      localPrincipalId: ALICE.principalId,
      localClientId: ALICE.clientId,
      localCredentialId: ALICE.credentialId,
      eventPrivateKeyPath: ALICE.privateKeyPath,
      eventPublicKey: ALICE.publicKey,
      eventFingerprint: ALICE.fingerprint,
    });

    transport.failRefreshAfterReinitialize = true;
    const [firstResult, secondResult] = await Promise.allSettled([
      firstOwner.service.initializeGroup(old.groupId),
      secondOwner.service.initializeGroup(old.groupId),
    ]);
    if (firstResult.status !== 'rejected')
      throw new Error('The first initialization unexpectedly completed');
    expect(firstResult.reason).toBeInstanceOf(Error);
    expect((firstResult.reason as Error).message).toMatch(
      /local replacement is pending/u,
    );
    if (secondResult.status !== 'fulfilled') throw secondResult.reason;
    const [pending] = firstOwner.store.listGroupInitializations();
    expect(pending?.phase).toBe('pushed');

    const winner = secondResult.value;
    expect(winner.groupId).not.toBe(old.groupId);
    expect(winner.groupId).not.toBe(pending?.newGroupId);

    const [recovered] =
      await firstOwner.service.recoverInterruptedInitializations();
    expect(recovered).toMatchObject({
      groupId: winner.groupId,
      remoteUrl: old.remoteUrl,
      subscriptionMode: 'observer',
      localPrincipalId: null,
      localClientId: null,
      localCredentialId: null,
      recoveryCredentialId: null,
    });
    expect(firstOwner.store.getGroup(old.groupId)).toBeNull();
    expect(firstOwner.store.getGroup(pending!.newGroupId)).toBeNull();
    expect(firstOwner.store.listGroupInitializations()).toEqual([]);
    firstOwner.store.close();
    secondOwner.store.close();
  });

  it('does not subscribe the losing initializer to a members-only winner', async () => {
    const transport = new MemoryTransport();
    const firstOwner = service(tempDirectory(), transport, ALICE);
    const old = await firstOwner.service.createGroup({
      remoteUrl: '/tmp/initialize-concurrent-private.git',
      name: 'Concurrent private initialization',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'approval',
      observerAccess: 'members_only',
      groupId: 'group_initialize_concurrent_private',
    });
    const original = await transport.inspect({ remoteUrl: old.remoteUrl });
    const secondOwner = service(tempDirectory(), transport, ALICE);
    registerOwnerSnapshot(secondOwner, old, original, ALICE);

    transport.failRefreshAfterReinitialize = true;
    const [firstResult, secondResult] = await Promise.allSettled([
      firstOwner.service.initializeGroup(old.groupId),
      secondOwner.service.initializeGroup(old.groupId),
    ]);
    if (firstResult.status !== 'rejected')
      throw new Error('The first initialization unexpectedly completed');
    if (secondResult.status !== 'fulfilled') throw secondResult.reason;
    const [pending] = firstOwner.store.listGroupInitializations();
    const winner = secondResult.value;
    expect(winner.projection?.group.visibility_policy.observer_access).toBe(
      'members_only',
    );

    const recovered =
      await firstOwner.service.recoverInterruptedInitializations();
    expect(recovered).toEqual([]);
    expect(firstOwner.store.getGroup(old.groupId)).toBeNull();
    expect(firstOwner.store.getGroup(pending!.newGroupId)).toBeNull();
    expect(firstOwner.store.getGroup(winner.groupId)).toBeNull();
    expect(firstOwner.store.listGroups()).toEqual([]);
    expect(firstOwner.store.listGroupInitializations()).toEqual([]);
    expect(firstOwner.service.getCachedHistory(old.groupId)).toBeNull();
    expect(firstOwner.service.getCachedHistory(winner.groupId)).toBeNull();
    await expect(firstOwner.service.sync(winner.groupId)).rejects.toThrow(
      /Group not found/u,
    );
    firstOwner.store.close();
    secondOwner.store.close();
  });

  it('removes an abandoned locally replaced Group before observing the later winner', async () => {
    const { firstOwner, secondOwner, old, pending, winner } =
      await initializeThenLoseAfterLocalReplacement('allowed');

    const [recovered] =
      await firstOwner.service.recoverInterruptedInitializations();
    expect(recovered).toMatchObject({
      groupId: winner.groupId,
      subscriptionMode: 'observer',
      localPrincipalId: null,
      localCredentialId: null,
    });
    expect(firstOwner.store.getGroup(old.groupId)).toBeNull();
    expect(firstOwner.store.getLocalGroupBinding(old.groupId)).toBeNull();
    expect(firstOwner.store.getGroup(pending.newGroupId)).toBeNull();
    expect(
      firstOwner.store.getLocalGroupBinding(pending.newGroupId),
    ).toBeNull();
    expect(firstOwner.service.getCachedHistory(old.groupId)).toBeNull();
    expect(firstOwner.service.getCachedHistory(pending.newGroupId)).toBeNull();
    expect(firstOwner.store.getGroup(winner.groupId)).toMatchObject({
      subscriptionMode: 'observer',
    });
    expect(firstOwner.store.listGroupInitializations()).toEqual([]);
    firstOwner.store.close();
    secondOwner.store.close();
  });

  it('removes an abandoned locally replaced Group without subscribing to a members-only winner', async () => {
    const { firstOwner, secondOwner, old, pending, winner } =
      await initializeThenLoseAfterLocalReplacement('members_only');

    await expect(
      firstOwner.service.recoverInterruptedInitializations(),
    ).resolves.toEqual([]);
    expect(firstOwner.store.getGroup(old.groupId)).toBeNull();
    expect(firstOwner.store.getLocalGroupBinding(old.groupId)).toBeNull();
    expect(firstOwner.store.getGroup(pending.newGroupId)).toBeNull();
    expect(
      firstOwner.store.getLocalGroupBinding(pending.newGroupId),
    ).toBeNull();
    expect(firstOwner.store.getGroup(winner.groupId)).toBeNull();
    expect(firstOwner.store.getLocalGroupBinding(winner.groupId)).toBeNull();
    expect(firstOwner.store.listGroups()).toEqual([]);
    expect(firstOwner.service.getCachedHistory(old.groupId)).toBeNull();
    expect(firstOwner.service.getCachedHistory(pending.newGroupId)).toBeNull();
    expect(firstOwner.service.getCachedHistory(winner.groupId)).toBeNull();
    expect(firstOwner.store.listGroupInitializations()).toEqual([]);
    firstOwner.store.close();
    secondOwner.store.close();
  });

  it('continues recovering later initialization operations when the first remains unavailable', async () => {
    const transport = new MemoryTransport();
    let nowMs = Date.parse('2026-08-06T12:00:00.000Z');
    const owner = service(tempDirectory(), transport, ALICE, () => nowMs++);
    const first = await owner.service.createGroup({
      remoteUrl: '/tmp/recover-first-pending.git',
      name: 'First pending',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_recover_first_pending',
    });
    const second = await owner.service.createGroup({
      remoteUrl: '/tmp/recover-second-pending.git',
      name: 'Second pending',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_recover_second_pending',
    });

    transport.failRefreshAfterReinitialize = true;
    await expect(owner.service.initializeGroup(first.groupId)).rejects.toThrow(
      /local replacement is pending/u,
    );
    transport.failRefreshAfterReinitialize = true;
    await expect(owner.service.initializeGroup(second.groupId)).rejects.toThrow(
      /local replacement is pending/u,
    );
    const operations = owner.store.listGroupInitializations();
    const firstOperation = operations.find(
      (operation) => operation.oldGroupId === first.groupId,
    )!;
    const secondOperation = operations.find(
      (operation) => operation.oldGroupId === second.groupId,
    )!;
    transport.refreshAfterReinitializeErrors.set(
      first.remoteUrl,
      new Error('first remote remains unavailable'),
    );

    await expect(
      owner.service.recoverInterruptedInitializations(),
    ).rejects.toThrow(/1 Collaboration Group initialization recovery/u);
    expect(owner.store.listGroupInitializations()).toEqual([
      expect.objectContaining({ operationId: firstOperation.operationId }),
    ]);
    expect(owner.store.getGroup(first.groupId)).not.toBeNull();
    expect(owner.store.getGroup(firstOperation.newGroupId)).toBeNull();
    expect(owner.store.getGroup(second.groupId)).toBeNull();
    expect(owner.store.getGroup(secondOperation.newGroupId)).toMatchObject({
      subscriptionMode: 'member',
    });
    owner.store.close();
  });

  it('does not delete a Credential retained by another local Group binding', async () => {
    const transport = new MemoryTransport();
    const deletedCredentialIds: string[] = [];
    const owner = service(tempDirectory(), transport, ALICE, undefined, {
      deleteCredentialIdentity: async (credentialId) => {
        deletedCredentialIds.push(credentialId);
        return true;
      },
    });
    const initializedGroup = await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-shared-credential.git',
      name: 'Initialize shared Credential',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_initialize_shared_credential',
    });
    const retainedGroup = await owner.service.createGroup({
      remoteUrl: '/tmp/retained-shared-credential.git',
      name: 'Retained shared Credential',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_retained_shared_credential',
    });
    owner.store.detachLocalGroup({
      groupId: retainedGroup.groupId,
      reason: 'local_remove',
    });
    owner.store.completeLocalGroupCleanup(retainedGroup.groupId);

    await owner.service.initializeGroup(initializedGroup.groupId);

    expect(
      owner.store.getLocalGroupBinding(retainedGroup.groupId),
    ).toMatchObject({
      bindingState: 'retained',
      credentialId: ALICE.credentialId,
      recoveryCredentialId: `${ALICE.credentialId}_recovery`,
    });
    expect(deletedCredentialIds).toEqual([]);
    owner.store.close();
  });

  it('stops the old identity from writing after another device rewrites history', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/initialize-other-device.git',
      name: 'Other device initialization',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_other_device',
    });
    const rewrite = new Error(
      'The remote control history now belongs to a new Group; observe or join it',
    );
    rewrite.name = 'CollaborationProjectSpaceHistoryRewrittenError';
    vi.spyOn(transport, 'inspect').mockRejectedValue(rewrite);

    await expect(owner.service.sync('group_other_device')).rejects.toBe(
      rewrite,
    );
    expect(owner.store.getGroup('group_other_device')).toMatchObject({
      subscriptionMode: 'observer',
      localPrincipalId: null,
      localClientId: null,
      localCredentialId: null,
      protocolStatus: 'PROTOCOL_QUARANTINED',
      protocolError: expect.stringMatching(/observe or join/u),
    });
    await expect(
      owner.service.createWorkItem({
        groupId: 'group_other_device',
        workItemId: 'must_not_write',
        type: 'task',
        title: 'Must not write with the old identity',
      }),
    ).rejects.toThrow(/Observer subscriptions cannot issue/u);
    expect(transport.appendCount).toBe(0);
    owner.store.close();
  });

  it('keeps local state on remote dissolution failure and hides it before cleanup retry', async () => {
    const transport = new MemoryTransport();
    const cleanup = vi
      .fn<CollaborationLocalGroupCleanup>()
      .mockRejectedValueOnce(new Error('repository cache is busy'))
      .mockResolvedValue(undefined);
    const local = service(tempDirectory(), transport, ALICE, undefined, {
      cleanupLocalPaths: cleanup,
    });
    await local.service.createGroup({
      remoteUrl: '/tmp/lifecycle.git',
      name: 'Lifecycle project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_lifecycle',
    });
    await expect(
      local.service.leaveGroup('group_lifecycle', 'Owner cannot leave', 0),
    ).rejects.toThrow(/Owner cannot leave/u);

    transport.failNextAppend = new Error('remote push rejected');
    await expect(
      local.service.dissolveGroup('group_lifecycle', 'Project complete', 1),
    ).rejects.toThrow(/remote push rejected/u);
    expect(local.store.getGroup('group_lifecycle')).not.toBeNull();
    expect(local.store.getLocalGroupBinding('group_lifecycle')).toMatchObject({
      bindingState: 'attached',
    });
    expect(
      transport.histories.get('/tmp/lifecycle.git')?.projection.group.lifecycle,
    ).toBe('active');
    expect(cleanup).not.toHaveBeenCalled();

    const dissolved = await local.service.dissolveGroup(
      'group_lifecycle',
      'Project complete',
      1,
    );
    expect(dissolved).toMatchObject({
      groupId: 'group_lifecycle',
      removed: true,
      cleanupPending: true,
      cleanupError: 'repository cache is busy',
    });
    expect(local.store.getGroup('group_lifecycle')).toBeNull();
    expect(local.store.listGroups()).toEqual([]);
    expect(local.store.getLocalGroupBinding('group_lifecycle')).toMatchObject({
      principalId: ALICE.principalId,
      credentialId: ALICE.credentialId,
      bindingState: 'cleanup_pending',
      detachReason: 'group_dissolved',
      terminalHead: transport.histories.get('/tmp/lifecycle.git')?.head,
    });
    expect(
      transport.histories.get('/tmp/lifecycle.git')?.projection.group.lifecycle,
    ).toBe('dissolved');

    await expect(
      local.service.retryLocalCleanup('group_lifecycle'),
    ).resolves.toMatchObject({
      cleanupPending: false,
    });
    expect(local.store.getLocalGroupBinding('group_lifecycle')).toMatchObject({
      bindingState: 'retained',
      cleanupPaths: [],
      cleanupError: null,
    });
    expect(cleanup).toHaveBeenCalledTimes(2);
    local.store.close();
  });

  it('persists a remote terminal projection when the detach transaction must retry', async () => {
    const transport = new MemoryTransport();
    const local = service(tempDirectory(), transport, ALICE);
    await local.service.createGroup({
      remoteUrl: '/tmp/detach-retry.git',
      name: 'Detach retry project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_detach_retry',
    });
    const detach = vi.spyOn(local.store, 'detachLocalGroup');
    detach.mockImplementationOnce(() => {
      throw new Error('database detach transaction is busy');
    });

    await expect(
      local.service.dissolveGroup(
        'group_detach_retry',
        'Terminal remote event',
        1,
      ),
    ).resolves.toMatchObject({
      removed: false,
      cleanupPending: true,
      cleanupError: 'database detach transaction is busy',
    });
    expect(local.store.getGroup('group_detach_retry')).toMatchObject({
      lifecycle: 'dissolved',
    });
    expect(
      local.store.getGroup('group_detach_retry')?.projection?.group.lifecycle,
    ).toBe('dissolved');
    expect(
      local.store.getLocalGroupBinding('group_detach_retry'),
    ).toMatchObject({
      bindingState: 'attached',
    });

    await expect(local.service.retryPendingLocalCleanups()).resolves.toEqual([
      expect.objectContaining({
        groupId: 'group_detach_retry',
        removed: true,
        cleanupPending: false,
      }),
    ]);
    expect(local.store.getGroup('group_detach_retry')).toBeNull();
    expect(
      local.store.getLocalGroupBinding('group_detach_retry'),
    ).toMatchObject({
      bindingState: 'retained',
      detachReason: 'group_dissolved',
    });
    expect(transport.appendCount).toBe(1);
    local.store.close();
  });

  it('removes an Observer locally without appending a business event', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/local-remove.git',
      name: 'Local remove project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_local_remove',
    });
    const observerCleanup = vi.fn<CollaborationLocalGroupCleanup>();
    const observer = service(tempDirectory(), transport, BOB, undefined, {
      cleanupLocalPaths: observerCleanup,
    });
    await observer.service.observeGroup({
      remoteUrl: '/tmp/local-remove.git',
      gitSshKeyPath: BOB.privateKeyPath,
    });
    const appendCount = transport.appendCount;
    const remoteHead = transport.histories.get('/tmp/local-remove.git')?.head;

    await expect(
      observer.service.removeLocalGroup('group_local_remove'),
    ).resolves.toMatchObject({ removed: true, cleanupPending: false });
    expect(transport.appendCount).toBe(appendCount);
    expect(transport.histories.get('/tmp/local-remove.git')?.head).toBe(
      remoteHead,
    );
    expect(
      transport.histories.get('/tmp/local-remove.git')?.projection.group
        .lifecycle,
    ).toBe('active');
    expect(observer.store.getGroup('group_local_remove')).toBeNull();
    expect(
      observer.store.getLocalGroupBinding('group_local_remove'),
    ).toMatchObject({
      principalId: null,
      credentialId: null,
      bindingState: 'retained',
      detachReason: 'local_remove',
    });
    expect(observerCleanup).toHaveBeenCalledTimes(1);

    const ownerHead = transport.histories.get('/tmp/local-remove.git')?.head;
    await owner.service.removeLocalGroup('group_local_remove');
    const restoredOwner = await owner.service.observeGroup({
      remoteUrl: '/tmp/local-remove.git',
      gitSshKeyPath: ALICE.privateKeyPath,
    });
    expect(restoredOwner).toMatchObject({
      subscriptionMode: 'member',
      localPrincipalId: ALICE.principalId,
      localCredentialId: ALICE.credentialId,
      recoveryCredentialId: `${ALICE.credentialId}_recovery`,
    });
    expect(transport.histories.get('/tmp/local-remove.git')?.head).toBe(
      ownerHead,
    );
    expect(transport.appendCount).toBe(appendCount);
    owner.store.close();
    observer.store.close();
  });

  it('rejoins through a migrated locator with the retained Principal and current policy', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/rejoin-original.git',
      name: 'Rejoin project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'approval',
      observerAccess: 'allowed',
      groupId: 'group_rejoin',
    });
    const rejoinedIdentity: CollaborationEventSigningIdentity = {
      ...BOB,
      clientId: 'client_bob_rejoined',
      credentialId: 'credential_bob_rejoined',
      privateKeyPath: '/tmp/bob-rejoined',
    };
    const bob = service(tempDirectory(), transport, BOB, undefined, {
      createCredentialIdentity: async () => rejoinedIdentity,
    });
    await bob.service.joinGroup({
      remoteUrl: '/tmp/rejoin-original.git',
      gitSshKeyPath: BOB.privateKeyPath,
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    await owner.service.approveMembership('group_rejoin', BOB.principalId, 1);
    await bob.service.sync('group_rejoin');
    await expect(
      bob.service.dissolveGroup('group_rejoin', 'Not the Owner', 1),
    ).rejects.toThrow(/Only the Group Owner/u);
    await bob.service.leaveGroup('group_rejoin', 'Leaving for now', 2);
    expect(bob.store.getLocalGroupBinding('group_rejoin')).toMatchObject({
      principalId: BOB.principalId,
      credentialId: BOB.credentialId,
      bindingState: 'retained',
      detachReason: 'member_left',
    });

    const migratedHistory = transport.histories.get(
      '/tmp/rejoin-original.git',
    )!;
    transport.histories.set('/tmp/rejoin-migrated.git', migratedHistory);
    const requested = await bob.service.joinGroup({
      remoteUrl: '/tmp/rejoin-migrated.git',
      gitSshKeyPath: BOB.privateKeyPath,
      displayName: 'Bob',
      clientDisplayName: 'Bob Rejoined Device',
    });
    expect(requested).toMatchObject({
      groupId: 'group_rejoin',
      remoteUrl: '/tmp/rejoin-migrated.git',
      subscriptionMode: 'observer',
      localPrincipalId: BOB.principalId,
      localCredentialId: rejoinedIdentity.credentialId,
    });
    expect(requested.projection?.members[BOB.principalId]).toMatchObject({
      principal_id: BOB.principalId,
      status: 'requested',
    });
    expect(
      requested.projection?.credentials[BOB.principalId]?.[BOB.credentialId]
        ?.status,
    ).toBe('revoked');
    expect(
      requested.projection?.credentials[BOB.principalId]?.[
        rejoinedIdentity.credentialId
      ]?.status,
    ).toBe('active');
    expect(Object.keys(requested.projection?.members ?? {})).toHaveLength(2);
    expect(bob.store.getLocalGroupBinding('group_rejoin')).toMatchObject({
      remoteUrl: '/tmp/rejoin-migrated.git',
      principalId: BOB.principalId,
      credentialId: rejoinedIdentity.credentialId,
      bindingState: 'attached',
    });
    owner.store.close();
    bob.store.close();
  });

  it('marks a leaving member Workflow Turn for recovery and notifies the Owner', async () => {
    const transport = new MemoryTransport();
    let nowMs = Date.parse('2026-08-06T12:00:00.000Z');
    const advancingNow = () => nowMs++;
    const owner = service(tempDirectory(), transport, ALICE, advancingNow);
    const bob = service(tempDirectory(), transport, BOB, advancingNow);
    await owner.service.createGroup({
      remoteUrl: '/tmp/member-left-workflow.git',
      name: 'Workflow recovery project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_member_left_workflow',
    });
    await bob.service.joinGroup({
      remoteUrl: '/tmp/member-left-workflow.git',
      gitSshKeyPath: BOB.privateKeyPath,
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    await owner.service.sync('group_member_left_workflow');
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_member_left_workflow',
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_member_left_workflow',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_member_left_workflow',
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'instance_member_left',
      scope: { type: 'group' },
      participantBindings: { implementer: BOB.principalId },
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_member_left_workflow',
      instanceId: 'instance_member_left',
      expectedRevision: 1,
    });
    await owner.service.createTurn({
      groupId: 'group_member_left_workflow',
      instanceId: 'instance_member_left',
      expectedRevision: 2,
      turnId: 'turn_member_left',
    });

    await bob.service.leaveGroup(
      'group_member_left_workflow',
      'Leaving during assigned work',
      1,
    );
    const synced = await owner.service.sync('group_member_left_workflow');
    expect(synced.projection.turns.turn_member_left).toMatchObject({
      state: 'recovery_required',
      recovery_reason: `member_left:${BOB.principalId}`,
    });
    expect(
      synced.projection.workflowInstances.instance_member_left?.lifecycle,
    ).toBe('recovery_required');
    expect(
      owner.store.listPendingNotifications({
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        groupId: 'group_member_left_workflow',
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'member_left_workflow_recovery',
        resourceType: 'turn',
        resourceId: 'turn_member_left',
        severity: 'critical',
      }),
    ]);
    await withServiceApi(owner, async (baseUrl) => {
      const prefix = `${baseUrl}/api/collaboration/groups/group_member_left_workflow`;
      const notifications = await fetch(`${prefix}/notifications`);
      expect(notifications.status).toBe(200);
      expect(await notifications.json()).toMatchObject({
        notifications: [
          {
            kind: 'member_left_workflow_recovery',
            resourceType: 'turn',
            resourceId: 'turn_member_left',
          },
        ],
      });
      const recovered = await fetch(
        `${prefix}/workflow-instances/instance_member_left/turns/turn_member_left/recover`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 3,
            previousAttempt: 1,
            assigneePrincipalId: ALICE.principalId,
            reason: 'Owner reassigned work after Bob left',
          }),
        },
      );
      expect(recovered.status).toBe(200);
      const started = await fetch(
        `${prefix}/workflow-instances/instance_member_left/turns/turn_member_left/start`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: 4, executorId: null }),
        },
      );
      expect(started.status).toBe(200);
    });
    expect(
      owner.store.getGroup('group_member_left_workflow')?.projection?.turns
        .turn_member_left,
    ).toMatchObject({
      state: 'running',
      attempt: 2,
      assignee_principal_id: ALICE.principalId,
      claimant_principal_id: ALICE.principalId,
    });
    expect(
      owner.store.getGroup('group_member_left_workflow')?.projection
        ?.workflowInstances.instance_member_left,
    ).toMatchObject({
      lifecycle: 'running',
      resolved_assignments: { implementation: ALICE.principalId },
    });
    owner.store.close();
    bob.store.close();
  });

  it('binds a batched member-left notification to event-time affected Turns', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    const bob = service(tempDirectory(), transport, BOB);
    const groupId = 'group_member_left_batch';
    const remoteUrl = '/tmp/member-left-batch.git';
    await owner.service.createGroup({
      remoteUrl,
      name: 'Batched workflow recovery',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId,
    });
    await bob.service.joinGroup({
      remoteUrl,
      gitSshKeyPath: BOB.privateKeyPath,
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    await owner.service.sync(groupId);
    await owner.service.proposeWorkflowDefinition({
      groupId,
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    await owner.service.publishWorkflowDefinition({
      groupId,
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkflowInstance({
      groupId,
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'instance_batch',
      scope: { type: 'group' },
      participantBindings: { implementer: BOB.principalId },
    });
    await owner.service.startWorkflowInstance({
      groupId,
      instanceId: 'instance_batch',
      expectedRevision: 1,
    });
    await owner.service.createTurn({
      groupId,
      instanceId: 'instance_batch',
      expectedRevision: 2,
      turnId: 'turn_batch',
    });

    await bob.service.leaveGroup(groupId, 'Leaving before batched sync', 1);
    await transport.append({
      remoteUrl,
      buildEvent: (current) => {
        const head =
          current.projection.aggregateHeads[
            'workflow_instance:instance_batch'
          ]!;
        return buildCollaborationEventV3({
          groupId,
          eventId: 'evt_batch_recovered',
          aggregateType: 'workflow_instance',
          aggregateId: 'instance_batch',
          aggregateRevision: head.revision + 1,
          previousEventHash: head.eventHash,
          eventType: 'turn_recovered',
          actor: {
            principal_id: ALICE.principalId,
            client_id: ALICE.clientId,
            credential_id: ALICE.credentialId,
            executor_id: null,
          },
          occurredAt: '2026-08-06T12:01:00.000Z',
          payload: {
            turn_id: 'turn_batch',
            assignee_principal_id: ALICE.principalId,
            previous_attempt: 1,
            next_attempt: 2,
            reason: 'Recovered before Owner batch sync',
            start_deadline_at: '2026-08-06T12:02:00.000Z',
            deadline_snapshot_hash: collaborationDeadlineSnapshotHashV3({
              turnId: 'turn_batch',
              attempt: 2,
              timeoutPolicy:
                current.projection.turns.turn_batch!.timeout_policy_snapshot,
              startDeadlineAt: '2026-08-06T12:02:00.000Z',
              startedAt: null,
              executionDeadlineAt: null,
            }),
          },
        });
      },
    });

    const synced = await owner.service.sync(groupId);
    expect(synced.projection.turns.turn_batch).toMatchObject({
      state: 'pending',
      assignee_principal_id: ALICE.principalId,
      recovery_reason: null,
    });
    const notifications = owner.store.listPendingNotifications({
      principalId: ALICE.principalId,
      clientId: ALICE.clientId,
      groupId,
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        kind: 'member_left_workflow_recovery',
        resourceType: 'turn',
        resourceId: 'turn_batch',
        severity: 'critical',
        payload: {
          principal_id: BOB.principalId,
          turn_id: 'turn_batch',
        },
      }),
    ]);
    await owner.service.sync(groupId);
    expect(
      owner.store.listPendingNotifications({
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        groupId,
      }),
    ).toHaveLength(1);
    owner.store.close();
    bob.store.close();
  });

  it('serializes background sync with a command for the same repository', async () => {
    const transport = new OverlapDetectingMemoryTransport();
    const local = service(tempDirectory(), transport, ALICE);
    await local.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });

    const [, updated] = await Promise.all([
      local.service.sync('group_project'),
      local.service.createDiscussion({
        groupId: 'group_project',
        threadId: 'thread_concurrent',
        title: 'Concurrent command',
        scope: { type: 'group' },
      }),
    ]);

    expect(transport.maxConcurrentInspections).toBe(1);
    expect(
      updated.projection?.discussions.thread_concurrent?.discussion.title,
    ).toBe('Concurrent command');
    local.store.close();
  });

  it('observes the same verified projection without identity or remote writes', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const observer = service(tempDirectory(), transport, ALICE);
    const before = transport.appendCount;
    const observed = await observer.service.observeGroup({
      remoteUrl: '/tmp/project.git',
    });
    expect(transport.appendCount).toBe(before);
    expect(observed).toMatchObject({
      subscriptionMode: 'observer',
      localPrincipalId: null,
      localClientId: null,
      lastVerifiedHead: owner.store.getGroup('group_project')?.lastVerifiedHead,
    });
    await expect(
      observer.service.archiveGroup('group_project', 'not allowed', 1),
    ).rejects.toThrow(/Observer subscriptions cannot issue/u);
    owner.store.close();
    observer.store.close();
  });

  it('reuses an observed Group custom SSH key for join when no override is provided', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/reuse-observer-key.git',
      name: 'Reuse observer transport',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_reuse_observer_key',
    });
    const bob = service(tempDirectory(), transport, BOB);
    await bob.service.observeGroup({
      remoteUrl: '/tmp/reuse-observer-key.git',
      gitSshKeyPath: '/tmp/observed-custom-key',
    });

    const joined = await bob.service.joinGroup({
      remoteUrl: '/tmp/reuse-observer-key.git',
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    expect(joined.gitSshKeyPath).toBe('/tmp/observed-custom-key');
    expect(bob.store.getGroup('group_reuse_observer_key')?.gitSshKeyPath).toBe(
      '/tmp/observed-custom-key',
    );
    owner.store.close();
    bob.store.close();
  });

  it('registers one Principal with multiple Clients while Executor remains optional', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    const created = await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const secondIdentity = {
      ...ALICE,
      clientId: 'client_alice_studio',
      credentialId: 'credential_alice_studio',
    };
    const second = service(tempDirectory(), transport, secondIdentity);
    const joined = await recoverClient({
      owner,
      recovering: second,
      remoteUrl: '/tmp/project.git',
      groupId: 'group_project',
      principalId: created.localPrincipalId!,
      clientDisplayName: 'Alice Studio',
    });
    expect(
      Object.keys(joined.projection?.clients[ALICE.principalId] ?? {}),
    ).toEqual(
      expect.arrayContaining([ALICE.clientId, secondIdentity.clientId]),
    );
    expect(joined.projection?.executors[ALICE.principalId]).toBeUndefined();
    const revoked = await owner.service.revokeClient({
      groupId: 'group_project',
      clientId: secondIdentity.clientId,
      expectedRevision: 0,
      reason: 'Studio device was lost',
    });
    expect(
      revoked.projection?.clients[ALICE.principalId]?.[secondIdentity.clientId],
    ).toMatchObject({ status: 'revoked' });
    expect(
      revoked.projection?.credentials[ALICE.principalId]?.[
        secondIdentity.credentialId
      ],
    ).toMatchObject({ status: 'revoked' });
    owner.store.close();
    second.store.close();
  });

  it('cancels a pending recovery once with the requesting Credential', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/recovery-cancel.git',
      name: 'Recovery cancel',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_recovery_cancel',
    });
    const recoveryIdentity = {
      ...ALICE,
      clientId: 'client_alice_recovery_cancel',
      credentialId: 'credential_alice_recovery_cancel',
    };
    const recovering = service(tempDirectory(), transport, recoveryIdentity);
    await recovering.service.observeGroup({
      remoteUrl: '/tmp/recovery-cancel.git',
    });
    const requested = await recovering.service.requestIdentityRecovery({
      groupId: 'group_recovery_cancel',
      targetPrincipalId: ALICE.principalId,
      type: 'identity_recovery',
      clientDisplayName: 'Alice replacement',
    });
    const cancelled = await recovering.service.cancelRecovery({
      groupId: 'group_recovery_cancel',
      requestId: requested.requestId,
      expectedRevision: 1,
      reason: 'Replacement device is no longer trusted',
    });
    expect(
      cancelled.projection?.recoveryRequests[requested.requestId],
    ).toMatchObject({
      status: 'cancelled',
      decision_reason: 'Replacement device is no longer trusted',
    });
    await owner.service.sync('group_recovery_cancel');
    expect(
      owner.store.listNotifications({
        groupId: 'group_recovery_cancel',
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        includeHandled: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'recovery_cancelled',
          resourceId: requested.requestId,
          reason: 'cancelled',
          handledAtMs: expect.any(Number),
        }),
      ]),
    );
    await expect(
      owner.service.decideRecovery({
        groupId: 'group_recovery_cancel',
        requestId: requested.requestId,
        expectedRevision: 2,
        decision: 'approve',
        reason: 'too late',
      }),
    ).rejects.toThrow(/not pending/u);
    owner.store.close();
    recovering.store.close();
  });

  it('notifies the Owner and revokes old Credentials by default for Owner recovery', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/owner-recovery.git',
      name: 'Owner recovery',
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_owner_recovery',
    });
    const bob = service(tempDirectory(), transport, BOB);
    await bob.service.joinGroup({
      remoteUrl: '/tmp/owner-recovery.git',
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    await owner.service.sync('group_owner_recovery');

    const replacementIdentity = {
      ...BOB,
      clientId: 'client_bob_replacement',
      credentialId: 'credential_bob_replacement',
    };
    const replacement = service(
      tempDirectory(),
      transport,
      replacementIdentity,
    );
    await replacement.service.observeGroup({
      remoteUrl: '/tmp/owner-recovery.git',
    });
    const requested = await replacement.service.requestIdentityRecovery({
      groupId: 'group_owner_recovery',
      targetPrincipalId: BOB.principalId,
      type: 'owner_recovery',
      clientDisplayName: 'Bob replacement',
      reason: "All of Bob's previous devices are unavailable",
    });
    const ownerHistory = await owner.service.sync('group_owner_recovery');
    expect(
      owner.store.listPendingNotifications({
        groupId: 'group_owner_recovery',
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'owner_recovery',
        resourceId: requested.requestId,
        payload: expect.objectContaining({
          verification_code: requested.verificationCode,
        }),
      }),
    ]);
    const revision =
      ownerHistory.projection.aggregateHeads[`recovery:${requested.requestId}`]!
        .revision;
    const approved = await owner.service.decideRecovery({
      groupId: 'group_owner_recovery',
      requestId: requested.requestId,
      expectedRevision: revision,
      decision: 'approve',
      reason: 'Offline identity verification completed',
    });
    expect(
      approved.projection?.recoveryRequests[requested.requestId],
    ).toMatchObject({
      status: 'approved',
      approval_kind: 'owner',
      revoked_credential_ids: [BOB.credentialId],
    });
    expect(
      approved.projection?.credentials[BOB.principalId]?.[BOB.credentialId],
    ).toMatchObject({ status: 'revoked' });
    const recovered = await replacement.service.sync('group_owner_recovery');
    expect(
      recovered.projection.credentials[BOB.principalId]?.[
        replacementIdentity.credentialId
      ],
    ).toMatchObject({ status: 'active' });
    expect(
      replacement.store.getGroup('group_owner_recovery')?.subscriptionMode,
    ).toBe('member');
    owner.store.close();
    bob.store.close();
    replacement.store.close();
  });

  it('uses direct grants and rejects self-elevation in the reducer', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const bobIdentity: CollaborationEventSigningIdentity = {
      ...ALICE,
      principalId: 'principal_00000000-0000-4000-8000-000000000002',
      credentialId: 'credential_00000000-0000-4000-8000-000000000002',
      fingerprint: collaborationCredentialFingerprintV3(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview',
      ),
      purpose: 'event_signing',
      clientId: 'client_bob',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview',
    };
    const bob = service(tempDirectory(), transport, bobIdentity);
    const joined = await bob.service.joinGroup({
      remoteUrl: '/tmp/project.git',
      gitSshKeyPath: '/tmp/bob',
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    const revision =
      joined.projection?.aggregateHeads[`membership:${bobIdentity.principalId}`]
        ?.revision ?? 0;
    const updated = await owner.service.updatePermissions({
      groupId: 'group_project',
      principalId: bobIdentity.principalId,
      grants: ['work_item:create', 'discussion:post'],
      expectedRevision: revision,
    });
    expect(
      updated.projection?.permissionGrants[bobIdentity.principalId]?.grants,
    ).toEqual(['work_item:create', 'discussion:post']);
    expect(JSON.stringify(updated.projection)).not.toMatch(/role|claim/iu);
    owner.store.close();
    bob.store.close();
  });

  it('publishes progress, original business bytes, and Action Markdown into the verified Workspace', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    const created = await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const workspaceRevision =
      created.projection?.aggregateHeads[`workspace:${ALICE.principalId}`]
        ?.revision ?? 0;
    const progressed = await owner.service.postProgress({
      groupId: 'group_project',
      expectedRevision: workspaceRevision,
      summary: 'Contract draft complete',
      completed: ['Drafted contract'],
    });
    expect(Object.values(progressed.projection?.progressUpdates ?? {})).toEqual(
      [
        expect.objectContaining({
          principal_id: ALICE.principalId,
          actor_client_id: ALICE.clientId,
          summary: 'Contract draft complete',
        }),
      ],
    );

    const contents = Buffer.from('%PDF-1.7\ncontract\n', 'utf8');
    const shared = await owner.service.publishSharedFile({
      groupId: 'group_project',
      expectedRevision: 0,
      fileId: 'file_contract',
      fileName: 'contract.pdf',
      mediaType: 'application/pdf',
      contents,
    });
    const location = shared.projection?.fileLocations.file_contract;
    const repositoryFile = `${location!.repositoryDirectory}/contract.pdf`;
    expect(repositoryFile).toBe(
      'workspace/shared/documents/file_contract/contract.pdf',
    );
    await expect(
      owner.service.readVerifiedFile({
        groupId: 'group_project',
        repositoryFile,
      }),
    ).resolves.toEqual(contents);

    const actionRevision =
      shared.projection?.aggregateHeads[`workspace:${ALICE.principalId}`]
        ?.revision ?? 0;
    const action = await owner.service.publishAction({
      groupId: 'group_project',
      expectedRevision: actionRevision,
      actionId: 'draft_contract',
      name: 'Draft contract',
      version: 1,
      kind: 'run_once',
      prompt: '# Draft contract\n\nUse the approved requirements.\n',
      filesystemAccess: 'workspace_write',
    });
    const definition =
      action.projection?.actions[`${ALICE.principalId}:draft_contract`];
    expect(definition?.prompt_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(
      owner.service.readVerifiedFile({
        groupId: 'group_project',
        repositoryFile: definition!.prompt_ref,
      }),
    ).resolves.toEqual(
      Buffer.from(
        '# Draft contract\n\nUse the approved requirements.\n',
        'utf8',
      ),
    );
    owner.store.close();
  });

  it('requires integrity metadata for an external business file', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    await expect(
      owner.service.publishSharedFile({
        groupId: 'group_project',
        expectedRevision: 0,
        fileName: 'large.zip',
        mediaType: 'application/zip',
        externalLocator: {
          type: 'object_store',
          locator: 'objects/project/large.zip',
        },
      }),
    ).rejects.toThrow(/verified size and sha256/u);
    owner.store.close();
  });

  it('manages parallel Work Items, append-only progress, relations, and due reminders', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    await owner.service.createWorkItem({
      groupId: 'group_project',
      workItemId: 'wi_api',
      type: 'task',
      title: 'Implement API',
      priority: 'high',
      dueAt: '2026-08-05T12:00:00.000Z',
    });
    await owner.service.createWorkItem({
      groupId: 'group_project',
      workItemId: 'wi_test',
      type: 'issue',
      title: 'Add regression tests',
    });
    const related = await owner.service.changeWorkItemRelations({
      groupId: 'group_project',
      workItemId: 'wi_api',
      expectedRevision: 1,
      blockedBy: ['wi_test'],
    });
    expect(related.projection?.workItems.wi_api.blocked_by).toEqual([
      'wi_test',
    ]);
    expect(related.projection?.workItems.wi_test.revision).toBe(1);

    const artifact = await owner.service.stageWorkItemArtifact({
      groupId: 'group_project',
      workItemId: 'wi_api',
      fileName: 'api-contract.json',
      mediaType: 'application/json',
      contents: Buffer.from('{"openapi":"3.1.0"}\n'),
    });
    const progressed = await owner.service.postWorkItemProgress({
      groupId: 'group_project',
      workItemId: 'wi_api',
      expectedRevision: 2,
      summary: 'Route implementation complete',
      completed: ['POST /work-items'],
      artifactIds: [artifact.metadata.artifact_id],
    });
    expect(progressed.projection?.workItemUpdates.wi_api).toEqual([
      expect.objectContaining({
        summary: 'Route implementation complete',
        artifact_refs: [artifact.artifactRef],
      }),
    ]);
    expect(
      progressed.projection?.artifacts[artifact.metadata.artifact_id],
    ).toEqual(artifact.metadata);
    expect(
      owner.store.getStagedArtifact(artifact.metadata.artifact_id)?.state,
    ).toBe('committed');
    expect(
      transport.files.get(
        artifact.artifactRef.replace(
          /metadata\.json$/u,
          artifact.metadata.content_ref,
        ),
      ),
    ).toEqual(Buffer.from('{"openapi":"3.1.0"}\n'));
    await owner.service.changeWorkItemStatus({
      groupId: 'group_project',
      workItemId: 'wi_api',
      expectedRevision: 3,
      status: 'in_progress',
    });
    await expect(
      owner.service.changeWorkItemStatus({
        groupId: 'group_project',
        workItemId: 'wi_test',
        expectedRevision: 1,
        status: 'done',
      }),
    ).rejects.toThrow(/Invalid Work Item transition/u);

    expect(owner.service.refreshDueNotifications('group_project')).toBe(0);
    expect(
      owner.store.listPendingNotifications({
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        groupId: 'group_project',
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'work_item_due',
          resourceId: 'wi_api',
        }),
        expect.objectContaining({
          kind: 'work_item_blocked',
          resourceId: 'wi_api',
        }),
        expect.objectContaining({
          kind: 'work_item_blocking_others',
          resourceId: 'wi_test',
        }),
      ]),
    );
    await owner.service.changeWorkItemStatus({
      groupId: 'group_project',
      workItemId: 'wi_test',
      expectedRevision: 1,
      status: 'in_progress',
    });
    await owner.service.changeWorkItemStatus({
      groupId: 'group_project',
      workItemId: 'wi_test',
      expectedRevision: 2,
      status: 'done',
    });
    expect(
      owner.store.listPendingNotifications({
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        groupId: 'group_project',
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'work_item_unblocked',
          resourceId: 'wi_api',
        }),
      ]),
    );
    expect(
      owner.store.listNotifications({
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        groupId: 'group_project',
        includeHandled: true,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'work_item_blocking_others',
          resourceId: 'wi_test',
          handledAtMs: expect.any(Number),
        }),
      ]),
    );
    owner.store.close();
  });

  it('forces Executor-created Work Items to PROPOSED and preserves Principal ownership', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    await owner.service.registerExecutor({
      groupId: 'group_project',
      expectedRevision: 0,
      executorId: 'executor_codex',
      displayName: 'Codex',
      kind: 'codex',
    });
    const created = await owner.service.createWorkItem({
      groupId: 'group_project',
      workItemId: 'wi_found',
      type: 'issue',
      title: 'Discovered failure',
      status: 'open',
      executorId: 'executor_codex',
    });
    expect(created.projection?.workItems.wi_found).toMatchObject({
      status: 'proposed',
      owner_principal_id: ALICE.principalId,
      preferred_executor_id: null,
    });
    owner.store.close();
  });

  it('enforces Discussion authorship and persists deduplicated mention notifications', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const bobIdentity: CollaborationEventSigningIdentity = {
      ...ALICE,
      principalId: 'principal_00000000-0000-4000-8000-000000000002',
      credentialId: 'credential_00000000-0000-4000-8000-000000000002',
      fingerprint: collaborationCredentialFingerprintV3(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview',
      ),
      purpose: 'event_signing',
      clientId: 'client_bob',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview',
    };
    const bob = service(tempDirectory(), transport, bobIdentity);
    const joined = await bob.service.joinGroup({
      remoteUrl: '/tmp/project.git',
      gitSshKeyPath: '/tmp/bob',
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    const membershipRevision =
      joined.projection?.aggregateHeads[`membership:${bobIdentity.principalId}`]
        ?.revision ?? 0;
    await owner.service.updatePermissions({
      groupId: 'group_project',
      principalId: bobIdentity.principalId,
      grants: ['discussion:create', 'discussion:post'],
      expectedRevision: membershipRevision,
    });
    await owner.service.createDiscussion({
      groupId: 'group_project',
      threadId: 'thread_api',
      title: 'API review',
      scope: { type: 'group' },
    });
    await owner.service.postDiscussionMessage({
      groupId: 'group_project',
      threadId: 'thread_api',
      expectedRevision: 1,
      messageId: 'message_review',
      body: 'Please review the API.',
      mentions: [bobIdentity.principalId],
    });
    await bob.service.sync('group_project');
    await bob.service.sync('group_project');
    expect(
      bob.store.listPendingNotifications({
        principalId: bobIdentity.principalId,
        clientId: bobIdentity.clientId,
        groupId: 'group_project',
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'discussion_mention',
        resourceId: 'thread_api',
      }),
    ]);
    await expect(
      bob.service.reviseDiscussionMessage({
        groupId: 'group_project',
        threadId: 'thread_api',
        expectedRevision: 2,
        messageId: 'message_review',
        body: "I rewrote Alice's message.",
      }),
    ).rejects.toThrow(/Only the message author/u);

    const posted = await bob.service.postDiscussionMessage({
      groupId: 'group_project',
      threadId: 'thread_api',
      expectedRevision: 2,
      messageId: 'message_bob',
      body: 'Reviewed and approved.',
    });
    expect(
      posted.projection?.discussions.thread_api.messages.message_bob
        .author_principal_id,
    ).toBe(bobIdentity.principalId);
    await bob.service.reviseDiscussionMessage({
      groupId: 'group_project',
      threadId: 'thread_api',
      expectedRevision: 3,
      messageId: 'message_bob',
      body: 'Reviewed and approved with one note.',
    });
    await owner.service.setDiscussionResolved({
      groupId: 'group_project',
      threadId: 'thread_api',
      expectedRevision: 4,
      resolved: true,
    });
    const final = await bob.service.sync('group_project');
    expect(final.projection.discussions.thread_api.discussion.status).toBe(
      'resolved',
    );
    owner.store.close();
    bob.store.close();
  });

  it('versions Outcome-first Definitions while isolating layout from the business hash', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const proposed = await owner.service.proposeWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      launchPolicy: {
        group_admin: true,
        work_item_owner: true,
        principals: [],
      },
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    expect(
      proposed.projection?.workflowDefinitions['delivery@1'].definition.status,
    ).toBe('proposed');
    const published = await owner.service.publishWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    const before =
      published.projection?.workflowDefinitions['delivery@1'].definition;
    const laidOut = await owner.service.updateWorkflowLayout({
      groupId: 'group_project',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 2,
      view: 'free',
      nodes: {
        implementation: { x: 160, y: 180 },
        completed: { x: 560, y: 80 },
        cancelled: { x: 560, y: 260 },
      },
    });
    const after = laidOut.projection?.workflowDefinitions['delivery@1'];
    expect(after?.definition.machine_hash).toBe(before?.machine_hash);
    expect(after?.definition.version).toBe(1);
    expect(after?.definition.layout_hash).not.toBe(before?.layout_hash);
    await expect(
      owner.service.proposeWorkflowDefinition({
        groupId: 'group_project',
        definitionId: 'delivery',
        expectedRevision: 3,
        version: 1,
        name: 'Rewrite published version',
        machine: DELIVERY_MACHINE,
        layout: DELIVERY_LAYOUT,
      }),
    ).rejects.toThrow(/immutable/u);
    owner.store.close();
  });

  it('runs independent Group and Work Item Workflow Instances with participant resolution', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkItem({
      groupId: 'group_project',
      workItemId: 'wi_delivery',
      type: 'task',
      title: 'Deliver the release',
    });

    const draft = await owner.service.createWorkflowInstance({
      groupId: 'group_project',
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'wfi_draft',
      scope: { type: 'group' },
    });
    expect(draft.projection?.workflowInstances.wfi_draft.lifecycle).toBe(
      'draft',
    );
    await expect(
      owner.service.startWorkflowInstance({
        groupId: 'group_project',
        instanceId: 'wfi_draft',
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/lifecycle transition/u);
    const resolved = await owner.service.reassignWorkflowState({
      groupId: 'group_project',
      instanceId: 'wfi_draft',
      expectedRevision: 1,
      stateId: 'implementation',
      principalId: ALICE.principalId,
    });
    expect(resolved.projection?.workflowInstances.wfi_draft.lifecycle).toBe(
      'ready',
    );
    const groupRunning = await owner.service.startWorkflowInstance({
      groupId: 'group_project',
      instanceId: 'wfi_draft',
      expectedRevision: 2,
    });
    expect(groupRunning.projection?.workflowInstances.wfi_draft).toMatchObject({
      lifecycle: 'running',
      business_state: 'implementation',
      active_turn_id: null,
    });

    const itemInstance = await owner.service.createWorkflowInstance({
      groupId: 'group_project',
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'wfi_item',
      scope: { type: 'work_item', work_item_id: 'wi_delivery' },
      participantBindings: { implementer: ALICE.principalId },
      workItemStatusMapping: {
        completed: 'done',
        cancelled: 'cancelled',
      },
    });
    expect(itemInstance.projection?.workflowInstances.wfi_item.lifecycle).toBe(
      'ready',
    );
    expect(
      itemInstance.projection?.workItems.wi_delivery
        .primary_workflow_instance_id,
    ).toBe('wfi_item');
    await expect(
      owner.service.createWorkflowInstance({
        groupId: 'group_project',
        definitionId: 'delivery',
        definitionVersion: 1,
        instanceId: 'wfi_duplicate',
        scope: { type: 'work_item', work_item_id: 'wi_delivery' },
        participantBindings: { implementer: ALICE.principalId },
        workItemStatusMapping: {
          completed: 'done',
          cancelled: 'cancelled',
        },
      }),
    ).rejects.toThrow(/active primary Workflow/u);
    const running = await owner.service.startWorkflowInstance({
      groupId: 'group_project',
      instanceId: 'wfi_item',
      expectedRevision: 1,
    });
    expect(running.projection?.workItems.wi_delivery.status).toBe(
      'in_progress',
    );
    owner.store.close();
  });

  it('defaults to manual execution, fences competing Clients, and maps a terminal Outcome atomically', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkItem({
      groupId: 'group_project',
      workItemId: 'wi_delivery',
      type: 'task',
      title: 'Deliver release',
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_project',
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'wfi_delivery',
      scope: { type: 'work_item', work_item_id: 'wi_delivery' },
      participantBindings: { implementer: ALICE.principalId },
      workItemStatusMapping: {
        completed: 'done',
        cancelled: 'cancelled',
      },
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_project',
      instanceId: 'wfi_delivery',
      expectedRevision: 1,
    });
    const pending = await owner.service.createTurn({
      groupId: 'group_project',
      instanceId: 'wfi_delivery',
      expectedRevision: 2,
      turnId: 'turn_delivery',
    });
    expect(pending.projection?.turns.turn_delivery).toMatchObject({
      state: 'pending',
      execution_mode: 'manual',
      action_hash: null,
      claimant_client_id: null,
    });

    const secondIdentity = {
      ...ALICE,
      clientId: 'client_alice_studio',
      credentialId: 'credential_alice_studio',
    };
    const second = service(tempDirectory(), transport, secondIdentity);
    await recoverClient({
      owner,
      recovering: second,
      remoteUrl: '/tmp/project.git',
      groupId: 'group_project',
      principalId: ALICE.principalId,
      clientDisplayName: 'Alice Studio',
    });
    const ownerSynced = await owner.service.sync('group_project');
    const currentRevision =
      ownerSynced.projection.aggregateHeads['workflow_instance:wfi_delivery']!
        .revision;
    const claimed = await owner.service.startTurn({
      groupId: 'group_project',
      instanceId: 'wfi_delivery',
      turnId: 'turn_delivery',
      expectedRevision: currentRevision,
    });
    const claimedTurn = claimed.projection?.turns.turn_delivery;
    expect(claimedTurn).toMatchObject({
      state: 'running',
      claimant_principal_id: ALICE.principalId,
      claimant_client_id: ALICE.clientId,
    });
    const artifact = await owner.service.stageTurnArtifact({
      groupId: 'group_project',
      instanceId: 'wfi_delivery',
      turnId: 'turn_delivery',
      attempt: 1,
      fencingToken: claimedTurn!.fencing_token!,
      fileName: 'release.txt',
      mediaType: 'text/plain',
      contents: Buffer.from('release artifact\n'),
    });
    await expect(
      second.service.startTurn({
        groupId: 'group_project',
        instanceId: 'wfi_delivery',
        turnId: 'turn_delivery',
        expectedRevision: currentRevision,
      }),
    ).rejects.toThrow(/revision conflict/u);
    await expect(
      second.service.completeTurn({
        groupId: 'group_project',
        instanceId: 'wfi_delivery',
        turnId: 'turn_delivery',
        expectedRevision: currentRevision + 1,
        attempt: 1,
        fencingToken: claimedTurn!.fencing_token!,
        outcome: 'complete',
        summary: 'Attempted from a stale Client.',
      }),
    ).rejects.toThrow(/fenced claimant Client/u);

    const completed = await owner.service.completeTurn({
      groupId: 'group_project',
      instanceId: 'wfi_delivery',
      turnId: 'turn_delivery',
      expectedRevision: currentRevision + 1,
      attempt: 1,
      fencingToken: claimedTurn!.fencing_token!,
      outcome: 'complete',
      summary: 'Release delivered.',
      instruction: 'Verify the published artifacts.',
      artifactIds: [artifact.metadata.artifact_id],
    });
    expect(completed.projection?.workflowInstances.wfi_delivery).toMatchObject({
      lifecycle: 'closed',
      business_state: 'completed',
      active_turn_id: null,
    });
    expect(completed.projection?.workItems.wi_delivery).toMatchObject({
      status: 'done',
      primary_workflow_instance_id: null,
    });
    expect(
      completed.projection?.turns.turn_delivery.handoff?.artifact_refs,
    ).toEqual([artifact.artifactRef]);
    expect(
      owner.store.getStagedArtifact(artifact.metadata.artifact_id)?.state,
    ).toBe('committed');
    owner.store.close();
    second.store.close();
  });

  it('requires a Principal and Client scoped local Binding for assisted execution', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    await owner.service.registerExecutor({
      groupId: 'group_project',
      expectedRevision: 0,
      executorId: 'executor_codex',
      displayName: 'Codex',
      kind: 'codex',
    });
    await owner.service.publishAction({
      groupId: 'group_project',
      expectedRevision: 0,
      actionId: 'implement',
      name: 'Implement',
      version: 1,
      kind: 'run_once',
      prompt: 'Implement the current State.\n',
      filesystemAccess: 'workspace_write',
    });
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_project',
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'wfi_assisted',
      scope: { type: 'group' },
      participantBindings: { implementer: ALICE.principalId },
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_project',
      instanceId: 'wfi_assisted',
      expectedRevision: 1,
    });
    const configured = await owner.service.publishStateExecution({
      groupId: 'group_project',
      instanceId: 'wfi_assisted',
      stateId: 'implementation',
      expectedRevision: 2,
      mode: 'assisted',
      actionId: 'implement',
    });
    const pending = await owner.service.createTurn({
      groupId: 'group_project',
      instanceId: 'wfi_assisted',
      expectedRevision: 3,
      turnId: 'turn_assisted',
    });
    const turn = pending.projection?.turns.turn_assisted;
    expect(turn?.execution_mode).toBe('assisted');
    await expect(
      owner.service.startTurn({
        groupId: 'group_project',
        instanceId: 'wfi_assisted',
        turnId: 'turn_assisted',
        expectedRevision: 4,
        executorId: 'executor_codex',
      }),
    ).rejects.toThrow(/local Executor Binding/u);
    owner.store.saveExecutorBinding({
      groupId: 'group_project',
      instanceId: 'wfi_assisted',
      stateId: 'implementation',
      principalId: ALICE.principalId,
      clientId: ALICE.clientId,
      actionHash: turn!.action_hash!,
      promptHash: turn!.prompt_hash!,
      executorId: 'executor_codex',
      executorKind: 'codex',
      workspacePath: '/tmp/project-workspace',
      filesystemAccess: 'workspace_write',
      approvalPolicy: 'on-request',
      config: {},
      enabled: true,
    });
    const started = await owner.service.startTurn({
      groupId: 'group_project',
      instanceId: 'wfi_assisted',
      turnId: 'turn_assisted',
      expectedRevision: 4,
      executorId: 'executor_codex',
    });
    expect(started.projection?.turns.turn_assisted).toMatchObject({
      state: 'running',
      executor_id: 'executor_codex',
    });
    const actionResult = {
      format: 'icarus.collaboration-action-result/3' as const,
      outcome: 'complete',
      summary: 'Executor suggests completion.',
      instruction: 'Review the generated changes.',
      markers: ['executor_suggested', 'needs_review'],
      data: { provider: 'test' },
      artifacts: [],
      error: null,
    };
    const awaiting = await owner.service.recordActionState({
      groupId: 'group_project',
      instanceId: 'wfi_assisted',
      turnId: 'turn_assisted',
      expectedRevision: 5,
      attempt: 1,
      fencingToken: started.projection!.turns.turn_assisted.fencing_token!,
      state: 'completed',
      result: actionResult,
      resultHash: collaborationCanonicalHashV3(actionResult),
      executorId: 'executor_codex',
    });
    expect(awaiting.projection?.turns.turn_assisted).toMatchObject({
      state: 'awaiting_confirmation',
      executor_result: actionResult,
    });
    expect(awaiting.projection?.workflowInstances.wfi_assisted).toMatchObject({
      business_state: 'implementation',
      lifecycle: 'running',
    });
    const confirmedArtifact = await owner.service.stageTurnArtifact({
      groupId: 'group_project',
      instanceId: 'wfi_assisted',
      turnId: 'turn_assisted',
      attempt: 1,
      fencingToken: started.projection!.turns.turn_assisted.fencing_token!,
      fileName: 'confirmed-result.txt',
      mediaType: 'text/plain',
      contents: Buffer.from('confirmed result\n'),
    });
    let confirmed: Awaited<ReturnType<typeof owner.service.sync>> | null = null;
    await withServiceApi(owner, async (baseUrl) => {
      const response = await fetch(
        `${baseUrl}/api/collaboration/groups/group_project/workflow-instances/wfi_assisted/turns/turn_assisted/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision: 6,
            attempt: 1,
            fencingToken:
              started.projection!.turns.turn_assisted.fencing_token!,
            outcome: 'complete',
            summary: 'User reviewed and confirmed completion.',
            instruction: 'Proceed with the verified result.',
            markers: ['user_confirmed', 'release_candidate'],
            data: { confirmed: true },
            artifactIds: [confirmedArtifact.metadata.artifact_id],
          }),
        },
      );
      expect(response.status).toBe(200);
      confirmed = await owner.service.sync('group_project');
    });
    expect(confirmed!.projection.turns.turn_assisted).toMatchObject({
      state: 'completed',
      executor_result_hash: collaborationCanonicalHashV3(actionResult),
      completion_hash: expect.stringMatching(/^sha256:/u),
      handoff: {
        artifact_refs: [confirmedArtifact.artifactRef],
        markers: ['user_confirmed', 'release_candidate'],
      },
    });
    expect(confirmed!.projection.workflowInstances.wfi_assisted).toMatchObject({
      business_state: 'completed',
      lifecycle: 'closed',
    });
    expect(
      configured.projection?.stateExecutions.wfi_assisted.implementation,
    ).toBeDefined();
    owner.store.close();
  });

  it('advances automatic execution only from a validated custom business Outcome', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/automatic-project.git',
      name: 'Automatic project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_automatic',
    });
    await owner.service.registerExecutor({
      groupId: 'group_automatic',
      expectedRevision: 0,
      executorId: 'executor_run_once',
      displayName: 'Run Once',
      kind: 'run_once',
    });
    await owner.service.publishAction({
      groupId: 'group_automatic',
      expectedRevision: 0,
      actionId: 'verify',
      name: 'Verify',
      version: 1,
      kind: 'run_once',
      prompt: 'Verify the frozen implementation.\n',
      filesystemAccess: 'read_only',
    });
    const automaticMachine = {
      format: 'icarus.collaboration-machine/3' as const,
      initial_state: 'verification',
      states: {
        verification: {
          label: 'Verification',
          description: 'Verify the frozen implementation.',
          assignee: {
            type: 'principal' as const,
            principal_id: ALICE.principalId,
          },
          terminal: false,
          transitions: [
            {
              outcome: 'ready_for_test',
              label: 'Ready for test',
              target_state: 'completed',
            },
          ],
        },
        completed: {
          label: 'Completed',
          description: '',
          terminal: true,
          transitions: [],
        },
      },
    };
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_automatic',
      definitionId: 'verification',
      expectedRevision: 0,
      version: 1,
      name: 'Verification',
      machine: automaticMachine,
      layout: {
        format: 'icarus.collaboration-workflow-layout/1',
        view: 'free',
        nodes: {
          verification: { x: 0, y: 0 },
          completed: { x: 240, y: 0 },
        },
        revision: 1,
      },
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_automatic',
      definitionId: 'verification',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_automatic',
      definitionId: 'verification',
      definitionVersion: 1,
      instanceId: 'wfi_automatic',
      scope: { type: 'group' },
      participantBindings: {},
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_automatic',
      instanceId: 'wfi_automatic',
      expectedRevision: 1,
    });
    await owner.service.publishStateExecution({
      groupId: 'group_automatic',
      instanceId: 'wfi_automatic',
      stateId: 'verification',
      expectedRevision: 2,
      mode: 'automatic',
      actionId: 'verify',
    });
    const pending = await owner.service.createTurn({
      groupId: 'group_automatic',
      instanceId: 'wfi_automatic',
      expectedRevision: 3,
      turnId: 'turn_automatic',
    });
    const turn = pending.projection!.turns.turn_automatic;
    owner.store.saveExecutorBinding({
      groupId: 'group_automatic',
      instanceId: 'wfi_automatic',
      stateId: 'verification',
      principalId: ALICE.principalId,
      clientId: ALICE.clientId,
      actionHash: turn.action_hash!,
      promptHash: turn.prompt_hash!,
      executorId: 'executor_run_once',
      executorKind: 'run_once',
      workspacePath: '/tmp/project-workspace',
      filesystemAccess: 'read_only',
      approvalPolicy: 'never',
      config: { agent_jid: 'web:main' },
      enabled: true,
    });
    const runOnce = vi.fn<RunOnceService['runOnce']>(
      async (input, lifecycle) => {
        lifecycle?.onAccepted({
          runId: 'run-automatic',
          queryId: 'query-automatic',
          containerName: 'container-automatic',
        });
        expect(input.messages[0]?.content).toContain('ready_for_test');
        expect(input.messages[0]?.content).toContain(
          'Verify the frozen implementation.',
        );
        return {
          ok: true,
          text: JSON.stringify({
            format: 'icarus.collaboration-action-result/3',
            outcome: 'ready_for_test',
            summary: 'Verification is ready for testing.',
            instruction: 'Run the release suite.',
            markers: [],
            data: { suite: 'release' },
            artifacts: [],
            error: null,
          }),
          run_id: 'run-automatic',
          query_id: 'query-automatic',
          model: 'test-model',
          output_files: [],
        };
      },
    );
    const registry = new ActionExecutorRegistry();
    registry.register(
      new RunOnceActionExecutor({
        preflightWorkspace: vi.fn(),
        runOnce,
      }),
    );
    const scheduler = new CollaborationScheduler(
      owner.store,
      owner.service,
      registry,
      { ownerId: 'test-scheduler' },
    );

    const completeTurn = owner.service.completeTurn.bind(owner.service);
    vi.spyOn(owner.service, 'completeTurn')
      .mockRejectedValueOnce(
        new Error('injected failure after Action Result commit'),
      )
      .mockImplementation(completeTurn);
    await expect(scheduler.syncNow('group_automatic')).rejects.toThrow(
      /injected failure/u,
    );
    const interrupted = owner.store.getGroup('group_automatic')!.projection!;
    expect(interrupted.turns.turn_automatic).toMatchObject({
      state: 'running',
      executor_result: {
        outcome: 'ready_for_test',
        summary: 'Verification is ready for testing.',
      },
      executor_result_hash: expect.stringMatching(/^sha256:/u),
      completion_hash: null,
    });
    expect(
      owner.store
        .listEventRecords('group_automatic', 5_000)
        .filter(({ event }) => event.event_type === 'action_completed'),
    ).toHaveLength(1);

    const restartedScheduler = new CollaborationScheduler(
      owner.store,
      owner.service,
      new ActionExecutorRegistry(),
      { ownerId: 'restarted-test-scheduler' },
    );
    await restartedScheduler.syncNow('group_automatic');

    const completed = owner.store.getGroup('group_automatic')!.projection!;
    expect(completed.turns.turn_automatic).toMatchObject({
      state: 'completed',
      outcome: 'ready_for_test',
      executor_result: {
        outcome: 'ready_for_test',
        data: { suite: 'release' },
      },
      executor_result_hash: expect.stringMatching(/^sha256:/u),
      completion_hash: expect.stringMatching(/^sha256:/u),
    });
    expect(completed.workflowInstances.wfi_automatic).toMatchObject({
      lifecycle: 'closed',
      business_state: 'completed',
    });
    expect(runOnce).toHaveBeenCalledOnce();
    expect(
      owner.store
        .listEventRecords('group_automatic', 5_000)
        .filter(({ event }) => event.event_type === 'action_completed'),
    ).toHaveLength(1);
    owner.store.close();
  });

  it('derives two-node and self-loop incoming Handoffs from verified Instance history', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/handoff-project.git',
      name: 'Handoff project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_handoff',
    });
    await owner.service.registerExecutor({
      groupId: 'group_handoff',
      expectedRevision: 0,
      executorId: 'executor_handoff',
      displayName: 'Handoff Executor',
      kind: 'run_once',
    });
    await owner.service.publishAction({
      groupId: 'group_handoff',
      expectedRevision: 0,
      actionId: 'review_handoff',
      name: 'Review Handoff',
      version: 1,
      kind: 'run_once',
      prompt: 'Review the incoming release context.\n',
      filesystemAccess: 'read_only',
    });
    const twoNodeMachine = {
      format: 'icarus.collaboration-machine/3' as const,
      initial_state: 'prepare',
      states: {
        prepare: {
          label: 'Prepare',
          description: 'Prepare the release.',
          assignee: {
            type: 'principal' as const,
            principal_id: ALICE.principalId,
          },
          terminal: false,
          transitions: [
            { outcome: 'review', label: 'Review', target_state: 'review' },
          ],
        },
        review: {
          label: 'Review',
          description: 'Review the release.',
          assignee: {
            type: 'principal' as const,
            principal_id: ALICE.principalId,
          },
          terminal: false,
          transitions: [
            { outcome: 'complete', label: 'Complete', target_state: 'done' },
          ],
        },
        done: {
          label: 'Done',
          description: '',
          terminal: true,
          transitions: [],
        },
      },
    };
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_handoff',
      definitionId: 'handoff',
      expectedRevision: 0,
      version: 1,
      name: 'Handoff',
      machine: twoNodeMachine,
      layout: {
        format: 'icarus.collaboration-workflow-layout/1',
        view: 'free',
        nodes: {
          prepare: { x: 0, y: 0 },
          review: { x: 240, y: 0 },
          done: { x: 480, y: 0 },
        },
        revision: 1,
      },
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_handoff',
      definitionId: 'handoff',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_handoff',
      definitionId: 'handoff',
      definitionVersion: 1,
      instanceId: 'wfi_handoff',
      scope: { type: 'group' },
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_handoff',
      instanceId: 'wfi_handoff',
      expectedRevision: 1,
    });
    await owner.service.publishStateExecution({
      groupId: 'group_handoff',
      instanceId: 'wfi_handoff',
      stateId: 'review',
      expectedRevision: 2,
      mode: 'automatic',
      actionId: 'review_handoff',
    });
    await owner.service.createTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_handoff',
      expectedRevision: 3,
      turnId: 'turn_prepare',
    });
    const started = await owner.service.startTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_handoff',
      turnId: 'turn_prepare',
      expectedRevision: 4,
    });
    const fence = started.projection!.turns.turn_prepare.fencing_token!;
    const completed = await owner.service.completeTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_handoff',
      turnId: 'turn_prepare',
      expectedRevision: 5,
      attempt: 1,
      fencingToken: fence,
      outcome: 'review',
      summary: 'Preparation complete.',
      instruction: 'Review the signed release.',
      markers: ['signed'],
      dataRefs: ['workspace/shared/data/release.json'],
      artifactRefs: [
        'artifacts/workflows/wfi_handoff/turn_prepare/report/metadata.json',
      ],
      data: { release: '2026.08' },
    });
    expect(completed.projection?.workflowInstances.wfi_handoff).toMatchObject({
      business_state: 'review',
      last_completed_turn_id: 'turn_prepare',
      last_handoff_hash: expect.stringMatching(/^sha256:/u),
    });
    const beforeNext = transport.histories.get('/tmp/handoff-project.git')!;
    const next = await owner.service.createTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_handoff',
      expectedRevision: 6,
      turnId: 'turn_review',
    });
    const nextTurn = next.projection!.turns.turn_review;
    expect(nextTurn.incoming_handoff).toEqual(
      completed.projection!.turns.turn_prepare.handoff,
    );
    expect(nextTurn.incoming_handoff).toMatchObject({
      instruction: 'Review the signed release.',
      data_refs: ['workspace/shared/data/release.json'],
      artifact_refs: [
        'artifacts/workflows/wfi_handoff/turn_prepare/report/metadata.json',
      ],
      data: { release: '2026.08' },
    });
    expect(nextTurn.execution_mode).toBe('automatic');

    for (const incoming of [
      null,
      { ...nextTurn.incoming_handoff!, source_turn_id: 'turn_cross_instance' },
    ]) {
      const tamperedTurn = {
        ...nextTurn,
        turn_id: `turn_tampered_${incoming ? 'cross' : 'missing'}`,
        incoming_handoff: incoming,
        incoming_handoff_hash: incoming
          ? collaborationCanonicalHashV3(incoming)
          : null,
      };
      const head =
        beforeNext.projection.aggregateHeads['workflow_instance:wfi_handoff']!;
      const tamperedEvent = buildCollaborationEventV3({
        groupId: 'group_handoff',
        eventId: `evt_${tamperedTurn.turn_id}`,
        aggregateType: 'workflow_instance',
        aggregateId: 'wfi_handoff',
        aggregateRevision: head.revision + 1,
        previousEventHash: head.eventHash,
        eventType: 'turn_created',
        actor: {
          principal_id: ALICE.principalId,
          client_id: ALICE.clientId,
          credential_id: ALICE.credentialId,
          executor_id: null,
        },
        occurredAt: '2026-08-06T12:05:00.000Z',
        payload: { turn: tamperedTurn },
      });
      expect(() =>
        reduceCollaborationEventV3(beforeNext.projection, tamperedEvent),
      ).toThrow(/incoming Handoff/u);
    }

    owner.store.saveExecutorBinding({
      groupId: 'group_handoff',
      instanceId: 'wfi_handoff',
      stateId: 'review',
      principalId: ALICE.principalId,
      clientId: ALICE.clientId,
      actionHash: nextTurn.action_hash!,
      promptHash: nextTurn.prompt_hash!,
      executorId: 'executor_handoff',
      executorKind: 'run_once',
      workspacePath: '/tmp/handoff-workspace',
      filesystemAccess: 'read_only',
      approvalPolicy: 'never',
      config: { agent_jid: 'web:main' },
      enabled: true,
    });
    const handoffRunOnce = vi.fn<RunOnceService['runOnce']>(
      async (input, lifecycle) => {
        lifecycle?.onAccepted({
          runId: 'run-handoff',
          queryId: 'query-handoff',
          containerName: 'container-handoff',
        });
        const actionInput = input.messages[0]!.content;
        expect(actionInput).toContain('Review the signed release.');
        expect(actionInput).toContain('workspace/shared/data/release.json');
        expect(actionInput).toContain(
          'artifacts/workflows/wfi_handoff/turn_prepare/report/metadata.json',
        );
        expect(actionInput).toContain('2026.08');
        return {
          ok: true,
          text: JSON.stringify({
            format: 'icarus.collaboration-action-result/3',
            outcome: 'complete',
            summary: 'Reviewed the carried Handoff.',
            instruction: '',
            markers: [],
            data: { reviewed: true },
            artifacts: [],
            error: null,
          }),
          run_id: 'run-handoff',
          query_id: 'query-handoff',
          model: 'test-model',
          output_files: [],
        };
      },
    );
    const handoffRegistry = new ActionExecutorRegistry();
    handoffRegistry.register(
      new RunOnceActionExecutor({
        preflightWorkspace: vi.fn(),
        runOnce: handoffRunOnce,
      }),
    );
    const handoffScheduler = new CollaborationScheduler(
      owner.store,
      owner.service,
      handoffRegistry,
      { ownerId: 'handoff-scheduler' },
    );
    await handoffScheduler.syncNow('group_handoff');
    await handoffScheduler.syncNow('group_handoff');
    expect(
      owner.store.getGroup('group_handoff')?.projection?.turns.turn_review,
    ).toMatchObject({ state: 'completed', outcome: 'complete' });
    expect(handoffRunOnce).toHaveBeenCalledOnce();

    const loopMachine = {
      format: 'icarus.collaboration-machine/3' as const,
      initial_state: 'loop',
      states: {
        loop: {
          label: 'Loop',
          description: 'Repeat until externally closed.',
          assignee: {
            type: 'principal' as const,
            principal_id: ALICE.principalId,
          },
          terminal: false,
          transitions: [
            { outcome: 'again', label: 'Again', target_state: 'loop' },
          ],
        },
      },
    };
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_handoff',
      definitionId: 'loop',
      expectedRevision: 0,
      version: 1,
      name: 'Loop',
      machine: loopMachine,
      layout: {
        format: 'icarus.collaboration-workflow-layout/1',
        view: 'free',
        nodes: { loop: { x: 0, y: 0 } },
        revision: 1,
      },
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_handoff',
      definitionId: 'loop',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_handoff',
      definitionId: 'loop',
      definitionVersion: 1,
      instanceId: 'wfi_loop',
      scope: { type: 'group' },
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_handoff',
      instanceId: 'wfi_loop',
      expectedRevision: 1,
    });
    await owner.service.createTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_loop',
      expectedRevision: 2,
      turnId: 'turn_loop_1',
    });
    const loopStarted = await owner.service.startTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_loop',
      turnId: 'turn_loop_1',
      expectedRevision: 3,
    });
    const loopCompleted = await owner.service.completeTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_loop',
      turnId: 'turn_loop_1',
      expectedRevision: 4,
      attempt: 1,
      fencingToken: loopStarted.projection!.turns.turn_loop_1.fencing_token!,
      outcome: 'again',
      summary: 'Loop iteration complete.',
      instruction: 'Use this context on the next iteration.',
      data: { iteration: 1 },
    });
    const loopNext = await owner.service.createTurn({
      groupId: 'group_handoff',
      instanceId: 'wfi_loop',
      expectedRevision: 5,
      turnId: 'turn_loop_2',
    });
    expect(loopNext.projection?.turns.turn_loop_2.incoming_handoff).toEqual(
      loopCompleted.projection?.turns.turn_loop_1.handoff,
    );
    owner.store.close();
  });

  it('rejects Turn creation by an unrelated active Member', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/turn-authority.git',
      name: 'Turn authority',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_turn_authority',
    });
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_turn_authority',
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      machine: {
        ...DELIVERY_MACHINE,
        states: {
          ...DELIVERY_MACHINE.states,
          implementation: {
            ...DELIVERY_MACHINE.states.implementation,
            assignee: {
              type: 'principal' as const,
              principal_id: ALICE.principalId,
            },
          },
        },
      },
      layout: DELIVERY_LAYOUT,
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_turn_authority',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_turn_authority',
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'wfi_authority',
      scope: { type: 'group' },
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_turn_authority',
      instanceId: 'wfi_authority',
      expectedRevision: 1,
    });
    const bob = service(tempDirectory(), transport, BOB);
    await bob.service.joinGroup({
      remoteUrl: '/tmp/turn-authority.git',
      gitSshKeyPath: BOB.privateKeyPath,
      displayName: 'Bob',
      clientDisplayName: 'Bob MacBook',
    });
    await owner.service.sync('group_turn_authority');
    await expect(
      bob.service.createTurn({
        groupId: 'group_turn_authority',
        instanceId: 'wfi_authority',
        expectedRevision: 2,
        turnId: 'turn_unauthorized',
      }),
    ).rejects.toThrow(/cannot create|Actor cannot create/u);
    await expect(
      owner.service.createTurn({
        groupId: 'group_turn_authority',
        instanceId: 'wfi_authority',
        expectedRevision: 2,
        turnId: 'turn_authorized',
      }),
    ).resolves.toMatchObject({
      projection: {
        turns: { turn_authorized: { state: 'pending' } },
      },
    });
    owner.store.close();
    bob.store.close();
  });

  it('observes start timeout reminders without changing Workflow or Work Item state', async () => {
    const transport = new MemoryTransport();
    let nowMs = Date.parse('2026-08-06T12:00:00.000Z');
    const owner = service(tempDirectory(), transport, ALICE, () => nowMs);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      gitSshKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    await owner.service.proposeWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      expectedRevision: 0,
      version: 1,
      name: 'Delivery',
      machine: DELIVERY_MACHINE,
      layout: DELIVERY_LAYOUT,
    });
    await owner.service.publishWorkflowDefinition({
      groupId: 'group_project',
      definitionId: 'delivery',
      version: 1,
      expectedRevision: 1,
    });
    await owner.service.createWorkItem({
      groupId: 'group_project',
      workItemId: 'wi_timeout',
      type: 'task',
      title: 'Timeout remains notify-only',
    });
    await owner.service.createWorkflowInstance({
      groupId: 'group_project',
      definitionId: 'delivery',
      definitionVersion: 1,
      instanceId: 'wfi_timeout',
      scope: { type: 'work_item', work_item_id: 'wi_timeout' },
      participantBindings: { implementer: ALICE.principalId },
      workItemStatusMapping: {
        completed: 'done',
        cancelled: 'cancelled',
      },
    });
    await owner.service.startWorkflowInstance({
      groupId: 'group_project',
      instanceId: 'wfi_timeout',
      expectedRevision: 1,
    });
    expect(
      owner.store.listNotifications({
        groupId: 'group_project',
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        resourceType: 'workflow_instance',
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'workflow_state_action',
        resourceId: 'wfi_timeout',
        handledAtMs: null,
      }),
    ]);
    await owner.service.createTurn({
      groupId: 'group_project',
      instanceId: 'wfi_timeout',
      expectedRevision: 2,
      turnId: 'turn_timeout',
    });
    expect(
      owner.store.listNotifications({
        groupId: 'group_project',
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        includeHandled: true,
        resourceType: 'workflow_instance',
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'workflow_state_action',
        resourceId: 'wfi_timeout',
        handledAtMs: expect.any(Number),
      }),
    ]);
    expect(
      owner.store.listNotifications({
        groupId: 'group_project',
        principalId: ALICE.principalId,
        clientId: ALICE.clientId,
        resourceType: 'turn',
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'workflow_turn_action',
        resourceId: 'turn_timeout',
      }),
    ]);

    nowMs += 60_000;
    await expect(
      owner.service.observeDueTimeouts('group_project'),
    ).resolves.toEqual({ observed: 1, notifications: 1 });
    let projection = owner.store.getGroup('group_project')!.projection!;
    expect(projection.turns.turn_timeout.state).toBe('pending');
    expect(projection.workflowInstances.wfi_timeout.lifecycle).toBe('running');
    expect(projection.workItems.wi_timeout.status).toBe('in_progress');

    await expect(
      owner.service.observeDueTimeouts('group_project'),
    ).resolves.toEqual({ observed: 0, notifications: 0 });
    nowMs += 30_000;
    await expect(
      owner.service.observeDueTimeouts('group_project'),
    ).resolves.toEqual({ observed: 0, notifications: 1 });
    projection = owner.store.getGroup('group_project')!.projection!;
    expect(projection.timeoutObservations.turn_timeout).toHaveLength(1);
    expect(
      owner.store
        .listPendingNotifications({
          principalId: ALICE.principalId,
          clientId: ALICE.clientId,
          groupId: 'group_project',
        })
        .map((notification) => notification.dedupeKey),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('workflow-turn:'),
        expect.stringContaining('workflow-timeout:'),
        expect.stringContaining('workflow-timeout:'),
      ]),
    );
    owner.store.close();
  });
});
