import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCollaborationVirtualTree,
  collaborationProjectSpaceEventPath,
  CollaborationProjectSpaceGitTransport,
} from './project-space-git.js';
import {
  CollaborationProjectSpaceIdentityService,
  type CollaborationEventSigningIdentity,
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
  const identity: CollaborationEventSigningIdentity = {
    principalId: 'principal_00000000-0000-4000-8000-000000000001',
    clientId: 'client_alice',
    credentialId: 'credential_alice',
    privateKeyPath: key,
    publicKey,
    fingerprint,
    purpose: 'event_signing',
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

function identityService(
  identity: CollaborationEventSigningIdentity,
): CollaborationProjectSpaceIdentityService {
  return {
    createPrincipalIdentity: async () => identity,
    createCredentialIdentity: async (input: { purpose?: string }) => ({
      ...identity,
      credentialId:
        input.purpose === 'group_recovery'
          ? `${identity.credentialId}_recovery`
          : identity.credentialId,
      purpose:
        input.purpose === 'group_recovery'
          ? ('group_recovery' as const)
          : ('event_signing' as const),
    }),
    resolveGitSshKeyPath: (configured?: string) =>
      configured || identity.privateKeyPath,
    resolveGitSshKeyCandidates: (configured?: string) => [
      configured || identity.privateKeyPath,
    ],
  } as unknown as CollaborationProjectSpaceIdentityService;
}

function genesis(identity: CollaborationEventSigningIdentity) {
  const eventId = 'evt_genesis';
  const payload = {
    group: {
      format: 'icarus.collaboration-group/3' as const,
      protocol_version: 3 as const,
      group_id: 'group_signed',
      name: 'Signed project',
      creator: {
        principal_id: identity.principalId,
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
    credential: {
      format: 'icarus.collaboration-credential/1' as const,
      credential_id: identity.credentialId,
      principal_id: identity.principalId,
      client_id: identity.clientId,
      public_key: identity.publicKey,
      fingerprint: identity.fingerprint,
      purpose: 'event_signing' as const,
      status: 'active' as const,
      created_at_event: eventId,
      revoked_at_event: null,
    },
    recovery_credential: {
      format: 'icarus.collaboration-credential/1' as const,
      credential_id: `${identity.credentialId}_recovery`,
      principal_id: identity.principalId,
      client_id: identity.clientId,
      public_key: identity.publicKey,
      fingerprint: identity.fingerprint,
      purpose: 'group_recovery' as const,
      status: 'active' as const,
      created_at_event: eventId,
      revoked_at_event: null,
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
      credential_id: identity.credentialId,
      executor_id: null,
    },
    occurredAt: NOW,
    payload,
  });
  return { event, projection: reduceCollaborationEventV3(null, event) };
}

describe('Collaboration project space v3 Git protocol', () => {
  it('falls back from the configured default SSH key and persists the working key', async () => {
    const test = fixture();
    const primaryKey = path.join(test.root, 'configured-default-key');
    const fallbackKey = test.identity.privateKeyPath;
    const logPath = path.join(test.root, 'git-fallback.jsonl');
    const wrapperPath = path.join(test.root, 'git-fallback.cjs');
    const realGit = run(test.root, ['which', 'git']);
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const ssh = process.env.GIT_SSH_COMMAND || '';
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, ssh }) + '\\n');
if (args[0] === 'ls-remote' && ssh.includes(${JSON.stringify(primaryKey)})) {
  process.stderr.write('git@example.test: Permission denied (publickey).\\n');
  process.exit(128);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
`,
      { mode: 0o700 },
    );
    chmodSync(wrapperPath, 0o700);
    const store = new CollaborationProjectSpaceStore(
      path.join(test.root, 'fallback.db'),
    );
    const baseIdentities = identityService(test.identity);
    const identities = {
      createPrincipalIdentity: () => baseIdentities.createPrincipalIdentity(),
      createCredentialIdentity: (
        input: Parameters<typeof baseIdentities.createCredentialIdentity>[0],
      ) => baseIdentities.createCredentialIdentity(input),
      resolveGitSshKeyPath: () => primaryKey,
      resolveGitSshKeyCandidates: () => [primaryKey, fallbackKey],
    } as unknown as CollaborationProjectSpaceIdentityService;
    const service = new CollaborationProjectSpaceService(
      store,
      new CollaborationProjectSpaceGitTransport(wrapperPath),
      path.join(test.root, 'fallback-repositories'),
      identities,
      () => Date.parse(NOW),
    );
    try {
      const created = await service.createGroup({
        remoteUrl: test.remote,
        name: 'Fallback project',
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'open',
        observerAccess: 'allowed',
        groupId: 'group_fallback',
      });
      expect(created.gitSshKeyPath).toBe(fallbackKey);
      const attempts = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { args: string[]; ssh: string })
        .filter((entry) => entry.args[0] === 'ls-remote');
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.ssh).toContain(primaryKey);
      expect(attempts[1]!.ssh).toContain(fallbackKey);
    } finally {
      store.close();
    }
  });

  it('does not try another SSH identity for non-authentication failures', async () => {
    const test = fixture();
    const primaryKey = path.join(test.root, 'configured-default-key');
    const fallbackKey = test.identity.privateKeyPath;
    const logPath = path.join(test.root, 'git-no-fallback.jsonl');
    const wrapperPath = path.join(test.root, 'git-no-fallback.cjs');
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  ssh: process.env.GIT_SSH_COMMAND || '',
}) + '\\n');
process.stderr.write('fatal: repository does not exist\\n');
process.exit(128);
`,
      { mode: 0o700 },
    );
    chmodSync(wrapperPath, 0o700);
    const transport = new CollaborationProjectSpaceGitTransport(wrapperPath);
    const initial = genesis(test.identity);

    await expect(
      transport.create({
        remoteUrl: test.remote,
        repositoryPath: test.cache,
        gitSshKeyPaths: [primaryKey, fallbackKey],
        identity: test.identity,
        genesisEvent: initial.event,
        genesisProjection: initial.projection,
      }),
    ).rejects.toThrow(/repository does not exist/u);
    const attempts = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { ssh: string });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.ssh).toContain(primaryKey);
  });

  it('materializes and replays unbound Invite issuance and consumption', async () => {
    const test = fixture();
    const bobKey = path.join(test.root, 'bob-signing-key');
    run(test.root, [
      'ssh-keygen',
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      bobKey,
    ]);
    const bobPublicKey = readFileSync(`${bobKey}.pub`, 'utf8').trim();
    const bobFingerprint = run(test.root, [
      'ssh-keygen',
      '-lf',
      `${bobKey}.pub`,
      '-E',
      'sha256',
    ]).match(/SHA256:[^\s]+/u)?.[0];
    if (!bobFingerprint) throw new Error('Bob SSH fingerprint missing');
    const bobIdentity: CollaborationEventSigningIdentity = {
      principalId: 'principal_00000000-0000-4000-8000-000000000002',
      clientId: 'client_bob',
      credentialId: 'credential_bob',
      privateKeyPath: bobKey,
      publicKey: bobPublicKey,
      fingerprint: bobFingerprint,
      purpose: 'event_signing',
    };
    const ownerStore = new CollaborationProjectSpaceStore(
      path.join(test.root, 'owner.db'),
    );
    const bobStore = new CollaborationProjectSpaceStore(
      path.join(test.root, 'bob.db'),
    );
    const owner = new CollaborationProjectSpaceService(
      ownerStore,
      new CollaborationProjectSpaceGitTransport(),
      path.join(test.root, 'owner-repositories'),
      identityService(test.identity),
      () => Date.parse(NOW),
    );
    const bob = new CollaborationProjectSpaceService(
      bobStore,
      new CollaborationProjectSpaceGitTransport(),
      path.join(test.root, 'bob-repositories'),
      identityService(bobIdentity),
      () => Date.parse(NOW),
    );
    try {
      await owner.createGroup({
        remoteUrl: test.remote,
        name: 'Signed invite project',
        gitSshKeyPath: test.identity.privateKeyPath,
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'invite_only',
        observerAccess: 'allowed',
        groupId: 'group_signed',
      });
      await owner.issueInvite({
        groupId: 'group_signed',
        inviteId: 'invite_bob',
        expectedRevision: 0,
      });
      await bob.joinGroup({
        remoteUrl: test.remote,
        gitSshKeyPath: bobIdentity.privateKeyPath,
        displayName: 'Bob',
        clientDisplayName: 'Bob MacBook',
        inviteId: 'invite_bob',
      });
      const synced = await owner.sync('group_signed');
      expect(synced.projection.invites.invite_bob).toMatchObject({
        status: 'used',
      });
      const repositoryPath =
        ownerStore.getGroup('group_signed')!.repositoryPath;
      const files = run(repositoryPath, [
        'git',
        'ls-tree',
        '-r',
        '--name-only',
        synced.head,
      ]).split('\n');
      expect(files).toEqual(
        expect.arrayContaining([
          'invites/invite_bob.json',
          'projections/invites/invite_bob.json',
        ]),
      );
      expect(
        files.some((file) =>
          file.startsWith('events/invites/invite_bob/00000001-'),
        ),
      ).toBe(true);
      expect(
        JSON.parse(
          run(repositoryPath, [
            'git',
            'show',
            `${synced.head}:invites/invite_bob.json`,
          ]),
        ),
      ).toMatchObject({ status: 'used' });
    } finally {
      ownerStore.close();
      bobStore.close();
    }
  }, 30_000);

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

  it('materializes member exit revocations and terminal Group dissolution', async () => {
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
    const bob: CollaborationEventSigningIdentity = {
      ...test.identity,
      principalId: 'principal_00000000-0000-4000-8000-000000000002',
      clientId: 'client_bob',
      credentialId: 'credential_bob',
    };
    const joinEventId = 'evt_bob_join';
    history = await transport.append({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
      identity: bob,
      buildEvent: (current) =>
        buildCollaborationEventV3({
          groupId: 'group_signed',
          eventId: joinEventId,
          aggregateType: 'membership',
          aggregateId: bob.principalId,
          aggregateRevision: 1,
          previousEventHash: null,
          eventType: 'member_registered',
          actor: {
            principal_id: bob.principalId,
            client_id: bob.clientId,
            credential_id: bob.credentialId,
            executor_id: null,
          },
          occurredAt: NOW,
          payload: {
            member: {
              format: 'icarus.collaboration-member/3',
              principal_id: bob.principalId,
              display_name: 'Bob',
              status: 'active',
              joined_at_event: joinEventId,
            },
            client: {
              format: 'icarus.collaboration-client/1',
              principal_id: bob.principalId,
              client_id: bob.clientId,
              display_name: 'Bob MacBook',
              capabilities: [],
              status: 'active',
              registered_at_event: joinEventId,
            },
            credential: {
              format: 'icarus.collaboration-credential/1',
              credential_id: bob.credentialId,
              principal_id: bob.principalId,
              client_id: bob.clientId,
              public_key: bob.publicKey,
              fingerprint: bob.fingerprint,
              purpose: 'event_signing',
              status: 'active',
              created_at_event: joinEventId,
              revoked_at_event: null,
            },
          },
        }),
    });
    const executorEventId = 'evt_bob_executor';
    history = await transport.append({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
      identity: bob,
      buildEvent: (current) => {
        const head =
          current.projection.aggregateHeads[`membership:${bob.principalId}`]!;
        return buildCollaborationEventV3({
          groupId: 'group_signed',
          eventId: executorEventId,
          aggregateType: 'membership',
          aggregateId: bob.principalId,
          aggregateRevision: head.revision + 1,
          previousEventHash: head.eventHash,
          eventType: 'executor_registered',
          actor: {
            principal_id: bob.principalId,
            client_id: bob.clientId,
            credential_id: bob.credentialId,
            executor_id: null,
          },
          occurredAt: NOW,
          payload: {
            executor: {
              format: 'icarus.collaboration-executor/1',
              principal_id: bob.principalId,
              executor_id: 'executor_bob',
              display_name: 'Bob Executor',
              kind: 'run_once',
              capabilities: [],
              status: 'active',
              registered_at_event: executorEventId,
              revoked_at_event: null,
            },
          },
        });
      },
    });
    const leftEventId = 'evt_bob_left';
    history = await transport.append({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
      identity: bob,
      buildEvent: (current) => {
        const head =
          current.projection.aggregateHeads[`membership:${bob.principalId}`]!;
        return buildCollaborationEventV3({
          groupId: 'group_signed',
          eventId: leftEventId,
          aggregateType: 'membership',
          aggregateId: bob.principalId,
          aggregateRevision: head.revision + 1,
          previousEventHash: head.eventHash,
          eventType: 'member_left',
          actor: {
            principal_id: bob.principalId,
            client_id: bob.clientId,
            credential_id: bob.credentialId,
            executor_id: null,
          },
          occurredAt: NOW,
          payload: {
            reason: 'Leaving the project',
            affected_turn_ids: [],
          },
        });
      },
    });
    const dissolvedAt = '2026-08-06T12:30:00.000Z';
    history = await transport.append({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
      identity: test.identity,
      buildEvent: (current) => {
        const head = current.projection.aggregateHeads['group:group_signed']!;
        return buildCollaborationEventV3({
          groupId: 'group_signed',
          eventId: 'evt_group_dissolved',
          aggregateType: 'group',
          aggregateId: 'group_signed',
          aggregateRevision: head.revision + 1,
          previousEventHash: head.eventHash,
          eventType: 'group_dissolved',
          actor: {
            principal_id: test.identity.principalId,
            client_id: test.identity.clientId,
            credential_id: test.identity.credentialId,
            executor_id: null,
          },
          occurredAt: dissolvedAt,
          payload: { reason: 'Project complete' },
        });
      },
    });

    const showJson = (repositoryFile: string) =>
      JSON.parse(
        run(test.cache, ['git', 'show', `${history.head}:${repositoryFile}`]),
      ) as Record<string, unknown>;
    expect(showJson('group.json')).toMatchObject({
      lifecycle: 'dissolved',
      archived_at: null,
      dissolved_at: dissolvedAt,
    });
    expect(showJson(`members/${bob.principalId}/member.json`)).toMatchObject({
      status: 'left',
    });
    expect(
      showJson(`members/${bob.principalId}/clients/${bob.clientId}.json`),
    ).toMatchObject({ status: 'revoked' });
    expect(
      showJson(
        `members/${bob.principalId}/credentials/${bob.credentialId}.json`,
      ),
    ).toMatchObject({ status: 'revoked', revoked_at_event: leftEventId });
    expect(
      showJson(`members/${bob.principalId}/executors/executor_bob.json`),
    ).toMatchObject({ status: 'revoked', revoked_at_event: leftEventId });
    expect(
      history.eventRecords.map((record) => record.event.event_type),
    ).toEqual([
      'group_initialized',
      'member_registered',
      'executor_registered',
      'member_left',
      'group_dissolved',
    ]);
    const replayed = await transport.inspect({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
    });
    expect(replayed.projection).toEqual(history.projection);
  }, 30_000);

  it('rejects a signed Git replay that dissolves through a non-Group Aggregate', async () => {
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
    const maliciousEvent = buildCollaborationEventV3({
      groupId: 'group_signed',
      eventId: 'evt_wrong_aggregate_dissolve',
      aggregateType: 'membership',
      aggregateId: test.identity.principalId,
      aggregateRevision: 1,
      previousEventHash: null,
      eventType: 'group_dissolved',
      actor: {
        principal_id: test.identity.principalId,
        client_id: test.identity.clientId,
        credential_id: test.identity.credentialId,
        executor_id: null,
      },
      occurredAt: NOW,
      payload: { reason: 'Wrong Aggregate replay' },
    });
    const checkout = path.join(test.root, 'wrong-aggregate');
    run(test.root, ['git', 'clone', '-q', test.remote, checkout]);
    run(checkout, [
      'git',
      'checkout',
      '-q',
      '-b',
      'wrong-aggregate',
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
    const eventPath = collaborationProjectSpaceEventPath(maliciousEvent);
    mkdirSync(path.join(checkout, path.dirname(eventPath)), {
      recursive: true,
    });
    writeFileSync(
      path.join(checkout, eventPath),
      `${JSON.stringify(maliciousEvent, null, 2)}\n`,
    );
    run(checkout, ['git', 'add', eventPath]);
    run(checkout, ['git', 'commit', '-q', '-m', 'wrong aggregate dissolve']);
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
    ).rejects.toThrow(/Group Aggregate/iu);
  }, 30_000);

  it('passes the configured SSH key to the append checkout fetch process', async () => {
    const test = fixture();
    const logPath = path.join(test.root, 'git-wrapper.jsonl');
    const wrapperPath = path.join(test.root, 'git-wrapper.cjs');
    const realGit = run(test.root, ['which', 'git']);
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args: process.argv.slice(2),
  gitSshCommand: process.env.GIT_SSH_COMMAND || null,
}) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
`,
      { mode: 0o700 },
    );
    chmodSync(wrapperPath, 0o700);
    const transport = new CollaborationProjectSpaceGitTransport(wrapperPath);
    const initial = genesis(test.identity);
    const history = await transport.create({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      gitSshKeyPath: test.identity.privateKeyPath,
      identity: test.identity,
      genesisEvent: initial.event,
      genesisProjection: initial.projection,
    });
    writeFileSync(logPath, '');

    await transport.append({
      remoteUrl: test.remote,
      repositoryPath: test.cache,
      previousHead: history.head,
      gitSshKeyPath: test.identity.privateKeyPath,
      identity: test.identity,
      buildEvent: (current) => {
        const head = current.projection.aggregateHeads['group:group_signed']!;
        return buildCollaborationEventV3({
          groupId: 'group_signed',
          eventId: 'evt_transport_key_check',
          aggregateType: 'group',
          aggregateId: 'group_signed',
          aggregateRevision: head.revision + 1,
          previousEventHash: head.eventHash,
          eventType: 'group_settings_updated',
          actor: {
            principal_id: test.identity.principalId,
            client_id: test.identity.clientId,
            credential_id: test.identity.credentialId,
            executor_id: null,
          },
          occurredAt: NOW,
          payload: { name: 'SSH transport checked' },
        });
      },
    });

    const invocations = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            gitSshCommand: string | null;
          },
      );
    const appendFetch = invocations.find(
      ({ args }) =>
        args[0] === 'fetch' && args[1] === '-q' && args.at(-1) === history.head,
    );
    expect(appendFetch?.gitSshCommand).toContain(
      `ssh -i '${test.identity.privateKeyPath}'`,
    );
    expect(appendFetch?.gitSshCommand).toContain('IdentitiesOnly=yes');
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
              credential_id: test.identity.credentialId,
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
    const identities = identityService(test.identity);
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
        gitSshKeyPath: test.identity.privateKeyPath,
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

  it('materializes a Discussion and its initial message in one signed commit', async () => {
    const test = fixture();
    const transport = new CollaborationProjectSpaceGitTransport();
    const store = new CollaborationProjectSpaceStore(
      path.join(test.root, 'collaboration.db'),
    );
    const service = new CollaborationProjectSpaceService(
      store,
      transport,
      path.join(test.root, 'repositories'),
      identityService(test.identity),
      () => Date.parse(NOW),
    );
    try {
      await service.createGroup({
        remoteUrl: test.remote,
        name: 'Signed project',
        gitSshKeyPath: test.identity.privateKeyPath,
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'open',
        observerAccess: 'allowed',
        groupId: 'group_signed',
      });
      const created = await service.createDiscussionWithMessage({
        groupId: 'group_signed',
        threadId: 'thread_atomic',
        messageId: 'message_initial',
        title: 'Atomic review',
        scope: { type: 'group' },
        body: 'The initial review request.',
      });

      const records = store
        .listEventRecords('group_signed')
        .filter((record) => record.event.aggregate_id === 'thread_atomic');
      expect(records).toHaveLength(1);
      expect(records[0]?.event).toMatchObject({
        aggregate_revision: 1,
        event_type: 'discussion_created',
        payload: {
          discussion: { thread_id: 'thread_atomic' },
          message: {
            message_id: 'message_initial',
            body: 'The initial review request.',
          },
        },
      });
      expect(
        created.projection?.discussions.thread_atomic.messages.message_initial,
      ).toMatchObject({ body: 'The initial review request.', revision: 1 });
      expect(
        JSON.parse(
          (
            await transport.readVerifiedFile({
              repositoryPath: created.repositoryPath,
              verifiedHead: created.lastVerifiedHead!,
              repositoryFile: 'discussions/thread_atomic/thread.json',
            })
          ).toString('utf8'),
        ),
      ).toMatchObject({ thread_id: 'thread_atomic', revision: 1 });
      expect(
        JSON.parse(
          (
            await transport.readVerifiedFile({
              repositoryPath: created.repositoryPath,
              verifiedHead: created.lastVerifiedHead!,
              repositoryFile:
                'discussions/thread_atomic/messages/message_initial.json',
            })
          ).toString('utf8'),
        ),
      ).toMatchObject({
        message_id: 'message_initial',
        body: 'The initial review request.',
      });
    } finally {
      store.close();
    }
  }, 30_000);

  it('materializes Workflow Definition lifecycle commits when files stay unchanged', async () => {
    const test = fixture();
    const store = new CollaborationProjectSpaceStore(
      path.join(test.root, 'collaboration.db'),
    );
    const identities = identityService(test.identity);
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
        gitSshKeyPath: test.identity.privateKeyPath,
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

  it('unconditionally rewrites control to one validated Genesis and leaves unrelated refs untouched', async () => {
    const test = fixture();
    const logPath = path.join(test.root, 'git-initialize.jsonl');
    const wrapperPath = path.join(test.root, 'git-initialize.cjs');
    const realGit = run(test.root, ['which', 'git']);
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  env: process.env,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
`,
      { mode: 0o700 },
    );
    chmodSync(wrapperPath, 0o700);
    const storeDirectory = path.join(test.root, 'store');
    const store = new CollaborationProjectSpaceStore(
      path.join(storeDirectory, 'collaboration.db'),
    );
    const identities = new CollaborationProjectSpaceIdentityService(
      storeDirectory,
      test.identity.privateKeyPath,
    );
    const transport = new CollaborationProjectSpaceGitTransport(wrapperPath);
    const service = new CollaborationProjectSpaceService(
      store,
      transport,
      path.join(storeDirectory, 'repositories'),
      identities,
      () => Date.parse(NOW),
    );
    try {
      const old = await service.createGroup({
        remoteUrl: test.remote,
        name: 'Signed project',
        gitSshKeyPath: test.identity.privateKeyPath,
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'approval',
        observerAccess: 'allowed',
        groupId: 'group_signed',
      });
      run(test.remote, [
        'git',
        'update-ref',
        'refs/heads/unrelated',
        old.lastVerifiedHead!,
      ]);
      run(test.remote, [
        'git',
        'update-ref',
        'refs/tags/keep-history',
        old.lastVerifiedHead!,
      ]);
      await service.createWorkItem({
        groupId: old.groupId,
        workItemId: 'confirmation_race',
        type: 'task',
        title: 'Written after confirmation',
      });
      const oldCredentialIds = [
        old.localCredentialId!,
        old.recoveryCredentialId!,
      ];
      for (const credentialId of oldCredentialIds)
        expect(
          existsSync(path.join(identities.credentialDirectory, credentialId)),
        ).toBe(true);
      const competingHead = run(test.remote, [
        'git',
        'rev-parse',
        'refs/heads/icarus/control',
      ]);

      const initialized = await service.initializeGroup(old.groupId);
      const newHead = run(test.remote, [
        'git',
        'rev-parse',
        'refs/heads/icarus/control',
      ]);
      const remoteHistory = await transport.inspect({
        remoteUrl: test.remote,
        repositoryPath: initialized.repositoryPath,
        gitSshKeyPath: test.identity.privateKeyPath,
      });

      expect(initialized.remoteUrl).toBe(old.remoteUrl);
      expect(initialized.groupId).not.toBe(old.groupId);
      expect(initialized.localPrincipalId).not.toBe(old.localPrincipalId);
      expect(initialized.localClientId).not.toBe(old.localClientId);
      expect(initialized.localCredentialId).not.toBe(old.localCredentialId);
      expect(remoteHistory).toMatchObject({
        head: newHead,
        projection: {
          groupId: initialized.groupId,
          workItems: {},
          workflowInstances: {},
          turns: {},
          activity: [
            expect.objectContaining({ eventType: 'group_initialized' }),
          ],
        },
        eventRecords: [
          expect.objectContaining({
            commitHash: newHead,
            commitOrder: 1,
          }),
        ],
      });
      expect(
        run(test.remote, ['git', 'rev-list', '--parents', '-n', '1', newHead]),
      ).toBe(newHead);
      expect(
        run(test.remote, [
          'git',
          'rev-list',
          '--count',
          'refs/heads/icarus/control',
        ]),
      ).toBe('1');
      expect(
        run(test.remote, [
          'git',
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads/icarus',
        ]),
      ).toBe(`refs/heads/icarus/control ${newHead}`);
      expect(
        run(initialized.repositoryPath, [
          'git',
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/heads/icarus',
          'refs/remotes/origin/icarus',
        ]),
      ).toBe(
        [
          `refs/heads/icarus/control ${newHead}`,
          `refs/remotes/origin/icarus/control ${newHead}`,
        ].join('\n'),
      );
      expect(
        run(initialized.repositoryPath, [
          'git',
          'rev-list',
          '--count',
          'icarus/control',
        ]),
      ).toBe('1');
      expect(
        run(test.remote, ['git', 'rev-parse', 'refs/heads/unrelated']),
      ).toBe(old.lastVerifiedHead);
      expect(
        run(test.remote, ['git', 'rev-parse', 'refs/tags/keep-history']),
      ).toBe(old.lastVerifiedHead);
      expect(competingHead).not.toBe(newHead);
      expect(() =>
        execFileSync('git', ['cat-file', '-e', competingHead], {
          cwd: initialized.repositoryPath,
          stdio: 'ignore',
        }),
      ).toThrow();
      const commands = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as string[]);
      expect(commands).toContainEqual([
        'push',
        'origin',
        '+HEAD:refs/heads/icarus/control',
      ]);
      expect(commands.flat()).not.toContain('--force-with-lease');
      for (const credentialId of oldCredentialIds)
        expect(
          existsSync(path.join(identities.credentialDirectory, credentialId)),
        ).toBe(false);
      for (const credentialId of [
        initialized.localCredentialId!,
        initialized.recoveryCredentialId!,
      ])
        expect(
          existsSync(path.join(identities.credentialDirectory, credentialId)),
        ).toBe(true);
      expect(existsSync(test.identity.privateKeyPath)).toBe(true);
    } finally {
      store.close();
    }
  }, 30_000);

  it('preserves the complete old local Group when the Git server rejects force push', async () => {
    const test = fixture();
    const storeDirectory = path.join(test.root, 'rejected-store');
    const store = new CollaborationProjectSpaceStore(
      path.join(storeDirectory, 'collaboration.db'),
    );
    const identities = new CollaborationProjectSpaceIdentityService(
      storeDirectory,
      test.identity.privateKeyPath,
    );
    const service = new CollaborationProjectSpaceService(
      store,
      new CollaborationProjectSpaceGitTransport(),
      path.join(storeDirectory, 'repositories'),
      identities,
      () => Date.parse(NOW),
    );
    try {
      const old = await service.createGroup({
        remoteUrl: test.remote,
        name: 'Protected project',
        gitSshKeyPath: test.identity.privateKeyPath,
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'open',
        observerAccess: 'allowed',
        groupId: 'group_protected',
      });
      await service.createWorkItem({
        groupId: old.groupId,
        workItemId: 'must_survive',
        type: 'task',
        title: 'Must survive rejection',
      });
      const oldHead = store.getGroup(old.groupId)!.lastVerifiedHead!;
      const credentialRoot = identities.credentialDirectory;
      const credentialsBefore = readdirSync(credentialRoot).sort();
      const hooks = path.join(test.remote, 'hooks');
      mkdirSync(hooks, { recursive: true });
      writeFileSync(
        path.join(hooks, 'pre-receive'),
        `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/icarus/control" ] && [ "$old" != "0000000000000000000000000000000000000000" ]; then
    echo "force push prohibited" >&2
    exit 1
  fi
done
exit 0
`,
        { mode: 0o700 },
      );

      await expect(service.initializeGroup(old.groupId)).rejects.toThrow(
        /force push was rejected by the Git server|force push prohibited/u,
      );

      expect(run(test.remote, ['git', 'rev-parse', 'icarus/control'])).toBe(
        oldHead,
      );
      expect(store.getGroup(old.groupId)).toMatchObject({
        groupId: old.groupId,
        lastVerifiedHead: oldHead,
        projection: {
          workItems: { must_survive: expect.any(Object) },
        },
      });
      expect(store.listGroupInitializations()).toEqual([]);
      expect(readdirSync(credentialRoot).sort()).toEqual(credentialsBefore);
      expect(existsSync(test.identity.privateKeyPath)).toBe(true);
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
              credential_id: test.identity.credentialId,
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

  it('rejects a signed details event that rewrites Work Item relations', async () => {
    const test = fixture();
    const transport = new CollaborationProjectSpaceGitTransport();
    const store = new CollaborationProjectSpaceStore(
      path.join(test.root, 'collaboration.db'),
    );
    const identities = identityService(test.identity);
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
        gitSshKeyPath: test.identity.privateKeyPath,
        displayName: 'Alice',
        clientDisplayName: 'Alice MacBook',
        membershipPolicy: 'open',
        observerAccess: 'allowed',
        groupId: 'group_signed',
      });
      await service.createWorkItem({
        groupId: 'group_signed',
        workItemId: 'wi_a',
        type: 'task',
        title: 'A',
      });
      const currentGroup = await service.createWorkItem({
        groupId: 'group_signed',
        workItemId: 'wi_b',
        type: 'task',
        title: 'B',
      });
      const current = await transport.inspect({
        remoteUrl: test.remote,
        repositoryPath: currentGroup.repositoryPath,
      });
      const item = current.projection.workItems.wi_a!;
      const head = current.projection.aggregateHeads['work_item:wi_a']!;
      await expect(
        transport.append({
          remoteUrl: test.remote,
          repositoryPath: currentGroup.repositoryPath,
          previousHead: current.head,
          identity: test.identity,
          buildEvent: () =>
            buildCollaborationEventV3({
              groupId: 'group_signed',
              eventId: 'evt_relation_bypass',
              aggregateType: 'work_item',
              aggregateId: 'wi_a',
              aggregateRevision: head.revision + 1,
              previousEventHash: head.eventHash,
              eventType: 'work_item_details_updated',
              actor: {
                principal_id: test.identity.principalId,
                client_id: test.identity.clientId,
                credential_id: test.identity.credentialId,
                executor_id: null,
              },
              occurredAt: NOW,
              payload: {
                item: {
                  ...item,
                  blocked_by: ['wi_a'],
                  revision: item.revision + 1,
                },
              },
            }),
        }),
      ).rejects.toThrow(/relation|itself/u);
    } finally {
      store.close();
    }
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
