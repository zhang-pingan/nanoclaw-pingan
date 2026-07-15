import crypto from 'crypto';

import { canonicalize } from 'json-canonicalize';

import { assertJsonValue } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

export const SHA256_HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
export const DOMAIN_SEPARATOR_PATTERN =
  '^icarus:(?:[a-z0-9]+(?:-[a-z0-9]+)*:)+[1-9][0-9]*\\n$';
export const HASH_ALGORITHM = 'sha256';
export const JCS_CANONICALIZER_PACKAGE = 'json-canonicalize';
export const JCS_CANONICALIZER_VERSION = '2.0.0';

const sha256Pattern = new RegExp(SHA256_HASH_PATTERN);
const domainSeparatorPattern = new RegExp(DOMAIN_SEPARATOR_PATTERN);

export class ContractHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractHashError';
  }
}

export function parseSha256Hash(value: unknown): Sha256Hash {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new ContractHashError(
      'Hash must use sha256:<64 lowercase hexadecimal characters>',
    );
  }
  return value as Sha256Hash;
}

export function assertDomainSeparator(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !domainSeparatorPattern.test(value) ||
    [...value].some((character) => character.codePointAt(0)! > 0x7f)
  ) {
    throw new ContractHashError(
      'Domain separator must be a versioned ASCII icarus domain ending in LF',
    );
  }
}

export function canonicalJson(value: JsonValue): string {
  assertJsonValue(value);
  return canonicalize(value);
}

export function domainSeparatedSha256(
  domainSeparator: string,
  value: JsonValue,
): Sha256Hash {
  assertDomainSeparator(domainSeparator);
  const canonical = canonicalJson(value);
  return `sha256:${crypto
    .createHash(HASH_ALGORITHM)
    .update(domainSeparator, 'ascii')
    .update(canonical, 'utf8')
    .digest('hex')}`;
}

export function calculateArtifactHash(
  artifact: ContractArtifactEnvelope,
): Sha256Hash {
  const payloadWithoutHash: JsonObject = {
    format: artifact.format,
    ref: artifact.ref,
    version: artifact.version,
    domain_separator: artifact.domain_separator,
    payload: artifact.payload,
  };
  return domainSeparatedSha256(artifact.domain_separator, payloadWithoutHash);
}

export function verifyArtifactHash(artifact: ContractArtifactEnvelope): void {
  const expected = calculateArtifactHash(artifact);
  if (artifact.hash !== expected) {
    throw new ContractHashError(
      `Artifact hash mismatch: expected ${expected}, received ${artifact.hash}`,
    );
  }
}
