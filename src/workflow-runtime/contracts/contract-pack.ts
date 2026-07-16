import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  Ajv2020,
  type AnySchema,
  type ValidateFunction,
} from 'ajv/dist/2020.js';

import {
  CONTRACT_ARTIFACT_FORMAT_PATTERN,
  CONTRACT_ARTIFACT_ENVELOPE_KEYS,
  ContractArtifactError,
  parseContractArtifactEnvelope,
} from './artifact.js';
import {
  DOMAIN_SEPARATOR_PATTERN,
  HASH_ALGORITHM,
  JCS_CANONICALIZER_PACKAGE,
  JCS_CANONICALIZER_VERSION,
  SHA256_HASH_PATTERN,
  ContractHashError,
  calculateArtifactHash,
  canonicalJson,
  domainSeparatedSha256,
} from './hash.js';
import {
  StrictJsonError,
  STRICT_JSON_PARSER_PACKAGE,
  STRICT_JSON_PARSER_VERSION,
  STRICT_JSON_PARSE_OPTIONS,
  assertJsonObject,
  strictParseJsonBytes,
} from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import {
  VERSIONED_REF_ID_PATTERN,
  VERSIONED_REF_KEYS,
  VERSIONED_REF_MUTABLE_VERSIONS,
  VERSIONED_REF_VERSION_PATTERN,
  VersionedRefError,
  parseVersionedRef,
} from './versioned-ref.js';

const contractsRoot = import.meta.dirname;
const projectRoot = path.resolve(contractsRoot, '..', '..', '..');

const foundationArtifactPaths = [
  'foundation/artifact-envelope-schema.json',
  'foundation/versioned-ref-schema.json',
  'foundation/strict-json-profile.json',
  'foundation/canonical-hash-profile.json',
  'catalogs/foundation-domain-separators.json',
  'conformance/foundation/hash-vectors.json',
  'conformance/foundation/negative-cases.json',
] as const;

const foundationManifestPath = 'contract-pack-foundation.json';

const foundationReservedDirectories = [
  'schemas',
  'protocols',
  'safety',
  'sqlite',
  'conformance/draft',
  'conformance/sealed',
] as const;

const stillReservedDirectories = ['conformance/sealed'] as const;

const g01DirectPackages = [
  {
    package_name: '@types/better-sqlite3',
    dependency_kind: 'dev',
    exact_version: '7.6.13',
  },
  {
    package_name: '@types/node',
    dependency_kind: 'dev',
    exact_version: '26.1.1',
  },
  {
    package_name: 'ajv',
    dependency_kind: 'runtime',
    exact_version: '8.20.0',
  },
  {
    package_name: 'ajv-formats',
    dependency_kind: 'runtime',
    exact_version: '3.0.1',
  },
  {
    package_name: 'better-sqlite3',
    dependency_kind: 'runtime',
    exact_version: '12.11.1',
  },
  {
    package_name: 'fast-check',
    dependency_kind: 'dev',
    exact_version: '4.9.0',
  },
  {
    package_name: 'json-canonicalize',
    dependency_kind: 'runtime',
    exact_version: '2.0.0',
  },
  {
    package_name: 'jsonc-parser',
    dependency_kind: 'runtime',
    exact_version: '3.3.1',
  },
] as const;

interface ArtifactDescriptor extends JsonObject {
  path: string;
  format: string;
  ref: JsonObject;
  version: number;
  domain_separator: string;
  hash: Sha256Hash;
}

function absoluteContractPath(relativePath: string): string {
  const absolute = path.resolve(contractsRoot, relativePath);
  if (!absolute.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(`Contract path escapes root: ${relativePath}`);
  }
  return absolute;
}

function readContractBytes(relativePath: string): Buffer {
  const absolute = absoluteContractPath(relativePath);
  if (!fs.lstatSync(absolute).isFile()) {
    throw new Error(`Contract path is not a regular file: ${relativePath}`);
  }
  return fs.readFileSync(absolute);
}

function readJsonObject(relativePath: string): JsonObject {
  const value = strictParseJsonBytes(readContractBytes(relativePath));
  assertJsonObject(value);
  return value;
}

