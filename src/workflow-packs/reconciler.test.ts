import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { workflowPackContainerResources } from '../container-runner.js';
import { domainSeparatedSha256 } from '../workflow-runtime/contracts/hash.js';
import type { JsonObject } from '../workflow-runtime/contracts/types.js';
import { RuntimeWorkspaceGateway } from '../workflow-runtime/gateway/workspace.js';
import {
  createG6MapFixture,
  ensureTaskWorkspaceCore,
  TASK_WORKSPACE_TEMPORARY_REFS,
  WorkflowRuntimeConnectionFactory,
  type WorkflowPackManifestDocument,
  type WorkflowRuntimeStore,
} from '../workflow-runtime/gateway/workflow-packs-test.js';
import {
  resolveWorkflowPackExecutionResourcePin,
  verifyWorkflowPackExecutionResourcePin,
} from './execution-resources.js';
import { calculateWorkflowPackManifestHash } from './manifest.js';
import { WorkflowPackManager } from './management.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function graphPolicy(): JsonObject {
  return {
    allowed_node_types: ['delegation', 'terminal'],
    allowed_capabilities: [TASK_WORKSPACE_TEMPORARY_REFS.capability],
    allowed_templates: [],
    allowed_interface_refs: [{ id: 'example.interface', version: '1.0.0' }],
    allowed_wait_contracts: [],
    allowed_child_policy_refs: [],
    allowed_claim_ids: [],
    allow_early_close: false,
    allow_indefinite_waits: false,
    effect_policy: {
      allowed_recovery_kinds: ['pure'],
      max_impact: 'read_only',
    },
    build_retry: null,
    limits: {
      max_scopes: null,
      max_nodes: null,
      max_nodes_per_scope: null,
      max_edges_per_scope: null,
      max_nesting_depth: null,
      max_map_items: null,
      max_concurrency: null,
      max_total_attempts: null,
      max_total_waits: null,
      max_total_output_bytes: null,
      max_scope_spec_bytes: null,
      max_condition_steps: null,
      max_wait_duration_ms: null,
      max_pending_signals: null,
      max_fixed_point_facts: null,
      max_frontier_bytes: null,
    },
    usage_budget: {
      max_total_tool_calls: null,
      max_total_input_tokens: null,
      max_total_output_tokens: null,
      max_total_cost_micros: null,
    },
  };
}

