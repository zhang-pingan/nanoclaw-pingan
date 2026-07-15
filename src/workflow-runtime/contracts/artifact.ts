import {
  assertDomainSeparator,
  parseSha256Hash,
  verifyArtifactHash,
} from './hash.js';
import { assertJsonObject } from './strict-json.js';
import type { ContractArtifactEnvelope } from './types.js';
import { parseVersionedRef } from './versioned-ref.js';

export const CONTRACT_ARTIFACT_FORMAT_PATTERN =
  '^icarus\\.[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?/[1-9][0-9]*$';

const formatPattern = new RegExp(CONTRACT_ARTIFACT_FORMAT_PATTERN);
export const CONTRACT_ARTIFACT_ENVELOPE_KEYS = [
  'domain_separator',
  'format',
  'hash',
  'payload',
  'ref',
  'version',
];

export class ContractArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractArtifactError';
  }
}

export function parseContractArtifactEnvelope(
  value: unknown,
  options: { verifyHash?: boolean } = {},
): ContractArtifactEnvelope {
  assertJsonObject(value);
  const keys = Object.keys(value).sort();
  if (
    keys.length !== CONTRACT_ARTIFACT_ENVELOPE_KEYS.length ||
    keys.some((key, index) => key !== CONTRACT_ARTIFACT_ENVELOPE_KEYS[index])
  ) {
    throw new ContractArtifactError(
      'Contract artifact envelope has an unknown, duplicate, or missing field',
    );
  }
  if (typeof value.format !== 'string' || !formatPattern.test(value.format)) {
    throw new ContractArtifactError('Contract artifact format is invalid');
  }
  if (!Number.isSafeInteger(value.version) || Number(value.version) <= 0) {
    throw new ContractArtifactError(
      'Contract artifact version must be a positive safe integer',
    );
  }
  const formatVersion = Number(
    value.format.slice(value.format.lastIndexOf('/') + 1),
  );
  if (formatVersion !== value.version) {
    throw new ContractArtifactError(
      'Contract artifact version must equal the format revision',
    );
  }
  const ref = parseVersionedRef(value.ref);
  assertDomainSeparator(value.domain_separator);
  if (!value.domain_separator.endsWith(`:${value.version}\n`)) {
    throw new ContractArtifactError(
      'Contract artifact domain revision must equal the artifact version',
    );
  }
  const hash = parseSha256Hash(value.hash);
  assertJsonObject(value.payload);

  const artifact: ContractArtifactEnvelope = {
    format: value.format,
    ref,
    version: value.version,
    domain_separator: value.domain_separator,
    hash,
    payload: value.payload,
  };
  if (options.verifyHash !== false) verifyArtifactHash(artifact);
  return artifact;
}
