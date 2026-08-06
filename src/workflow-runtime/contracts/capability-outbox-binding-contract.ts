import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  buildCompiledScopePlanV2ExecutionBindingSchema,
  buildCompilerConformanceCaseResultExecutionBindingSchema,
} from './compiler-contract-repair-artifacts.js';
import { calculateArtifactHash, domainSeparatedSha256 } from './hash.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;

export const CAPABILITY_OUTBOX_BINDING_ROOT =
  'conformance/capability-outbox-execution-binding';
export const CAPABILITY_OUTBOX_COMPILED_PLAN_SCHEMA_PATH = `${CAPABILITY_OUTBOX_BINDING_ROOT}/schemas/compiled-scope-plan-v2-execution-binding-schema@1.json`;
export const CAPABILITY_OUTBOX_CONFORMANCE_RESULT_SCHEMA_PATH = `${CAPABILITY_OUTBOX_BINDING_ROOT}/schemas/compiler-conformance-case-result-execution-binding-schema@1.json`;
export const CAPABILITY_OUTBOX_SNAPSHOT_SCHEMA_PATH = `${CAPABILITY_OUTBOX_BINDING_ROOT}/schemas/capability-outbox-snapshot-schema@1.json`;
export const CAPABILITY_OUTBOX_HANDOFF_SCHEMA_PATH = `${CAPABILITY_OUTBOX_BINDING_ROOT}/schemas/schema5-outbox-handoff-schema@1.json`;
export const CAPABILITY_OUTBOX_POSITIVE_CASES_PATH = `${CAPABILITY_OUTBOX_BINDING_ROOT}/positive-cases.json`;
export const CAPABILITY_OUTBOX_NEGATIVE_CASES_PATH = `${CAPABILITY_OUTBOX_BINDING_ROOT}/negative-cases.json`;
export const CAPABILITY_OUTBOX_MANIFEST_PATH = `${CAPABILITY_OUTBOX_BINDING_ROOT}/contract-pack-capability-outbox-execution-binding.json`;

export const CAPABILITY_OUTBOX_ADAPTER_DOMAIN =
  'icarus:workflow-outbox-adapter:1\n';
export const CAPABILITY_OUTBOX_POLICY_DOMAIN =
  'icarus:workflow-outbox-delivery-policy:1\n';
export const CAPABILITY_OUTBOX_POLICY_SNAPSHOT_DOMAIN =
  'icarus:workflow-outbox-effective-policy-snapshot:1\n';
export const CAPABILITY_OUTBOX_EXECUTION_BINDING_DOMAIN =
  'icarus:workflow-capability-outbox-execution-binding:1\n';

const ARTIFACT_DOMAINS = Object.freeze({
  compiledSchema:
    'icarus:workflow-compiled-scope-plan-v2-execution-binding-schema:1\n',
  resultSchema:
    'icarus:workflow-compiler-conformance-case-result-execution-binding-schema:1\n',
  snapshotSchema: 'icarus:workflow-capability-outbox-snapshot-schema:1\n',
  handoffSchema: 'icarus:workflow-schema5-outbox-handoff-schema:1\n',
  positive: 'icarus:workflow-capability-outbox-positive-cases:1\n',
  negative: 'icarus:workflow-capability-outbox-negative-cases:1\n',
  manifest: 'icarus:workflow-capability-outbox-contract-pack:1\n',
});

const hashSchema: JsonObject = {
  type: 'string',
  pattern: '^sha256:[0-9a-f]{64}$',
};
const versionedRefSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 255 },
    version: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      not: {
        pattern: '^(?:current|head|latest|main|master|next|snapshot)$',
      },
    },
  },
};

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

function compiledSchemaPayload(): JsonObject {
  return buildCompiledScopePlanV2ExecutionBindingSchema();
}

