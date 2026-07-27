import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { parseContractArtifactEnvelope } from '../../contracts/artifact.js';
import {
  calculateArtifactHash,
  domainSeparatedSha256,
  parseSha256Hash,
} from '../../contracts/hash.js';
import { strictParseJsonBytes } from '../../contracts/strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from '../../contracts/types.js';
import {
  G1_SCHEMA_DEPENDENCY_ROLES,
  type G1SchemaDependencyManifestPayload,
  type G1SchemaDependencyMember,
  type G1SchemaDependencyRole,
} from './types.js';
import {
  ACTIVATION_SCHEMA_INPUT_ARTIFACT_HASH,
  ACTIVATION_SCHEMA_INPUT_RELATIVE_PATH,
} from './activation-source.js';
import {
  ACTIVATION_REPAIR_SCHEMA_INPUT_ARTIFACT_HASH,
  ACTIVATION_REPAIR_SCHEMA_INPUT_RELATIVE_PATH,
} from './activation-repair-source.js';
import {
  PUBLISHER_SCHEMA_INPUT_ARTIFACT_HASH,
  PUBLISHER_SCHEMA_INPUT_RELATIVE_PATH,
} from './publisher-source.js';
import {
  buildGeneratedSchemaPrerequisiteArtifact,
  GENERATED_SCHEMA_INPUT_RELATIVE_PATH,
} from './generated-schema-source.js';
import {
  buildNodeOutputEnvelopeSchemaPrerequisiteArtifact,
  NODE_OUTPUT_ENVELOPE_SCHEMA_INPUT_RELATIVE_PATH,
} from './node-output-envelope-source.js';
import {
  buildChildCompletionLineageSchemaPrerequisiteArtifact,
  CHILD_COMPLETION_LINEAGE_SCHEMA_INPUT_RELATIVE_PATH,
} from './child-completion-lineage-source.js';
import {
  buildMapTerminalConsumptionSchemaPrerequisiteArtifact,
  MAP_TERMINAL_CONSUMPTION_SCHEMA_INPUT_RELATIVE_PATH,
} from './map-terminal-consumption-source.js';
import {
  buildDomainClaimHandoffSchemaPrerequisiteArtifact,
  DOMAIN_CLAIM_HANDOFF_SCHEMA_INPUT_RELATIVE_PATH,
} from './domain-claim-handoff-source.js';

export const G1_SCHEMA_DEPENDENCY_MANIFEST_DOMAIN_SEPARATOR =
  'icarus:workflow-runtime-schema-dependency-manifest:1\n';
export const G1_PHYSICAL_SCHEMA_IDENTITY_DOMAIN_SEPARATOR =
  'icarus:workflow-runtime-physical-schema-identity:1\n';

const defaultContractsRoot = path.resolve(
  import.meta.dirname,
  '../../contracts',
);
const defaultSchemaRoot = import.meta.dirname;

interface DependencyMemberSpec {
  role: G1SchemaDependencyRole;
  identity_effect: G1SchemaDependencyMember['identity_effect'];
  path: string;
  format: string;
  ref: { id: string; version: string };
  version: number;
  expected_semantic_hash?: Sha256Hash;
}

