import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { strictParseJsonBytes } from './strict-json.js';
import type { JsonObject, JsonValue } from './types.js';

export const G4_BOOTSTRAP_SOURCE_ROOT = 'src/workflow-runtime/bootstrap';

export const G4_BOOTSTRAP_SOURCE_PATHS = [
  'src/workflow-runtime/bootstrap/fake-adapter.ts',
  'src/workflow-runtime/bootstrap/index.ts',
  'src/workflow-runtime/bootstrap/test-bootstrap.ts',
  'src/workflow-runtime/bootstrap/virtual-clock.ts',
] as const;

const SOURCE_ROOTS = [
  'src',
  'electron',
  'assistant',
  'features',
  'setup',
  'scripts',
] as const;

const SOURCE_EXTENSIONS = [
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
] as const;

const IMPORT_FORMS = [
  'static_import',
  'static_export_from',
  'literal_require',
  'literal_dynamic_import',
] as const;

const HOST_CONFIGURATION_EXTENSIONS = [
  '.html',
  '.json',
  '.plist',
  '.sh',
  '.yaml',
  '.yml',
] as const;

const G4_AUTHORITY_SOURCE_PREFIXES = [
  `${G4_BOOTSTRAP_SOURCE_ROOT}/`,
  'src/workflow-runtime/contracts/g4-test-bootstrap-',
] as const;

const G4_AUTHORITY_CONFIGURATION_PATHS = [
  'src/workflow-runtime/contracts/bootstrap/workflow-test-bootstrap-profile-schema@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-fake-adapter-invocation-schema@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-fake-adapter-result-schema@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-bootstrap-isolation-receipt-schema@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-bootstrap-fixture-set@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-fake-adapter-profile@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-virtual-clock-profile@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-bootstrap-implementation@1.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-bootstrap-isolation-boundary@2.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-bootstrap-profile@1.json',
  'src/workflow-runtime/contracts/conformance/g4-test-bootstrap/positive-cases.json',
  'src/workflow-runtime/contracts/conformance/g4-test-bootstrap/negative-cases.json',
  'src/workflow-runtime/contracts/conformance/g4-test-bootstrap/fault-cases.json',
  'src/workflow-runtime/contracts/bootstrap/workflow-test-bootstrap-domain-separators@1.json',
  'src/workflow-runtime/contracts/contract-pack-g4-test-bootstrap.json',
] as const;

const FORBIDDEN_REFERENCE_MARKERS = [
  'workflow-runtime/bootstrap',
  'g4-test-bootstrap',
  'workflow-test-bootstrap-profile',
] as const;

const PRODUCTION_PACKAGE_FIELDS = ['main', 'bin', 'exports', 'config'] as const;

const PRODUCTION_SCRIPT_NAMES = [
  'start',
  'default',
  'serve',
  'dev',
  'dev:*',
  'build',
  'build:*',
  'package',
  'package:*',
  'setup',
  'auth',
] as const;

const KNOWN_HOST_ENTRYPOINTS = [
  'src/index.ts',
  'electron/main.ts',
  'electron/preload.ts',
  'assistant/main.ts',
  'assistant/preload.ts',
  'setup/index.ts',
] as const;

const INGRESS_RULES = {
  feature: ['src/features/**', 'features/**'],
  api: ['**/*api.{ts,tsx,js,mjs,cjs}', 'src/channels/web.ts'],
  automation: ['**/*automation*.{ts,tsx,js,mjs,cjs}', '**/task-scheduler.ts'],
  host: [
    'src/index.ts',
    'electron/**',
    'assistant/**',
    'setup/**',
    'scripts/**',
  ],
} as const;

type G4IngressSurface =
  | 'production'
  | 'feature'
  | 'api'
  | 'automation'
  | 'host';

export interface G4IsolationViolation {
  readonly kind:
    | 'bootstrap_source_inventory_drift'
    | 'authority_import_reachable'
    | 'authority_reference_selected'
    | 'production_package_reference';
  readonly surface: G4IngressSurface;
  readonly source: string;
  readonly detail: string;
  readonly path: readonly string[];
}

export interface G4IsolationAnalysis {
  readonly source_files: readonly string[];
  readonly production_entrypoints: readonly string[];
  readonly authority_source_files: readonly string[];
  readonly bootstrap_source_files: readonly string[];
  readonly violations: readonly G4IsolationViolation[];
}

