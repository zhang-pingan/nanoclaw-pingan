import fs from 'fs';
import path from 'path';

import fc from 'fast-check';
import { canonicalize } from 'json-canonicalize';
import { describe, expect, it } from 'vitest';

import {
  ContractArtifactError,
  ContractHashError,
  StrictJsonError,
  VersionedRefError,
  assertJsonValue,
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
  parseContractArtifactEnvelope,
  parseSha256Hash,
  parseVersionedRef,
  strictParseJson,
  strictParseJsonBytes,
} from './index.js';
import { checkContractPackFoundation } from './contract-pack.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const contractsRoot = import.meta.dirname;

function expectStrictJsonError(source: string, code: StrictJsonError['code']) {
  try {
    strictParseJson(source);
    throw new Error('Expected strict JSON parsing to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(StrictJsonError);
    expect((error as StrictJsonError).code).toBe(code);
  }
}

function exampleArtifact(
  overrides: Partial<ContractArtifactEnvelope> = {},
): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.test-contract/1',
    ref: { id: 'test.contract', version: '1.0.0' },
    version: 1,
    domain_separator: 'icarus:test-contract:1\n',
    hash: `sha256:${'0'.repeat(64)}`,
    payload: { value: 1 },
    ...overrides,
  };
  return { ...artifact, hash: calculateArtifactHash(artifact) };
}

describe('G0.2 strict JSON foundation', () => {
  it('parses strict UTF-8 JSON and reports duplicate paths before materializing', () => {
    expect(strictParseJson('{"outer":{"value":1},"ok":true}')).toEqual({
      outer: { value: 1 },
      ok: true,
    });

    try {
      strictParseJson('{"outer":{"value":1,"value":2}}');
      throw new Error('Expected duplicate key rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(StrictJsonError);
      expect(error).toMatchObject({
        code: 'json_duplicate_key',
        pointer: '/outer/value',
      });
    }
  });

  it('rejects comments, trailing commas, non-finite values, and unsafe integers', () => {
    expectStrictJsonError('{"value":1/*comment*/}', 'json_syntax_invalid');
    expectStrictJsonError('{"value":1,}', 'json_syntax_invalid');
    expectStrictJsonError('{"value":1e400}', 'json_non_finite_number');
    expectStrictJsonError('{"value":9007199254740992}', 'json_unsafe_integer');
  });

  it('rejects invalid UTF-8 and values that JSON cannot represent exactly', () => {
    expect(() => strictParseJsonBytes(Uint8Array.from([0xc3, 0x28]))).toThrow(
      expect.objectContaining({ code: 'json_invalid_unicode' }),
    );
    expectStrictJsonError('{"value":"\\ud800"}', 'json_invalid_unicode');
    expect(() => assertJsonValue('\ud800')).toThrow(
      expect.objectContaining({ code: 'json_invalid_unicode' }),
    );

    for (const value of [undefined, 1n, new Date(), new Map()]) {
      expect(() => assertJsonValue(value)).toThrow(StrictJsonError);
    }
    expect(() => assertJsonValue({ ['\ud800']: 'invalid object key' })).toThrow(
      expect.objectContaining({ code: 'json_invalid_unicode' }),
    );
    expect(() => assertJsonValue(new Proxy({ ok: true }, {}))).toThrow(
      expect.objectContaining({ code: 'json_value_unsupported' }),
    );
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => assertJsonValue(sparse)).toThrow(StrictJsonError);
    const accessor = [1];
    Object.defineProperty(accessor, 0, { enumerable: true, get: () => 1 });
    expect(() => assertJsonValue(accessor)).toThrow(StrictJsonError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonValue(cyclic)).toThrow(StrictJsonError);
  });
});

describe('G0.2 VersionedRef and artifact envelope', () => {
  it('accepts only a closed exact VersionedRef', () => {
    expect(
      parseVersionedRef({ id: 'example.capability', version: '1.0.0' }),
    ).toEqual({ id: 'example.capability', version: '1.0.0' });

    for (const value of [
      { id: 'example.capability', version: 'latest' },
      { id: 'example.capability', version: 'LATEST' },
      { id: 'example.capability', version: '^1.0.0' },
      { id: 'example.capability', version: '1.x' },
      { id: 'example.capability', version: '1.0.0', extra: true },
    ]) {
      expect(() => parseVersionedRef(value)).toThrow(VersionedRefError);
    }
  });

  it('validates the generic closed envelope and detects tampering', () => {
    const artifact = exampleArtifact();
    expect(parseContractArtifactEnvelope(artifact)).toEqual(artifact);

    expect(() =>
      parseContractArtifactEnvelope({ ...artifact, unknown: true }),
    ).toThrow(ContractArtifactError);
    expect(() =>
      parseContractArtifactEnvelope({
        ...artifact,
        payload: { value: 2 },
      }),
    ).toThrow(ContractHashError);
    expect(() =>
      parseContractArtifactEnvelope({ ...artifact, version: 2 }),
    ).toThrow(ContractArtifactError);
  });
});

