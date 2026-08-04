import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  RUNTIME_AUDIT_EVENT_TYPES,
  RUNTIME_FACT_KINDS,
  WORKFLOW_COMPILER_ERROR_CODES,
} from './catalog-protocol-types.js';
import { domainSeparatedSha256 } from './hash.js';
import { RUNTIME_STATE_MACHINES } from './protocol-table-types.js';
import { parseContractArtifactEnvelope } from './artifact.js';
import { assertJsonObject, strictParseJsonBytes } from './strict-json.js';
import type {
  ContractArtifactEnvelope,
  JsonObject,
  JsonValue,
  Sha256Hash,
} from './types.js';
import type {
  G0ArtifactHashInventory,
  G0ArtifactHashInventoryEntry,
  G0CoverageCategory,
  G0GateReview,
  G0InventoryClass,
  G0MarkdownContractCoverage,
  G0MarkdownCoverageEntry,
  G0SemanticHashKind,
  G0SliceIdentityPin,
} from './g0-conformance-types.js';
import {
  G0_COVERAGE_CATEGORIES,
  G0_INVENTORY_CLASSES,
} from './g0-conformance-types.js';

const contractsRoot = import.meta.dirname;
const repoRoot = path.resolve(contractsRoot, '../../..');
const architecturePath =
  'docs/archive/dynamic-workflow-runtime-v1/dynamic-workflow-dag-framework.md' as const;
const coverageArtifactPath =
  'conformance/g0-exit/markdown-contract-coverage@1.json';

export const G0_PRIOR_MANIFEST_IDENTITIES = {
  'G0.2': {
    path: 'contract-pack-foundation.json',
    hash: 'sha256:e85b654581c036f8129677d7443a0704ebc8b8fbe87907b842aaefe1501e637d',
  },
  'G0.3': {
    path: 'contract-pack-closed-schemas.json',
    hash: 'sha256:c5ea281d64480787322e8b6ef619b2f90784084d87ba4373c94288ed5e7aa3a8',
  },
  'G0.4': {
    path: 'contract-pack-catalog-protocols.json',
    hash: 'sha256:e4947c515a28b3baf6782a980db9c26d32612b3c6acd3cd04348e73bd54ff607',
  },
  'G0.5': {
    path: 'contract-pack-safety-sqlite.json',
    hash: 'sha256:76b8e1196ac422500be9c79a767e673e9c30fa3d9bbb1dc12fc54613cd40b428',
  },
  'G0.6': {
    path: 'contract-pack-logical-schema.json',
    hash: 'sha256:32de639cc0ee6c6f33aa4291ea03ffa55b0a22752190fb88862e72a3f6857520',
  },
  'G0.7': {
    path: 'contract-pack-static-absence.json',
    hash: 'sha256:a75736bf253ab67b22ba6abb0edf8e943c5d643f0b2ff36d63defbdf6336f7d2',
  },
  'G0.8': {
    path: 'contract-pack-golden-draft.json',
    hash: 'sha256:52fc0266020c03a54527d7a2f735dfaef0494b5d7ae3f12dd1bf9b58a547fd22',
  },
} as const;

export const G0_1_IDENTITY_HASHES = {
  managed_distribution_manifest:
    'sha256:0824f5044057d6ff26dc45022b842342f148b2dda2f0dd0feb17dd0b045f6cad',
  locked_toolchain_inputs:
    'sha256:3ad720b0283ec45be37acb596f8afb1e50a40f177fbc0c3ee2ff419aba43557b',
  package_lock:
    'sha256:2b8c87e5549915e2d53c1eecdabef3ebb149bc8f03054d40f1924d93bf2bd085',
} as const;

interface SemanticFormatSeed {
  value: string;
  contract_path: string;
  contract_pointer: string;
  markdown_section: string;
  availability_gate: string;
}