function sha256Bytes(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto
    .createHash(HASH_ALGORITHM)
    .update(bytes)
    .digest('hex')}`;
}

function renderJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(file: string, contents: string): void {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, file);
}

function refreshedHashVectors(value: JsonObject): JsonObject {
  if (value.format !== 'icarus.workflow-contract-hash-vectors/1') return value;
  assertJsonObject(value.payload);
  const cases = value.payload.cases;
  if (!Array.isArray(cases))
    throw new Error('Hash vectors cases must be an array');

  const refreshedCases = cases.map((testCase) => {
    assertJsonObject(testCase);
    if (
      typeof testCase.case_id !== 'string' ||
      typeof testCase.domain_separator !== 'string' ||
      typeof testCase.canonical_json !== 'string'
    ) {
      throw new Error('Hash vector has an invalid shape');
    }
    const actualCanonical = canonicalJson(testCase.input);
    if (actualCanonical !== testCase.canonical_json) {
      throw new Error(
        `Hand-authored canonical JSON drift in ${testCase.case_id}`,
      );
    }
    return {
      ...testCase,
      expected_hash: domainSeparatedSha256(
        testCase.domain_separator,
        testCase.input,
      ),
    } satisfies JsonObject;
  });
  return {
    ...value,
    payload: {
      ...value.payload,
      cases: refreshedCases,
    },
  };
}

function refreshedNegativeCases(value: JsonObject): JsonObject {
  if (value.format !== 'icarus.workflow-contract-foundation-negative-cases/1') {
    return value;
  }
  assertJsonObject(value.payload);
  const cases = value.payload.cases;
  if (!Array.isArray(cases)) {
    throw new Error('Negative fixture cases must be an array');
  }
  return {
    ...value,
    payload: {
      ...value.payload,
      cases: cases.map((testCase) => {
        assertJsonObject(testCase);
        if (
          typeof testCase.case_id !== 'string' ||
          typeof testCase.path !== 'string' ||
          typeof testCase.expected_error !== 'string'
        ) {
          throw new Error('Negative fixture case has an invalid shape');
        }
        return {
          case_id: testCase.case_id,
          path: testCase.path,
          expected_error: testCase.expected_error,
          source_sha256: sha256Bytes(readContractBytes(testCase.path)),
        } satisfies JsonObject;
      }),
    },
  };
}

function refreshArtifact(value: JsonObject): ContractArtifactEnvelope {
  const withVectors = refreshedHashVectors(value);
  const withNegativeCases = refreshedNegativeCases(withVectors);
  const parsed = parseContractArtifactEnvelope(withNegativeCases, {
    verifyHash: false,
  });
  const refreshed: ContractArtifactEnvelope = {
    ...parsed,
    hash: calculateArtifactHash(parsed),
  };
  parseContractArtifactEnvelope(refreshed);
  return refreshed;
}

function descriptor(
  relativePath: string,
  artifact: ContractArtifactEnvelope,
): ArtifactDescriptor {
  return {
    path: relativePath,
    format: artifact.format,
    ref: artifact.ref,
    version: artifact.version,
    domain_separator: artifact.domain_separator,
    hash: artifact.hash,
  };
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function verifyG01ToolchainArtifacts(): ArtifactDescriptor[] {
  const distributionPath = 'toolchain/node-v26.5.0-darwin-arm64.json';
  const compilerInputsPath = 'toolchain/compiler-toolchain-inputs.json';
  const schemaPath = 'toolchain/managed-node-runtime-distribution.schema.json';
  const distribution = readJsonObject(distributionPath);
  const compilerInputs = readJsonObject(compilerInputsPath);
  const distributionSchema = readJsonObject(schemaPath);

  if (
    Object.keys(compilerInputs).sort().join(',') !==
    'direct_packages,format,identity_hash,identity_scope,node_runtime_version,npm_version,package_lock_sha256,ref'
  ) {
    throw new Error('G0.1 compiler input identity must be closed');
  }

  const distributionRef = parseVersionedRef(distribution.ref);
  const compilerRef = parseVersionedRef(compilerInputs.ref);
  if (
    distribution.format !== 'icarus.managed-node-runtime-distribution/1' ||
    compilerInputs.format !== 'icarus.workflow-compiler-toolchain-inputs/1'
  ) {
    throw new Error('G0.1 toolchain format identity drift');
  }
  if (
    distributionRef.id !== 'nodejs.node-v26.5.0-darwin-arm64' ||
    distributionRef.version !== '1.0.0' ||
    compilerRef.id !== 'icarus.workflow-compiler-toolchain-inputs' ||
    compilerRef.version !== '1.0.0' ||
    distribution.node_runtime_version !== '26.5.0' ||
    distribution.npm_version !== '11.17.0' ||
    compilerInputs.identity_scope !== 'g0.1_locked_inputs' ||
    compilerInputs.node_runtime_version !== '26.5.0' ||
    compilerInputs.npm_version !== '11.17.0'
  ) {
    throw new Error('G0.1 toolchain exact identity drift');
  }
  const distributionHash = distribution.manifest_hash;
  const compilerHash = compilerInputs.identity_hash;
  if (
    typeof distributionHash !== 'string' ||
    typeof compilerHash !== 'string'
  ) {
    throw new Error('G0.1 toolchain hash field is missing');
  }

  const { manifest_hash: _manifestHash, ...distributionPayload } = distribution;
  const expectedDistributionHash = domainSeparatedSha256(
    'icarus:managed-node-runtime-distribution:1\n',
    distributionPayload,
  );
  if (distributionHash !== expectedDistributionHash) {
    throw new Error('G0.1 managed distribution hash drift');
  }
  const { identity_hash: _identityHash, ...compilerPayload } = compilerInputs;
  const expectedCompilerHash = domainSeparatedSha256(
    'icarus:workflow-compiler-toolchain-inputs:1\n',
    compilerPayload,
  );
  if (compilerHash !== expectedCompilerHash) {
    throw new Error('G0.1 compiler input identity hash drift');
  }

  const lockBytes = fs.readFileSync(
    path.join(projectRoot, 'package-lock.json'),
  );
  const expectedLockHash = `sha256:${crypto
    .createHash(HASH_ALGORITHM)
    .update(lockBytes)
    .digest('hex')}`;
  if (compilerInputs.package_lock_sha256 !== expectedLockHash) {
    throw new Error('G0.1 compiler input package-lock hash drift');
  }
  const packageJson = strictParseJsonBytes(
    fs.readFileSync(path.join(projectRoot, 'package.json')),
  );
  const packageLock = strictParseJsonBytes(lockBytes);
  assertJsonObject(packageJson);
  assertJsonObject(packageLock);
  assertJsonObject(packageJson.dependencies);
  assertJsonObject(packageJson.devDependencies);
  assertJsonObject(packageLock.packages);
  assertJsonObject(packageLock.packages['']);
  assertJsonObject(packageLock.packages[''].dependencies);
  assertJsonObject(packageLock.packages[''].devDependencies);
  const packageDependencies = packageJson.dependencies;
  const packageDevDependencies = packageJson.devDependencies;
  const lockPackages = packageLock.packages;
  const lockRoot = lockPackages[''];
  assertJsonObject(lockRoot);
  assertJsonObject(lockRoot.dependencies);
  assertJsonObject(lockRoot.devDependencies);
  const lockDependencies = lockRoot.dependencies;
  const lockDevDependencies = lockRoot.devDependencies;
  if (
    packageJson.packageManager !== 'npm@11.17.0' ||
    fs.readFileSync(path.join(projectRoot, '.nvmrc'), 'utf8').trim() !==
      '26.5.0'
  ) {
    throw new Error('G0.1 repository Node/npm identity drift');
  }
  if (!Array.isArray(compilerInputs.direct_packages)) {
    throw new Error('G0.1 direct package identity is missing');
  }
  if (compilerInputs.direct_packages.length !== g01DirectPackages.length) {
    throw new Error('G0.1 direct package identity coverage drift');
  }
  for (const [index, expectedPackage] of g01DirectPackages.entries()) {
    const packageRef: JsonValue = compilerInputs.direct_packages[index]!;
    assertJsonObject(packageRef);
    if (
      Object.keys(packageRef).sort().join(',') !==
        'dependency_kind,exact_version,lockfile_integrity,package_name' ||
      packageRef.package_name !== expectedPackage.package_name ||
      packageRef.dependency_kind !== expectedPackage.dependency_kind ||
      packageRef.exact_version !== expectedPackage.exact_version ||
      typeof packageRef.lockfile_integrity !== 'string'
    ) {
      throw new Error(`G0.1 direct package descriptor drift at index ${index}`);
    }
    const dependencyField =
      expectedPackage.dependency_kind === 'runtime'
        ? 'dependencies'
        : 'devDependencies';
    const packageRootDependencies =
      dependencyField === 'dependencies'
        ? packageDependencies
        : packageDevDependencies;
    const lockRootDependencies =
      dependencyField === 'dependencies'
        ? lockDependencies
        : lockDevDependencies;
    const locked = lockPackages[`node_modules/${expectedPackage.package_name}`];
    assertJsonObject(locked);
    if (
      packageRootDependencies[expectedPackage.package_name] !==
        expectedPackage.exact_version ||
      lockRootDependencies[expectedPackage.package_name] !==
        expectedPackage.exact_version ||
      locked.version !== expectedPackage.exact_version ||
      locked.integrity !== packageRef.lockfile_integrity
    ) {
      throw new Error(
        `G0.1 direct package lock replay failed for ${expectedPackage.package_name}`,
      );
    }
  }

  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
  });
  const validateDistribution = ajv.compile(distributionSchema as AnySchema);
  if (!validateDistribution(distribution)) {
    throw new Error(
      `G0.1 distribution schema mismatch: ${ajv.errorsText(validateDistribution.errors)}`,
    );
  }

  return [
    {
      path: distributionPath,
      format: String(distribution.format),
      ref: distributionRef,
      version: 1,
      domain_separator: 'icarus:managed-node-runtime-distribution:1\n',
      hash: expectedDistributionHash,
    },
    {
      path: compilerInputsPath,
      format: String(compilerInputs.format),
      ref: compilerRef,
      version: 1,
      domain_separator: 'icarus:workflow-compiler-toolchain-inputs:1\n',
      hash: expectedCompilerHash,
    },
  ].sort((left, right) => asciiCompare(left.path, right.path));
}

function buildFoundationManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  const manifestWithoutHash: ContractArtifactEnvelope = {
    format: 'icarus.workflow-contract-pack-foundation/1',
    ref: {
      id: 'icarus.workflow-contract-pack-foundation',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: 'icarus:workflow-contract-pack-foundation:1\n',
    hash: `sha256:${'0'.repeat(64)}`,
    payload: {
      gate: 'G0.2',
      status: 'foundation',
      artifact_envelope_format:
        'icarus.workflow-contract-artifact-envelope-schema/1',
      artifacts: artifacts
        .map(([relativePath, artifact]) => descriptor(relativePath, artifact))
        .sort((left, right) => asciiCompare(left.path, right.path)),
      toolchain_inputs: verifyG01ToolchainArtifacts(),
      reserved_directories: [...foundationReservedDirectories],
    },
  };
  return {
    ...manifestWithoutHash,
    hash: calculateArtifactHash(manifestWithoutHash),
  };
}

function compileSchema(
  ajv: Ajv2020,
  artifact: ContractArtifactEnvelope,
): ValidateFunction {
  try {
    return ajv.compile(artifact.payload as AnySchema);
  } catch (error) {
    throw new Error(
      `Invalid schema artifact ${artifact.format}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateMachineContracts(artifacts: ContractArtifactEnvelope[]): void {
  const byFormat = new Map(
    artifacts.map((artifact) => [artifact.format, artifact] as const),
  );
  if (byFormat.size !== artifacts.length) {
    throw new Error('Foundation artifact formats must be unique');
  }

  const envelopeSchema = byFormat.get(
    'icarus.workflow-contract-artifact-envelope-schema/1',
  );
  const versionedRefSchema = byFormat.get(
    'icarus.workflow-versioned-ref-schema/1',
  );
  if (!envelopeSchema || !versionedRefSchema) {
    throw new Error('Foundation bootstrap schemas are missing');
  }

  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes: false,
    removeAdditional: false,
    strict: true,
    useDefaults: false,
  });
  const validateEnvelope = compileSchema(ajv, envelopeSchema);
  const validateVersionedRef = compileSchema(ajv, versionedRefSchema);
  for (const artifact of artifacts) {
    const envelopeValid: boolean = validateEnvelope(artifact);
    if (!envelopeValid) {
      throw new Error(
        `${artifact.format} violates the artifact envelope schema: ${ajv.errorsText(validateEnvelope.errors)}`,
      );
    }
    const versionedRefValid: boolean = validateVersionedRef(artifact.ref);
    if (!versionedRefValid) {
      throw new Error(
        `${artifact.format} violates VersionedRef schema: ${ajv.errorsText(validateVersionedRef.errors)}`,
      );
    }
    parseContractArtifactEnvelope(artifact);
  }
  for (const invalidRef of [
    { id: 'example.ref', version: 'latest' },
    { id: 'example.ref', version: 'LATEST' },
    { id: 'example.ref', version: '1.x' },
    { id: 'example.ref', version: '1.0.0', unknown: true },
  ]) {
    const incorrectlyAccepted: boolean = validateVersionedRef(invalidRef);
    if (incorrectlyAccepted) {
      throw new Error(
        `VersionedRef schema accepted a mutable or open ref: ${JSON.stringify(invalidRef)}`,
      );
    }
  }

  const envelopePayload = envelopeSchema.payload;
  assertJsonObject(envelopePayload.properties);
  assertJsonObject(envelopePayload.properties.format);
  assertJsonObject(envelopePayload.properties.version);
  assertJsonObject(envelopePayload.properties.domain_separator);
  assertJsonObject(envelopePayload.properties.hash);
  assertJsonObject(envelopePayload.properties.payload);
  if (!Array.isArray(envelopePayload.required)) {
    throw new Error('Artifact envelope required key list is missing');
  }
  if (
    [...envelopePayload.required].sort().join(',') !==
      CONTRACT_ARTIFACT_ENVELOPE_KEYS.join(',') ||
    envelopePayload.properties.format.pattern !==
      CONTRACT_ARTIFACT_FORMAT_PATTERN ||
    envelopePayload.properties.domain_separator.pattern !==
      DOMAIN_SEPARATOR_PATTERN ||
    envelopePayload.properties.hash.pattern !== SHA256_HASH_PATTERN ||
    envelopePayload.type !== 'object' ||
    envelopePayload.additionalProperties !== false ||
    envelopePayload.properties.version.type !== 'integer' ||
    envelopePayload.properties.version.minimum !== 1 ||
    envelopePayload.properties.version.maximum !== Number.MAX_SAFE_INTEGER ||
    envelopePayload.properties.payload.type !== 'object'
  ) {
    throw new Error(
      'Artifact envelope schema and TypeScript primitives drifted',
    );
  }

  assertJsonObject(versionedRefSchema.payload.properties);
  assertJsonObject(versionedRefSchema.payload.properties.id);
  assertJsonObject(versionedRefSchema.payload.properties.version);
  if (!Array.isArray(versionedRefSchema.payload.required)) {
    throw new Error('VersionedRef required key list is missing');
  }
  if (
    [...versionedRefSchema.payload.required].sort().join(',') !==
      VERSIONED_REF_KEYS.join(',') ||
    versionedRefSchema.payload.properties.id.pattern !==
      VERSIONED_REF_ID_PATTERN ||
    versionedRefSchema.payload.properties.version.pattern !==
      VERSIONED_REF_VERSION_PATTERN ||
    versionedRefSchema.payload.type !== 'object' ||
    versionedRefSchema.payload.additionalProperties !== false ||
    versionedRefSchema.payload.properties.id.minLength !== 1 ||
    versionedRefSchema.payload.properties.id.maxLength !== 255 ||
    versionedRefSchema.payload.properties.version.minLength !== 1 ||
    versionedRefSchema.payload.properties.version.maxLength !== 64
  ) {
    throw new Error('VersionedRef schema and TypeScript parser drifted');
  }

  assertJsonObject(envelopePayload.$defs);
  assertJsonObject(envelopePayload.$defs.versioned_ref);
  const {
    $schema: _schema,
    $id: _id,
    title: _title,
    ...standaloneVersionedRef
  } = versionedRefSchema.payload;
  if (
    canonicalJson(envelopePayload.$defs.versioned_ref) !==
    canonicalJson(standaloneVersionedRef)
  ) {
    throw new Error('Embedded and standalone VersionedRef schemas drifted');
  }

  const refCases: Array<[JsonValue, boolean]> = [
    [{ id: 'example.ref', version: '1.0.0' }, true],
    ...VERSIONED_REF_MUTABLE_VERSIONS.flatMap(
      (version): Array<[JsonValue, boolean]> => [
        [{ id: 'example.ref', version }, false],
        [{ id: 'example.ref', version: version.toUpperCase() }, false],
      ],
    ),
    [{ id: 'example.ref', version: '1.x' }, false],
    [{ id: 'example.ref', version: 'x.1' }, false],
    [{ id: 'example.ref', version: '^1.0.0' }, false],
    [{ id: 'example.ref', version: '1.0.0', unknown: true }, false],
  ];
  for (const [candidate, expected] of refCases) {
    const schemaAccepted: boolean = validateVersionedRef(candidate);
    let parserAccepted = true;
    try {
      parseVersionedRef(candidate);
    } catch {
      parserAccepted = false;
    }
    if (schemaAccepted !== expected || parserAccepted !== expected) {
      throw new Error(
        `VersionedRef Schema/TypeScript semantic drift for ${JSON.stringify(candidate)}`,
      );
    }
  }
}

