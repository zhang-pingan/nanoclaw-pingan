import {
  checkStaticChildPlanBundleRepair,
  generateStaticChildPlanBundleRepair,
} from './static-child-plan-bundle-repair.js';

const mode = process.argv[2];
if (mode === 'generate') {
  const pack = generateStaticChildPlanBundleRepair();
  console.log(`static_child_plan_bundle_repair=${pack.hash}`);
} else if (mode === 'check') {
  const pack = checkStaticChildPlanBundleRepair();
  console.log(`static_child_plan_bundle_repair=${pack.hash}`);
} else {
  console.error('Usage: static-child-plan-bundle-repair <generate|check>');
  process.exitCode = 2;
}
