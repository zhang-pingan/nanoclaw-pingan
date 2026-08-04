import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parse as parseYaml } from 'yaml';

const repositoryRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const archiveRoot = path.join(
  repositoryRoot,
  'docs/archive/dynamic-workflow-runtime-v1',
);
const acceptedCommit = '56a78b6dcede075c60d7e5b2049158824050410c';
const acceptedRelease =
  'sha256:3de887f1f822976631960aec663042ddd00ee5edb5db1dd50dc09a8bbcaca279';
const acceptedTask = '019fc76d-4aaf-71b1-9839-1d5a6fa21132';
const protectedHistoricalPathspecs = [
  '.nvmrc',
  'container/agent-runner/package-lock.json',
  'package-lock.json',
  'scripts/runtime-launcher.sh',
  'scripts/runtime-toolchain.sh',
  'src/workflow-runtime/capacity',
  'src/workflow-runtime/certification',
  'src/workflow-runtime/contracts/certification',
  ':(exclude,glob)src/workflow-runtime/contracts/certification/accepted-release-v1/**',
  'src/workflow-runtime/contracts/conformance',
  'src/workflow-runtime/projection',
  'src/workflow-runtime/registry',
  'src/workflow-runtime/runtime',
  ':(exclude)src/workflow-runtime/runtime/g5-test-bootstrap.ts',
  'src/workflow-runtime/store',
  ':(exclude)src/workflow-runtime/store/runtime-store/identity.ts',
  ':(exclude)src/workflow-runtime/store/runtime-store/index.ts',
  ':(exclude)src/workflow-runtime/store/runtime-store/check.ts',
  ':(exclude)src/workflow-runtime/store/runtime-store/runtime-store.test.ts',
  ':(exclude)src/workflow-runtime/store/registry-persistence.test.ts',
  ':(exclude)src/workflow-runtime/store/registry-resource-query.test.ts',
  ':(exclude)src/workflow-runtime/store/retention-executor-abi-preflight.test.ts',
];