export class G4IsolationContractError extends Error {
  readonly code = 'g4_test_bootstrap_isolation_failed';

  constructor(message: string) {
    super(message);
    this.name = 'G4IsolationContractError';
  }
}

const analysisCache = new Map<
  string,
  { state: string; analysis: G4IsolationAnalysis }
>();

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(asciiCompare);
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function isTestSource(relativePath: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

function isGeneratedDirectory(name: string): boolean {
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === 'dist' ||
    name === 'dist-electron' ||
    name === 'dist-assistant' ||
    name === 'release'
  );
}

function collectSourceFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isGeneratedDirectory(entry.name)) visit(absolute);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.includes(
          path.extname(entry.name) as (typeof SOURCE_EXTENSIONS)[number],
        )
      ) {
        files.push(normalizeRelative(path.relative(repoRoot, absolute)));
      }
    }
  };
  for (const root of SOURCE_ROOTS) visit(path.join(repoRoot, root));
  return uniqueSorted(files);
}

function collectHostConfigurationFiles(repoRoot: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isGeneratedDirectory(entry.name)) visit(absolute);
      } else if (
        entry.isFile() &&
        HOST_CONFIGURATION_EXTENSIONS.includes(
          path.extname(
            entry.name,
          ) as (typeof HOST_CONFIGURATION_EXTENSIONS)[number],
        )
      ) {
        files.push(normalizeRelative(path.relative(repoRoot, absolute)));
      }
    }
  };
  for (const root of SOURCE_ROOTS) {
    visit(path.join(repoRoot, root));
  }
  if (fs.existsSync(path.join(repoRoot, 'tsconfig.json'))) {
    files.push('tsconfig.json');
  }
  return uniqueSorted(files);
}

function scriptKind(relativePath: string): ts.ScriptKind {
  switch (path.extname(relativePath)) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function collectModuleSpecifiersAndStrings(sourceFile: ts.SourceFile): {
  moduleSpecifiers: string[];
  stringLiterals: string[];
} {
  const moduleSpecifiers: string[] = [];
  const stringLiterals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) stringLiterals.push(node.text);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      moduleSpecifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) &&
        node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      moduleSpecifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    moduleSpecifiers: uniqueSorted(moduleSpecifiers),
    stringLiterals: uniqueSorted(stringLiterals),
  };
}

function resolveInternalImport(
  repoRoot: string,
  from: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
  compilerOptions: ts.CompilerOptions,
): string | null {
  let base: string | null = null;
  if (specifier.startsWith('.')) {
    base = normalizeRelative(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(from), specifier),
      ),
    );
  } else if (SOURCE_ROOTS.some((root) => specifier.startsWith(`${root}/`))) {
    base = normalizeRelative(specifier);
  }
  if (base !== null) {
    const withoutRuntimeExtension = base.replace(/\.(?:c|m)?js$/, '');
    const candidates = uniqueSorted([
      base,
      withoutRuntimeExtension,
      ...SOURCE_EXTENSIONS.map(
        (extension) => `${withoutRuntimeExtension}${extension}`,
      ),
      ...SOURCE_EXTENSIONS.map(
        (extension) => `${withoutRuntimeExtension}/index${extension}`,
      ),
    ]);
    const local = candidates.find((candidate) => knownFiles.has(candidate));
    if (local) return local;
  }
  const resolved = ts.resolveModuleName(
    specifier,
    path.join(repoRoot, from),
    compilerOptions,
    ts.sys,
  ).resolvedModule?.resolvedFileName;
  if (!resolved) return null;
  const relative = normalizeRelative(path.relative(repoRoot, resolved));
  return knownFiles.has(relative) ? relative : null;
}

function isG4AuthoritySource(relativePath: string): boolean {
  return G4_AUTHORITY_SOURCE_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix),
  );
}

function isG4AuthorityConfiguration(relativePath: string): boolean {
  return G4_AUTHORITY_CONFIGURATION_PATHS.includes(
    relativePath as (typeof G4_AUTHORITY_CONFIGURATION_PATHS)[number],
  );
}

function forbiddenReference(value: string): string | null {
  return (
    FORBIDDEN_REFERENCE_MARKERS.find((marker) => value.includes(marker)) ?? null
  );
}

