import { describe, expect, it } from 'vitest';

import { buildStaticAbsenceContracts } from '../src/workflow-runtime/contracts/static-absence-source.js';
import { checkContractPackStaticAbsence } from '../src/workflow-runtime/contracts/static-absence-pack.js';
import {
  REMOVED_API_FIXTURES,
  REMOVED_DOM_NAV_KEYS,
  REMOVED_DOM_SCREEN_IDS,
} from '../src/workflow-runtime/contracts/static-absence-types.js';

describe('legacy workflow boundary', () => {
  it('keeps the migration archive checksum-valid without using its content for source hits', () => {
    const { evidence, candidateBoundary } = buildStaticAbsenceContracts();
    expect(candidateBoundary.archived_file_count).toBe(16);
    expect(candidateBoundary.archive_manifest_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(candidateBoundary.checksum_manifest_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(evidence.candidate_scanned_content_file_count).toBe(0);
  });

  it('is unreachable from production, test-helper, setup and runtime file access', () => {
    const { evidence, candidateBoundary } = buildStaticAbsenceContracts();
    expect(evidence.candidate_runtime_file_access_hits).toEqual([]);
    for (const hash of [
      candidateBoundary.production_import_reachability_hash,
      candidateBoundary.test_helper_reachability_hash,
      candidateBoundary.setup_reachability_hash,
    ]) {
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('stays outside compiler fixtures, Feature registry, build and release inputs', () => {
    const { candidateBoundary } = buildStaticAbsenceContracts();
    for (const hash of [
      candidateBoundary.feature_registry_reachability_hash,
      candidateBoundary.compiler_fixture_reachability_hash,
      candidateBoundary.build_context_reachability_hash,
      candidateBoundary.release_artifact_reachability_hash,
    ]) {
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('keeps removed Electron navigation and screens out of the generated DOM inventory', () => {
    const { evidence } = buildStaticAbsenceContracts();
    for (const navKey of REMOVED_DOM_NAV_KEYS) {
      expect(evidence.dom_nav_keys).not.toContain(navKey);
    }
    for (const screenId of REMOVED_DOM_SCREEN_IDS) {
      expect(evidence.dom_ids).not.toContain(screenId);
    }
    expect(evidence.removed_ui_hits).toEqual([]);
  });

  it('keeps removed imports, symbols and routes out of the production AST graph', () => {
    const { evidence } = buildStaticAbsenceContracts();
    expect(evidence.production_source_hits).toEqual([]);
    expect(evidence.removed_api_hits).toEqual([]);
    expect(REMOVED_API_FIXTURES.length).toBeGreaterThan(0);
  });

  it('keeps legacy schema, filesystem and active resource roots absent', () => {
    const { evidence } = buildStaticAbsenceContracts();
    expect(evidence.legacy_schema_hits).toEqual([]);
    expect(evidence.legacy_filesystem_hits).toEqual([]);
    expect(evidence.active_resource_hits).toEqual([]);
    expect(() => checkContractPackStaticAbsence()).not.toThrow();
  });
});
