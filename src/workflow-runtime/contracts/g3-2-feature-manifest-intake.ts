import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { calculateArtifactHash, canonicalJson } from './hash.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { parseAndEvaluateG32AFeatureManifest } from './g3-2a-feature-manifest-intake.js';
import {
  G32A_ERROR_CODES,
  G32A_PHASES,
} from './g3-2a-feature-manifest-intake-types.js';
import type {
  G32AErrorCode,
  G32AFeatureManifest,
  G32AIntakeResult,
} from './g3-2a-feature-manifest-intake-types.js';
import type {
  G32ADependencyRequest,
  G32DependencyResolver,
  G32FeatureManifestPreflightDiagnostic,
  G32FeatureManifestPreflightOptions,
  G32FeatureManifestPreflightResult,
  G32ResolvedFeatureRelease,
} from './g3-2-feature-manifest-intake-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export const G32_FEATURE_MANIFEST_PREFLIGHT_ROOT =
  'conformance/g3.2-feature-manifest-intake';
export const G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_PATH =
  'registry/feature-manifest-vnext-strict-intake-preflight-profile@1.json';
export const G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA_PATH =
  'registry/feature-manifest-vnext-strict-intake-preflight-result-schema@1.json';
export const G32_FEATURE_MANIFEST_PREFLIGHT_DOMAIN_CATALOG_PATH =
  'registry/feature-manifest-vnext-strict-intake-preflight-domain-separators@1.json';
export const G32_FEATURE_MANIFEST_PREFLIGHT_PACK_PATH =
  'contract-pack-g3.2-feature-manifest-intake.json';
export const G32_FEATURE_MANIFEST_PREFLIGHT_POSITIVE_CASES_PATH = `${G32_FEATURE_MANIFEST_PREFLIGHT_ROOT}/positive-cases.json`;
export const G32_FEATURE_MANIFEST_PREFLIGHT_NEGATIVE_CASES_PATH = `${G32_FEATURE_MANIFEST_PREFLIGHT_ROOT}/negative-cases.json`;

export const G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-preflight-profile:1\n';
export const G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_SCHEMA_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-preflight-profile-schema:1\n';
export const G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-preflight-result-schema:1\n';
export const G32_FEATURE_MANIFEST_PREFLIGHT_DOMAIN_CATALOG_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-preflight-domain-separators:1\n';
export const G32_FEATURE_MANIFEST_PREFLIGHT_POSITIVE_DOMAIN =
  'icarus:workflow-g3-2-feature-manifest-intake-positive-cases:1\n';
export const G32_FEATURE_MANIFEST_PREFLIGHT_NEGATIVE_DOMAIN =
  'icarus:workflow-g3-2-feature-manifest-intake-negative-cases:1\n';
export const G32_FEATURE_MANIFEST_PREFLIGHT_PACK_DOMAIN =
  'icarus:workflow-contract-pack-g3-2-feature-manifest-intake:1\n';

const contractsRoot = import.meta.dirname;

function diagnostic(
  code: G32AErrorCode,
  phase: G32FeatureManifestPreflightDiagnostic['phase'],
  pointer: string,
  detail: string,
): G32FeatureManifestPreflightDiagnostic {
  return { code, phase, pointer, detail };
}

function resultFromA(
  result: G32AIntakeResult,
  overrides: Partial<G32FeatureManifestPreflightResult> = {},
): G32FeatureManifestPreflightResult {
  return {
    format:
      'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result/1',
    outcome: result.outcome,
    code: result.code,
    phase: result.phase,
    diagnostics: result.diagnostics,
    feature_id: result.feature_id,
    manifest_hash: result.manifest_hash,
    reader_invoked: false,
    resolver_invoked: false,
    root_snapshot_status: 'not_invoked',
    source_hash_status: 'not_invoked',
    dependency_resolution_status: 'not_attempted',
    ...overrides,
  };
}

