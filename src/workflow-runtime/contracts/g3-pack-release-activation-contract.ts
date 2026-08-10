import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { compareAscii } from './g3-registry-persistence.js';
import {
  deterministicG39FixtureDigest,
  g39ActivationFaultCases,
  g39ActivationPositiveCases,
  g39PackReleaseActivationStoreFixtureForTest,
} from './g3-pack-release-activation-fixtures.js';
import {
  G39_ACTIVATION_ERROR_PRECEDENCE,
  G39_PACK_RELEASE_ACTIVATION_FORMATS,
} from './g3-pack-release-activation-types.js';
import {
  G39_COMMAND_ID_DOMAIN,
  G39_DOMAIN_REQUEST_DOMAIN,
  G39_EVENT_DOMAIN,
  G39_INVOCATION_DOMAIN,
  G39_RECEIPT_DOMAIN,
  G39_RECEIPT_SCHEMA,
  G39_REQUEST_DOMAIN,
  G39_REQUEST_SCHEMA,
  G39_RESULT_DOMAIN,
  G39_RESULT_SCHEMA,
  G39_SCHEMA_RESOURCE_HASHES,
  validateG39PackReleaseActivationRequest,
} from './g3-pack-release-activation.js';
import { calculateArtifactHash, canonicalJson } from './hash.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const contractsRoot = import.meta.dirname;
const root = 'conformance/g3.9-pack-release-activation';
const paths = {
  requestSchema:
    'registry/workflow-pack-release-activation-request-schema@1.json',
  receiptSchema:
    'registry/workflow-pack-release-activation-receipt-schema@1.json',
  resultSchema:
    'registry/workflow-pack-release-activation-result-schema@1.json',
  positive: `${root}/positive-cases.json`,
  negative: `${root}/negative-cases.json`,
  fault: `${root}/fault-cases.json`,
  domains: 'registry/workflow-pack-release-activation-domain-separators@1.json',
  manifest: 'contract-pack-g3.9-pack-release-activation.json',
} as const;

const domains = {
  requestSchema: 'icarus:workflow-pack-release-activation-request-schema:1\n',
  receiptSchema: 'icarus:workflow-pack-release-activation-receipt-schema:1\n',
  resultSchema: 'icarus:workflow-pack-release-activation-result-schema:1\n',
  positive: 'icarus:workflow-g3-pack-release-activation-positive-cases:1\n',
  negative: 'icarus:workflow-g3-pack-release-activation-negative-cases:1\n',
  fault: 'icarus:workflow-g3-pack-release-activation-fault-cases:1\n',
  catalog: 'icarus:workflow-pack-release-activation-domain-separators:1\n',
  manifest: 'icarus:workflow-contract-pack-g3-pack-release-activation:1\n',
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
    throw new Error(`G3.9 path escapes Contracts root: ${relativePath}`);
  return resolved;
}

function render(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(relativePath: string, value: JsonValue): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, render(value), 'utf8');
  fs.renameSync(temporary, target);
}

function negativeCases(): JsonObject[] {
  const structural: JsonObject[] = [
    {
      case_id: 'negative.strict.invalid-utf8',
      layer: 'request_bytes',
      mutation: 'invalid_utf8',
      expected_code: 'activation_request_strict_parse_invalid',
    },
    {
      case_id: 'negative.strict.duplicate-key',
      layer: 'request_bytes',
      mutation: 'duplicate_top_level_key',
      expected_code: 'activation_request_strict_parse_invalid',
    },
    {
      case_id: 'negative.removed.current-release',
      layer: 'request',
      mutation: 'add_removed_current_release',
      expected_code: 'activation_request_removed_field',
    },
    {
      case_id: 'negative.unknown.active-release',
      layer: 'request',
      mutation: 'add_unknown_active_release',
      expected_code: 'activation_request_unknown_field',
    },
    {
      case_id: 'negative.schema.previous-with-absent-pointer',
      layer: 'request',
      mutation: 'previous_claim_without_present_pointer',
      expected_code: 'activation_request_schema_invalid',
    },
    {
      case_id: 'negative.hash.request-drift',
      layer: 'request',
      mutation: 'request_hash_drift',
      expected_code: 'activation_request_hash_mismatch',
    },
  ];
  const precedence: JsonObject[] = [];
  for (const [index, code] of G39_ACTIVATION_ERROR_PRECEDENCE.entries()) {
    precedence.push({
      case_id: `negative.precedence.${code}`,
      layer: 'runtime_precedence',
      precedence_rank: index + 1,
      expected_code: code,
      receipt: null,
      pointer_transition_count: 0,
    });
  }
  return [...structural, ...precedence];
}