function ingressSurface(relativePath: string): G4IngressSurface {
  if (
    relativePath.startsWith('src/features/') ||
    relativePath.startsWith('features/')
  ) {
    return 'feature';
  }
  if (
    /(?:^|\/)[^/]*api\.[cm]?[jt]sx?$/.test(relativePath) ||
    relativePath === 'src/channels/web.ts'
  ) {
    return 'api';
  }
  if (
    /automation/i.test(relativePath) ||
    relativePath.endsWith('/task-scheduler.ts')
  ) {
    return 'automation';
  }
  if (
    relativePath === 'src/index.ts' ||
    /^(?:electron|assistant|setup|scripts)\//.test(relativePath)
  ) {
    return 'host';
  }
  return 'production';
}

function findAuthorityPath(
  start: string,
  imports: ReadonlyMap<string, readonly string[]>,
  authorityFiles: ReadonlySet<string>,
): string[] | null {
  const queue: string[][] = [[start]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const currentPath = queue.shift()!;
    const current = currentPath[currentPath.length - 1];
    if (visited.has(current)) continue;
    visited.add(current);
    if (current !== start && authorityFiles.has(current)) return currentPath;
    for (const dependency of imports.get(current) ?? []) {
      if (!visited.has(dependency)) queue.push([...currentPath, dependency]);
    }
  }
  return null;
}

function collectJsonStrings(
  value: JsonValue,
  pointer: string,
  output: Array<{ pointer: string; value: string }>,
): void {
  if (typeof value === 'string') {
    output.push({ pointer, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectJsonStrings(entry, `${pointer}/${index}`, output),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    collectJsonStrings(entry, `${pointer}/${key}`, output);
  }
}

function isProductionScript(scriptName: string): boolean {
  return PRODUCTION_SCRIPT_NAMES.some((rule) =>
    rule.endsWith(':*')
      ? scriptName.startsWith(rule.slice(0, -1))
      : scriptName === rule,
  );
}

function packageReferenceViolations(repoRoot: string): G4IsolationViolation[] {
  const packagePath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new G4IsolationContractError('G4 isolation requires package.json');
  }
  const packageValue = strictParseJsonBytes(
    fs.readFileSync(packagePath),
  ) as JsonObject;
  const inspected: Array<{ pointer: string; value: string }> = [];
  for (const field of PRODUCTION_PACKAGE_FIELDS) {
    if (packageValue[field] !== undefined) {
      collectJsonStrings(
        packageValue[field] as JsonValue,
        `/${field}`,
        inspected,
      );
    }
  }
  const scripts = packageValue.scripts;
  if (
    scripts !== null &&
    typeof scripts === 'object' &&
    !Array.isArray(scripts)
  ) {
    for (const [scriptName, script] of Object.entries(scripts)) {
      if (isProductionScript(scriptName)) {
        collectJsonStrings(
          script as JsonValue,
          `/scripts/${scriptName}`,
          inspected,
        );
      }
    }
  }
  return inspected.flatMap(({ pointer, value }) => {
    const marker = forbiddenReference(value);
    return marker
      ? [
          {
            kind: 'production_package_reference' as const,
            surface: 'host' as const,
            source: `package.json${pointer}`,
            detail: marker,
            path: ['package.json'],
          },
        ]
      : [];
  });
}

function hostConfigurationViolations(
  repoRoot: string,
  files: readonly string[],
): G4IsolationViolation[] {
  return files.flatMap((relativePath) => {
    if (isG4AuthorityConfiguration(relativePath)) return [];
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    const marker = forbiddenReference(source);
    return marker
      ? [
          {
            kind: 'authority_reference_selected' as const,
            surface: relativePath.startsWith('features/')
              ? ('feature' as const)
              : ('host' as const),
            source: relativePath,
            detail: marker,
            path: [relativePath],
          },
        ]
      : [];
  });
}

function loadCompilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  if (!fs.existsSync(configPath)) return {};
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    throw new G4IsolationContractError(
      `G4 isolation cannot parse tsconfig.json: ${loaded.error.code}`,
    );
  }
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, repoRoot).options;
}

function deriveProductionEntrypoints(
  repoRoot: string,
  knownFiles: ReadonlySet<string>,
): string[] {
  const entries = new Set<string>(
    KNOWN_HOST_ENTRYPOINTS.filter((entry) => knownFiles.has(entry)),
  );
  const packageValue = strictParseJsonBytes(
    fs.readFileSync(path.join(repoRoot, 'package.json')),
  ) as JsonObject;
  if (typeof packageValue.main === 'string') {
    const candidate = normalizeRelative(
      packageValue.main.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'),
    );
    if (knownFiles.has(candidate)) entries.add(candidate);
  }
  for (const file of knownFiles) {
    if (ingressSurface(file) !== 'production' && !isG4AuthoritySource(file)) {
      entries.add(file);
    }
  }
  return uniqueSorted(entries);
}

