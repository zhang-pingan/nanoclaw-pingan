import fs from 'node:fs';
import path from 'node:path';

import { calculateArtifactHash, canonicalJson } from './hash.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { compareAscii } from './g3-registry-persistence.js';
import {
  G37_APPROVED_REVIEW_DOMAIN,
  G37_COMMAND_ID_DOMAIN,
  G37_DOMAIN_REQUEST_DOMAIN,
  G37_EVENT_DOMAIN,
  G37_INVOCATION_DOMAIN,
  G37_RECEIPT_DOMAIN,
  G37_RECEIPT_SCHEMA,
  G37_REQUEST_DOMAIN,
  G37_REQUEST_SCHEMA,
  G37_RESULT_DOMAIN,
  G37_RESULT_SCHEMA,
  G37_SCHEMA_RESOURCE_HASHES,
  G37_TARGET_RELEASE_DOMAIN,
  validateG37WorkflowPublisherRequest,
} from './g3-workflow-publisher.js';
import { g37WorkflowPublisherStoreFixtureForTest } from './g3-workflow-publisher-fixtures.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const contractsRoot = import.meta.dirname;
const root = 'conformance/g3-workflow-publisher';
const paths = {
  requestSchema: 'registry/workflow-staged-publish-request-schema@1.json',
  receiptSchema: 'registry/workflow-staged-publish-receipt-schema@1.json',
  resultSchema: 'registry/workflow-staged-publish-result-schema@1.json',
  positive: `${root}/positive-cases.json`,
  negative: `${root}/negative-cases.json`,
  domains: 'registry/workflow-staged-publish-domain-separators@1.json',
  manifest: 'contract-pack-g3-workflow-publisher.json',
} as const;

const domains = {
  requestSchema: 'icarus:workflow-staged-publish-request-schema:1\n',
  receiptSchema: 'icarus:workflow-staged-publish-receipt-schema:1\n',
  resultSchema: 'icarus:workflow-staged-publish-result-schema:1\n',
  positive: 'icarus:workflow-g3-staged-publish-positive-cases:1\n',
  negative: 'icarus:workflow-g3-staged-publish-negative-cases:1\n',
  catalog: 'icarus:workflow-staged-publish-domain-separators:1\n',
  manifest: 'icarus:workflow-contract-pack-g3-workflow-publisher:1\n',
} as const;