function validateProfiles(artifacts: ContractArtifactEnvelope[]): void {
  const byFormat = new Map(
    artifacts.map((artifact) => [artifact.format, artifact] as const),
  );
  const strictProfile = byFormat.get('icarus.workflow-strict-json-profile/1');
  const hashProfile = byFormat.get('icarus.workflow-canonical-hash-profile/1');
  if (!strictProfile || !hashProfile)
    throw new Error('Foundation profile missing');

  assertJsonObject(strictProfile.payload.lexer_parser);
  assertJsonObject(strictProfile.payload.options);
  assertJsonObject(hashProfile.payload.canonicalization);
  assertJsonObject(hashProfile.payload.domain_separator);
  assertJsonObject(hashProfile.payload.output);
  if (
    strictProfile.payload.lexer_parser.package !== STRICT_JSON_PARSER_PACKAGE ||
    strictProfile.payload.lexer_parser.version !== STRICT_JSON_PARSER_VERSION ||
    strictProfile.payload.options.disallow_comments !==
      STRICT_JSON_PARSE_OPTIONS.disallowComments ||
    strictProfile.payload.options.allow_trailing_comma !==
      STRICT_JSON_PARSE_OPTIONS.allowTrailingComma ||
    strictProfile.payload.options.allow_empty_content !==
      STRICT_JSON_PARSE_OPTIONS.allowEmptyContent ||
    hashProfile.payload.algorithm !== HASH_ALGORITHM ||
    hashProfile.payload.canonicalization.package !==
      JCS_CANONICALIZER_PACKAGE ||
    hashProfile.payload.canonicalization.version !==
      JCS_CANONICALIZER_VERSION ||
    hashProfile.payload.domain_separator.pattern !== DOMAIN_SEPARATOR_PATTERN ||
    hashProfile.payload.output.pattern !== SHA256_HASH_PATTERN
  ) {
    throw new Error('Foundation parser/hash profile identity drift');
  }

  const packageJson = strictParseJsonBytes(
    fs.readFileSync(path.join(projectRoot, 'package.json')),
  );
  assertJsonObject(packageJson);
  assertJsonObject(packageJson.dependencies);
  if (
    packageJson.dependencies['jsonc-parser'] !== '3.3.1' ||
    packageJson.dependencies['json-canonicalize'] !== '2.0.0'
  ) {
    throw new Error('Foundation profile does not match direct dependencies');
  }
}