function packSourceDocuments(
  sourceOverride: Record<string, unknown> = {},
): Array<{
  kind: WorkflowPackManifestDocument['workflow_resources'][number]['kind'];
  ref: { id: string; version: string };
  relativePath: string;
  content: JsonObject;
}> {
  const version = '1.0.0';
  const interfaceRef = { id: 'example.interface', version };
  const interfaceSnapshot: JsonObject = {
    ref: interfaceRef,
    inputs: {},
    exits: { done: { output_ports: {} } },
  };
  const scopeInterface: JsonObject = {
    format: 'icarus.workflow-scope-interface/1',
    ...interfaceSnapshot,
    interface_hash: domainSeparatedSha256(
      'icarus:workflow-scope-interface:1\n',
      interfaceSnapshot,
    ),
  };
  const definitionWithoutHash: JsonObject = {
    format: 'icarus.workflow-definition/1',
    ref: { id: 'example.definition', version },
    owner_pack_id: 'example-pack',
    name: 'Example Definition',
    context_contract_ref: { id: 'example.context', version },
    entry_points: { default: { state_key: 'run' } },
    states: {
      run: {
        type: 'delegation',
        capability_ref: TASK_WORKSPACE_TEMPORARY_REFS.capability,
        input_bindings: {},
        policy: graphPolicy(),
        retry_request: null,
        timeout_ms: null,
        on_complete: {
          success: { target: 'completed' },
          failure: { target: 'failed' },
        },
        on_error: { target: 'failed' },
        on_local_cancel: { target: 'failed' },
      },
      completed: {
        type: 'terminal',
        terminal_kind: 'normal',
        output_binding: { source: 'constant', value: { status: 'done' } },
      },
      failed: {
        type: 'terminal',
        terminal_kind: 'errored',
        error_code: 'example_failed',
        error_binding: null,
      },
    },
  };
  const definition: JsonObject = {
    ...definitionWithoutHash,
    definition_hash: domainSeparatedSha256(
      'icarus:workflow-definition:1\n',
      definitionWithoutHash,
    ),
  };
  const recipe: JsonObject = {
    format: 'icarus.workflow-recipe/1',
    ref: { id: 'example.recipe', version },
    owner_pack_id: 'example-pack',
    catalog_visibility: 'selectable',
    name: 'Example Recipe',
    description: 'A Pack-owned Workflow',
    workflow_definition_ref: { id: 'example.definition', version },
    entry_point: 'default',
    initial_state_key: 'run',
    workflow_execution_policy_ref: { id: 'example.execution', version },
    workflow_command_policy_ref: { id: 'example.commands', version },
    input_schema_ref: { id: 'example.input', version },
    output_schema_ref: { id: 'example.input', version },
    context_contract_ref: { id: 'example.context', version },
    routing_scope_ref: { id: 'example.routing', version },
    launch_policy: 'confirm',
    effect_ceiling: 'read_only',
    input_summary: {},
    ...sourceOverride,
  };
  const graphTemplate: JsonObject = {
    format: 'icarus.workflow-graph-scope/1',
    scope_key: 'example_graph',
    interface_ref: interfaceRef,
    nodes: [
      {
        id: 'done',
        type: 'terminal',
        trigger: { type: 'root' },
        exit: 'done',
      },
    ],
    control_edges: [],
    data_edges: [],
    completion: {
      settled_rules: [
        {
          id: 'select_done',
          when: { fact: 'all_nodes_terminal' },
          select: {
            exits: ['done'],
            pick: { type: 'lowest_terminal_node_id' },
          },
          phase: 'settled',
          priority: 100,
        },
      ],
      no_match: 'error',
      early_close: 'cancel_and_fence_remaining',
    },
    requested_limits: graphPolicy().limits,
  };
  const cardRef = { id: 'example.card', version };
  const sharedCardDependencyRef = { id: 'example.input', version };
  const cardPresentation: JsonObject = {
    format: 'icarus.card-presentation/1',
    ref: cardRef,
    owner_pack_id: 'example-pack',
    template_ref: sharedCardDependencyRef,
    template_hash: `sha256:${'1'.repeat(64)}`,
    variable_schema_ref: sharedCardDependencyRef,
    variable_schema_hash: `sha256:${'2'.repeat(64)}`,
    supported_channel_adapters: [
      {
        adapter_ref: sharedCardDependencyRef,
        adapter_hash: `sha256:${'3'.repeat(64)}`,
        render_profile_ref: sharedCardDependencyRef,
      },
    ],
    render_limits: {
      max_payload_bytes: 65536,
      max_text_bytes: 8192,
      max_actions: 4,
    },
    fallback_text_template_ref: sharedCardDependencyRef,
    actions: [
      {
        action_id: 'pause',
        label: 'Pause',
        binding: {
          action_kind: 'runtime_command',
          command_type: 'pause_run',
          target_binding: 'run',
        },
        required_permission: 'workflow.operate',
        idempotency_domain: 'card_interaction',
        expires_after_ms: 300000,
      },
    ],
    snapshot_retention_policy_ref: sharedCardDependencyRef,
    deterministic_render_fixture_ref: 'fixture:example-card',
    deterministic_render_fixture_hash: `sha256:${'4'.repeat(64)}`,
    contract_hash: `sha256:${'5'.repeat(64)}`,
  };
  return [
    {
      kind: 'recipe',
      ref: recipe.ref as { id: string; version: string },
      relativePath: 'workflow-src/recipe.json',
      content: recipe,
    },
    {
      kind: 'definition',
      ref: definition.ref as { id: string; version: string },
      relativePath: 'workflow-src/definition.json',
      content: definition,
    },
    {
      kind: 'execution_policy',
      ref: { id: 'example.execution', version },
      relativePath: 'workflow-src/execution-policy.json',
      content: { effect_ceiling: 'read_only' },
    },
    {
      kind: 'command_policy',
      ref: { id: 'example.commands', version },
      relativePath: 'workflow-src/command-policy.json',
      content: {
        command_policy_allow_pause: true,
        command_policy_allow_resume: true,
        command_policy_allows_local_graph_cancel: true,
        command_policy_allows_workflow_cancel: true,
        command_policy_allow_manual_skip: false,
        command_policy_allow_retry_wait_advance: false,
        receipt_remediation_contract_allows_reconcile: false,
        receipt_remediation_contract_allows_verified_receipt: false,
        receipt_remediation_contract_allows_not_applied_proof: false,
        command_policy_administrative_abandon_allowed: false,
        administrative_abandon_release_claims: false,
      },
    },
    {
      kind: 'schema',
      ref: { id: 'example.input', version },
      relativePath: 'workflow-src/input-schema.json',
      content: { type: 'object', additionalProperties: true },
    },
    {
      kind: 'context_contract',
      ref: { id: 'example.context', version },
      relativePath: 'workflow-src/context-contract.json',
      content: { slots: {} },
    },
    {
      kind: 'routing_scope',
      ref: { id: 'example.routing', version },
      relativePath: 'workflow-src/routing-scope.json',
      content: { mode: 'explicit' },
    },
    {
      kind: 'scope_interface',
      ref: interfaceRef,
      relativePath: 'workflow-src/scope-interface.json',
      content: scopeInterface,
    },
    {
      kind: 'graph_template',
      ref: { id: 'example.graph-template', version },
      relativePath: 'workflow-src/graph-template.json',
      content: graphTemplate,
    },
    {
      kind: 'graph_policy',
      ref: { id: 'example.graph-policy', version },
      relativePath: 'workflow-src/graph-policy.json',
      content: {
        ref: { id: 'example.graph-policy', version },
        request: graphPolicy(),
      },
    },
    {
      kind: 'card_presentation',
      ref: cardRef,
      relativePath: 'workflow-src/card-presentation.json',
      content: cardPresentation,
    },
  ];
}

