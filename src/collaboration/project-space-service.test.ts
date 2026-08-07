import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { CollaborationPrincipalIdentity } from './project-space-identity.js';
import { CollaborationProjectSpaceIdentityService } from './project-space-identity.js';
import {
  CollaborationProjectSpaceService,
  type CollaborationProjectSpaceTransport,
  type ValidatedProjectSpaceHistory,
} from './project-space-service.js';
import { CollaborationProjectSpaceStore } from './project-space-store.js';
import { reduceCollaborationEventV3 } from './protocol/v3-reducer.js';

const temporaryDirectories: string[] = [];
const ALICE: CollaborationPrincipalIdentity = {
  principalId: 'principal_sha256_alice',
  clientId: 'client_alice_mac',
  privateKeyPath: '/tmp/alice',
  publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKXQfKE4hE1m3sXEXAMPLEalice',
  keyRef: 'ssh-ed25519:SHA256:alice',
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

function service(
  root: string,
  transport: MemoryTransport,
  identity: CollaborationPrincipalIdentity,
) {
  const store = new CollaborationProjectSpaceStore(path.join(root, 'store.db'));
  const identities = {
    resolveSigningIdentity: async () => identity,
  } as unknown as CollaborationProjectSpaceIdentityService;
  return {
    store,
    service: new CollaborationProjectSpaceService(
      store,
      transport,
      path.join(root, 'repos'),
      identities,
      () => Date.parse('2026-08-06T12:00:00.000Z'),
    ),
  };
}

describe('Collaboration project space v3 Group and identity service', () => {
  it('creates an immediately active Group without Roles, Claims, or Workflow', async () => {
    const transport = new MemoryTransport();
    const local = service(tempDirectory(), transport, ALICE);
    const group = await local.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      signingKeyPath: ALICE.privateKeyPath,
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

  it('observes the same verified projection without identity or remote writes', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      signingKeyPath: ALICE.privateKeyPath,
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

  it('registers one Principal with multiple Clients while Executor remains optional', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      signingKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const secondIdentity = { ...ALICE, clientId: 'client_alice_studio' };
    const second = service(tempDirectory(), transport, secondIdentity);
    const joined = await second.service.joinGroup({
      remoteUrl: '/tmp/project.git',
      signingKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice Studio',
    });
    expect(
      Object.keys(joined.projection?.clients[ALICE.principalId] ?? {}),
    ).toEqual(
      expect.arrayContaining([ALICE.clientId, secondIdentity.clientId]),
    );
    expect(joined.projection?.executors[ALICE.principalId]).toBeUndefined();
    owner.store.close();
    second.store.close();
  });

  it('uses direct grants and rejects self-elevation in the reducer', async () => {
    const transport = new MemoryTransport();
    const owner = service(tempDirectory(), transport, ALICE);
    await owner.service.createGroup({
      remoteUrl: '/tmp/project.git',
      name: 'Project',
      signingKeyPath: ALICE.privateKeyPath,
      displayName: 'Alice',
      clientDisplayName: 'Alice MacBook',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_project',
    });
    const bobIdentity: CollaborationPrincipalIdentity = {
      ...ALICE,
      principalId: 'principal_sha256_bob',
      clientId: 'client_bob',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMXQfKE4hE1m3sXEXAMPLEreview',
      keyRef: 'ssh-ed25519:SHA256:bob',
    };
    const bob = service(tempDirectory(), transport, bobIdentity);
    const joined = await bob.service.joinGroup({
      remoteUrl: '/tmp/project.git',
      signingKeyPath: '/tmp/bob',
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
      signingKeyPath: ALICE.privateKeyPath,
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
      signingKeyPath: ALICE.privateKeyPath,
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
});