function validateDomainCatalog(artifacts: ContractArtifactEnvelope[]): void {
  const catalog = artifacts.find(
    (artifact) =>
      artifact.format === 'icarus.workflow-foundation-domain-separators/1',
  );
  if (!catalog || !Array.isArray(catalog.payload.entries)) {
    throw new Error('Foundation domain separator catalog is missing');
  }

  const declared = new Map<string, string>();
  const separators = new Set<string>();
  const declaredOrder: string[] = [];
  for (const entry of catalog.payload.entries) {
    assertJsonObject(entry);
    if (
      typeof entry.format !== 'string' ||
      typeof entry.domain_separator !== 'string' ||
      Object.keys(entry).sort().join(',') !== 'domain_separator,format'
    ) {
      throw new Error('Domain separator entry must be closed');
    }
    if (declared.has(entry.format) || separators.has(entry.domain_separator)) {
      throw new Error('Domain separator formats and values must be one-to-one');
    }
    declared.set(entry.format, entry.domain_separator);
    declaredOrder.push(entry.format);
    separators.add(entry.domain_separator);
  }
  if (
    declaredOrder.join('\n') !==
    [...declaredOrder].sort(asciiCompare).join('\n')
  ) {
    throw new Error('Domain separator entries must be sorted by format');
  }
  const toolchainInputs = verifyG01ToolchainArtifacts();
  if (declared.size !== artifacts.length + toolchainInputs.length) {
    throw new Error('Domain separator catalog coverage is incomplete');
  }
  for (const artifact of [...artifacts, ...toolchainInputs]) {
    if (declared.get(artifact.format) !== artifact.domain_separator) {
      throw new Error(`Domain separator drift for ${artifact.format}`);
    }
  }
}

