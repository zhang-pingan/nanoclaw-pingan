import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import { calculateG32AFeatureManifestHash } from './g3-2a-feature-manifest-intake.js';
import {
  checkG32FeatureManifestIntake,
  G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_SCHEMA,
  G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA,
  parseAndPreflightG32FeatureManifest,
  preflightG32FeatureManifest,
} from './g3-2-feature-manifest-intake.js';
import type { G32FeatureManifest } from './g3-2-feature-manifest-intake-types.js';
import type { Sha256Hash } from './types.js';

function hash(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function manifestFor(content: Uint8Array): G32FeatureManifest {
  const manifest = {
    format: 'icarus.feature-manifest/2',
    feature_ref: { id: 'example.feature', version: '1.0.0' },
    namespace: 'example',
    owner_principal_ref: 'human:local-owner',
    dependencies: [],
    package_resources: {
      skills: [],
      agents: [],
      mcp: [],
      scripts: [],
      templates: [],
    },
    extension_surfaces: {
      api_entry: null,
      nav_entry: null,
      renderer_entry: null,
    },
    dynamic_workflow_resources: [
      {
        kind: 'definition',
        ref: { id: 'example.workflow', version: '1.0.0' },
        source_path: 'workflow-src/example.json',
        expected_source_hash: hash(content),
      },
    ],
    ownership: {
      feature_source_root: 'features/example',
      workflow_source_root: 'features/example/workflow-src',
      execution_bundle_owner: 'feature_release',
      registry_namespace: 'example',
    },
    lifecycle: {
      draining_policy_ref: { id: 'example.draining', version: '1.0.0' },
      retention_policy_ref: { id: 'example.retention', version: '1.0.0' },
      deletion_policy_ref: { id: 'example.deletion', version: '1.0.0' },
    },
    manifest_hash: 'sha256:' + '0'.repeat(64),
  } as G32FeatureManifest;
  manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
  return manifest;
}

function fixtureRoot(content: Uint8Array): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-g32-'));
  const source = path.join(root, 'workflow-src');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'example.json'), content);
  return root;
}