function artifact<T extends JsonObject>(
  format: string,
  ref: string,
  domain: string,
  payload: T,
): ContractArtifactEnvelope<T> {
  const withoutHash = {
    format,
    ref: { id: ref, version: '1.0.0' },
    version: 1,
    domain_separator: domain,
    payload,
  };
  return {
    ...withoutHash,
    hash: calculateArtifactHash(withoutHash as ContractArtifactEnvelope<T>),
  };
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`))
    throw new Error(`G3.7 path escapes Contracts root: ${relativePath}`);
  return resolved;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(relativePath: string, contents: string): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, 'utf8');
  fs.renameSync(temporary, target);
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const fixture = g37WorkflowPublisherStoreFixtureForTest();
  const unknown = structuredClone(fixture.request) as JsonObject;
  unknown.active_pointer = 'forbidden';
  const requestHashDrift = structuredClone(fixture.request);
  requestHashDrift.request_hash =
    'sha256:1111111111111111111111111111111111111111111111111111111111111111';
  const reviewHashDrift = structuredClone(fixture.request);
  reviewHashDrift.approved_review.review_hash =
    'sha256:2222222222222222222222222222222222222222222222222222222222222222';
  const entries: Array<[string, ContractArtifactEnvelope]> = [
    [
      paths.requestSchema,
      artifact(
        'icarus.workflow-staged-publish-request-schema/1',
        'icarus.workflow-staged-publish-request-schema',
        domains.requestSchema,
        G37_REQUEST_SCHEMA,
      ),
    ],
    [
      paths.receiptSchema,
      artifact(
        'icarus.workflow-staged-publish-receipt-schema/1',
        'icarus.workflow-staged-publish-receipt-schema',
        domains.receiptSchema,
        G37_RECEIPT_SCHEMA,
      ),
    ],
    [
      paths.resultSchema,
      artifact(
        'icarus.workflow-staged-publish-result-schema/1',
        'icarus.workflow-staged-publish-result-schema',
        domains.resultSchema,
        G37_RESULT_SCHEMA,
      ),
    ],
    [
      paths.positive,
      artifact(
        'icarus.workflow-g3-staged-publish-positive-cases/1',
        'icarus.workflow-g3-staged-publish-positive-cases',
        domains.positive,
        {
          fixture_scope: 'test_only',
          cases: [
            {
              case_id: 'positive.exact-staged-publish',
              request: fixture.request,
              invocation: fixture.invocation,
              expected_disposition: 'applied',
              expected_code: 'staged_publish_applied',
            },
          ],
        },
      ),
    ],
    [
      paths.negative,
      artifact(
        'icarus.workflow-g3-staged-publish-negative-cases/1',
        'icarus.workflow-g3-staged-publish-negative-cases',
        domains.negative,
        {
          fixture_scope: 'test_only',
          cases: [
            {
              case_id: 'negative.unknown-active-pointer',
              request: unknown,
              expected_code: 'publish_request_invalid',
            },
            {
              case_id: 'negative.request-hash-drift',
              request: requestHashDrift,
              expected_code: 'publish_request_hash_mismatch',
            },
            {
              case_id: 'negative.approved-review-hash-drift',
              request: reviewHashDrift,
              expected_code: 'approved_review_identity_mismatch',
            },
          ],
        },
      ),
    ],
  ];
  const domainEntries = [
    ...entries.map(([, entry]) => ({
      format: entry.format,
      domain_separator: entry.domain_separator,
    })),
    {
      format: 'icarus.workflow-approved-publish-review/1',
      domain_separator: G37_APPROVED_REVIEW_DOMAIN,
    },
    {
      format: 'icarus.workflow-staged-feature-release/1',
      domain_separator: G37_TARGET_RELEASE_DOMAIN,
    },
    {
      format: 'icarus.workflow-staged-publish-request-domain/1',
      domain_separator: G37_DOMAIN_REQUEST_DOMAIN,
    },
    {
      format: 'icarus.workflow-staged-publish-request/1',
      domain_separator: G37_REQUEST_DOMAIN,
    },
    {
      format: 'icarus.workflow-staged-publish-receipt/1',
      domain_separator: G37_RECEIPT_DOMAIN,
    },
    {
      format: 'icarus.workflow-staged-publish-result/1',
      domain_separator: G37_RESULT_DOMAIN,
    },
    {
      format: 'icarus.workflow-publisher-invocation/1',
      domain_separator: G37_INVOCATION_DOMAIN,
    },
    {
      format: 'icarus.workflow-publisher-event/1',
      domain_separator: G37_EVENT_DOMAIN,
    },
    {
      format: 'icarus.workflow-publisher-command-id/1',
      domain_separator: G37_COMMAND_ID_DOMAIN,
    },
    {
      format: 'icarus.workflow-staged-publish-domain-separators/1',
      domain_separator: domains.catalog,
    },
    {
      format: 'icarus.workflow-contract-pack-g3-workflow-publisher/1',
      domain_separator: domains.manifest,
    },
  ].sort((left, right) => compareAscii(left.format, right.format));
  entries.push([
    paths.domains,
    artifact(
      'icarus.workflow-staged-publish-domain-separators/1',
      'icarus.workflow-staged-publish-domain-separators',
      domains.catalog,
      { entries: domainEntries },
    ),
  ]);
  return entries;
}

function buildManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  return artifact(
    'icarus.workflow-contract-pack-g3-workflow-publisher/1',
    'icarus.workflow-contract-pack-g3-workflow-publisher',
    domains.manifest,
    {
      gate: 'G3',
      slice: 'G3.7',
      status: 'DONE',
      g3_status: 'IN_PROGRESS',
      publisher_schema_readiness: 'PUBLISHER_SCHEMA_PREREQUISITE_READY',
      request_schema_resource_hash: G37_SCHEMA_RESOURCE_HASHES.request,
      receipt_schema_resource_hash: G37_SCHEMA_RESOURCE_HASHES.receipt,
      result_schema_resource_hash: G37_SCHEMA_RESOURCE_HASHES.result,
      preflights_composed: ['G3.1', 'G3.3', 'G3.5'],
      store_transaction: 'single_begin_immediate',
      durable_dispositions: ['applied', 'duplicate', 'conflict', 'failed'],
      registry_publication_written: true,
      staged_feature_release_written: true,
      published_retention_root_written: true,
      activation_or_active_pointer_written: false,
      production_loader_implemented: false,
      execution_artifact_build_or_install: false,
      gc_or_delete_implemented: false,
      g4_through_g9_status: 'NOT_READY',
      artifacts: artifacts.map(([artifactPath, entry]) => ({
        path: artifactPath,
        format: entry.format,
        ref: entry.ref,
        version: entry.version,
        domain_separator: entry.domain_separator,
        hash: entry.hash,
      })),
      positive_case_count: 1,
      negative_case_count: 3,
    },
  );
}

function validateAll(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
): void {
  const fixture = g37WorkflowPublisherStoreFixtureForTest();
  validateG37WorkflowPublisherRequest(fixture.request);
  for (const [, entry] of artifacts) parseContractArtifactEnvelope(entry);
  parseContractArtifactEnvelope(manifest);
  if (canonicalJson(buildManifest(artifacts)) !== canonicalJson(manifest))
    throw new Error('G3.7 Contract Pack manifest is not deterministic');
}

export function generateG37WorkflowPublisherContracts(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateAll(artifacts, manifest);
  for (const [file, entry] of artifacts) writeAtomic(file, render(entry));
  writeAtomic(paths.manifest, render(manifest));
  return manifest;
}

export function checkG37WorkflowPublisherContracts(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateAll(artifacts, manifest);
  for (const [file, entry] of artifacts) {
    if (fs.readFileSync(absolute(file), 'utf8') !== render(entry))
      throw new Error(`G3.7 artifact bytes drift: ${file}`);
  }
  if (fs.readFileSync(absolute(paths.manifest), 'utf8') !== render(manifest))
    throw new Error('G3.7 Contract Pack manifest bytes drift');
  return manifest;
}