describe('G0.2 canonical and domain-separated hash', () => {
  it('uses lowercase sha256 format and separates equal payloads by domain', () => {
    const payload: JsonObject = { value: 1 };
    const first = domainSeparatedSha256('icarus:test-first:1\n', payload);
    const second = domainSeparatedSha256('icarus:test-second:1\n', payload);

    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(parseSha256Hash(first)).toBe(first);
    expect(() => parseSha256Hash(`sha256:${'A'.repeat(64)}`)).toThrow(
      ContractHashError,
    );
    expect(() => domainSeparatedSha256('icarus:test-first:1', payload)).toThrow(
      ContractHashError,
    );
  });

  it('canonicalizes object keys while preserving array order', () => {
    expect(canonicalJson({ z: 2, a: 1, items: [3, 1, 2] })).toBe(
      '{"a":1,"items":[3,1,2],"z":2}',
    );
    expect(
      canonicalize({
        numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
        string: '€$\u000f\nA\'B"\\"/',
        literals: [null, true, false],
      }),
    ).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}',
    );
  });

  it('is invariant to object insertion order for generated JSON values', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.stringMatching(/^[a-z]{1,8}$/),
          fc.oneof(fc.integer(), fc.boolean(), fc.string()),
          { maxKeys: 12 },
        ),
        (record) => {
          const entries = Object.entries(record);
          const forward = Object.fromEntries(entries) as JsonObject;
          const reverse = Object.fromEntries(entries.reverse()) as JsonObject;
          expect(
            domainSeparatedSha256('icarus:test-property:1\n', forward),
          ).toBe(domainSeparatedSha256('icarus:test-property:1\n', reverse));
        },
      ),
      { numRuns: 200, seed: 20260715 },
    );
  });
});

describe('G0.2 Contract Pack conformance', () => {
  it('checks generated artifacts, fixtures, directories, and G0.1 inputs', () => {
    const before = new Map<string, Buffer>();
    for (const relativePath of [
      'contract-pack-foundation.json',
      'foundation/artifact-envelope-schema.json',
      'foundation/versioned-ref-schema.json',
      'foundation/strict-json-profile.json',
      'foundation/canonical-hash-profile.json',
      'catalogs/foundation-domain-separators.json',
      'conformance/foundation/hash-vectors.json',
      'conformance/foundation/negative-cases.json',
    ]) {
      before.set(
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      );
    }

    const manifest = checkContractPackFoundation();
    expect(manifest.ref).toEqual({
      id: 'icarus.workflow-contract-pack-foundation',
      version: '1.0.0',
    });
    expect(manifest.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const [relativePath, bytes] of before) {
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    }
  });

  it('keeps hand-authored vector canonical bytes independent of key insertion', () => {
    const vectorArtifact = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        fs.readFileSync(
          path.join(
            contractsRoot,
            'conformance',
            'foundation',
            'hash-vectors.json',
          ),
        ),
      ),
    );
    const cases = vectorArtifact.payload.cases as JsonValue[];
    expect(cases).toHaveLength(5);
    for (const testCase of cases) {
      expect(typeof testCase).toBe('object');
      expect(testCase).not.toBeNull();
      expect(canonicalJson((testCase as JsonObject).input)).toBe(
        (testCase as JsonObject).canonical_json,
      );
    }
  });

  it('keeps production Contract Pack imports inside the foundation boundary', () => {
    const allowedPackages = new Set([
      'ajv/dist/2020.js',
      'better-sqlite3',
      'crypto',
      'fs',
      'json-canonicalize',
      'jsonc-parser',
      'node:util',
      'node:crypto',
      'node:fs',
      'node:path',
      'os',
      'path',
      'typescript',
    ]);
    const files = fs
      .readdirSync(contractsRoot, { recursive: true, withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts'),
      )
      .map((entry) => path.join(entry.parentPath, entry.name));

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\bimport\s*\(/);
      expect(source).not.toMatch(/\brequire\s*\(/);
      const specifiers = [
        ...source.matchAll(
          /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
        ),
        ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
        ...source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        if (specifier.startsWith('.')) {
          const resolved = path.resolve(path.dirname(file), specifier);
          const allowedConstructionImport =
            (path.basename(file) ===
              'semantic-correction-review-candidate.ts' &&
              resolved ===
                path.resolve(
                  contractsRoot,
                  '../compiler/semantic-correction.js',
                )) ||
            (path.basename(file) === 'g4-test-bootstrap-contract.ts' &&
              resolved ===
                path.resolve(
                  contractsRoot,
                  '../store/runtime-store/profile.js',
                )) ||
            (path.basename(file) === 'static-child-plan-bundle-repair.ts' &&
              [
                path.resolve(contractsRoot, '../compiler/compiler.js'),
                path.resolve(contractsRoot, '../compiler/identity.js'),
              ].includes(resolved));
          expect(
            resolved.startsWith(`${contractsRoot}${path.sep}`) ||
              allowedConstructionImport,
          ).toBe(true);
        } else {
          expect(allowedPackages.has(specifier)).toBe(true);
        }
      }
    }
  });
});
