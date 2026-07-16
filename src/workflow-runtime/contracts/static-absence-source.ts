import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import ts from 'typescript';

import { domainSeparatedSha256 } from './hash.js';
import { strictParseJsonBytes } from './strict-json.js';
import {
  LEGACY_SQLITE_COLUMNS,
  LEGACY_SQLITE_INDEX_PREFIXES,
  LEGACY_SQLITE_TABLES,
  PRODUCT_SURFACE_SEEDS,
  PROTECTED_CAPABILITY_FIXTURES,
  REMOVED_API_FIXTURES,
  REMOVED_DATA_ROOT_BASENAMES,
  REMOVED_DOM_NAV_KEYS,
  REMOVED_DOM_SCREEN_IDS,
  REMOVED_FEATURE_RESOURCE_KEYS,
  REMOVED_RESOURCE_ROOT_BASENAMES,
  REMOVED_SOURCE_IDENTIFIERS,
  REMOVED_SOURCE_MODULE_BASENAMES,
  STATIC_ABSENCE_SOURCE_ROOTS,
  STATIC_ABSENCE_TOOL_SOURCE_FILES,
  type MigrationCandidateBoundaryManifest,
  type ProductSurfaceCoverageEntry,
  type ProductSurfaceCoverageManifest,
  type StaticAbsenceProofEvidence,
  type StaticAbsenceFixtureKind,
  type WorkflowRuntimeAbsenceBaseline,
} from './static-absence-types.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

const contractsRoot = import.meta.dirname;
export const STATIC_ABSENCE_REPO_ROOT = path.resolve(
  contractsRoot,
  '..',
  '..',
  '..',
);

const SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.js',
  '.jsx',
  '.mjs',
  '.ts',
  '.tsx',
]);
const TEXT_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  '.css',
  '.html',
  '.json',
  '.json5',
  '.md',
  '.sh',
  '.yaml',
  '.yml',
]);
const DATABASE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3']);
const CANDIDATE_ROOT_SEGMENTS = ['local', 'migration-candidates'] as const;
const CANDIDATE_ROOT_RELATIVE =
  `${CANDIDATE_ROOT_SEGMENTS.join('/')}/` as const;
const STATIC_GATE_ERROR = 'static_absence_gate_failed';

interface SourceInventory {
  files: Map<string, ts.SourceFile>;
  bytes: Map<string, Buffer>;
  imports: Map<string, string[]>;
  identifiers: Map<string, Set<string>>;
  stringLiterals: Map<string, string[]>;
}

interface RouteInventoryEntry {
  source_file: string;
  match_kind: 'exact' | 'prefix' | 'regex';
  pattern: string;
  methods: string[];
}

interface CandidateReachabilityEvidence extends JsonObject {
  category: string;
  forward_paths: string[];
  reverse_paths: string[];
  candidate_content_read_for_source_scan: false;
}

export class StaticAbsenceContractError extends Error {
  readonly code = STATIC_GATE_ERROR;

  constructor(message: string) {
    super(message);
    this.name = 'StaticAbsenceContractError';
  }
}

function asciiCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(asciiCompare);
}

function normalizeRelative(value: string): string {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}

function repoRelative(absolute: string): string {
  return normalizeRelative(path.relative(STATIC_ABSENCE_REPO_ROOT, absolute));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function isCandidatePath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath);
  return (
    normalized === CANDIDATE_ROOT_RELATIVE.slice(0, -1) ||
    normalized.startsWith(CANDIDATE_ROOT_RELATIVE)
  );
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'dist-electron' ||
        entry.name === 'dist-assistant' ||
        entry.name === 'release'
      ) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  };
  visit(root);
  return result.sort((left, right) =>
    asciiCompare(repoRelative(left), repoRelative(right)),
  );
}

function rawSha256(bytes: Uint8Array): Sha256Hash {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function hashEvidence(domain: string, value: JsonValue): Sha256Hash {
  return domainSeparatedSha256(domain, value);
}

function assertJsonRecord(
  value: unknown,
  label: string,
): asserts value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StaticAbsenceContractError(`${label} must be an object`);
  }
}

function scriptKind(file: string): ts.ScriptKind {
  switch (path.extname(file)) {
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

function collectAstFacts(sourceFile: ts.SourceFile): {
  importSpecifiers: string[];
  identifiers: Set<string>;
  stringLiterals: string[];
} {
  const importSpecifiers: string[] = [];
  const identifiers = new Set<string>();
  const stringLiterals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    if (ts.isStringLiteralLike(node)) stringLiterals.push(node.text);
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      importSpecifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) &&
        (node.expression.text === 'require' ||
          node.expression.text === 'import')) ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      importSpecifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return {
    importSpecifiers: uniqueSorted(importSpecifiers),
    identifiers,
    stringLiterals,
  };
}

function sourceFilesFromConfiguredRoots(): string[] {
  return STATIC_ABSENCE_SOURCE_ROOTS.flatMap((root) =>
    listFiles(path.join(STATIC_ABSENCE_REPO_ROOT, root)),
  ).filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
}

function resolveRelativeImport(
  fromRelative: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = normalizeRelative(
    path.posix.normalize(
      path.posix.join(path.posix.dirname(fromRelative), specifier),
    ),
  );
  const withoutJs = base.replace(/\.(?:c|m)?js$/, '');
  const candidates = uniqueSorted([
    base,
    withoutJs,
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(
      (extension) => `${withoutJs}${extension}`,
    ),
    ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map(
      (extension) => `${withoutJs}/index${extension}`,
    ),
  ]);
  return candidates.find((candidate) => knownFiles.has(candidate)) ?? null;
}

