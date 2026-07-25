import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseContractArtifactEnvelope } from './artifact.js';
import { calculateArtifactHash, parseSha256Hash } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  Sha256Hash,
} from './types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');

export const G4_NODE_OUTPUT_ENVELOPE_SUCCESSOR_PATH =
  'contract-pack-g4-node-output-envelope-authority-successor.json';

const PREDECESSOR_PACK_PATH = 'contract-pack-g4-test-bootstrap.json';
const PREDECESSOR_PACK_RAW_HASH =
  'sha256:1760da21231d46a323caf43ab5936ba90fbe378bf978e4a638caeefcd95082c7';
const PREDECESSOR_MEMBER_RAW_TREE_HASH =
  'sha256:d4ad1ff6e3f08cbaa5e9b54f1342213d9612dd03078bdcd21abf1870c28f7bf2';
const PREDECESSOR_PACK_HASH =
  'sha256:bd7b944c66181e05add3618e6355a1acc64ff452dc4c027d4556c776a4402046';
const PREDECESSOR_PROFILE_HASH =
  'sha256:87956027bca69d9fcdb1891298dc2a083a9e413c4530d7aff71473b74a58c106';
const PREDECESSOR_IMPLEMENTATION_ARTIFACT_HASH =
  'sha256:4ced1df4314038474b41c19b313531b25bc31671969529caa33876f18d448275';
const PREDECESSOR_IMPLEMENTATION_HASH =
  'sha256:1a04adf90718c7ad7f53caf93fd2a02ca00857e86ab96bfcf81ae137aef1a552';

const DOMAIN =
  'icarus:workflow-g4-node-output-envelope-authority-successor:1\n';

const CURRENT_UPSTREAMS = [
  {
    role: 'r019_node_output_envelope_authority',
    path: 'conformance/generated-schema-join-authority-repair/contract-pack-generated-schema-join-authority-repair.json',
    hash: 'sha256:7a852ff21a77a767b708ab8a4fc5c329024ca954422b26d71210b0385ce05441',
  },
  {
    role: 'g1_schema_7',
    path: '../store/schema/contract-pack-g1-executable-schema.json',
    hash: 'sha256:b60e3c7fe91d1cfab341d487102c7bff13ad73a320444b45fb6ea71d8b914306',
  },
  {
    role: 'g2_v6_sealed_bundle',
    path: 'conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json',
    hash: 'sha256:0e5ea012864bce2dae7d0435e700b78b6d3299703f896c737677d24f46d8f78f',
  },
  {
    role: 'g3_6_retention_executor_abi',
    path: 'contract-pack-g3-retention-executor-abi-preflight.json',
    hash: 'sha256:0b1079429b4fa65ffdad1061a0e664ae2a08b6c692645067787b051031c49337',
  },
  {
    role: 'g3_7_workflow_publisher',
    path: 'contract-pack-g3-workflow-publisher.json',
    hash: 'sha256:bc0c536a09f8bd79cffa5da78add54747c7a6f075e58ab0bfc93f0d13ce363b1',
  },
  {
    role: 'g3_8a_frozen_activation_repair',
    path: 'contract-pack-g3.8a-activation-contract-repair.json',
    hash: 'sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f',
  },
  {
    role: 'g3_9_feature_release_activation',
    path: 'contract-pack-g3.9-feature-release-activation.json',
    hash: 'sha256:5ab7b3b322b4bad4a08e56569b79f4b9ec3ecd8b8240c013b5992a8d16eb5593',
  },
] as const;

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readArtifact(relativePath: string): ContractArtifactEnvelope {
  const root = relativePath.startsWith('../') ? contractsRoot : contractsRoot;
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(path.resolve(root, relativePath))),
  );
}

function assertHistoricalG4(): void {
  const packBytes = fs.readFileSync(path.join(contractsRoot, PREDECESSOR_PACK_PATH));
  if (rawSha256(packBytes) !== PREDECESSOR_PACK_RAW_HASH) {
    throw new Error('Historical G4 Contract Pack raw bytes drifted');
  }
  const pack = parseContractArtifactEnvelope(strictParseJsonBytes(packBytes));
  if (pack.hash !== PREDECESSOR_PACK_HASH) {
    throw new Error('Historical G4 Contract Pack identity drifted');
  }
  const artifacts = pack.payload.artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== 14) {
    throw new Error('Historical G4 artifact inventory drifted');
  }
  const tree = crypto.createHash('sha256');
  const sorted = [...artifacts].sort((left, right) => {
    const leftPath = String((left as JsonObject).path);
    const rightPath = String((right as JsonObject).path);
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  for (const value of sorted) {
    const entry = value as JsonObject;
    const artifactPath = String(entry.path);
    const bytes = fs.readFileSync(path.join(contractsRoot, artifactPath));
    const rawHash = rawSha256(bytes);
    const artifact = parseContractArtifactEnvelope(strictParseJsonBytes(bytes));
    if (artifact.hash !== entry.hash) {
      throw new Error(`Historical G4 artifact identity drifted: ${artifactPath}`);
    }
    tree.update(artifactPath, 'utf8').update('\0').update(rawHash, 'ascii').update('\n');
  }
  if (`sha256:${tree.digest('hex')}` !== PREDECESSOR_MEMBER_RAW_TREE_HASH) {
    throw new Error('Historical G4 member raw-byte tree drifted');
  }

  const profile = readArtifact('bootstrap/workflow-test-bootstrap-profile@1.json');
  const implementation = readArtifact(
    'bootstrap/workflow-test-bootstrap-implementation@1.json',
  );
  if (
    profile.hash !== PREDECESSOR_PROFILE_HASH ||
    implementation.hash !== PREDECESSOR_IMPLEMENTATION_ARTIFACT_HASH ||
    implementation.payload.implementation_hash !== PREDECESSOR_IMPLEMENTATION_HASH
  ) {
    throw new Error('Historical G4 profile or implementation identity drifted');
  }
  const sourceFiles = implementation.payload.source_files;
  if (!Array.isArray(sourceFiles) || sourceFiles.length !== 4) {
    throw new Error('Historical G4 implementation source inventory drifted');
  }
  for (const value of sourceFiles) {
    const entry = value as JsonObject;
    const sourcePath = String(entry.path);
    if (rawSha256(fs.readFileSync(path.join(repoRoot, sourcePath))) !== entry.raw_sha256) {
      throw new Error(`Historical G4 bootstrap source drifted: ${sourcePath}`);
    }
  }
}

function assertCurrentUpstreams(): void {
  for (const upstream of CURRENT_UPSTREAMS) {
    const artifact = readArtifact(upstream.path);
    if (artifact.hash !== upstream.hash) {
      throw new Error(`G4 successor upstream identity drifted: ${upstream.role}`);
    }
  }
  const schema7 = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v7.sql',
    ),
  );
  const upgrade = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v6-to-v7.sql',
    ),
  );
  if (
    rawSha256(schema7) !==
      'sha256:b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497' ||
    rawSha256(upgrade) !==
      'sha256:225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062'
  ) {
    throw new Error('G4 successor Schema 7 migration identity drifted');
  }
}