function rejected(
  code: G32AErrorCode,
  phase: G32FeatureManifestPreflightDiagnostic['phase'],
  detail: string,
  pointer = '',
  state: Partial<G32FeatureManifestPreflightResult> = {},
): G32FeatureManifestPreflightResult {
  return {
    format:
      'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result/1',
    outcome: 'rejected',
    code,
    phase,
    diagnostics: [diagnostic(code, phase, pointer, detail)],
    feature_id: state.feature_id ?? null,
    manifest_hash: state.manifest_hash ?? null,
    reader_invoked: state.reader_invoked ?? false,
    resolver_invoked: state.resolver_invoked ?? false,
    root_snapshot_status: state.root_snapshot_status ?? 'not_invoked',
    source_hash_status: state.source_hash_status ?? 'not_invoked',
    dependency_resolution_status:
      state.dependency_resolution_status ?? 'not_attempted',
  };
}

function hashBytes(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function identity(stats: fs.Stats): { device: string; inode: string } {
  return { device: String(stats.dev), inode: String(stats.ino) };
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function sourceRootPath(
  manifest: G32AFeatureManifest,
  options: G32FeatureManifestPreflightOptions,
): string {
  const override = options.featureSourceRoot ?? options.rootDir;
  if (override) return path.resolve(override);
  return path.resolve(
    options.workspaceRoot ?? process.cwd(),
    manifest.ownership.feature_source_root,
  );
}

function noFollowFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
}

function lstatPath(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function sourcePathParts(root: string, sourcePath: string): string[] {
  return sourcePath
    .split('/')
    .filter(Boolean)
    .reduce<string[]>((parts, part) => {
      parts.push(part);
      return parts;
    }, []);
}

interface ReadEntry {
  sourcePath: string;
  fileIdentity: { device: string; inode: string };
  contentHash: Sha256Hash;
}

function readSourceEntries(
  manifest: G32AFeatureManifest,
  root: string,
): { result: G32FeatureManifestPreflightResult | null; entries: ReadEntry[] } {
  const rootBefore = lstatPath(root);
  const baseState = {
    feature_id: manifest.feature_ref.id.slice(0, -'.feature'.length),
    manifest_hash: manifest.manifest_hash,
    reader_invoked: true,
  } as const;
  if (!rootBefore) {
    return {
      result: rejected(
        'feature_manifest_source_path_drift',
        'root_snapshot_path_read',
        'Canonical feature source root does not exist',
        '/ownership/feature_source_root',
        baseState,
      ),
      entries: [],
    };
  }
  if (rootBefore.isSymbolicLink()) {
    return {
      result: rejected(
        'feature_manifest_source_root_symlink',
        'root_snapshot_path_read',
        'Canonical feature source root is a symlink',
        '/ownership/feature_source_root',
        baseState,
      ),
      entries: [],
    };
  }
  if (!rootBefore.isDirectory()) {
    return {
      result: rejected(
        'feature_manifest_source_root_moved',
        'root_snapshot_path_read',
        'Canonical feature source root is not a directory',
        '/ownership/feature_source_root',
        baseState,
      ),
      entries: [],
    };
  }
  const entries: ReadEntry[] = [];
  const identities = new Set<string>();
  for (const [
    index,
    resource,
  ] of manifest.dynamic_workflow_resources.entries()) {
    const fullPath = path.resolve(
      root,
      ...sourcePathParts(root, resource.source_path),
    );
    const pointer = `/dynamic_workflow_resources/${index}/source_path`;
    if (!inside(root, fullPath)) {
      return {
        result: rejected(
          'feature_manifest_path_invalid',
          'root_snapshot_path_read',
          'Resolved source path escapes the canonical feature root',
          pointer,
          baseState,
        ),
        entries,
      };
    }
    const parts = sourcePathParts(root, resource.source_path);
    let current = root;
    for (const segment of parts) {
      current = path.join(current, segment);
      const observed = lstatPath(current);
      if (!observed) {
        return {
          result: rejected(
            'feature_manifest_source_path_drift',
            'root_snapshot_path_read',
            'Manifest source path does not exist',
            pointer,
            baseState,
          ),
          entries,
        };
      }
      if (observed.isSymbolicLink()) {
        return {
          result: rejected(
            'feature_manifest_source_path_symlink',
            'root_snapshot_path_read',
            'Manifest source path contains a symlink',
            pointer,
            baseState,
          ),
          entries,
        };
      }
    }
    const before = lstatPath(fullPath);
    if (!before || !before.isFile()) {
      return {
        result: rejected(
          'feature_manifest_source_path_drift',
          'root_snapshot_path_read',
          'Manifest source path is not a regular file',
          pointer,
          baseState,
        ),
        entries,
      };
    }
    const key = `${before.dev}:${before.ino}`;
    if (identities.has(key)) {
      return {
        result: rejected(
          'feature_manifest_source_hard_link',
          'root_snapshot_path_read',
          'Two manifest source paths share one device/inode identity',
          pointer,
          baseState,
        ),
        entries,
      };
    }
    identities.add(key);
    let fd: number;
    try {
      fd = fs.openSync(fullPath, noFollowFlags());
    } catch {
      return {
        result: rejected(
          'feature_manifest_source_path_symlink',
          'root_snapshot_path_read',
          'Source file could not be opened with no-follow semantics',
          pointer,
          baseState,
        ),
        entries,
      };
    }
    try {
      const opened = fs.fstatSync(fd);
      if (!sameIdentity(before, opened)) {
        return {
          result: rejected(
            'feature_manifest_source_path_drift',
            'root_snapshot_path_read',
            'Source file identity changed before reading',
            pointer,
            baseState,
          ),
          entries,
        };
      }
      const bytes = fs.readFileSync(fd);
      const afterRead = fs.fstatSync(fd);
      if (!sameIdentity(opened, afterRead)) {
        return {
          result: rejected(
            'feature_manifest_source_path_drift',
            'root_snapshot_path_read',
            'Source file identity changed after reading',
            pointer,
            baseState,
          ),
          entries,
        };
      }
      entries.push({
        sourcePath: resource.source_path,
        fileIdentity: identity(afterRead),
        contentHash: hashBytes(bytes),
      });
    } finally {
      fs.closeSync(fd);
    }
    const rootAfterEntry = lstatPath(root);
    if (!rootAfterEntry || !sameIdentity(rootBefore, rootAfterEntry)) {
      return {
        result: rejected(
          'feature_manifest_source_root_moved',
          'root_snapshot_path_read',
          'Feature source root identity changed during source read',
          '/ownership/feature_source_root',
          baseState,
        ),
        entries,
      };
    }
  }
  const rootAfter = lstatPath(root);
  if (!rootAfter || !sameIdentity(rootBefore, rootAfter)) {
    return {
      result: rejected(
        'feature_manifest_source_root_moved',
        'root_snapshot_path_read',
        'Feature source root identity changed after source read',
        '/ownership/feature_source_root',
        baseState,
      ),
      entries,
    };
  }
  return { result: null, entries };
}

function sourceHashFailure(
  manifest: G32AFeatureManifest,
  entries: ReadEntry[],
): G32FeatureManifestPreflightResult | null {
  for (const [
    index,
    resource,
  ] of manifest.dynamic_workflow_resources.entries()) {
    const entry = entries.find(
      (candidate) => candidate.sourcePath === resource.source_path,
    );
    if (!entry || entry.contentHash !== resource.expected_source_hash) {
      return rejected(
        'feature_manifest_source_hash_mismatch',
        'source_hash',
        `Source content hash does not match expected_source_hash (expected ${resource.expected_source_hash})`,
        `/dynamic_workflow_resources/${index}/expected_source_hash`,
        {
          feature_id: manifest.feature_ref.id.slice(0, -'.feature'.length),
          manifest_hash: manifest.manifest_hash,
          reader_invoked: true,
          root_snapshot_status: 'verified',
        },
      );
    }
  }
  return null;
}

function refsEqual(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function dependencyResolutionFailure(
  manifest: G32AFeatureManifest,
  resolver: G32DependencyResolver | undefined,
): G32FeatureManifestPreflightResult | null {
  if (manifest.dependencies.length === 0) return null;
  if (!resolver) {
    return rejected(
      'feature_manifest_dependency_unresolved',
      'dependency_resolution',
      'No exact dependency resolver was supplied',
      '/dependencies',
      {
        feature_id: manifest.feature_ref.id.slice(0, -'.feature'.length),
        manifest_hash: manifest.manifest_hash,
        reader_invoked: true,
        resolver_invoked: true,
        root_snapshot_status: 'verified',
        source_hash_status: 'verified',
      },
    );
  }
  for (const [index, dependency] of manifest.dependencies.entries()) {
    let resolved: G32ResolvedFeatureRelease | null;
    try {
      resolved = resolver(dependency as G32ADependencyRequest);
    } catch {
      resolved = null;
    }
    if (resolved === null) {
      return rejected(
        'feature_manifest_dependency_unresolved',
        'dependency_resolution',
        'Exact feature release dependency could not be resolved',
        `/dependencies/${index}/feature_release_ref`,
        {
          feature_id: manifest.feature_ref.id.slice(0, -'.feature'.length),
          manifest_hash: manifest.manifest_hash,
          reader_invoked: true,
          resolver_invoked: true,
          root_snapshot_status: 'verified',
          source_hash_status: 'verified',
        },
      );
    }
    if (
      !refsEqual(
        resolved.feature_release_ref,
        dependency.feature_release_ref,
      ) ||
      resolved.feature_release_hash !== dependency.feature_release_hash
    ) {
      return rejected(
        'feature_manifest_dependency_unresolved',
        'dependency_resolution',
        'Resolved feature release does not match the exact ref/hash pin',
        `/dependencies/${index}/feature_release_ref`,
        {
          feature_id: manifest.feature_ref.id.slice(0, -'.feature'.length),
          manifest_hash: manifest.manifest_hash,
          reader_invoked: true,
          resolver_invoked: true,
          root_snapshot_status: 'verified',
          source_hash_status: 'verified',
        },
      );
    }
    const resolvedResources = resolved.required_resource_refs;
    for (const [
      resourceIndex,
      required,
    ] of dependency.required_resource_refs.entries()) {
      if (
        !resolvedResources.some((candidate) => refsEqual(candidate, required))
      ) {
        return rejected(
          'feature_manifest_dependency_unresolved',
          'dependency_resolution',
          'Exact required resource ref is absent from the resolved release closure',
          `/dependencies/${index}/required_resource_refs/${resourceIndex}`,
          {
            feature_id: manifest.feature_ref.id.slice(0, -'.feature'.length),
            manifest_hash: manifest.manifest_hash,
            reader_invoked: true,
            resolver_invoked: true,
            root_snapshot_status: 'verified',
            source_hash_status: 'verified',
          },
        );
      }
    }
  }
  return null;
}

export function preflightG32FeatureManifest(
  bytes: Uint8Array,
  options: G32FeatureManifestPreflightOptions = {},
): G32FeatureManifestPreflightResult {
  const initial = parseAndEvaluateG32AFeatureManifest(bytes);
  if (initial.outcome === 'rejected') return resultFromA(initial);
  let manifest: G32AFeatureManifest;
  try {
    manifest = strictParseJsonBytes(bytes) as G32AFeatureManifest;
  } catch {
    return resultFromA(initial);
  }
  const root = sourceRootPath(manifest, options);
  const rootRead = readSourceEntries(manifest, root);
  if (rootRead.result) return rootRead.result;
  const hashFailure = sourceHashFailure(manifest, rootRead.entries);
  if (hashFailure) return hashFailure;
  const resolver = options.dependencyResolver ?? options.resolveDependency;
  const dependencyFailure = dependencyResolutionFailure(manifest, resolver);
  if (dependencyFailure) return dependencyFailure;
  const featureId = manifest.feature_ref.id.slice(0, -'.feature'.length);
  return {
    format:
      'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result/1',
    outcome: 'accepted',
    code: 'feature_manifest_intake_ok',
    phase: 'dependency_resolution',
    diagnostics: [
      diagnostic(
        'feature_manifest_intake_ok',
        'dependency_resolution',
        '',
        'Strict intake preflight passed; source bytes were read and exact dependencies were resolved',
      ),
    ],
    feature_id: featureId,
    manifest_hash: manifest.manifest_hash,
    reader_invoked: true,
    resolver_invoked: manifest.dependencies.length > 0,
    root_snapshot_status: 'verified',
    source_hash_status: 'verified',
    dependency_resolution_status: 'resolved',
  };
}

export function parseAndPreflightG32FeatureManifest(
  bytes: Uint8Array,
  options: G32FeatureManifestPreflightOptions = {},
): G32FeatureManifestPreflightResult {
  try {
    return preflightG32FeatureManifest(bytes, options);
  } catch (error) {
    const code = (error as { code?: string; pointer?: string }).code;
    const mapped = new Set<string>(G32A_ERROR_CODES);
    const resultCode: G32AErrorCode = mapped.has(code ?? '')
      ? (code as G32AErrorCode)
      : 'feature_manifest_json_syntax_invalid';
    const phase = (error as { phase?: string }).phase;
    const resultPhase = (G32A_PHASES as readonly string[]).includes(phase ?? '')
      ? (phase as G32FeatureManifestPreflightDiagnostic['phase'])
      : 'strict_bytes_parse';
    return rejected(
      resultCode,
      resultPhase,
      error instanceof Error ? error.message : String(error),
      (error as { pointer?: string }).pointer ?? '',
    );
  }
}

export function calculateG32PreflightResultHash(
  result: G32FeatureManifestPreflightResult,
): Sha256Hash {
  const withoutDiagnostics = {
    ...result,
    diagnostics: result.diagnostics,
  } as JsonObject;
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      'icarus:workflow-feature-manifest-vnext-strict-intake-preflight-result:1\n',
      'ascii',
    )
    .update(canonicalJson(withoutDiagnostics), 'utf8')
    .digest('hex')}`;
}

function artifact(
  format: string,
  id: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const output: ContractArtifactEnvelope = {
    format,
    ref: { id, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: `sha256:${'0'.repeat(64)}`,
    payload,
  };
  output.hash = calculateArtifactHash(output);
  return output;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`G3.2 contract path escapes root: ${relativePath}`);
  }
  return resolved;
}

function writeAtomic(relativePath: string, value: JsonValue): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, render(value), { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(relativePath))),
  );
}

function profilePayload(): JsonObject {
  return {
    format:
      'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-profile/1',
    source_profile_format:
      'icarus.workflow-feature-manifest-vnext-strict-intake-profile/1',
    source_manifest_hash_domain: 'icarus:feature-manifest-source:2\n',
    reader_contract:
      'After the G3.2A phases pass, resolve the canonical feature source root, lstat root and every declared source path, open files with O_NOFOLLOW, fstat-compare before reading, hash raw bytes with SHA-256, compare root identity before and after every read, and reject symlink, hard-link, missing or moving paths.',
    dependency_contract:
      'Resolve every dependency only through an explicit resolver against the exact feature_release_ref and feature_release_hash; every required_resource_ref must be present in that exact release closure.',
    side_effect_boundary:
      'The preflight is read-only. It does not read legacy resource keys, write Registry state, publish, activate, or load Production resources.',
    error_precedence: [
      'strict_bytes_parse',
      'removed_unknown_structural_intake',
      'full_closed_schema',
      'manifest_hash',
      'ownership_order_path_lexical_validation',
      'root_snapshot_path_read',
      'source_hash',
      'dependency_resolution',
    ],
  };
}

function profileSchema(): JsonObject {
  const text = { type: 'string', minLength: 1 };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://icarus.local/schemas/feature-manifest-vnext-strict-intake-preflight-profile/1',
    title: 'Feature Manifest vNext Strict Intake Preflight Profile v1',
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'source_profile_format',
      'source_manifest_hash_domain',
      'reader_contract',
      'dependency_contract',
      'side_effect_boundary',
      'error_precedence',
    ],
    properties: {
      format: {
        const:
          'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-profile/1',
      },
      source_profile_format: {
        const: 'icarus.workflow-feature-manifest-vnext-strict-intake-profile/1',
      },
      source_manifest_hash_domain: {
        const: 'icarus:feature-manifest-source:2\n',
      },
      reader_contract: text,
      dependency_contract: text,
      side_effect_boundary: text,
      error_precedence: {
        type: 'array',
        minItems: 8,
        maxItems: 8,
        items: text,
      },
    },
  };
}

function resultSchema(): JsonObject {
  const codes = [...G32A_ERROR_CODES];
  const phases = [...G32A_PHASES];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://icarus.local/schemas/feature-manifest-vnext-strict-intake-preflight-result/1',
    title: 'Feature Manifest vNext Strict Intake Preflight Result v1',
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'outcome',
      'code',
      'phase',
      'diagnostics',
      'feature_id',
      'manifest_hash',
      'reader_invoked',
      'resolver_invoked',
      'root_snapshot_status',
      'source_hash_status',
      'dependency_resolution_status',
    ],
    properties: {
      format: {
        const:
          'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result/1',
      },
      outcome: { enum: ['accepted', 'rejected'] },
      code: { enum: codes },
      phase: { enum: phases },
      diagnostics: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'phase', 'pointer', 'detail'],
          properties: {
            code: { enum: codes },
            phase: { enum: phases },
            pointer: { type: 'string' },
            detail: { type: 'string', minLength: 1 },
          },
        },
      },
      feature_id: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
      },
      manifest_hash: {
        anyOf: [
          { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          { type: 'null' },
        ],
      },
      reader_invoked: { type: 'boolean' },
      resolver_invoked: { type: 'boolean' },
      root_snapshot_status: { enum: ['not_invoked', 'verified'] },
      source_hash_status: { enum: ['not_invoked', 'verified'] },
      dependency_resolution_status: { enum: ['not_attempted', 'resolved'] },
    },
  };
}

function manifestWithoutResource(): string {
  const value: JsonObject = {
    format: 'icarus.feature-manifest/2',
    feature_ref: { id: 'example.feature', version: '1.0.0' },
    namespace: 'example',
    owner_principal_ref: 'human:local-owner',
    dependencies: [],
    package_resources: {
      skills: [],
      agents: [],
      mcp: [],
      scripts: [],
      templates: [],
    },
    extension_surfaces: {
      api_entry: null,
      nav_entry: null,
      renderer_entry: null,
    },
    dynamic_workflow_resources: [],
    ownership: {
      feature_source_root: 'features/example',
      workflow_source_root: 'features/example/workflow-src',
      execution_bundle_owner: 'feature_release',
      registry_namespace: 'example',
    },
    lifecycle: {
      draining_policy_ref: { id: 'example.draining', version: '1.0.0' },
      retention_policy_ref: { id: 'example.retention', version: '1.0.0' },
      deletion_policy_ref: { id: 'example.deletion', version: '1.0.0' },
    },
    manifest_hash: `sha256:${'0'.repeat(64)}`,
  };
  // Importing the G3.2A hash helper would make the generated pack depend on
  // fixture internals; the source hash formula is intentionally explicit here.
  const withoutHash = { ...value };
  delete withoutHash.manifest_hash;
  value.manifest_hash = `sha256:${crypto
    .createHash('sha256')
    .update('icarus:feature-manifest-source:2\n', 'ascii')
    .update(canonicalJson(withoutHash), 'utf8')
    .digest('hex')}`;
  return JSON.stringify(value);
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const positive = artifact(
    'icarus.workflow-g3-2-feature-manifest-intake-positive-cases/1',
    'icarus.workflow-g3-2-feature-manifest-intake-positive-cases',
    G32_FEATURE_MANIFEST_PREFLIGHT_POSITIVE_DOMAIN,
    {
      cases: [
        {
          case_id: 'valid-empty-resource-set-with-read-only-root',
          input_text: manifestWithoutResource(),
          expected_code: 'feature_manifest_intake_ok',
          expected_phase: 'dependency_resolution',
        },
      ],
    },
  );
  const negative = artifact(
    'icarus.workflow-g3-2-feature-manifest-intake-negative-cases/1',
    'icarus.workflow-g3-2-feature-manifest-intake-negative-cases',
    G32_FEATURE_MANIFEST_PREFLIGHT_NEGATIVE_DOMAIN,
    {
      cases: [
        {
          case_id: 'missing-canonical-root',
          input_text: manifestWithoutResource(),
          expected_code: 'feature_manifest_source_path_drift',
          expected_phase: 'root_snapshot_path_read',
        },
        {
          case_id: 'missing-exact-dependency-resolver',
          input_text: manifestWithoutResource(),
          expected_code: 'feature_manifest_dependency_unresolved',
          expected_phase: 'dependency_resolution',
        },
      ],
    },
  );
  const profile = artifact(
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-profile/1',
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-profile',
    G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_DOMAIN,
    profilePayload(),
  );
  const resultSchemaArtifact = artifact(
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result-schema/1',
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result-schema',
    G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA_DOMAIN,
    resultSchema(),
  );
  const profileSchemaArtifact = artifact(
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-profile-schema/1',
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-profile-schema',
    G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_SCHEMA_DOMAIN,
    profileSchema(),
  );
  const domainCatalog = artifact(
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-domain-separators/1',
    'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-domain-separators',
    G32_FEATURE_MANIFEST_PREFLIGHT_DOMAIN_CATALOG_DOMAIN,
    {
      entries: [
        {
          format: profile.format,
          domain_separator: G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_DOMAIN,
        },
        {
          format: profileSchemaArtifact.format,
          domain_separator:
            G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_SCHEMA_DOMAIN,
        },
        {
          format: resultSchemaArtifact.format,
          domain_separator: G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA_DOMAIN,
        },
        {
          format: positive.format,
          domain_separator: G32_FEATURE_MANIFEST_PREFLIGHT_POSITIVE_DOMAIN,
        },
        {
          format: negative.format,
          domain_separator: G32_FEATURE_MANIFEST_PREFLIGHT_NEGATIVE_DOMAIN,
        },
        {
          format:
            'icarus.workflow-contract-pack-g3-2-feature-manifest-intake/1',
          domain_separator: G32_FEATURE_MANIFEST_PREFLIGHT_PACK_DOMAIN,
        },
      ],
    },
  );
  const pack = artifact(
    'icarus.workflow-contract-pack-g3-2-feature-manifest-intake/1',
    'icarus.workflow-contract-pack-g3-2-feature-manifest-intake',
    G32_FEATURE_MANIFEST_PREFLIGHT_PACK_DOMAIN,
    {
      gate: 'G3.2',
      slice: 'strict_intake_preflight',
      status: 'DONE',
      g3_status: 'IN_PROGRESS',
      profile_hash: profile.hash,
      profile_schema_hash: profileSchemaArtifact.hash,
      result_schema_hash: resultSchemaArtifact.hash,
      positive_cases_hash: positive.hash,
      negative_cases_hash: negative.hash,
      domain_catalog_hash: domainCatalog.hash,
      positive_case_count: 1,
      negative_case_count: 2,
      reader_invoked: true,
      resolver_invoked: true,
      registry_write_performed: false,
      publisher_executed: false,
      activation_performed: false,
      g4_through_g9_status: 'NOT_READY',
    },
  );
  return [
    [G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_PATH, profile],
    [
      'registry/feature-manifest-vnext-strict-intake-preflight-profile-schema@1.json',
      profileSchemaArtifact,
    ],
    [G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA_PATH, resultSchemaArtifact],
    [G32_FEATURE_MANIFEST_PREFLIGHT_POSITIVE_CASES_PATH, positive],
    [G32_FEATURE_MANIFEST_PREFLIGHT_NEGATIVE_CASES_PATH, negative],
    [G32_FEATURE_MANIFEST_PREFLIGHT_DOMAIN_CATALOG_PATH, domainCatalog],
    [G32_FEATURE_MANIFEST_PREFLIGHT_PACK_PATH, pack],
  ];
}

export const G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_SCHEMA = profileSchema();
export const G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA = resultSchema();

export function generateG32FeatureManifestIntake(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  for (const [relativePath, value] of artifacts)
    writeAtomic(relativePath, value);
  return artifacts.at(-1)![1];
}

export function checkG32FeatureManifestIntake(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  for (const [relativePath, expected] of artifacts) {
    const actual = readArtifact(relativePath);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`${relativePath} identity or payload drift`);
    }
    if (fs.readFileSync(absolute(relativePath), 'utf8') !== render(expected)) {
      throw new Error(`${relativePath} is not generated byte-for-byte`);
    }
  }
  return artifacts.at(-1)![1];
}

export function g32FeatureManifestIntakeFixturesForTest(): {
  positive: JsonObject[];
  negative: JsonObject[];
} {
  const artifacts = buildArtifacts();
  const positive = (artifacts[3][1].payload as JsonObject).cases;
  const negative = (artifacts[4][1].payload as JsonObject).cases;
  return {
    positive: positive as JsonObject[],
    negative: negative as JsonObject[],
  };
}
