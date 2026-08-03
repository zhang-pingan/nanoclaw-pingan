import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  calculateRegistryResourceContentHash,
  registryResourceId,
  registryValueId,
} from './g3-registry-persistence.js';
import {
  G3_REGISTRY_DEPENDENCY_KIND,
  type G3RegistryResourceRecord,
} from './g3-registry-persistence-types.js';
import {
  canonicalJson,
  domainSeparatedSha256,
  parseSha256Hash,
} from './hash.js';
import {
  G9_CAPACITY_GENESIS_BOOTSTRAP_BUNDLE_RELEASE_PATH,
  G9_PRODUCTION_RELEASE_REF,
  type G9ActivationAuditAuthority,
  type G9CapacityGenesisEvidence,
  type G9CapacityGenesisEvidenceIdentity,
} from './g9-production-activation-types.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export const G9_CAPACITY_GENESIS_BOOTSTRAP_ROOT =
  'production-activation/capacity-genesis-bootstrap' as const;
export const G9_CAPACITY_GENESIS_BOOTSTRAP_BUNDLE_PATH =
  `${G9_CAPACITY_GENESIS_BOOTSTRAP_ROOT}/capacity-genesis-bootstrap-bundle@1.json` as const;
export const G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA_PATH =
  `${G9_CAPACITY_GENESIS_BOOTSTRAP_ROOT}/capacity-genesis-bootstrap-meta-schema@1.json` as const;
export const G9_CAPACITY_GENESIS_RESULT_SCHEMA_PATH =
  `${G9_CAPACITY_GENESIS_BOOTSTRAP_ROOT}/capacity-admin-result-schema@1.json` as const;
export const G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA_PATH =
  `${G9_CAPACITY_GENESIS_BOOTSTRAP_ROOT}/capacity-genesis-evidence-schema@1.json` as const;

export const G9_CAPACITY_GENESIS_BOOTSTRAP_BUNDLE_DOMAIN =
  'icarus:capacity-genesis-bootstrap-bundle:1\n' as const;
export const G9_ACTIVATION_AUDIT_AUTHORITY_DOMAIN =
  'icarus:production-activation-audit-authority:1\n' as const;
export const G9_CAPACITY_GENESIS_EVIDENCE_DOMAIN =
  'icarus:capacity-genesis-evidence:1\n' as const;
export const G9_CAPACITY_GENESIS_EVIDENCE_VALUE_PREFIX =
  'capacity-genesis-evidence-value:' as const;

export const G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA_REF = {
  id: 'icarus.capacity-genesis-bootstrap-meta-schema',
  version: '1.0.0',
} as const;
export const G9_CAPACITY_GENESIS_RESULT_SCHEMA_REF = {
  id: 'icarus.capacity-admin-result',
  version: '1.0.0',
} as const;
export const G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA_REF = {
  id: 'icarus.capacity-genesis-evidence',
  version: '1.0.0',
} as const;

const memberRoles = [
  'bootstrap_meta_schema',
  'capacity_result_schema',
  'genesis_evidence_schema',
] as const;
export type G9CapacityGenesisBootstrapMemberRole = (typeof memberRoles)[number];

export interface G9CapacityGenesisBootstrapMember extends JsonObject {
  readonly role: G9CapacityGenesisBootstrapMemberRole;
  readonly artifact_relative_path: string;
  readonly artifact_raw_sha256: Sha256Hash;
  readonly canonical_content_json: string;
  readonly canonical_value_id: string;
  readonly resource_row_id: string;
  readonly resource: G3RegistryResourceRecord;
}

export interface G9CapacityGenesisEvidenceContract {
  readonly format: 'icarus.capacity-genesis-evidence-contract/1';
  readonly schema_resource_id: string;
  readonly schema_ref: VersionedRef;
  readonly schema_hash: Sha256Hash;
  readonly content_hash_domain: typeof G9_CAPACITY_GENESIS_EVIDENCE_DOMAIN;
  readonly value_id_prefix: typeof G9_CAPACITY_GENESIS_EVIDENCE_VALUE_PREFIX;
  readonly exact_inputs: readonly [
    'core_release_artifact_hash',
    'baseline_config_hash',
    'activation_audit_authority_hash',
    'capacity_revision',
    'purpose',
  ];
  readonly capacity_revision: 1;
  readonly purpose: 'initial_provisioning';
}