function classifyFoundationError(error: unknown): string {
  if (error instanceof StrictJsonError) return error.code;
  if (error instanceof VersionedRefError) return 'versioned_ref_invalid';
  if (error instanceof ContractArtifactError)
    return 'artifact_envelope_invalid';
  if (error instanceof ContractHashError) {
    if (error.message.startsWith('Hash must use')) return 'hash_format_invalid';
    if (error.message.startsWith('Domain separator')) {
      return 'domain_separator_invalid';
    }
    if (error.message.startsWith('Artifact hash mismatch')) {
      return 'artifact_hash_mismatch';
    }
  }
  throw error;
}

function validateNegativeFixtures(artifacts: ContractArtifactEnvelope[]): void {
  const manifest = artifacts.find(
    (artifact) =>
      artifact.format ===
      'icarus.workflow-contract-foundation-negative-cases/1',
  );
  if (!manifest || !Array.isArray(manifest.payload.cases)) {
    throw new Error('Foundation negative case manifest is missing');
  }
  for (const testCase of manifest.payload.cases) {
    assertJsonObject(testCase);
    if (
      typeof testCase.case_id !== 'string' ||
      typeof testCase.path !== 'string' ||
      typeof testCase.expected_error !== 'string' ||
      typeof testCase.source_sha256 !== 'string' ||
      Object.keys(testCase).sort().join(',') !==
        'case_id,expected_error,path,source_sha256'
    ) {
      throw new Error('Foundation negative case has an invalid shape');
    }
    const sourceBytes = readContractBytes(testCase.path);
    if (sha256Bytes(sourceBytes) !== testCase.source_sha256) {
      throw new Error(`Negative fixture raw byte drift in ${testCase.case_id}`);
    }
    let actualError = 'accepted';
    try {
      const fixture = strictParseJsonBytes(sourceBytes);
      assertJsonObject(fixture);
      parseContractArtifactEnvelope(fixture);
    } catch (error) {
      actualError = classifyFoundationError(error);
    }
    if (actualError !== testCase.expected_error) {
      throw new Error(
        `Negative fixture ${testCase.case_id} expected ${testCase.expected_error}, received ${actualError}`,
      );
    }
  }
}

