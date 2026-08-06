import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import {
  G32A_DYNAMIC_RESOURCE_KINDS,
  G32A_ERROR_CODES,
  G32A_FEATURE_MANIFEST_FORMAT,
  G32A_FEATURE_MANIFEST_PROFILE_FORMAT,
  G32A_FEATURE_MANIFEST_PROFILE_SCHEMA_FORMAT,
  G32A_FEATURE_MANIFEST_RESULT_FORMAT,
  G32A_FEATURE_MANIFEST_RESULT_SCHEMA_FORMAT,
  G32A_PHASES,
  G32A_REMOVED_RESOURCE_KEYS,
  G32A_ROOT_IDENTITY_DOMAIN,
  G32A_SOURCE_MANIFEST_HASH_DOMAIN,
  type G32ADiagnostic,
  type G32ADependency,
  type G32AFeatureManifest,
  type G32AFileIdentity,
  type G32AIntakeObservations,
  type G32AIntakeResult,
  type G32AProfilePayload,
  type G32AResourceEntry,
} from './g3-2a-feature-manifest-intake-types.js';

const contractsRoot = import.meta.dirname;
const sourceSchemaPath = path.join(
  contractsRoot,
  'schemas/feature-manifest-v2-schema.json',
);
export const G32A_ROOT = 'conformance/g3.2a-feature-manifest-intake';
export const G32A_PROFILE_SCHEMA_PATH =
  'registry/feature-manifest-vnext-strict-intake-profile-schema@1.json';
export const G32A_RESULT_SCHEMA_PATH =
  'registry/feature-manifest-vnext-strict-intake-result-schema@1.json';
export const G32A_PROFILE_PATH =
  'registry/feature-manifest-vnext-strict-intake-profile@1.json';
export const G32A_POSITIVE_CASES_PATH = `${G32A_ROOT}/positive-cases.json`;
export const G32A_NEGATIVE_CASES_PATH = `${G32A_ROOT}/negative-cases.json`;
export const G32A_DOMAIN_CATALOG_PATH =
  'registry/feature-manifest-vnext-strict-intake-domain-separators@1.json';
export const G32A_PACK_PATH =
  'contract-pack-g3.2a-feature-manifest-intake.json';

export const G32A_SOURCE_SCHEMA_HASH =
  'sha256:e47344ea2f4bebde3688f76b3450d5143adfd99ab4cc30eb6fc48a9d5a398e2d' as const;
export const G32A_PROFILE_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-profile:1\n';
export const G32A_PROFILE_SCHEMA_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-profile-schema:1\n';
export const G32A_RESULT_SCHEMA_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-result-schema:1\n';
export const G32A_POSITIVE_DOMAIN =
  'icarus:workflow-g3-2a-feature-manifest-intake-positive-cases:1\n';
export const G32A_NEGATIVE_DOMAIN =
  'icarus:workflow-g3-2a-feature-manifest-intake-negative-cases:1\n';
export const G32A_DOMAIN_CATALOG_DOMAIN =
  'icarus:workflow-feature-manifest-vnext-strict-intake-domain-separators:1\n';
export const G32A_PACK_DOMAIN =
  'icarus:workflow-contract-pack-g3-2a-feature-manifest-intake:1\n';

const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const REF_ID_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9._:/-]{0,253}[A-Za-z0-9])?$';
const REF_VERSION_PATTERN = '^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$';
const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const testHash = (hex: string): Sha256Hash => `sha256:${hex}` as Sha256Hash;

export class G32AContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'G32AContractError';
  }
}

function object(
  properties: Record<string, JsonValue>,
  required = Object.keys(properties),
): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
  };
}

function hashSchema(): JsonObject {
  return { type: 'string', pattern: HASH_PATTERN };
}

function refSchema(): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'version'],
    properties: {
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        pattern: REF_ID_PATTERN,
      },
      version: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: REF_VERSION_PATTERN,
        not: {
          anyOf: [
            {
              pattern:
                '^(?:[Cc][Uu][Rr][Rr][Ee][Nn][Tt]|[Hh][Ee][Aa][Dd]|[Ll][Aa][Tt][Ee][Ss][Tt]|[Mm][Aa][Ii][Nn]|[Mm][Aa][Ss][Tt][Ee][Rr]|[Nn][Ee][Xx][Tt]|[Ss][Nn][Aa][Pp][Ss][Hh][Oo][Tt])$',
            },
            { pattern: '(?:^|[._-])[xX](?:$|[._-])' },
          ],
        },
      },
    },
  };
}

function profileSchema(): JsonObject {
  return {
    $schema: DRAFT_2020_12,
    $id: 'https://icarus.local/schemas/feature-manifest-vnext-strict-intake-profile/1',
    title: 'Feature Manifest vNext Strict Intake Semantics Profile v1',
    ...object({
      format: { const: G32A_FEATURE_MANIFEST_PROFILE_FORMAT },
      source_manifest_format: { const: G32A_FEATURE_MANIFEST_FORMAT },
      source_manifest_schema_hash: hashSchema(),
      source_manifest_hash_domain: {
        const: 'icarus:feature-manifest-source:2\n',
      },
      feature_id_derivation: { type: 'string', minLength: 1 },
      ownership_predicate: { type: 'string', minLength: 1 },
      source_root_contract: { type: 'string', minLength: 1 },
      snapshot_contract: { type: 'string', minLength: 1 },
      ordering_contract: { type: 'string', minLength: 1 },
      error_precedence: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 1 },
      },
      reader_activation_phase: { const: 'root_snapshot_path_read' },
      resolver_activation_phase: { const: 'dependency_resolution' },
      manifest_hash_excludes: {
        type: 'array',
        const: ['manifest_hash'],
      },
      arrays_preserve_business_order: { const: true },
    }),
  };
}

