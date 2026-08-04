import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const archiveRoot = path.join(
  repositoryRoot,
  'docs/archive/dynamic-workflow-runtime-v1',
);
const acceptedCommit = '56a78b6dcede075c60d7e5b2049158824050410c';
const acceptedRelease =
  'sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279';
const acceptedTask = '019fc76d-4aaf-71b1-9839-1d5a6fa21132';
const protectedHistoricalPaths = [
  '.nvmrc',
  'container/agent-runner/package-lock.json',
  'dist',
  'package-lock.json',
  'scripts/runtime-launcher.sh',
  'scripts/runtime-toolchain.sh',
  'src/workflow-runtime/capacity',
  'src/workflow-runtime/certification',
  'src/workflow-runtime/contracts/certification',
  'src/workflow-runtime/contracts/conformance',
  'src/workflow-runtime/projection',
  'src/workflow-runtime/registry',
  'src/workflow-runtime/runtime',
  'src/workflow-runtime/store',
];

const archivedDocuments = Object.freeze({
  'dynamic-workflow-dag-framework.md':
    'sha256:937344cc44a4f07917d51933c1aad04fc4e18fc98c3ad44d457a3b56ddea30ed',
  'dynamic-workflow-dag-framework-introduction.md':
    'sha256:c6e539651a2372890d3e14b2e891bc1587e913d943f599a6ffe25f162902320b',
  'dynamic-workflow-runtime-implementation-progress.md':
    'sha256:0931fcf14639a90cb78ba1e8042790a18ff66ff5676806cea9f8f0ed85fd47a8',
  'dynamic-workflow-runtime-extended-certification-plan.md':
    'sha256:aac840fb176bf46470cc0ea4599b2c0d4d1937e9d304bb74774378168413e5d9',
  'pre-dynamic-workflow-runtime-cleanup-handoff.md':
    'sha256:780fe35b67124c1922be39673cd2761bbfdaae58bd9f925701e5f7fcc2783870',
  'pre-dynamic-workflow-runtime-cleanup-continuation-handoff.md':
    'sha256:f1f912bf673ab7b76a0e1918685378f5635376e9517676ae7baed0bd3c78f025',
});

