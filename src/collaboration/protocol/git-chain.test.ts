import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deterministicProjectionJson,
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
  return { root: repository, key, publicKey, fingerprint };
}

function definition(fingerprint: string): CollaborationRepositoryDefinition {
  return validateRepositoryDefinition({
    group: {
      format: 'icarus.agent-group/1',
      protocol_version: 1,
      group_id: 'ag_signed',
      name: 'Signed group',
      creator: {
        principal_id: 'alice',
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
      format: 'icarus.agent-group-machine/1',
      initial_state: 'development',
      states: {
        development: {
          terminal: false,
          transitions: [
            {
              id: 'implement',
              actor_role: 'developer',
              action_ref: 'actions/implement.yaml',
              outcomes: { succeeded: 'completed' },
            },
          ],
        },
        completed: { terminal: true, transitions: [] },
      },
    },
    roles: {
      developer: {
        format: 'icarus.agent-group-role/1',
        role: 'developer',
        display_name: 'Developer',
        cardinality: { min: 1, max: 1 },
        allowed_transitions: ['implement'],
        executor_requirements: {
          capability: 'coding_task',
          interaction: 'visible_session',
        },
      },
    },
    actions: {
      implement: {
        format: 'icarus.agent-group-action/1',
        action_id: 'implement',
        kind: 'external',
        adapter: 'codex-task',
        input: { prompt_ref: 'prompts/implement.md' },
        requirements: {
          capability: 'coding_task',
          interaction: 'visible_session',
          filesystem_access: 'workspace_write',
        },
        result_schema: { ref: 'code-change-result@1' },
      },
    },
  });
}

function protocolEvent(input: {
  readonly type: CollaborationEvent['event_type'];
  readonly id: string;
  readonly sequence: number;
  readonly revision: number;
  readonly payload?: Record<string, unknown>;
}): CollaborationEvent {
  return {
    format: 'icarus.agent-group-event/1',
    protocol_version: 1,
    group_id: 'ag_signed',
    event_id: input.id,
    epoch: 1,
    sequence: input.sequence,
    event_type: input.type,
    actor: { principal_id: 'alice', agent_id: 'agent_alice' },
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
): string {
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

function initializeSignedHistory() {
  const test = fixture();
  const contract = definition(test.fingerprint);
  write(test.root, 'group.yaml', YAML.stringify(contract.group));
  write(test.root, 'machine.yaml', YAML.stringify(contract.machine));
  write(
    test.root,
    'groups/roles/developer.yaml',
    YAML.stringify(contract.roles.developer),
  );
  write(
    test.root,
    'actions/implement.yaml',
    YAML.stringify(contract.actions.implement),
  );
  write(test.root, 'prompts/implement.md', 'Implement the requested change.\n');
  const genesis = protocolEvent({
    type: 'group_initialized',
    id: 'evt_genesis',
    sequence: 1,
    revision: 0,
    payload: {
      member: {
        format: 'icarus.agent-group-member/1',
        principal_id: 'alice',
        signing_key_ref: `ssh-ed25519:${test.fingerprint}`,
        signing_public_key: test.publicKey,
        agent_id: 'agent_alice',
        capabilities: ['coding_task', 'visible_session'],
        registered_at_event: 'evt_genesis',
      },
      role_claim: {
        format: 'icarus.agent-group-role-claim/1',
        role: 'developer',
        principal_id: 'alice',
        agent_id: 'agent_alice',
        claimed_at_event: 'evt_genesis',
      },
    },
  });
  const genesisProjection = reduceCollaborationEvent(null, genesis, contract);
  const genesisHead = appendEvent(test.root, genesis, genesisProjection);
  return { ...test, contract, genesisProjection, genesisHead };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('signed Git collaboration history', () => {
  it('verifies SSH commit signatures and deterministic materialization', async () => {
    const test = initializeSignedHistory();
    const start = protocolEvent({
      type: 'group_started',
      id: 'evt_start',
      sequence: 2,
      revision: 1,
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      start,
      test.contract,
    );
    const head = appendEvent(test.root, start, projection);
    const history = await validateCollaborationGitHistory({
      repositoryPath: test.root,
      head,
      previousHead: test.genesisHead,
    });
    expect(history.events.map((candidate) => candidate.event_id)).toEqual([
      'evt_genesis',
      'evt_start',
    ]);
    expect(history.projection.lifecycle).toBe('RUNNING');
  });

  it('quarantines an unsigned commit even when its author name is forged', async () => {
    const test = initializeSignedHistory();
    run(test.root, ['git', 'config', 'commit.gpgsign', 'false']);
    const start = protocolEvent({
      type: 'group_started',
      id: 'evt_unsigned',
      sequence: 2,
      revision: 1,
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      start,
      test.contract,
    );
    const head = appendEvent(test.root, start, projection);
    await expect(
      validateCollaborationGitHistory({ repositoryPath: test.root, head }),
    ).rejects.toThrow(/signature is invalid/);
  });

  it('detects remote history rewrites relative to the prior accepted head', async () => {
    const test = initializeSignedHistory();
    const first = protocolEvent({
      type: 'group_started',
      id: 'evt_first',
      sequence: 2,
      revision: 1,
    });
    const firstProjection = reduceCollaborationEvent(
      test.genesisProjection,
      first,
      test.contract,
    );
    const previousHead = appendEvent(test.root, first, firstProjection);
    run(test.root, ['git', 'checkout', '-q', '--detach', test.genesisHead]);
    const replacement = protocolEvent({
      type: 'group_started',
      id: 'evt_replacement',
      sequence: 2,
      revision: 1,
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
    const test = initializeSignedHistory();
    const start = protocolEvent({
      type: 'group_started',
      id: 'evt_bad_projection',
      sequence: 2,
      revision: 1,
    });
    const projection = reduceCollaborationEvent(
      test.genesisProjection,
      start,
      test.contract,
    );
    const head = appendEvent(test.root, start, {
      ...projection,
      businessState: 'forged-state',
    });
    await expect(
      validateCollaborationGitHistory({ repositoryPath: test.root, head }),
    ).rejects.toThrow(/materialized projection/);
  });
});
