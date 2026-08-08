import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { copyWorkflowRuntimeAssets } from './runtime-assets.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-runtime-assets-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('Host Core runtime assets', () => {
  it('copies runtime assets after compiling the current checkout', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts?: { build?: string } };
    expect(packageJson.scripts?.build).toContain(
      'node dist/host-core/runtime-assets.js',
    );
  });

  it('copies Workflow Runtime JSON and SQL beside compiled modules', () => {
    const projectRoot = temporaryRoot();
    const sourceRoot = path.join(projectRoot, 'src', 'workflow-runtime');
    const outputRoot = path.join(projectRoot, 'dist');
    fs.mkdirSync(path.join(sourceRoot, 'contracts', 'schemas'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(sourceRoot, 'store'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'contracts', 'schemas', 'workflow.json'),
      '{"format":"test"}\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'store', 'schema.sql'),
      'CREATE TABLE test (id TEXT);\n',
    );
    fs.writeFileSync(
      path.join(sourceRoot, 'store', 'ignored.ts'),
      'export {};\n',
    );

    copyWorkflowRuntimeAssets(projectRoot, outputRoot);

    expect(
      fs.readFileSync(
        path.join(
          outputRoot,
          'workflow-runtime',
          'contracts',
          'schemas',
          'workflow.json',
        ),
        'utf8',
      ),
    ).toBe('{"format":"test"}\n');
    expect(
      fs.readFileSync(
        path.join(outputRoot, 'workflow-runtime', 'store', 'schema.sql'),
        'utf8',
      ),
    ).toBe('CREATE TABLE test (id TEXT);\n');
    expect(
      fs.existsSync(
        path.join(outputRoot, 'workflow-runtime', 'store', 'ignored.ts'),
      ),
    ).toBe(false);
  });
});
