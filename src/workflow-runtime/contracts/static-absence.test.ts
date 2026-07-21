import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import '../../channels/web.js';
import { getChannelFactory } from '../../channels/registry.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import {
  STATIC_ABSENCE_NEGATIVE_CASES,
  STATIC_ABSENCE_POSITIVE_CASES,
} from './static-absence-fixtures.js';
import {
  checkContractPackStaticAbsence,
  evaluateStaticAbsenceNegativeFixture,
  generateContractPackStaticAbsence,
} from './static-absence-pack.js';
import {
  assertIsolatedTestRoots,
  buildStaticAbsenceContracts,
  createIsolatedStaticGateTestRoots,
  STATIC_ABSENCE_REPO_ROOT,
} from './static-absence-source.js';
import {
  PROTECTED_CAPABILITY_FIXTURES,
  REMOVED_API_FIXTURES,
} from './static-absence-types.js';
import { strictParseJsonBytes } from './strict-json.js';

const contractsRoot = import.meta.dirname;

function readArtifact(relativePath: string) {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  );
}

async function requestWebStatus(
  pathname: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
): Promise<number> {
  const channel = getChannelFactory('web')?.({
    onMessage: () => {},
    onChatMetadata: () => {},
    registeredGroups: () => ({}),
  });
  if (!channel) throw new Error('web channel factory not registered');
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    writeHead(statusCode: number) {
      this.statusCode = statusCode;
      return this;
    },
    end: () => undefined,
  };
  await (
    channel as unknown as {
      handleHttp: (request: unknown, response: unknown) => Promise<void>;
    }
  ).handleHttp({ method, url: pathname, headers: {} }, response);
  return response.statusCode;
}