const archivedDocuments = Object.freeze({
  'dynamic-workflow-dag-framework.md':
    'sha256:937344cc44a4f07917d51933c1aad04fc4e18fc98c3ad44d457a3b56ddea30ed',
  'dynamic-workflow-dag-framework-introduction.md':
    'sha256:c6e539651a2372890d3e14b2e891bc1587e913d943f599a6ffe25f162902320b',
  'dynamic-workflow-runtime-implementation-progress.md':
    'sha256:6052ba7357ca23e707bca1f10fe8f17dfacd5a434d051b6b781bc3f45c710338',
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
const defaultScriptRoots = new Set([
  'contracts:check',
  'format:check',
  'test',
  'test:current',
  'typecheck',
  'workflow-runtime:release:check',
]);
const retiredConstructionScripts = new Set([
  'archive:verify:v1',
  'contracts:archive:check',
  'contracts:generate',
  'contracts:gate-ownership:check',
  'contracts:g5:check',
  'contracts:g6:check',
  'contracts:g7:check',
  'contracts:g8:foundation:check',
  'contracts:g9:check',
  'contracts:r020:check',
  'contracts:r021:check',
  'contracts:r022:check',
  'test:g2:archive',
  'test:g5',
  'test:g5:blocker',
  'test:g5:readiness',
  'test:g6',
  'test:g6:readiness',
  'test:g7',
  'test:g8:validation',
  'test:g9:preactivation',
]);
const retiredConstructionSources = new Set([
  'src/workflow-runtime/contracts/g4-node-output-envelope-authority-successor.test.ts',
  'src/workflow-runtime/contracts/g5-basic-runtime-repair-contract.test.ts',
  'src/workflow-runtime/contracts/g5-capability-outbox-blocker.test.ts',
  'src/workflow-runtime/contracts/g5-capacity-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/contracts/g5-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/contracts/g6-dynamic-close-contract.test.ts',
  'src/workflow-runtime/contracts/g6-map-terminal-consumption-blocker.test.ts',
  'src/workflow-runtime/contracts/g6-required-child-claim-handoff-blocker.test.ts',
  'src/workflow-runtime/contracts/g6-runtime-readiness-audit.test.ts',
  'src/workflow-runtime/contracts/g7-control-projection-contract.test.ts',
  'src/workflow-runtime/contracts/g7-runtime-readiness-audit.test.ts',
]);

function fail(message) {
  throw new Error(`workflow_runtime_v1_archive_invalid: ${message}`);
}

function rawSha256(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function relativePath(absolute) {
  return path.relative(repositoryRoot, absolute).split(path.sep).join('/');
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

function assertRepositoryFile(candidate, label) {
  const absolute = path.resolve(candidate);
  if (!isInside(repositoryRoot, absolute)) fail(`${label} escapes repository`);
  if (!fs.existsSync(absolute)) fail(`${label} does not exist: ${absolute}`);
  let cursor = repositoryRoot;
  for (const component of path
    .relative(repositoryRoot, absolute)
    .split(path.sep)) {
    if (!component) continue;
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink())
      fail(`${label} traverses symbolic link: ${relativePath(cursor)}`);
  }
  const canonical = fs.realpathSync(absolute);
  if (!isInside(repositoryRoot, canonical))
    fail(`${label} resolves outside repository`);
  return canonical;
}

function walk(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink())
      fail(`repository scan encountered symlink: ${relativePath(absolute)}`);
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
    .map((relative) =>
      assertRepositoryFile(
        path.join(repositoryRoot, relative),
        'repository file',
      ),
    );
}

function markdownDestinations(markdown, document) {
  const destinations = [];
  for (let index = 0; index < markdown.length - 1; index += 1) {
    if (markdown[index] !== ']' || markdown[index + 1] !== '(') continue;
    let cursor = index + 2;
    while (/\s/.test(markdown[cursor] ?? '')) cursor += 1;
    let destination = '';
    if (markdown[cursor] === '<') {
      cursor += 1;
      const end = markdown.indexOf('>', cursor);
      if (end < 0) fail(`unterminated Markdown destination: ${document}`);
      destination = markdown.slice(cursor, end);
      cursor = end + 1;
    } else {
      let depth = 0;
      for (; cursor < markdown.length; cursor += 1) {
        const character = markdown[cursor];
        if (character === '\\' && cursor + 1 < markdown.length) {
          destination += markdown[cursor + 1];
          cursor += 1;
          continue;
        }
        if (character === '(') depth += 1;
        if (character === ')' && depth === 0) break;
        if (character === ')') depth -= 1;
        if (/\s/.test(character) && depth === 0) break;
        destination += character;
      }
    }
    if (destination) destinations.push(destination);
    index = cursor;
  }
  return destinations;
}

function localMarkdownTarget(document, destination) {
  if (destination.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(destination))
    return null;
  const withoutFragment = destination.split('#', 1)[0];
  if (!withoutFragment) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    fail(
      `invalid encoded Markdown destination: ${relativePath(document)} -> ${destination}`,
    );
  }
  if (decoded.includes('\\') || path.isAbsolute(decoded))
    fail(
      `unsafe Markdown destination: ${relativePath(document)} -> ${destination}`,
    );
  return assertRepositoryFile(
    path.resolve(path.dirname(document), decoded),
    `Markdown destination ${relativePath(document)} -> ${destination}`,
  );
}

function collectYamlRunCommands(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectYamlRunCommands(item, result);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'run' && typeof item === 'string') result.push(item);
      else collectYamlRunCommands(item, result);
    }
  }
  return result;
}

function scriptReferences(command) {
  const references = [];
  for (const match of command.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:._-]+)/g))
    references.push(match[1]);
  if (/\bnpm\s+test(?:\s|$)/.test(command)) references.push('test');
  return references;
}