const INPUT_MEMBER_SPECS = [
  {
    role: 'g0_6_logical_schema_manifest',
    identity_effect: 'construction_provenance',
    path: 'contracts/contract-pack-logical-schema.json',
    format: 'icarus.workflow-contract-pack-logical-schema/1',
    ref: { id: 'icarus.workflow-contract-pack-logical-schema', version: '1' },
    version: 1,
    expected_semantic_hash:
      'sha256:e0b1bb30303e9bf0c45fdc5383ec7f61f90b2bb2e6ed8e422c5478a1dfd134cc',
  },
  {
    role: 'logical_schema_source',
    identity_effect: 'physical_schema_input',
    path: 'contracts/sqlite/workflow-runtime-logical-schema-source@1.json',
    format: 'icarus.workflow-runtime-logical-schema-source/1',
    ref: { id: 'icarus.workflow-runtime-logical-schema-source', version: '1' },
    version: 1,
    expected_semantic_hash:
      'sha256:ef5221d3465f1214c3c0aad3660f57b119d03eb4b5127428d6a1f881a6260214',
  },
  {
    role: 'typed_relation_catalog',
    identity_effect: 'physical_schema_input',
    path: 'contracts/sqlite/workflow-runtime-typed-relation-catalog@1.json',
    format: 'icarus.workflow-runtime-typed-relation-catalog/1',
    ref: {
      id: 'icarus.workflow-runtime-typed-relation-catalog',
      version: '1',
    },
    version: 1,
    expected_semantic_hash:
      'sha256:20babbfc787ac8a6006243180ef6e867bef8b454c41a527f4b8f20c8f6dd0d99',
  },
  {
    role: 'query_catalog',
    identity_effect: 'physical_schema_input',
    path: 'contracts/sqlite/workflow-runtime-query-catalog@1.json',
    format: 'icarus.workflow-runtime-query-catalog/1',
    ref: { id: 'icarus.workflow-runtime-query-catalog', version: '1' },
    version: 1,
    expected_semantic_hash:
      'sha256:6a6368f1300a5d732a6a63b73f593b9dd930880beafdd14958517bc92463ed2d',
  },
  {
    role: 'g0_10_capacity_logical_schema_delta',
    identity_effect: 'physical_schema_input',
    path: 'contracts/conformance/capacity-control-plane-addendum/sqlite/capacity-control-plane-logical-schema-delta@1.json',
    format: 'icarus.workflow-capacity-control-plane-logical-schema-delta/1',
    ref: {
      id: 'icarus.workflow-capacity-control-plane-logical-schema-delta',
      version: '1.0.0',
    },
    version: 1,
    expected_semantic_hash:
      'sha256:b15daf99f68f8447aff1da5a9411460497ae29e7067a3802ac588d790066fe30',
  },
  {
    role: 'publisher_schema_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${PUBLISHER_SCHEMA_INPUT_RELATIVE_PATH}`,
    format: 'icarus.workflow-publisher-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-publisher-schema-prerequisite',
      version: '1',
    },
    version: 1,
    expected_semantic_hash: PUBLISHER_SCHEMA_INPUT_ARTIFACT_HASH,
  },
  {
    role: 'feature_release_activation_schema_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${ACTIVATION_SCHEMA_INPUT_RELATIVE_PATH}`,
    format: 'icarus.workflow-feature-release-activation-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-feature-release-activation-schema-prerequisite',
      version: '1',
    },
    version: 1,
    expected_semantic_hash: ACTIVATION_SCHEMA_INPUT_ARTIFACT_HASH,
  },
  {
    role: 'activation_failure_replay_schema_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${ACTIVATION_REPAIR_SCHEMA_INPUT_RELATIVE_PATH}`,
    format:
      'icarus.workflow-feature-release-activation-failure-replay-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-feature-release-activation-failure-replay-schema-prerequisite',
      version: '1',
    },
    version: 1,
    expected_semantic_hash: ACTIVATION_REPAIR_SCHEMA_INPUT_ARTIFACT_HASH,
  },
  {
    role: 'generated_schema_authority_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${GENERATED_SCHEMA_INPUT_RELATIVE_PATH}`,
    format: 'icarus.workflow-generated-schema-authority-prerequisite/1',
    ref: {
      id: 'icarus.workflow-generated-schema-authority-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    expected_semantic_hash: buildGeneratedSchemaPrerequisiteArtifact().hash,
  },
  {
    role: 'node_output_envelope_schema_authority_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${NODE_OUTPUT_ENVELOPE_SCHEMA_INPUT_RELATIVE_PATH}`,
    format:
      'icarus.workflow-node-output-envelope-schema-authority-prerequisite/1',
    ref: {
      id: 'icarus.workflow-node-output-envelope-schema-authority-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    expected_semantic_hash:
      buildNodeOutputEnvelopeSchemaPrerequisiteArtifact().hash,
  },
  {
    role: 'child_completion_lineage_schema_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${CHILD_COMPLETION_LINEAGE_SCHEMA_INPUT_RELATIVE_PATH}`,
    format: 'icarus.workflow-child-completion-lineage-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-child-completion-lineage-schema-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    expected_semantic_hash:
      buildChildCompletionLineageSchemaPrerequisiteArtifact().hash,
  },
  {
    role: 'map_terminal_consumption_schema_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${MAP_TERMINAL_CONSUMPTION_SCHEMA_INPUT_RELATIVE_PATH}`,
    format: 'icarus.workflow-map-terminal-consumption-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-map-terminal-consumption-schema-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    expected_semantic_hash:
      buildMapTerminalConsumptionSchemaPrerequisiteArtifact().hash,
  },
  {
    role: 'domain_claim_handoff_schema_prerequisite',
    identity_effect: 'physical_schema_input',
    path: `store/schema/${DOMAIN_CLAIM_HANDOFF_SCHEMA_INPUT_RELATIVE_PATH}`,
    format: 'icarus.workflow-domain-claim-handoff-schema-prerequisite/1',
    ref: {
      id: 'icarus.workflow-domain-claim-handoff-schema-prerequisite',
      version: '1.0.0',
    },
    version: 1,
    expected_semantic_hash:
      buildDomainClaimHandoffSchemaPrerequisiteArtifact().hash,
  },
  {
    role: 'sqlite_execution_profile',
    identity_effect: 'physical_schema_input',
    path: 'contracts/sqlite/local_single_user_sqlite@1.json',
    format: 'icarus.sqlite-execution-profile/1',
    ref: { id: 'icarus.local-single-user-sqlite', version: '1.0.0' },
    version: 1,
    expected_semantic_hash:
      'sha256:3d69742dad2fefa8bef4ba47e375defd705e3b32920a92b105a43726436fb7af',
  },
] as const satisfies readonly DependencyMemberSpec[];

const OUTPUT_MEMBER_SPECS = [
  {
    role: 'schema_manifest',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/artifacts/workflow-runtime-schema-manifest@4.json',
    format: 'icarus.workflow-runtime-schema-manifest/1',
    ref: { id: 'icarus.workflow-runtime-schema-manifest', version: '1' },
    version: 1,
  },
  {
    role: 'canonical_migration',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v10.sql',
    format: 'icarus.workflow-runtime-sqlite-migration/1',
    ref: { id: 'icarus.workflow-runtime-schema-v10-migration', version: '1' },
    version: 1,
  },
  {
    role: 'schema3_to_schema4_upgrade',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v3-to-v4.sql',
    format: 'icarus.workflow-runtime-sqlite-schema-upgrade/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-v3-to-v4-upgrade',
      version: '1',
    },
    version: 1,
  },
  {
    role: 'schema4_to_schema5_upgrade',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v4-to-v5.sql',
    format: 'icarus.workflow-runtime-sqlite-schema-upgrade/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-v4-to-v5-upgrade',
      version: '1',
    },
    version: 1,
  },
  {
    role: 'schema5_to_schema6_upgrade',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v5-to-v6.sql',
    format: 'icarus.workflow-runtime-sqlite-schema-upgrade/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-v5-to-v6-upgrade',
      version: '1',
    },
    version: 1,
  },
  {
    role: 'schema6_to_schema7_upgrade',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v6-to-v7.sql',
    format: 'icarus.workflow-runtime-sqlite-schema-upgrade/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-v6-to-v7-upgrade',
      version: '1',
    },
    version: 1,
  },
  {
    role: 'schema7_to_schema8_upgrade',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v7-to-v8.sql',
    format: 'icarus.workflow-runtime-sqlite-schema-upgrade/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-v7-to-v8-upgrade',
      version: '1',
    },
    version: 1,
  },
  {
    role: 'schema8_to_schema9_upgrade',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v8-to-v9.sql',
    format: 'icarus.workflow-runtime-sqlite-schema-upgrade/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-v8-to-v9-upgrade',
      version: '1',
    },
    version: 1,
  },
  {
    role: 'schema9_to_schema10_upgrade',
    identity_effect: 'physical_schema_output',
    path: 'store/schema/migration/workflow-runtime-schema-v9-to-v10.sql',
    format: 'icarus.workflow-runtime-sqlite-schema-upgrade/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-v9-to-v10-upgrade',
      version: '1',
    },
    version: 1,
  },
] as const satisfies readonly DependencyMemberSpec[];