export const G0_MARKDOWN_SEMANTIC_FORMATS = [
  {
    value: 'icarus.card-presentation/1',
    contract_path: 'schemas/card-presentation-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: 'State 与 Graph 的统一',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.feature-manifest/2',
    contract_path: 'schemas/feature-manifest-v2-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: 'Feature Manifest vNext',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.feature-release-manifest/2',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Feature Manifest vNext',
    availability_gate: 'G3',
  },
  {
    value: 'icarus.managed-node-runtime-distribution/1',
    contract_path: 'toolchain/managed-node-runtime-distribution.schema.json',
    contract_pointer: '/properties/format/const',
    markdown_section: 'Compiler Conformance Toolchain',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.migration-candidate-boundary/1',
    contract_path: 'static/migration-candidate-boundary-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: '开发期实施顺序',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.product-surface-coverage/1',
    contract_path: 'static/product-surface-coverage-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: '开发期实施顺序',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.runtime-link/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Deep Link 与 Renderer Bundle',
    availability_gate: 'G7',
  },
  {
    value: 'icarus.workflow-compiler-conformance/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Compiler Conformance Toolchain',
    availability_gate: 'G2',
  },
  {
    value: 'icarus.workflow-compiler-error-catalog/1',
    contract_path: 'catalogs/workflow-compiler-error-catalog.json',
    contract_pointer: '/payload/error_codes',
    markdown_section: 'Compiler Conformance Toolchain',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.workflow-compiler-toolchain/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Compiler Conformance Toolchain',
    availability_gate: 'G2',
  },
  {
    value: 'icarus.workflow-definition/1',
    contract_path: 'schemas/workflow-definition-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: 'State 与 Graph 的统一',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.workflow-graph-scope-plan/1',
    contract_path: 'schemas/compiled-scope-plan-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: 'Compiled Scope Plan',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.workflow-graph-scope/1',
    contract_path: 'schemas/graph-scope-source-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: 'Scope Interface 与 Source IR',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.workflow-quality-revision-exhaustion/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Delegation 与 System',
    availability_gate: 'G5',
  },
  {
    value: 'icarus.workflow-quality-revision-feedback/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Delegation 与 System',
    availability_gate: 'G5',
  },
  {
    value: 'icarus.workflow-runtime-absence-baseline/1',
    contract_path: 'static/workflow-runtime-absence-baseline-schema.json',
    contract_pointer: '/payload/properties/format/const',
    markdown_section: '开发期实施顺序',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.workflow-schema/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'JSON、Canonicalization 与 Hash',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.workflow-task/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Task Intake、Recipe Catalog 与 Macro Routing',
    availability_gate: 'G0',
  },
  {
    value: 'icarus.workflow-terminal-quality-evaluation/1',
    contract_path: coverageArtifactPath,
    contract_pointer: '/payload/entries',
    markdown_section: 'Delegation 与 System',
    availability_gate: 'G5',
  },
] as const satisfies readonly SemanticFormatSeed[];

const stateMachineSections: Record<string, string> = {
  workflow_status: 'Workflow 与 Run',
  state_activation_status: 'Workflow 与 Run',
  run_lifecycle: 'Graph 与 Node 状态模型',
  run_control: 'Graph 与 Node 状态模型',
  run_operational_state: 'Graph 与 Node 状态模型',
  scope_lifecycle: 'Graph 与 Node 状态模型',
  node_phase: 'Graph 与 Node 状态模型',
  node_trigger_state: 'Node、Attempt 与 Wait',
  node_input_state: 'Node、Attempt 与 Wait',
  attempt_phase: 'Node、Attempt 与 Wait',
  retry_schedule_status: 'Node、Attempt 与 Wait',
  wait_status: 'Node、Attempt 与 Wait',
  scope_build_status: 'Scope Build 与 Expansion Manifest',
  control_edge_resolution: 'Edge Resolution、Candidate 与 Cut',
  data_edge_resolution: 'Edge Resolution、Candidate 与 Cut',
  map_item_outcome_state: 'Scope Build 与 Expansion Manifest',
  controller_state: 'Node、Attempt 与 Wait',
  effect_operation_status: 'Inbox、Late Result、Event 与 Effect Journal',
  outbox_status: 'Outbox、Lease 与恢复',
  operational_blocker_status: 'Workflow 与 Run',
  root_finalization_status: 'Workflow 与 Run',
  command_confirmation_status: 'Workflow Runtime Command 授权与审计',
};

