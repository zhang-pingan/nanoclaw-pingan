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
    role: 'g1_schema_11',
    path: '../store/schema/contract-pack-g1-executable-schema-v11.json',
    hash: 'sha256:2adb9376d341ad430155829647086bcc76f84ebf22dffac28c19d4026ea06ab2',
  },
  {
    role: 'r021_map_terminal_consumption',
    path: 'contract-pack-r021-map-terminal-consumption.json',
    hash: 'sha256:b5e9237d09d829946c496e19eddf16b21c94fb4fd59b3588900f4764332d0699',
  },
  {
    role: 'r022_domain_claim_handoff',
    path: 'contract-pack-r022-domain-claim-handoff.json',
    hash: 'sha256:ea97a3d52a2e4a14fb2671b2191b1b1cb6acc22c4ecded7db2e141a1716b516e',
  },
  {
    role: 'g2_v6_sealed_bundle',
    path: 'conformance/sealed/g2-generated-schema-join-authority-v6/golden-conformance-bundle@2.json',
    hash: 'sha256:5cf2d899d0bf8d7cc0d4b70cc7796a123b8b5384bbbefe3e204e70bddf33fe11',
  },
  {
    role: 'g3_6_retention_executor_abi',
    path: 'contract-pack-g3-retention-executor-abi-preflight.json',
    hash: 'sha256:3fa7afb5fa9294325004476ee230b896bc08fe8a6e6fe7f8c719c130e4c6911b',
  },
  {
    role: 'g3_7_workflow_publisher',
    path: 'contract-pack-g3-workflow-publisher.json',
    hash: 'sha256:7d51a4406c0f1e72ad195b7bb8ad8c3800dfc08761022d4ce15ce0fae4ec5560',
  },
  {
    role: 'g3_8a_frozen_activation_repair',
    path: 'contract-pack-g3.8a-activation-contract-repair.json',
    hash: 'sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f',
  },
  {
    role: 'g3_9_feature_release_activation',
    path: 'contract-pack-g3.9-feature-release-activation.json',
    hash: 'sha256:d8e9a00949477e58920de22324b1895578745438f3b6245fd42d6edb6b1fb867',
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
  const schema8 = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v8.sql',
    ),
  );
  const upgrade = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v7-to-v8.sql',
    ),
  );
  const schema9 = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v9.sql',
    ),
  );
  const schema8To9Upgrade = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v8-to-v9.sql',
    ),
  );
  const schema10 = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v10.sql',
    ),
  );
  const schema9To10Upgrade = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v9-to-v10.sql',
    ),
  );
  const schema11 = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v11.sql',
    ),
  );
  const schema10To11Upgrade = fs.readFileSync(
    path.join(
      repoRoot,
      'src/workflow-runtime/store/schema/migration/workflow-runtime-schema-v10-to-v11.sql',
    ),
  );
  if (
    rawSha256(schema8) !==
      'sha256:b19ebe83ea8b7c53a2ab54a901df092b4e343ee4e1d5772ed6bc3143a82746ad' ||
    rawSha256(upgrade) !==
      'sha256:544af9b55349268d152650c9a9fda5c399bb0e665750a2c47a6155d22ca6e3a9'
  ) {
    throw new Error('G4 successor Schema 8 migration identity drifted');
  }
  if (
    rawSha256(schema9) !==
      'sha256:4591e2dd417d439c813026816572e8a66e9d088efa6a8de88ebfb38a68cf9837' ||
    rawSha256(schema8To9Upgrade) !==
      'sha256:890c911a27074cca3ee34f9a7f022e4fbda6edf77fbe2ad75f2b77d0d1bed23b'
  ) {
    throw new Error('G4 successor Schema 9 migration identity drifted');
  }
  if (
    rawSha256(schema10) !==
      'sha256:269645a9f093dc35fd35a04336d71e38cc17b7168584752f9b9bdfc106f46fad' ||
    rawSha256(schema9To10Upgrade) !==
      'sha256:19c24f06558a3e98f1415468c4af8ce44e94afcad8be3428ebdc133bf4a353c5'
  ) {
    throw new Error('G4 successor Schema 10 migration identity drifted');
  }
  if (
    rawSha256(schema11) !==
      'sha256:ccaa7699894da98284b9ce86767d917e355441df93e010d90751ccb713c9b872' ||
    rawSha256(schema10To11Upgrade) !==
      'sha256:cb7c434266a62899323a03c83ee36fae01d3bf25ace4e81c82ea8f4ed1ded381'
  ) {
    throw new Error('G4 successor Schema 11 migration identity drifted');
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
        database_schema_version: 11,
        g1_root_hash:
          'sha256:2adb9376d341ad430155829647086bcc76f84ebf22dffac28c19d4026ea06ab2',
        database_schema_hash:
          'sha256:ad998b2d0bb5e5f158b0be6d13db79cb6a0c0650d5064b267262551af266189c',
        schema11_migration_hash:
          'sha256:ccaa7699894da98284b9ce86767d917e355441df93e010d90751ccb713c9b872',
        schema10_to_11_upgrade_hash:
          'sha256:cb7c434266a62899323a03c83ee36fae01d3bf25ace4e81c82ea8f4ed1ded381',
        schema10_migration_hash:
          'sha256:269645a9f093dc35fd35a04336d71e38cc17b7168584752f9b9bdfc106f46fad',
        schema9_to_10_upgrade_hash:
          'sha256:19c24f06558a3e98f1415468c4af8ce44e94afcad8be3428ebdc133bf4a353c5',
        schema9_migration_hash:
          'sha256:4591e2dd417d439c813026816572e8a66e9d088efa6a8de88ebfb38a68cf9837',
        schema8_to_9_upgrade_hash:
          'sha256:890c911a27074cca3ee34f9a7f022e4fbda6edf77fbe2ad75f2b77d0d1bed23b',
        schema8_migration_hash:
          'sha256:b19ebe83ea8b7c53a2ab54a901df092b4e343ee4e1d5772ed6bc3143a82746ad',
        schema7_to_8_upgrade_hash:
          'sha256:544af9b55349268d152650c9a9fda5c399bb0e665750a2c47a6155d22ca6e3a9',
      },
      upstreams: CURRENT_UPSTREAMS.map((entry) => ({ ...entry })),
      selection: {
        successor_is_current_machine_authority: true,
        bootstrap_runtime_selectable: false,
        activation_condition: 'independent_affected_chain_regression_required',
        registry_latest_lookup: 'forbidden',
        network_or_fallback: 'forbidden',
      },
      g5_status: 'IN_PROGRESS',
      g6_status: 'BLOCKED_PENDING_REGRESSION/NOT_STARTED',
      g7_through_g9_status: 'NOT_READY',
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