function buildArtifacts(): Array<[string, ContractArtifactEnvelope]> {
  const entries: Array<[string, ContractArtifactEnvelope]> = [
    [
      paths.requestSchema,
      artifact(
        'icarus.workflow-pack-release-activation-request-schema/1',
        'icarus.workflow-pack-release-activation-request-schema',
        domains.requestSchema,
        G39_REQUEST_SCHEMA,
      ),
    ],
    [
      paths.receiptSchema,
      artifact(
        'icarus.workflow-pack-release-activation-receipt-schema/1',
        'icarus.workflow-pack-release-activation-receipt-schema',
        domains.receiptSchema,
        G39_RECEIPT_SCHEMA,
      ),
    ],
    [
      paths.resultSchema,
      artifact(
        'icarus.workflow-pack-release-activation-result-schema/1',
        'icarus.workflow-pack-release-activation-result-schema',
        domains.resultSchema,
        G39_RESULT_SCHEMA,
      ),
    ],
    [
      paths.positive,
      artifact(
        'icarus.workflow-g3-pack-release-activation-positive-cases/1',
        'icarus.workflow-g3-pack-release-activation-positive-cases',
        domains.positive,
        {
          fixture_scope: 'test_only',
          cases: g39ActivationPositiveCases(),
        },
      ),
    ],
    [
      paths.negative,
      artifact(
        'icarus.workflow-g3-pack-release-activation-negative-cases/1',
        'icarus.workflow-g3-pack-release-activation-negative-cases',
        domains.negative,
        { fixture_scope: 'test_only', cases: negativeCases() },
      ),
    ],
    [
      paths.fault,
      artifact(
        'icarus.workflow-g3-pack-release-activation-fault-cases/1',
        'icarus.workflow-g3-pack-release-activation-fault-cases',
        domains.fault,
        {
          fixture_scope: 'test_only_real_file_sqlite',
          cases: g39ActivationFaultCases(),
        },
      ),
    ],
  ];
  const catalogEntries = [
    ...entries.map(([, entry]) => ({
      format: entry.format,
      domain_separator: entry.domain_separator,
    })),
    {
      format: G39_PACK_RELEASE_ACTIVATION_FORMATS.request,
      domain_separator: G39_REQUEST_DOMAIN,
    },
    {
      format: 'icarus.workflow-pack-release-activation-domain-request/1',
      domain_separator: G39_DOMAIN_REQUEST_DOMAIN,
    },
    {
      format: G39_PACK_RELEASE_ACTIVATION_FORMATS.receipt,
      domain_separator: G39_RECEIPT_DOMAIN,
    },
    {
      format: G39_PACK_RELEASE_ACTIVATION_FORMATS.result,
      domain_separator: G39_RESULT_DOMAIN,
    },
    {
      format: 'icarus.workflow-pack-release-activation-invocation/1',
      domain_separator: G39_INVOCATION_DOMAIN,
    },
    {
      format: 'icarus.workflow-pack-release-activation-event/1',
      domain_separator: G39_EVENT_DOMAIN,
    },
    {
      format: 'icarus.workflow-pack-release-activation-command-id/1',
      domain_separator: G39_COMMAND_ID_DOMAIN,
    },
    {
      format: 'icarus.workflow-pack-release-activation-domain-separators/1',
      domain_separator: domains.catalog,
    },
    {
      format: 'icarus.workflow-contract-pack-g3-pack-release-activation/1',
      domain_separator: domains.manifest,
    },
  ].sort((left, right) => compareAscii(left.format, right.format));
  entries.push([
    paths.domains,
    artifact(
      'icarus.workflow-pack-release-activation-domain-separators/1',
      'icarus.workflow-pack-release-activation-domain-separators',
      domains.catalog,
      { entries: catalogEntries },
    ),
  ]);
  return entries;
}