function fixture(
  input: {
    sourceOverride?: Record<string, unknown>;
    expectedSourceHash?: `sha256:${string}`;
    fullExecutionResources?: boolean;
  } = {},
): {
  root: string;
  sourceRoot: string;
  configPath: string;
  stagingRoot: string;
  databasePath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-workflow-pack-'));
  roots.push(root);
  const sourceRoot = path.join(root, 'workflow-packs');
  const packRoot = path.join(sourceRoot, 'example-pack');
  const scriptPath = path.join(packRoot, 'runtime', 'scripts', 'run.sh');
  const configPath = path.join(root, 'local', 'workflow-packs.json');
  const stagingRoot = path.join(root, 'staging');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho pinned\n');
  if (input.fullExecutionResources) {
    const executionFiles: Array<[string, string]> = [
      [
        'runtime/agents/reviewer.md',
        '---\nname: pack-reviewer\ndescription: Reviews Pack output\ntools: Read, Glob, Grep\n---\nReview the pinned Pack output.\n',
      ],
      [
        'runtime/skills/pack-review/SKILL.md',
        '---\nname: pack-review\ndescription: Review a pinned Pack result\n---\nRead the Pack template before reviewing.\n',
      ],
      [
        'runtime/mcp/mcp.json',
        `${JSON.stringify(
          {
            mcpServers: {
              'pack-tools': {
                command: 'node',
                args: [
                  '/workspace/workflow-pack-resources/scripts/mcp-server.mjs',
                ],
              },
            },
          },
          null,
          2,
        )}\n`,
      ],
      [
        'runtime/scripts/mcp-server.mjs',
        "process.stdout.write('pinned-pack-mcp');\n",
      ],
      ['runtime/templates/report.md', '# Pinned Pack Report\n'],
    ];
    for (const [relativePath, content] of executionFiles) {
      const target = path.join(packRoot, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }
  const sources = packSourceDocuments(input.sourceOverride);
  const sourceBytes = new Map<string, Buffer>();
  for (const source of sources) {
    const bytes = Buffer.from(`${JSON.stringify(source.content, null, 2)}\n`);
    const sourcePath = path.join(packRoot, source.relativePath);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, bytes);
    sourceBytes.set(source.relativePath, bytes);
  }
  const withoutHash: Omit<WorkflowPackManifestDocument, 'manifest_hash'> = {
    format: 'icarus.workflow-pack/1',
    pack_ref: { id: 'example-pack', version: '1.0.0' },
    display_name: 'Example Pack',
    description: 'Example workflows',
    namespace: 'example_pack',
    owner_principal_ref: 'human:local-owner',
    dependencies: [],
    workflow_resources: sources.map((source) => ({
      kind: source.kind,
      ref: source.ref,
      source_path: source.relativePath,
      expected_source_hash:
        source.kind === 'recipe' && input.expectedSourceHash
          ? input.expectedSourceHash
          : sha256(sourceBytes.get(source.relativePath)!),
    })),
    execution_resources: {
      agents: input.fullExecutionResources ? 'runtime/agents' : null,
      skills: input.fullExecutionResources ? 'runtime/skills' : null,
      mcp: input.fullExecutionResources ? 'runtime/mcp' : null,
      scripts: 'runtime/scripts',
      templates: input.fullExecutionResources ? 'runtime/templates' : null,
    },
    permissions: {
      host_actions: [],
      file_scopes: [],
      mcp_servers: input.fullExecutionResources ? ['pack-tools'] : [],
      effect_ceiling: 'read_only',
    },
  };
  const manifest: WorkflowPackManifestDocument = {
    ...withoutHash,
    manifest_hash: calculateWorkflowPackManifestHash(withoutHash),
  };
  fs.writeFileSync(
    path.join(packRoot, 'pack.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ enabled: ['example-pack'] }, null, 2)}\n`,
  );
  return {
    root,
    sourceRoot,
    configPath,
    stagingRoot,
    databasePath: path.join(root, 'workflow-runtime.db'),
  };
}

function bindRunToActivePackRelease(
  store: WorkflowRuntimeStore,
  graphRunId: string,
): void {
  const authority = store.queryOne<{
    snapshot_id: string;
    snapshot_hash: string;
    closure_manifest_id: string;
    closure_hash: string;
  }>(
    `SELECT snapshot.id AS snapshot_id, snapshot.snapshot_hash,
            snapshot.closure_manifest_id, snapshot.closure_hash
       FROM workflow_pack_active_releases active
       JOIN workflow_pack_releases release
         ON release.id = active.release_id
        AND release.release_hash = active.release_hash
       JOIN workflow_registry_retention_handles published
         ON published.pack_release_id = release.id
        AND published.handle_kind = 'published' AND published.status = 'held'
       JOIN workflow_registry_snapshots snapshot
         ON snapshot.closure_manifest_id = published.closure_manifest_id
        AND snapshot.closure_hash = published.closure_hash
      WHERE active.pack_id = 'example-pack'`,
    [],
  );
  if (!authority) throw new Error('Active Pack authority is missing');
  store.withImmediateTransaction((transaction) => {
    transaction.execute(
      `INSERT INTO workflow_registry_retention_handles (
         id, handle_kind, pack_release_id, graph_run_id, backup_id,
         external_actor_ref, closure_manifest_id, closure_hash, status,
         created_at_ms, released_at_ms, row_version
       ) VALUES (?, 'active_run', NULL, ?, NULL, NULL, ?, ?, 'held', 201, NULL, 1)`,
      [
        `retention:test-pack:${graphRunId}`,
        graphRunId,
        authority.closure_manifest_id,
        authority.closure_hash,
      ],
    );
    transaction.execute(
      `UPDATE workflow_graph_runs
          SET registry_snapshot_id = ?, registry_snapshot_hash = ?,
              registry_retention_handle_id = ?,
              row_version = row_version + 1
        WHERE id = ?`,
      [
        authority.snapshot_id,
        authority.snapshot_hash,
        `retention:test-pack:${graphRunId}`,
        graphRunId,
      ],
    );
  });
}

function rewritePackRelease(
  paths: ReturnType<typeof fixture>,
  version: string,
  script: string,
): void {
  const packRoot = path.join(paths.sourceRoot, 'example-pack');
  fs.writeFileSync(path.join(packRoot, 'runtime', 'scripts', 'run.sh'), script);
  const manifestPath = path.join(packRoot, 'pack.json');
  const manifest = JSON.parse(
    fs.readFileSync(manifestPath, 'utf8'),
  ) as WorkflowPackManifestDocument;
  manifest.pack_ref.version = version;
  const { manifest_hash: _oldHash, ...withoutHash } = manifest;
  manifest.manifest_hash = calculateWorkflowPackManifestHash(withoutHash);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('Workflow Pack reconciler', () => {
  it('publishes one active authority and invalidates Catalog selection on disable', () => {
    const paths = fixture();
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      expect(ensureTaskWorkspaceCore(store, 100)).toBe('initialized');
      expect(ensureTaskWorkspaceCore(store, 101)).toBe('preserved');
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items).toEqual([
        expect.objectContaining({
          pack_id: 'example-pack',
          state: 'enabled',
        }),
      ]);
      const supportedKinds = [
        'recipe',
        'routing_scope',
        'execution_policy',
        'definition',
        'command_policy',
        'context_contract',
        'schema',
        'scope_interface',
        'graph_template',
        'graph_policy',
        'card_presentation',
      ].sort();
      const publishedKinds = store
        .queryAll<{ resource_type: string }>(
          `SELECT DISTINCT resource_type
             FROM workflow_registry_resources
            WHERE owner_pack_id = ?`,
          ['example-pack'],
        )
        .map((row) => row.resource_type)
        .filter((kind) => supportedKinds.includes(kind))
        .sort();
      expect(publishedKinds).toEqual(supportedKinds);
      const gateway = new RuntimeWorkspaceGateway(store, Buffer.alloc(32, 7));
      const catalog = gateway.listRecipes({
        principal_ref: 'human:local-owner',
        now_ms: 300,
      });
      expect(catalog.items).toHaveLength(1);
      expect(catalog.items[0]).toEqual(
        expect.objectContaining({
          distribution_kind: 'pack',
          distribution_ref: { id: 'example-pack', version: '1.0.0' },
          recipe_ref: { id: 'example.recipe', version: '1.0.0' },
        }),
      );
      const selected = catalog.items[0]!;
      const launchInput: JsonObject = { task: 'Pack launch' };
      const launchAttachments: JsonObject[] = [];
      const launched = gateway.launchPublished({
        principal_ref: 'human:local-owner',
        selection_token: selected.selection_token,
        authorization_ref: 'workflow-pack-launch-authorization',
        launch: {
          request_id: 'workflow-pack-launch-request',
          creation_domain: 'workflow-pack-test',
          creation_key: 'workflow-pack-launch',
          effective_input_json: launchInput,
          effective_input_hash: domainSeparatedSha256(
            'icarus:test-workflow-pack-input:1\n',
            launchInput,
          ),
          attachment_manifest_json: launchAttachments,
          attachment_manifest_hash: domainSeparatedSha256(
            'icarus:test-workflow-pack-attachments:1\n',
            launchAttachments,
          ),
          deadline_at_ms: null,
        },
        now_ms: 300,
      });
      expect(
        store.queryOne<{
          registry_snapshot_id: string;
          registry_snapshot_hash: string;
        }>(
          `SELECT registry_snapshot_id, registry_snapshot_hash
             FROM workflow_graph_runs WHERE id = ?`,
          [launched.activation.graphRunId],
        ),
      ).toEqual({
        registry_snapshot_id: expect.stringContaining('example-pack'),
        registry_snapshot_hash: expect.stringMatching(/^sha256:/),
      });
      const disabled = manager.setDesiredEnabled('example-pack', false);
      expect(disabled.runtime_disabled).toBe(true);
      expect(
        gateway.listRecipes({
          principal_ref: 'human:local-owner',
          now_ms: 301,
        }).items,
      ).toEqual([]);
      expect(() =>
        gateway.refreshRecipeSelection({
          principal_ref: 'human:local-owner',
          recipe_ref: selected.recipe_ref,
          recipe_hash: selected.recipe_hash,
          now_ms: 301,
        }),
      ).toThrowError(expect.objectContaining({ code: 'selection_stale' }));
      expect(
        store.queryOne<{ status: string }>(
          'SELECT status FROM workflow_pack_releases WHERE pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ status: 'disabled' });
      expect(
        store.queryOne<{ count: number }>(
          `SELECT count(*) AS count
             FROM workflow_registry_retention_handles
            WHERE handle_kind = 'published' AND status = 'held'`,
          [],
        ),
      ).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });

  it('keeps the active pointer unchanged when updated source compile fails', () => {
    const paths = fixture();
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'enabled',
          release_id: expect.any(String),
        }),
      );
      const before = store.queryOne<{
        release_id: string;
        release_hash: string;
        row_version: number;
      }>(
        `SELECT release_id, release_hash, row_version
           FROM workflow_pack_active_releases WHERE pack_id = ?`,
        ['example-pack'],
      );
      const sourcePath = path.join(
        paths.sourceRoot,
        'example-pack',
        'workflow-src',
        'definition.json',
      );
      const definition = JSON.parse(
        fs.readFileSync(sourcePath, 'utf8'),
      ) as JsonObject;
      definition.definition_hash = `sha256:${'0'.repeat(64)}`;
      const definitionBytes = Buffer.from(
        `${JSON.stringify(definition, null, 2)}\n`,
      );
      fs.writeFileSync(sourcePath, definitionBytes);
      const manifestPath = path.join(
        paths.sourceRoot,
        'example-pack',
        'pack.json',
      );
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, 'utf8'),
      ) as WorkflowPackManifestDocument;
      const definitionEntry = manifest.workflow_resources.find(
        (entry) => entry.kind === 'definition',
      )!;
      definitionEntry.expected_source_hash = sha256(definitionBytes);
      manifest.permissions.effect_ceiling = 'external_write';
      const { manifest_hash: _oldHash, ...manifestWithoutHash } = manifest;
      manifest.manifest_hash =
        calculateWorkflowPackManifestHash(manifestWithoutHash);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const report = manager.reconcileAtStartup();
      expect(report.items[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          error: expect.stringContaining('Definition failed compile'),
        }),
      );
      expect(
        store.queryOne(
          `SELECT release_id, release_hash, row_version
             FROM workflow_pack_active_releases WHERE pack_id = ?`,
          ['example-pack'],
        ),
      ).toEqual(before);
      expect(manager.list()[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          permissions: {
            host_actions: [],
            file_scopes: [],
            mcp_servers: [],
            effect_ceiling: 'read_only',
          },
          active_release: expect.objectContaining({
            release_id: before!.release_id,
            release_hash: before!.release_hash,
          }),
        }),
      );
    } finally {
      store.close();
    }
  });

  it('pins the exact release closure across v1 to v2 to v1 rollback', () => {
    const paths = fixture();
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      let now = 200;
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => now,
      });
      const gateway = new RuntimeWorkspaceGateway(store, Buffer.alloc(32, 8));
      manager.reconcileAtStartup();
      const v1 = gateway.listRecipes({
        principal_ref: 'human:local-owner',
        now_ms: 201,
      }).items[0]!;

      now = 300;
      rewritePackRelease(paths, '2.0.0', '#!/bin/sh\necho pinned-v2\n');
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'enabled',
          release_id: expect.any(String),
        }),
      );
      const v2 = gateway.listRecipes({
        principal_ref: 'human:local-owner',
        now_ms: 301,
      }).items[0]!;
      expect(v2.distribution_ref).toEqual({
        id: 'example-pack',
        version: '2.0.0',
      });
      expect(v2.recipe_ref).toEqual(v1.recipe_ref);
      expect(v2.recipe_hash).toBe(v1.recipe_hash);
      expect(() =>
        gateway.launchPublished({
          principal_ref: 'human:local-owner',
          selection_token: v1.selection_token,
          authorization_ref: 'stale-v1-token',
          launch: {
            request_id: 'stale-v1-request',
            creation_domain: 'workflow-pack-test',
            creation_key: 'stale-v1',
            effective_input_json: {},
            effective_input_hash: domainSeparatedSha256(
              'icarus:test-workflow-pack-input:1\n',
              {},
            ),
            attachment_manifest_json: [],
            attachment_manifest_hash: domainSeparatedSha256(
              'icarus:test-workflow-pack-attachments:1\n',
              [],
            ),
            deadline_at_ms: null,
          },
          now_ms: 301,
        }),
      ).toThrowError(expect.objectContaining({ code: 'selection_stale' }));

      now = 400;
      rewritePackRelease(paths, '1.0.0', '#!/bin/sh\necho pinned\n');
      manager.reconcileAtStartup();
      const rolledBack = gateway.listRecipes({
        principal_ref: 'human:local-owner',
        now_ms: 401,
      }).items[0]!;
      expect(rolledBack.distribution_ref).toEqual({
        id: 'example-pack',
        version: '1.0.0',
      });
      expect(() =>
        gateway.refreshRecipeSelection({
          principal_ref: 'human:local-owner',
          recipe_ref: v2.recipe_ref,
          recipe_hash: v2.recipe_hash,
          now_ms: 401,
        }),
      ).not.toThrow();
      expect(() =>
        gateway.launchPublished({
          principal_ref: 'human:local-owner',
          selection_token: v2.selection_token,
          authorization_ref: 'stale-v2-token',
          launch: {
            request_id: 'stale-v2-request',
            creation_domain: 'workflow-pack-test',
            creation_key: 'stale-v2',
            effective_input_json: {},
            effective_input_hash: domainSeparatedSha256(
              'icarus:test-workflow-pack-input:1\n',
              {},
            ),
            attachment_manifest_json: [],
            attachment_manifest_hash: domainSeparatedSha256(
              'icarus:test-workflow-pack-attachments:1\n',
              [],
            ),
            deadline_at_ms: null,
          },
          now_ms: 401,
        }),
      ).toThrowError(expect.objectContaining({ code: 'selection_stale' }));

      const launchInput: JsonObject = { task: 'Rollback launch' };
      const launched = gateway.launchPublished({
        principal_ref: 'human:local-owner',
        selection_token: rolledBack.selection_token,
        authorization_ref: 'rolled-back-v1-token',
        launch: {
          request_id: 'rolled-back-v1-request',
          creation_domain: 'workflow-pack-test',
          creation_key: 'rolled-back-v1',
          effective_input_json: launchInput,
          effective_input_hash: domainSeparatedSha256(
            'icarus:test-workflow-pack-input:1\n',
            launchInput,
          ),
          attachment_manifest_json: [],
          attachment_manifest_hash: domainSeparatedSha256(
            'icarus:test-workflow-pack-attachments:1\n',
            [],
          ),
          deadline_at_ms: null,
        },
        now_ms: 401,
      });
      const pin = resolveWorkflowPackExecutionResourcePin(
        store,
        launched.activation.graphRunId,
        paths.stagingRoot,
      );
      expect(pin).toMatchObject({ pack_version: '1.0.0' });
      expect(
        fs.readFileSync(path.join(pin!.root_path, 'scripts', 'run.sh'), 'utf8'),
      ).toContain('echo pinned');
      expect(
        fs.readFileSync(path.join(pin!.root_path, 'scripts', 'run.sh'), 'utf8'),
      ).not.toContain('pinned-v2');
    } finally {
      store.close();
    }
  });

  it('reports missing desired source without hiding the retained active release', () => {
    const paths = fixture();
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      manager.reconcileAtStartup();
      fs.renameSync(
        path.join(paths.sourceRoot, 'example-pack'),
        path.join(paths.root, 'source-removed-out-of-band'),
      );
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({ state: 'source_missing' }),
      );
      expect(manager.list()[0]).toEqual(
        expect.objectContaining({
          state: 'source_missing',
          source_present: false,
          active_release: expect.objectContaining({
            release_id: expect.any(String),
          }),
        }),
      );
    } finally {
      store.close();
    }
  });

  it('rejects non-empty cross-Pack dependencies before publication', () => {
    const paths = fixture();
    const manifestPath = path.join(
      paths.sourceRoot,
      'example-pack',
      'pack.json',
    );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as WorkflowPackManifestDocument;
    manifest.dependencies = [
      {
        pack_release_ref: { id: 'another-pack', version: '1.0.0' },
        pack_release_hash: `sha256:${'1'.repeat(64)}`,
        required_resource_refs: [],
      },
    ];
    const { manifest_hash: _oldHash, ...manifestWithoutHash } = manifest;
    manifest.manifest_hash =
      calculateWorkflowPackManifestHash(manifestWithoutHash);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          error: expect.stringContaining(
            'does not support cross-Pack dependencies',
          ),
        }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_registry_resources WHERE owner_pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('rejects Host lifecycle keys before publishing any Pack resources', () => {
    const paths = fixture({ sourceOverride: { hostEntry: 'host/index.js' } });
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({ state: 'invalid' }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_registry_resources WHERE owner_pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('does not compare Workflow business effects with Pack container permissions', () => {
    const paths = fixture({
      sourceOverride: { effect_ceiling: 'mutable_effects' },
    });
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({ state: 'enabled' }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_pack_releases WHERE pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 1 });
    } finally {
      store.close();
    }
  });

  it('rejects Host actions not declared by Manifest permissions', () => {
    const paths = fixture({
      sourceOverride: { required_permissions: ['host.undeclared'] },
    });
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          error: expect.stringMatching(/Host action/),
        }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_pack_releases WHERE pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('rejects a malformed unused closed-schema resource before publication', () => {
    const paths = fixture();
    const packRoot = path.join(paths.sourceRoot, 'example-pack');
    const malformed = {
      ...packSourceDocuments().find((source) => source.kind === 'definition')!
        .content,
      ref: { id: 'example.unused-definition', version: '1.0.0' },
      unsupported_field: true,
    };
    const bytes = Buffer.from(`${JSON.stringify(malformed, null, 2)}\n`);
    const relativePath = 'workflow-src/unused-definition.json';
    fs.writeFileSync(path.join(packRoot, relativePath), bytes);
    const manifestPath = path.join(packRoot, 'pack.json');
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as WorkflowPackManifestDocument;
    manifest.workflow_resources.push({
      kind: 'definition',
      ref: malformed.ref,
      source_path: relativePath,
      expected_source_hash: sha256(bytes),
    });
    const { manifest_hash: _oldHash, ...withoutHash } = manifest;
    manifest.manifest_hash = calculateWorkflowPackManifestHash(withoutHash);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          error: expect.stringContaining(
            'authoritative closed definition schema',
          ),
        }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_registry_resources WHERE owner_pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('rejects an unused execution policy with an unsupported field before publication', () => {
    const paths = fixture();
    const packRoot = path.join(paths.sourceRoot, 'example-pack');
    const malformed = {
      effect_ceiling: 'read_only',
      unsupported_field: true,
    };
    const bytes = Buffer.from(`${JSON.stringify(malformed, null, 2)}\n`);
    const relativePath = 'workflow-src/unused-execution-policy.json';
    fs.writeFileSync(path.join(packRoot, relativePath), bytes);
    const manifestPath = path.join(packRoot, 'pack.json');
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as WorkflowPackManifestDocument;
    manifest.workflow_resources.push({
      kind: 'execution_policy',
      ref: { id: 'example.unused-execution', version: '1.0.0' },
      source_path: relativePath,
      expected_source_hash: sha256(bytes),
    });
    const { manifest_hash: _oldHash, ...withoutHash } = manifest;
    manifest.manifest_hash = calculateWorkflowPackManifestHash(withoutHash);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          error: expect.stringContaining(
            'authoritative closed execution_policy schema',
          ),
        }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_registry_resources WHERE owner_pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('rejects an unused routing scope with an unsupported field before publication', () => {
    const paths = fixture();
    const packRoot = path.join(paths.sourceRoot, 'example-pack');
    const malformed = { mode: 'explicit', unsupported_field: true };
    const bytes = Buffer.from(`${JSON.stringify(malformed, null, 2)}\n`);
    const relativePath = 'workflow-src/unused-routing-scope.json';
    fs.writeFileSync(path.join(packRoot, relativePath), bytes);
    const manifestPath = path.join(packRoot, 'pack.json');
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as WorkflowPackManifestDocument;
    manifest.workflow_resources.push({
      kind: 'routing_scope',
      ref: { id: 'example.unused-routing', version: '1.0.0' },
      source_path: relativePath,
      expected_source_hash: sha256(bytes),
    });
    const { manifest_hash: _oldHash, ...withoutHash } = manifest;
    manifest.manifest_hash = calculateWorkflowPackManifestHash(withoutHash);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          error: expect.stringContaining(
            'authoritative closed routing_scope schema',
          ),
        }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_registry_resources WHERE owner_pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('rejects a Registry kind outside the closed Workflow Pack Manifest surface', () => {
    const paths = fixture();
    const manifestPath = path.join(
      paths.sourceRoot,
      'example-pack',
      'pack.json',
    );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as WorkflowPackManifestDocument;
    (manifest.workflow_resources[0] as unknown as { kind: string }).kind =
      'capability';
    const { manifest_hash: _oldHash, ...withoutHash } = manifest;
    manifest.manifest_hash = calculateWorkflowPackManifestHash(withoutHash);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      expect(manager.reconcileAtStartup().items[0]).toEqual(
        expect.objectContaining({
          state: 'invalid',
          error: expect.stringMatching(/manifest is invalid.*kind/i),
        }),
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_registry_resources WHERE owner_pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual({ count: 0 });
    } finally {
      store.close();
    }
  });

  it('separates disable, uninstall, and purge while retaining Registry history', () => {
    const paths = fixture();
    const archiveRoot = path.join(paths.root, 'uninstalled');
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath: paths.databasePath,
      databaseMode: 'create',
    });
    try {
      ensureTaskWorkspaceCore(store, 100);
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        uninstallArchiveRoot: archiveRoot,
        now: () => 200,
      });
      manager.reconcileAtStartup();
      expect(() => manager.uninstall('example-pack')).toThrow(
        'must be disabled before uninstall',
      );

      manager.setDesiredEnabled('example-pack', false);
      const releaseCount = store.queryOne<{ count: number }>(
        'SELECT count(*) AS count FROM workflow_pack_releases WHERE pack_id = ?',
        ['example-pack'],
      );
      const uninstall = manager.uninstall('example-pack');
      expect(fs.existsSync(uninstall.archived_path)).toBe(true);
      expect(fs.existsSync(path.join(paths.sourceRoot, 'example-pack'))).toBe(
        false,
      );

      const preview = manager.purgePreview('example-pack');
      expect(preview).toMatchObject({
        pack_id: 'example-pack',
        active_run_pins: 0,
        preserves: [
          'task_sessions',
          'runtime_history',
          'shared_artifacts',
          'audit',
          'external_workspaces',
        ],
      });
      expect(preview.managed_paths).toContain(
        path.join(paths.stagingRoot, 'example-pack'),
      );
      manager.purge('example-pack');
      expect(fs.existsSync(path.join(paths.stagingRoot, 'example-pack'))).toBe(
        false,
      );
      expect(
        store.queryOne<{ count: number }>(
          'SELECT count(*) AS count FROM workflow_pack_releases WHERE pack_id = ?',
          ['example-pack'],
        ),
      ).toEqual(releaseCount);
    } finally {
      store.close();
    }
  });

  it('pins exact staged execution bytes for a Run and blocks purge while held', async () => {
    const paths = fixture({ fullExecutionResources: true });
    const manifestPath = path.join(
      paths.sourceRoot,
      'example-pack',
      'pack.json',
    );
    const manifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as WorkflowPackManifestDocument;
    manifest.permissions.host_actions = ['z_action', 'a_action'];
    manifest.permissions.file_scopes = ['workspace', 'agent'];
    const { manifest_hash: _oldManifestHash, ...manifestWithoutHash } =
      manifest;
    manifest.manifest_hash =
      calculateWorkflowPackManifestHash(manifestWithoutHash);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const runtime = createG6MapFixture('workflow-pack-execution-pin');
    roots.push(runtime.instance.dataRoot);
    const store = runtime.instance.store;
    try {
      ensureTaskWorkspaceCore(store, 100);
      expect(
        resolveWorkflowPackExecutionResourcePin(
          store,
          runtime.graphRunId,
          paths.stagingRoot,
        ),
      ).toBeNull();
      const manager = new WorkflowPackManager(store, {
        sourceRoot: paths.sourceRoot,
        configPath: paths.configPath,
        stagingRoot: paths.stagingRoot,
        now: () => 200,
      });
      manager.reconcileAtStartup();
      bindRunToActivePackRelease(store, runtime.graphRunId);

      const pin = resolveWorkflowPackExecutionResourcePin(
        store,
        runtime.graphRunId,
        paths.stagingRoot,
      );
      expect(pin).toMatchObject({
        pack_id: 'example-pack',
        pack_version: '1.0.0',
        execution_resource_files: {
          agents: expect.arrayContaining([
            expect.objectContaining({ path: 'reviewer.md' }),
          ]),
          skills: expect.arrayContaining([
            expect.objectContaining({ path: 'pack-review/SKILL.md' }),
          ]),
          mcp: expect.arrayContaining([
            expect.objectContaining({ path: 'mcp.json' }),
          ]),
          scripts: expect.arrayContaining([
            expect.objectContaining({ path: 'run.sh' }),
            expect.objectContaining({ path: 'mcp-server.mjs' }),
          ]),
          templates: expect.arrayContaining([
            expect.objectContaining({ path: 'report.md' }),
          ]),
        },
        permissions: {
          host_actions: ['a_action', 'z_action'],
          file_scopes: ['agent', 'workspace'],
          mcp_servers: ['pack-tools'],
          effect_ceiling: 'read_only',
        },
      });
      expect(
        fs.readFileSync(path.join(pin!.root_path, 'scripts', 'run.sh'), 'utf8'),
      ).toContain('echo pinned');
      expect(() =>
        verifyWorkflowPackExecutionResourcePin(
          { ...pin!, pack_version: '9.9.9' },
          paths.stagingRoot,
        ),
      ).toThrow('staging identity drifted');

      manager.setDesiredEnabled('example-pack', false);
      expect(manager.purgePreview('example-pack').active_run_pins).toBe(1);
      expect(() => manager.purge('example-pack')).toThrow('active Run pin');
      const retainedPin = resolveWorkflowPackExecutionResourcePin(
        store,
        runtime.graphRunId,
        paths.stagingRoot,
      );
      expect(retainedPin).toMatchObject({ pack_id: 'example-pack' });
      expect(() =>
        bindRunToActivePackRelease(store, 'new-run-after-disable'),
      ).toThrow('Active Pack authority is missing');

      const containerResources = workflowPackContainerResources(retainedPin!);
      const containerResolverModule =
        '../../container/agent-runner/src/workflow-pack-resources.js';
      const { resolveWorkflowPackRuntimeOptions } = await import(
        containerResolverModule
      );
      const runtimeOptions = resolveWorkflowPackRuntimeOptions(
        containerResources,
        {
          readTextFile: (containerPath: string) => {
            const relative = path.posix.relative(
              containerResources.root_path,
              containerPath,
            );
            if (relative.startsWith('../') || path.posix.isAbsolute(relative)) {
              throw new Error(
                'Container resource path escaped the pinned root',
              );
            }
            return fs.readFileSync(
              path.join(retainedPin!.root_path, ...relative.split('/')),
              'utf8',
            );
          },
        },
      );
      expect(containerResources.resource_paths).toEqual({
        agents: '/workspace/workflow-pack-resources/agents',
        skills: '/workspace/workflow-pack-resources/skills',
        mcp: '/workspace/workflow-pack-resources/mcp',
        scripts: '/workspace/workflow-pack-resources/scripts',
        templates: '/workspace/workflow-pack-resources/templates',
      });
      expect(runtimeOptions.allowedTools).toEqual(
        expect.arrayContaining(['Task', 'Skill', 'mcp__pack-tools__*']),
      );
      expect(runtimeOptions.mcpServers).toEqual({
        'pack-tools': {
          command: 'node',
          args: ['/workspace/workflow-pack-resources/scripts/mcp-server.mjs'],
        },
      });
      expect(runtimeOptions.environment).toMatchObject({
        ICARUS_WORKFLOW_PACK_SCRIPTS_DIR:
          '/workspace/workflow-pack-resources/scripts',
        ICARUS_WORKFLOW_PACK_TEMPLATES_DIR:
          '/workspace/workflow-pack-resources/templates',
      });
      expect(
        fs.readFileSync(
          path.join(retainedPin!.root_path, 'agents', 'reviewer.md'),
          'utf8',
        ),
      ).toContain('pack-reviewer');
      expect(
        fs.readFileSync(
          path.join(
            retainedPin!.root_path,
            'skills',
            'pack-review',
            'SKILL.md',
          ),
          'utf8',
        ),
      ).toContain('pack-review');

      fs.appendFileSync(
        path.join(pin!.root_path, 'scripts', 'run.sh'),
        'drift\n',
      );
      expect(() =>
        resolveWorkflowPackExecutionResourcePin(
          store,
          runtime.graphRunId,
          paths.stagingRoot,
        ),
      ).toThrow('staging content drifted');
    } finally {
      runtime.instance.closeStore();
    }
  });
});
