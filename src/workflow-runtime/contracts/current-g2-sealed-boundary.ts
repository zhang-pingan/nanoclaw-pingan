import fs from 'node:fs';
import path from 'node:path';

export const CURRENT_G2_SEALED_DIRECTORY = 'g2-semantic-correction';
export const G2_REPLAY_REPAIR_SUCCESSOR_SEALED_DIRECTORY =
  'g2-production-compiler-replay-repair-v2';
export const G2_CAPABILITY_OUTBOX_BINDING_SEALED_DIRECTORY =
  'g2-capability-outbox-binding-v3';

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
  const allowed = new Set([
    '.gitkeep',
    CURRENT_G2_SEALED_DIRECTORY,
    G2_REPLAY_REPAIR_SUCCESSOR_SEALED_DIRECTORY,
    G2_CAPABILITY_OUTBOX_BINDING_SEALED_DIRECTORY,
  ]);
  if (
    entries.some((entry) => !allowed.has(entry)) ||
    !entries.includes(CURRENT_G2_SEALED_DIRECTORY)
  ) {
    throw new Error('Golden sealed boundary contains an unknown entry');
  }
  for (const directory of entries.filter((entry) => entry !== '.gitkeep')) {
    const current = path.join(sealedRoot, directory);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Current G2 sealed boundary is not a regular directory');
    }
  }
  return 'current_g2';
}