const formerPaths = Object.keys(archivedDocuments).map((name) =>
  path.posix.join('local', 'docs', name),
);
const textExtensions = new Set([
  '.cjs',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);

function fail(message) {
  throw new Error(`workflow_runtime_v1_archive_invalid: ${message}`);
}

function rawSha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function walk(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...walk(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

function repositoryFiles() {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map((relative) => path.join(repositoryRoot, relative));
}

for (const [name, expectedHash] of Object.entries(archivedDocuments)) {
  const former = path.join(repositoryRoot, 'local/docs', name);
  const archived = path.join(archiveRoot, name);
  if (fs.existsSync(former)) fail(`former path still exists: ${former}`);
  if (!fs.statSync(archived).isFile()) fail(`archive member missing: ${name}`);
  const actualHash = rawSha256(archived);
  if (actualHash !== expectedHash)
    fail(`${name} raw hash ${actualHash} != ${expectedHash}`);
}

try {
  execFileSync(
    'git',
    ['diff', '--quiet', acceptedCommit, '--', ...protectedHistoricalPaths],
    { cwd: repositoryRoot },
  );
} catch {
  fail(`protected history differs from accepted commit ${acceptedCommit}`);
}

const currentIndexDocuments = [
  'docs/dynamic-workflow-runtime.md',
  'docs/archive/dynamic-workflow-runtime-v1/README.md',
  'src/workflow-runtime/contracts/README.md',
];
for (const required of currentIndexDocuments) {
  if (!fs.existsSync(path.join(repositoryRoot, required)))
    fail(`current index missing: ${required}`);
}

for (const relativeDocument of currentIndexDocuments) {
  const document = path.join(repositoryRoot, relativeDocument);
  const markdown = fs.readFileSync(document, 'utf8');
  for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(document), target);
    if (!fs.existsSync(resolved)) {
      fail(`broken current index link: ${relativeDocument} -> ${target}`);
    }
  }
}

const ledger = fs.readFileSync(
  path.join(archiveRoot, 'dynamic-workflow-runtime-implementation-progress.md'),
  'utf8',
);
for (const required of [
  'CONSTRUCTION_ARCHIVED / CLOSED_HISTORICAL_PROVENANCE',
  acceptedCommit,
  acceptedRelease,
  acceptedTask,
  'G9 Production Activation | `DONE`',
]) {
  if (!ledger.includes(required)) fail(`ledger closure missing: ${required}`);
}

const liveFormerReferences = [];
let historicalLiteralCount = 0;
for (const absolute of repositoryFiles()) {
  if (!textExtensions.has(path.extname(absolute))) continue;
  const relative = path
    .relative(repositoryRoot, absolute)
    .split(path.sep)
    .join('/');
  const text = fs.readFileSync(absolute, 'utf8');
  for (const formerPath of formerPaths) {
    if (!text.includes(formerPath)) continue;
    const historical =
      relative.startsWith('docs/archive/dynamic-workflow-runtime-v1/') ||
      relative.startsWith('src/workflow-runtime/contracts/conformance/') ||
      relative.startsWith('dist/');
    if (historical) historicalLiteralCount += 1;
    else liveFormerReferences.push(`${relative}:${formerPath}`);
  }
}
if (liveFormerReferences.length > 0)
  fail(`live former-path references: ${liveFormerReferences.join(', ')}`);

const packageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const ciWorkflow = fs.readFileSync(
  path.join(repositoryRoot, '.github/workflows/ci.yml'),
  'utf8',
);
if (
  ciWorkflow.includes('archive:verify') ||
  ciWorkflow.includes('docs/archive/dynamic-workflow-runtime-v1') ||
  formerPaths.some((formerPath) => ciWorkflow.includes(formerPath))
) {
  fail('default CI reads construction archive');
}
const defaultScripts = [
  'contracts:check',
  'test',
  'test:current',
  'test:g0',
  'test:g2',
  'test:g6:readiness',
  'test:workflow-runtime:certification',
  'workflow-runtime:release:check',
];
for (const name of defaultScripts) {
  const command = packageJson.scripts?.[name];
  if (typeof command !== 'string') fail(`default script missing: ${name}`);
  if (
    command.includes('archive:verify') ||
    command.includes('g0-conformance') ||
    command.includes('golden:working') ||
    command.includes('contract:g2:working') ||
    command.includes('contracts:r020') ||
    command.includes('contracts:r021') ||
    command.includes('contracts:r022') ||
    command.includes('contracts:g5:check') ||
    command.includes('contracts:g6:check') ||
    command.includes('contracts:g7:check') ||
    command.includes('contracts:g8:foundation:check') ||
    command.includes('contracts:g9:check') ||
    command.includes('test:g8:validation') ||
    command.includes('current-g2-static-child-replay-authority.test')
  ) {
    fail(`default script reads construction authority: ${name}`);
  }
}

const productionReadRoots = [
  'src/workflow-runtime/runtime',
  'src/workflow-runtime/compiler',
  'src/workflow-runtime/store',
  'src/workflow-runtime/registry',
  'src/workflow-runtime/projection',
  'src/workflow-runtime/capacity',
  'src/workflow-runtime/certification',
  'scripts/runtime-launcher.sh',
  'scripts/runtime-toolchain.sh',
];
for (const relativeRoot of productionReadRoots) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  const files = fs.statSync(absoluteRoot).isDirectory()
    ? walk(absoluteRoot)
    : [absoluteRoot];
  for (const file of files) {
    if (!textExtensions.has(path.extname(file))) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (
      text.includes('docs/archive/dynamic-workflow-runtime-v1') ||
      formerPaths.some((formerPath) => text.includes(formerPath))
    ) {
      fail(
        `production/default read references archive: ${path.relative(repositoryRoot, file)}`,
      );
    }
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      workflow_runtime_v1_archive: 'check:ok',
      construction_lifecycle: 'CONSTRUCTION_ARCHIVED',
      accepted_commit: acceptedCommit,
      accepted_release: acceptedRelease,
      document_count: Object.keys(archivedDocuments).length,
      historical_literal_count: historicalLiteralCount,
      live_former_reference_count: liveFormerReferences.length,
      default_archive_read_count: 0,
      protected_history_diff_count: 0,
    },
    null,
    2,
  )}\n`,
);
