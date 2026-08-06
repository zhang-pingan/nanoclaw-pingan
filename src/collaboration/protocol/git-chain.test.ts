import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { collaborationPrincipalIdFromFingerprint } from '../identity.js';
import {
  collaborationCanonicalHash,
  deterministicProjectionJson,
  loadCollaborationRepositoryDefinition,
  memberDefinitionSchema,
  reduceCollaborationEvent,
  validateCollaborationGitHistory,
  validateRepositoryDefinition,
  type CollaborationEvent,
  type CollaborationProjection,
  type CollaborationRepositoryDefinition,
} from './index.js';

const roots: string[] = [];

function run(cwd: string, args: readonly string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(): {
  readonly root: string;
  readonly key: string;
  readonly publicKey: string;
  readonly fingerprint: string;
  readonly principalId: string;
} {
  const root = mkdtempSync(path.join(os.tmpdir(), 'icarus-git-chain-test-'));
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
  ]).match(/SHA256:[^\s]+/)?.[0];
  if (!fingerprint) throw new Error('temporary SSH fingerprint was not found');
  const repository = path.join(root, 'repository');
  mkdirSync(repository);
  run(repository, ['git', 'init', '-q']);
  run(repository, ['git', 'checkout', '-q', '--orphan', 'icarus/control']);
  run(repository, ['git', 'config', 'user.name', 'Alice']);
  run(repository, ['git', 'config', 'user.email', 'alice@example.test']);
  run(repository, ['git', 'config', 'gpg.format', 'ssh']);
  run(repository, ['git', 'config', 'user.signingkey', key]);
  run(repository, ['git', 'config', 'commit.gpgsign', 'true']);
  return {
    root: repository,
    key,
    publicKey,
    fingerprint,
    principalId: collaborationPrincipalIdFromFingerprint(fingerprint),
  };
}

function definition(
  fingerprint: string,
  principalId: string,
): CollaborationRepositoryDefinition {
  return validateRepositoryDefinition({
    group: {
      format: 'icarus.agent-group/2',
      protocol_version: 2,
      group_id: 'ag_signed',
      name: 'Signed group',
      creator: {
        principal_id: principalId,
        signing_key_ref: `ssh-ed25519:${fingerprint}`,
      },
      control_branch: 'refs/heads/icarus/control',
      machine_ref: 'machine.yaml',
      required_roles: [{ role: 'developer', min_members: 1, max_members: 1 }],
      lifecycle_policy: {
        active_turn_pause: 'drain',
        stalled_turn_recovery: 'creator_command',
      },
    },
    machine: {
      format: 'icarus.agent-group-machine/2',
      initial_state: 'development',
      states: {
        development: {
          label: 'Development',
          owner_role: 'developer',
          terminal: false,
          transitions: [{ outcome: 'completed', target_state: 'completed' }],
        },
        completed: { label: 'Completed', terminal: true, transitions: [] },
      },
    },
    roles: {
      developer: {
        format: 'icarus.agent-group-role/2',
        role: 'developer',
        display_name: 'Developer',
        cardinality: { min: 1, max: 1 },
        required_capabilities: ['coding_task'],
        owned_states: ['development'],
      },
    },
    actions: {},
    implementations: {},
  });
}

function protocolEvent(input: {
  readonly type: CollaborationEvent['event_type'];
  readonly id: string;
  readonly sequence: number;
  readonly revision: number;
  readonly principalId: string;
  readonly agentId?: string;
  readonly payload?: Record<string, unknown>;
}): CollaborationEvent {
  return {
    format: 'icarus.agent-group-event/2',
    protocol_version: 2,
    group_id: 'ag_signed',
    event_id: input.id,
    epoch: 1,
    sequence: input.sequence,
    event_type: input.type,
    actor: {
      principal_id: input.principalId,
      agent_id: input.agentId ?? 'agent_alice',
    },
    expected: { state_revision: input.revision },
    payload: input.payload ?? {},
    occurred_at: '2026-08-05T12:00:00.000Z',
  };
}