function buildSourceInventory(): SourceInventory {
  const absoluteFiles = sourceFilesFromConfiguredRoots();
  const knownFiles = new Set(absoluteFiles.map(repoRelative));
  const files = new Map<string, ts.SourceFile>();
  const bytes = new Map<string, Buffer>();
  const imports = new Map<string, string[]>();
  const identifiers = new Map<string, Set<string>>();
  const stringLiterals = new Map<string, string[]>();
  for (const absolute of absoluteFiles) {
    const relative = repoRelative(absolute);
    if (isCandidatePath(relative)) {
      throw new StaticAbsenceContractError(
        `Candidate content entered source inventory: ${relative}`,
      );
    }
    const fileBytes = fs.readFileSync(absolute);
    const sourceFile = ts.createSourceFile(
      relative,
      fileBytes.toString('utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(relative),
    );
    const facts = collectAstFacts(sourceFile);
    files.set(relative, sourceFile);
    bytes.set(relative, fileBytes);
    identifiers.set(relative, facts.identifiers);
    stringLiterals.set(relative, facts.stringLiterals);
    imports.set(
      relative,
      uniqueSorted(
        facts.importSpecifiers
          .map((specifier) =>
            resolveRelativeImport(relative, specifier, knownFiles),
          )
          .filter((value): value is string => value !== null),
      ),
    );
  }
  return { files, bytes, imports, identifiers, stringLiterals };
}

function deriveProductionEntrypoints(inventory: SourceInventory): string[] {
  const entries = new Set<string>();
  const packageJson = strictParseJsonBytes(
    fs.readFileSync(path.join(STATIC_ABSENCE_REPO_ROOT, 'package.json')),
  ) as JsonObject;
  if (typeof packageJson.main === 'string') {
    const sourceEntry = normalizeRelative(
      packageJson.main.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'),
    );
    if (inventory.files.has(sourceEntry)) entries.add(sourceEntry);
  }
  for (const root of ['electron', 'assistant']) {
    for (const suffix of [
      'main.ts',
      'preload.ts',
      'renderer/app.ts',
      'renderer/app.js',
    ]) {
      const candidate = `${root}/${suffix}`;
      if (inventory.files.has(candidate)) entries.add(candidate);
    }
  }
  const containerPackagePath = path.join(
    STATIC_ABSENCE_REPO_ROOT,
    'container',
    'agent-runner',
    'package.json',
  );
  if (fs.existsSync(containerPackagePath)) {
    const containerPackage = strictParseJsonBytes(
      fs.readFileSync(containerPackagePath),
    ) as JsonObject;
    if (typeof containerPackage.main === 'string') {
      const sourceEntry = normalizeRelative(
        path.posix.join(
          'container/agent-runner',
          containerPackage.main
            .replace(/^dist\//, 'src/')
            .replace(/\.js$/, '.ts'),
        ),
      );
      if (inventory.files.has(sourceEntry)) entries.add(sourceEntry);
    }
  }
  if (entries.size === 0) {
    throw new StaticAbsenceContractError(
      'No production entrypoint was discovered',
    );
  }
  return uniqueSorted(entries);
}

function reachableProductionFiles(
  inventory: SourceInventory,
  entrypoints: readonly string[],
): string[] {
  const visited = new Set<string>();
  const queue = [...entrypoints];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const dependency of inventory.imports.get(current) ?? []) {
      if (!visited.has(dependency)) queue.push(dependency);
    }
  }
  return uniqueSorted(visited);
}

