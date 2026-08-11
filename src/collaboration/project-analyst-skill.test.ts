import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildProjectAnalystCapabilityFiles } from './analysis-capability.js';
import { PROJECT_ANALYST_CAPABILITY_STATIC_FILES } from './analysis-capability-resources.generated.js';
import type { CollaborationAnalysisInput } from './analysis-contracts.js';
import { CollaborationProjectSpaceGitTransport } from './project-space-git.js';
import {
  CollaborationProjectSpaceIdentityService,
  type CollaborationEventSigningIdentity,
} from './project-space-identity.js';
import { CollaborationProjectSpaceService } from './project-space-service.js';
import { CollaborationProjectSpaceStore } from './project-space-store.js';
import { collaborationCanonicalHashV3 } from './protocol/v3-reducer.js';

const roots: string[] = [];
const NOW = '2026-08-09T12:00:00.000Z';
const skillRoot = path.resolve(process.cwd(), 'project-analyst');
const repositoryCli = path.join(skillRoot, 'scripts/repository-context.mjs');
const resultValidator = path.join(skillRoot, 'scripts/validate-result.mjs');
let fixtureRoot = '';
let remote = '';
let principalId = '';
const idlePrincipalId = 'principal_00000000-0000-4000-8000-000000000002';
let validHead = '';

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function run(cwd: string, args: readonly string[]): string {
  return execFileSync(args[0]!, args.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

function invoke(
  script: string,
  args: readonly string[],
  cwd = temporaryRoot('icarus-analyst-cwd-'),
) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
  });
}

function json(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function buildContext(
  repository: string,
  scope: string,
  extra: readonly string[] = [],
) {
  const output = temporaryRoot('icarus-analyst-output-');
  const result = invoke(repositoryCli, [
    '--repository',
    repository,
    '--scope',
    scope,
    '--output',
    output,
    '--now',
    NOW,
    ...extra,
  ]);
  return { output, result };
}

beforeAll(async () => {
  fixtureRoot = temporaryRoot('icarus-analyst-fixture-');
  const key = path.join(fixtureRoot, 'signing-key');
  run(fixtureRoot, ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key]);
  const publicKey = readFileSync(`${key}.pub`, 'utf8').trim();
  const fingerprint = run(fixtureRoot, [
    'ssh-keygen',
    '-lf',
    `${key}.pub`,
    '-E',
    'sha256',
  ]).match(/SHA256:[^\s]+/u)?.[0];
  if (!fingerprint) throw new Error('SSH fingerprint missing');
  principalId = 'principal_00000000-0000-4000-8000-000000000001';
  const identity: CollaborationEventSigningIdentity = {
    principalId,
    clientId: 'client_analyst_fixture',
    credentialId: 'credential_analyst_fixture',
    privateKeyPath: key,
    publicKey,
    fingerprint,
    purpose: 'event_signing',
  };
  remote = path.join(fixtureRoot, 'remote.git');
  mkdirSync(remote);
  run(remote, ['git', 'init', '-q', '--bare']);
  const store = new CollaborationProjectSpaceStore(
    path.join(fixtureRoot, 'collaboration.db'),
  );
  const service = new CollaborationProjectSpaceService(
    store,
    new CollaborationProjectSpaceGitTransport(),
    path.join(fixtureRoot, 'repositories'),
    identityService(identity),
    () => Date.parse(NOW),
  );
  try {
    await service.createGroup({
      remoteUrl: remote,
      name: 'Analyst fixture',
      gitSshKeyPath: key,
      displayName: 'Alice',
      clientDisplayName: 'Alice test client',
      membershipPolicy: 'open',
      observerAccess: 'allowed',
      groupId: 'group_analyst_fixture',
    });
    const group = await service.createWorkItem({
      groupId: 'group_analyst_fixture',
      workItemId: 'wi_release',
      type: 'task',
      title: 'Ship the release',
      priority: 'high',
      dueAt: '2026-08-08T12:00:00.000Z',
      acceptanceCriteria: ['Attach release evidence'],
    });
    validHead = group.lastVerifiedHead!;
    const idleKey = path.join(fixtureRoot, 'idle-signing-key');
    run(fixtureRoot, [
      'ssh-keygen',
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-f',
      idleKey,
    ]);
    const idlePublicKey = readFileSync(`${idleKey}.pub`, 'utf8').trim();
    const idleFingerprint = run(fixtureRoot, [
      'ssh-keygen',
      '-lf',
      `${idleKey}.pub`,
      '-E',
      'sha256',
    ]).match(/SHA256:[^\s]+/u)?.[0];
    if (!idleFingerprint) throw new Error('Idle SSH fingerprint missing');
    const idleStore = new CollaborationProjectSpaceStore(
      path.join(fixtureRoot, 'idle-collaboration.db'),
    );
    const idleService = new CollaborationProjectSpaceService(
      idleStore,
      new CollaborationProjectSpaceGitTransport(),
      path.join(fixtureRoot, 'idle-repositories'),
      identityService({
        principalId: idlePrincipalId,
        clientId: 'client_idle_fixture',
        credentialId: 'credential_idle_fixture',
        privateKeyPath: idleKey,
        publicKey: idlePublicKey,
        fingerprint: idleFingerprint,
        purpose: 'event_signing',
      }),
      () => Date.parse(NOW),
    );
    try {
      const joined = await idleService.joinGroup({
        remoteUrl: remote,
        gitSshKeyPath: idleKey,
        displayName: 'Idle member',
        clientDisplayName: 'Idle test client',
      });
      expect(joined.lastVerifiedHead).toBeTruthy();
      const notified = await service.sendMemberNotification({
        groupId: group.groupId,
        notificationId: 'notification_analyst_fixture',
        recipientPrincipalIds: [idlePrincipalId],
        bodyMarkdown: 'Review the **release analysis**.',
        scope: { type: 'group', ref: group.groupId },
      });
      validHead = notified.lastVerifiedHead!;
    } finally {
      idleStore.close();
    }
  } finally {
    store.close();
  }
}, 30_000);