function buildManifest(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
): ContractArtifactEnvelope {
  return artifact(
    'icarus.workflow-contract-pack-g3-pack-release-activation/1',
    'icarus.workflow-contract-pack-g3-pack-release-activation',
    domains.manifest,
    {
      gate: 'G3',
      slice: 'G3.9',
      status: 'DONE',
      g3_status: 'EXIT_CANDIDATE_PENDING_INDEPENDENT_G3_REGRESSION',
      schema_resource_hashes: G39_SCHEMA_RESOURCE_HASHES,
      fixture_digest: deterministicG39FixtureDigest(),
      error_precedence: [...G39_ACTIVATION_ERROR_PRECEDENCE],
      command_boundary:
        'workflow_pack_release_activation_commands/invocations/events',
      forbidden_command_unions: [
        'workflow_runtime_commands',
        'runtime_capacity_admin_commands',
        'workflow_publisher_commands',
      ],
      store_transaction: 'single_begin_immediate',
      compatibility_check: 'direct_runtime_abi_major',
      active_pointer_dml: 'adjacent_cas_only',
      receipt_owner: 'committed_pointer_transition_only',
      recovery:
        'bounded_pending_scan_then_strict_terminal_and_chain_verification',
      positive_case_count: g39ActivationPositiveCases().length,
      negative_case_count: negativeCases().length,
      fault_case_count: g39ActivationFaultCases().length,
      artifacts: artifacts.map(([artifactPath, entry]) => ({
        path: artifactPath,
        format: entry.format,
        ref: entry.ref,
        version: entry.version,
        domain_separator: entry.domain_separator,
        hash: entry.hash,
      })),
      production_loader_implemented: false,
      execution_artifact_build_or_install: false,
      gc_or_delete_implemented: false,
      authoring_stages_implemented: false,
      g4_through_g9_status: 'NOT_READY',
    },
  );
}

function validateAll(
  artifacts: Array<[string, ContractArtifactEnvelope]>,
  manifest: ContractArtifactEnvelope,
): void {
  const fixture = g39PackReleaseActivationStoreFixtureForTest();
  validateG39PackReleaseActivationRequest(fixture.activation_request);
  if (
    canonicalJson(fixture.activation_request) !==
    fixture.activation_request_bytes.toString('utf8')
  ) {
    throw new Error('G3.9 canonical request fixture bytes drift');
  }
  for (const [, entry] of artifacts) parseContractArtifactEnvelope(entry);
  parseContractArtifactEnvelope(manifest);
  if (canonicalJson(buildManifest(artifacts)) !== canonicalJson(manifest))
    throw new Error('G3.9 Contract Pack manifest is not deterministic');
}

export function generateG39PackReleaseActivationContracts(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateAll(artifacts, manifest);
  for (const [file, entry] of artifacts) writeAtomic(file, entry);
  writeAtomic(paths.manifest, manifest);
  return manifest;
}

export function checkG39PackReleaseActivationContracts(): ContractArtifactEnvelope {
  const artifacts = buildArtifacts();
  const manifest = buildManifest(artifacts);
  validateAll(artifacts, manifest);
  for (const [file, entry] of artifacts) {
    if (fs.readFileSync(absolute(file), 'utf8') !== render(entry))
      throw new Error(`G3.9 artifact bytes drift: ${file}`);
  }
  if (fs.readFileSync(absolute(paths.manifest), 'utf8') !== render(manifest))
    throw new Error('G3.9 Contract Pack manifest bytes drift');
  return manifest;
}

export function g39ContractCountsForTest(): {
  positive: number;
  negative: number;
  fault: number;
} {
  return {
    positive: g39ActivationPositiveCases().length,
    negative: negativeCases().length,
    fault: g39ActivationFaultCases().length,
  };
}