function commandEntrypoints(command) {
  const files = [];
  for (const match of command.matchAll(
    /(?:^|[\s"'])(?:(\.\/)?)(src|setup|scripts)\/([A-Za-z0-9_@./*?-]+\.(?:cjs|js|json|mjs|ts|tsx))(?=$|[\s"'])/g,
  )) {
    const relative = `${match[2]}/${match[3]}`;
    if (!relative.includes('*') && !relative.includes('?'))
      files.push(relative);
  }
  return files;
}

function resolveSourceImport(containingFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const unresolved = path.resolve(path.dirname(containingFile), specifier);
  const candidates = [unresolved];
  const extension = path.extname(unresolved);
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    const base = unresolved.slice(0, -extension.length);
    candidates.push(`${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`);
  } else if (!extension) {
    candidates.push(
      `${unresolved}.ts`,
      `${unresolved}.tsx`,
      `${unresolved}.js`,
      path.join(unresolved, 'index.ts'),
      path.join(unresolved, 'index.tsx'),
      path.join(unresolved, 'index.js'),
    );
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return assertRepositoryFile(
        candidate,
        `source import from ${relativePath(containingFile)}`,
      );
  }
  return null;
}

function sourceDependencies(file) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const dependencies = [];
  const literals = [];
  const initializers = new Map();
  const functions = [];
  const calls = [];

  function callName(expression) {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return null;
  }

  function collect(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      initializers.set(node.name.text, node.initializer);
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.push(node);
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, collect);
  }
  collect(sourceFile);

  function valueParts(node, parameters = new Set(), seen = new Set()) {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (ts.isIdentifier(node)) {
      if (parameters.has(node.text)) return [`$parameter:${node.text}`];
      if (seen.has(node.text)) return [];
      const initializer = initializers.get(node.text);
      if (!initializer) return [];
      const nextSeen = new Set(seen);
      nextSeen.add(node.text);
      return valueParts(initializer, parameters, nextSeen);
    }
    if (ts.isParenthesizedExpression(node))
      return valueParts(node.expression, parameters, seen);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      return valueParts(node.expression, parameters, seen);
    if (ts.isBinaryExpression(node))
      return [
        ...valueParts(node.left, parameters, seen),
        ...valueParts(node.right, parameters, seen),
      ];
    if (ts.isTemplateExpression(node)) {
      return [
        node.head.text,
        ...node.templateSpans.flatMap((span) => [
          ...valueParts(span.expression, parameters, seen),
          span.literal.text,
        ]),
      ];
    }
    if (ts.isCallExpression(node))
      return node.arguments.flatMap((argument) =>
        valueParts(argument, parameters, seen),
      );
    return [];
  }

  const filesystemReadNames = new Set([
    'access',
    'accessSync',
    'createReadStream',
    'lstat',
    'lstatSync',
    'open',
    'openSync',
    'readFile',
    'readFileSync',
    'realpath',
    'realpathSync',
    'stat',
    'statSync',
  ]);
  const wrapperReadParameters = new Map();
  for (const declaration of functions) {
    const parameters = new Set(
      declaration.parameters
        .map((parameter) =>
          ts.isIdentifier(parameter.name) ? parameter.name.text : null,
        )
        .filter(Boolean),
    );
    const readParameters = new Set();
    function inspect(node) {
      if (
        ts.isCallExpression(node) &&
        filesystemReadNames.has(callName(node.expression))
      ) {
        for (const part of valueParts(node.arguments[0], parameters)) {
          if (part.startsWith('$parameter:'))
            readParameters.add(part.slice('$parameter:'.length));
        }
      }
      ts.forEachChild(node, inspect);
    }
    if (declaration.body) inspect(declaration.body);
    if (readParameters.size > 0)
      wrapperReadParameters.set(declaration.name.text, readParameters);
  }

  const archiveReads = [];
  function archiveReference(parts) {
    return parts.find(
      (part) =>
        part.includes('docs/archive/dynamic-workflow-runtime-v1') ||
        formerPaths.some((formerPath) => part.includes(formerPath)),
    );
  }
  for (const call of calls) {
    const name = callName(call.expression);
    if (!name) continue;
    if (filesystemReadNames.has(name)) {
      const reference = archiveReference(valueParts(call.arguments[0]));
      if (reference) archiveReads.push(`${name}:${reference}`);
      continue;
    }
    const readParameters = wrapperReadParameters.get(name);
    if (!readParameters) continue;
    const declaration = functions.find(
      (candidate) => candidate.name?.text === name,
    );
    if (!declaration) continue;
    declaration.parameters.forEach((parameter, index) => {
      if (
        ts.isIdentifier(parameter.name) &&
        readParameters.has(parameter.name.text)
      ) {
        const reference = archiveReference(valueParts(call.arguments[index]));
        if (reference) archiveReads.push(`${name}:${reference}`);
      }
    });
  }

  function visit(node) {
    if (ts.isStringLiteralLike(node)) literals.push(node.text);
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === 'require'))
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier) {
      const resolved = resolveSourceImport(file, specifier);
      if (resolved) dependencies.push(resolved);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { archiveReads, dependencies, literals };
}