function resultSchema(): JsonObject {
  const diagnostic = object({
    code: { enum: [...G32A_ERROR_CODES] },
    phase: { enum: [...G32A_PHASES] },
    pointer: { type: 'string' },
    detail: { type: 'string', minLength: 1 },
  });
  return {
    $schema: DRAFT_2020_12,
    $id: 'https://icarus.local/schemas/feature-manifest-vnext-strict-intake-result/1',
    title: 'Feature Manifest vNext Strict Intake Result v1',
    ...object({
      format: { const: G32A_FEATURE_MANIFEST_RESULT_FORMAT },
      outcome: { enum: ['accepted', 'rejected'] },
      code: { enum: [...G32A_ERROR_CODES] },
      phase: { enum: [...G32A_PHASES] },
      diagnostics: { type: 'array', minItems: 1, items: diagnostic },
      feature_id: {
        anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
      },
      manifest_hash: { anyOf: [hashSchema(), { type: 'null' }] },
      reader_invoked: { const: false },
      resolver_invoked: { const: false },
      root_snapshot_status: {
        enum: ['not_invoked', 'supplied_snapshot_verified'],
      },
      source_hash_status: { enum: ['not_invoked', 'verified'] },
      dependency_resolution_status: { enum: ['not_attempted', 'resolved'] },
    }),
  };
}

function profilePayload(): G32AProfilePayload {
  return {
    format: G32A_FEATURE_MANIFEST_PROFILE_FORMAT,
    source_manifest_format: G32A_FEATURE_MANIFEST_FORMAT,
    source_manifest_schema_hash: G32A_SOURCE_SCHEMA_HASH,
    source_manifest_hash_domain: 'icarus:feature-manifest-source:2\n',
    feature_id_derivation:
      'feature_ref.id MUST be <featureId>.feature; featureId is the exact prefix before the final .feature suffix, and is also namespace and registry_namespace.',
    ownership_predicate:
      'A dynamic resource is Feature-owned iff ref.id is exactly featureId + "." + a non-empty local id; dependencies may cross owner only through an exact immutable feature_release_ref and feature_release_hash pin.',
    source_root_contract:
      'feature_source_root MUST equal features/<featureId>; workflow_source_root MUST equal features/<featureId>/workflow-src; source_path is relative to feature_source_root and MUST begin workflow-src/.',
    snapshot_contract:
      'Symlink, hard-link, and moving-root are forbidden. A read-only snapshot records canonical root path plus lstat device/inode identities; root identity is compared before and after every read, each file is opened no-follow and fstat-compared, and duplicate device/inode entries are rejected.',
    ordering_contract:
      'Dependencies sort by (feature_release_ref.id, feature_release_ref.version, feature_release_hash); required_resource_refs sort by (id, version); dynamic_workflow_resources sort by (kind, ref.id, ref.version). Tuples use unsigned ASCII bytes and preserve array order in the hash.',
    error_precedence: [
      'strict bytes parse',
      'removed/unknown structural intake',
      'full closed schema',
      'manifest hash',
      'ownership, duplicate identity, order, and path lexical validation',
      'root snapshot/path read',
      'source hash',
      'dependency resolution',
    ],
    reader_activation_phase: 'root_snapshot_path_read',
    resolver_activation_phase: 'dependency_resolution',
    manifest_hash_excludes: ['manifest_hash'],
    arrays_preserve_business_order: true,
  };
}

function buildArtifact(
  format: string,
  refId: string,
  domainSeparator: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const artifact: ContractArtifactEnvelope = {
    format,
    ref: { id: refId, version: '1.0.0' },
    version: 1,
    domain_separator: domainSeparator,
    hash: testHash('0'.repeat(64)),
    payload,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function absolute(relativePath: string): string {
  const result = path.resolve(contractsRoot, relativePath);
  if (!result.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new G32AContractError(`Contract path escapes root: ${relativePath}`);
  }
  return result;
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

function assertExpected(relativePath: string, expected: JsonValue): void {
  const actual = fs.readFileSync(absolute(relativePath), 'utf8');
  if (actual !== render(expected)) {
    throw new G32AContractError(
      `${relativePath} is not generated byte-for-byte`,
    );
  }
}

function asciiCompare(left: string, right: string): number {
  const leftBytes = Buffer.from(left, 'ascii');
  const rightBytes = Buffer.from(right, 'ascii');
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] - rightBytes[index];
    }
  }
  return leftBytes.length - rightBytes.length;
}

