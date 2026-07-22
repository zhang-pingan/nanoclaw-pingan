import fs from 'fs';
import path from 'path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import {
  CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT,
  CAPACITY_CONTROL_PLANE_ARTIFACT_COUNT,
  CAPACITY_CONTROL_PLANE_MANIFEST_PATH,
  buildCapacityControlPlaneExpectedArtifactsForTest,
  checkHistoricalG0_9Conformance,
} from './capacity-control-plane-pack.js';
import {
  CAPACITY_CONTROL_PLANE_FAULT_CASES,
  CAPACITY_CONTROL_PLANE_NEGATIVE_CASES,
  CAPACITY_CONTROL_PLANE_POSITIVE_CASES,
  evaluateCapacityControlPlaneCase,
} from './capacity-control-plane-fixtures.js';
import {
  CAPACITY_ADMIN_DENIAL_CODES,
  CAPACITY_ADMIN_HUMAN_ENTRYPOINTS,
  CAPACITY_CHANGE_REASON_CODES,
  CAPACITY_PROTOCOL_IDS,
  type CapacityArtifactInventory,
  type CapacityGateReview,
  type CapacityLogicalSchemaDelta,
  type CapacityMarkdownDeltaCoverage,
  type CapacityProtocolCatalog,
  type DeploymentRuntimeCapacitySnapshot,
  type ReplaceDeploymentCapacityCommand,
} from './capacity-control-plane-types.js';
import {
  CAPACITY_DENIAL_CATALOG_ENTRIES,
  CAPACITY_PERMISSION_CATALOG_ENTRIES,
  CAPACITY_REASON_CATALOG_ENTRIES,
  CAPACITY_SCHEMA_HISTORICAL_HASH,
  CAPACITY_BASELINE_HISTORICAL_HASH,
  G0_10_HISTORICAL_IDENTITIES,
  G0_9_HISTORICAL_ROOT_HASH,
  buildCapacityMarkdownDeltaCoverage,
  buildDeploymentCapacityPublication,
  calculateCapacityAdminRequestHash,
  validateCapacityPublication,
} from './capacity-control-plane-source.js';
import { checkContractPackG0Conformance } from './g0-conformance-pack.js';
import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import { LOGICAL_SCHEMA_TABLES } from './logical-schema-source.js';
import { buildDeploymentRuntimeCapacityBaseline } from './safety-sqlite-artifacts.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');
const addendumRoot = path.join(
  contractsRoot,
  CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT,
);

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

function readPayload<T>(relativePath: string): T {
  return readArtifact(relativePath).payload as unknown as T;
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, entry);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else
        result.push(
          path.relative(contractsRoot, absolute).split(path.sep).join('/'),
        );
    }
  };
  visit(root);
  return result.sort();
}

function compileSchema(relativePath: string) {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  });
  return ajv.compile(readArtifact(relativePath).payload as AnySchema);
}

function withoutDocumentMetadata(schema: JsonObject): JsonObject {
  const {
    $schema: _dialect,
    $id: _id,
    title: _title,
    ...objectSchema
  } = schema;
  return objectSchema;
}

