import { checkG2V6FrozenReplay } from './g2-v6-frozen-replay.js';

if (process.argv[2] !== 'check') {
  console.error('Usage: g2-v6-frozen-replay check');
  process.exitCode = 2;
} else {
  const result = checkG2V6FrozenReplay();
  console.log(`g2_v6_frozen_replay=${result.exactCount}/40`);
  console.log(`g2_v6_frozen_bundle=${result.bundleHash}`);
}