export interface G9CapacityGenesisBootstrapBundle {
  readonly format: 'icarus.capacity-genesis-bootstrap-bundle/1';
  readonly ref: VersionedRef;
  readonly owner_core_ref: VersionedRef;
  readonly member_order: readonly G9CapacityGenesisBootstrapMemberRole[];
  readonly install_order: readonly [
    'bootstrap_meta_schema_value',
    'bootstrap_meta_schema_resource',
    'capacity_result_schema_value',
    'capacity_result_schema_resource',
    'genesis_evidence_schema_value',
    'genesis_evidence_schema_resource',
    'exact_dependency_rows',
  ];
  readonly members: readonly G9CapacityGenesisBootstrapMember[];
  readonly evidence_contract: G9CapacityGenesisEvidenceContract;
  readonly bundle_hash: Sha256Hash;
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function jsonBytes(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    actual.length !== required.length ||
    actual.some((key, index) => key !== required[index])
  )
    throw new Error(`${label}_field_set_invalid`);
}

const hashSchema = {
  type: 'string',
  pattern: '^sha256:[0-9a-f]{64}$',
} as const;

export const G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:capacity-genesis-bootstrap-meta-schema:1',
  title: 'Icarus Capacity Genesis Bootstrap Schema Resource',
  type: 'object',
  additionalProperties: false,
  required: [
    '$schema',
    '$id',
    'title',
    'type',
    'additionalProperties',
    'required',
    'properties',
  ],
  properties: {
    $schema: { const: 'https://json-schema.org/draft/2020-12/schema' },
    $id: { type: 'string', minLength: 1, maxLength: 255 },
    title: { type: 'string', minLength: 1, maxLength: 255 },
    type: { const: 'object' },
    additionalProperties: { const: false },
    required: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 255 },
    },
    properties: { type: 'object' },
  },
};

export const G9_CAPACITY_GENESIS_RESULT_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:capacity-admin-result:1',
  title: 'Icarus Revision 1 Applied Capacity Admin Result',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'command_id',
    'disposition',
    'capacity_revision',
    'capacity_change_id',
    'config_hash',
    'publication_hash',
  ],
  properties: {
    format: { const: 'icarus.capacity-admin-result/1' },
    command_id: { type: 'string', minLength: 1, maxLength: 255 },
    disposition: { const: 'applied' },
    capacity_revision: { const: 1 },
    capacity_change_id: { type: 'string', minLength: 1, maxLength: 255 },
    config_hash: hashSchema,
    publication_hash: hashSchema,
  },
};

export const G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA: JsonObject = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:icarus:capacity-genesis-evidence:1',
  title: 'Icarus Capacity Genesis Evidence',
  type: 'object',
  additionalProperties: false,
  required: [
    'format',
    'core_release_artifact_hash',
    'baseline_config_hash',
    'activation_audit_authority_hash',
    'capacity_revision',
    'purpose',
  ],
  properties: {
    format: { const: 'icarus.capacity-genesis-evidence/1' },
    core_release_artifact_hash: hashSchema,
    baseline_config_hash: hashSchema,
    activation_audit_authority_hash: hashSchema,
    capacity_revision: { const: 1 },
    purpose: { const: 'initial_provisioning' },
  },
};

function resource(
  ref: VersionedRef,
  content: JsonObject,
  schemaRef: VersionedRef,
  schemaHash: Sha256Hash,
  dependencies: G3RegistryResourceRecord['dependencies'],
): G3RegistryResourceRecord {
  const base = {
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref: { ...ref },
    owner: { kind: 'core', ref: { ...G9_PRODUCTION_RELEASE_REF } },
    schema_ref: { ...schemaRef },
    schema_hash: schemaHash,
    content: structuredClone(content),
    dependencies: structuredClone(dependencies),
  } as const;
  return {
    ...base,
    content_hash: calculateRegistryResourceContentHash(base),
  };
}

function buildMembers(): readonly G9CapacityGenesisBootstrapMember[] {
  const metaHash = calculateRegistryResourceContentHash({
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref: G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA_REF,
    content: G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA,
  });
  const meta = resource(
    G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA_REF,
    G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA,
    G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA_REF,
    metaHash,
    [],
  );
  const dependency = {
    resource_type: 'schema',
    ref: { ...meta.ref },
    content_hash: meta.content_hash,
    dependency_kind: G3_REGISTRY_DEPENDENCY_KIND,
  } as const;
  const result = resource(
    G9_CAPACITY_GENESIS_RESULT_SCHEMA_REF,
    G9_CAPACITY_GENESIS_RESULT_SCHEMA,
    meta.ref,
    meta.content_hash,
    [dependency],
  );
  const evidence = resource(
    G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA_REF,
    G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA,
    meta.ref,
    meta.content_hash,
    [dependency],
  );
  return [
    member(
      'bootstrap_meta_schema',
      G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA_PATH,
      meta,
    ),
    member(
      'capacity_result_schema',
      G9_CAPACITY_GENESIS_RESULT_SCHEMA_PATH,
      result,
    ),
    member(
      'genesis_evidence_schema',
      G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA_PATH,
      evidence,
    ),
  ];
}