for (const [name, expectedHash] of Object.entries(archivedDocuments)) {
  const former = path.join(repositoryRoot, 'local/docs', name);
  const archived = assertRepositoryFile(
    path.join(archiveRoot, name),
    `archive member ${name}`,
  );
  if (fs.existsSync(former)) fail(`former path still exists: ${former}`);
  if (!fs.statSync(archived).isFile()) fail(`archive member missing: ${name}`);
  const actualHash = rawSha256(archived);
  if (actualHash !== expectedHash)
    fail(`${name} raw hash ${actualHash} != ${expectedHash}`);
}

const protectedHistoryDiffs = execFileSync(
  'git',
  [
    'diff',
    '--name-only',
    acceptedCommit,
    '--',
    ...protectedHistoricalPathspecs,
  ],
  { cwd: repositoryRoot, encoding: 'utf8' },
)
  .trim()
  .split('\n')
  .filter(Boolean);
if (protectedHistoryDiffs.length > 0)
  fail(`protected history differs: ${protectedHistoryDiffs.join(', ')}`);

const currentIndexDocuments = [
  'docs/dynamic-workflow-runtime.md',
  'docs/archive/dynamic-workflow-runtime-v1/README.md',
  'src/workflow-runtime/contracts/README.md',
];
let checkedLinkCount = 0;
for (const relativeDocument of currentIndexDocuments) {
  const document = assertRepositoryFile(
    path.join(repositoryRoot, relativeDocument),
    `current index ${relativeDocument}`,
  );
  const markdown = fs.readFileSync(document, 'utf8');
  for (const destination of markdownDestinations(markdown, relativeDocument)) {
    if (localMarkdownTarget(document, destination)) checkedLinkCount += 1;
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
  '019fcaa1-8e1e-7420-b631-f010ca7425db',
  'S39 archive validation=`1`',
]) {
  if (!ledger.includes(required)) fail(`ledger closure missing: ${required}`);
}

const liveFormerReferences = [];
let historicalLiteralCount = 0;
const checkedRepositoryFiles = repositoryFiles();
for (const absolute of checkedRepositoryFiles) {
  if (!textExtensions.has(path.extname(absolute))) continue;
  const relative = relativePath(absolute);
  const text = fs.readFileSync(absolute, 'utf8');
  for (const formerPath of formerPaths) {
    if (!text.includes(formerPath)) continue;
    const historical =
      relative.startsWith('docs/archive/dynamic-workflow-runtime-v1/') ||
      relative.startsWith('src/workflow-runtime/contracts/conformance/');
    if (historical) historicalLiteralCount += 1;
    else liveFormerReferences.push(`${relative}:${formerPath}`);
  }
}
if (liveFormerReferences.length > 0)
  fail(`live former-path references: ${liveFormerReferences.join(', ')}`);

const packageJson = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const ciPath = path.join(repositoryRoot, '.github/workflows/ci.yml');
const ci = parseYaml(fs.readFileSync(ciPath, 'utf8'));
const ciCommands = collectYamlRunCommands(ci);
if (ci?.jobs?.ci?.['runs-on'] !== 'macos-14-xlarge')
  fail('default CI is not mapped to the required Darwin/arm64 profile');
for (const command of ciCommands) {
  if (
    /\bnpm\s+(?:ci|test|run)\b/.test(command) &&
    !/runtime-toolchain\.sh[^\n]*\bexec\s+--\s+npm\s/.test(command)
  ) {
    fail(`default CI bypasses the managed npm boundary: ${command}`);
  }
  for (const reference of scriptReferences(command))
    defaultScriptRoots.add(reference);
}

