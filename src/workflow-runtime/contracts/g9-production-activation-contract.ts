import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from './artifact.js';
import { domainSeparatedSha256 } from './hash.js';
import {
  G9_DEPLOYMENT_JOURNAL_PHASES,
  G9_DEPLOYMENT_PARTICIPANTS,
  G9_PRODUCTION_ACTIVATION_ENTRY,
  G9_PRODUCTION_RELEASE_MANIFEST_FILENAME,
  G9_PRODUCTION_RELEASE_MANIFEST_FORMAT,
  G9_PRODUCTION_RELEASE_REF,
  type G9ProductionActivationContractPack,
} from './g9-production-activation-types.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repositoryRoot = path.resolve(contractsRoot, '../../..');

export const G9_PROJECT_RULESET_ID =
  'dynamic-workflow-runtime-controller-project-v2' as const;
export const G9_PROJECT_RULESET_BLOCK_SHA256 =
  'de02b6f7d4bf22c89159cba249eb4d764377d6ac146c8762d4612d4985fb19a5' as const;
export const G9_HISTORICAL_ACCEPTED_G8 = {
  candidate_commit: '540af100a61b9181aead6923b829729a843c5ec1',
  release_artifact_hash:
    'sha256:8234f51bc669f5c5119e6b3fee80565827b7af061b9013a59e513c90b09f9243',
  core_build_hash:
    'sha256:2778eef831bcff49bfff80df4d8a63f6f8a05164664c28d5f4537902e25dd5f5',
  startup_report_hash:
    'sha256:ed5a15c8bfb267bb01eb43826249580b83368d1f6207d1e513884d23e19cb88c',
  readiness_report_hash:
    'sha256:222691989044f781e57f7e4d8113e93ada3de0a3d81a5a32cc291c146404563e',
} as const;
export const G9_DATABASE_SCHEMA_HASH =
  'sha256:ad998b2d0bb5e5f158b0be6d13db79cb6a0c0650d5064b267262551af266189c' as const;

const schemaPaths = {
  release:
    'production-activation/schemas/core-production-release-manifest-schema.json',
  coreBinding:
    'production-activation/schemas/core-runtime-launch-binding-v3-schema.json',
  deploymentBinding:
    'production-activation/schemas/deployment-activation-binding-schema.json',
  journal:
    'production-activation/schemas/deployment-activation-journal-event-schema.json',
  audit:
    'production-activation/schemas/production-activation-audit-schema.json',
  request:
    'production-activation/schemas/production-activation-request-schema.json',
} as const;
const protocolPath =
  'production-activation/g9-production-activation-protocol@1.json';
const packPath = 'contract-pack-g9-production-activation.json';

export const G9_IMPLEMENTATION_SOURCE_PATHS = [
  'package.json',
  'scripts/clean-typescript-output.mjs',
  'scripts/runtime-launcher.sh',
  'scripts/runtime-toolchain.sh',
  'src/workflow-runtime/compiler/artifacts.ts',
  'src/workflow-runtime/certification/release-manifest.ts',
  'src/workflow-runtime/certification/g9-production-release-cli.ts',
  'src/workflow-runtime/contracts/g9-production-activation-contract.ts',
  'src/workflow-runtime/contracts/g9-production-activation-types.ts',
  'src/workflow-runtime/creation/routing-resolver.ts',
  'src/workflow-runtime/projection/workflow-projection.ts',
  'src/workflow-runtime/registry/production-activation-entry.ts',
  'src/workflow-runtime/registry/production-activation-runtime.ts',
  'src/workflow-runtime/registry/production-activation.ts',
  'src/workflow-runtime/store/runtime-store/identity.ts',
] as const;

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonBytes(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function artifact(
  format: string,
  ref: { id: string; version: string },
  domain: string,
  payload: JsonObject,
): ContractArtifactEnvelope {
  const withoutHash = {
    format,
    ref,
    version: 1,
    domain_separator: domain,
    payload,
  };
  return {
    ...withoutHash,
    hash: domainSeparatedSha256(domain, withoutHash as JsonValue),
  };
}

const hashSchema = {
  type: 'string',
  pattern: '^sha256:[0-9a-f]{64}$',
} as const;
const nonNegativeSafeInteger = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
const positiveSafeInteger = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
const versionedRefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 255 },
    version: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