function productionImportEdges(
  inventory: SourceInventory,
  productionFiles: readonly string[],
): Array<{ from: string; to: string }> {
  const reachable = new Set(productionFiles);
  return productionFiles
    .flatMap((from) =>
      (inventory.imports.get(from) ?? [])
        .filter((to) => reachable.has(to))
        .map((to) => ({ from, to })),
    )
    .sort((left, right) =>
      asciiCompare(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`),
    );
}

function scanProductionSourceHits(
  inventory: SourceInventory,
  productionFiles: readonly string[],
): string[] {
  const hits: string[] = [];
  const removedModules = new Set(REMOVED_SOURCE_MODULE_BASENAMES);
  const removedIdentifiers = new Set(REMOVED_SOURCE_IDENTIFIERS);
  for (const relative of productionFiles) {
    const sourceFile = inventory.files.get(relative)!;
    const outsideRuntime = !relative.startsWith('src/workflow-runtime/');
    for (const identifier of inventory.identifiers.get(relative) ?? []) {
      if (
        removedIdentifiers.has(
          identifier as (typeof REMOVED_SOURCE_IDENTIFIERS)[number],
        )
      ) {
        hits.push(`${relative}:identifier:${identifier}`);
      }
    }
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        const specifier = node.moduleSpecifier.text;
        const basename = path.posix
          .basename(specifier)
          .replace(/\.(?:c|m)?js$/, '');
        if (
          removedModules.has(
            basename as (typeof REMOVED_SOURCE_MODULE_BASENAMES)[number],
          )
        ) {
          hits.push(`${relative}:removed-import:${specifier}`);
        }
        if (
          outsideRuntime &&
          /workflow-runtime\/(?:store|runtime|scheduler|reconciler|registry)(?:\/|$)/.test(
            specifier,
          )
        ) {
          hits.push(`${relative}:runtime-gateway-bypass:${specifier}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return uniqueSorted(hits);
}

function nodeContainsNumber(node: ts.Node, value: number): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isNumericLiteral(child) && Number(child.text) === value)
      found = true;
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function nodeContainsRouteHandler(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) {
      const expressionText = child.expression.getText();
      if (
        /(?:^|\.)(?:api[A-Z]|handle[A-Z]|serve[A-Z]|dispatch$)/.test(
          expressionText,
        ) ||
        expressionText === 'this.serveFile'
      ) {
        found = true;
      }
    }
    if (!found) ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function collectRoutePatterns(
  condition: ts.Expression,
): Array<Pick<RouteInventoryEntry, 'match_kind' | 'pattern'>> {
  const patterns: Array<Pick<RouteInventoryEntry, 'match_kind' | 'pattern'>> =
    [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    ) {
      const left = node.left.getText();
      const right = node.right;
      if (left === 'pathname' && ts.isStringLiteralLike(right)) {
        patterns.push({ match_kind: 'exact', pattern: right.text });
      } else if (
        node.right.getText() === 'pathname' &&
        ts.isStringLiteralLike(node.left)
      ) {
        patterns.push({ match_kind: 'exact', pattern: node.left.text });
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === 'pathname' &&
      node.arguments.length > 0
    ) {
      const method = node.expression.name.text;
      const argument = node.arguments[0];
      if (method === 'startsWith' && ts.isStringLiteralLike(argument)) {
        patterns.push({ match_kind: 'prefix', pattern: argument.text });
      }
      if (method === 'match' && ts.isRegularExpressionLiteral(argument)) {
        patterns.push({ match_kind: 'regex', pattern: argument.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return patterns;
}

function collectRouteMethods(condition: ts.Expression): string[] {
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    ) {
      if (
        node.left.getText() === 'req.method' &&
        ts.isStringLiteralLike(node.right)
      ) {
        methods.push(node.right.text);
      }
      if (
        node.right.getText() === 'req.method' &&
        ts.isStringLiteralLike(node.left)
      ) {
        methods.push(node.left.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(condition);
  return uniqueSorted(methods.length > 0 ? methods : ['ANY']);
}

function enumerateWebRoutes(
  inventory: SourceInventory,
  productionFiles: readonly string[],
): RouteInventoryEntry[] {
  const routes: RouteInventoryEntry[] = [];
  for (const relative of productionFiles) {
    const sourceFile = inventory.files.get(relative)!;
    const visit = (node: ts.Node): void => {
      if (
        ts.isIfStatement(node) &&
        !nodeContainsNumber(node.thenStatement, 404) &&
        nodeContainsRouteHandler(node.thenStatement)
      ) {
        const methods = collectRouteMethods(node.expression);
        for (const pattern of collectRoutePatterns(node.expression)) {
          routes.push({ source_file: relative, ...pattern, methods });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const keyed = new Map<string, RouteInventoryEntry>();
  for (const route of routes) {
    const key = `${route.source_file}\0${route.match_kind}\0${route.pattern}\0${route.methods.join(',')}`;
    keyed.set(key, route);
  }
  return [...keyed.values()].sort((left, right) =>
    asciiCompare(
      `${left.pattern}\0${left.match_kind}\0${left.source_file}`,
      `${right.pattern}\0${right.match_kind}\0${right.source_file}`,
    ),
  );
}

function regexLiteralMatches(literal: string, pathname: string): boolean {
  const match = literal.match(/^\/(.*)\/([a-z]*)$/s);
  if (!match) return false;
  try {
    return new RegExp(match[1], match[2]).test(pathname);
  } catch {
    throw new StaticAbsenceContractError(
      `Invalid route regex inventory: ${literal}`,
    );
  }
}

function routeMatches(
  route: RouteInventoryEntry,
  pathname: string,
  method: string,
): boolean {
  if (!route.methods.includes('ANY') && !route.methods.includes(method))
    return false;
  if (route.match_kind === 'exact') return route.pattern === pathname;
  if (route.match_kind === 'prefix') return pathname.startsWith(route.pattern);
  return regexLiteralMatches(route.pattern, pathname);
}

function removedApiHits(routes: readonly RouteInventoryEntry[]): string[] {
  return REMOVED_API_FIXTURES.flatMap((fixture) =>
    routes
      .filter((route) => routeMatches(route, fixture.path, fixture.method))
      .map(
        (route) =>
          `${fixture.method} ${fixture.path}:${route.source_file}:${route.match_kind}:${route.pattern}`,
      ),
  ).sort(asciiCompare);
}

function parseHtmlInventory(): { ids: string[]; navKeys: string[] } {
  const ids: string[] = [];
  const navKeys: string[] = [];
  for (const root of ['electron', 'assistant']) {
    for (const file of listFiles(
      path.join(STATIC_ABSENCE_REPO_ROOT, root),
    ).filter((candidate) => path.extname(candidate) === '.html')) {
      const html = fs.readFileSync(file, 'utf8');
      const tagPattern = /<([A-Za-z][A-Za-z0-9:-]*)(\s[^<>]*?)?\/?\s*>/g;
      for (const tagMatch of html.matchAll(tagPattern)) {
        const attributes = tagMatch[2] ?? '';
        const attributePattern =
          /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
        for (const attributeMatch of attributes.matchAll(attributePattern)) {
          const name = attributeMatch[1].toLowerCase();
          const value = attributeMatch[2] ?? attributeMatch[3] ?? '';
          if (name === 'id') ids.push(value);
          if (name === 'data-nav-key') navKeys.push(value);
        }
      }
    }
  }
  return { ids: uniqueSorted(ids), navKeys: uniqueSorted(navKeys) };
}

function discoverFeatureManifests(): string[] {
  const root = path.join(STATIC_ABSENCE_REPO_ROOT, 'features');
  return listFiles(root)
    .filter((file) => path.basename(file) === 'feature.json')
    .map(repoRelative)
    .sort(asciiCompare);
}

function scanFeatureManifests(manifestFiles: readonly string[]): {
  removedResourceHits: string[];
  navKeys: string[];
  resourceRoots: string[];
} {
  const removedResourceHits: string[] = [];
  const navKeys: string[] = [];
  const resourceRoots: string[] = [];
  for (const relative of manifestFiles) {
    const value = strictParseJsonBytes(
      fs.readFileSync(path.join(STATIC_ABSENCE_REPO_ROOT, relative)),
    );
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new StaticAbsenceContractError(
        `${relative}: feature manifest is not an object`,
      );
    }
    const manifest = value as JsonObject;
    if (Array.isArray(manifest.nav)) {
      for (const item of manifest.nav) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const key = (item as JsonObject).key;
          if (typeof key === 'string') navKeys.push(key);
        }
      }
    }
    if (
      manifest.resources &&
      typeof manifest.resources === 'object' &&
      !Array.isArray(manifest.resources)
    ) {
      const resources = manifest.resources as JsonObject;
      for (const key of REMOVED_FEATURE_RESOURCE_KEYS) {
        if (Object.hasOwn(resources, key)) {
          removedResourceHits.push(`${relative}:resources.${key}`);
        }
      }
      for (const [key, resourcePath] of Object.entries(resources)) {
        if (typeof resourcePath === 'string')
          resourceRoots.push(`${relative}:${key}:${resourcePath}`);
      }
    }
    for (const key of REMOVED_FEATURE_RESOURCE_KEYS) {
      if (Object.hasOwn(manifest, key))
        removedResourceHits.push(`${relative}:${key}`);
    }
  }
  return {
    removedResourceHits: uniqueSorted(removedResourceHits),
    navKeys: uniqueSorted(navKeys),
    resourceRoots: uniqueSorted(resourceRoots),
  };
}

function configuredFilesystemRoots(inventory: SourceInventory): string[] {
  const config = inventory.files.get('src/config.ts');
  if (!config)
    throw new StaticAbsenceContractError('src/config.ts was not inventoried');
  const roots: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          (declaration.name.text === 'DATA_DIR' ||
            declaration.name.text === 'STORE_DIR') &&
          declaration.initializer
        ) {
          const strings: string[] = [];
          const collect = (child: ts.Node): void => {
            if (ts.isStringLiteralLike(child)) strings.push(child.text);
            ts.forEachChild(child, collect);
          };
          collect(declaration.initializer);
          const leaf = strings.at(-1);
          if (!leaf) {
            throw new StaticAbsenceContractError(
              `${declaration.name.text} has no statically configured root segment`,
            );
          }
          roots.push(normalizeRelative(leaf));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(config);
  const result = uniqueSorted(roots);
  if (!result.includes('data') || !result.includes('store')) {
    throw new StaticAbsenceContractError(
      'DATA_DIR/STORE_DIR root discovery drift',
    );
  }
  return result;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function inspectDatabase(database: Database.Database, label: string): string[] {
  const hits: string[] = [];
  const schemaRows = database
    .prepare(
      "SELECT type, name, tbl_name FROM sqlite_schema WHERE type IN ('table', 'index') ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl_name: string }>;
  const legacyTables = new Set(LEGACY_SQLITE_TABLES);
  for (const row of schemaRows) {
    if (
      row.type === 'table' &&
      legacyTables.has(row.name as (typeof LEGACY_SQLITE_TABLES)[number])
    ) {
      hits.push(`${label}:table:${row.name}`);
    }
    if (
      row.type === 'index' &&
      LEGACY_SQLITE_INDEX_PREFIXES.some((prefix) => row.name.startsWith(prefix))
    ) {
      hits.push(`${label}:index:${row.name}`);
    }
  }
  const forbiddenColumns = new Set(LEGACY_SQLITE_COLUMNS);
  for (const row of schemaRows.filter(
    (candidate) => candidate.type === 'table',
  )) {
    const columns = database
      .prepare(`PRAGMA table_info(${quoteSqlIdentifier(row.name)})`)
      .all() as Array<{ name: string }>;
    for (const column of columns) {
      const qualified = `${row.name}.${column.name}`;
      if (
        forbiddenColumns.has(
          qualified as (typeof LEGACY_SQLITE_COLUMNS)[number],
        )
      ) {
        hits.push(`${label}:column:${qualified}`);
      }
    }
  }
  return hits;
}

function inspectConfiguredSqliteSchemas(
  configuredRoots: readonly string[],
): string[] {
  const hits: string[] = [];
  const fresh = new Database(':memory:');
  try {
    hits.push(...inspectDatabase(fresh, 'fresh'));
  } finally {
    fresh.close();
  }
  for (const root of configuredRoots) {
    const absoluteRoot = path.join(STATIC_ABSENCE_REPO_ROOT, root);
    for (const databasePath of listFiles(absoluteRoot).filter((file) =>
      DATABASE_EXTENSIONS.has(path.extname(file).toLowerCase()),
    )) {
      const database = new Database(databasePath, {
        fileMustExist: true,
        readonly: true,
      });
      try {
        hits.push(...inspectDatabase(database, repoRelative(databasePath)));
      } finally {
        database.close();
      }
    }
  }
  return uniqueSorted(hits);
}

function scanLegacyFilesystem(configuredRoots: readonly string[]): string[] {
  const hits: string[] = [];
  const forbidden = new Set(REMOVED_DATA_ROOT_BASENAMES);
  for (const root of configuredRoots) {
    const absoluteRoot = path.join(STATIC_ABSENCE_REPO_ROOT, root);
    if (!fs.existsSync(absoluteRoot)) continue;
    for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        forbidden.has(
          entry.name as (typeof REMOVED_DATA_ROOT_BASENAMES)[number],
        )
      ) {
        hits.push(`${root}/${entry.name}`);
      }
    }
  }
  return uniqueSorted(hits);
}

function scanActiveResourceRoots(
  featureScan: ReturnType<typeof scanFeatureManifests>,
): string[] {
  const hits = [...featureScan.removedResourceHits];
  for (const root of ['container', 'features']) {
    const absolute = path.join(STATIC_ABSENCE_REPO_ROOT, root);
    for (const file of listFiles(absolute)) {
      if (
        REMOVED_RESOURCE_ROOT_BASENAMES.some((basename) =>
          repoRelative(file).split('/').includes(basename),
        )
      ) {
        hits.push(repoRelative(file));
      }
    }
  }
  return uniqueSorted(hits);
}

function scanTestRootViolations(): string[] {
  const violations: string[] = [];
  const tests = [...STATIC_ABSENCE_SOURCE_ROOTS, 'setup']
    .flatMap((root) => listFiles(path.join(STATIC_ABSENCE_REPO_ROOT, root)))
    .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file));
  for (const absolute of tests) {
    const relative = repoRelative(absolute);
    const sourceText = fs.readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(
      relative,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(relative),
    );
    const usesTemporaryCwd =
      sourceText.includes('mkdtempSync') &&
      sourceText.includes('process.chdir');
    const facts = collectAstFacts(sourceFile);
    for (const literal of facts.stringLiterals) {
      const normalized = normalizeRelative(literal);
      if (
        isCandidatePath(normalized) &&
        !relative.endsWith('static-absence.test.ts')
      ) {
        violations.push(`${relative}:candidate-test-root:${literal}`);
      }
      if (!usesTemporaryCwd && /^(?:data|store)\//.test(normalized)) {
        violations.push(`${relative}:repository-test-root:${literal}`);
      }
      if (
        path.isAbsolute(literal) &&
        (isInside(path.join(STATIC_ABSENCE_REPO_ROOT, 'data'), literal) ||
          isInside(path.join(STATIC_ABSENCE_REPO_ROOT, 'store'), literal))
      ) {
        violations.push(`${relative}:absolute-production-test-root:${literal}`);
      }
    }
  }
  return uniqueSorted(violations);
}

export function assertIsolatedTestRoots(
  dataRoot: string,
  storeRoot: string,
  repositoryRoot = STATIC_ABSENCE_REPO_ROOT,
): void {
  const roots = [path.resolve(dataRoot), path.resolve(storeRoot)];
  const productionRoots = [
    path.join(repositoryRoot, 'data'),
    path.join(repositoryRoot, 'store'),
  ];
  const candidateRoot = path.join(repositoryRoot, ...CANDIDATE_ROOT_SEGMENTS);
  if (
    roots[0] === roots[1] ||
    roots.some(
      (root) =>
        productionRoots.some(
          (production) =>
            isInside(production, root) || isInside(root, production),
        ) ||
        isInside(candidateRoot, root) ||
        isInside(root, candidateRoot),
    )
  ) {
    throw new StaticAbsenceContractError('test_root_not_isolated');
  }
}

function candidateMarkerInText(text: string): boolean {
  const marker = CANDIDATE_ROOT_SEGMENTS.join('/');
  return (
    text.includes(marker) ||
    (/migration-candidates/.test(text) &&
      /(?:^|[^A-Za-z])local(?:[^A-Za-z]|$)/.test(text))
  );
}

function textReferenceHits(files: readonly string[], label: string): string[] {
  const hits: string[] = [];
  for (const relative of files) {
    if (isCandidatePath(relative)) {
      hits.push(`${label}:candidate-file:${relative}`);
      continue;
    }
    const absolute = path.join(STATIC_ABSENCE_REPO_ROOT, relative);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    if (
      !TEXT_EXTENSIONS.has(path.extname(relative)) &&
      path.basename(relative) !== 'Dockerfile'
    )
      continue;
    if (candidateMarkerInText(fs.readFileSync(absolute, 'utf8'))) {
      hits.push(`${label}:reference:${relative}`);
    }
  }
  return uniqueSorted(hits);
}

function globCanReachCandidate(pattern: string): boolean {
  const normalized = normalizeRelative(pattern.trim());
  if (!normalized || normalized.startsWith('!')) return false;
  const wildcardIndex = normalized.search(/[?*{[]/);
  const staticPrefix = (
    wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex)
  ).replace(/\/$/, '');
  const candidate = CANDIDATE_ROOT_RELATIVE.slice(0, -1);
  if (staticPrefix === '' || staticPrefix === '.') return true;
  return (
    candidate === staticPrefix ||
    candidate.startsWith(`${staticPrefix}/`) ||
    staticPrefix.startsWith(`${candidate}/`)
  );
}

function categoryEvidence(
  category: string,
  hits: readonly string[],
): CandidateReachabilityEvidence {
  return {
    category,
    forward_paths: [...hits].sort(asciiCompare),
    reverse_paths: [...hits].map((hit) => `reverse:${hit}`).sort(asciiCompare),
    candidate_content_read_for_source_scan: false,
  };
}

function categoryHash(category: string, hits: readonly string[]): Sha256Hash {
  return hashEvidence(
    `icarus:migration-candidate-${category}-reachability:1\n`,
    categoryEvidence(category, hits),
  );
}

function verifyCandidateArchive(): {
  archiveManifestHash: Sha256Hash;
  checksumManifestHash: Sha256Hash;
  archivedFileCount: number;
} {
  const candidateRoot = path.join(
    STATIC_ABSENCE_REPO_ROOT,
    ...CANDIDATE_ROOT_SEGMENTS,
  );
  if (!fs.existsSync(candidateRoot)) {
    throw new StaticAbsenceContractError('Migration candidate root is missing');
  }
  const archiveManifests = listFiles(candidateRoot).filter(
    (file) => path.basename(file) === 'MIGRATION-CANDIDATE.md',
  );
  const checksumManifests = listFiles(candidateRoot).filter(
    (file) => path.basename(file) === 'SHA256SUMS',
  );
  if (archiveManifests.length === 0 || checksumManifests.length === 0) {
    throw new StaticAbsenceContractError(
      'Candidate archive/checksum manifest is missing',
    );
  }
  let archivedFileCount = 0;
  for (const checksumFile of checksumManifests) {
    const candidateDirectory = path.dirname(checksumFile);
    const lines = fs
      .readFileSync(checksumFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const line of lines) {
      const match = line.match(/^([0-9a-f]{64})  ([^\0\r\n]+)$/);
      if (!match)
        throw new StaticAbsenceContractError(
          `Invalid checksum line in ${repoRelative(checksumFile)}`,
        );
      const target = path.resolve(candidateDirectory, match[2]);
      if (
        !isInside(candidateDirectory, target) ||
        !fs.existsSync(target) ||
        !fs.statSync(target).isFile()
      ) {
        throw new StaticAbsenceContractError(
          `Candidate checksum target is invalid: ${match[2]}`,
        );
      }
      // Candidate bytes are read only by this checksum verifier, never by source-hit analysis.
      if (rawSha256(fs.readFileSync(target)) !== `sha256:${match[1]}`) {
        throw new StaticAbsenceContractError(
          `Candidate checksum mismatch: ${repoRelative(target)}`,
        );
      }
      archivedFileCount += 1;
    }
  }
  const archiveManifestHash = hashEvidence(
    'icarus:migration-candidate-archive-manifests:1\n',
    archiveManifests.map((file) => ({
      candidate: repoRelative(path.dirname(file)),
      hash: rawSha256(fs.readFileSync(file)),
    })),
  );
  const checksumManifestHash = hashEvidence(
    'icarus:migration-candidate-checksum-manifests:1\n',
    checksumManifests.map((file) => ({
      candidate: repoRelative(path.dirname(file)),
      hash: rawSha256(fs.readFileSync(file)),
    })),
  );
  return { archiveManifestHash, checksumManifestHash, archivedFileCount };
}

function buildCandidateBoundary(
  sourceCoreBuildHash: Sha256Hash,
  inventory: SourceInventory,
  productionFiles: readonly string[],
  featureManifestFiles: readonly string[],
): {
  manifest: MigrationCandidateBoundaryManifest;
  runtimeFileAccessHits: string[];
} {
  const verified = verifyCandidateArchive();
  const productionHits = textReferenceHits(productionFiles, 'production');
  const testHelperFiles = [...inventory.files.keys()].filter(
    (file) =>
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) &&
      !file.endsWith('static-absence.test.ts'),
  );
  const testHelperHits = textReferenceHits(testHelperFiles, 'test-helper');
  const setupFiles = [
    ...listFiles(path.join(STATIC_ABSENCE_REPO_ROOT, 'setup')),
    path.join(STATIC_ABSENCE_REPO_ROOT, 'setup.sh'),
  ]
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .map(repoRelative)
    .filter((file) => !/\.(?:test|spec)\./.test(file));
  const setupHits = textReferenceHits(setupFiles, 'setup');
  const featureFiles = uniqueSorted([
    ...[...inventory.files.keys()].filter((file) =>
      file.startsWith('src/features/'),
    ),
    ...featureManifestFiles,
  ]);
  const featureHits = textReferenceHits(featureFiles, 'feature-registry');
  const compilerFixtureFiles = listFiles(
    path.join(
      STATIC_ABSENCE_REPO_ROOT,
      'src/workflow-runtime/contracts/conformance',
    ),
  ).map(repoRelative);
  const compilerFixtureHits = textReferenceHits(
    compilerFixtureFiles,
    'compiler-fixture',
  );
  const buildFiles = [
    'container/Dockerfile',
    'electron-builder.json5',
    'package.json',
    'scripts/build-assistant.mjs',
    'scripts/build-electron.mjs',
    'tsconfig.json',
    'container/agent-runner/tsconfig.json',
  ].filter((file) => fs.existsSync(path.join(STATIC_ABSENCE_REPO_ROOT, file)));
  const buildHits = textReferenceHits(buildFiles, 'build-context');
  const candidateRoot = CANDIDATE_ROOT_RELATIVE.slice(0, -1);
  const buildCoverageHits: string[] = [];
  const electronBuilder = strictParseJsonBytes(
    fs.readFileSync(
      path.join(STATIC_ABSENCE_REPO_ROOT, 'electron-builder.json5'),
    ),
  );
  if (
    electronBuilder &&
    typeof electronBuilder === 'object' &&
    !Array.isArray(electronBuilder)
  ) {
    const patterns = (electronBuilder as JsonObject).files;
    if (
      Array.isArray(patterns) &&
      patterns.some(
        (value) => typeof value === 'string' && globCanReachCandidate(value),
      )
    ) {
      buildCoverageHits.push('electron-builder:candidate-covered');
    }
  }
  const tsconfig = strictParseJsonBytes(
    fs.readFileSync(path.join(STATIC_ABSENCE_REPO_ROOT, 'tsconfig.json')),
  ) as JsonObject;
  if (
    Array.isArray(tsconfig.include) &&
    tsconfig.include.some(
      (value) => typeof value === 'string' && globCanReachCandidate(value),
    )
  ) {
    buildCoverageHits.push('tsconfig:candidate-covered');
  }
  const rootPackage = strictParseJsonBytes(
    fs.readFileSync(path.join(STATIC_ABSENCE_REPO_ROOT, 'package.json')),
  ) as JsonObject;
  if (
    Array.isArray(rootPackage.files) &&
    rootPackage.files.some(
      (value) => typeof value === 'string' && globCanReachCandidate(value),
    )
  ) {
    buildCoverageHits.push('package-files:candidate-covered');
  }
  if (
    isInside(
      path.join(STATIC_ABSENCE_REPO_ROOT, 'container'),
      path.join(STATIC_ABSENCE_REPO_ROOT, candidateRoot),
    )
  ) {
    buildCoverageHits.push('container-context:candidate-covered');
  }
  const releaseHits = uniqueSorted([...buildHits, ...buildCoverageHits]);
  const runtimeFileAccessHits = uniqueSorted(
    productionFiles.flatMap((file) => {
      const hits = (inventory.stringLiterals.get(file) ?? [])
        .filter((literal) => candidateMarkerInText(literal))
        .map((literal) => `${file}:runtime-file-access:${literal}`);
      const sourceFile = inventory.files.get(file)!;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText();
          const firstArgument = node.arguments[0]?.getText() ?? '';
          if (
            /(?:^|\.)(?:readdir|readdirSync|glob|globSync)$/.test(callee) &&
            (firstArgument === 'PROJECT_ROOT' ||
              firstArgument === 'process.cwd()')
          ) {
            hits.push(
              `${file}:broad-runtime-discovery:${callee}(${firstArgument})`,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
      return hits;
    }),
  );
  const productionReachabilityHits = uniqueSorted([
    ...productionHits,
    ...runtimeFileAccessHits,
    ...productionImportEdges(inventory, productionFiles)
      .filter((edge) => isCandidatePath(edge.to))
      .map((edge) => `${edge.from}->${edge.to}`),
  ]);
  const productionHash = categoryHash(
    'production-import',
    productionReachabilityHits,
  );
  const testHash = categoryHash('test-helper', testHelperHits);
  const setupHash = categoryHash('setup', setupHits);
  const featureHash = categoryHash('feature-registry', featureHits);
  const compilerHash = categoryHash('compiler-fixture', compilerFixtureHits);
  const buildHash = categoryHash(
    'build-context',
    uniqueSorted([...buildHits, ...buildCoverageHits]),
  );
  const releaseHash = categoryHash('release-artifact', releaseHits);
  const withoutBoundary = {
    format: 'icarus.migration-candidate-boundary/1',
    source_core_build_hash: sourceCoreBuildHash,
    candidate_root: CANDIDATE_ROOT_RELATIVE,
    archive_manifest_hash: verified.archiveManifestHash,
    checksum_manifest_hash: verified.checksumManifestHash,
    archived_file_count: verified.archivedFileCount,
    production_import_reachability_hash: productionHash,
    test_helper_reachability_hash: testHash,
    setup_reachability_hash: setupHash,
    feature_registry_reachability_hash: featureHash,
    compiler_fixture_reachability_hash: compilerHash,
    build_context_reachability_hash: buildHash,
    release_artifact_reachability_hash: releaseHash,
  } satisfies JsonObject;
  const allHits = [
    ...productionReachabilityHits,
    ...testHelperHits,
    ...setupHits,
    ...featureHits,
    ...compilerFixtureHits,
    ...buildHits,
    ...buildCoverageHits,
    ...releaseHits,
  ];
  if (allHits.length > 0) {
    throw new StaticAbsenceContractError(
      `Migration candidate is reachable: ${uniqueSorted(allHits).join(', ')}`,
    );
  }
  return {
    manifest: {
      ...withoutBoundary,
      boundary_hash: hashEvidence(
        'icarus:migration-candidate-boundary:1\n',
        withoutBoundary as unknown as JsonValue,
      ),
    } as unknown as MigrationCandidateBoundaryManifest,
    runtimeFileAccessHits,
  };
}

function sourceCoreBuildHash(
  inventory: SourceInventory,
  productionFiles: readonly string[],
): Sha256Hash {
  return hashEvidence(
    'icarus:workflow-runtime-source-core-build:1\n',
    productionFiles.map((file) => ({
      path: file,
      hash: rawSha256(inventory.bytes.get(file)!),
    })),
  );
}

function generatedByToolHash(): Sha256Hash {
  const packageLockBytes = fs.readFileSync(
    path.join(STATIC_ABSENCE_REPO_ROOT, 'package-lock.json'),
  );
  const packageLock = strictParseJsonBytes(packageLockBytes) as JsonObject;
  const lockedPackageEntries = packageLock.packages;
  assertJsonRecord(lockedPackageEntries, 'package-lock packages');
  const lockedPackages = ['better-sqlite3', 'typescript'].map((packageName) => {
    const entry = lockedPackageEntries[`node_modules/${packageName}`];
    assertJsonRecord(entry, `package-lock ${packageName}`);
    if (
      typeof entry.version !== 'string' ||
      typeof entry.integrity !== 'string'
    ) {
      throw new StaticAbsenceContractError(
        `Static gate package identity is incomplete: ${packageName}`,
      );
    }
    return {
      package_name: packageName,
      version: entry.version,
      integrity: entry.integrity,
    };
  });
  const rootPackage = strictParseJsonBytes(
    fs.readFileSync(path.join(STATIC_ABSENCE_REPO_ROOT, 'package.json')),
  ) as JsonObject;
  if (typeof rootPackage.packageManager !== 'string') {
    throw new StaticAbsenceContractError('packageManager identity is missing');
  }
  const managedNodeVersion = fs
    .readFileSync(path.join(STATIC_ABSENCE_REPO_ROOT, '.nvmrc'), 'utf8')
    .trim();
  return hashEvidence('icarus:workflow-runtime-static-absence-tool:1\n', {
    managed_node_version: managedNodeVersion,
    package_manager: rootPackage.packageManager,
    package_lock_hash: rawSha256(packageLockBytes),
    locked_packages: lockedPackages,
    source_files: STATIC_ABSENCE_TOOL_SOURCE_FILES.map((file) => {
      const absolute = path.join(STATIC_ABSENCE_REPO_ROOT, file);
      if (!fs.existsSync(absolute)) {
        throw new StaticAbsenceContractError(
          `Static gate tool source is missing: ${file}`,
        );
      }
      return { path: file, hash: rawSha256(fs.readFileSync(absolute)) };
    }),
  });
}

function buildProtectedFixtureHashes(
  inventory: SourceInventory,
  productionFiles: readonly string[],
  routes: readonly RouteInventoryEntry[],
  domIds: readonly string[],
  domNavKeys: readonly string[],
): Record<string, Sha256Hash> {
  const result: Record<string, Sha256Hash> = {};
  for (const fixture of PROTECTED_CAPABILITY_FIXTURES) {
    const matchingFiles = productionFiles.filter((file) =>
      `/${file}`.endsWith(fixture.source_module_suffix),
    );
    if (matchingFiles.length === 0) {
      throw new StaticAbsenceContractError(
        `Protected capability source is missing: ${fixture.fixture_id}`,
      );
    }
    if (
      fixture.source_identifier &&
      !matchingFiles.some((file) =>
        inventory.identifiers.get(file)?.has(fixture.source_identifier!),
      )
    ) {
      throw new StaticAbsenceContractError(
        `Protected capability identifier is missing: ${fixture.fixture_id}`,
      );
    }
    if (
      fixture.api_route &&
      !routes.some(
        (route) =>
          routeMatches(route, fixture.api_route!, 'GET') ||
          routeMatches(route, fixture.api_route!, 'POST'),
      )
    ) {
      throw new StaticAbsenceContractError(
        `Protected capability route is missing: ${fixture.fixture_id}`,
      );
    }
    if (fixture.dom_id && !domIds.includes(fixture.dom_id)) {
      throw new StaticAbsenceContractError(
        `Protected capability DOM id is missing: ${fixture.fixture_id}`,
      );
    }
    if (fixture.dom_nav_key && !domNavKeys.includes(fixture.dom_nav_key)) {
      throw new StaticAbsenceContractError(
        `Protected capability nav key is missing: ${fixture.fixture_id}`,
      );
    }
    result[fixture.fixture_id] = hashEvidence(
      'icarus:workflow-runtime-protected-capability-fixture:1\n',
      {
        ...fixture,
        matching_source_files: matchingFiles,
        status: 'present',
      },
    );
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => asciiCompare(left, right)),
  );
}

export function buildStaticAbsenceProofEvidence(): StaticAbsenceProofEvidence {
  const inventory = buildSourceInventory();
  const entrypoints = deriveProductionEntrypoints(inventory);
  const productionFiles = reachableProductionFiles(inventory, entrypoints);
  const importEdges = productionImportEdges(inventory, productionFiles);
  const productionSourceHits = scanProductionSourceHits(
    inventory,
    productionFiles,
  );
  const routes = enumerateWebRoutes(inventory, productionFiles);
  const apiHits = removedApiHits(routes);
  const html = parseHtmlInventory();
  const featureManifestFiles = discoverFeatureManifests();
  const featureScan = scanFeatureManifests(featureManifestFiles);
  const domIds = html.ids;
  const domNavKeys = uniqueSorted([...html.navKeys, ...featureScan.navKeys]);
  const removedUiHits = uniqueSorted([
    ...REMOVED_DOM_SCREEN_IDS.filter((id) => domIds.includes(id)).map(
      (id) => `screen:${id}`,
    ),
    ...REMOVED_DOM_NAV_KEYS.filter((key) => domNavKeys.includes(key)).map(
      (key) => `nav:${key}`,
    ),
  ]);
  const configuredRoots = configuredFilesystemRoots(inventory);
  const legacySchemaHits = inspectConfiguredSqliteSchemas(configuredRoots);
  const legacyFilesystemHits = scanLegacyFilesystem(configuredRoots);
  const activeResourceHits = scanActiveResourceRoots(featureScan);
  const testRootViolations = scanTestRootViolations();
  const coreHash = sourceCoreBuildHash(inventory, productionFiles);
  const toolHash = generatedByToolHash();
  const protectedFixtureHashes = buildProtectedFixtureHashes(
    inventory,
    productionFiles,
    routes,
    domIds,
    domNavKeys,
  );
  const candidate = buildCandidateBoundary(
    coreHash,
    inventory,
    productionFiles,
    featureManifestFiles,
  );
  const failures = [
    ...productionSourceHits,
    ...apiHits,
    ...removedUiHits,
    ...legacySchemaHits,
    ...legacyFilesystemHits,
    ...activeResourceHits,
    ...testRootViolations,
    ...candidate.runtimeFileAccessHits,
  ];
  if (failures.length > 0) {
    throw new StaticAbsenceContractError(
      `Static absence proof has hits: ${uniqueSorted(failures).join(', ')}`,
    );
  }
  return {
    source_core_build_hash: coreHash,
    generated_by_tool_hash: toolHash,
    production_files: productionFiles,
    production_import_edges: importEdges,
    production_source_hits: productionSourceHits,
    web_routes: routes,
    removed_api_hits: apiHits,
    dom_ids: domIds,
    dom_nav_keys: domNavKeys,
    removed_ui_hits: removedUiHits,
    configured_filesystem_roots: configuredRoots,
    legacy_schema_hits: legacySchemaHits,
    legacy_filesystem_hits: legacyFilesystemHits,
    active_resource_hits: activeResourceHits,
    feature_manifest_files: featureManifestFiles,
    protected_fixture_hashes: protectedFixtureHashes,
    test_root_violations: testRootViolations,
    candidate_boundary: candidate.manifest,
    candidate_runtime_file_access_hits: candidate.runtimeFileAccessHits,
    candidate_scanned_content_file_count: 0,
  };
}

function fixtureBundleHash(kind: StaticAbsenceFixtureKind): Sha256Hash {
  return hashEvidence('icarus:workflow-runtime-removal-fixture-kind:1\n', {
    fixture_kind: kind,
    status: 'machine_checked',
  });
}

export function buildWorkflowRuntimeAbsenceBaseline(
  evidence: StaticAbsenceProofEvidence,
): WorkflowRuntimeAbsenceBaseline {
  const productionHash = hashEvidence(
    'icarus:workflow-runtime-production-source-absence:1\n',
    {
      entry_file_count: evidence.production_files.length,
      import_graph_hash: hashEvidence(
        'icarus:workflow-runtime-production-import-graph:1\n',
        evidence.production_import_edges,
      ),
      hits: evidence.production_source_hits,
    },
  );
  const apiHash = hashEvidence(
    'icarus:workflow-runtime-removed-api-negative-fixtures:1\n',
    {
      fixtures: [...REMOVED_API_FIXTURES],
      route_inventory_hash: hashEvidence(
        'icarus:workflow-runtime-web-route-inventory:1\n',
        evidence.web_routes,
      ),
      hits: evidence.removed_api_hits,
      expected_status: 404,
    },
  );
  const uiHash = hashEvidence(
    'icarus:workflow-runtime-removed-ui-negative-fixtures:1\n',
    {
      removed_nav_keys: [...REMOVED_DOM_NAV_KEYS],
      removed_screen_ids: [...REMOVED_DOM_SCREEN_IDS],
      dom_inventory_hash: hashEvidence(
        'icarus:workflow-runtime-electron-dom-inventory:1\n',
        {
          ids: evidence.dom_ids,
          nav_keys: evidence.dom_nav_keys,
        },
      ),
      hits: evidence.removed_ui_hits,
    },
  );
  const schemaHash = hashEvidence(
    'icarus:workflow-runtime-schema-absence:1\n',
    {
      inspector: 'sqlite_schema+pragma_table_info',
      scan_modes: ['fresh', 'configured_existing'],
      legacy_tables: [...LEGACY_SQLITE_TABLES],
      legacy_columns: [...LEGACY_SQLITE_COLUMNS],
      legacy_index_prefixes: [...LEGACY_SQLITE_INDEX_PREFIXES],
      hits: evidence.legacy_schema_hits,
    },
  );
  const filesystemHash = hashEvidence(
    'icarus:workflow-runtime-filesystem-absence:1\n',
    {
      configured_roots: evidence.configured_filesystem_roots,
      removed_root_basenames: [...REMOVED_DATA_ROOT_BASENAMES],
      hits: evidence.legacy_filesystem_hits,
    },
  );
  const resourceHash = hashEvidence(
    'icarus:workflow-runtime-active-resource-absence:1\n',
    {
      feature_manifest_files: evidence.feature_manifest_files,
      removed_resource_keys: [...REMOVED_FEATURE_RESOURCE_KEYS],
      removed_root_basenames: [...REMOVED_RESOURCE_ROOT_BASENAMES],
      hits: evidence.active_resource_hits,
    },
  );
  const protectedHash = hashEvidence(
    'icarus:workflow-runtime-protected-capability-fixtures:1\n',
    {
      fixture_hashes: evidence.protected_fixture_hashes,
    },
  );
  const testRootHash = hashEvidence(
    'icarus:workflow-runtime-test-root-isolation:1\n',
    {
      policy:
        'distinct_temporary_data_and_store_roots_outside_production_and_candidate',
      violations: evidence.test_root_violations,
    },
  );
  const withoutHash = {
    format: 'icarus.workflow-runtime-absence-baseline/1',
    source_core_build_hash: evidence.source_core_build_hash,
    generated_by_tool_hash: evidence.generated_by_tool_hash,
    production_source_absence_hash: productionHash,
    removed_api_negative_fixture_hash: apiHash,
    removed_ui_negative_fixture_hash: uiHash,
    schema_absence_hash: schemaHash,
    filesystem_absence_hash: filesystemHash,
    active_resource_absence_hash: resourceHash,
    protected_capability_fixture_hash: protectedHash,
    test_data_root_isolation_hash: testRootHash,
    migration_candidate_boundary_hash:
      evidence.candidate_boundary.boundary_hash,
  } satisfies JsonObject;
  return {
    ...withoutHash,
    baseline_hash: hashEvidence(
      'icarus:workflow-runtime-absence-baseline:1\n',
      withoutHash as unknown as JsonValue,
    ),
  } as unknown as WorkflowRuntimeAbsenceBaseline;
}

export function buildProductSurfaceCoverageManifest(
  evidence: StaticAbsenceProofEvidence,
  baseline: WorkflowRuntimeAbsenceBaseline,
): ProductSurfaceCoverageManifest {
  const removalHashes: Record<StaticAbsenceFixtureKind, Sha256Hash> = {
    source: baseline.production_source_absence_hash,
    api: baseline.removed_api_negative_fixture_hash,
    ui: baseline.removed_ui_negative_fixture_hash,
    schema: baseline.schema_absence_hash,
    filesystem: baseline.filesystem_absence_hash,
    resource: baseline.active_resource_absence_hash,
    protected_capability: baseline.protected_capability_fixture_hash,
    test_root: baseline.test_data_root_isolation_hash,
    candidate_production:
      evidence.candidate_boundary.production_import_reachability_hash,
    candidate_test_helper:
      evidence.candidate_boundary.test_helper_reachability_hash,
    candidate_setup: evidence.candidate_boundary.setup_reachability_hash,
    candidate_feature_registry:
      evidence.candidate_boundary.feature_registry_reachability_hash,
    candidate_compiler_fixture:
      evidence.candidate_boundary.compiler_fixture_reachability_hash,
    candidate_build_context:
      evidence.candidate_boundary.build_context_reachability_hash,
    candidate_release_artifact:
      evidence.candidate_boundary.release_artifact_reachability_hash,
    candidate_runtime_file_access:
      evidence.candidate_boundary.production_import_reachability_hash,
    surface: fixtureBundleHash('surface'),
  };
  const entries: ProductSurfaceCoverageEntry[] = PRODUCT_SURFACE_SEEDS.map(
    (seed) => {
      const contractFixtureHash = seed.protected_fixture_id
        ? (evidence.protected_fixture_hashes[seed.protected_fixture_id] ?? null)
        : null;
      const removalFixtureHash = seed.removal_fixture_kind
        ? removalHashes[seed.removal_fixture_kind]
        : null;
      const withoutHash = {
        surface_id: seed.surface_id,
        surface_kind: seed.surface_kind,
        owner_feature_id: seed.owner_feature_id,
        status: seed.status,
        replacement_ref: seed.replacement_ref,
        contract_fixture_hash: contractFixtureHash,
        removal_fixture_hash: removalFixtureHash,
      };
      if (
        (seed.status === 'active' &&
          (withoutHash.replacement_ref === null ||
            withoutHash.contract_fixture_hash === null ||
            withoutHash.removal_fixture_hash !== null)) ||
        (seed.status === 'removed' &&
          (withoutHash.replacement_ref !== null ||
            withoutHash.contract_fixture_hash !== null ||
            withoutHash.removal_fixture_hash === null))
      ) {
        throw new StaticAbsenceContractError(
          `Surface status contract drift: ${seed.surface_id}`,
        );
      }
      return {
        ...withoutHash,
        entry_hash: hashEvidence(
          'icarus:product-surface-coverage-entry:1\n',
          withoutHash as unknown as JsonValue,
        ),
      };
    },
  ).sort((left, right) => asciiCompare(left.surface_id, right.surface_id));
  const withoutHash = {
    format: 'icarus.product-surface-coverage/1',
    source_core_build_hash: evidence.source_core_build_hash,
    generated_by_tool_hash: evidence.generated_by_tool_hash,
    entries,
    active_surface_count: entries.filter((entry) => entry.status === 'active')
      .length,
    removed_surface_count: entries.filter((entry) => entry.status === 'removed')
      .length,
  } satisfies JsonObject;
  return {
    ...withoutHash,
    manifest_hash: hashEvidence(
      'icarus:product-surface-coverage:1\n',
      withoutHash as unknown as JsonValue,
    ),
  } as unknown as ProductSurfaceCoverageManifest;
}

export function buildStaticAbsenceContracts(): {
  evidence: StaticAbsenceProofEvidence;
  absenceBaseline: WorkflowRuntimeAbsenceBaseline;
  surfaceManifest: ProductSurfaceCoverageManifest;
  candidateBoundary: MigrationCandidateBoundaryManifest;
} {
  const evidence = buildStaticAbsenceProofEvidence();
  const absenceBaseline = buildWorkflowRuntimeAbsenceBaseline(evidence);
  const surfaceManifest = buildProductSurfaceCoverageManifest(
    evidence,
    absenceBaseline,
  );
  return {
    evidence,
    absenceBaseline,
    surfaceManifest,
    candidateBoundary: evidence.candidate_boundary,
  };
}

export function createIsolatedStaticGateTestRoots(): {
  root: string;
  dataRoot: string;
  storeRoot: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-static-gates-'));
  const dataRoot = path.join(root, 'data');
  const storeRoot = path.join(root, 'store');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(storeRoot);
  assertIsolatedTestRoots(dataRoot, storeRoot);
  return {
    root,
    dataRoot,
    storeRoot,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