function tupleCompare(
  left: readonly string[],
  right: readonly string[],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = asciiCompare(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function pointer(parts: readonly (string | number)[]): string {
  return parts.length === 0
    ? ''
    : `/${parts.map((part) => pointerToken(String(part))).join('/')}`;
}

function diagnostic(
  code: G32ADiagnostic['code'],
  phase: G32ADiagnostic['phase'],
  at: string,
  detail: string,
): G32ADiagnostic {
  return { code, phase, pointer: at, detail };
}

function rejected(
  code: G32ADiagnostic['code'],
  phase: G32ADiagnostic['phase'],
  detail: string,
  at = '',
  extra: Partial<G32AIntakeResult> = {},
): G32AIntakeResult {
  return {
    format: G32A_FEATURE_MANIFEST_RESULT_FORMAT,
    outcome: 'rejected',
    code,
    phase,
    diagnostics: [diagnostic(code, phase, at, detail)],
    feature_id: extra.feature_id ?? null,
    manifest_hash: extra.manifest_hash ?? null,
    reader_invoked: false,
    resolver_invoked: false,
    root_snapshot_status: extra.root_snapshot_status ?? 'not_invoked',
    source_hash_status: extra.source_hash_status ?? 'not_invoked',
    dependency_resolution_status:
      extra.dependency_resolution_status ?? 'not_attempted',
  };
}

type AnyRecord = Record<string, unknown>;

function structuralIssue(value: unknown): G32ADiagnostic | null {
  const removed: string[] = [];
  const unknown: string[] = [];
  const allowed: Record<string, readonly string[]> = {
    '': [
      'format',
      'feature_ref',
      'namespace',
      'owner_principal_ref',
      'dependencies',
      'package_resources',
      'extension_surfaces',
      'dynamic_workflow_resources',
      'ownership',
      'lifecycle',
      'manifest_hash',
    ],
    '/feature_ref': ['id', 'version'],
    '/package_resources': ['skills', 'agents', 'mcp', 'scripts', 'templates'],
    '/extension_surfaces': ['api_entry', 'nav_entry', 'renderer_entry'],
    '/ownership': [
      'feature_source_root',
      'workflow_source_root',
      'execution_bundle_owner',
      'registry_namespace',
    ],
    '/lifecycle': [
      'draining_policy_ref',
      'retention_policy_ref',
      'deletion_policy_ref',
    ],
    '/dependencies/*': [
      'feature_release_ref',
      'feature_release_hash',
      'required_resource_refs',
    ],
    '/dependencies/*/feature_release_ref': ['id', 'version'],
    '/dependencies/*/required_resource_refs/*': ['id', 'version'],
    '/dynamic_workflow_resources/*': [
      'kind',
      'ref',
      'source_path',
      'expected_source_hash',
    ],
    '/dynamic_workflow_resources/*/ref': ['id', 'version'],
    '/lifecycle/*': ['id', 'version'],
  };
  const allowedFor = (at: string): readonly string[] | undefined =>
    allowed[at] ?? allowed[at.replace(/\/\d+(?=\/|$)/g, '/*')];
  const visit = (current: unknown, at: string): void => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      if (Array.isArray(current))
        current.forEach((item, index) => visit(item, `${at}/${index}`));
      return;
    }
    const record = current as AnyRecord;
    const keys = Object.keys(record);
    for (const key of keys) {
      const child = at ? `${at}/${pointerToken(key)}` : `/${pointerToken(key)}`;
      if (
        G32A_REMOVED_RESOURCE_KEYS.includes(
          key as (typeof G32A_REMOVED_RESOURCE_KEYS)[number],
        )
      ) {
        removed.push(child);
      }
      const keySet = allowedFor(at);
      if (keySet && !keySet.includes(key)) unknown.push(child);
      visit(record[key], child);
    }
  };
  visit(value, '');
  if (removed.length > 0) {
    const at = [...removed].sort(asciiCompare)[0];
    return diagnostic(
      'feature_manifest_removed_resource_key',
      'removed_unknown_structural_intake',
      at,
      `Removed legacy resource key at ${at}`,
    );
  }
  if (unknown.length > 0) {
    const at = [...unknown].sort(asciiCompare)[0];
    return diagnostic(
      'feature_manifest_unknown_field',
      'removed_unknown_structural_intake',
      at,
      `Unknown manifest field at ${at}`,
    );
  }
  return null;
}

function sourceManifestValidator() {
  const schemaArtifact = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(sourceSchemaPath)),
  );
  if (
    schemaArtifact.format !== 'icarus.workflow-feature-manifest-v2-schema/1' ||
    schemaArtifact.hash !== G32A_SOURCE_SCHEMA_HASH
  ) {
    throw new G32AContractError('G0.3 Feature Manifest schema identity drift');
  }
  const ajv = new Ajv2020({ strict: true, allErrors: false });
  return ajv.compile(schemaArtifact.payload as AnySchema);
}

function asManifest(value: unknown): G32AFeatureManifest {
  assertJsonObject(value);
  return value as G32AFeatureManifest;
}

export function calculateG32AFeatureManifestHash(
  manifest: G32AFeatureManifest,
): Sha256Hash {
  const withoutHash = { ...manifest } as JsonObject;
  delete withoutHash.manifest_hash;
  return domainSeparatedSha256(G32A_SOURCE_MANIFEST_HASH_DOMAIN, withoutHash);
}

function featureId(manifest: G32AFeatureManifest): string | null {
  const id = manifest.feature_ref.id;
  return id.endsWith('.feature') ? id.slice(0, -'.feature'.length) : null;
}

function ownershipDiagnostic(
  manifest: G32AFeatureManifest,
  id: string,
): G32ADiagnostic | null {
  if (
    !id ||
    manifest.namespace !== id ||
    manifest.ownership.registry_namespace !== id
  ) {
    return diagnostic(
      'feature_manifest_ownership_invalid',
      'ownership_order_path_lexical_validation',
      '/namespace',
      'feature_ref.id must end in .feature and its prefix must equal namespace and registry_namespace',
    );
  }
  if (
    manifest.ownership.feature_source_root !== `features/${id}` ||
    manifest.ownership.workflow_source_root !== `features/${id}/workflow-src`
  ) {
    return diagnostic(
      'feature_manifest_ownership_invalid',
      'ownership_order_path_lexical_validation',
      '/ownership',
      'Feature source roots are not the canonical features/<featureId> and workflow-src roots',
    );
  }
  for (
    let index = 0;
    index < manifest.dynamic_workflow_resources.length;
    index += 1
  ) {
    const entry = manifest.dynamic_workflow_resources[index];
    if (
      !entry.ref.id.startsWith(`${id}.`) ||
      entry.ref.id.length <= id.length + 1
    ) {
      return diagnostic(
        'feature_manifest_ownership_invalid',
        'ownership_order_path_lexical_validation',
        `/dynamic_workflow_resources/${index}/ref/id`,
        'Feature-owned resource ref must be featureId.localId',
      );
    }
  }
  return null;
}