function snapshotSchemaPayload(): JsonObject {
  const compiled = compiledSchemaPayload();
  assertJsonObject(compiled.$defs);
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://icarus.local/schemas/capability-outbox-snapshot/1',
    type: 'object',
    additionalProperties: false,
    required: ['capability', 'adapter', 'delivery_policy'],
    properties: {
      capability: { $ref: '#/$defs/capability_resource' },
      adapter: { $ref: '#/$defs/adapter_resource' },
      delivery_policy: { $ref: '#/$defs/policy_resource' },
    },
    $defs: {
      ...compiled.$defs,
      versioned_ref: versionedRefSchema,
      hash: hashSchema,
      versioned_resource: {
        type: 'object',
        additionalProperties: false,
        required: [
          'resource_type',
          'ref',
          'content_hash',
          'publication_state',
          'launchability',
          'content',
        ],
        properties: {
          resource_type: { type: 'string' },
          ref: { $ref: '#/$defs/versioned_ref' },
          content_hash: { $ref: '#/$defs/hash' },
          publication_state: { const: 'published' },
          launchability: { enum: ['production', 'test_only'] },
          content: { type: 'object' },
        },
      },
      capability_resource: {
        type: 'object',
        additionalProperties: false,
        required: [
          'resource_type',
          'ref',
          'content_hash',
          'publication_state',
          'launchability',
          'content',
        ],
        properties: {
          resource_type: { const: 'capability' },
          ref: { $ref: '#/$defs/versioned_ref' },
          content_hash: { $ref: '#/$defs/hash' },
          publication_state: { const: 'published' },
          launchability: { enum: ['production', 'test_only'] },
          content: { $ref: '#/$defs/workflow_capability' },
        },
      },
      adapter_resource: {
        type: 'object',
        additionalProperties: false,
        required: [
          'resource_type',
          'ref',
          'content_hash',
          'publication_state',
          'launchability',
          'content',
        ],
        properties: {
          resource_type: { const: 'outbox_adapter' },
          ref: { $ref: '#/$defs/versioned_ref' },
          content_hash: { $ref: '#/$defs/hash' },
          publication_state: { const: 'published' },
          launchability: { enum: ['production', 'test_only'] },
          content: {
            type: 'object',
            additionalProperties: false,
            required: [
              'format',
              'ref',
              'supported_effect_types',
              'supported_delivery_lanes',
              'supported_reconciliation',
              'supported_idempotency',
              'adapter_hash',
            ],
            properties: {
              format: { const: 'icarus.workflow-outbox-adapter/1' },
              ref: { $ref: '#/$defs/versioned_ref' },
              supported_effect_types: {
                type: 'array',
                items: { type: 'string' },
                uniqueItems: true,
              },
              supported_delivery_lanes: {
                type: 'array',
                items: {
                  enum: [
                    'normal_execution',
                    'close_cleanup',
                    'system_projection',
                  ],
                },
                uniqueItems: true,
              },
              supported_reconciliation: {
                type: 'array',
                items: { enum: ['not_required', 'by_effect_key'] },
                uniqueItems: true,
              },
              supported_idempotency: {
                type: 'array',
                items: { enum: ['provider_key', 'external_lookup'] },
                uniqueItems: true,
              },
              adapter_hash: { $ref: '#/$defs/hash' },
            },
          },
        },
      },
      policy_resource: {
        type: 'object',
        additionalProperties: false,
        required: [
          'resource_type',
          'ref',
          'content_hash',
          'publication_state',
          'launchability',
          'content',
        ],
        properties: {
          resource_type: { const: 'outbox_policy' },
          ref: { $ref: '#/$defs/versioned_ref' },
          content_hash: { $ref: '#/$defs/hash' },
          publication_state: { const: 'published' },
          launchability: { enum: ['production', 'test_only'] },
          content: { $ref: '#/$defs/outbox_delivery_policy' },
        },
      },
    },
  };
}