describe('G3.2 Feature Manifest vNext strict intake preflight', () => {
  it('checks the deterministic G3.2 preflight pack and closed schemas', () => {
    const pack = checkG32FeatureManifestIntake();
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const profile = JSON.parse(
      fs.readFileSync(
        path.join(
          import.meta.dirname,
          'registry/feature-manifest-vnext-strict-intake-preflight-profile@1.json',
        ),
        'utf8',
      ),
    ) as { payload: AnySchema };
    expect(
      ajv.validate(
        G32_FEATURE_MANIFEST_PREFLIGHT_PROFILE_SCHEMA,
        profile.payload,
      ),
    ).toBe(true);
    expect(
      ajv.validate(G32_FEATURE_MANIFEST_PREFLIGHT_RESULT_SCHEMA, {
        format:
          'icarus.workflow-feature-manifest-vnext-strict-intake-preflight-result/1',
        outcome: 'rejected',
        code: 'feature_manifest_source_path_drift',
        phase: 'root_snapshot_path_read',
        diagnostics: [
          {
            code: 'feature_manifest_source_path_drift',
            phase: 'root_snapshot_path_read',
            pointer: '/ownership/feature_source_root',
            detail: 'missing',
          },
        ],
        feature_id: 'example',
        manifest_hash: null,
        reader_invoked: true,
        resolver_invoked: false,
        root_snapshot_status: 'verified',
        source_hash_status: 'not_invoked',
        dependency_resolution_status: 'not_attempted',
      }),
    ).toBe(true);
    expect(pack.payload).toMatchObject({
      gate: 'G3.2',
      slice: 'strict_intake_preflight',
      status: 'DONE',
      registry_write_performed: false,
      publisher_executed: false,
      activation_performed: false,
    });
  });

  it('reads declared sources with no-follow and verifies raw bytes', () => {
    const content = Buffer.from('{"workflow":true}\n', 'utf8');
    const manifest = manifestFor(content);
    const root = fixtureRoot(content);
    const result = preflightG32FeatureManifest(
      Buffer.from(JSON.stringify(manifest)),
      {
        featureSourceRoot: root,
      },
    );
    expect(result).toMatchObject({
      outcome: 'accepted',
      code: 'feature_manifest_intake_ok',
      reader_invoked: true,
      root_snapshot_status: 'verified',
      source_hash_status: 'verified',
      dependency_resolution_status: 'resolved',
    });
  });

  it('preserves G3.2A precedence before filesystem access', () => {
    const content = Buffer.from('x', 'utf8');
    const manifest = manifestFor(content);
    const raw = JSON.stringify({ ...manifest, workflowDefinitions: [] });
    const result = parseAndPreflightG32FeatureManifest(Buffer.from(raw), {
      featureSourceRoot: '/definitely/missing',
    });
    expect(result).toMatchObject({
      outcome: 'rejected',
      code: 'feature_manifest_removed_resource_key',
      phase: 'removed_unknown_structural_intake',
      reader_invoked: false,
      resolver_invoked: false,
    });
  });

  it('rejects root symlink, hard-link identity reuse, and hash drift', () => {
    const content = Buffer.from('x', 'utf8');
    const manifest = manifestFor(content);
    const root = fixtureRoot(content);
    const symlink = `${root}-symlink`;
    fs.symlinkSync(root, symlink, 'dir');
    expect(
      preflightG32FeatureManifest(Buffer.from(JSON.stringify(manifest)), {
        featureSourceRoot: symlink,
      }).code,
    ).toBe('feature_manifest_source_root_symlink');

    const wrong = manifestFor(Buffer.from('different', 'utf8'));
    expect(
      preflightG32FeatureManifest(Buffer.from(JSON.stringify(wrong)), {
        featureSourceRoot: root,
      }).code,
    ).toBe('feature_manifest_source_hash_mismatch');

    const second = path.join(root, 'workflow-src', 'second.json');
    fs.linkSync(path.join(root, 'workflow-src', 'example.json'), second);
    const linked = structuredClone(manifest) as G32FeatureManifest;
    linked.dynamic_workflow_resources.push({
      kind: 'recipe',
      ref: { id: 'example.recipe', version: '1.0.0' },
      source_path: 'workflow-src/second.json',
      expected_source_hash: hash(content),
    });
    linked.manifest_hash = calculateG32AFeatureManifestHash(linked);
    expect(
      preflightG32FeatureManifest(Buffer.from(JSON.stringify(linked)), {
        featureSourceRoot: root,
      }).code,
    ).toBe('feature_manifest_source_hard_link');
  });

  it('requires exact dependency release and resource pins', () => {
    const content = Buffer.from('x', 'utf8');
    const manifest = manifestFor(content);
    manifest.dependencies = [
      {
        feature_release_ref: { id: 'other.release', version: '2.0.0' },
        feature_release_hash: ('sha256:' + 'a'.repeat(64)) as Sha256Hash,
        required_resource_refs: [{ id: 'other.schema', version: '1.0.0' }],
      },
    ];
    manifest.manifest_hash = calculateG32AFeatureManifestHash(manifest);
    const root = fixtureRoot(content);
    const bytes = Buffer.from(JSON.stringify(manifest));
    const unresolved = preflightG32FeatureManifest(bytes, {
      featureSourceRoot: root,
    });
    expect(unresolved.code).toBe('feature_manifest_dependency_unresolved');
    const resolved = preflightG32FeatureManifest(bytes, {
      featureSourceRoot: root,
      dependencyResolver: (dependency) => ({
        feature_release_ref: dependency.feature_release_ref,
        feature_release_hash: dependency.feature_release_hash,
        required_resource_refs: dependency.required_resource_refs,
      }),
    });
    expect(resolved.outcome).toBe('accepted');
    expect(resolved.resolver_invoked).toBe(true);
  });
});
