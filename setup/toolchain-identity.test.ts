import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import Ajv2020 from 'ajv/dist/2020.js';
import Database from 'better-sqlite3';
import { canonicalize } from 'json-canonicalize';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const toolchainDir = path.join(
  projectRoot,
  'src',
  'workflow-runtime',
  'contracts',
  'toolchain',
);

function readJson(file: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
}

function domainHash(domain: string, payload: unknown): string {
  return `sha256:${crypto
    .createHash('sha256')
    .update(`${domain}\n`)
    .update(canonicalize(payload))
    .digest('hex')}`;
}

const exactPackages = {
  'better-sqlite3': ['dependencies', '12.11.1'],
  'jsonc-parser': ['dependencies', '3.3.1'],
  ajv: ['dependencies', '8.20.0'],
  'ajv-formats': ['dependencies', '3.0.1'],
  'json-canonicalize': ['dependencies', '2.0.0'],
  'fast-check': ['devDependencies', '4.9.0'],
  '@types/node': ['devDependencies', '26.1.1'],
  '@types/better-sqlite3': ['devDependencies', '7.6.13'],
} as const;

describe('G0.1 toolchain identity', () => {
  it('pins the repository and CI Node/npm identity', () => {
    const packageJson = readJson(path.join(projectRoot, 'package.json'));
    const ci = fs.readFileSync(
      path.join(projectRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );

    expect(
      fs.readFileSync(path.join(projectRoot, '.nvmrc'), 'utf8').trim(),
    ).toBe('26.5.0');
    expect(packageJson.packageManager).toBe('npm@11.17.0');
    expect(packageJson.scripts.start).toBe(
      './local/shell/start.sh --mode current',
    );
    expect(packageJson.scripts.start).not.toContain('bind-core');
    expect(packageJson.scripts.start).not.toMatch(/\bnode\s+dist\/index\.js\b/);
    expect(ci).toContain('runs-on: macos-14-xlarge');
    expect(ci).toContain('test "$(uname -s)/$(uname -m)" = "Darwin/arm64"');
    expect(ci).not.toContain('actions/setup-node');
    expect(ci).not.toContain('node-version-file:');
    expect(ci).not.toMatch(/node-version:\s*\d/);
    expect(ci).toContain(
      './scripts/runtime-toolchain.sh --runtime-home "$ICARUS_CI_RUNTIME_HOME" install',
    );
    expect(ci).toContain(
      './scripts/runtime-toolchain.sh --runtime-home "$ICARUS_CI_RUNTIME_HOME" exec -- npm ci',
    );
    expect(ci.indexOf('Install pinned managed runtime')).toBeLessThan(
      ci.indexOf('Install dependencies with managed npm'),
    );
    for (const line of ci
      .split('\n')
      .filter((value) => /^\s+run:.*\bnpm\b/.test(value))) {
      expect(line).toContain('runtime-toolchain.sh');
      expect(line).toContain('exec -- npm');
    }
    expect(process.version).toBe('v26.5.0');
  });

  it('pins every specified direct package and lock integrity', () => {
    const packageJson = readJson(path.join(projectRoot, 'package.json'));
    const lock = readJson(path.join(projectRoot, 'package-lock.json'));

    for (const [packageName, [kind, version]] of Object.entries(
      exactPackages,
    )) {
      expect(packageJson[kind][packageName]).toBe(version);
      expect(lock.packages[''][kind][packageName]).toBe(version);
      expect(lock.packages[`node_modules/${packageName}`].version).toBe(
        version,
      );
      expect(lock.packages[`node_modules/${packageName}`].integrity).toMatch(
        /^sha512-/,
      );
    }
  });

  it('validates the official managed distribution manifest and hash', () => {
    const schema = readJson(
      path.join(toolchainDir, 'managed-node-runtime-distribution.schema.json'),
    );
    const manifest = readJson(
      path.join(toolchainDir, 'node-v26.5.0-darwin-arm64.json'),
    );
    const ajv = new Ajv2020({ strict: true, allErrors: true });

    expect(ajv.validate(schema, manifest), ajv.errorsText()).toBe(true);
    const { manifest_hash: manifestHash, ...payload } = manifest;
    expect(manifestHash).toBe(
      domainHash('icarus:managed-node-runtime-distribution:1', payload),
    );
  });

  it('loads the pinned native module under the active managed Node on darwin', () => {
    const database = new Database(':memory:');
    expect(database.prepare('select 1 as value').get()).toEqual({ value: 1 });
    database.close();

    if (process.platform === 'darwin') {
      const toolchain = path.join(
        projectRoot,
        'scripts',
        'runtime-toolchain.sh',
      );
      const activePath = execFileSync(toolchain, ['active-path'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim();
      expect(fs.realpathSync(process.execPath)).toBe(
        path.join(activePath, 'bin', 'node'),
      );
    }
  });
});