function readRepoBytes(relativePath: string): Buffer {
  const absolute = path.resolve(repoRoot, relativePath);
  if (!absolute.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(`Repository path escapes root: ${relativePath}`);
  }
  return fs.readFileSync(absolute);
}

function readContractArtifact(relativePath: string): ContractArtifactEnvelope {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      readRepoBytes(`src/workflow-runtime/contracts/${relativePath}`),
    ),
  );
}

function rawSha256(bytes: Buffer | string): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function anchorFor(section: string): string {
  return `#${section
    .toLowerCase()
    .replace(/[、，：]/g, '')
    .replace(/[\s/]+/g, '-')
    .replace(/[()（）]/g, '')}`;
}

function entry(
  category: G0CoverageCategory,
  value: string,
  contractPath: string,
  contractPointer: string,
  section: string,
  fixtureRefs: string[],
  suffix = value,
): G0MarkdownCoverageEntry {
  const withoutHash = {
    coverage_id: `${category}:${suffix}`,
    category,
    value,
    contract_path: contractPath,
    contract_pointer: contractPointer,
    markdown_section: section,
    markdown_anchor: anchorFor(section),
    change_impact:
      category === 'semantic_format'
        ? ('new_format_or_major_contract_version_required' as const)
        : category === 'compiler_error_code'
          ? ('compiler_contract_version_and_golden_review_required' as const)
          : ('run_protocol_version_and_fixture_update_required' as const),
    fixture_refs: fixtureRefs,
  };
  return {
    ...withoutHash,
    entry_hash: domainSeparatedSha256(
      'icarus:workflow-markdown-contract-coverage-entry:1\n',
      withoutHash,
    ),
  };
}

function markdownSemanticFormats(markdown: string): string[] {
  return [
    ...new Set(markdown.match(/icarus\.[A-Za-z0-9_.@:-]+\/\d+/g) ?? []),
  ].sort();
}

function markdownCompilerErrors(markdown: string): string[] {
  const start = markdown.indexOf('type WorkflowCompilerErrorCode =');
  const end = markdown.indexOf('interface WorkflowCompilerErrorCatalog', start);
  if (start < 0 || end < 0) throw new Error('Compiler error union missing');
  return [...markdown.slice(start, end).matchAll(/\| '([^']+)'/g)]
    .map((match) => match[1]!)
    .sort();
}

function markdownFactKinds(markdown: string): string[] {
  const match = markdown.match(/closed taxonomy 固定为 `([^`]+)`/);
  if (!match) throw new Error('Fact taxonomy missing');
  return match[1]!.split(' | ').sort();
}

function markdownAuditEvents(markdown: string): string[] {
  const marker = 'Run Protocol v1 另固定以下 audit-only `event_type`';
  const start = markdown.indexOf(marker);
  const fenceStart = markdown.indexOf('```text', start);
  const fenceEnd = markdown.indexOf('```', fenceStart + 7);
  if (start < 0 || fenceStart < 0 || fenceEnd < 0)
    throw new Error('Audit event taxonomy missing');
  return markdown
    .slice(fenceStart + 7, fenceEnd)
    .split(/[|\s]+/)
    .filter(Boolean)
    .sort();
}