function pathDiagnostic(
  manifest: G32AFeatureManifest,
  entry: G32AResourceEntry,
  index: number,
): G32ADiagnostic | null {
  const value = entry.source_path;
  const at = `/dynamic_workflow_resources/${index}/source_path`;
  if (
    value.length === 0 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/.test(value) ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    return diagnostic(
      'feature_manifest_path_invalid',
      'ownership_order_path_lexical_validation',
      at,
      'source_path must be a relative POSIX path',
    );
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    segments[0] !== 'workflow-src'
  ) {
    return diagnostic(
      'feature_manifest_path_invalid',
      'ownership_order_path_lexical_validation',
      at,
      'source_path must remain below workflow-src without empty, dot, or parent segments',
    );
  }
  const resolved = `${manifest.ownership.feature_source_root}/${value}`;
  if (!resolved.startsWith(`${manifest.ownership.workflow_source_root}/`)) {
    return diagnostic(
      'feature_manifest_path_invalid',
      'ownership_order_path_lexical_validation',
      at,
      'source_path escapes workflow_source_root',
    );
  }
  return null;
}

function validateOrdering(
  manifest: G32AFeatureManifest,
): G32ADiagnostic | null {
  const dependencyKeys = manifest.dependencies.map(
    (dependency) =>
      [
        dependency.feature_release_ref.id,
        dependency.feature_release_ref.version,
        dependency.feature_release_hash,
      ] as const,
  );
  const dependencyIdentityKeys = manifest.dependencies.map(
    (dependency) =>
      [
        dependency.feature_release_ref.id,
        dependency.feature_release_ref.version,
      ] as const,
  );
  const requiredKeys = manifest.dependencies.flatMap(
    (dependency, dependencyIndex) =>
      dependency.required_resource_refs.map((ref, resourceIndex) => ({
        key: [ref.id, ref.version] as const,
        at: `/dependencies/${dependencyIndex}/required_resource_refs/${resourceIndex}`,
      })),
  );
  const resourceKeys = manifest.dynamic_workflow_resources.map(
    (entry) => [entry.kind, entry.ref.id, entry.ref.version] as const,
  );
  const duplicate = (keys: readonly (readonly string[])[]): number => {
    const seen = new Set<string>();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index].join('\u0000');
      if (seen.has(key)) return index;
      seen.add(key);
    }
    return -1;
  };
  const dependencyDuplicate = duplicate(dependencyIdentityKeys);
  if (dependencyDuplicate >= 0) {
    return diagnostic(
      'feature_manifest_dependency_identity_duplicate',
      'ownership_order_path_lexical_validation',
      `/dependencies/${dependencyDuplicate}/feature_release_ref`,
      'Duplicate dependency identity',
    );
  }
  const requiredDuplicate = duplicate(requiredKeys.map((item) => item.key));
  if (requiredDuplicate >= 0) {
    return diagnostic(
      'feature_manifest_required_resource_identity_duplicate',
      'ownership_order_path_lexical_validation',
      requiredKeys[requiredDuplicate].at,
      'Duplicate required resource identity',
    );
  }
  const resourceDuplicate = duplicate(resourceKeys);
  if (resourceDuplicate >= 0) {
    return diagnostic(
      'feature_manifest_dynamic_resource_identity_duplicate',
      'ownership_order_path_lexical_validation',
      `/dynamic_workflow_resources/${resourceDuplicate}/ref`,
      'Duplicate dynamic resource identity',
    );
  }
  for (let index = 1; index < dependencyKeys.length; index += 1) {
    if (tupleCompare(dependencyKeys[index - 1], dependencyKeys[index]) > 0) {
      return diagnostic(
        'feature_manifest_dependency_order_invalid',
        'ownership_order_path_lexical_validation',
        `/dependencies/${index}`,
        'Dependencies must use the frozen ASCII tuple order',
      );
    }
  }
  for (const [dependencyIndex, dependency] of manifest.dependencies.entries()) {
    const keys = dependency.required_resource_refs.map(
      (ref) => [ref.id, ref.version] as const,
    );
    for (let index = 1; index < keys.length; index += 1) {
      if (tupleCompare(keys[index - 1], keys[index]) > 0) {
        return diagnostic(
          'feature_manifest_required_resource_order_invalid',
          'ownership_order_path_lexical_validation',
          `/dependencies/${dependencyIndex}/required_resource_refs/${index}`,
          'Required resource refs must use the frozen ASCII tuple order',
        );
      }
    }
  }
  for (let index = 1; index < resourceKeys.length; index += 1) {
    if (tupleCompare(resourceKeys[index - 1], resourceKeys[index]) > 0) {
      return diagnostic(
        'feature_manifest_dynamic_resource_order_invalid',
        'ownership_order_path_lexical_validation',
        `/dynamic_workflow_resources/${index}`,
        'Dynamic resources must use the frozen (kind, ref.id, ref.version) ASCII tuple order',
      );
    }
  }
  return null;
}

function identityHash(identity: G32AFileIdentity): Sha256Hash {
  return domainSeparatedSha256(G32A_ROOT_IDENTITY_DOMAIN, identity);
}

