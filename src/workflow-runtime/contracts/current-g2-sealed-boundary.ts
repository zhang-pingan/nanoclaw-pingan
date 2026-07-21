import fs from 'node:fs';
import path from 'node:path';

export const CURRENT_G2_SEALED_DIRECTORY = 'g2-semantic-correction';

export type CurrentG2SealedBoundaryState = 'empty' | 'current_g2';

export function assertCurrentG2SealedBoundary(
  sealedRoot: string,
): CurrentG2SealedBoundaryState {
  const entries = fs.readdirSync(sealedRoot).sort();
  const gitkeep = path.join(sealedRoot, '.gitkeep');
  if (!fs.lstatSync(gitkeep).isFile()) {
    throw new Error('Golden sealed boundary is missing its .gitkeep file');
  }
  if (entries.length === 1 && entries[0] === '.gitkeep') return 'empty';
  if (
    entries.length !== 2 ||
    entries[0] !== '.gitkeep' ||
    entries[1] !== CURRENT_G2_SEALED_DIRECTORY
  ) {
    throw new Error('Golden sealed boundary contains an unknown entry');
  }
  const current = path.join(sealedRoot, CURRENT_G2_SEALED_DIRECTORY);
  const stat = fs.lstatSync(current);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Current G2 sealed boundary is not a regular directory');
  }
  return 'current_g2';
}