function releaseManifestSchema(): JsonObject {
  const required = [
    'format',
    'ref',
    'release_scope',
    'build_kind',
    'activation_status',
    'historical_g8_release_artifact_hash',
    'g9_activation_contract_hash',
    'static_source_core_build_hash',
    'workflow_runtime_absence_baseline_hash',
    'product_surface_coverage_manifest_hash',
    'migration_candidate_boundary_manifest_hash',
    'platform',
    'arch',
    'run_protocol_majors',
    'executor_abi_majors',
    'database_schema_version',
    'database_schema_hash',
    'managed_node_distribution_ref',
    'managed_node_distribution_hash',
    'runtime_launcher_hash',
    'runtime_toolchain_hash',
    'core_entry_relative_path',
    'core_entry_sha256',
    'validation_entry_relative_path',
    'validation_entry_sha256',
    'activation_entry_relative_path',
    'activation_entry_sha256',
    'core_build_hash',
    'inventory',
    'inventory_hash',
    'release_artifact_hash',
  ];
  const hashFields = Object.fromEntries(
    required
      .filter((key) => key.endsWith('_hash') || key.endsWith('_sha256'))
      .map((key) => [key, hashSchema]),
  );
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:core-production-release-manifest:1',
    title: 'Icarus G9 Production Candidate Core Release Manifest',
    type: 'object',
    additionalProperties: false,
    required,
    properties: {
      format: { const: G9_PRODUCTION_RELEASE_MANIFEST_FORMAT },
      ref: {
        ...versionedRefSchema,
        properties: {
          id: { const: G9_PRODUCTION_RELEASE_REF.id },
          version: { const: G9_PRODUCTION_RELEASE_REF.version },
        },
      },
      release_scope: { const: 'workflow_runtime_g9_production_candidate' },
      build_kind: { const: 'release' },
      activation_status: {
        const: 'pending_fresh_independent_g8_boundary',
      },
      ...hashFields,
      platform: { const: 'darwin' },
      arch: { const: 'arm64' },
      run_protocol_majors: {
        type: 'array',
        prefixItems: [{ const: 1 }],
        items: false,
        minItems: 1,
        maxItems: 1,
      },
      executor_abi_majors: {
        type: 'array',
        prefixItems: [{ const: 1 }],
        items: false,
        minItems: 1,
        maxItems: 1,
      },
      database_schema_version: { const: 11 },
      managed_node_distribution_ref: versionedRefSchema,
      core_entry_relative_path: { const: 'dist/index.js' },
      validation_entry_relative_path: {
        const: 'dist/workflow-runtime/certification/release-entry.js',
      },
      activation_entry_relative_path: {
        const: G9_PRODUCTION_ACTIVATION_ENTRY,
      },
      inventory: {
        type: 'array',
        minItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'byte_length', 'executable', 'raw_sha256'],
          properties: {
            path: {
              type: 'string',
              minLength: 1,
              pattern: '^(?!/)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*//)[^\\\\]+$',
            },
            byte_length: nonNegativeSafeInteger,
            executable: { type: 'boolean' },
            raw_sha256: hashSchema,
          },
        },
      },
    },
  } as unknown as JsonObject;
}