function validateObservations(
  manifest: G32AFeatureManifest,
  observations: G32AIntakeObservations,
  id: string,
): G32AIntakeResult | null {
  const snapshot = observations.root_snapshot;
  if (snapshot === null) {
    if (observations.dependency_resolution === 'unresolved') {
      return rejected(
        'feature_manifest_dependency_unresolved',
        'dependency_resolution',
        'Dependency resolution was supplied as unresolved',
        '',
        { feature_id: id },
      );
    }
    return null;
  }
  if (snapshot.symlink) {
    return rejected(
      'feature_manifest_source_root_symlink',
      'root_snapshot_path_read',
      'Source root is a symlink',
      '',
      { feature_id: id },
    );
  }
  if (
    snapshot.kind !== 'directory' ||
    snapshot.root_identity_before !== snapshot.root_identity_after
  ) {
    return rejected(
      'feature_manifest_source_root_moved',
      'root_snapshot_path_read',
      'Root identity changed or root is not a directory',
      '',
      { feature_id: id },
    );
  }
  if (snapshot.canonical_root_path !== manifest.ownership.feature_source_root) {
    return rejected(
      'feature_manifest_source_path_drift',
      'root_snapshot_path_read',
      'Snapshot root path is not the canonical feature source root',
      '/ownership/feature_source_root',
      { feature_id: id },
    );
  }
  const entriesByPath = new Map<
    string,
    NonNullable<G32AIntakeObservations['root_snapshot']>['entries'][number]
  >();
  const identities = new Set<string>();
  for (const entry of snapshot.entries) {
    if (entry.symlink || entry.kind !== 'regular_file') {
      return rejected(
        'feature_manifest_source_path_symlink',
        'root_snapshot_path_read',
        'Source entry is not a regular non-symlink file',
        `/source_snapshot/${entry.source_path}`,
        { feature_id: id },
      );
    }
    const identity = identityHash(entry.identity);
    if (identities.has(identity)) {
      return rejected(
        'feature_manifest_source_hard_link',
        'root_snapshot_path_read',
        'Two source paths share one device/inode identity',
        `/source_snapshot/${entry.source_path}`,
        { feature_id: id },
      );
    }
    identities.add(identity);
    entriesByPath.set(entry.source_path, entry);
  }
  for (
    let index = 0;
    index < manifest.dynamic_workflow_resources.length;
    index += 1
  ) {
    const resource = manifest.dynamic_workflow_resources[index];
    const entry = entriesByPath.get(resource.source_path);
    if (!entry) {
      return rejected(
        'feature_manifest_source_path_drift',
        'root_snapshot_path_read',
        'Manifest source path is absent from the supplied snapshot',
        `/dynamic_workflow_resources/${index}/source_path`,
        { feature_id: id },
      );
    }
    if (entry.content_hash !== resource.expected_source_hash) {
      return rejected(
        'feature_manifest_source_hash_mismatch',
        'source_hash',
        'Source content hash does not match expected_source_hash',
        `/dynamic_workflow_resources/${index}/expected_source_hash`,
        { feature_id: id, root_snapshot_status: 'supplied_snapshot_verified' },
      );
    }
  }
  if (observations.dependency_resolution === 'unresolved') {
    return rejected(
      'feature_manifest_dependency_unresolved',
      'dependency_resolution',
      'Dependency resolution was supplied as unresolved',
      '',
      {
        feature_id: id,
        root_snapshot_status: 'supplied_snapshot_verified',
        source_hash_status: 'verified',
      },
    );
  }
  return null;
}

export function evaluateG32AFeatureManifest(
  value: unknown,
  observations: G32AIntakeObservations = {
    root_snapshot: null,
    dependency_resolution: 'not_attempted',
  },
): G32AIntakeResult {
  const structural = structuralIssue(value);
  if (structural)
    return rejected(
      structural.code,
      structural.phase,
      structural.detail,
      structural.pointer,
    );
  const validator = sourceManifestValidator();
  if (!validator(value)) {
    const error = validator.errors?.[0];
    return rejected(
      'feature_manifest_schema_invalid',
      'full_closed_schema',
      error?.message ?? 'Feature Manifest vNext schema validation failed',
      error?.instancePath ?? '',
    );
  }
  const manifest = asManifest(value);
  const id = featureId(manifest);
  const manifestHash = manifest.manifest_hash;
  const expectedHash = calculateG32AFeatureManifestHash(manifest);
  if (manifestHash !== expectedHash) {
    return rejected(
      'feature_manifest_hash_mismatch',
      'manifest_hash',
      `manifest_hash must equal ${expectedHash}`,
      '/manifest_hash',
      { feature_id: id, manifest_hash: manifestHash },
    );
  }
  if (!id)
    return rejected(
      'feature_manifest_ownership_invalid',
      'ownership_order_path_lexical_validation',
      'feature_ref.id must use the <featureId>.feature form',
      '/feature_ref/id',
      { manifest_hash: manifestHash },
    );
  const ownership = ownershipDiagnostic(manifest, id);
  if (ownership)
    return rejected(
      ownership.code,
      ownership.phase,
      ownership.detail,
      ownership.pointer,
      { feature_id: id, manifest_hash: manifestHash },
    );
  const ordering = validateOrdering(manifest);
  if (ordering)
    return rejected(
      ordering.code,
      ordering.phase,
      ordering.detail,
      ordering.pointer,
      { feature_id: id, manifest_hash: manifestHash },
    );
  for (
    let index = 0;
    index < manifest.dynamic_workflow_resources.length;
    index += 1
  ) {
    const pathIssue = pathDiagnostic(
      manifest,
      manifest.dynamic_workflow_resources[index],
      index,
    );
    if (pathIssue)
      return rejected(
        pathIssue.code,
        pathIssue.phase,
        pathIssue.detail,
        pathIssue.pointer,
        { feature_id: id, manifest_hash: manifestHash },
      );
  }
  const observationResult = validateObservations(manifest, observations, id);
  if (observationResult) {
    observationResult.manifest_hash = manifestHash;
    return observationResult;
  }
  const supplied = observations.root_snapshot !== null;
  const resolved = observations.dependency_resolution === 'resolved';
  return {
    format: G32A_FEATURE_MANIFEST_RESULT_FORMAT,
    outcome: 'accepted',
    code: 'feature_manifest_intake_ok',
    phase: resolved
      ? 'dependency_resolution'
      : supplied
        ? 'source_hash'
        : 'ownership_order_path_lexical_validation',
    diagnostics: [
      diagnostic(
        'feature_manifest_intake_ok',
        resolved
          ? 'dependency_resolution'
          : supplied
            ? 'source_hash'
            : 'ownership_order_path_lexical_validation',
        '',
        'All G3.2A semantic checks passed; no source reader or Registry operation was invoked',
      ),
    ],
    feature_id: id,
    manifest_hash: manifestHash,
    reader_invoked: false,
    resolver_invoked: false,
    root_snapshot_status: supplied
      ? 'supplied_snapshot_verified'
      : 'not_invoked',
    source_hash_status: supplied ? 'verified' : 'not_invoked',
    dependency_resolution_status: resolved ? 'resolved' : 'not_attempted',
  };
}

