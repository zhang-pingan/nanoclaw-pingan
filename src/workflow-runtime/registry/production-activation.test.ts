import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { JsonValue, Sha256Hash } from '../contracts/types.js';
import {
  buildG9ActivationAuditAuthority,
  buildG9CapacityGenesisBootstrapArtifacts,
  buildG9CapacityGenesisEvidence,
  capacityGenesisBootstrapGeneratedOutputs,
} from '../contracts/g9-capacity-genesis-bootstrap.js';
import { calculateCapacityAdminRequestHash } from '../contracts/capacity-control-plane-source.js';
import type {
  DeploymentRuntimeCapacitySnapshot,
  InitializeDeploymentCapacityCommand,
} from '../contracts/capacity-control-plane-types.js';
import { canonicalJson } from '../contracts/hash.js';
import { resolveDeterministicRoute } from '../creation/routing-resolver.js';
import { WorkflowProjectionStore } from '../projection/workflow-projection.js';
import type {
  WorkflowRuntimeSqlValue,
  WorkflowRuntimeStore,
  WorkflowRuntimeWriteTransaction,
} from '../store/runtime-store/index.js';
import { loadFrozenWorkflowRuntimeStoreInputs } from '../store/runtime-store/profile.js';
import {
  buildG9DeploymentJournalEvent,
  buildG9ProductionActivationRequest,
  calculateG9FeaturePointerAggregateHash,
  calculateG9ProjectionGenerationAggregateHash,
  assertG9DeploymentActivationJournalSequence,
  parseG9DeploymentActivationBinding,
  parseG9DeploymentJournalEvent,
  parseG9ProductionActivationRequest,
  resolveG9ProductionActivationRuntimeLayout,
} from './production-activation.js';
import {
  buildG9RuntimeCenterProjectionGenerationDocument,
  createG9ProductionActivationParticipants,
  expectedFreshCapacityGenesisIdentity,
} from './production-activation-runtime.js';
import { calculateExistingCapacityDependencyObjectsHash } from './capacity-genesis-bootstrap-runtime.js';

function hash(character: string): Sha256Hash {
  return `sha256:${character.repeat(64)}`;
}

function emptyProjectionBinding() {
  const generations = ['workflows', 'agent_executions', 'pending', 'trace'].map(
    (view) => ({
      view,
      generation_id: `generation:${view}:0:${hash('a')}`,
      source_head_seq: 0,
      rows_hash: hash('a'),
    }),
  ) as Parameters<typeof calculateG9ProjectionGenerationAggregateHash>[0];
  return {
    projection_version: 'g7.1' as const,
    generations,
    generation_aggregate_hash:
      calculateG9ProjectionGenerationAggregateHash(generations),
  };
}

