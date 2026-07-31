import fs from 'node:fs';
import path from 'node:path';

const projectRoot = fs.realpathSync(path.resolve(import.meta.dirname, '..'));
const outputRoot = path.join(projectRoot, 'dist');

if (
  path.dirname(outputRoot) !== projectRoot ||
  path.basename(outputRoot) !== 'dist'
) {
  throw new Error('TypeScript output root identity is invalid');
}

let outputStat = null;
try {
  outputStat = fs.lstatSync(outputRoot);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (outputStat) {
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error('TypeScript output root must be a local directory');
  }
  fs.rmSync(outputRoot, { recursive: true });
}