function parserErrorResult(error: unknown): G32AIntakeResult {
  const code = error as { code?: string; pointer?: string };
  const mapped: Record<string, G32ADiagnostic['code']> = {
    json_syntax_invalid: 'feature_manifest_json_syntax_invalid',
    json_duplicate_key: 'feature_manifest_json_duplicate_key',
    json_unsafe_integer: 'feature_manifest_json_unsafe_integer',
    json_invalid_unicode: 'feature_manifest_json_invalid_unicode',
    json_non_finite_number: 'feature_manifest_json_non_finite_number',
  };
  const resultCode =
    mapped[code.code ?? ''] ?? 'feature_manifest_json_syntax_invalid';
  return rejected(
    resultCode,
    'strict_bytes_parse',
    error instanceof Error ? error.message : String(error),
    code.pointer ?? '',
  );
}

export function parseAndEvaluateG32AFeatureManifest(
  bytes: Uint8Array,
  observations?: G32AIntakeObservations,
): G32AIntakeResult {
  try {
    return evaluateG32AFeatureManifest(
      strictParseJsonBytes(bytes),
      observations,
    );
  } catch (error) {
    return parserErrorResult(error);
  }
}

function baseManifest(): G32AFeatureManifest {
  const manifest: G32AFeatureManifest = {
    format: G32A_FEATURE_MANIFEST_FORMAT,
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
    dynamic_workflow_resources: [
      {
        kind: 'definition',
        ref: { id: 'example.workflow', version: '1.0.0' },
        source_path: 'workflow-src/ab/example.workflow.json',
        expected_source_hash: testHash('1'.repeat(64)),
      },
    ],
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
    manifest_hash: testHash('0'.repeat(64)),
  };
  manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
  return manifest;
}

function observationsFor(
  manifest: G32AFeatureManifest,
): G32AIntakeObservations {
  return {
    root_snapshot: {
      canonical_root_path: manifest.ownership.feature_source_root,
      root_identity_before: testHash('2'.repeat(64)),
      root_identity_after: testHash('2'.repeat(64)),
      kind: 'directory',
      symlink: false,
      entries: manifest.dynamic_workflow_resources.map((resource, index) => ({
        source_path: resource.source_path,
        identity: { device: 'dev-1', inode: `ino-${index + 1}` },
        kind: 'regular_file',
        symlink: false,
        content_hash: resource.expected_source_hash,
      })),
    },
    dependency_resolution: 'resolved',
  };
}

function mutateManifest(
  source: G32AFeatureManifest,
  mutate: (manifest: G32AFeatureManifest) => void,
): string {
  const manifest = structuredClone(source) as G32AFeatureManifest;
  mutate(manifest);
  return JSON.stringify(manifest);
}

function insertTopLevelField(json: string, key: string): string {
  const insertion = `,"${key}":[]`;
  return `${json.slice(0, -1)}${insertion}}`;
}