function writeBootstrapReleaseAssets(releaseRoot: string): void {
  for (const [relative, value] of capacityGenesisBootstrapGeneratedOutputs()) {
    const output = path.join(
      releaseRoot,
      'dist/workflow-runtime/contracts',
      relative,
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  }
}

function openIsolatedSchema11Store(databasePath: string): {
  readonly store: WorkflowRuntimeStore;
  close(): void;
} {
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.exec(loadFrozenWorkflowRuntimeStoreInputs().migrationSql);
  const queryAll = <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T[] => database.prepare(sql).all(...parameters) as T[];
  const queryOne = <T extends Record<string, unknown>>(
    sql: string,
    parameters: readonly WorkflowRuntimeSqlValue[],
  ): T | undefined => database.prepare(sql).get(...parameters) as T | undefined;
  const store = {
    queryAll,
    queryOne,
    withImmediateTransaction: <T>(
      callback: (transaction: WorkflowRuntimeWriteTransaction) => T,
    ): T => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const transaction = {
          transactionKind: 'immediate' as const,
          execute: (
            sql: string,
            parameters: readonly WorkflowRuntimeSqlValue[],
          ) => {
            const result = database.prepare(sql).run(...parameters);
            return {
              changes: result.changes,
              lastInsertRowid: result.lastInsertRowid,
            };
          },
          queryAll,
          queryOne,
        };
        const result = callback(transaction);
        database.exec('COMMIT');
        return result;
      } catch (error) {
        if (database.inTransaction) database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as WorkflowRuntimeStore;
  return { store, close: () => database.close() };
}

describe('G9 pre-activation production authority', () => {
  it('resolves the managed content-addressed release root from the installed entry', () => {
    const runtimeHome = fs.mkdtempSync(
      '/private/tmp/icarus-g9-installed-layout-',
    );
    try {
      const releaseHash = 'a'.repeat(64);
      const releaseRoot = path.join(runtimeHome, 'core-releases', releaseHash);
      const entryDirectory = path.join(
        releaseRoot,
        'dist/workflow-runtime/registry',
      );
      const executable = path.join(
        runtimeHome,
        'toolchains/node/26.5.0/bin/node',
      );
      fs.mkdirSync(entryDirectory, { recursive: true });
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, 'managed node fixture\n');
      fs.writeFileSync(
        path.join(releaseRoot, 'core-production-release-manifest.json'),
        '{}\n',
      );

      expect(
        resolveG9ProductionActivationRuntimeLayout(executable, entryDirectory),
      ).toEqual({
        runtimeHome: fs.realpathSync(runtimeHome),
        releaseRoot: fs.realpathSync(releaseRoot),
      });
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('cleans only compiler-owned output before building release inventory', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../../..');
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { scripts: { build: string } };
    expect(packageJson.scripts.build).toBe(
      'node scripts/clean-typescript-output.mjs && tsc',
    );
    const cleaner = fs.readFileSync(
      path.join(projectRoot, 'scripts/clean-typescript-output.mjs'),
      'utf8',
    );
    expect(cleaner).toContain("path.join(projectRoot, 'dist')");
    expect(cleaner).toContain('outputStat.isSymbolicLink()');
    expect(cleaner).toContain('fs.rmSync(outputRoot, { recursive: true })');
  });

  it('returns the generic zero-inventory Intake result', () => {
    const result = resolveDeterministicRoute('intake-empty', hash('0'), []);
    expect(result.disposition).toBe('no_route_available');
    expect(result.selected).toBeNull();
    expect(result.decision).toMatchObject({
      disposition: 'no_route_available',
      selected_recipe_resource_id: null,
    });

    const runtimeCenter = new WorkflowProjectionStore();
    for (const view of ['workflows', 'pending'] as const) {
      expect(runtimeCenter.rows(view)).toEqual([]);
      expect(runtimeCenter.status(view)).toMatchObject({
        state: 'ready',
        source_head_seq: 0,
        projected_head_seq: 0,
      });
    }
    expect(runtimeCenter.rows('trace')).toEqual([]);
    expect(runtimeCenter.status('trace')).toMatchObject({
      state: 'ready',
      projection_version: 'g7.1',
    });
  });

  it('accepts the checked-in Capacity baseline serialization', () => {
    const projectRoot = path.resolve(import.meta.dirname, '../../..');
    const runtimeHome = fs.mkdtempSync(
      '/private/tmp/icarus-g9-capacity-baseline-',
    );
    const releaseRoot = path.join(runtimeHome, 'release');
    const baselineFile = path.join(
      releaseRoot,
      'config/workflow-runtime-capacity.json',
    );
    const emptyStore = {
      queryOne: () => undefined,
    } as unknown as WorkflowRuntimeStore;
    try {
      fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
      fs.copyFileSync(
        path.join(projectRoot, 'config/workflow-runtime-capacity.json'),
        baselineFile,
      );
      const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')) as {
        config_hash: Sha256Hash;
      };
      writeBootstrapReleaseAssets(releaseRoot);
      const bootstrap = buildG9CapacityGenesisBootstrapArtifacts().bundle;
      const auditAuthority = buildG9ActivationAuditAuthority({
        activation_id: 'activation-capacity-baseline',
        requested_at_ms: 1000,
        target_release_artifact_hash: hash('2'),
        previous_deployment_binding_hash: null,
        capacity_mode: 'fresh_genesis',
      });
      const evidence = buildG9CapacityGenesisEvidence({
        core_release_artifact_hash: hash('2'),
        baseline_config_hash: baseline.config_hash,
        activation_audit_authority_hash: auditAuthority.authority_hash,
      });
      const generations = [
        'workflows',
        'agent_executions',
        'pending',
        'trace',
      ].map((view) => ({
        view,
        generation_id: `generation:${view}:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      })) as Parameters<typeof calculateG9ProjectionGenerationAggregateHash>[0];
      const request = buildG9ProductionActivationRequest({
        activation_id: 'activation-capacity-baseline',
        operation_key: 'deployment-capacity-baseline',
        requested_at_ms: 1000,
        previous_deployment_binding_hash: null,
        deployment_binding: {
          deployment_profile: 'local_single_user',
          runtime_surface: 'node_service',
          release_manifest_hash: hash('1'),
          release_artifact_hash: hash('2'),
          core_build_hash: hash('3'),
          core_binding_hash: hash('4'),
          capacity_genesis_bootstrap_bundle_hash: bootstrap.bundle_hash,
          applicable_g8_evidence: {
            status: 'fresh_independent_boundary_pass',
            release_artifact_hash: hash('2'),
            startup_report_hash: hash('5'),
            readiness_report_hash: hash('6'),
            startup_harness_hash: hash('7'),
            readiness_harness_hash: hash('8'),
            sqlite_profile_candidate_hash: hash('9'),
            node_executable_hash: hash('a'),
            native_module_hash: hash('b'),
          },
          static_authority: {
            source_core_build_hash: hash('c'),
            absence_baseline_hash: hash('d'),
            product_surface_manifest_hash: hash('e'),
            migration_candidate_boundary_hash: hash('f'),
          },
          feature_registry_pointer: {
            state: 'empty',
            active_release_count: 0,
            pointers: [],
            pointer_aggregate_hash: calculateG9FeaturePointerAggregateHash([]),
          },
          runtime_center_projection: {
            projection_version: 'g7.1',
            generations,
            generation_aggregate_hash:
              calculateG9ProjectionGenerationAggregateHash(generations),
          },
          capacity_authority: {
            mode: 'fresh_genesis',
            expected_head_state: 'absent',
            baseline_config_hash: baseline.config_hash,
            expected_capacity_revision: 1,
            expected_change_id: 'capacity-change-1',
            expected_publication_hash: hash('1'),
            expected_audit_head_hash: hash('2'),
            genesis_core_release_hash: hash('2'),
            genesis_command_id: 'capacity-command-1',
            genesis_idempotency_key: 'capacity-genesis-1',
            genesis_auth_session_ref: 'auth:capacity-genesis-1',
            genesis_activation_audit_authority_hash:
              auditAuthority.authority_hash,
            genesis_evidence_value_id: evidence.value_id,
            genesis_evidence_value_hash: evidence.value_hash,
          },
        },
      });
      const capacity = createG9ProductionActivationParticipants({
        runtimeHome,
        releaseRoot,
        store: emptyStore,
        request,
      }).find((participant) => participant.name === 'capacity')!;

      expect(fs.readFileSync(baselineFile, 'utf8')).toContain('\n  "');
      expect(() => capacity.prepare(request.deployment_binding)).not.toThrow();
    } finally {
      fs.rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it('installs the release-owned bootstrap before fresh CAP0-CAP4 and preserves existing authority', () => {
    const root = fs.mkdtempSync('/private/tmp/icarus-g9-bootstrap-positive-');
    const runtimeHome = path.join(root, 'runtime-home');
    const releaseRoot = path.join(runtimeHome, 'synthetic-release');
    const databasePath = path.join(root, 'workflow-runtime.db');
    const baselineFile = path.join(
      releaseRoot,
      'config/workflow-runtime-capacity.json',
    );
    let isolated:
      | { readonly store: WorkflowRuntimeStore; close(): void }
      | undefined;
    try {
      fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
      fs.copyFileSync(
        path.resolve(
          import.meta.dirname,
          '../../../config/workflow-runtime-capacity.json',
        ),
        baselineFile,
      );
      writeBootstrapReleaseAssets(releaseRoot);
      fs.mkdirSync(runtimeHome, { recursive: true });
      isolated = openIsolatedSchema11Store(databasePath);
      const store = isolated.store;

      const requestedAtMs = 2000;
      const releaseHash = hash('2');
      const baseline = JSON.parse(
        fs.readFileSync(baselineFile, 'utf8'),
      ) as DeploymentRuntimeCapacitySnapshot;
      const bootstrap = buildG9CapacityGenesisBootstrapArtifacts().bundle;
      const auditAuthority = buildG9ActivationAuditAuthority({
        activation_id: 'activation-bootstrap-fresh',
        requested_at_ms: requestedAtMs,
        target_release_artifact_hash: releaseHash,
        previous_deployment_binding_hash: null,
        capacity_mode: 'fresh_genesis',
      });
      const evidence = buildG9CapacityGenesisEvidence({
        core_release_artifact_hash: releaseHash,
        baseline_config_hash: baseline.config_hash,
        activation_audit_authority_hash: auditAuthority.authority_hash,
      });
      const command: InitializeDeploymentCapacityCommand = {
        command_type: 'initialize_deployment_capacity',
        command_id: 'capacity-command-bootstrap-fresh',
        idempotency_key: 'capacity-bootstrap-fresh',
        proposed_capacity: baseline,
        reason_code: 'initial_provisioning',
        core_release_hash: releaseHash,
        evidence_refs: [
          `core-release:${releaseHash}`,
          `capacity-baseline:${baseline.config_hash}`,
          `capacity-genesis-evidence:${evidence.value_hash}`,
        ],
      };
      const expected = expectedFreshCapacityGenesisIdentity({
        commandId: command.command_id,
        requestHash: calculateCapacityAdminRequestHash(command),
        baseline,
        requestedAtMs,
      });
      const projection = emptyProjectionBinding();
      const common = {
        deployment_profile: 'local_single_user' as const,
        runtime_surface: 'node_service' as const,
        release_manifest_hash: hash('1'),
        release_artifact_hash: releaseHash,
        core_build_hash: hash('3'),
        core_binding_hash: hash('4'),
        capacity_genesis_bootstrap_bundle_hash: bootstrap.bundle_hash,
        applicable_g8_evidence: {
          status: 'fresh_independent_boundary_pass' as const,
          release_artifact_hash: releaseHash,
          startup_report_hash: hash('5'),
          readiness_report_hash: hash('6'),
          startup_harness_hash: hash('7'),
          readiness_harness_hash: hash('8'),
          sqlite_profile_candidate_hash: hash('9'),
          node_executable_hash: hash('a'),
          native_module_hash: hash('b'),
        },
        static_authority: {
          source_core_build_hash: hash('c'),
          absence_baseline_hash: hash('d'),
          product_surface_manifest_hash: hash('e'),
          migration_candidate_boundary_hash: hash('f'),
        },
        feature_registry_pointer: {
          state: 'empty' as const,
          active_release_count: 0,
          pointers: [],
          pointer_aggregate_hash: calculateG9FeaturePointerAggregateHash([]),
        },
        runtime_center_projection: projection,
      };
      const fresh = buildG9ProductionActivationRequest({
        activation_id: 'activation-bootstrap-fresh',
        operation_key: 'deployment-bootstrap-fresh',
        requested_at_ms: requestedAtMs,
        previous_deployment_binding_hash: null,
        deployment_binding: {
          ...common,
          capacity_authority: {
            mode: 'fresh_genesis',
            expected_head_state: 'absent',
            baseline_config_hash: baseline.config_hash,
            expected_capacity_revision: 1,
            expected_change_id: expected.changeId,
            expected_publication_hash: expected.publicationHash,
            expected_audit_head_hash: expected.auditHeadHash,
            genesis_core_release_hash: releaseHash,
            genesis_command_id: command.command_id,
            genesis_idempotency_key: command.idempotency_key,
            genesis_auth_session_ref: 'auth:capacity-bootstrap-fresh',
            genesis_activation_audit_authority_hash:
              auditAuthority.authority_hash,
            genesis_evidence_value_id: evidence.value_id,
            genesis_evidence_value_hash: evidence.value_hash,
          },
        },
      });
      const capacityFile = path.join(
        runtimeHome,
        'data',
        'workflow-runtime',
        'workflow-runtime-capacity.json',
      );
      const freshParticipant = createG9ProductionActivationParticipants({
        runtimeHome,
        releaseRoot,
        store,
        request: fresh,
      }).find((participant) => participant.name === 'capacity')!;
      freshParticipant.prepare(fresh.deployment_binding);
      freshParticipant.rollForward(fresh.deployment_binding);

      expect(
        store.queryOne<{ revision: number }>(
          'SELECT current_capacity_revision AS revision FROM runtime_capacity_head WHERE singleton_key = 1',
          [],
        ),
      ).toEqual({ revision: 1 });
      expect(
        store.queryOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM workflow_registry_resources WHERE publication_state = 'published' AND owner_core_ref = 'icarus.core@1.2.14-g9.1'",
          [],
        ),
      ).toEqual({ count: 3 });
      expect(
        store.queryOne<{ content_hash: Sha256Hash }>(
          'SELECT content_hash FROM workflow_values WHERE id = ?',
          [evidence.value_id],
        ),
      ).toEqual({ content_hash: evidence.value_hash });
      expect(fs.readFileSync(capacityFile, 'utf8')).toBe(
        `${canonicalJson(expected.publication as unknown as JsonValue)}\n`,
      );

      const dependencyHash = calculateExistingCapacityDependencyObjectsHash(
        store,
        expected.changeId,
      );
      const existing = buildG9ProductionActivationRequest({
        activation_id: 'activation-bootstrap-existing',
        operation_key: 'deployment-bootstrap-existing',
        requested_at_ms: 3000,
        previous_deployment_binding_hash: fresh.deployment_binding.binding_hash,
        deployment_binding: {
          ...common,
          capacity_authority: {
            mode: 'existing_preserved',
            capacity_revision: 1,
            change_id: expected.changeId,
            config_hash: baseline.config_hash,
            publication_hash: expected.publicationHash,
            publication_file_raw_hash: hash('0'),
            audit_head_hash: expected.auditHeadHash,
            dependency_objects_hash: dependencyHash,
          },
        },
      });
      const existingCapacity = existing.deployment_binding.capacity_authority;
      if (existingCapacity.mode !== 'existing_preserved')
        throw new Error('existing Capacity binding expected');
      const rawHash = `sha256:${crypto
        .createHash('sha256')
        .update(fs.readFileSync(capacityFile))
        .digest('hex')}` as Sha256Hash;
      const exactExisting = buildG9ProductionActivationRequest({
        ...{
          activation_id: 'activation-bootstrap-existing',
          operation_key: 'deployment-bootstrap-existing',
          requested_at_ms: 3000,
          previous_deployment_binding_hash:
            fresh.deployment_binding.binding_hash,
        },
        deployment_binding: {
          ...common,
          capacity_authority: {
            ...existingCapacity,
            publication_file_raw_hash: rawHash,
          },
        },
      });
      const before = canonicalJson({
        head: store.queryAll('SELECT * FROM runtime_capacity_head', []),
        commands: store.queryAll(
          'SELECT * FROM runtime_capacity_admin_commands',
          [],
        ),
        events: store.queryAll(
          'SELECT * FROM runtime_capacity_change_events ORDER BY event_seq',
          [],
        ),
        resources: store.queryAll(
          'SELECT * FROM workflow_registry_resources ORDER BY id',
          [],
        ),
        values: store.queryAll('SELECT * FROM workflow_values ORDER BY id', []),
        dependencies: store.queryAll(
          'SELECT * FROM workflow_registry_resource_dependencies ORDER BY resource_id, dependency_resource_id',
          [],
        ),
      } as unknown as JsonValue);
      const beforeFile = fs.readFileSync(capacityFile);
      const existingParticipant = createG9ProductionActivationParticipants({
        runtimeHome,
        releaseRoot,
        store,
        request: exactExisting,
      }).find((participant) => participant.name === 'capacity')!;
      existingParticipant.prepare(exactExisting.deployment_binding);
      existingParticipant.rollForward(exactExisting.deployment_binding);
      expect(fs.readFileSync(capacityFile)).toEqual(beforeFile);
      expect(
        canonicalJson({
          head: store.queryAll('SELECT * FROM runtime_capacity_head', []),
          commands: store.queryAll(
            'SELECT * FROM runtime_capacity_admin_commands',
            [],
          ),
          events: store.queryAll(
            'SELECT * FROM runtime_capacity_change_events ORDER BY event_seq',
            [],
          ),
          resources: store.queryAll(
            'SELECT * FROM workflow_registry_resources ORDER BY id',
            [],
          ),
          values: store.queryAll(
            'SELECT * FROM workflow_values ORDER BY id',
            [],
          ),
          dependencies: store.queryAll(
            'SELECT * FROM workflow_registry_resource_dependencies ORDER BY resource_id, dependency_resource_id',
            [],
          ),
        } as unknown as JsonValue),
      ).toBe(before);
    } finally {
      isolated?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds one deterministic closed request, audit, and deployment binding', () => {
    const generations = [
      {
        view: 'workflows' as const,
        generation_id: `generation:workflows:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
      {
        view: 'agent_executions' as const,
        generation_id: `generation:agent_executions:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
      {
        view: 'pending' as const,
        generation_id: `generation:pending:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
      {
        view: 'trace' as const,
        generation_id: `generation:trace:0:${hash('a')}`,
        source_head_seq: 0,
        rows_hash: hash('a'),
      },
    ];
    const request = buildG9ProductionActivationRequest({
      activation_id: 'activation-g9-1',
      operation_key: 'deployment-g9-1',
      requested_at_ms: 1000,
      previous_deployment_binding_hash: null,
      deployment_binding: {
        deployment_profile: 'local_single_user',
        runtime_surface: 'node_service',
        release_manifest_hash: hash('1'),
        release_artifact_hash: hash('2'),
        core_build_hash: hash('3'),
        core_binding_hash: hash('4'),
        capacity_genesis_bootstrap_bundle_hash:
          buildG9CapacityGenesisBootstrapArtifacts().bundle.bundle_hash,
        applicable_g8_evidence: {
          status: 'fresh_independent_boundary_pass',
          release_artifact_hash: hash('2'),
          startup_report_hash: hash('5'),
          readiness_report_hash: hash('6'),
          startup_harness_hash: hash('7'),
          readiness_harness_hash: hash('8'),
          sqlite_profile_candidate_hash: hash('9'),
          node_executable_hash: hash('a'),
          native_module_hash: hash('b'),
        },
        static_authority: {
          source_core_build_hash: hash('c'),
          absence_baseline_hash: hash('d'),
          product_surface_manifest_hash: hash('e'),
          migration_candidate_boundary_hash: hash('f'),
        },
        feature_registry_pointer: {
          state: 'empty',
          active_release_count: 0,
          pointers: [],
          pointer_aggregate_hash: calculateG9FeaturePointerAggregateHash([]),
        },
        runtime_center_projection: {
          projection_version: 'g7.1',
          generations,
          generation_aggregate_hash:
            calculateG9ProjectionGenerationAggregateHash(generations),
        },
        capacity_authority: {
          mode: 'existing_preserved',
          capacity_revision: 4,
          change_id: 'capacity-change-4',
          config_hash: hash('1'),
          publication_hash: hash('2'),
          publication_file_raw_hash: hash('3'),
          audit_head_hash: hash('4'),
          dependency_objects_hash: hash('5'),
        },
      },
    });
    expect(parseG9ProductionActivationRequest(request)).toEqual(request);
    expect(
      parseG9DeploymentActivationBinding(request.deployment_binding),
    ).toEqual(request.deployment_binding);
    expect(request.audit.audit_hash).toBe(
      request.deployment_binding.activation_audit_hash,
    );
    expect(
      buildG9RuntimeCenterProjectionGenerationDocument(
        request.deployment_binding.runtime_center_projection,
      ),
    ).toEqual({
      format: 'icarus.runtime-center-projection-generation/1',
      projection_version: 'g7.1',
      generations,
      generation_aggregate_hash:
        request.deployment_binding.runtime_center_projection
          .generation_aggregate_hash,
    });
    expect(
      buildG9RuntimeCenterProjectionGenerationDocument(
        request.deployment_binding.runtime_center_projection,
      ),
    ).not.toHaveProperty('deployment_binding_hash');
  });

  it('builds a complete positive journal that is strictly replayable', () => {
    const first = buildG9DeploymentJournalEvent({
      activation_id: 'activation-g9-1',
      sequence: 1,
      phase: 'prepared',
      participant: null,
      previous_event_hash: null,
      previous_binding_hash: null,
      target_binding_hash: hash('1'),
      operation_key: 'deployment-g9-1',
      occurred_at_ms: 1000,
    });
    const second = buildG9DeploymentJournalEvent({
      activation_id: 'activation-g9-1',
      sequence: 2,
      phase: 'participant_prepared',
      participant: 'core_binding',
      previous_event_hash: first.event_hash,
      previous_binding_hash: null,
      target_binding_hash: hash('1'),
      operation_key: 'deployment-g9-1',
      occurred_at_ms: 1001,
    });
    expect(parseG9DeploymentJournalEvent(first)).toEqual(first);
    expect(parseG9DeploymentJournalEvent(second).previous_event_hash).toBe(
      first.event_hash,
    );
    const events = [first, second];
    for (const [phase, participant] of [
      ['participant_prepared', 'feature_registry'],
      ['participant_prepared', 'runtime_center_projection'],
      ['participant_prepared', 'capacity'],
      ['active_deployment_committed', 'deployment_pointer'],
      ['participant_rolled_forward', 'core_binding'],
      ['participant_rolled_forward', 'feature_registry'],
      ['participant_rolled_forward', 'runtime_center_projection'],
      ['participant_rolled_forward', 'capacity'],
      ['completed', null],
    ] as const) {
      events.push(
        buildG9DeploymentJournalEvent({
          activation_id: 'activation-g9-1',
          sequence: events.length + 1,
          phase,
          participant,
          previous_event_hash: events.at(-1)!.event_hash,
          previous_binding_hash: null,
          target_binding_hash: hash('1'),
          operation_key: 'deployment-g9-1',
          occurred_at_ms: 1000 + events.length,
        }),
      );
    }
    expect(() =>
      assertG9DeploymentActivationJournalSequence(events),
    ).not.toThrow();
  });
});