function coreBindingSchema(): JsonObject {
  const required = [
    'format',
    'binding_kind',
    'core_release_relative_path',
    'release_manifest_relative_path',
    'release_manifest_sha256',
    'release_artifact_hash',
    'core_build_hash',
    'core_entry_relative_path',
    'core_entry_sha256',
    'validation_entry_relative_path',
    'validation_entry_sha256',
    'activation_entry_relative_path',
    'activation_entry_sha256',
    'managed_node_manifest_hash',
    'binding_hash',
  ];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:core-runtime-launch-binding:3',
    title: 'Icarus Content-addressed Production Core Launch Binding v3',
    type: 'object',
    additionalProperties: false,
    required,
    properties: {
      format: { const: 'icarus.core-runtime-launch-binding/3' },
      binding_kind: { const: 'content_addressed_production_release' },
      core_release_relative_path: {
        type: 'string',
        pattern: '^core-releases/[0-9a-f]{64}$',
      },
      release_manifest_relative_path: {
        const: G9_PRODUCTION_RELEASE_MANIFEST_FILENAME,
      },
      release_manifest_sha256: hashSchema,
      release_artifact_hash: hashSchema,
      core_build_hash: hashSchema,
      core_entry_relative_path: { const: 'dist/index.js' },
      core_entry_sha256: hashSchema,
      validation_entry_relative_path: {
        const: 'dist/workflow-runtime/certification/release-entry.js',
      },
      validation_entry_sha256: hashSchema,
      activation_entry_relative_path: {
        const: G9_PRODUCTION_ACTIVATION_ENTRY,
      },
      activation_entry_sha256: hashSchema,
      managed_node_manifest_hash: hashSchema,
      binding_hash: hashSchema,
    },
  } as JsonObject;
}

function applicableG8Schema(): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'status',
      'release_artifact_hash',
      'startup_report_hash',
      'readiness_report_hash',
      'startup_harness_hash',
      'readiness_harness_hash',
      'sqlite_profile_candidate_hash',
      'node_executable_hash',
      'native_module_hash',
    ],
    properties: {
      status: { const: 'fresh_independent_boundary_pass' },
      release_artifact_hash: hashSchema,
      startup_report_hash: hashSchema,
      readiness_report_hash: hashSchema,
      startup_harness_hash: hashSchema,
      readiness_harness_hash: hashSchema,
      sqlite_profile_candidate_hash: hashSchema,
      node_executable_hash: hashSchema,
      native_module_hash: hashSchema,
    },
  } as JsonObject;
}