function write(repository: string, file: string, contents: string): void {
  const target = path.join(repository, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function appendEvent(
  repository: string,
  event: CollaborationEvent,
  projection: CollaborationProjection,
  materializedFiles: Readonly<Record<string, string>> = {},
): string {
  for (const [file, contents] of Object.entries(materializedFiles))
    write(repository, file, contents);
  write(
    repository,
    `events/${String(event.epoch)}/${String(event.sequence).padStart(8, '0')}-${event.event_id}.json`,
    `${JSON.stringify(event, null, 2)}\n`,
  );
  write(
    repository,
    'projection/state.json',
    deterministicProjectionJson(projection),
  );
  run(repository, ['git', 'add', '.']);
  run(repository, ['git', 'commit', '-q', '-m', event.event_id]);
  return run(repository, ['git', 'rev-parse', 'HEAD']);
}

function dataPayload(path: string, contents: string) {
  return {
    path,
    encoding: 'utf-8',
    content_sha256: `sha256:${crypto
      .createHash('sha256')
      .update(contents, 'utf8')
      .digest('hex')}`,
    size_bytes: Buffer.byteLength(contents, 'utf8'),
    media_type: 'text/plain',
  };
}

async function initializeSignedHistory(principalOverride?: string) {
  const test = fixture();
  const principalId = principalOverride ?? test.principalId;
  const contract = definition(test.fingerprint, principalId);
  write(test.root, 'group.yaml', YAML.stringify(contract.group));
  write(test.root, 'machine.yaml', YAML.stringify(contract.machine));
  write(
    test.root,
    'groups/roles/developer.yaml',
    YAML.stringify(contract.roles.developer),
  );
  const genesis = protocolEvent({
    type: 'group_initialized',
    id: 'evt_genesis',
    sequence: 1,
    revision: 0,
    principalId,
    payload: {
      member: {
        format: 'icarus.agent-group-member/2',
        principal_id: principalId,
        signing_key_ref: `ssh-ed25519:${test.fingerprint}`,
        signing_public_key: test.publicKey,
        agent_id: 'agent_alice',
        capabilities: ['coding_task', 'visible_session'],
        registered_at_event: 'evt_genesis',
      },
      role_claim: {
        format: 'icarus.agent-group-role-claim/2',
        role: 'developer',
        principal_id: principalId,
        agent_id: 'agent_alice',
        claimed_at_event: 'evt_genesis',
      },
    },
  });
  const genesisProjection = reduceCollaborationEvent(null, genesis, contract);
  write(
    test.root,
    `groups/members/${principalId}/agent_alice.json`,
    `${JSON.stringify(genesis.payload.member, null, 2)}\n`,
  );
  write(
    test.root,
    `groups/claims/developer/${principalId}/agent_alice.json`,
    `${JSON.stringify(genesis.payload.role_claim, null, 2)}\n`,
  );
  const genesisHead = appendEvent(test.root, genesis, genesisProjection);
  const materializedContract = await loadCollaborationRepositoryDefinition(
    test.root,
    genesisHead,
  );
  expect(materializedContract).toEqual(contract);
  const materializedGenesisProjection = reduceCollaborationEvent(
    null,
    genesis,
    materializedContract,
  );
  expect(materializedGenesisProjection).toEqual(genesisProjection);
  return {
    ...test,
    principalId,
    contract: materializedContract,
    genesisProjection: materializedGenesisProjection,
    genesisHead,
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('signed Git collaboration history', () => {
  it('quarantines a Handoff reference that is absent from the signed tree', async () => {
    const test = await initializeSignedHistory();
    const implementation = {
      format: 'icarus.agent-group-state-implementation/2' as const,
      role: 'developer',
      state_id: 'development',
      owner: {
        principal_id: test.principalId,
        agent_id: 'agent_alice',
      },
      mode: 'manual' as const,
      action_ref: null,
      published_at_event: 'evt_implementation',
    };
    const implementationEvent = protocolEvent({
      type: 'state_implementation_published',
      id: 'evt_implementation',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: {
        implementation,
        implementation_ref: 'groups/implementations/developer/development.yaml',
        implementation_hash: collaborationCanonicalHash(implementation),
        action: null,
        action_hash: null,
        prompt_hash: null,
      },
    });
    const ready = reduceCollaborationEvent(
      test.genesisProjection,
      implementationEvent,
      test.contract,
    );
    appendEvent(test.root, implementationEvent, ready, {
      'groups/implementations/developer/development.yaml':
        YAML.stringify(implementation),
    });
    const handoff = {
      format: 'icarus.agent-group-handoff/2' as const,
      source_turn_id: 'turn_initial',
      outcome: 'initial',
      summary: 'Start with a missing reference.',
      instruction: '',
      markers: [],
      data_refs: ['data/missing.json'],
      artifact_refs: [],
      data: {},
    };
    const startedEvent = protocolEvent({
      type: 'group_started',
      id: 'evt_started',
      sequence: 3,
      revision: 2,
      principalId: test.principalId,
      payload: {
        initial_handoff: handoff,
        initial_handoff_hash: collaborationCanonicalHash(handoff),
      },
    });
    const started = reduceCollaborationEvent(
      ready,
      startedEvent,
      test.contract,
    );
    const head = appendEvent(test.root, startedEvent, started);

    await expect(
      validateCollaborationGitHistory({ repositoryPath: test.root, head }),
    ).rejects.toThrow(/Handoff reference is not a verified regular file/);
  });

  it('verifies SSH commit signatures and deterministic materialization', async () => {
    const test = await initializeSignedHistory();
    const start = protocolEvent({
      type: 'data_updated',
      id: 'evt_start',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/start.txt', 'start\n'),
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      start,
      test.contract,
    );
    const head = appendEvent(test.root, start, projection, {
      'data/start.txt': 'start\n',
    });
    const history = await validateCollaborationGitHistory({
      repositoryPath: test.root,
      head,
      previousHead: test.genesisHead,
    });
    expect(history.events.map((candidate) => candidate.event_id)).toEqual([
      'evt_genesis',
      'evt_start',
    ]);
    expect(history.projection.lifecycle).toBe('FORMING');
  });

  it('validates only the signed suffix after a long-history checkpoint', async () => {
    const test = await initializeSignedHistory();
    let projection = test.genesisProjection;
    let head = test.genesisHead;
    for (let sequence = 2; sequence <= 24; sequence += 1) {
      const contents = `history ${String(sequence)}\n`;
      const next = protocolEvent({
        type: 'data_updated',
        id: `evt_data_${String(sequence)}`,
        sequence,
        revision: sequence - 1,
        principalId: test.principalId,
        payload: dataPayload('data/history.txt', contents),
      });
      projection = reduceCollaborationEvent(projection, next, test.contract);
      head = appendEvent(test.root, next, projection, {
        'data/history.txt': contents,
      });
    }
    const full = await validateCollaborationGitHistory({
      repositoryPath: test.root,
      head,
    });
    const tailContents = 'history tail\n';
    const tail = protocolEvent({
      type: 'data_updated',
      id: 'evt_data_tail',
      sequence: 25,
      revision: 24,
      principalId: test.principalId,
      payload: dataPayload('data/history.txt', tailContents),
    });
    projection = reduceCollaborationEvent(projection, tail, test.contract);
    const tailHead = appendEvent(test.root, tail, projection, {
      'data/history.txt': tailContents,
    });

    const incremental = await validateCollaborationGitHistory({
      repositoryPath: test.root,
      head: tailHead,
      previousHead: head,
      checkpoint: {
        head,
        projection: full.projection,
      },
    });

    expect(full.validation).toMatchObject({
      mode: 'full',
      validatedCommitCount: 24,
    });
    expect(incremental.validation).toMatchObject({
      mode: 'incremental',
      validatedCommitCount: 1,
      totalSequence: 25,
      checkpointHead: head,
    });
    expect(incremental.commits).toEqual([tailHead]);
    expect(incremental.events.map((event) => event.event_id)).toEqual([
      'evt_data_tail',
    ]);
    expect(incremental.projection).toEqual(projection);
  }, 30_000);

  it('falls back to full replay when a local checkpoint is inconsistent', async () => {
    const test = await initializeSignedHistory();
    const history = await validateCollaborationGitHistory({
      repositoryPath: test.root,
      head: test.genesisHead,
      previousHead: test.genesisHead,
      checkpoint: {
        head: test.genesisHead,
        projection: {
          ...test.genesisProjection,
          businessState: 'corrupted-local-cache',
        },
      },
    });

    expect(history.validation).toMatchObject({
      mode: 'full',
      validatedCommitCount: 1,
      checkpointHead: null,
    });
    expect(history.projection).toEqual(test.genesisProjection);
  });

  it('rejects an unsigned suffix when validating incrementally', async () => {
    const test = await initializeSignedHistory();
    const checkpoint = await validateCollaborationGitHistory({
      repositoryPath: test.root,
      head: test.genesisHead,
    });
    run(test.root, ['git', 'config', 'commit.gpgsign', 'false']);
    const next = protocolEvent({
      type: 'data_updated',
      id: 'evt_unsigned_suffix',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/unsigned.txt', 'unsigned\n'),
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      next,
      test.contract,
    );
    const head = appendEvent(test.root, next, projection, {
      'data/unsigned.txt': 'unsigned\n',
    });

    await expect(
      validateCollaborationGitHistory({
        repositoryPath: test.root,
        head,
        previousHead: test.genesisHead,
        checkpoint: {
          head: test.genesisHead,
          projection: checkpoint.projection,
        },
      }),
    ).rejects.toThrow(/signature is invalid/);
  });

  it('quarantines an unsigned commit even when its author name is forged', async () => {
    const test = await initializeSignedHistory();
    run(test.root, ['git', 'config', 'commit.gpgsign', 'false']);
    const start = protocolEvent({
      type: 'data_updated',
      id: 'evt_unsigned',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/unsigned-forged.txt', 'unsigned\n'),
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      start,
      test.contract,
    );
    const head = appendEvent(test.root, start, projection, {
      'data/unsigned-forged.txt': 'unsigned\n',
    });
    await expect(
      validateCollaborationGitHistory({ repositoryPath: test.root, head }),
    ).rejects.toThrow(/signature is invalid/);
  });

  it('detects remote history rewrites relative to the prior accepted head', async () => {
    const test = await initializeSignedHistory();
    const first = protocolEvent({
      type: 'data_updated',
      id: 'evt_first',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/first.txt', 'first\n'),
    });
    const firstProjection = reduceCollaborationEvent(
      test.genesisProjection,
      first,
      test.contract,
    );
    const previousHead = appendEvent(test.root, first, firstProjection, {
      'data/first.txt': 'first\n',
    });
    run(test.root, ['git', 'checkout', '-q', '--detach', test.genesisHead]);
    const replacement = protocolEvent({
      type: 'data_updated',
      id: 'evt_replacement',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/replacement.txt', 'replacement\n'),
    });
    const replacementProjection = reduceCollaborationEvent(
      test.genesisProjection,
      replacement,
      test.contract,
    );
    const rewrittenHead = appendEvent(
      test.root,
      replacement,
      replacementProjection,
      { 'data/replacement.txt': 'replacement\n' },
    );
    await expect(
      validateCollaborationGitHistory({
        repositoryPath: test.root,
        head: rewrittenHead,
        previousHead,
      }),
    ).rejects.toThrow(/history was rewritten/);
  });

  it('quarantines a projection that disagrees with replay', async () => {
    const test = await initializeSignedHistory();
    const start = protocolEvent({
      type: 'data_updated',
      id: 'evt_bad_projection',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/projection.txt', 'projection\n'),
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      start,
      test.contract,
    );
    const head = appendEvent(
      test.root,
      start,
      { ...projection, businessState: 'forged-state' },
      { 'data/projection.txt': 'projection\n' },
    );
    await expect(
      validateCollaborationGitHistory({ repositoryPath: test.root, head }),
    ).rejects.toThrow(/materialized projection/);
  });

  it('quarantines data whose materialized blob disagrees with its event hash', async () => {
    const test = await initializeSignedHistory();
    const next = protocolEvent({
      type: 'data_updated',
      id: 'evt_bad_data_hash',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/result.txt', 'declared\n'),
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      next,
      test.contract,
    );
    const head = appendEvent(test.root, next, projection, {
      'data/result.txt': 'materialized\n',
    });

    await expect(
      validateCollaborationGitHistory({
        repositoryPath: test.root,
        head,
        previousHead: test.genesisHead,
        checkpoint: {
          head: test.genesisHead,
          projection: test.genesisProjection,
        },
      }),
    ).rejects.toThrow(/does not match event hash and size/);
  });

  it('quarantines a signed data update materialized as a symbolic link', async () => {
    const test = await initializeSignedHistory();
    const linkTarget = '../../outside-collaboration.txt';
    const next = protocolEvent({
      type: 'data_updated',
      id: 'evt_data_symlink',
      sequence: 2,
      revision: 1,
      principalId: test.principalId,
      payload: dataPayload('data/link.txt', linkTarget),
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      next,
      test.contract,
    );
    mkdirSync(path.join(test.root, 'data'), { recursive: true });
    symlinkSync(linkTarget, path.join(test.root, 'data/link.txt'));
    const head = appendEvent(test.root, next, projection);

    await expect(
      validateCollaborationGitHistory({
        repositoryPath: test.root,
        head,
        previousHead: test.genesisHead,
        checkpoint: {
          head: test.genesisHead,
          projection: test.genesisProjection,
        },
      }),
    ).rejects.toThrow(/regular file/);
  });

  it('quarantines merge commits instead of accepting a non-linear event DAG', async () => {
    const test = await initializeSignedHistory();
    run(test.root, ['git', 'checkout', '-q', '-b', 'left']);
    write(test.root, 'left.txt', 'left\n');
    run(test.root, ['git', 'add', 'left.txt']);
    run(test.root, ['git', 'commit', '-q', '-m', 'left']);
    run(test.root, ['git', 'checkout', '-q', '-b', 'right', test.genesisHead]);
    write(test.root, 'right.txt', 'right\n');
    run(test.root, ['git', 'add', 'right.txt']);
    run(test.root, ['git', 'commit', '-q', '-m', 'right']);
    run(test.root, ['git', 'merge', '-q', '--no-ff', 'left', '-m', 'merge']);
    const head = run(test.root, ['git', 'rev-parse', 'HEAD']);

    await expect(
      validateCollaborationGitHistory({
        repositoryPath: test.root,
        head,
        previousHead: test.genesisHead,
        checkpoint: {
          head: test.genesisHead,
          projection: test.genesisProjection,
        },
      }),
    ).rejects.toThrow(/linear single-parent chain/);
  });

  it.each([
    ['member', 'groups/members'],
    ['role claim', 'groups/claims/developer'],
  ])('quarantines a forged materialized %s', async (_label, prefix) => {
    const test = await initializeSignedHistory();
    const file = `${prefix}/${test.principalId}/agent_alice.json`;
    const materialized = JSON.parse(
      readFileSync(path.join(test.root, file), 'utf8'),
    ) as Record<string, unknown>;
    materialized.agent_id = 'agent_forged';
    write(test.root, file, `${JSON.stringify(materialized, null, 2)}\n`);
    run(test.root, ['git', 'add', file]);
    run(test.root, ['git', 'commit', '--amend', '-q', '--no-edit']);
    const head = run(test.root, ['git', 'rev-parse', 'HEAD']);

    await expect(
      validateCollaborationGitHistory({ repositoryPath: test.root, head }),
    ).rejects.toThrow(/does not match event replay/);
  });

  it('quarantines a Principal id that is not derived from the signing key', async () => {
    const test = await initializeSignedHistory('forged_principal');

    await expect(
      validateCollaborationGitHistory({
        repositoryPath: test.root,
        head: test.genesisHead,
      }),
    ).rejects.toThrow(/not derived from its SSH fingerprint/);
  });
});

describe('member signing key schema', () => {
  it('rejects an allowed-signers newline injection', () => {
    const test = fixture();
    const member = {
      format: 'icarus.agent-group-member/2',
      principal_id: 'alice',
      signing_key_ref: `ssh-ed25519:${test.fingerprint}`,
      signing_public_key: `${test.publicKey}\nmallory ${test.publicKey}`,
      agent_id: 'agent_alice',
      capabilities: ['coding_task'],
      registered_at_event: 'evt_genesis',
    };

    expect(() => memberDefinitionSchema.parse(member)).toThrow(
      /Invalid string|must match pattern/,
    );
  });
});
