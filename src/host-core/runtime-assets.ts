import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME_ASSET_PATTERN = /\.(?:json|sql)$/u;

export function copyWorkflowRuntimeAssets(
  projectRoot: string,
  outputRoot: string,
): void {
  const sourceRoot = path.join(projectRoot, 'src', 'workflow-runtime');
  if (!fs.lstatSync(sourceRoot).isDirectory())
    throw new Error('Workflow Runtime asset source must be a directory');

  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Workflow Runtime asset symlink rejected: ${source}`);
      if (entry.isDirectory()) {
        visit(source);
        continue;
      }
      if (!entry.isFile() || !RUNTIME_ASSET_PATTERN.test(entry.name)) continue;
      const relative = path.relative(sourceRoot, source);
      const target = path.join(outputRoot, 'workflow-runtime', relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  };

  visit(sourceRoot);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const projectRoot = path.resolve(import.meta.dirname, '../..');
  copyWorkflowRuntimeAssets(projectRoot, path.join(projectRoot, 'dist'));
}