function deploymentBindingSchema(): JsonObject {
  const capacityFresh = {
    type: 'object',
    additionalProperties: false,
    required: [
      'mode',
      'expected_head_state',
      'baseline_config_hash',
      'expected_capacity_revision',
      'expected_change_id',
      'expected_publication_hash',
      'expected_audit_head_hash',
      'genesis_core_release_hash',
      'genesis_command_id',
      'genesis_idempotency_key',
      'genesis_auth_session_ref',
      'genesis_evidence_manifest_id',
      'genesis_evidence_manifest_hash',
      'genesis_result_schema_row_id',
      'genesis_result_schema_resource_type',
      'genesis_result_schema_ref',
      'genesis_result_schema_hash',
    ],
    properties: {
      mode: { const: 'fresh_genesis' },
      expected_head_state: { const: 'absent' },
      baseline_config_hash: hashSchema,
      expected_capacity_revision: { const: 1 },
      expected_change_id: { type: 'string', minLength: 1, maxLength: 255 },
      expected_publication_hash: hashSchema,
      expected_audit_head_hash: hashSchema,
      genesis_core_release_hash: hashSchema,
      genesis_command_id: { type: 'string', minLength: 1, maxLength: 255 },
      genesis_idempotency_key: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
      },
      genesis_auth_session_ref: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
      },
      genesis_evidence_manifest_id: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
      },
      genesis_evidence_manifest_hash: hashSchema,
      genesis_result_schema_row_id: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
      },
      genesis_result_schema_resource_type: { const: 'schema' },
      genesis_result_schema_ref: versionedRefSchema,
      genesis_result_schema_hash: hashSchema,
    },
  };
  const capacityExisting = {
    type: 'object',
    additionalProperties: false,
    required: [
      'mode',
      'capacity_revision',
      'change_id',
      'config_hash',
      'publication_hash',
      'publication_file_raw_hash',
      'audit_head_hash',
    ],
    properties: {
      mode: { const: 'existing_preserved' },
      capacity_revision: positiveSafeInteger,
      change_id: { type: 'string', minLength: 1, maxLength: 255 },
      config_hash: hashSchema,
      publication_hash: hashSchema,
      publication_file_raw_hash: hashSchema,
      audit_head_hash: hashSchema,
    },
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:deployment-activation-binding:1',
    title: 'Icarus Deployment Activation Binding',
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'deployment_profile',
      'runtime_surface',
      'release_manifest_hash',
      'release_artifact_hash',
      'core_build_hash',
      'core_binding_hash',
      'applicable_g8_evidence',
      'static_authority',
      'feature_registry_pointer',
      'runtime_center_projection',
      'capacity_authority',
      'activation_audit_hash',
      'binding_hash',
    ],
    properties: {
      format: { const: 'icarus.deployment-activation-binding/1' },
      deployment_profile: { const: 'local_single_user' },
      runtime_surface: { const: 'node_service' },
      release_manifest_hash: hashSchema,
      release_artifact_hash: hashSchema,
      core_build_hash: hashSchema,
      core_binding_hash: hashSchema,
      applicable_g8_evidence: applicableG8Schema(),
      static_authority: {
        type: 'object',
        additionalProperties: false,
        required: [
          'source_core_build_hash',
          'absence_baseline_hash',
          'product_surface_manifest_hash',
          'migration_candidate_boundary_hash',
        ],
        properties: {
          source_core_build_hash: hashSchema,
          absence_baseline_hash: hashSchema,
          product_surface_manifest_hash: hashSchema,
          migration_candidate_boundary_hash: hashSchema,
        },
      },
      feature_registry_pointer: {
        type: 'object',
        additionalProperties: false,
        required: [
          'state',
          'active_release_count',
          'pointers',
          'pointer_aggregate_hash',
        ],
        properties: {
          state: { enum: ['empty', 'present'] },
          active_release_count: nonNegativeSafeInteger,
          pointers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['feature_id', 'release_id', 'release_hash'],
              properties: {
                feature_id: { type: 'string', minLength: 1, maxLength: 255 },
                release_id: { type: 'string', minLength: 1, maxLength: 255 },
                release_hash: hashSchema,
              },
            },
          },
          pointer_aggregate_hash: hashSchema,
        },
      },
      runtime_center_projection: {
        type: 'object',
        additionalProperties: false,
        required: [
          'projection_version',
          'generations',
          'generation_aggregate_hash',
        ],
        properties: {
          projection_version: { const: 'g7.1' },
          generations: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'view',
                'generation_id',
                'source_head_seq',
                'rows_hash',
              ],
              properties: {
                view: {
                  enum: ['workflows', 'agent_executions', 'pending', 'trace'],
                },
                generation_id: { type: 'string', minLength: 1, maxLength: 255 },
                source_head_seq: nonNegativeSafeInteger,
                rows_hash: hashSchema,
              },
            },
          },
          generation_aggregate_hash: hashSchema,
        },
      },
      capacity_authority: { oneOf: [capacityFresh, capacityExisting] },
      activation_audit_hash: hashSchema,
      binding_hash: hashSchema,
    },
  } as JsonObject;
}

function journalEventSchema(): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:deployment-activation-journal-event:1',
    title: 'Icarus Deployment Activation Journal Event',
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'activation_id',
      'sequence',
      'phase',
      'participant',
      'previous_event_hash',
      'previous_binding_hash',
      'target_binding_hash',
      'operation_key',
      'occurred_at_ms',
      'event_hash',
    ],
    properties: {
      format: { const: 'icarus.deployment-activation-journal-event/1' },
      activation_id: { type: 'string', minLength: 1, maxLength: 255 },
      sequence: nonNegativeSafeInteger,
      phase: { enum: [...G9_DEPLOYMENT_JOURNAL_PHASES] },
      participant: {
        type: ['string', 'null'],
        enum: [null, ...G9_DEPLOYMENT_PARTICIPANTS],
      },
      previous_event_hash: { anyOf: [hashSchema, { type: 'null' }] },
      previous_binding_hash: { anyOf: [hashSchema, { type: 'null' }] },
      target_binding_hash: hashSchema,
      operation_key: { type: 'string', minLength: 1, maxLength: 255 },
      occurred_at_ms: nonNegativeSafeInteger,
      event_hash: hashSchema,
    },
  } as JsonObject;
}

