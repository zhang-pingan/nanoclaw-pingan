import path from 'node:path';

import { Ajv2020, type AnySchema, type ErrorObject } from 'ajv/dist/2020.js';

import { domainSeparatedSha256 } from '../workflow-runtime/contracts/hash.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../workflow-runtime/contracts/strict-json.js';
import type {
  JsonObject,
  Sha256Hash,
} from '../workflow-runtime/contracts/types.js';
import {
  buildClosedSchemaArtifacts,
  type WorkflowPackManifestDocument,
} from '../workflow-runtime/gateway/workflow-packs.js';

const MANIFEST_SCHEMA_PATH = 'schemas/workflow-pack-manifest-schema.json';
const MANIFEST_HASH_DOMAIN = 'icarus:workflow-pack-manifest:1\n';
const SAFE_PACK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const manifestSchema = buildClosedSchemaArtifacts().find(
  ([artifactPath]) => artifactPath === MANIFEST_SCHEMA_PATH,
)?.[1].payload;

if (!manifestSchema) {
  throw new Error('Workflow Pack manifest schema is unavailable');
}

const validateManifestSchema = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
}).compile(manifestSchema as AnySchema);

export class WorkflowPackManifestError extends Error {
  constructor(
    readonly code:
      | 'manifest_invalid'
      | 'manifest_hash_mismatch'
      | 'manifest_path_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowPackManifestError';
  }
}

function validationMessage(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map(
      (error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`,
    )
    .join('; ');
}

export function calculateWorkflowPackManifestHash(
  manifest: Omit<WorkflowPackManifestDocument, 'manifest_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    MANIFEST_HASH_DOMAIN,
    manifest as unknown as JsonObject,
  );
}

export function assertSafeWorkflowPackId(packId: string): string {
  if (
    !SAFE_PACK_ID.test(packId) ||
    packId === '.' ||
    packId === '..' ||
    packId.includes('/') ||
    packId.includes('\\') ||
    path.isAbsolute(packId)
  ) {
    throw new WorkflowPackManifestError(
      'manifest_invalid',
      `Workflow Pack id ${JSON.stringify(packId)} is not a safe path segment`,
    );
  }
  return packId;
}

export function parseWorkflowPackManifest(
  bytes: Uint8Array,
): WorkflowPackManifestDocument {
  const parsed = strictParseJsonBytes(bytes);
  assertJsonObject(parsed);
  if (!validateManifestSchema(parsed)) {
    throw new WorkflowPackManifestError(
      'manifest_invalid',
      `Workflow Pack manifest is invalid: ${validationMessage(validateManifestSchema.errors)}`,
    );
  }
  const manifest = parsed as unknown as WorkflowPackManifestDocument;
  assertSafeWorkflowPackId(manifest.pack_ref.id);
  const { manifest_hash: suppliedHash, ...withoutHash } = manifest;
  const expectedHash = calculateWorkflowPackManifestHash(withoutHash);
  if (suppliedHash !== expectedHash) {
    throw new WorkflowPackManifestError(
      'manifest_hash_mismatch',
      `Workflow Pack manifest hash mismatch: expected ${expectedHash}, received ${suppliedHash}`,
    );
  }
  return manifest;
}

export function resolveWorkflowPackPath(
  packRoot: string,
  relativePath: string,
  label: string,
): string {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath)
  ) {
    throw new WorkflowPackManifestError(
      'manifest_path_invalid',
      `${label} must be a non-empty portable relative path`,
    );
  }
  const root = path.resolve(packRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new WorkflowPackManifestError(
      'manifest_path_invalid',
      `${label} must stay inside the Workflow Pack root`,
    );
  }
  return resolved;
}