function member(
  role: G9CapacityGenesisBootstrapMemberRole,
  artifactRelativePath: string,
  resourceRecord: G3RegistryResourceRecord,
): G9CapacityGenesisBootstrapMember {
  return {
    role,
    artifact_relative_path: `dist/workflow-runtime/contracts/${artifactRelativePath}`,
    artifact_raw_sha256: rawSha256(
      Buffer.from(jsonBytes(resourceRecord.content), 'utf8'),
    ),
    canonical_content_json: canonicalJson(resourceRecord.content),
    canonical_value_id: registryValueId(resourceRecord),
    resource_row_id: registryResourceId(resourceRecord),
    resource: resourceRecord,
  };
}

export function buildG9CapacityGenesisBootstrapArtifacts(): {
  readonly schemas: Readonly<Record<string, JsonObject>>;
  readonly bundle: G9CapacityGenesisBootstrapBundle;
} {
  const withoutHash = buildG9CapacityGenesisBootstrapBundleContent();
  const bundle: G9CapacityGenesisBootstrapBundle = {
    ...withoutHash,
    bundle_hash: domainSeparatedSha256(
      G9_CAPACITY_GENESIS_BOOTSTRAP_BUNDLE_DOMAIN,
      withoutHash as unknown as JsonValue,
    ),
  };
  assertG9CapacityGenesisBootstrapBundle(bundle);
  return {
    schemas: {
      [G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA_PATH]:
        G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA,
      [G9_CAPACITY_GENESIS_RESULT_SCHEMA_PATH]:
        G9_CAPACITY_GENESIS_RESULT_SCHEMA,
      [G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA_PATH]:
        G9_CAPACITY_GENESIS_EVIDENCE_SCHEMA,
    },
    bundle,
  };
}

function buildG9CapacityGenesisBootstrapBundleContent() {
  const members = buildMembers();
  const evidenceMember = members[2];
  return {
    format: 'icarus.capacity-genesis-bootstrap-bundle/1',
    ref: { id: 'icarus.capacity-genesis-bootstrap-bundle', version: '1.0.0' },
    owner_core_ref: { ...G9_PRODUCTION_RELEASE_REF },
    member_order: [...memberRoles],
    install_order: [
      'bootstrap_meta_schema_value',
      'bootstrap_meta_schema_resource',
      'capacity_result_schema_value',
      'capacity_result_schema_resource',
      'genesis_evidence_schema_value',
      'genesis_evidence_schema_resource',
      'exact_dependency_rows',
    ],
    members,
    evidence_contract: {
      format: 'icarus.capacity-genesis-evidence-contract/1',
      schema_resource_id: evidenceMember.resource_row_id,
      schema_ref: { ...evidenceMember.resource.ref },
      schema_hash: evidenceMember.resource.content_hash,
      content_hash_domain: G9_CAPACITY_GENESIS_EVIDENCE_DOMAIN,
      value_id_prefix: G9_CAPACITY_GENESIS_EVIDENCE_VALUE_PREFIX,
      exact_inputs: [
        'core_release_artifact_hash',
        'baseline_config_hash',
        'activation_audit_authority_hash',
        'capacity_revision',
        'purpose',
      ],
      capacity_revision: 1,
      purpose: 'initial_provisioning',
    },
  } as const;
}

export function assertG9CapacityGenesisBootstrapBundle(
  value: unknown,
): asserts value is G9CapacityGenesisBootstrapBundle {
  assertJsonObject(value);
  exactKeys(
    value,
    [
      'format',
      'ref',
      'owner_core_ref',
      'member_order',
      'install_order',
      'members',
      'evidence_contract',
      'bundle_hash',
    ],
    'capacity_genesis_bootstrap_bundle',
  );
  const expectedWithoutHash = buildG9CapacityGenesisBootstrapBundleContent();
  const bundle = value as unknown as G9CapacityGenesisBootstrapBundle;
  const withoutHash = Object.fromEntries(
    Object.entries(bundle).filter(([key]) => key !== 'bundle_hash'),
  );
  if (
    canonicalJson(withoutHash as JsonValue) !==
      canonicalJson(expectedWithoutHash as unknown as JsonValue) ||
    parseSha256Hash(bundle.bundle_hash) !==
      domainSeparatedSha256(
        G9_CAPACITY_GENESIS_BOOTSTRAP_BUNDLE_DOMAIN,
        withoutHash as JsonValue,
      )
  )
    throw new Error('capacity_genesis_bootstrap_bundle_identity_invalid');

  const validator = new Ajv2020({ strict: true, allErrors: true });
  const validateMeta = validator.compile(
    G9_CAPACITY_GENESIS_BOOTSTRAP_META_SCHEMA as AnySchema,
  );
  for (const member of bundle.members) {
    if (member.role !== 'bootstrap_meta_schema')
      validator.compile(member.resource.content as AnySchema);
    if (!validateMeta(member.resource.content))
      throw new Error('capacity_genesis_bootstrap_member_schema_invalid');
  }
}