function auditSchema(): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:production-activation-audit:1',
    title: 'Icarus Production Activation Audit',
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'activation_id',
      'actor_ref',
      'requested_at_ms',
      'request_hash',
      'target_release_artifact_hash',
      'previous_deployment_binding_hash',
      'capacity_mode',
      'audit_hash',
    ],
    properties: {
      format: { const: 'icarus.production-activation-audit/1' },
      activation_id: { type: 'string', minLength: 1, maxLength: 255 },
      actor_ref: { const: 'system:production-activation' },
      requested_at_ms: nonNegativeSafeInteger,
      request_hash: hashSchema,
      target_release_artifact_hash: hashSchema,
      previous_deployment_binding_hash: {
        anyOf: [hashSchema, { type: 'null' }],
      },
      capacity_mode: { enum: ['fresh_genesis', 'existing_preserved'] },
      audit_hash: hashSchema,
    },
  } as JsonObject;
}

function requestSchema(): JsonObject {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:icarus:production-activation-request:1',
    title: 'Icarus Production Activation Request',
    type: 'object',
    additionalProperties: false,
    required: [
      'format',
      'operation',
      'activation_id',
      'operation_key',
      'requested_at_ms',
      'audit',
      'deployment_binding',
    ],
    properties: {
      format: { const: 'icarus.production-activation-request/1' },
      operation: { const: 'activate' },
      activation_id: { type: 'string', minLength: 1, maxLength: 255 },
      operation_key: { type: 'string', minLength: 1, maxLength: 255 },
      requested_at_ms: nonNegativeSafeInteger,
      audit: auditSchema(),
      deployment_binding: deploymentBindingSchema(),
    },
  } as JsonObject;
}

function sourceTreeHash(): Sha256Hash {
  const entries = [...G9_IMPLEMENTATION_SOURCE_PATHS].sort().map((file) => ({
    path: file,
    raw_sha256: rawSha256(fs.readFileSync(path.join(repositoryRoot, file))),
  }));
  return domainSeparatedSha256(
    'icarus:g9-production-activation-source-tree:1\n',
    entries,
  );
}