describe('G0.10 Capacity Control-Plane Addendum', () => {
  it('checks the repaired current root read-only and owns exactly 26 isolated JSON artifacts', () => {
    const first = buildCapacityControlPlaneExpectedArtifactsForTest();
    const firstFiles = listFiles(addendumRoot);
    const firstBytes = new Map(
      firstFiles.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );
    const second = buildCapacityControlPlaneExpectedArtifactsForTest();
    expect(second).toEqual(first);
    expect(firstFiles).toHaveLength(CAPACITY_CONTROL_PLANE_ARTIFACT_COUNT);
    expect(firstFiles).toContain(CAPACITY_CONTROL_PLANE_MANIFEST_PATH);
    expect(
      firstFiles.every((relativePath) =>
        relativePath.startsWith(`${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/`),
      ),
    ).toBe(true);
    for (const [relativePath, bytes] of firstBytes)
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
  });

  it('treats G0.9 as immutable history while the current G0.4 reopen fails its aggregate checker closed', () => {
    expect(checkHistoricalG0_9Conformance().hash).toBe(
      G0_9_HISTORICAL_ROOT_HASH,
    );
    expect(() => checkContractPackG0Conformance()).toThrow(
      /Prior manifest identity drift: contract-pack-catalog-protocols\.json/,
    );
    expect(
      readArtifact('safety/deployment-runtime-capacity-schema.json').hash,
    ).toBe(CAPACITY_SCHEMA_HISTORICAL_HASH);
    const baseline = strictParseJsonBytes(
      fs.readFileSync(
        path.join(repoRoot, 'config/workflow-runtime-capacity.json'),
      ),
    ) as Record<string, unknown>;
    expect(baseline.config_hash).toBe(CAPACITY_BASELINE_HISTORICAL_HASH);
  });

  it('keeps publication and both command branches on the exact historical Capacity object schema', () => {
    const historical = readArtifact(
      'safety/deployment-runtime-capacity-schema.json',
    ).payload;
    const expectedCapacitySchema = withoutDocumentMetadata(historical);
    const publicationSchema = readArtifact(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/schemas/deployment-runtime-capacity-publication-schema.json`,
    ).payload;
    const publicationProperties = publicationSchema.properties as JsonObject;
    expect(publicationProperties.capacity).toEqual(expectedCapacitySchema);

    const commandSchema = readArtifact(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/schemas/capacity-admin-command-schema.json`,
    ).payload;
    const branches = commandSchema.oneOf as JsonObject[];
    expect(branches).toHaveLength(2);
    for (const branch of branches)
      expect((branch.properties as JsonObject).proposed_capacity).toEqual(
        expectedCapacitySchema,
      );
  });

  it('strictly validates publication lineage/hash and the closed command union', () => {
    const capacity =
      buildDeploymentRuntimeCapacityBaseline() as DeploymentRuntimeCapacitySnapshot;
    const publication = buildDeploymentCapacityPublication(
      1,
      'capacity-change:genesis',
      null,
      capacity,
    );
    expect(validateCapacityPublication(publication)).toBeNull();
    expect(
      validateCapacityPublication({
        ...publication,
        previous_config_hash: capacity.config_hash,
      }),
    ).toBe('capacity_publication_previous_hash_lineage_invalid');
    expect(
      validateCapacityPublication({
        ...publication,
        publication_hash: `sha256:${'a'.repeat(64)}`,
      }),
    ).toBe('capacity_publication_hash_invalid');

    const validateCommand = compileSchema(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/schemas/capacity-admin-command-schema.json`,
    );
    const replace: ReplaceDeploymentCapacityCommand = {
      command_type: 'replace_deployment_capacity',
      command_id: 'capacity-command:replace',
      idempotency_key: 'capacity-key:replace',
      expected_capacity_revision: 1,
      expected_config_hash: capacity.config_hash,
      proposed_capacity: capacity,
      reason_code: 'planned_tuning',
      reason_text: 'Audited replacement.',
      evidence_refs: [],
    };
    expect(validateCommand(replace)).toBe(true);
    expect(
      validateCommand({ ...replace, actor_ref: 'human:local-owner' }),
    ).toBe(false);
    expect(validateCommand({ ...replace, reason_text: '' })).toBe(false);
    expect(
      validateCommand({ ...replace, patch: { max_active_executions: 8 } }),
    ).toBe(false);
    expect(calculateCapacityAdminRequestHash(replace)).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('closes authorization against Feature, Automation, Workflow, and business API proxying', () => {
    expect(CAPACITY_PERMISSION_CATALOG_ENTRIES).toEqual([
      expect.objectContaining({
        permission: 'runtime.capacity.manage',
        production_principal: 'human:local-owner',
        allowed_entrypoints: CAPACITY_ADMIN_HUMAN_ENTRYPOINTS,
        delegation: 'forbidden',
        workflow_ownership_derivation: 'forbidden',
        feature_manifest_ceiling_derivation: 'forbidden',
      }),
    ]);
    const forbiddenScenarios = [
      'wrong_actor_kind',
      'delegated_via_feature_service',
      'delegated_via_automation',
      'delegated_via_workflow',
      'untrusted_business_api_entrypoint',
    ];
    for (const scenario of forbiddenScenarios) {
      const fixture = CAPACITY_CONTROL_PLANE_NEGATIVE_CASES.find(
        (candidate) => candidate.scenario === scenario,
      );
      expect(fixture, scenario).toBeDefined();
      expect(evaluateCapacityControlPlaneCase(fixture!)).toBe(
        fixture!.expected_result,
      );
    }
  });

  it('keeps permission, reason, and denial entries unique, complete, mapped, and hash-closed', () => {
    const catalogs = [
      {
        path: `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/catalogs/capacity-permission-catalog.json`,
        codes: ['runtime.capacity.manage'],
        codeKey: 'permission_codes',
        entryKey: 'permission',
        expected: CAPACITY_PERMISSION_CATALOG_ENTRIES,
        domain: 'icarus:workflow-capacity-permission-catalog-payload:1\n',
      },
      {
        path: `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/catalogs/capacity-reason-catalog.json`,
        codes: CAPACITY_CHANGE_REASON_CODES,
        codeKey: 'reason_codes',
        entryKey: 'reason_code',
        expected: CAPACITY_REASON_CATALOG_ENTRIES,
        domain: 'icarus:workflow-capacity-reason-catalog-payload:1\n',
      },
      {
        path: `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/catalogs/capacity-denial-catalog.json`,
        codes: CAPACITY_ADMIN_DENIAL_CODES,
        codeKey: 'denial_codes',
        entryKey: 'denial_code',
        expected: CAPACITY_DENIAL_CATALOG_ENTRIES,
        domain: 'icarus:workflow-capacity-denial-catalog-payload:1\n',
      },
    ];
    for (const catalog of catalogs) {
      const payload = readArtifact(catalog.path).payload;
      const entries = payload.entries as JsonObject[];
      expect(payload[catalog.codeKey]).toEqual(catalog.codes);
      expect(entries).toEqual(catalog.expected);
      expect(entries.map((entry) => entry[catalog.entryKey])).toEqual(
        catalog.codes,
      );
      expect(
        new Set(entries.map((entry) => entry[catalog.entryKey])).size,
      ).toBe(catalog.codes.length);
      const { catalog_hash: catalogHash, ...withoutHash } = payload;
      expect(catalogHash).toBe(
        domainSeparatedSha256(catalog.domain, withoutHash),
      );
    }
    expect(CAPACITY_REASON_CATALOG_ENTRIES[0]!.allowed_command_types).toEqual([
      'initialize_deployment_capacity',
    ]);
    for (const entry of CAPACITY_REASON_CATALOG_ENTRIES.slice(1)) {
      expect(entry.allowed_command_types).toEqual([
        'replace_deployment_capacity',
      ]);
      expect(entry.reason_text_required).toBe(true);
    }
  });

  it('declares CAP0-CAP4 exactly without inventing a CAP0 crash boundary', () => {
    const protocol = readPayload<CapacityProtocolCatalog>(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/protocols/capacity-control-plane-protocol@1.json`,
    );
    expect(protocol.protocol_ids).toEqual(CAPACITY_PROTOCOL_IDS);
    expect(protocol.steps.map((step) => step.protocol_id)).toEqual(
      CAPACITY_PROTOCOL_IDS,
    );
    expect(protocol.crash_boundaries).toHaveLength(10);
    expect(
      protocol.crash_boundaries.some(
        (boundary) => boundary.protocol_id === 'CAP0',
      ),
    ).toBe(false);
    for (const protocolId of ['CAP1', 'CAP2', 'CAP3', 'CAP4'])
      expect(
        protocol.crash_boundaries.some(
          (boundary) => boundary.protocol_id === protocolId,
        ),
      ).toBe(true);
    expect(
      new Set(protocol.crash_boundaries.map((boundary) => boundary.boundary_id))
        .size,
    ).toBe(protocol.crash_boundaries.length);
  });

  it('adds four logical tables and the exact three-field Admission lineage without executable DDL', () => {
    const delta = readPayload<CapacityLogicalSchemaDelta>(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/sqlite/capacity-control-plane-logical-schema-delta@1.json`,
    );
    expect(delta.added_tables.map((table) => table.name)).toEqual([
      'runtime_capacity_head',
      'runtime_capacity_admin_commands',
      'runtime_capacity_admin_invocations',
      'runtime_capacity_change_events',
    ]);
    expect(delta).toMatchObject({
      delta_mode: 'additive_only',
      executable_status: 'non_executable',
      ddl_generation_status: 'forbidden_in_g0_10',
      sqlite_open_status: 'forbidden_in_g0_10',
    });
    const events = delta.added_tables.find(
      (table) => table.name === 'runtime_capacity_change_events',
    )!;
    const milestoneUnique = events.unique_keys.find(
      (key) => key.key_id === 'uk:capacity_events:single_commit_milestone',
    )!;
    expect(milestoneUnique.columns).toEqual(['change_id', 'event_type']);
    expect(milestoneUnique.predicate_intent).toContain('watcher_published');
    expect(milestoneUnique.predicate_intent).not.toContain('recovered');
    expect(milestoneUnique.predicate_intent).not.toContain('failed');
    expect(milestoneUnique.predicate_intent).not.toContain(
      'unauthorized_file_rejected',
    );

    const scheduler = delta.extended_tables[0]!;
    expect(scheduler.added_columns.map((column) => column.name)).toEqual([
      'capacity_revision',
      'capacity_change_id',
    ]);
    expect(
      LOGICAL_SCHEMA_TABLES.find(
        (table) => table.name === 'workflow_graph_scheduler_admissions',
      )!.columns.some((column) => column.name === 'capacity_config_hash'),
    ).toBe(true);
    expect(scheduler.added_foreign_keys[0]!.source_columns).toEqual([
      'capacity_revision',
      'capacity_change_id',
      'capacity_config_hash',
    ]);
  });

  it('closes delta coverage, inventory, Gate review, and every fixture oracle', () => {
    const coverage = readPayload<CapacityMarkdownDeltaCoverage>(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/markdown-delta-coverage@1.json`,
    );
    expect(coverage).toMatchObject({
      spec_binding_scope: 'capacity_contract_values_only',
      prior_g0_9_root_hash: G0_9_HISTORICAL_ROOT_HASH,
      contract_value_count: 33,
      markdown_value_count: 33,
      contract_values_without_markdown: [],
      markdown_values_without_contract: [],
    });
    expect(coverage.category_counts).toEqual({
      semantic_format: 1,
      command_type: 2,
      permission: 1,
      reason_code: 6,
      denial_code: 11,
      protocol_id: 5,
      logical_table: 4,
      admission_lineage_field: 3,
    });

    const architecture = fs.readFileSync(
      path.join(repoRoot, 'local/docs/dynamic-workflow-dag-framework.md'),
      'utf8',
    );
    expect(
      buildCapacityMarkdownDeltaCoverage(
        `${architecture}\n\nUnrelated Compiler-only prose.\n`,
      ).coverage_hash,
    ).toBe(coverage.coverage_hash);
    expect(
      buildCapacityMarkdownDeltaCoverage(
        architecture.replaceAll(
          'runtime.capacity.manage',
          'removed.capacity.permission.for-test',
        ),
      ).contract_values_without_markdown,
    ).toContain('permission:runtime.capacity.manage');

    const inventory = readPayload<CapacityArtifactInventory>(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/artifact-inventory@1.json`,
    );
    expect(inventory.entry_count).toBe(23);
    expect(
      inventory.entries.find((entry) => entry.owning_slice === 'G0.9'),
    ).toMatchObject({
      owning_slice: 'G0.9',
      artifact_class: 'historical_root',
      semantic_hash: G0_9_HISTORICAL_ROOT_HASH,
    });
    expect(inventory.duplicate_paths).toEqual([]);
    expect(inventory.missing_paths).toEqual([]);

    const review = readPayload<CapacityGateReview>(
      `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/gate-review@1.json`,
    );
    expect(review.historical_identity_hashes).toEqual(
      G0_10_HISTORICAL_IDENTITIES,
    );
    expect(review.exit_criteria).toHaveLength(10);
    expect(
      review.exit_criteria.every((criterion) => criterion.status === 'pass'),
    ).toBe(true);

    const cases = [
      ...CAPACITY_CONTROL_PLANE_POSITIVE_CASES,
      ...CAPACITY_CONTROL_PLANE_NEGATIVE_CASES,
      ...CAPACITY_CONTROL_PLANE_FAULT_CASES,
    ];
    expect(CAPACITY_CONTROL_PLANE_POSITIVE_CASES).toHaveLength(9);
    expect(CAPACITY_CONTROL_PLANE_NEGATIVE_CASES).toHaveLength(31);
    expect(CAPACITY_CONTROL_PLANE_FAULT_CASES).toHaveLength(14);
    expect(cases).toHaveLength(54);
    for (const candidate of cases)
      expect(
        evaluateCapacityControlPlaneCase(candidate),
        candidate.case_id,
      ).toBe(candidate.expected_result);
  });

  it('keeps the generated closure free of DDL, Store, Runtime, and UI output', () => {
    expect(buildCapacityControlPlaneExpectedArtifactsForTest()).toHaveLength(
      25,
    );
    expect(
      fs.readdirSync(path.join(contractsRoot, 'conformance/sealed')),
    ).toEqual([
      '.gitkeep',
      'g2-production-compiler-replay-repair-v2',
      'g2-semantic-correction',
    ]);
    const forbidden = [
      ['store', 'runtime-store.ts'],
      ['store', 'schema', 'workflow-runtime-schema-v1.sql'],
      ['runtime', 'capacity-admin.ts'],
      ['runtime', 'capacity-publication.ts'],
      ['runtime', 'scheduler.ts'],
      ['projection', 'runtime-center-api.ts'],
      ['projection', 'runtime-center-renderer'],
    ];
    expect(
      forbidden.every(
        (relativePath) =>
          !fs.existsSync(path.join(contractsRoot, '..', ...relativePath)),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          repoRoot,
          'data',
          'workflow-runtime',
          'workflow-runtime-capacity.json',
        ),
      ),
    ).toBe(false);

    const manifest = readArtifact(CAPACITY_CONTROL_PLANE_MANIFEST_PATH);
    expect(manifest.payload.historical_identity_hashes).toEqual(
      G0_10_HISTORICAL_IDENTITIES,
    );
    expect(manifest.payload.artifacts).toHaveLength(25);
    expect(
      (manifest.payload.artifacts as JsonValue[]).every((artifact) => {
        const descriptor = artifact as JsonObject;
        return String(descriptor.path).startsWith(
          `${CAPACITY_CONTROL_PLANE_ADDENDUM_ROOT}/`,
        );
      }),
    ).toBe(true);
    expect(canonicalJson(manifest.payload.historical_identity_hashes)).toBe(
      canonicalJson({ ...G0_10_HISTORICAL_IDENTITIES }),
    );
  });
});