function handoffSchemaPayload(): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://icarus.local/schemas/schema5-outbox-handoff/1',
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'binding_hash',
      'adapter_registry_identity',
      'delivery_policy_registry_identity',
      'policy_snapshot_value_identity',
      'outbox_columns',
    ],
    properties: {
      format: { const: 'icarus.workflow-schema5-outbox-handoff/1' },
      binding_hash: hashSchema,
      adapter_registry_identity: {
        $ref: '#/$defs/registry_identity',
      },
      delivery_policy_registry_identity: {
        $ref: '#/$defs/registry_identity',
      },
      policy_snapshot_value_identity: {
        type: 'object',
        additionalProperties: false,
        required: ['value_id', 'content_hash'],
        properties: {
          value_id: { type: 'string', minLength: 1 },
          content_hash: hashSchema,
        },
      },
      outbox_columns: {
        type: 'object',
        additionalProperties: false,
        required: [
          'adapter_resource_id',
          'adapter_resource_hash',
          'delivery_policy_resource_id',
          'delivery_policy_resource_hash',
          'policy_snapshot_value_id',
          'policy_snapshot_hash',
        ],
        properties: {
          adapter_resource_id: { type: 'string', minLength: 1 },
          adapter_resource_hash: hashSchema,
          delivery_policy_resource_id: { type: 'string', minLength: 1 },
          delivery_policy_resource_hash: hashSchema,
          policy_snapshot_value_id: { type: 'string', minLength: 1 },
          policy_snapshot_hash: hashSchema,
        },
      },
    },
    $defs: {
      registry_identity: {
        type: 'object',
        additionalProperties: false,
        required: ['resource_type', 'ref', 'content_hash', 'registry_row_id'],
        properties: {
          resource_type: { enum: ['outbox_adapter', 'outbox_policy'] },
          ref: versionedRefSchema,
          content_hash: hashSchema,
          registry_row_id: { type: 'string', minLength: 1 },
        },
      },
    },
  };
}

function positiveCases(): JsonObject {
  return {
    format: 'icarus.workflow-capability-outbox-positive-cases/1',
    cases: [
      {
        case_id: 'published_exact_binding_lowers_to_finite_snapshot',
        expected: 'accepted',
      },
      {
        case_id: 'schema5_exact_fk_handoff',
        expected: 'accepted',
      },
    ],
  };
}

function negativeCases(): JsonObject {
  return {
    format: 'icarus.workflow-capability-outbox-negative-cases/1',
    cases: [
      'missing_binding',
      'mismatched_adapter_identity',
      'mismatched_policy_identity',
      'unpublished_adapter',
      'unpublished_policy',
      'latest_adapter_ref',
      'latest_policy_ref',
      'test_only_binding_for_production',
      'non_finite_delivery_policy',
      'policy_snapshot_hash_drift',
      'unknown_binding_field',
    ].map((caseId) => ({ case_id: caseId, expected: 'rejected' })),
  };
}

export function buildCapabilityOutboxBindingArtifacts(): Map<string, string> {
  const entries: Array<[string, ContractArtifactEnvelope]> = [
    [
      CAPABILITY_OUTBOX_COMPILED_PLAN_SCHEMA_PATH,
      artifact(
        'icarus.workflow-compiled-scope-plan-v2-execution-binding-schema/1',
        'icarus.workflow-compiled-scope-plan-v2-execution-binding-schema',
        ARTIFACT_DOMAINS.compiledSchema,
        compiledSchemaPayload(),
      ),
    ],
    [
      CAPABILITY_OUTBOX_SNAPSHOT_SCHEMA_PATH,
      artifact(
        'icarus.workflow-capability-outbox-snapshot-schema/1',
        'icarus.workflow-capability-outbox-snapshot-schema',
        ARTIFACT_DOMAINS.snapshotSchema,
        snapshotSchemaPayload(),
      ),
    ],
    [
      CAPABILITY_OUTBOX_CONFORMANCE_RESULT_SCHEMA_PATH,
      artifact(
        'icarus.workflow-compiler-conformance-case-result-execution-binding-schema/1',
        'icarus.workflow-compiler-conformance-case-result-execution-binding-schema',
        ARTIFACT_DOMAINS.resultSchema,
        buildCompilerConformanceCaseResultExecutionBindingSchema(),
      ),
    ],
    [
      CAPABILITY_OUTBOX_HANDOFF_SCHEMA_PATH,
      artifact(
        'icarus.workflow-schema5-outbox-handoff-schema/1',
        'icarus.workflow-schema5-outbox-handoff-schema',
        ARTIFACT_DOMAINS.handoffSchema,
        handoffSchemaPayload(),
      ),
    ],
    [
      CAPABILITY_OUTBOX_POSITIVE_CASES_PATH,
      artifact(
        'icarus.workflow-capability-outbox-positive-cases/1',
        'icarus.workflow-capability-outbox-positive-cases',
        ARTIFACT_DOMAINS.positive,
        positiveCases(),
      ),
    ],
    [
      CAPABILITY_OUTBOX_NEGATIVE_CASES_PATH,
      artifact(
        'icarus.workflow-capability-outbox-negative-cases/1',
        'icarus.workflow-capability-outbox-negative-cases',
        ARTIFACT_DOMAINS.negative,
        negativeCases(),
      ),
    ],
  ];
  const manifest = artifact(
    'icarus.workflow-capability-outbox-contract-pack/1',
    'icarus.workflow-capability-outbox-contract-pack',
    ARTIFACT_DOMAINS.manifest,
    {
      plan_format: 'icarus.workflow-graph-scope-plan/2',
      artifacts: entries.map(([artifactPath, value]) => ({
        path: artifactPath,
        format: value.format,
        hash: value.hash,
      })),
    },
  );
  entries.push([CAPABILITY_OUTBOX_MANIFEST_PATH, manifest]);
  return new Map(
    entries.map(([artifactPath, value]) => [artifactPath, render(value)]),
  );
}