describe('G0.7 Static Absence and Surface Gates', () => {
  it('generates deterministically, keeps check read-only, and pins G0.2-G0.6 identities', () => {
    const trackedArtifacts = [
      'contract-pack-foundation.json',
      'contract-pack-closed-schemas.json',
      'contract-pack-catalog-protocols.json',
      'contract-pack-safety-sqlite.json',
      'contract-pack-logical-schema.json',
      'contract-pack-static-absence.json',
      'static/workflow-runtime-absence-baseline@1.json',
      'static/product-surface-coverage@1.json',
      'static/migration-candidate-boundary@1.json',
    ];
    const first = generateContractPackStaticAbsence();
    const firstBytes = new Map(
      trackedArtifacts.map((relativePath) => [
        relativePath,
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ]),
    );
    const second = generateContractPackStaticAbsence();
    expect(second.hash).toBe(first.hash);
    expect(checkContractPackStaticAbsence().hash).toBe(first.hash);
    expect(readArtifact('contract-pack-foundation.json').hash).toBe(
      'sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d',
    );
    expect(readArtifact('contract-pack-closed-schemas.json').hash).toBe(
      'sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8',
    );
    expect(readArtifact('contract-pack-catalog-protocols.json').hash).toBe(
      'sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607',
    );
    expect(readArtifact('contract-pack-safety-sqlite.json').hash).toBe(
      'sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428',
    );
    expect(readArtifact('contract-pack-logical-schema.json').hash).toBe(
      'sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520',
    );
    for (const [relativePath, bytes] of firstBytes) {
      expect(fs.readFileSync(path.join(contractsRoot, relativePath))).toEqual(
        bytes,
      );
    }
  });

  it('builds source, route, DOM, schema, filesystem and resource proof from inventories', () => {
    const { evidence, absenceBaseline } = buildStaticAbsenceContracts();
    expect(evidence.production_files.length).toBeGreaterThan(50);
    expect(evidence.production_import_edges.length).toBeGreaterThan(50);
    expect(evidence.production_source_hits).toEqual([]);
    expect(evidence.removed_api_hits).toEqual([]);
    expect(evidence.removed_ui_hits).toEqual([]);
    expect(evidence.legacy_schema_hits).toEqual([]);
    expect(evidence.legacy_filesystem_hits).toEqual([]);
    expect(evidence.active_resource_hits).toEqual([]);
    expect(evidence.configured_filesystem_roots).toEqual(['data', 'store']);
    expect(absenceBaseline.source_core_build_hash).toBe(
      evidence.source_core_build_hash,
    );
  });

  it.each(REMOVED_API_FIXTURES)(
    'returns an actual 404 for removed API $method $path',
    async ({ path: pathname, method }) => {
      expect(await requestWebStatus(pathname, method)).toBe(404);
    },
  );

  it('keeps every protected non-Workflow product capability present', () => {
    const { evidence, surfaceManifest } = buildStaticAbsenceContracts();
    expect(Object.keys(evidence.protected_fixture_hashes)).toEqual(
      PROTECTED_CAPABILITY_FIXTURES.map((fixture) => fixture.fixture_id).sort(),
    );
    const protectedSurfaceIds = new Set(
      surfaceManifest.entries
        .filter((entry) => entry.status === 'active')
        .map((entry) => entry.surface_id),
    );
    for (const fixture of PROTECTED_CAPABILITY_FIXTURES) {
      expect(protectedSurfaceIds.has(`protected.${fixture.fixture_id}`)).toBe(
        true,
      );
    }
  });

  it('enforces active/removed ProductSurfaceCoverage status contracts', () => {
    const { surfaceManifest } = buildStaticAbsenceContracts();
    expect(surfaceManifest.active_surface_count).toBe(12);
    expect(surfaceManifest.removed_surface_count).toBe(10);
    for (const entry of surfaceManifest.entries) {
      if (entry.status === 'active') {
        expect(entry.replacement_ref).not.toBeNull();
        expect(entry.contract_fixture_hash).not.toBeNull();
        expect(entry.removal_fixture_hash).toBeNull();
      } else {
        expect(entry.replacement_ref).toBeNull();
        expect(entry.contract_fixture_hash).toBeNull();
        expect(entry.removal_fixture_hash).not.toBeNull();
      }
    }
  });

  it('proves migration candidates are checksum-valid and unreachable without source scanning them', () => {
    const { evidence, candidateBoundary } = buildStaticAbsenceContracts();
    expect(candidateBoundary.candidate_root).toBe(
      'local/migration-candidates/',
    );
    expect(candidateBoundary.archived_file_count).toBe(16);
    expect(evidence.candidate_runtime_file_access_hits).toEqual([]);
    expect(evidence.candidate_scanned_content_file_count).toBe(0);
    expect(candidateBoundary.production_import_reachability_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(candidateBoundary.release_artifact_reachability_hash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('requires distinct temporary DATA_DIR and STORE_DIR outside production and candidate roots', () => {
    const roots = createIsolatedStaticGateTestRoots();
    try {
      expect(() =>
        assertIsolatedTestRoots(roots.dataRoot, roots.storeRoot),
      ).not.toThrow();
      expect(() =>
        assertIsolatedTestRoots(
          path.join(STATIC_ABSENCE_REPO_ROOT, 'data'),
          roots.storeRoot,
        ),
      ).toThrow(/test_root_not_isolated/);
      expect(() =>
        assertIsolatedTestRoots(
          path.join(
            STATIC_ABSENCE_REPO_ROOT,
            'local',
            'migration-candidates',
            'fixture',
          ),
          roots.storeRoot,
        ),
      ).toThrow(/test_root_not_isolated/);
    } finally {
      roots.cleanup();
    }
  });

  it('executes all positive and removed/candidate negative fixtures', () => {
    expect(STATIC_ABSENCE_POSITIVE_CASES).toHaveLength(10);
    expect(STATIC_ABSENCE_NEGATIVE_CASES).toHaveLength(30);
    for (const fixture of STATIC_ABSENCE_NEGATIVE_CASES) {
      expect(evaluateStaticAbsenceNegativeFixture(fixture)).toBe(
        fixture.expected_error,
      );
    }
  });

  it('keeps the G0.7 artifact free of sealed Golden, DDL, Store, Runtime, UI and certification claims', () => {
    const manifest = readArtifact('contract-pack-static-absence.json');
    expect(manifest.payload).toMatchObject({
      gate: 'G0.7',
      sqlite_profile_status: 'candidate',
      certification_status: 'not_certified',
      executable_ddl_status: 'absent',
      sqlite_runtime_execution_status: 'absent',
      candidate_content_source_scan_status: 'forbidden_and_zero',
    });
    for (const directory of ['conformance/sealed']) {
      expect(fs.readdirSync(path.join(contractsRoot, directory))).toEqual([
        '.gitkeep',
        'g2-production-compiler-replay-repair-v2',
        'g2-semantic-correction',
      ]);
    }
    expect(
      fs.existsSync(path.join(contractsRoot, '../store/runtime-store.ts')),
    ).toBe(false);
    const sqliteCandidate = readArtifact(
      'sqlite/local_single_user_sqlite@1.json',
    );
    expect(sqliteCandidate.payload.certification_status).toBe('candidate');
    expect(sqliteCandidate.payload.sqlite_version).toBeNull();
    expect(sqliteCandidate.payload.release_artifact_hash).toBeNull();
  });
});