function bootstrapInventoryViolation(
  actual: readonly string[],
): G4IsolationViolation[] {
  const expected = [...G4_BOOTSTRAP_SOURCE_PATHS].sort(asciiCompare);
  if (actual.join('\n') === expected.join('\n')) return [];
  const expectedSet = new Set<string>(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((entry) => !actualSet.has(entry));
  const undeclared = actual.filter((entry) => !expectedSet.has(entry));
  return [
    {
      kind: 'bootstrap_source_inventory_drift',
      surface: 'production',
      source: G4_BOOTSTRAP_SOURCE_ROOT,
      detail: `missing=${missing.join(',') || 'none'};undeclared=${undeclared.join(',') || 'none'}`,
      path: [G4_BOOTSTRAP_SOURCE_ROOT],
    },
  ];
}

export function analyzeG4TestBootstrapIsolation(
  repoRoot: string,
): G4IsolationAnalysis {
  const sourceFiles = collectSourceFiles(repoRoot).filter(
    (file) => !isTestSource(file),
  );
  const hostConfigurationFiles = collectHostConfigurationFiles(repoRoot);
  const stateHash = crypto.createHash('sha256');
  for (const relativePath of uniqueSorted([
    ...sourceFiles,
    ...hostConfigurationFiles,
    'package.json',
  ])) {
    stateHash.update(relativePath).update('\0');
    stateHash.update(fs.readFileSync(path.join(repoRoot, relativePath)));
    stateHash.update('\0');
  }
  const state = stateHash.digest('hex');
  const cached = analysisCache.get(repoRoot);
  if (cached?.state === state) return cached.analysis;
  const knownSourceFiles = new Set(sourceFiles);
  const knownModuleFiles = new Set([...sourceFiles, ...hostConfigurationFiles]);
  const compilerOptions = loadCompilerOptions(repoRoot);
  const authoritySourceFiles = sourceFiles.filter(isG4AuthoritySource);
  const authorityFiles = new Set([
    ...authoritySourceFiles,
    ...hostConfigurationFiles.filter(isG4AuthorityConfiguration),
  ]);
  const bootstrapFiles = sourceFiles.filter((file) =>
    file.startsWith(`${G4_BOOTSTRAP_SOURCE_ROOT}/`),
  );
  const imports = new Map<string, string[]>();
  const moduleSpecifiers = new Map<string, string[]>();
  const stringLiterals = new Map<string, string[]>();

  for (const relativePath of sourceFiles) {
    const sourceFile = ts.createSourceFile(
      relativePath,
      fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(relativePath),
    );
    const facts = collectModuleSpecifiersAndStrings(sourceFile);
    moduleSpecifiers.set(relativePath, facts.moduleSpecifiers);
    stringLiterals.set(relativePath, facts.stringLiterals);
    imports.set(
      relativePath,
      uniqueSorted(
        facts.moduleSpecifiers
          .map((specifier) =>
            resolveInternalImport(
              repoRoot,
              relativePath,
              specifier,
              knownModuleFiles,
              compilerOptions,
            ),
          )
          .filter((candidate): candidate is string => candidate !== null),
      ),
    );
  }

  const violations: G4IsolationViolation[] = [
    ...bootstrapInventoryViolation(bootstrapFiles),
    ...packageReferenceViolations(repoRoot),
    ...hostConfigurationViolations(repoRoot, hostConfigurationFiles),
  ];
  for (const relativePath of sourceFiles) {
    if (isG4AuthoritySource(relativePath)) continue;
    const surface = ingressSurface(relativePath);
    const authorityPath = findAuthorityPath(
      relativePath,
      imports,
      authorityFiles,
    );
    if (authorityPath) {
      violations.push({
        kind: 'authority_import_reachable',
        surface,
        source: relativePath,
        detail: authorityPath[authorityPath.length - 1],
        path: authorityPath,
      });
    }
    const directMarker = (moduleSpecifiers.get(relativePath) ?? [])
      .map(forbiddenReference)
      .find((marker): marker is string => marker !== null);
    if (directMarker && !authorityPath) {
      violations.push({
        kind: 'authority_import_reachable',
        surface,
        source: relativePath,
        detail: directMarker,
        path: [relativePath],
      });
    }
    const selectedMarker = (stringLiterals.get(relativePath) ?? [])
      .filter(
        (literal) =>
          !(moduleSpecifiers.get(relativePath) ?? []).includes(literal),
      )
      .map(forbiddenReference)
      .find((marker): marker is string => marker !== null);
    if (selectedMarker) {
      violations.push({
        kind: 'authority_reference_selected',
        surface,
        source: relativePath,
        detail: selectedMarker,
        path: [relativePath],
      });
    }
  }

  const analysis: G4IsolationAnalysis = {
    source_files: sourceFiles,
    production_entrypoints: deriveProductionEntrypoints(
      repoRoot,
      knownSourceFiles,
    ),
    authority_source_files: uniqueSorted(authoritySourceFiles),
    bootstrap_source_files: bootstrapFiles,
    violations: violations.sort((left, right) =>
      asciiCompare(
        `${left.kind}\0${left.surface}\0${left.source}\0${left.detail}`,
        `${right.kind}\0${right.surface}\0${right.source}\0${right.detail}`,
      ),
    ),
  };
  analysisCache.set(repoRoot, { state, analysis });
  return analysis;
}

export function assertG4TestBootstrapIsolation(repoRoot: string): void {
  const analysis = analyzeG4TestBootstrapIsolation(repoRoot);
  if (analysis.violations.length > 0) {
    throw new G4IsolationContractError(
      `G4 test bootstrap isolation violation: ${analysis.violations
        .map(
          (violation) =>
            `${violation.kind}:${violation.surface}:${violation.source}:${violation.detail}`,
        )
        .join(', ')}`,
    );
  }
}

export function g4IsolationBoundaryPayload(repoRoot: string): JsonObject {
  assertG4TestBootstrapIsolation(repoRoot);
  return {
    format: 'icarus.workflow-test-bootstrap-isolation-boundary/2',
    policy: 'downstream_safe_test_only_bootstrap_isolation',
    source_ownership: {
      root: G4_BOOTSTRAP_SOURCE_ROOT,
      declared_source_paths: [...G4_BOOTSTRAP_SOURCE_PATHS],
      discovery: 'recursive_non_test_javascript_typescript_sources',
      inventory_match: 'exact',
      source_bytes_identity: 'implementation_artifact',
    },
    import_graph: {
      inventory_roots: [...SOURCE_ROOTS],
      source_extensions: [...SOURCE_EXTENSIONS],
      parsed_import_forms: [...IMPORT_FORMS],
      module_resolution: 'relative_root_and_typescript_resolver',
      authority_source_prefixes: [...G4_AUTHORITY_SOURCE_PREFIXES],
      authority_configuration_paths: [...G4_AUTHORITY_CONFIGURATION_PATHS],
      all_non_test_source_reachability: 'unreachable',
      production_root_reachability: 'unreachable',
      future_gate_source_policy:
        'allowed_when_no_test_bootstrap_authority_reachability',
    },
    production_surfaces: {
      package_fields: [...PRODUCTION_PACKAGE_FIELDS],
      production_script_names: [...PRODUCTION_SCRIPT_NAMES],
      known_host_entrypoints: [...KNOWN_HOST_ENTRYPOINTS],
      feature_ingress_rules: [...INGRESS_RULES.feature],
      api_ingress_rules: [...INGRESS_RULES.api],
      automation_ingress_rules: [...INGRESS_RULES.automation],
      host_bootstrap_rules: [...INGRESS_RULES.host],
      forbidden_reference_markers: [...FORBIDDEN_REFERENCE_MARKERS],
      host_configuration_roots: [...SOURCE_ROOTS],
      host_configuration_extensions: [...HOST_CONFIGURATION_EXTENSIONS],
      package_default_reference: 'absent',
      host_configuration_reference: 'absent',
      feature_ingress_reachability: 'unreachable',
      api_ingress_reachability: 'unreachable',
      automation_ingress_reachability: 'unreachable',
      host_bootstrap_reachability: 'unreachable',
    },
    production_fail_closed_evidence:
      'structured_source_ownership_and_live_ast_import_graph',
    active_registry_or_release_pointer_access: 'forbidden',
    real_adapter_access: 'forbidden',
    network_access: 'forbidden',
    user_data_access: 'forbidden',
  };
}
