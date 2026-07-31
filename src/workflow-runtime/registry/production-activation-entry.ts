import fs from 'node:fs';
import path from 'node:path';

import { parseSha256Hash } from '../contracts/hash.js';
import { WorkflowRuntimeConnectionFactory } from '../store/runtime-store/index.js';
import {
  readG9ProductionActivationRequestFile,
  recoverG9ProductionActivation,
  runG9ProductionActivation,
} from './production-activation.js';
import { createG9ProductionActivationParticipants } from './production-activation-runtime.js';

function runtimeLayout(): { runtimeHome: string; releaseRoot: string } {
  const executable = fs.realpathSync(process.execPath);
  const marker = `${path.sep}toolchains${path.sep}node${path.sep}`;
  const index = executable.indexOf(marker);
  if (index <= 0)
    throw new Error('production_activation_managed_node_required');
  const runtimeHome = fs.realpathSync(executable.slice(0, index));
  const releaseRoot = fs.realpathSync(
    path.resolve(import.meta.dirname, '../../../..'),
  );
  return { runtimeHome, releaseRoot };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length)
    throw new Error(`production_activation_argument_missing:${name}`);
  return process.argv[index + 1];
}

const operation = process.argv[2];
if (
  (operation !== 'activate' && operation !== 'recover') ||
  process.argv.length !== 5 ||
  process.argv[3] !== '--audit-hash'
)
  throw new Error(
    'Usage: production-activation-entry.js <activate|recover> --audit-hash sha256:<hex>',
  );

const { runtimeHome, releaseRoot } = runtimeLayout();
const auditHash = parseSha256Hash(argument('--audit-hash'));
const requestPath = path.join(
  runtimeHome,
  'activation-requests',
  auditHash.slice('sha256:'.length),
  'production-activation-request.json',
);
const request = readG9ProductionActivationRequestFile(requestPath);
if (request.audit.audit_hash !== auditHash || request.operation !== 'activate')
  throw new Error('production_activation_request_selection_mismatch');

const dataRoot = path.join(runtimeHome, 'data/workflow-runtime');
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
const databasePath = path.join(dataRoot, 'workflow-runtime.db');
const store = WorkflowRuntimeConnectionFactory.openStore({
  databasePath,
  databaseMode: fs.existsSync(databasePath) ? 'open_existing' : 'create',
  identityMode: 'production_activation',
});
try {
  const participants = createG9ProductionActivationParticipants({
    runtimeHome,
    releaseRoot,
    store,
    request,
  });
  const outcome =
    operation === 'activate'
      ? runG9ProductionActivation(runtimeHome, request, participants)
      : recoverG9ProductionActivation(runtimeHome, request, participants);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
} finally {
  store.close();
}