function fixtureCases(): {
  positive: G32AIntakeResult[];
  negative: G32AIntakeResult[];
  positiveCases: JsonObject[];
  negativeCases: JsonObject[];
} {
  const valid = baseManifest();
  const validText = JSON.stringify(valid);
  const positiveSpecs = [
    {
      case_id: 'valid-g0.3-example-ownership-and-snapshot',
      input_text: validText,
      observations: observationsFor(valid),
    },
    {
      case_id: 'valid-no-reader-or-registry-side-effect',
      input_text: validText,
      observations: {
        root_snapshot: null,
        dependency_resolution: 'not_attempted' as const,
      },
    },
  ];
  const negativeSpecs: Array<{
    case_id: string;
    input_text: string;
    observations: G32AIntakeObservations;
  }> = [
    {
      case_id: 'precedence-duplicate-key-before-unknown-and-hash',
      input_text:
        '{"format":"icarus.feature-manifest/2","format":"icarus.feature-manifest/2"}',
      observations: {
        root_snapshot: null,
        dependency_resolution: 'not_attempted',
      },
    },
    {
      case_id: 'precedence-removed-before-unknown',
      input_text: insertTopLevelField(
        insertTopLevelField(validText, 'workflowDefinitions'),
        'unexpected',
      ),
      observations: {
        root_snapshot: null,
        dependency_resolution: 'not_attempted',
      },
    },
    {
      case_id: 'unknown-field-before-schema',
      input_text: insertTopLevelField(validText, 'unexpected'),
      observations: {
        root_snapshot: null,
        dependency_resolution: 'not_attempted',
      },
    },
    {
      case_id: 'nested-unknown-field-before-schema',
      input_text: validText.replace(
        '"expected_source_hash":',
        '"unexpected":[],"expected_source_hash":',
      ),
      observations: {
        root_snapshot: null,
        dependency_resolution: 'not_attempted',
      },
    },
    {
      case_id: 'hash-before-ownership-order-path',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.manifest_hash = testHash('f'.repeat(64));
        manifest.namespace = 'wrong';
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'ownership-before-order-and-path',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.namespace = 'wrong';
        manifest.dynamic_workflow_resources.reverse();
        manifest.dynamic_workflow_resources[0].source_path = 'wrong/path.json';
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'dependency-order-drift',
      input_text: mutateManifest(valid, (manifest) => {
        const first: G32ADependency = {
          feature_release_ref: { id: 'z.dep', version: '1.0.0' },
          feature_release_hash: testHash('3'.repeat(64)),
          required_resource_refs: [{ id: 'z.resource', version: '1.0.0' }],
        };
        const second: G32ADependency = {
          feature_release_ref: { id: 'a.dep', version: '1.0.0' },
          feature_release_hash: testHash('4'.repeat(64)),
          required_resource_refs: [{ id: 'a.resource', version: '1.0.0' }],
        };
        manifest.dependencies = [first, second];
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'required-resource-order-drift',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.dependencies = [
          {
            feature_release_ref: { id: 'owner.dep', version: '1.0.0' },
            feature_release_hash: testHash('5'.repeat(64)),
            required_resource_refs: [
              { id: 'z.resource', version: '1.0.0' },
              { id: 'a.resource', version: '1.0.0' },
            ],
          },
        ];
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'dynamic-resource-order-drift',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.dynamic_workflow_resources.push({
          kind: 'recipe',
          ref: { id: 'example.recipe', version: '1.0.0' },
          source_path: 'workflow-src/recipe.json',
          expected_source_hash: testHash('6'.repeat(64)),
        });
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'duplicate-dynamic-resource-identity',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.dynamic_workflow_resources.push({
          kind: 'definition',
          ref: { id: 'example.workflow', version: '1.0.0' },
          source_path: 'workflow-src/other.json',
          expected_source_hash: testHash('a'.repeat(64)),
        });
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'duplicate-dependency-identity',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.dependencies = [
          {
            feature_release_ref: { id: 'owner.dep', version: '1.0.0' },
            feature_release_hash: testHash('b'.repeat(64)),
            required_resource_refs: [],
          },
          {
            feature_release_ref: { id: 'owner.dep', version: '1.0.0' },
            feature_release_hash: testHash('c'.repeat(64)),
            required_resource_refs: [],
          },
        ];
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'duplicate-required-resource-identity',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.dependencies = [
          {
            feature_release_ref: { id: 'owner.dep', version: '1.0.0' },
            feature_release_hash: testHash('d'.repeat(64)),
            required_resource_refs: [
              { id: 'owner.resource', version: '1.0.0' },
              { id: 'owner.resource', version: '1.0.0' },
            ],
          },
        ];
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'path-rejects-platform-separator',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.dynamic_workflow_resources[0].source_path =
          'workflow-src\\file.json';
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: observationsFor(valid),
    },
    {
      case_id: 'moving-root-after-lexical-validation',
      input_text: validText,
      observations: {
        ...observationsFor(valid),
        root_snapshot: {
          ...observationsFor(valid).root_snapshot!,
          root_identity_after: testHash('7'.repeat(64)),
        },
      },
    },
    {
      case_id: 'symlink-root-rejected-before-path-read',
      input_text: validText,
      observations: {
        ...observationsFor(valid),
        root_snapshot: {
          ...observationsFor(valid).root_snapshot!,
          symlink: true,
        },
      },
    },
    {
      case_id: 'hard-link-rejected-before-source-hash',
      input_text: mutateManifest(valid, (manifest) => {
        manifest.dynamic_workflow_resources.push({
          kind: 'recipe',
          ref: { id: 'example.recipe', version: '1.0.0' },
          source_path: 'workflow-src/recipe.json',
          expected_source_hash: testHash('8'.repeat(64)),
        });
        manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
      }),
      observations: {
        ...observationsFor(valid),
        root_snapshot: {
          ...observationsFor(valid).root_snapshot!,
          entries: [
            ...observationsFor(valid).root_snapshot!.entries,
            {
              source_path: 'workflow-src/recipe.json',
              identity: { device: 'dev-1', inode: 'ino-1' },
              kind: 'regular_file',
              symlink: false,
              content_hash: testHash('8'.repeat(64)),
            },
          ],
        },
      },
    },
    {
      case_id: 'source-hash-drift-after-path-read',
      input_text: validText,
      observations: {
        ...observationsFor(valid),
        root_snapshot: {
          ...observationsFor(valid).root_snapshot!,
          entries: [
            {
              ...observationsFor(valid).root_snapshot!.entries[0],
              content_hash: testHash('9'.repeat(64)),
            },
          ],
        },
      },
    },
    {
      case_id: 'dependency-resolution-last',
      input_text: validText,
      observations: {
        root_snapshot: null,
        dependency_resolution: 'unresolved',
      },
    },
  ];
  const positiveCases = positiveSpecs.map((spec) => ({
    case_id: spec.case_id,
    input_text: spec.input_text,
    observations: spec.observations,
    expected: evaluateG32AFeatureManifest(
      strictParseJsonBytes(Buffer.from(spec.input_text)),
      spec.observations,
    ),
  }));
  const negativeCases = negativeSpecs.map((spec) => ({
    case_id: spec.case_id,
    input_text: spec.input_text,
    observations: spec.observations,
    expected: parseAndEvaluateG32AFeatureManifest(
      Buffer.from(spec.input_text),
      spec.observations,
    ),
  }));
  return {
    positive: positiveCases.map((item) => item.expected as G32AIntakeResult),
    negative: negativeCases.map((item) => item.expected as G32AIntakeResult),
    positiveCases,
    negativeCases,
  };
}

function schemaArtifact(
  relativePath: string,
  format: string,
  refId: string,
  domain: string,
  schema: JsonObject,
): [string, ContractArtifactEnvelope] {
  return [relativePath, buildArtifact(format, refId, domain, schema)];
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const fixtures = fixtureCases();
  const positive = buildArtifact(
    'icarus.workflow-g3-2a-feature-manifest-intake-positive-cases/1',
    'icarus.workflow-g3-2a-feature-manifest-intake-positive-cases',
    G32A_POSITIVE_DOMAIN,
    { cases: fixtures.positiveCases as unknown as JsonValue },
  );
  const negative = buildArtifact(
    'icarus.workflow-g3-2a-feature-manifest-intake-negative-cases/1',
    'icarus.workflow-g3-2a-feature-manifest-intake-negative-cases',
    G32A_NEGATIVE_DOMAIN,
    { cases: fixtures.negativeCases as unknown as JsonValue },
  );
  const profile = buildArtifact(
    G32A_FEATURE_MANIFEST_PROFILE_FORMAT,
    'icarus.workflow-feature-manifest-vnext-strict-intake-profile',
    G32A_PROFILE_DOMAIN,
    profilePayload(),
  );
  const profileSchemaArtifact = schemaArtifact(
    G32A_PROFILE_SCHEMA_PATH,
    G32A_FEATURE_MANIFEST_PROFILE_SCHEMA_FORMAT,
    'icarus.workflow-feature-manifest-vnext-strict-intake-profile-schema',
    G32A_PROFILE_SCHEMA_DOMAIN,
    profileSchema(),
  )[1];
  const resultSchemaArtifact = schemaArtifact(
    G32A_RESULT_SCHEMA_PATH,
    G32A_FEATURE_MANIFEST_RESULT_SCHEMA_FORMAT,
    'icarus.workflow-feature-manifest-vnext-strict-intake-result-schema',
    G32A_RESULT_SCHEMA_DOMAIN,
    resultSchema(),
  )[1];
  const domainCatalog = buildArtifact(
    'icarus.workflow-feature-manifest-vnext-strict-intake-domain-separators/1',
    'icarus.workflow-feature-manifest-vnext-strict-intake-domain-separators',
    G32A_DOMAIN_CATALOG_DOMAIN,
    {
      entries: [
        {
          format: G32A_FEATURE_MANIFEST_PROFILE_SCHEMA_FORMAT,
          domain_separator: G32A_PROFILE_SCHEMA_DOMAIN,
        },
        {
          format: G32A_FEATURE_MANIFEST_RESULT_SCHEMA_FORMAT,
          domain_separator: G32A_RESULT_SCHEMA_DOMAIN,
        },
        {
          format: G32A_FEATURE_MANIFEST_PROFILE_FORMAT,
          domain_separator: G32A_PROFILE_DOMAIN,
        },
        {
          format:
            'icarus.workflow-g3-2a-feature-manifest-intake-positive-cases/1',
          domain_separator: G32A_POSITIVE_DOMAIN,
        },
        {
          format:
            'icarus.workflow-g3-2a-feature-manifest-intake-negative-cases/1',
          domain_separator: G32A_NEGATIVE_DOMAIN,
        },
        {
          format:
            'icarus.workflow-feature-manifest-vnext-strict-intake-domain-separators/1',
          domain_separator: G32A_DOMAIN_CATALOG_DOMAIN,
        },
        {
          format:
            'icarus.workflow-contract-pack-g3-2a-feature-manifest-intake/1',
          domain_separator: G32A_PACK_DOMAIN,
        },
      ].sort((left, right) =>
        asciiCompare(String(left.format), String(right.format)),
      ),
    },
  );
  const packPayload: JsonObject = {
    gate: 'G3.2A',
    status: 'feature_manifest_vnext_strict_intake_semantics_frozen',
    source_manifest_schema_hash: G32A_SOURCE_SCHEMA_HASH,
    profile_hash: profile.hash,
    profile_schema_hash: profileSchemaArtifact.hash,
    result_schema_hash: resultSchemaArtifact.hash,
    positive_cases_hash: positive.hash,
    negative_cases_hash: negative.hash,
    domain_catalog_hash: domainCatalog.hash,
    positive_case_count: fixtures.positiveCases.length,
    negative_case_count: fixtures.negativeCases.length,
    reader_invoked: false,
    registry_write_performed: false,
    publisher_executed: false,
    activation_performed: false,
    g32_status: 'DONE',
    g3_status: 'IN_PROGRESS',
    g3_2_strict_intake_implementation: 'READY',
    g4_through_g9_status: 'NOT_READY',
  };
  const pack = buildArtifact(
    'icarus.workflow-contract-pack-g3-2a-feature-manifest-intake/1',
    'icarus.workflow-contract-pack-g3-2a-feature-manifest-intake',
    G32A_PACK_DOMAIN,
    packPayload,
  );
  return [
    [G32A_PROFILE_PATH, profile],
    [G32A_PROFILE_SCHEMA_PATH, profileSchemaArtifact],
    [G32A_RESULT_SCHEMA_PATH, resultSchemaArtifact],
    [G32A_POSITIVE_CASES_PATH, positive],
    [G32A_NEGATIVE_CASES_PATH, negative],
    [G32A_DOMAIN_CATALOG_PATH, domainCatalog],
    [G32A_PACK_PATH, pack],
  ];
}

export function generateG32AFeatureManifestIntake(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  for (const [relativePath, artifact] of artifacts)
    writeAtomic(relativePath, artifact);
  return artifacts.find(
    ([relativePath]) => relativePath === G32A_PACK_PATH,
  )![1];
}

export function checkG32AFeatureManifestIntake(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  for (const [relativePath, expected] of artifacts) {
    const actual = readArtifact(relativePath);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new G32AContractError(`${relativePath} identity or payload drift`);
    }
    assertExpected(relativePath, expected);
  }
  const pack = artifacts.find(
    ([relativePath]) => relativePath === G32A_PACK_PATH,
  )![1];
  return pack;
}

export function g32aFeatureManifestIntakeFixturesForTest(): {
  positive: Array<{
    case_id: string;
    input_text: string;
    observations: G32AIntakeObservations;
    expected: G32AIntakeResult;
  }>;
  negative: Array<{
    case_id: string;
    input_text: string;
    observations: G32AIntakeObservations;
    expected: G32AIntakeResult;
  }>;
} {
  const fixtures = fixtureCases();
  return {
    positive: fixtures.positiveCases as never,
    negative: fixtures.negativeCases as never,
  };
}

export const G32A_PROFILE_SCHEMA = profileSchema();
export const G32A_RESULT_SCHEMA = resultSchema();