afterAll(() => {
  for (const root of roots.splice(0).reverse())
    rmSync(root, { recursive: true, force: true });
});

describe('project-analyst complete Skill', () => {
  it('keeps Host package capability files byte-aligned with the checked-in Skill', () => {
    const capability = buildProjectAnalystCapabilityFiles({
      resourceCatalog: { 'group:group_analyst_fixture': {} },
    });
    for (const expected of PROJECT_ANALYST_CAPABILITY_STATIC_FILES) {
      const actual = capability.find((file) => file.path === expected.path);
      expect(actual?.contents).toBe(
        readFileSync(path.join(skillRoot, expected.path), 'utf8'),
      );
    }
    expect(capability.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'contracts/analysis-result.schema.json',
        'contracts/repository-analysis-result.schema.json',
        'resources/catalog.json',
      ]),
    );
  });

  it('builds a self-consistent local context and upgrades only with a trusted anchor', () => {
    const first = buildContext(remote, 'project');
    expect(first.result.status).toBe(0);
    expect(json(path.join(first.output, 'verification.json'))).toMatchObject({
      level: 'self_consistent',
      repository_identity: 'not_externally_anchored',
      repository_head: validHead,
      checks: {
        complete_history_validation: 'passed',
        commit_signatures_and_actor_credentials: 'passed',
        reducer_replay: 'passed',
        materialized_projection: 'passed',
      },
    });
    const context = json(path.join(first.output, 'context.json'));
    expect(context).toMatchObject({
      format: 'icarus.collaboration-repository-analysis-input/1',
      repository: { repository_head: validHead },
      scope: { type: 'project' },
    });
    expect(context.resource_index).toContain('work_item:wi_release');
    expect(context.resource_index).toContain(
      'notification:notification_analyst_fixture',
    );
    expect(context.rule_signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule_id: 'work_item_overdue' }),
      ]),
    );

    const anchored = buildContext(remote, 'project', [
      '--trusted-head',
      validHead,
    ]);
    expect(anchored.result.status).toBe(0);
    expect(json(path.join(anchored.output, 'verification.json'))).toMatchObject(
      {
        level: 'verified',
        repository_identity: 'trusted_input_match',
        trusted_head: validHead,
      },
    );
  });

  it('supports a Git URL, mine scope, work-item scope, and principal validation', () => {
    const mine = buildContext(pathToFileURL(remote).href, 'mine', [
      '--principal-id',
      principalId,
    ]);
    expect(mine.result.status).toBe(0);
    const mineContext = json(path.join(mine.output, 'context.json'));
    expect(mineContext.repository.source_kind).toBe('git_url');
    expect(mineContext.current_principal_id).toBe(principalId);
    expect(mineContext.resource_index).toEqual(
      expect.arrayContaining([
        'group:group_analyst_fixture',
        `principal:${principalId}`,
        'work_item:wi_release',
      ]),
    );

    const item = buildContext(remote, 'work_item:wi_release');
    expect(item.result.status).toBe(0);
    expect(json(path.join(item.output, 'context.json')).resource_index).toEqual(
      expect.arrayContaining([
        'group:group_analyst_fixture',
        `principal:${principalId}`,
        'work_item:wi_release',
      ]),
    );

    const invalid = buildContext(remote, 'mine', [
      '--principal-id',
      'principal_missing',
    ]);
    expect(invalid.result.status).not.toBe(0);
    expect(invalid.result.stderr).toMatch(/Principal is not present/u);

    const idle = buildContext(remote, 'mine', [
      '--principal-id',
      idlePrincipalId,
    ]);
    expect(idle.result.status).toBe(0);
    expect(json(path.join(idle.output, 'context.json'))).toMatchObject({
      current_principal_id: idlePrincipalId,
      my_items: [],
      resource_index: [
        'group:group_analyst_fixture',
        `principal:${idlePrincipalId}`,
      ],
    });
    expect(
      json(path.join(idle.output, 'resources/catalog.json')),
    ).toHaveProperty(`principal:${idlePrincipalId}`);
  });

  it('uses the shared delta resource closure and rejects an unknown base', () => {
    const genesis = run(fixtureRoot, [
      'git',
      '-C',
      remote,
      'rev-list',
      '--max-parents=0',
      validHead,
    ]);
    const delta = buildContext(remote, `delta:${genesis}`);
    expect(delta.result.status).toBe(0);
    const changedEventCount = run(fixtureRoot, [
      'git',
      '-C',
      remote,
      'diff',
      '--name-only',
      genesis,
      validHead,
      '--',
      'events',
    ])
      .split('\n')
      .filter(
        (repositoryPath) =>
          repositoryPath.startsWith('events/') &&
          !repositoryPath.startsWith('events/batches/') &&
          repositoryPath.endsWith('.json'),
      ).length;
    expect(json(path.join(delta.output, 'context.json'))).toMatchObject({
      scope: { type: 'delta', since_snapshot_head: genesis },
      change_range: {
        since_snapshot_head: genesis,
        repository_head: validHead,
        event_count: changedEventCount,
        changed_refs: expect.arrayContaining(['work_item:wi_release']),
      },
      resource_index: expect.arrayContaining([
        'group:group_analyst_fixture',
        `principal:${principalId}`,
        'work_item:wi_release',
      ]),
    });

    const invalid = buildContext(remote, `delta:${'f'.repeat(40)}`);
    expect(invalid.result.status).not.toBe(0);
    expect(invalid.result.stderr).toMatch(/base commit in the validated/u);
  });

  it('fails closed for a wrong ref and mismatched trusted head', () => {
    const wrongRef = buildContext(remote, 'project', [
      '--ref',
      'refs/heads/not-control',
    ]);
    expect(wrongRef.result.status).not.toBe(0);
    expect(wrongRef.result.stderr).toMatch(/Git ref not found/u);

    const wrongAnchor = buildContext(remote, 'project', [
      '--trusted-head',
      'f'.repeat(40),
    ]);
    expect(wrongAnchor.result.status).not.toBe(0);
    expect(wrongAnchor.result.stderr).toMatch(/Trusted head mismatch/u);

    const unknown = buildContext(remote, 'project', ['--unknown', 'value']);
    expect(unknown.result.status).not.toBe(0);
    expect(unknown.result.stderr).toMatch(/Unknown option/u);
  });

  it('refuses to write analysis output inside the local Group repository', () => {
    for (const [index, repository] of [
      remote,
      pathToFileURL(remote).href,
    ].entries()) {
      const output = path.join(remote, `analysis-output-${String(index)}`);
      const result = invoke(repositoryCli, [
        '--repository',
        repository,
        '--scope',
        'project',
        '--output',
        output,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/outside the local Group repository/u);
      expect(existsSync(output)).toBe(false);
    }
  });

  it('isolates local Git config and rejects replacement and graft state', () => {
    const cloneRepository = (name: string): string => {
      const clone = path.join(temporaryRoot(`icarus-${name}-`), 'repository');
      run(process.cwd(), [
        'git',
        'clone',
        '-q',
        '--branch',
        'icarus/control',
        remote,
        clone,
      ]);
      run(clone, ['git', 'config', 'user.name', 'Security test']);
      run(clone, ['git', 'config', 'user.email', 'security@example.invalid']);
      return clone;
    };

    const configClone = cloneRepository('malicious-config');
    const marker = path.join(fixtureRoot, 'malicious-gpg-program-ran');
    const maliciousProgram = path.join(fixtureRoot, 'malicious-gpg-program');
    writeFileSync(maliciousProgram, `#!/bin/sh\ntouch '${marker}'\nexit 97\n`);
    chmodSync(maliciousProgram, 0o755);
    run(configClone, ['git', 'config', 'gpg.ssh.program', maliciousProgram]);
    expect(buildContext(configClone, 'project').result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);

    const replacementClone = cloneRepository('replacement');
    const groupPath = path.join(replacementClone, 'group.json');
    const group = json(groupPath);
    group.name = 'Replacement-controlled content';
    writeFileSync(groupPath, `${JSON.stringify(group, null, 2)}\n`);
    run(replacementClone, ['git', 'add', 'group.json']);
    run(replacementClone, ['git', 'commit', '-q', '-m', 'replacement body']);
    const replacementCommit = run(replacementClone, [
      'git',
      'rev-parse',
      'HEAD',
    ]);
    run(replacementClone, [
      'git',
      'update-ref',
      'refs/heads/icarus/control',
      validHead,
    ]);
    run(replacementClone, ['git', 'replace', validHead, replacementCommit]);
    expect(
      run(replacementClone, ['git', 'rev-parse', 'refs/heads/icarus/control']),
    ).toBe(validHead);
    expect(
      JSON.parse(
        run(replacementClone, ['git', 'show', `${validHead}:group.json`]),
      ).name,
    ).toBe('Replacement-controlled content');
    const replacement = buildContext(replacementClone, 'project', [
      '--trusted-head',
      validHead,
    ]);
    expect(replacement.result.status).not.toBe(0);
    expect(replacement.result.stderr).toMatch(/replacement refs/iu);

    const graftClone = cloneRepository('graft');
    const commonDirectory = run(graftClone, [
      'git',
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    mkdirSync(path.join(commonDirectory, 'info'), { recursive: true });
    writeFileSync(
      path.join(commonDirectory, 'info', 'grafts'),
      `${validHead} ${run(graftClone, ['git', 'rev-parse', `${validHead}^`])}\n`,
    );
    const graft = buildContext(graftClone, 'project');
    expect(graft.result.status).not.toBe(0);
    expect(graft.result.stderr).toMatch(/graft state/iu);
  });

  it('rejects managed output symlinks before force can touch their targets', () => {
    const output = temporaryRoot('icarus-output-symlink-');
    const outputContext = path.join(output, 'context.json');
    const sourceCatalog = path.join(remote, 'catalog.json');
    writeFileSync(outputContext, 'output must remain unchanged\n');
    writeFileSync(sourceCatalog, 'source must remain unchanged\n');
    symlinkSync(remote, path.join(output, 'resources'), 'dir');
    const result = invoke(repositoryCli, [
      '--repository',
      remote,
      '--scope',
      'project',
      '--output',
      output,
      '--force',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/symbolic link/iu);
    expect(readFileSync(outputContext, 'utf8')).toBe(
      'output must remain unchanged\n',
    );
    expect(readFileSync(sourceCatalog, 'utf8')).toBe(
      'source must remain unchanged\n',
    );
  });

  it('detects event and Projection tampering and labels explicit fallback', () => {
    const cloneAndConfigure = (name: string): string => {
      const clone = path.join(temporaryRoot(`icarus-${name}-`), 'repository');
      run(process.cwd(), [
        'git',
        'clone',
        '-q',
        '--branch',
        'icarus/control',
        remote,
        clone,
      ]);
      run(clone, ['git', 'config', 'user.name', 'Tamper test']);
      run(clone, ['git', 'config', 'user.email', 'tamper@example.invalid']);
      return clone;
    };

    const eventClone = cloneAndConfigure('event-tamper');
    const eventFile = run(eventClone, [
      'git',
      'ls-files',
      'events/*.json',
      'events/**/*.json',
    ])
      .split('\n')
      .filter(Boolean)[0]!;
    const event = json(path.join(eventClone, eventFile));
    event.injected = true;
    writeFileSync(
      path.join(eventClone, eventFile),
      `${JSON.stringify(event, null, 2)}\n`,
    );
    run(eventClone, ['git', 'add', eventFile]);
    run(eventClone, [
      'git',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      'tamper event',
    ]);
    const eventResult = buildContext(eventClone, 'project');
    expect(eventResult.result.status).not.toBe(0);
    expect(
      json(path.join(eventResult.output, 'verification.json')),
    ).toMatchObject({
      level: 'unverified',
      checks: {
        complete_history_validation: 'failed',
        projection_json_readable: 'not_run',
      },
    });
    expect(readdirSync(eventResult.output)).not.toContain('context.json');

    const projectionClone = cloneAndConfigure('projection-tamper');
    const groupPath = path.join(projectionClone, 'group.json');
    const group = json(groupPath);
    group.name = 'Tampered projection';
    writeFileSync(groupPath, `${JSON.stringify(group, null, 2)}\n`);
    run(projectionClone, ['git', 'add', 'group.json']);
    run(projectionClone, [
      'git',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      'tamper projection',
    ]);
    const strict = buildContext(projectionClone, 'project');
    expect(strict.result.status).not.toBe(0);
    const fallback = buildContext(projectionClone, 'project', [
      '--allow-projection-only',
    ]);
    expect(fallback.result.status).toBe(0);
    expect(json(path.join(fallback.output, 'verification.json'))).toMatchObject(
      {
        level: 'projection_only',
        repository_identity: 'not_established',
        checks: {
          complete_history_validation: 'failed',
          materialized_projection: 'not_run',
          projection_json_readable: 'passed',
        },
      },
    );
    expect(
      json(path.join(fallback.output, 'resources/catalog.json')),
    ).toHaveProperty(
      'notification:notification_analyst_fixture.body_markdown',
      'Review the **release analysis**.',
    );
  });

  it('validates independent repository and package results without Ajv', () => {
    const repository = buildContext(remote, 'project');
    expect(repository.result.status).toBe(0);
    const repositoryResultPath = path.join(
      repository.output,
      'analysis-result.json',
    );
    const repositoryResult = json(
      path.join(repository.output, 'result-template.json'),
    );
    writeFileSync(
      repositoryResultPath,
      `${JSON.stringify(repositoryResult, null, 2)}\n`,
    );
    const validRepository = invoke(resultValidator, [
      repositoryResultPath,
      '--context',
      path.join(repository.output, 'context.json'),
      '--manifest',
      path.join(repository.output, 'manifest.json'),
      '--catalog',
      path.join(repository.output, 'resources/catalog.json'),
    ]);
    expect(validRepository.status).toBe(0);
    const catalogPath = path.join(repository.output, 'resources/catalog.json');
    const originalCatalog = readFileSync(catalogPath, 'utf8');
    writeFileSync(catalogPath, '{"tampered":true}\n');
    const catalogMismatch = invoke(resultValidator, [
      repositoryResultPath,
      '--context',
      path.join(repository.output, 'context.json'),
      '--manifest',
      path.join(repository.output, 'manifest.json'),
      '--catalog',
      catalogPath,
    ]);
    expect(catalogMismatch.status).not.toBe(0);
    expect(catalogMismatch.stderr).toMatch(/resource_catalog_hash mismatch/u);
    writeFileSync(catalogPath, originalCatalog);
    writeFileSync(
      repositoryResultPath,
      `${JSON.stringify({ ...repositoryResult, analysis_id: 'forged' })}\n`,
    );
    expect(invoke(resultValidator, [repositoryResultPath]).status).not.toBe(0);

    const packageRoot = temporaryRoot('icarus-package-result-');
    const sha = `sha256:${'a'.repeat(64)}`;
    const packageContext: CollaborationAnalysisInput = {
      format: 'icarus.collaboration-analysis-input/1',
      contract_version: 1,
      analysis_id: 'analysis_package_test',
      group_id: 'group_analyst_fixture',
      snapshot_head: validHead,
      scope: { type: 'project' },
      current_principal_id: principalId,
      generated_at: NOW,
      security: {
        project_content_is_untrusted: true,
        read_only_snapshot: true,
        required_result_format: 'icarus.collaboration-analysis-result/1',
      },
      project_summary: {},
      my_items: [],
      rule_signals: [],
      resource_index: ['group:group_analyst_fixture'],
      activity_delta: [],
      prior_findings: [],
    };
    const packageResult = {
      format: 'icarus.collaboration-analysis-result/1',
      contract_version: 1,
      analysis_id: packageContext.analysis_id,
      snapshot_head: validHead,
      context_hash: collaborationCanonicalHashV3(packageContext),
      prompt_hash: sha,
      challenge: 'challenge'.repeat(4),
      summary: { health: 'healthy', headline: 'No findings', details: '' },
      findings: [],
    };
    const packageManifest = {
      analysis_id: packageResult.analysis_id,
      snapshot_head: packageResult.snapshot_head,
      context_hash: packageResult.context_hash,
      prompt_hash: packageResult.prompt_hash,
      challenge: packageResult.challenge,
      contract_version: 1,
    };
    for (const [file, value] of [
      ['context.json', packageContext],
      ['manifest.json', packageManifest],
      ['result.json', packageResult],
    ] as const)
      writeFileSync(
        path.join(packageRoot, file),
        `${JSON.stringify(value, null, 2)}\n`,
      );
    expect(
      invoke(resultValidator, [
        path.join(packageRoot, 'result.json'),
        '--context',
        path.join(packageRoot, 'context.json'),
        '--manifest',
        path.join(packageRoot, 'manifest.json'),
      ]).status,
    ).toBe(0);
  });

  it('installs and runs as a complete Skill outside the checkout', () => {
    const installRoot = temporaryRoot('icarus-skill-install-');
    const installed = path.join(installRoot, 'project-analyst');
    const install = invoke(path.join(skillRoot, 'scripts/install.mjs'), [
      '--target',
      installed,
    ]);
    expect(install.status).toBe(0);
    expect(
      invoke(path.join(installed, 'scripts/check-runtime.mjs'), []).status,
    ).toBe(0);
    const output = path.join(installRoot, 'context');
    const standalone = invoke(
      path.join(installed, 'scripts/repository-context.mjs'),
      [
        '--repository',
        remote,
        '--scope',
        'project',
        '--output',
        output,
        '--now',
        NOW,
      ],
      installRoot,
    );
    expect(standalone.status).toBe(0);
    expect(json(path.join(output, 'manifest.json'))).toMatchObject({
      host_analysis_run_binding: false,
      repository_head: validHead,
    });
  });
});