function buildArtifacts(): {
  schemas: Record<keyof typeof schemaPaths, JsonObject>;
  protocol: ContractArtifactEnvelope;
  pack: G9ProductionActivationContractPack;
} {
  const schemas = {
    release: releaseManifestSchema(),
    coreBinding: coreBindingSchema(),
    deploymentBinding: deploymentBindingSchema(),
    journal: journalEventSchema(),
    audit: auditSchema(),
    request: requestSchema(),
  };
  const schemaHashes = Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      rawSha256(Buffer.from(jsonBytes(schema), 'utf8')),
    ]),
  );
  const protocol = artifact(
    'icarus.workflow-runtime-g9-production-activation-protocol/1',
    {
      id: 'icarus.workflow-runtime-g9-production-activation-protocol',
      version: '1',
    },
    'icarus:workflow-runtime-g9-production-activation-protocol:1\n',
    {
      gate: 'G9',
      stage: 'pre_activation_construction',
      authority_resolution: 'option_a_new_exact_production_release',
      fixed_ruleset_id: 'dynamic-workflow-runtime-controller-fixed-v10',
      project_ruleset_id: G9_PROJECT_RULESET_ID,
      project_ruleset_block_sha256: G9_PROJECT_RULESET_BLOCK_SHA256,
      historical_g8: G9_HISTORICAL_ACCEPTED_G8,
      historical_g8_disposition:
        'immutable_acceptance_not_applicable_to_new_release',
      production_release_ref: G9_PRODUCTION_RELEASE_REF,
      production_release_status: 'pending_fresh_independent_g8_boundary',
      database_schema_version: 11,
      database_schema_hash: G9_DATABASE_SCHEMA_HASH,
      commit_point: 'active-deployment-content-addressed-pointer-swap',
      precommit_authority: 'previous_binding_or_absent',
      precommit_recovery: 'deterministic_rollback_reversible_prepare_only',
      postcommit_authority: 'target_deployment_binding',
      postcommit_recovery: 'idempotent_roll_forward_only',
      postcommit_commit_evidence_recovery:
        'append_missing_active_deployment_committed_before_roll_forward',
      fresh_capacity_phase: 'postcommit_roll_forward',
      fresh_capacity_terminal_recovery:
        'read_only_exact_head_audit_publication_file_and_result_convergence',
      release_build_inventory:
        'clean_compiler_owned_dist_before_tsc_and_content_inventory',
      existing_capacity_policy:
        'verify_twice_and_preserve_exactly_without_write',
      feature_activation_contract: 'standard_g3_publish_activate_only',
      projection_views: ['workflows', 'agent_executions', 'pending', 'trace'],
      production_recipe_inventory: 'zero_or_standard_published_only',
      activation_execution_status: 'forbidden_before_fresh_independent_g8_pass',
      extended_certification_plan: 'excluded',
      security_sensitive_validation:
        'STATIC_SOURCE_DIFF_EXISTING_TESTS_AND_NORMAL_POSITIVE_ONLY',
      source_tree_hash: sourceTreeHash(),
      schema_hashes: schemaHashes,
    },
  );
  const pack = artifact(
    'icarus.workflow-runtime-g9-production-activation-contract/1',
    {
      id: 'icarus.workflow-runtime-g9-production-activation-contract',
      version: '1',
    },
    'icarus:workflow-runtime-g9-production-activation-contract:1\n',
    {
      gate: 'G9',
      status: 'PRE_ACTIVATION_PRODUCTION_CANDIDATE_AUTHORITY',
      protocol_hash: protocol.hash,
      schema_hashes: schemaHashes,
      production_release_manifest_format: G9_PRODUCTION_RELEASE_MANIFEST_FORMAT,
      production_activation_entry: G9_PRODUCTION_ACTIVATION_ENTRY,
      historical_g8_release_artifact_hash:
        G9_HISTORICAL_ACCEPTED_G8.release_artifact_hash,
      database_schema_hash: G9_DATABASE_SCHEMA_HASH,
      activation_execution_authorized: false,
      next_required_gate: 'fresh_independent_full_g8_boundary_revalidation',
    },
  ) as G9ProductionActivationContractPack;
  return { schemas, protocol, pack };
}

function absolute(relative: string): string {
  const resolved = path.resolve(contractsRoot, relative);
  if (!resolved.startsWith(`${contractsRoot}${path.sep}`))
    throw new Error(`G9 Contract path escapes contracts root: ${relative}`);
  return resolved;
}

function expectedOutputs(): Array<[string, JsonValue]> {
  const built = buildArtifacts();
  return [
    ...Object.entries(schemaPaths).map(
      ([name, output]) =>
        [output, built.schemas[name as keyof typeof built.schemas]] as [
          string,
          JsonValue,
        ],
    ),
    [protocolPath, built.protocol],
    [packPath, built.pack],
  ];
}

function validateOutputs(outputs: Array<[string, JsonValue]>): void {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const [relative, value] of outputs) {
    if (relative.includes('/schemas/')) ajv.compile(value as AnySchema);
    else parseContractArtifactEnvelope(value);
  }
}

export function generateG9ProductionActivationContracts(): G9ProductionActivationContractPack {
  const outputs = expectedOutputs();
  validateOutputs(outputs);
  for (const [relative, value] of outputs) {
    const file = absolute(relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, jsonBytes(value));
    fs.renameSync(temporary, file);
  }
  return outputs.at(-1)![1] as G9ProductionActivationContractPack;
}

export function checkG9ProductionActivationContracts(): G9ProductionActivationContractPack {
  const outputs = expectedOutputs();
  validateOutputs(outputs);
  for (const [relative, expected] of outputs) {
    const file = absolute(relative);
    const actual = strictParseJsonBytes(fs.readFileSync(file));
    if (jsonBytes(actual) !== jsonBytes(expected))
      throw new Error(`G9 Production Activation Contract drifted: ${relative}`);
  }
  return outputs.at(-1)![1] as G9ProductionActivationContractPack;
}

export function readG9ProductionActivationContractPack(): G9ProductionActivationContractPack {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(absolute(packPath))),
  ) as G9ProductionActivationContractPack;
}
