import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCollaborationVirtualTree,
  CollaborationProjectSpaceGitTransport,
} from './project-space-git.js';
import {
  collaborationPrincipalIdFromSshFingerprintV3,
  CollaborationProjectSpaceIdentityService,
  type CollaborationPrincipalIdentity,
} from './project-space-identity.js';
import { CollaborationProjectSpaceService } from './project-space-service.js';
import { CollaborationProjectSpaceStore } from './project-space-store.js';
import {
  buildCollaborationEventV3,
  reduceCollaborationEventV3,
} from './protocol/v3-reducer.js';

const roots: string[] = [];
const NOW = '2026-08-06T12:00:00.000Z';
const DELIVERY_MACHINE = {
  format: 'icarus.collaboration-machine/3' as const,
  initial_state: 'build',
  states: {
    build: {
      label: 'Build',
      description: 'Build the verified artifact.',
      assignee: { type: 'participant_slot' as const, slot: 'builder' },
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
const DELIVERY_LAYOUT = {
  format: 'icarus.collaboration-workflow-layout/1' as const,
  view: 'participants' as const,
  nodes: { build: { x: 96, y: 160 }, done: { x: 420, y: 160 } },
  revision: 1,
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function run(cwd: string, args: readonly string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'icarus-v3-git-'));
  roots.push(root);
  const key = path.join(root, 'signing-key');
  run(root, ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  const fingerprint = run(root, [
    'ssh-keygen',
    '-lf',
    `${key}.pub`,
    '-E',
    'sha256',
  ]).match(/SHA256:[^\s]+/u)?.[0];
  if (!fingerprint) throw new Error('SSH fingerprint missing');
  const identity: CollaborationPrincipalIdentity = {
    principalId: collaborationPrincipalIdFromSshFingerprintV3(fingerprint),
    clientId: 'client_alice',
    privateKeyPath: key,
    publicKey,
    keyRef: `ssh-ed25519:${fingerprint}`,
  };
  const remote = path.join(root, 'remote.git');
  mkdirSync(remote);
  run(remote, ['git', 'init', '-q', '--bare']);
  return {
    root,
    remote,
    cache: path.join(root, 'cache.git'),
    identity,
  };
}

function genesis(identity: CollaborationPrincipalIdentity) {
  const eventId = 'evt_genesis';
  const payload = {
    group: {
      format: 'icarus.collaboration-group/3' as const,
      protocol_version: 3 as const,
      group_id: 'group_signed',
      name: 'Signed project',
      creator: {
        principal_id: identity.principalId,
        signing_key_ref: identity.keyRef,
      },
      owner_principal_id: identity.principalId,
      control_branch: 'refs/heads/icarus/control' as const,
      lifecycle: 'active' as const,
      membership_policy: { join: 'open' as const },
      visibility_policy: { observer_access: 'allowed' as const },
      created_at: NOW,
      archived_at: null,
    },
    member: {
      format: 'icarus.collaboration-member/3' as const,
      principal_id: identity.principalId,
      display_name: 'Alice',
      signing_key_ref: identity.keyRef,
      signing_public_key: identity.publicKey,
      status: 'active' as const,
      joined_at_event: eventId,
    },
    client: {
      format: 'icarus.collaboration-client/1' as const,
      principal_id: identity.principalId,
      client_id: identity.clientId,
      display_name: 'Alice MacBook',
      capabilities: [],
      status: 'active' as const,
      registered_at_event: eventId,
    },
    owner_permissions: {
      format: 'icarus.collaboration-permission-grant/1' as const,
      principal_id: identity.principalId,
      grants: [],
      revision: 1,
      updated_at_event: eventId,
    },
  };
  const event = buildCollaborationEventV3({
    groupId: 'group_signed',
    eventId,
    aggregateType: 'group',
    aggregateId: 'group_signed',
    aggregateRevision: 1,
    previousEventHash: null,
    eventType: 'group_initialized',
    actor: {
      principal_id: identity.principalId,
      client_id: identity.clientId,
      executor_id: null,
    },
    occurredAt: NOW,
    payload,
  });
  return { event, projection: reduceCollaborationEventV3(null, event) };
}

describe('Collaboration project space v3 Git protocol', () => {
  it('creates and replays a signed JSON-only Aggregate history', async () => {
    const test = fixture();
    const transport = new CollaborationProjectSpaceGitTransport();
    const initial = genesis(test.identity);
    const history = await transport.create({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      identity: test.identity,
      genesisEvent: initial.event,
      genesisProjection: initial.projection,
    });
    expect(history.projection.group.lifecycle).toBe('active');
    expect(history.eventRecords).toHaveLength(1);
    const files = run(test.cache, [
      'git',
      'ls-tree',
      '-r',
      '--name-only',
      history.head,
    ]).split('\n');
    expect(files).toEqual(
      expect.arrayContaining([
        'group.json',
        `members/${test.identity.principalId}/member.json`,
        `members/${test.identity.principalId}/clients/${test.identity.clientId}.json`,
        `permissions/${test.identity.principalId}.json`,
        'projections/group.json',
      ]),
    );
    expect(files.some((file) => file.endsWith('.yaml'))).toBe(false);

    const replayed = await transport.inspect({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
    });
    expect(replayed.projection).toEqual(history.projection);
  }, 30_000);

  it('materializes original business bytes with a verified JSON sidecar and virtual tree', async () => {
    const test = fixture();
    const transport = new CollaborationProjectSpaceGitTransport();
    const initial = genesis(test.identity);
    let history = await transport.create({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      identity: test.identity,
      genesisEvent: initial.event,
      genesisProjection: initial.projection,
    });
    const contents = Buffer.from('%PDF-1.7\nproject contract\n', 'utf8');
    history = await transport.append({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
      identity: test.identity,
      buildEvent: (current) => {
        const aggregateId = 'shared';
        const head =
          current.projection.aggregateHeads[`workspace:${aggregateId}`];
        const metadata = {
          format: 'icarus.collaboration-file-metadata/1' as const,
          file_id: 'file_contract',
          original_filename: 'contract.pdf',
          content_ref: 'contract.pdf',
          external_locator: null,
          media_type: 'application/pdf',
          size: contents.byteLength,
          sha256: `sha256:${crypto.createHash('sha256').update(contents).digest('hex')}`,
          uploader_principal_id: test.identity.principalId,
          uploader_client_id: test.identity.clientId,
          executor_id: null,
          origin: 'human' as const,
          refs: {
            work_item_refs: [],
            workflow_instance_refs: [],
            discussion_refs: [],
          },
          created_at: NOW,
          revision: 1,
        };
        return {
          event: buildCollaborationEventV3({
            groupId: 'group_signed',
            eventId: 'evt_shared_file',
            aggregateType: 'workspace',
            aggregateId,
            aggregateRevision: (head?.revision ?? 0) + 1,
            previousEventHash: head?.eventHash ?? null,
            eventType: 'shared_file_published',
            actor: {
              principal_id: test.identity.principalId,
              client_id: test.identity.clientId,
              executor_id: null,
            },
            occurredAt: NOW,
            payload: { metadata },
          }),
          materializedFiles: [
            {
              path: 'workspace/shared/documents/file_contract/contract.pdf',
              contents,
            },
          ],
        };
      },
    });
    const bytes = await transport.readVerifiedFile({
      repositoryPath: test.cache,
      verifiedHead: history.head,
      repositoryFile: 'workspace/shared/documents/file_contract/contract.pdf',
    });
    expect(bytes).toEqual(contents);
    const tree = buildCollaborationVirtualTree(history.projection);
    expect(tree.find((node) => node.id === 'shared')?.children).toEqual([
      expect.objectContaining({ name: 'contract.pdf', rawId: 'file_contract' }),
    ]);
  }, 30_000);

  it('atomically materializes a staged Work Item Artifact with its signed progress event', async () => {
    const test = fixture();
    const transport = new CollaborationProjectSpaceGitTransport();
    const store = new CollaborationProjectSpaceStore(
      path.join(test.root, 'collaboration.db'),
    );
    const identities = {
      resolveSigningIdentity: async () => test.identity,
    } as unknown as CollaborationProjectSpaceIdentityService;
    const service = new CollaborationProjectSpaceService(
      store,
      transport,
      path.join(test.root, 'repositories'),
      identities,
      () => Date.parse(NOW),
    );
    try {
      await service.createGroup({
        remoteUrl: test.remote,
        name: 'Signed project',
        signingKeyPath: test.identity.privateKeyPath,
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'open',
        observerAccess: 'allowed',
        groupId: 'group_signed',
      });
      await service.createWorkItem({
        groupId: 'group_signed',
        workItemId: 'wi_release',
        type: 'task',
        title: 'Release',
      });
      const bytes = Buffer.from('%PDF-1.7\nrelease evidence\n');
      const staged = await service.stageWorkItemArtifact({
        groupId: 'group_signed',
        workItemId: 'wi_release',
        fileName: 'evidence.pdf',
        mediaType: 'application/pdf',
        contents: bytes,
      });
      const completed = await service.postWorkItemProgress({
        groupId: 'group_signed',
        workItemId: 'wi_release',
        expectedRevision: 1,
        summary: 'Evidence attached',
        artifactIds: [staged.metadata.artifact_id],
      });
      const repositoryPath = completed.repositoryPath;
      const contentPath = staged.artifactRef.replace(
        /metadata\.json$/u,
        staged.metadata.content_ref,
      );
      expect(
        await transport.readVerifiedFile({
          repositoryPath,
          verifiedHead: completed.lastVerifiedHead!,
          repositoryFile: contentPath,
        }),
      ).toEqual(bytes);
      const sidecar = JSON.parse(
        (
          await transport.readVerifiedFile({
            repositoryPath,
            verifiedHead: completed.lastVerifiedHead!,
            repositoryFile: staged.artifactRef,
          })
        ).toString('utf8'),
      ) as Record<string, unknown>;
      expect(sidecar).toEqual(staged.metadata);
      expect(store.listFileIndex('group_signed')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileId: `artifact:${staged.metadata.artifact_id}`,
            repositoryPath: contentPath,
          }),
        ]),
      );
      expect(store.getStagedArtifact(staged.metadata.artifact_id)?.state).toBe(
        'committed',
      );
    } finally {
      store.close();
    }
  }, 30_000);

  it('materializes Workflow Definition lifecycle commits when files stay unchanged', async () => {
    const test = fixture();
    const store = new CollaborationProjectSpaceStore(
      path.join(test.root, 'collaboration.db'),
    );
    const identities = {
      resolveSigningIdentity: async () => test.identity,
    } as unknown as CollaborationProjectSpaceIdentityService;
    const service = new CollaborationProjectSpaceService(
      store,
      new CollaborationProjectSpaceGitTransport(),
      path.join(test.root, 'repositories'),
      identities,
      () => Date.parse(NOW),
    );
    try {
      await service.createGroup({
        remoteUrl: test.remote,
        name: 'Signed project',
        signingKeyPath: test.identity.privateKeyPath,
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'open',
        observerAccess: 'allowed',
        groupId: 'group_signed',
      });
      await service.proposeWorkflowDefinition({
        groupId: 'group_signed',
        definitionId: 'delivery',
        expectedRevision: 0,
        version: 1,
        name: 'Delivery',
        machine: DELIVERY_MACHINE,
        layout: DELIVERY_LAYOUT,
      });
      const published = await service.publishWorkflowDefinition({
        groupId: 'group_signed',
        definitionId: 'delivery',
        expectedRevision: 1,
        version: 1,
      });
      expect(
        published.projection?.workflowDefinitions['delivery@1'].definition
          .status,
      ).toBe('published');

      const laidOut = await service.updateWorkflowLayout({
        groupId: 'group_signed',
        definitionId: 'delivery',
        expectedRevision: 2,
        version: 1,
        view: 'free',
        nodes: { build: { x: 120, y: 180 }, done: { x: 520, y: 180 } },
      });
      expect(
        laidOut.projection?.workflowDefinitions['delivery@1'].layout.view,
      ).toBe('free');

      const retired = await service.retireWorkflowDefinition({
        groupId: 'group_signed',
        definitionId: 'delivery',
        expectedRevision: 3,
        reason: 'Fixture complete',
      });
      expect(
        retired.projection?.workflowDefinitions['delivery@1'].definition.status,
      ).toBe('retired');
    } finally {
      store.close();
    }
  }, 30_000);

  it('rejects sidecar hash mismatch before writing and keeps the verified head', async () => {
    const test = fixture();
    const transport = new CollaborationProjectSpaceGitTransport();
    const initial = genesis(test.identity);
    const history = await transport.create({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      identity: test.identity,
      genesisEvent: initial.event,
      genesisProjection: initial.projection,
    });
    await expect(
      transport.append({
        remoteUrl: test.remote,
        repositoryPath: test.cache,
        previousHead: history.head,
        identity: test.identity,
        buildEvent: (current) => ({
          event: buildCollaborationEventV3({
            groupId: 'group_signed',
            eventId: 'evt_bad_file',
            aggregateType: 'workspace',
            aggregateId: 'shared',
            aggregateRevision: 1,
            previousEventHash: null,
            eventType: 'shared_file_published',
            actor: {
              principal_id: test.identity.principalId,
              client_id: test.identity.clientId,
              executor_id: null,
            },
            occurredAt: NOW,
            payload: {
              metadata: {
                format: 'icarus.collaboration-file-metadata/1',
                file_id: 'file_bad',
                original_filename: 'bad.bin',
                content_ref: 'bad.bin',
                external_locator: null,
                media_type: 'application/octet-stream',
                size: 3,
                sha256: `sha256:${'0'.repeat(64)}`,
                uploader_principal_id: test.identity.principalId,
                uploader_client_id: test.identity.clientId,
                executor_id: null,
                origin: 'human',
                refs: {
                  work_item_refs: [],
                  workflow_instance_refs: [],
                  discussion_refs: [],
                },
                created_at: NOW,
                revision: 1,
              },
            },
          }),
          materializedFiles: [
            {
              path: 'workspace/shared/documents/file_bad/bad.bin',
              contents: Buffer.from('bad'),
            },
          ],
        }),
      }),
    ).rejects.toThrow(/does not match its JSON sidecar/u);
    const after = await transport.inspect({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
    });
    expect(after.head).toBe(history.head);
  }, 30_000);

  it('quarantines a direct commit that cannot be explained by one v3 event', async () => {
    const test = fixture();
    const transport = new CollaborationProjectSpaceGitTransport();
    const initial = genesis(test.identity);
    const history = await transport.create({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      identity: test.identity,
      genesisEvent: initial.event,
      genesisProjection: initial.projection,
    });
    const checkout = path.join(test.root, 'tamper');
    run(test.root, ['git', 'clone', '-q', test.remote, checkout]);
    run(checkout, [
      'git',
      'checkout',
      '-q',
      '-b',
      'tamper',
      'origin/icarus/control',
    ]);
    run(checkout, ['git', 'config', 'user.name', test.identity.principalId]);
    run(checkout, [
      'git',
      'config',
      'user.email',
      `${test.identity.principalId}@icarus.local`,
    ]);
    run(checkout, ['git', 'config', 'gpg.format', 'ssh']);
    run(checkout, [
      'git',
      'config',
      'user.signingkey',
      test.identity.privateKeyPath,
    ]);
    run(checkout, ['git', 'config', 'commit.gpgsign', 'true']);
    run(checkout, ['git', 'mv', 'group.json', 'group-tampered.json']);
    run(checkout, ['git', 'commit', '-q', '-m', 'tamper']);
    run(checkout, [
      'git',
      'push',
      '-q',
      'origin',
      'HEAD:refs/heads/icarus/control',
    ]);
    await expect(
      transport.inspect({
        remoteUrl: test.remote,
        repositoryPath: test.cache,
        previousHead: history.head,
      }),
    ).rejects.toThrow(/exactly one v3 event|Unexpected file/u);
  }, 30_000);
});