const reachableScripts = new Set();
const scriptEdges = [];
const defaultEntrypoints = new Set();
const scriptQueue = [...defaultScriptRoots];
const defaultArchiveReads = [];
const retiredConstructionReads = [];
while (scriptQueue.length > 0) {
  const name = scriptQueue.shift();
  if (reachableScripts.has(name)) continue;
  const command = packageJson.scripts?.[name];
  if (typeof command !== 'string') fail(`default script missing: ${name}`);
  reachableScripts.add(name);
  if (retiredConstructionScripts.has(name))
    retiredConstructionReads.push(`script:${name}`);
  if (
    command.includes('docs/archive/dynamic-workflow-runtime-v1') ||
    formerPaths.some((formerPath) => command.includes(formerPath))
  ) {
    defaultArchiveReads.push(`script:${name}`);
  }
  for (const dependency of scriptReferences(command)) {
    scriptEdges.push(`${name}->${dependency}`);
    scriptQueue.push(dependency);
  }
  for (const entrypoint of commandEntrypoints(command))
    defaultEntrypoints.add(entrypoint);
}

const reachableSources = new Set();
const sourceQueue = [...defaultEntrypoints].map((entrypoint) =>
  assertRepositoryFile(
    path.join(repositoryRoot, entrypoint),
    `default entrypoint ${entrypoint}`,
  ),
);
let sourceImportEdgeCount = 0;
let defaultArchiveLiteralCount = 0;
while (sourceQueue.length > 0) {
  const file = sourceQueue.shift();
  const relative = relativePath(file);
  if (reachableSources.has(relative)) continue;
  reachableSources.add(relative);
  if (isInside(archiveRoot, file))
    defaultArchiveReads.push(`source:${relative}`);
  if (retiredConstructionSources.has(relative))
    retiredConstructionReads.push(`source:${relative}`);
  if (!['.js', '.mjs', '.cjs', '.ts', '.tsx'].includes(path.extname(file)))
    continue;
  const { archiveReads, dependencies, literals } = sourceDependencies(file);
  for (const literal of literals) {
    if (
      literal.includes('docs/archive/dynamic-workflow-runtime-v1') ||
      formerPaths.some((formerPath) => literal.includes(formerPath))
    ) {
      defaultArchiveLiteralCount += 1;
    }
    for (const retired of retiredConstructionScripts) {
      if (literal.includes(`npm run ${retired}`))
        retiredConstructionReads.push(`literal:${relative}:${retired}`);
    }
  }
  for (const read of archiveReads)
    defaultArchiveReads.push(`source-read:${relative}:${read}`);
  for (const dependency of dependencies) {
    sourceImportEdgeCount += 1;
    sourceQueue.push(dependency);
  }
}

if (defaultArchiveReads.length > 0)
  fail(
    `default dependency graph reads archive: ${defaultArchiveReads.join(', ')}`,
  );
if (retiredConstructionReads.length > 0)
  fail(
    `default dependency graph reaches retired construction: ${retiredConstructionReads.join(', ')}`,
  );

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
let productionSourceCount = 0;
for (const relativeRoot of productionReadRoots) {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  const files = fs.statSync(absoluteRoot).isDirectory()
    ? walk(absoluteRoot)
    : [absoluteRoot];
  for (const file of files) {
    if (!textExtensions.has(path.extname(file))) continue;
    productionSourceCount += 1;
    const text = fs.readFileSync(file, 'utf8');
    if (
      text.includes('docs/archive/dynamic-workflow-runtime-v1') ||
      formerPaths.some((formerPath) => text.includes(formerPath))
    ) {
      fail(`production read references archive: ${relativePath(file)}`);
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
      checked_current_link_count: checkedLinkCount,
      checked_repository_file_count: checkedRepositoryFiles.length,
      historical_literal_count: historicalLiteralCount,
      live_former_reference_count: liveFormerReferences.length,
      default_script_root_count: defaultScriptRoots.size,
      default_script_count: reachableScripts.size,
      default_script_edge_count: scriptEdges.length,
      default_entrypoint_count: defaultEntrypoints.size,
      default_source_count: reachableSources.size,
      default_source_import_edge_count: sourceImportEdgeCount,
      default_archive_literal_count: defaultArchiveLiteralCount,
      default_archive_read_count: defaultArchiveReads.length,
      default_retired_construction_read_count: retiredConstructionReads.length,
      production_source_count: productionSourceCount,
      protected_history_diff_count: protectedHistoryDiffs.length,
    },
    null,
    2,
  )}\n`,
);