export const G1_SCHEMA_DEPENDENCY_MEMBER_SPECS = [
  ...INPUT_MEMBER_SPECS,
  ...OUTPUT_MEMBER_SPECS,
] as const;

export interface SchemaDependencyRoots {
  contractsRoot?: string;
  schemaRoot?: string;
}

export interface LoadedSchemaInputArtifact {
  artifact: ContractArtifactEnvelope;
  rawSha256: Sha256Hash;
}

export type LoadedSchemaInputArtifacts = Record<
  (typeof INPUT_MEMBER_SPECS)[number]['role'],
  LoadedSchemaInputArtifact
>;

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
  ) {
    throw new Error(`${label} is not closed`);
  }
}

function rawSha256(bytes: Uint8Array | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function renderArtifact(artifact: ContractArtifactEnvelope): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function resolveMemberPath(
  memberPath: string,
  roots: SchemaDependencyRoots,
): string {
  const contractsRoot = roots.contractsRoot ?? defaultContractsRoot;
  const schemaRoot = roots.schemaRoot ?? defaultSchemaRoot;
  if (memberPath.startsWith('contracts/')) {
    return path.join(contractsRoot, memberPath.slice('contracts/'.length));
  }
  if (memberPath.startsWith('store/schema/')) {
    return path.join(schemaRoot, memberPath.slice('store/schema/'.length));
  }
  throw new Error(`Unsupported G1 dependency path: ${memberPath}`);
}

function assertArtifactMatchesSpec(
  artifact: ContractArtifactEnvelope,
  spec: DependencyMemberSpec,
): void {
  if (
    artifact.format !== spec.format ||
    artifact.ref.id !== spec.ref.id ||
    artifact.ref.version !== spec.ref.version ||
    artifact.version !== spec.version
  ) {
    throw new Error(`${spec.role} format/ref/version drifted`);
  }
  if (
    spec.expected_semantic_hash &&
    artifact.hash !== spec.expected_semantic_hash
  ) {
    throw new Error(
      `${spec.role} published semantic identity drifted: expected ${spec.expected_semantic_hash}, received ${artifact.hash}`,
    );
  }
}

function readArtifactMember(
  spec: (typeof INPUT_MEMBER_SPECS)[number],
  roots: SchemaDependencyRoots,
): LoadedSchemaInputArtifact {
  const bytes = fs.readFileSync(resolveMemberPath(spec.path, roots));
  const artifact = parseContractArtifactEnvelope(strictParseJsonBytes(bytes));
  assertArtifactMatchesSpec(artifact, spec);
  return { artifact, rawSha256: rawSha256(bytes) };
}

export function readPinnedSchemaInputArtifacts(
  roots: SchemaDependencyRoots = {},
): LoadedSchemaInputArtifacts {
  return Object.fromEntries(
    INPUT_MEMBER_SPECS.map((spec) => [
      spec.role,
      readArtifactMember(spec, roots),
    ]),
  ) as LoadedSchemaInputArtifacts;
}

function memberFromArtifact(
  spec: DependencyMemberSpec,
  artifact: ContractArtifactEnvelope,
  bytes: Uint8Array | string,
): G1SchemaDependencyMember {
  assertArtifactMatchesSpec(artifact, spec);
  return {
    role: spec.role,
    identity_effect: spec.identity_effect,
    path: spec.path,
    format: artifact.format,
    ref: { ...artifact.ref },
    version: artifact.version,
    semantic_hash: artifact.hash,
    raw_sha256: rawSha256(bytes),
  };
}

export function calculatePhysicalSchemaIdentity(
  members: readonly G1SchemaDependencyMember[],
): Sha256Hash {
  return domainSeparatedSha256(
    G1_PHYSICAL_SCHEMA_IDENTITY_DOMAIN_SEPARATOR,
    members.filter(
      (member) => member.identity_effect !== 'construction_provenance',
    ) as unknown as JsonValue,
  );
}

export function assertClosedSchemaDependencyManifest(
  payload: G1SchemaDependencyManifestPayload,
): void {
  exactKeys(
    payload,
    [
      'dependency_set_id',
      'identity_scope',
      'member_count',
      'physical_member_count',
      'construction_provenance_count',
      'members',
      'physical_schema_identity',
    ],
    'G1 Schema Dependency Manifest',
  );
  if (
    payload.dependency_set_id !== 'workflow-runtime-schema-v1' ||
    payload.identity_scope !== 'physical_schema_and_migration' ||
    payload.member_count !== G1_SCHEMA_DEPENDENCY_ROLES.length ||
    payload.physical_member_count !== 22 ||
    payload.construction_provenance_count !== 1 ||
    !Array.isArray(payload.members) ||
    payload.members.length !== G1_SCHEMA_DEPENDENCY_ROLES.length
  ) {
    throw new Error(
      'G1 Schema Dependency Manifest required members are missing',
    );
  }

  const roles = payload.members.map((member) => member.role);
  const paths = payload.members.map((member) => member.path);
  if (new Set(roles).size !== roles.length) {
    throw new Error('G1 Schema Dependency Manifest has a duplicate role');
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error('G1 Schema Dependency Manifest has a duplicate path');
  }

  for (const [index, member] of payload.members.entries()) {
    exactKeys(
      member,
      [
        'role',
        'identity_effect',
        'path',
        'format',
        'ref',
        'version',
        'semantic_hash',
        'raw_sha256',
      ],
      `G1 Schema Dependency Manifest member ${index}`,
    );
    exactKeys(member.ref, ['id', 'version'], `G1 dependency ref ${index}`);
    const expected = G1_SCHEMA_DEPENDENCY_MEMBER_SPECS[index];
    if (
      member.role !== expected.role ||
      member.identity_effect !== expected.identity_effect ||
      member.path !== expected.path ||
      member.format !== expected.format ||
      member.ref.id !== expected.ref.id ||
      member.ref.version !== expected.ref.version ||
      member.version !== expected.version
    ) {
      throw new Error(
        `G1 Schema Dependency Manifest required member ${expected.role} drifted`,
      );
    }
    parseSha256Hash(member.semantic_hash);
    parseSha256Hash(member.raw_sha256);
  }
  parseSha256Hash(payload.physical_schema_identity);
  const expectedIdentity = calculatePhysicalSchemaIdentity(payload.members);
  if (payload.physical_schema_identity !== expectedIdentity) {
    throw new Error(
      `G1 physical schema identity hash mismatch: expected ${expectedIdentity}, received ${payload.physical_schema_identity}`,
    );
  }
}

export function buildSchemaDependencyManifestArtifact(
  schemaManifest: ContractArtifactEnvelope,
  migrationSql: string,
  roots: SchemaDependencyRoots,
  schema3To4UpgradeSql: string,
  schema4To5UpgradeSql: string,
  schema5To6UpgradeSql: string,
  schema6To7UpgradeSql: string,
  schema7To8UpgradeSql: string,
  schema8To9UpgradeSql: string,
  schema9To10UpgradeSql: string,
): ContractArtifactEnvelope {
  if (schema3To4UpgradeSql.trim().length === 0) {
    throw new Error('Schema 3 to 4 upgrade SQL must not be empty');
  }
  if (schema4To5UpgradeSql.trim().length === 0) {
    throw new Error('Schema 4 to 5 upgrade SQL must not be empty');
  }
  if (schema5To6UpgradeSql.trim().length === 0) {
    throw new Error('Schema 5 to 6 upgrade SQL must not be empty');
  }
  if (schema6To7UpgradeSql.trim().length === 0) {
    throw new Error('Schema 6 to 7 upgrade SQL must not be empty');
  }
  if (schema7To8UpgradeSql.trim().length === 0) {
    throw new Error('Schema 7 to 8 upgrade SQL must not be empty');
  }
  if (schema8To9UpgradeSql.trim().length === 0) {
    throw new Error('Schema 8 to 9 upgrade SQL must not be empty');
  }
  if (schema9To10UpgradeSql.trim().length === 0) {
    throw new Error('Schema 9 to 10 upgrade SQL must not be empty');
  }
  const inputs = Object.fromEntries(
    INPUT_MEMBER_SPECS.map((spec) => [
      spec.role,
      readArtifactMember(spec, roots),
    ]),
  ) as LoadedSchemaInputArtifacts;
  const members = INPUT_MEMBER_SPECS.map((spec) => {
    const loaded = inputs[spec.role];
    return memberFromArtifact(
      spec,
      loaded.artifact,
      fs.readFileSync(resolveMemberPath(spec.path, roots)),
    );
  });
  members.push(
    memberFromArtifact(
      OUTPUT_MEMBER_SPECS[0],
      schemaManifest,
      renderArtifact(schemaManifest),
    ),
  );
  const migrationSha256 = rawSha256(migrationSql);
  members.push({
    role: 'canonical_migration',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[1].path,
    format: OUTPUT_MEMBER_SPECS[1].format,
    ref: { ...OUTPUT_MEMBER_SPECS[1].ref },
    version: OUTPUT_MEMBER_SPECS[1].version,
    semantic_hash: migrationSha256,
    raw_sha256: migrationSha256,
  });
  const upgradeSha256 = rawSha256(schema3To4UpgradeSql);
  members.push({
    role: 'schema3_to_schema4_upgrade',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[2].path,
    format: OUTPUT_MEMBER_SPECS[2].format,
    ref: { ...OUTPUT_MEMBER_SPECS[2].ref },
    version: OUTPUT_MEMBER_SPECS[2].version,
    semantic_hash: upgradeSha256,
    raw_sha256: upgradeSha256,
  });
  const schema4To5UpgradeSha256 = rawSha256(schema4To5UpgradeSql);
  members.push({
    role: 'schema4_to_schema5_upgrade',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[3].path,
    format: OUTPUT_MEMBER_SPECS[3].format,
    ref: { ...OUTPUT_MEMBER_SPECS[3].ref },
    version: OUTPUT_MEMBER_SPECS[3].version,
    semantic_hash: schema4To5UpgradeSha256,
    raw_sha256: schema4To5UpgradeSha256,
  });
  const schema5To6UpgradeSha256 = rawSha256(schema5To6UpgradeSql);
  members.push({
    role: 'schema5_to_schema6_upgrade',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[4].path,
    format: OUTPUT_MEMBER_SPECS[4].format,
    ref: { ...OUTPUT_MEMBER_SPECS[4].ref },
    version: OUTPUT_MEMBER_SPECS[4].version,
    semantic_hash: schema5To6UpgradeSha256,
    raw_sha256: schema5To6UpgradeSha256,
  });
  const schema6To7UpgradeSha256 = rawSha256(schema6To7UpgradeSql);
  members.push({
    role: 'schema6_to_schema7_upgrade',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[5].path,
    format: OUTPUT_MEMBER_SPECS[5].format,
    ref: { ...OUTPUT_MEMBER_SPECS[5].ref },
    version: OUTPUT_MEMBER_SPECS[5].version,
    semantic_hash: schema6To7UpgradeSha256,
    raw_sha256: schema6To7UpgradeSha256,
  });
  const schema7To8UpgradeSha256 = rawSha256(schema7To8UpgradeSql);
  members.push({
    role: 'schema7_to_schema8_upgrade',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[6].path,
    format: OUTPUT_MEMBER_SPECS[6].format,
    ref: { ...OUTPUT_MEMBER_SPECS[6].ref },
    version: OUTPUT_MEMBER_SPECS[6].version,
    semantic_hash: schema7To8UpgradeSha256,
    raw_sha256: schema7To8UpgradeSha256,
  });
  const schema8To9UpgradeSha256 = rawSha256(schema8To9UpgradeSql);
  members.push({
    role: 'schema8_to_schema9_upgrade',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[7].path,
    format: OUTPUT_MEMBER_SPECS[7].format,
    ref: { ...OUTPUT_MEMBER_SPECS[7].ref },
    version: OUTPUT_MEMBER_SPECS[7].version,
    semantic_hash: schema8To9UpgradeSha256,
    raw_sha256: schema8To9UpgradeSha256,
  });
  const schema9To10UpgradeSha256 = rawSha256(schema9To10UpgradeSql);
  members.push({
    role: 'schema9_to_schema10_upgrade',
    identity_effect: 'physical_schema_output',
    path: OUTPUT_MEMBER_SPECS[8].path,
    format: OUTPUT_MEMBER_SPECS[8].format,
    ref: { ...OUTPUT_MEMBER_SPECS[8].ref },
    version: OUTPUT_MEMBER_SPECS[8].version,
    semantic_hash: schema9To10UpgradeSha256,
    raw_sha256: schema9To10UpgradeSha256,
  });

  const payload: G1SchemaDependencyManifestPayload = {
    dependency_set_id: 'workflow-runtime-schema-v1',
    identity_scope: 'physical_schema_and_migration',
    member_count: 23,
    physical_member_count: 22,
    construction_provenance_count: 1,
    members,
    physical_schema_identity: calculatePhysicalSchemaIdentity(members),
  };
  assertClosedSchemaDependencyManifest(payload);
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-runtime-schema-dependency-manifest/1',
    ref: {
      id: 'icarus.workflow-runtime-schema-dependency-manifest',
      version: '1',
    },
    version: 1,
    domain_separator: G1_SCHEMA_DEPENDENCY_MANIFEST_DOMAIN_SEPARATOR,
    hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    payload: payload as unknown as JsonObject,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

export function verifySchemaDependencyManifestArtifact(
  artifact: ContractArtifactEnvelope,
  roots: SchemaDependencyRoots = {},
): G1SchemaDependencyManifestPayload {
  if (
    artifact.format !==
      'icarus.workflow-runtime-schema-dependency-manifest/1' ||
    artifact.ref.id !== 'icarus.workflow-runtime-schema-dependency-manifest' ||
    artifact.ref.version !== '1' ||
    artifact.version !== 1 ||
    artifact.domain_separator !==
      G1_SCHEMA_DEPENDENCY_MANIFEST_DOMAIN_SEPARATOR ||
    artifact.hash !== calculateArtifactHash(artifact)
  ) {
    throw new Error('G1 Schema Dependency Manifest artifact identity mismatch');
  }
  const payload =
    artifact.payload as unknown as G1SchemaDependencyManifestPayload;
  assertClosedSchemaDependencyManifest(payload);

  for (const [index, member] of payload.members.entries()) {
    const bytes = fs.readFileSync(resolveMemberPath(member.path, roots));
    const observedRaw = rawSha256(bytes);
    if (member.raw_sha256 !== observedRaw) {
      throw new Error(
        `${member.role} raw hash mismatch: expected ${member.raw_sha256}, received ${observedRaw}`,
      );
    }
    if (
      member.role === 'canonical_migration' ||
      member.role === 'schema3_to_schema4_upgrade' ||
      member.role === 'schema4_to_schema5_upgrade' ||
      member.role === 'schema5_to_schema6_upgrade' ||
      member.role === 'schema6_to_schema7_upgrade' ||
      member.role === 'schema7_to_schema8_upgrade' ||
      member.role === 'schema8_to_schema9_upgrade'
      || member.role === 'schema9_to_schema10_upgrade'
    ) {
      if (member.semantic_hash !== observedRaw) {
        throw new Error('canonical_migration semantic hash mismatch');
      }
      continue;
    }
    const observed = parseContractArtifactEnvelope(strictParseJsonBytes(bytes));
    const spec = G1_SCHEMA_DEPENDENCY_MEMBER_SPECS[index];
    assertArtifactMatchesSpec(observed, spec);
    if (member.semantic_hash !== observed.hash) {
      throw new Error(
        `${member.role} semantic hash mismatch: expected ${member.semantic_hash}, received ${observed.hash}`,
      );
    }
  }
  return payload;
}