function validateHashVectors(artifacts: ContractArtifactEnvelope[]): void {
  const vectors = artifacts.find(
    (artifact) => artifact.format === 'icarus.workflow-contract-hash-vectors/1',
  );
  if (!vectors || !Array.isArray(vectors.payload.cases)) {
    throw new Error('Foundation hash vectors are missing');
  }
  const caseIds = new Set<string>();
  for (const testCase of vectors.payload.cases) {
    assertJsonObject(testCase);
    if (
      typeof testCase.case_id !== 'string' ||
      typeof testCase.domain_separator !== 'string' ||
      typeof testCase.canonical_json !== 'string' ||
      typeof testCase.expected_hash !== 'string'
    ) {
      throw new Error('Foundation hash vector has an invalid shape');
    }
    if (caseIds.has(testCase.case_id)) {
      throw new Error(`Duplicate hash vector ${testCase.case_id}`);
    }
    caseIds.add(testCase.case_id);
    if (
      canonicalJson(testCase.input) !== testCase.canonical_json ||
      domainSeparatedSha256(testCase.domain_separator, testCase.input) !==
        testCase.expected_hash
    ) {
      throw new Error(`Hash vector drift in ${testCase.case_id}`);
    }
  }
}

function validateReservedDirectories(): void {
  for (const directory of stillReservedDirectories) {
    const absoluteDirectory = absoluteContractPath(directory);
    if (!fs.lstatSync(absoluteDirectory).isDirectory()) {
      throw new Error(`Reserved Contract Pack directory missing: ${directory}`);
    }
    const entries = fs.readdirSync(absoluteDirectory).sort(asciiCompare);
    if (
      entries.length !== 1 ||
      entries[0] !== '.gitkeep' ||
      !fs.lstatSync(path.join(absoluteDirectory, '.gitkeep')).isFile()
    ) {
      throw new Error(
        `Reserved Contract Pack directory contains out-of-slice artifacts: ${directory}`,
      );
    }
  }
}