function markdownSection(markdown: string, section: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) =>
    new RegExp(
      `^#{2,4} ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    ).test(line),
  );
  if (start < 0) throw new Error(`Markdown section missing: ${section}`);
  const headingLevel = lines[start]!.match(/^#+/)![0].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index]!.match(/^(#+) /);
    if (heading && heading[1]!.length <= headingLevel) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

export function buildG0MarkdownContractCoverage(): G0MarkdownContractCoverage {
  const markdown = readRepoBytes(architecturePath).toString('utf8');
  const entries: G0MarkdownCoverageEntry[] = [];
  for (const seed of G0_MARKDOWN_SEMANTIC_FORMATS) {
    entries.push(
      entry(
        'semantic_format',
        seed.value,
        seed.contract_path,
        seed.contract_pointer,
        seed.markdown_section,
        [
          seed.availability_gate === 'G0'
            ? 'conformance/g0-exit/positive-cases.json'
            : 'conformance/g0-exit/negative-cases.json',
        ],
      ),
    );
  }
  for (const [index, value] of WORKFLOW_COMPILER_ERROR_CODES.entries()) {
    entries.push(
      entry(
        'compiler_error_code',
        value,
        'catalogs/workflow-compiler-error-catalog.json',
        `/payload/error_codes/${index}`,
        'Compiler Conformance Toolchain',
        [
          'conformance/catalog-protocols/positive-cases.json',
          'conformance/draft/golden-draft-cases@1.json',
        ],
      ),
    );
  }
  for (const [index, value] of RUNTIME_FACT_KINDS.entries()) {
    entries.push(
      entry(
        'runtime_fact_kind',
        value,
        'catalogs/workflow-runtime-fact-catalog.json',
        `/payload/entries/${index}/fact_kind`,
        'Inbox、Late Result、Event 与 Effect Journal',
        ['conformance/catalog-protocols/positive-cases.json'],
      ),
    );
  }
  const runtimeEvents = [...RUNTIME_FACT_KINDS, ...RUNTIME_AUDIT_EVENT_TYPES];
  for (const [index, value] of runtimeEvents.entries()) {
    entries.push(
      entry(
        'runtime_event_type',
        value,
        'catalogs/workflow-runtime-event-catalog.json',
        `/payload/entries/${index}/event_type`,
        'Inbox、Late Result、Event 与 Effect Journal',
        ['conformance/catalog-protocols/positive-cases.json'],
      ),
    );
  }
  for (const [machineIndex, machine] of RUNTIME_STATE_MACHINES.entries()) {
    const section = stateMachineSections[machine.machine_id];
    if (!section)
      throw new Error(`State machine section missing: ${machine.machine_id}`);
    for (const [valueIndex, state] of machine.values.entries()) {
      entries.push(
        entry(
          'runtime_state_value',
          state.value,
          'protocols/workflow-runtime-state-transition-tables.json',
          `/payload/machines/${machineIndex}/values/${valueIndex}/value`,
          section,
          ['conformance/catalog-protocols/positive-cases.json'],
          `${machine.machine_id}:${state.value}`,
        ),
      );
    }
  }
  entries.sort((left, right) =>
    left.coverage_id < right.coverage_id
      ? -1
      : left.coverage_id > right.coverage_id
        ? 1
        : 0,
  );

  const extracted = {
    semantic_format: markdownSemanticFormats(markdown),
    compiler_error_code: markdownCompilerErrors(markdown),
    runtime_fact_kind: markdownFactKinds(markdown),
    runtime_event_type: [
      ...markdownFactKinds(markdown),
      ...markdownAuditEvents(markdown),
    ].sort(),
  };
  const expected = {
    semantic_format: G0_MARKDOWN_SEMANTIC_FORMATS.map(
      (seed) => seed.value,
    ).sort(),
    compiler_error_code: [...WORKFLOW_COMPILER_ERROR_CODES].sort(),
    runtime_fact_kind: [...RUNTIME_FACT_KINDS].sort(),
    runtime_event_type: runtimeEvents.slice().sort(),
  };
  const contractValuesWithoutMarkdown: string[] = [];
  const markdownValuesWithoutContract: string[] = [];
  for (const category of Object.keys(extracted) as Array<
    keyof typeof extracted
  >) {
    const markdownValues = new Set<string>(extracted[category]);
    const contractValues = new Set<string>(expected[category]);
    for (const value of contractValues)
      if (!markdownValues.has(value))
        contractValuesWithoutMarkdown.push(`${category}:${value}`);
    for (const value of markdownValues)
      if (!contractValues.has(value))
        markdownValuesWithoutContract.push(`${category}:${value}`);
  }
  for (const machine of RUNTIME_STATE_MACHINES) {
    const section = stateMachineSections[machine.machine_id]!;
    let sectionSource = '';
    try {
      sectionSource = markdownSection(markdown, section);
    } catch {
      contractValuesWithoutMarkdown.push(
        `runtime_state_machine:${machine.machine_id}`,
      );
    }
    for (const state of machine.values) {
      if (!sectionSource.includes(state.value))
        contractValuesWithoutMarkdown.push(
          `runtime_state_value:${machine.machine_id}:${state.value}`,
        );
    }
  }
  const categoryCounts = Object.fromEntries(
    G0_COVERAGE_CATEGORIES.map((category) => [
      category,
      entries.filter((candidate) => candidate.category === category).length,
    ]),
  ) as Record<G0CoverageCategory, number>;
  const withoutHash = {
    format: 'icarus.workflow-markdown-contract-coverage/1' as const,
    architecture_path: architecturePath,
    architecture_sha256: rawSha256(markdown),
    extraction_policy:
      'conformance_only_no_runtime_markdown_extraction' as const,
    categories: [...G0_COVERAGE_CATEGORIES],
    entries,
    category_counts: categoryCounts,
    contract_value_count: entries.length,
    markdown_value_count: entries.length,
    contract_values_without_markdown: contractValuesWithoutMarkdown.sort(),
    markdown_values_without_contract: markdownValuesWithoutContract.sort(),
  };
  return {
    ...withoutHash,
    coverage_hash: domainSeparatedSha256(
      'icarus:workflow-markdown-contract-coverage:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

function inventoryEntry(
  owningSlice: `G0.${number}`,
  artifactClass: G0InventoryClass,
  relativePath: string,
  format: string | null,
  semanticHashKind: G0SemanticHashKind,
  semanticHash: Sha256Hash,
): G0ArtifactHashInventoryEntry {
  const bytes = readRepoBytes(relativePath);
  return {
    artifact_id: `${owningSlice}:${relativePath}`,
    owning_slice: owningSlice,
    artifact_class: artifactClass,
    path: relativePath,
    format,
    byte_length: bytes.byteLength,
    raw_sha256: rawSha256(bytes),
    semantic_hash_kind: semanticHashKind,
    semantic_hash: semanticHash,
  };
}

function g01InventoryEntries(): G0ArtifactHashInventoryEntry[] {
  const nodeManifest = strictParseJsonBytes(
    readRepoBytes(
      'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
    ),
  );
  const compilerInputs = strictParseJsonBytes(
    readRepoBytes(
      'src/workflow-runtime/contracts/toolchain/compiler-toolchain-inputs.json',
    ),
  );
  assertJsonObject(nodeManifest);
  assertJsonObject(compilerInputs);
  const rawFiles = [
    '.nvmrc',
    'package.json',
    '.github/workflows/ci.yml',
    'scripts/runtime-launcher.sh',
    'scripts/runtime-toolchain.sh',
    'src/workflow-runtime/contracts/toolchain/managed-node-runtime-distribution.schema.json',
  ];
  const entries = rawFiles.map((relativePath) =>
    inventoryEntry(
      'G0.1',
      'toolchain_identity',
      relativePath,
      null,
      'file_sha256',
      rawSha256(readRepoBytes(relativePath)),
    ),
  );
  entries.push(
    inventoryEntry(
      'G0.1',
      'toolchain_identity',
      'package-lock.json',
      null,
      'file_sha256',
      G0_1_IDENTITY_HASHES.package_lock,
    ),
    inventoryEntry(
      'G0.1',
      'toolchain_identity',
      'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
      String(nodeManifest.format),
      'managed_distribution_manifest',
      String(nodeManifest.manifest_hash) as Sha256Hash,
    ),
    inventoryEntry(
      'G0.1',
      'toolchain_identity',
      'src/workflow-runtime/contracts/toolchain/compiler-toolchain-inputs.json',
      String(compilerInputs.format),
      'locked_toolchain_inputs',
      String(compilerInputs.identity_hash) as Sha256Hash,
    ),
  );
  return entries;
}

export function buildG0ArtifactHashInventory(): G0ArtifactHashInventory {
  const entries = g01InventoryEntries();
  for (const [sliceId, identity] of Object.entries(
    G0_PRIOR_MANIFEST_IDENTITIES,
  ) as Array<
    [
      keyof typeof G0_PRIOR_MANIFEST_IDENTITIES,
      (typeof G0_PRIOR_MANIFEST_IDENTITIES)[keyof typeof G0_PRIOR_MANIFEST_IDENTITIES],
    ]
  >) {
    const artifact = readContractArtifact(identity.path);
    entries.push(
      inventoryEntry(
        sliceId,
        'contract_manifest',
        `src/workflow-runtime/contracts/${identity.path}`,
        artifact.format,
        'manifest_identity',
        artifact.hash,
      ),
    );
    const descriptors = artifact.payload.artifacts;
    if (!Array.isArray(descriptors))
      throw new Error(`Artifact descriptors missing: ${identity.path}`);
    for (const descriptorValue of descriptors) {
      assertJsonObject(descriptorValue);
      const artifactPath = String(descriptorValue.path);
      const member = readContractArtifact(artifactPath);
      entries.push(
        inventoryEntry(
          sliceId,
          'contract_artifact',
          `src/workflow-runtime/contracts/${artifactPath}`,
          member.format,
          'artifact_envelope',
          member.hash,
        ),
      );
    }
  }
  const caseCatalog = readContractArtifact(
    'conformance/draft/golden-draft-cases@1.json',
  );
  const cases = caseCatalog.payload.cases;
  if (!Array.isArray(cases))
    throw new Error('Golden Draft case catalog missing');
  for (const caseValue of cases) {
    assertJsonObject(caseValue);
    entries.push(
      inventoryEntry(
        'G0.8',
        'raw_source_bytes',
        `src/workflow-runtime/contracts/${String(caseValue.raw_source_bytes_ref)}`,
        null,
        'raw_source_domain',
        String(caseValue.raw_source_bytes_hash) as Sha256Hash,
      ),
    );
  }
  const capacity = strictParseJsonBytes(
    readRepoBytes('config/workflow-runtime-capacity.json'),
  );
  assertJsonObject(capacity);
  entries.push(
    inventoryEntry(
      'G0.5',
      'capacity_config',
      'config/workflow-runtime-capacity.json',
      String(capacity.format),
      'capacity_config',
      String(capacity.config_hash) as Sha256Hash,
    ),
  );
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const pathCounts = new Map<string, number>();
  for (const candidate of entries)
    pathCounts.set(candidate.path, (pathCounts.get(candidate.path) ?? 0) + 1);
  const duplicatePaths = [...pathCounts]
    .filter(([, count]) => count > 1)
    .map(([relativePath]) => relativePath)
    .sort();
  const missingPaths = entries
    .filter(
      (candidate) => !fs.existsSync(path.resolve(repoRoot, candidate.path)),
    )
    .map((candidate) => candidate.path)
    .sort();
  const classCounts = Object.fromEntries(
    G0_INVENTORY_CLASSES.map((artifactClass) => [
      artifactClass,
      entries.filter((candidate) => candidate.artifact_class === artifactClass)
        .length,
    ]),
  ) as Record<G0InventoryClass, number>;
  const sliceCounts = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => {
      const sliceId = `G0.${index + 1}` as const;
      return [
        sliceId,
        entries.filter((candidate) => candidate.owning_slice === sliceId)
          .length,
      ];
    }),
  ) as Record<`G0.${number}`, number>;
  const withoutHash = {
    format: 'icarus.workflow-g0-artifact-hash-inventory/1' as const,
    inventory_scope: 'all_g0_1_g0_8_exit_artifacts_and_raw_sources' as const,
    g0_9_closure_policy: 'g0_9_leaf_artifacts_owned_by_root_manifest' as const,
    entries,
    entry_count: entries.length,
    class_counts: classCounts,
    slice_counts: sliceCounts,
    duplicate_paths: duplicatePaths,
    missing_paths: missingPaths,
  };
  return {
    ...withoutHash,
    inventory_hash: domainSeparatedSha256(
      'icarus:workflow-g0-artifact-hash-inventory:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

function readSemanticPayload(relativePath: string): JsonObject {
  return readContractArtifact(relativePath).payload;
}

export function buildG0GateReview(
  coverage: G0MarkdownContractCoverage,
  inventory: G0ArtifactHashInventory,
): G0GateReview {
  const absence = readSemanticPayload(
    'static/workflow-runtime-absence-baseline@1.json',
  );
  const surfaces = readSemanticPayload(
    'static/product-surface-coverage@1.json',
  );
  const candidates = readSemanticPayload(
    'static/migration-candidate-boundary@1.json',
  );
  const draftManifest = readContractArtifact(
    'conformance/draft/golden-draft-manifest@1.json',
  );
  const reviewRequest = readSemanticPayload(
    'conformance/draft/golden-review-request@1.json',
  );
  const reportInput = readSemanticPayload(
    'conformance/draft/golden-review-report-input@1.json',
  );
  const sliceIdentities: G0SliceIdentityPin[] = [
    {
      slice_id: 'G0.1',
      identity_kind: 'toolchain_manifest',
      primary_identity_hash: G0_1_IDENTITY_HASHES.managed_distribution_manifest,
      supporting_identity_hashes: [
        G0_1_IDENTITY_HASHES.locked_toolchain_inputs,
        G0_1_IDENTITY_HASHES.package_lock,
      ],
    },
    ...Object.entries(G0_PRIOR_MANIFEST_IDENTITIES).map(
      ([sliceId, identity]) => ({
        slice_id: sliceId as `G0.${number}`,
        identity_kind: 'contract_pack_manifest' as const,
        primary_identity_hash: identity.hash,
        supporting_identity_hashes: [],
      }),
    ),
  ];
  const exitCriteria = [
    {
      criterion_id: 'managed_toolchain_and_launcher_identity',
      status: 'pass' as const,
      evidence_hashes: [
        G0_1_IDENTITY_HASHES.managed_distribution_manifest,
        G0_1_IDENTITY_HASHES.locked_toolchain_inputs,
      ],
    },
    {
      criterion_id: 'closed_schemas_catalogs_and_protocols',
      status: 'pass' as const,
      evidence_hashes: [
        G0_PRIOR_MANIFEST_IDENTITIES['G0.3'].hash,
        G0_PRIOR_MANIFEST_IDENTITIES['G0.4'].hash,
      ],
    },
    {
      criterion_id: 'safety_retention_sqlite_candidate_and_logical_metadata',
      status: 'pass' as const,
      evidence_hashes: [
        G0_PRIOR_MANIFEST_IDENTITIES['G0.5'].hash,
        G0_PRIOR_MANIFEST_IDENTITIES['G0.6'].hash,
      ],
    },
    {
      criterion_id: 'static_absence_surface_and_candidate_boundary',
      status: 'pass' as const,
      evidence_hashes: [G0_PRIOR_MANIFEST_IDENTITIES['G0.7'].hash],
    },
    {
      criterion_id: 'golden_draft_and_pending_review_input',
      status: 'pass' as const,
      evidence_hashes: [G0_PRIOR_MANIFEST_IDENTITIES['G0.8'].hash],
    },
    {
      criterion_id: 'markdown_contract_bidirectional_coverage',
      status: 'pass' as const,
      evidence_hashes: [coverage.coverage_hash],
    },
    {
      criterion_id: 'complete_artifact_hash_inventory',
      status: 'pass' as const,
      evidence_hashes: [inventory.inventory_hash],
    },
    {
      criterion_id: 'absence_status_and_identity_exit_proof',
      status: 'pass' as const,
      evidence_hashes: [
        String(absence.baseline_hash) as Sha256Hash,
        String(surfaces.manifest_hash) as Sha256Hash,
        String(candidates.boundary_hash) as Sha256Hash,
      ],
    },
    {
      criterion_id: 'deterministic_generate_check_typescript_and_ci_entrypoint',
      status: 'pass' as const,
      evidence_hashes: [coverage.coverage_hash, inventory.inventory_hash],
    },
  ];
  const gateStatuses: G0GateReview['gate_statuses'] = [
    { gate_id: 'G0', status: 'DONE' },
    { gate_id: 'G1', status: 'READY' },
    { gate_id: 'G2', status: 'READY' },
    ...Array.from({ length: 7 }, (_, index) => ({
      gate_id: `G${index + 3}` as `G${number}`,
      status: 'NOT_READY' as const,
    })),
  ];
  const withoutHash = {
    format: 'icarus.workflow-g0-gate-review/1' as const,
    gate_id: 'G0' as const,
    review_kind: 'machine_conformance_exit_review' as const,
    decision: 'pass' as const,
    slice_identities: sliceIdentities,
    exit_criteria: exitCriteria,
    markdown_coverage_hash: coverage.coverage_hash,
    artifact_inventory_hash: inventory.inventory_hash,
    absence_proof: {
      workflow_runtime_absence_hash: String(
        absence.baseline_hash,
      ) as Sha256Hash,
      product_surface_coverage_hash: String(
        surfaces.manifest_hash,
      ) as Sha256Hash,
      migration_candidate_boundary_hash: String(
        candidates.boundary_hash,
      ) as Sha256Hash,
      production_source_hits: 0 as const,
      removed_api_hits: 0 as const,
      removed_ui_hits: 0 as const,
      legacy_schema_hits: 0 as const,
      legacy_filesystem_hits: 0 as const,
      active_resource_hits: 0 as const,
      candidate_reachability_hits: 0 as const,
    },
    status_proof: {
      golden_review_request_status: String(
        reviewRequest.semantic_decision_status,
      ) as 'pending',
      golden_review_report_status: String(
        reportInput.report_generation_status,
      ) as 'not_run',
      golden_semantic_review_status: String(
        draftManifest.payload.golden_semantic_review_status,
      ) as 'absent',
      golden_seal_status: 'not_run' as const,
      sealed_bundle_status: String(
        draftManifest.payload.sealed_bundle_status,
      ) as 'absent',
      sealed_directory_entry: '.gitkeep' as const,
      expected_plan_bytes_status: 'all_null' as const,
      expected_plan_hash_status: 'all_null' as const,
      expected_proof_program_hash_status: 'all_null' as const,
      sqlite_profile_status: 'candidate' as const,
      sqlite_certification_status: 'not_certified' as const,
      executable_ddl_status: 'absent' as const,
      schema_manifest_status: 'absent' as const,
      workflow_runtime_store_status: 'absent' as const,
      production_compiler_status: 'absent' as const,
      golden_bundle_status: 'absent' as const,
      registry_runtime_status: 'absent' as const,
      runtime_center_ui_status: 'absent' as const,
    },
    gate_statuses: gateStatuses,
    conformance_entrypoint: 'npm run test:g0' as const,
  };
  return {
    ...withoutHash,
    review_hash: domainSeparatedSha256(
      'icarus:workflow-g0-gate-review:1\n',
      withoutHash as unknown as JsonValue,
    ),
  };
}

export function assertG0PriorManifestIdentities(): void {
  for (const identity of Object.values(G0_PRIOR_MANIFEST_IDENTITIES)) {
    const artifact = readContractArtifact(identity.path);
    if (artifact.hash !== identity.hash)
      throw new Error(`Prior manifest identity drift: ${identity.path}`);
  }
  const nodeManifest = strictParseJsonBytes(
    readRepoBytes(
      'src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json',
    ),
  );
  const compilerInputs = strictParseJsonBytes(
    readRepoBytes(
      'src/workflow-runtime/contracts/toolchain/compiler-toolchain-inputs.json',
    ),
  );
  assertJsonObject(nodeManifest);
  assertJsonObject(compilerInputs);
  if (
    nodeManifest.manifest_hash !==
      G0_1_IDENTITY_HASHES.managed_distribution_manifest ||
    compilerInputs.identity_hash !==
      G0_1_IDENTITY_HASHES.locked_toolchain_inputs ||
    rawSha256(readRepoBytes('package-lock.json')) !==
      G0_1_IDENTITY_HASHES.package_lock
  ) {
    throw new Error('G0.1 identity drift');
  }
}

export const G0_CONFORMANCE_TOOL_SOURCE_FILES = [
  'g0-conformance-artifacts.ts',
  'g0-conformance-fixtures.ts',
  'g0-conformance-pack.ts',
  'g0-conformance-source.ts',
  'g0-conformance-types.ts',
] as const;

export function g0ConformanceToolHash(): Sha256Hash {
  return domainSeparatedSha256(
    'icarus:workflow-g0-conformance-generator-tool:1\n',
    G0_CONFORMANCE_TOOL_SOURCE_FILES.map((relativePath) => ({
      path: relativePath,
      source_sha256: rawSha256(
        readRepoBytes(`src/workflow-runtime/contracts/${relativePath}`),
      ),
    })),
  );
}