function absolute(relativePath: string): string {
  const resolved = path.resolve(contractsRoot, relativePath);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`)) {
    throw new Error(
      `Capability Outbox path escapes Contract root: ${relativePath}`,
    );
  }
  return resolved;
}

function writeAtomic(relativePath: string, contents: string): void {
  const target = absolute(relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(temporary, target);
}

function validateArtifacts(files: Map<string, string>): void {
  for (const contents of files.values()) {
    parseContractArtifactEnvelope(
      strictParseJsonBytes(Buffer.from(contents, 'utf8')),
    );
  }
  const compiled = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(files.get(CAPABILITY_OUTBOX_COMPILED_PLAN_SCHEMA_PATH) ?? ''),
    ),
  );
  new Ajv2020({ strict: true, allErrors: true }).compile(
    compiled.payload as AnySchema,
  );
  const snapshot = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(files.get(CAPABILITY_OUTBOX_SNAPSHOT_SCHEMA_PATH) ?? ''),
    ),
  );
  new Ajv2020({ strict: true, allErrors: true }).compile(
    snapshot.payload as AnySchema,
  );
  const result = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(
        files.get(CAPABILITY_OUTBOX_CONFORMANCE_RESULT_SCHEMA_PATH) ?? '',
      ),
    ),
  );
  new Ajv2020({ strict: true, allErrors: true }).compile(
    result.payload as AnySchema,
  );
  const handoff = parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(files.get(CAPABILITY_OUTBOX_HANDOFF_SCHEMA_PATH) ?? ''),
    ),
  );
  new Ajv2020({ strict: true, allErrors: true }).compile(
    handoff.payload as AnySchema,
  );
}

export function generateCapabilityOutboxBindingContract(): ContractArtifactEnvelope {
  const files = buildCapabilityOutboxBindingArtifacts();
  validateArtifacts(files);
  for (const [relativePath, contents] of files)
    writeAtomic(relativePath, contents);
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(files.get(CAPABILITY_OUTBOX_MANIFEST_PATH) ?? '', 'utf8'),
    ),
  );
}

export function checkCapabilityOutboxBindingContract(): ContractArtifactEnvelope {
  const files = buildCapabilityOutboxBindingArtifacts();
  validateArtifacts(files);
  for (const [relativePath, contents] of files) {
    if (!fs.existsSync(absolute(relativePath))) {
      throw new Error(`Capability Outbox artifact missing: ${relativePath}`);
    }
    if (fs.readFileSync(absolute(relativePath), 'utf8') !== contents) {
      throw new Error(`Capability Outbox artifact drift: ${relativePath}`);
    }
  }
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      Buffer.from(files.get(CAPABILITY_OUTBOX_MANIFEST_PATH) ?? '', 'utf8'),
    ),
  );
}

export function capabilityOutboxPolicySnapshotHash(
  snapshotWithoutHash: JsonObject,
): Sha256Hash {
  return domainSeparatedSha256(
    CAPABILITY_OUTBOX_POLICY_SNAPSHOT_DOMAIN,
    snapshotWithoutHash,
  );
}