function expectedFoundationArtifacts(): Array<
  [string, ContractArtifactEnvelope]
> {
  return foundationArtifactPaths.map((relativePath) => [
    relativePath,
    refreshArtifact(readJsonObject(relativePath)),
  ]);
}

function assertExpectedBytes(
  relativePath: string,
  expected: ContractArtifactEnvelope,
): void {
  const actual = fs.readFileSync(absoluteContractPath(relativePath), 'utf8');
  const rendered = renderJson(expected);
  if (actual !== rendered) {
    throw new Error(
      `${relativePath} is not generated byte-for-byte; run npm run contracts:generate`,
    );
  }
}

function validateCompletePack(
  foundations: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
): void {
  const artifacts = [...foundations.map(([, artifact]) => artifact), manifest];
  validateMachineContracts(artifacts);
  validateProfiles(artifacts);
  validateDomainCatalog(artifacts);
  validateHashVectors(artifacts);
  validateNegativeFixtures(artifacts);
  validateReservedDirectories();
  verifyG01ToolchainArtifacts();
}

export function generateContractPackFoundation(): ContractArtifactEnvelope {
  let foundations = expectedFoundationArtifacts();
  for (const [relativePath, artifact] of foundations) {
    writeAtomic(absoluteContractPath(relativePath), renderJson(artifact));
  }
  foundations = expectedFoundationArtifacts();
  const manifest = buildFoundationManifest(foundations);
  writeAtomic(
    absoluteContractPath(foundationManifestPath),
    renderJson(manifest),
  );
  validateCompletePack(foundations, manifest);
  return manifest;
}

export function checkContractPackFoundation(): ContractArtifactEnvelope {
  const foundations = expectedFoundationArtifacts();
  for (const [relativePath, artifact] of foundations) {
    assertExpectedBytes(relativePath, artifact);
  }
  const manifest = buildFoundationManifest(foundations);
  assertExpectedBytes(foundationManifestPath, manifest);
  const parsedManifest = parseContractArtifactEnvelope(
    readJsonObject(foundationManifestPath),
  );
  if (parsedManifest.hash !== manifest.hash) {
    throw new Error('Foundation manifest hash drift');
  }
  validateCompletePack(foundations, parsedManifest);
  return parsedManifest;
}
