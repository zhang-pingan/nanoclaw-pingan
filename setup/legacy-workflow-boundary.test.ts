import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const CANDIDATE_ROOT = path.join(
  REPO_ROOT,
  'local',
  'migration-candidates',
  'dev-test-fix-test',
);

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files.sort();
}

function repoRelative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

function readTextFiles(roots: string[]): Array<{ file: string; text: string }> {
  const textExtensions = new Set([
    '.cjs',
    '.css',
    '.html',
    '.js',
    '.json',
    '.json5',
    '.mjs',
    '.ts',
    '.yaml',
    '.yml',
  ]);
  return roots.flatMap((root) =>
    listFiles(path.join(REPO_ROOT, root))
      .filter((file) => textExtensions.has(path.extname(file)))
      .map((file) => ({
        file: repoRelative(file),
        text: fs.readFileSync(file, 'utf8'),
      })),
  );
}

function readProductionTextFiles(): Array<{ file: string; text: string }> {
  return readTextFiles([
    'assistant',
    'container',
    'electron',
    'scripts',
    'src',
    'setup',
  ]).filter(
    ({ file }) =>
      file !== 'setup/legacy-workflow-boundary.test.ts' &&
      !file.endsWith('.test.ts'),
  );
}

describe('legacy workflow boundary', () => {
  it('keeps the migration candidate byte-for-byte intact', () => {
    const checksumFile = path.join(CANDIDATE_ROOT, 'SHA256SUMS');
    const entries = fs
      .readFileSync(checksumFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const match = line.match(/^([a-f0-9]{64})  (.+)$/);
        expect(match, `invalid checksum entry: ${line}`).not.toBeNull();
        return { expected: match![1], relativePath: match![2] };
      });

    expect(entries).toHaveLength(16);
    expect(
      listFiles(path.join(CANDIDATE_ROOT, 'raw')).map((file) =>
        path.relative(CANDIDATE_ROOT, file).split(path.sep).join('/'),
      ),
    ).toEqual(entries.map((entry) => entry.relativePath).sort());

    for (const entry of entries) {
      const bytes = fs.readFileSync(
        path.join(CANDIDATE_ROOT, entry.relativePath),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        entry.expected,
      );
    }
  });

  it('is unreachable from production, build, test-helper, and setup code', () => {
    const forbiddenReference = ['local', 'migration-candidates'].join('/');
    const files = readTextFiles([
      'assistant',
      'container',
      'electron',
      'scripts',
      'src',
      'setup',
    ]).filter(({ file }) => file !== 'setup/legacy-workflow-boundary.test.ts');

    const references = files
      .filter(({ text }) => text.includes(forbiddenReference))
      .map(({ file }) => file);
    expect(references).toEqual([]);
  });

  it('stays outside compile, container, and release inputs', () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'tsconfig.json'), 'utf8'),
    ) as { include?: string[] };
    expect(tsconfig.include).toEqual(['src/**/*']);

    const electronBuilder = fs.readFileSync(
      path.join(REPO_ROOT, 'electron-builder.json5'),
      'utf8',
    );
    expect(electronBuilder).not.toContain('local/');
    expect(electronBuilder).not.toContain('migration-candidates');

    const electronBuild = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/build-electron.mjs'),
      'utf8',
    );
    const assistantBuild = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts/build-assistant.mjs'),
      'utf8',
    );
    expect(electronBuild).not.toContain('migration-candidates');
    expect(assistantBuild).not.toContain('migration-candidates');

    const dockerfile = fs.readFileSync(
      path.join(REPO_ROOT, 'container/Dockerfile'),
      'utf8',
    );
    expect(dockerfile).not.toContain('migration-candidates');
    expect(
      path.relative(path.join(REPO_ROOT, 'container'), CANDIDATE_ROOT),
    ).toMatch(/^\.\./);
  });

  it('keeps removed Electron navigation and screens out of the DOM', () => {
    const html = fs.readFileSync(
      path.join(REPO_ROOT, 'electron/renderer/index.html'),
      'utf8',
    );
    for (const navKey of [
      'workbench',
      'workflow-definitions',
      'cards-management',
    ]) {
      expect(html).not.toContain(`data-nav-key="${navKey}"`);
    }
    for (const screenId of [
      'workbench-screen',
      'workflow-definitions-screen',
      'cards-management-screen',
    ]) {
      expect(html).not.toContain(`id="${screenId}"`);
    }
  });

  it('keeps removed imports, symbols, routes, and nav keys out of production', () => {
    const files = readProductionTextFiles();
    const forbiddenSymbols = [
      'WORKBENCH_BROADCAST_TARGETS',
      'createWorkflow(',
      'deleteAllWorkbenchTaskData',
      'getAllWorkflows',
      'initWorkflow(',
      'query_workbench_tasks',
      'syncWorkbenchOnWorkflowCreated',
      'workbench_task_ids',
      'workflowAssets',
    ];
    const forbiddenRoutes = [
      '/api/workflow-definitions',
      '/api/workflow-artifact-contracts',
      '/api/workflow-actions',
      '/api/cards',
      '/api/workflow/create-options',
      '/api/workflow/requirement',
      '/api/workbench/',
    ];
    const failures: string[] = [];

    for (const file of files) {
      if (
        /(?:from\s+|import\s*\()['"][^'"]*(?:workflow|workbench)/i.test(
          file.text,
        )
      ) {
        failures.push(`${file.file}: removed import`);
      }
      for (const symbol of forbiddenSymbols) {
        if (file.text.includes(symbol)) {
          failures.push(`${file.file}: ${symbol}`);
        }
      }
      for (const route of forbiddenRoutes) {
        if (file.text.includes(route)) {
          failures.push(`${file.file}: ${route}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it('keeps deleted modules and active legacy resource roots absent', () => {
    const deletedModules = [
      'src/workflow.ts',
      'src/workflow-context.ts',
      'src/workflow-definition.ts',
      'src/workflow-compiler.ts',
      'src/workbench.ts',
      'src/workbench-store.ts',
      'src/workbench-query.ts',
      'src/card-files.ts',
      'src/card-config.ts',
      'src/card-builder.ts',
    ];
    const removedResourceRoots = [
      'container/cards',
      'container/workflow-definitions',
      'container/workflow-evaluators',
    ];
    for (const relativePath of [...deletedModules, ...removedResourceRoots]) {
      expect(
        fs.existsSync(path.join(REPO_ROOT, relativePath)),
        relativePath,
      ).toBe(false);
    }

    const mcpConfig = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'container/mcp/mcp.json'), 'utf8'),
    ) as {
      profiles?: Record<string, unknown>;
      groups?: Record<string, string[]>;
    };
    expect(mcpConfig.profiles?.['workbench-main']).toBeUndefined();
    expect(JSON.stringify(mcpConfig)).not.toContain('query_workbench_tasks');

    const mcpServer = fs.readFileSync(
      path.join(REPO_ROOT, 'container/agent-runner/src/ipc-mcp-stdio.ts'),
      'utf8',
    );
    expect(mcpServer).not.toContain('workbench_task_ids');
    expect(mcpServer).not.toContain('query_workbench_tasks');
  });
});
