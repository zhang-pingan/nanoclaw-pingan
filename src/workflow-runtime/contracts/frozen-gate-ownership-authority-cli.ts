import { checkFrozenGateOwnershipAuthority } from './frozen-gate-ownership-authority.js';

const command = process.argv[2];
if (process.argv.length !== 3 || (command !== 'generate' && command !== 'check')) {
  console.error('Usage: frozen-gate-ownership-authority <generate|check>');
  process.exit(64);
}

try {
  const authority = checkFrozenGateOwnershipAuthority();
  console.log(`frozen_gate_ownership=${command}:ok`);
  console.log(`authority_hash=${authority.hash}`);
  console.log('write_performed=false');
} catch (error) {
  console.error(
    `frozen_gate_ownership=${command}:failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
}
