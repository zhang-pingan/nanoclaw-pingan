import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../..');
const RUNTIME_ROOT = path.join(SOURCE_ROOT, 'workflow-runtime');

const ALLOWED_RUNTIME_TARGETS = new Set([
  'gateway/connection',
  'gateway/execution',
  'gateway/host-core',
  'gateway/workspace',
  'contracts/hash',
  'contracts/strict-json',
  'contracts/types',
]);

export interface GatewayImportViolation {
  readonly importer: string;
  readonly modulePath: string;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Source symlink is forbidden: ${absolute}`);
    }
    if (entry.isDirectory()) {
      if (
        absolute !== RUNTIME_ROOT &&
        !absolute.startsWith(`${RUNTIME_ROOT}${path.sep}`)
      ) {
        files.push(...sourceFiles(absolute));
      }
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files.sort();
}

function importedModulePaths(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const paths: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      paths.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      paths.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return paths;
}

function runtimeTarget(importer: string, modulePath: string): string | null {
  if (!modulePath.startsWith('.')) return null;
  let resolved = path.resolve(path.dirname(importer), modulePath);
  resolved = resolved.replace(/\.js$/, '').replace(/\.ts$/, '');
  const runtimeWithoutExtension = RUNTIME_ROOT.replace(/\.ts$/, '');
  if (!resolved.startsWith(`${runtimeWithoutExtension}${path.sep}`))
    return null;
  return path
    .relative(runtimeWithoutExtension, resolved)
    .split(path.sep)
    .join('/');
}

export function inspectGatewayImports(
  importer: string,
  source: string,
): GatewayImportViolation[] {
  const importerRelative = path
    .relative(SOURCE_ROOT, importer)
    .split(path.sep)
    .join('/');
  return importedModulePaths(source, importer)
    .map((modulePath) => ({
      modulePath,
      target: runtimeTarget(importer, modulePath),
    }))
    .filter(({ target }) => target && !ALLOWED_RUNTIME_TARGETS.has(target))
    .map(({ modulePath }) => ({ importer: importerRelative, modulePath }));
}

export function checkGatewayImports(): void {
  const violations = sourceFiles(SOURCE_ROOT).flatMap((file) =>
    inspectGatewayImports(file, fs.readFileSync(file, 'utf8')),
  );
  if (violations.length > 0) {
    throw new Error(
      `Runtime gateway bypass:\n${violations
        .map((entry) => `${entry.importer}: ${entry.modulePath}`)
        .join('\n')}`,
    );
  }
}