function buildSuccessor(): ContractArtifactEnvelope {
  assertHistoricalG4();
  assertCurrentUpstreams();
  const artifact: ContractArtifactEnvelope = {
    format: 'icarus.workflow-g4-node-output-envelope-authority-successor/1',
    ref: {
      id: 'icarus.workflow-g4-node-output-envelope-authority-successor',
      version: '1.0.0',
    },
    version: 1,
    domain_separator: DOMAIN,
    payload: {
      gate: 'G4',
      status:
        'NODE_OUTPUT_ENVELOPE_SCHEMA_AUTHORITY_REPAIR_EXIT_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      current_closure: 'REOPENED_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
      predecessor: {
        path: PREDECESSOR_PACK_PATH,
        raw_sha256: PREDECESSOR_PACK_RAW_HASH,
        artifact_hash: PREDECESSOR_PACK_HASH,
        member_count: 14,
        member_raw_tree_hash: PREDECESSOR_MEMBER_RAW_TREE_HASH,
        profile_hash: PREDECESSOR_PROFILE_HASH,
        implementation_artifact_hash: PREDECESSOR_IMPLEMENTATION_ARTIFACT_HASH,
        implementation_hash: PREDECESSOR_IMPLEMENTATION_HASH,
        disposition: 'frozen_historical_authority',
      },
      current_store: {
        database_schema_version: 7,
        g1_root_hash:
          'sha256:b60e3c7fe91d1cfab341d487102c7bff13ad73a320444b45fb6ea71d8b914306',
        database_schema_hash:
          'sha256:27a212831d2abd8898eb8becbfd714d96b1bfb15d818d471cfc58fdc36196e65',
        schema7_migration_hash:
          'sha256:b4307930cedd9e0b8acbec599a2b3b29cb18f78840a726532b108459a4df2497',
        schema6_to_7_upgrade_hash:
          'sha256:225c5f148347dc42ca086bfb0bf7db957d13eb1be502f155465e20ee66010062',
      },
      upstreams: CURRENT_UPSTREAMS.map((entry) => ({ ...entry })),
      selection: {
        successor_is_current_machine_authority: true,
        bootstrap_runtime_selectable: false,
        activation_condition: 'independent_affected_chain_regression_required',
        registry_latest_lookup: 'forbidden',
        network_or_fallback: 'forbidden',
      },
      g5_status: 'BLOCKED_BY_SPEC/NOT_READY',
      g6_through_g9_status: 'NOT_READY',
      runtime_construction_performed: false,
      production_authorization: false,
    },
    hash: '' as Sha256Hash,
  };
  artifact.hash = calculateArtifactHash(artifact);
  return artifact;
}

function render(value: ContractArtifactEnvelope): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function targetPath(): string {
  return path.join(contractsRoot, G4_NODE_OUTPUT_ENVELOPE_SUCCESSOR_PATH);
}

export function generateG4NodeOutputEnvelopeAuthoritySuccessor(): ContractArtifactEnvelope {
  const artifact = buildSuccessor();
  const target = targetPath();
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, render(artifact), 'utf8');
  fs.renameSync(temporary, target);
  return artifact;
}

export function checkG4NodeOutputEnvelopeAuthoritySuccessor(): ContractArtifactEnvelope {
  const expected = buildSuccessor();
  const actual = parseContractArtifactEnvelope(
    strictParseJsonBytes(fs.readFileSync(targetPath())),
  );
  if (fs.readFileSync(targetPath(), 'utf8') !== render(expected)) {
    throw new Error('G4 NodeOutputEnvelope authority successor bytes drifted');
  }
  if (actual.hash !== expected.hash) {
    throw new Error('G4 NodeOutputEnvelope authority successor identity drifted');
  }
  return expected;
}

export function g4HistoricalAuthorityHashesForTest(): Readonly<{
  packRaw: Sha256Hash;
  memberRawTree: Sha256Hash;
}> {
  return {
    packRaw: parseSha256Hash(PREDECESSOR_PACK_RAW_HASH),
    memberRawTree: parseSha256Hash(PREDECESSOR_MEMBER_RAW_TREE_HASH),
  };
}