export function readInstalledG9CapacityGenesisBootstrapBundle(
  releaseRoot: string,
  expectedBundleHash: Sha256Hash,
): G9CapacityGenesisBootstrapBundle {
  const root = fs.realpathSync(releaseRoot);
  const bundlePath = path.join(
    root,
    G9_CAPACITY_GENESIS_BOOTSTRAP_BUNDLE_RELEASE_PATH,
  );
  const bundle = strictParseJsonBytes(fs.readFileSync(bundlePath));
  assertG9CapacityGenesisBootstrapBundle(bundle);
  if (bundle.bundle_hash !== parseSha256Hash(expectedBundleHash))
    throw new Error('capacity_genesis_bootstrap_manifest_binding_invalid');
  for (const member of bundle.members) {
    const memberPath = path.resolve(root, member.artifact_relative_path);
    if (!memberPath.startsWith(`${root}${path.sep}`))
      throw new Error('capacity_genesis_bootstrap_member_path_invalid');
    const bytes = fs.readFileSync(memberPath);
    if (
      rawSha256(bytes) !== member.artifact_raw_sha256 ||
      bytes.toString('utf8') !== jsonBytes(member.resource.content)
    )
      throw new Error('capacity_genesis_bootstrap_member_bytes_invalid');
  }
  return structuredClone(bundle);
}

export function buildG9ActivationAuditAuthority(input: {
  readonly activation_id: string;
  readonly requested_at_ms: number;
  readonly target_release_artifact_hash: Sha256Hash;
  readonly previous_deployment_binding_hash: Sha256Hash | null;
  readonly capacity_mode: G9ActivationAuditAuthority['capacity_mode'];
}): G9ActivationAuditAuthority {
  const withoutHash = {
    format: 'icarus.production-activation-audit-authority/1',
    activation_id: input.activation_id,
    actor_ref: 'system:production-activation',
    requested_at_ms: input.requested_at_ms,
    target_release_artifact_hash: parseSha256Hash(
      input.target_release_artifact_hash,
    ),
    previous_deployment_binding_hash:
      input.previous_deployment_binding_hash === null
        ? null
        : parseSha256Hash(input.previous_deployment_binding_hash),
    capacity_mode: input.capacity_mode,
  } as const;
  return {
    ...withoutHash,
    authority_hash: domainSeparatedSha256(
      G9_ACTIVATION_AUDIT_AUTHORITY_DOMAIN,
      withoutHash,
    ),
  };
}

export function buildG9CapacityGenesisEvidence(input: {
  readonly core_release_artifact_hash: Sha256Hash;
  readonly baseline_config_hash: Sha256Hash;
  readonly activation_audit_authority_hash: Sha256Hash;
}): G9CapacityGenesisEvidenceIdentity {
  const document: G9CapacityGenesisEvidence = {
    format: 'icarus.capacity-genesis-evidence/1',
    core_release_artifact_hash: parseSha256Hash(
      input.core_release_artifact_hash,
    ),
    baseline_config_hash: parseSha256Hash(input.baseline_config_hash),
    activation_audit_authority_hash: parseSha256Hash(
      input.activation_audit_authority_hash,
    ),
    capacity_revision: 1,
    purpose: 'initial_provisioning',
  };
  const valueHash = domainSeparatedSha256(
    G9_CAPACITY_GENESIS_EVIDENCE_DOMAIN,
    document as unknown as JsonValue,
  );
  return {
    value_id: `${G9_CAPACITY_GENESIS_EVIDENCE_VALUE_PREFIX}${valueHash.slice('sha256:'.length)}`,
    value_hash: valueHash,
    document,
  };
}

export function capacityGenesisBootstrapGeneratedOutputs(): ReadonlyArray<
  readonly [string, JsonValue]
> {
  const artifacts = buildG9CapacityGenesisBootstrapArtifacts();
  return [
    ...Object.entries(artifacts.schemas),
    [
      G9_CAPACITY_GENESIS_BOOTSTRAP_BUNDLE_PATH,
      artifacts.bundle as unknown as JsonValue,
    ],
  ];
}
