import {
  checkContractPackCapacityControlPlane,
  generateContractPackCapacityControlPlane,
} from './capacity-control-plane-pack.js';

const command = process.argv[2];
if (
  process.argv.length !== 3 ||
  (command !== 'generate' && command !== 'check')
) {
  console.error('Usage: capacity-control-plane <generate|check>');
  process.exit(64);
}

try {
  const manifest =
    command === 'generate'
      ? generateContractPackCapacityControlPlane()
      : checkContractPackCapacityControlPlane();
  console.log(`capacity_control_plane=${command}:ok`);
  console.log(`capacity_control_plane_hash=${manifest.hash}`);
} catch (error) {
  console.error(
    `capacity_control_plane=${command}:failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
