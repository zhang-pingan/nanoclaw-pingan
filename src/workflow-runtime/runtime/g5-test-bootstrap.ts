import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkG4NodeOutputEnvelopeAuthoritySuccessor } from '../contracts/g4-node-output-envelope-authority-successor.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';
import type { WorkflowRuntimeIdentityMode } from '../store/runtime-store/identity.js';

const CURRENT_G4_SUCCESSOR_HASH =
  'sha256:1cd67bad72a3fb147db7943d669800c2f56fabf4c255d42af8f7704f0e9a0cae';

export class G5TestBootstrapInstance {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly identityMode: WorkflowRuntimeIdentityMode;
  #store: WorkflowRuntimeStore | null;

  constructor(
    dataRoot: string,
    store: WorkflowRuntimeStore,
    identityMode: WorkflowRuntimeIdentityMode = 'candidate_development',
  ) {
    this.dataRoot = dataRoot;
    this.databasePath = path.join(dataRoot, 'workflow-runtime.db');
    this.identityMode = identityMode;
    this.#store = store;
  }

  get store(): WorkflowRuntimeStore {
    if (!this.#store) throw new Error('G5 test bootstrap Store is closed');
    return this.#store;
  }

  closeStore(): void {
    this.#store?.close();
    this.#store = null;
  }

  reopenStore(): WorkflowRuntimeStore {
    if (!this.#store) {
      this.#store = WorkflowRuntimeConnectionFactory.openStore({
        databasePath: this.databasePath,
        databaseMode: 'open_existing',
        identityMode: this.identityMode,
      });
    }
    return this.#store;
  }

  cleanup(): void {
    this.closeStore();
    fs.rmSync(this.dataRoot, { recursive: true, force: true });
  }
}

export function openG5IsolatedBootstrap(
  dataRoot: string,
  identityMode: WorkflowRuntimeIdentityMode,
): G5TestBootstrapInstance {
  const canonicalRoot = fs.realpathSync(dataRoot);
  if (
    !fs.statSync(canonicalRoot).isDirectory() ||
    fs.readdirSync(canonicalRoot).length !== 0
  ) {
    throw new Error(
      'Isolated bootstrap root must be an existing empty directory',
    );
  }
  const databasePath = path.join(canonicalRoot, 'workflow-runtime.db');
  const store = WorkflowRuntimeConnectionFactory.openStore({
    databasePath,
    databaseMode: 'create',
    identityMode,
  });
  return new G5TestBootstrapInstance(canonicalRoot, store, identityMode);
}

export function createG5TestBootstrap(
  instanceKey: string,
): G5TestBootstrapInstance {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(instanceKey))
    throw new Error('G5 test bootstrap instance key is invalid');
  const g4 = checkG4NodeOutputEnvelopeAuthoritySuccessor();
  if (g4.hash !== CURRENT_G4_SUCCESSOR_HASH)
    throw new Error('Current G4 successor identity drifted');
  const suffix = domainSeparatedSha256(
    'icarus:workflow-g5-test-bootstrap:1\n',
    { instance_key: instanceKey },
  ).slice('sha256:'.length, 'sha256:'.length + 16);
  const dataRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), `icarus-g5-${suffix}-`),
  );
  const databasePath = path.join(dataRoot, 'workflow-runtime.db');
  try {
    const store = WorkflowRuntimeConnectionFactory.openStore({
      databasePath,
      databaseMode: 'create',
      identityMode: 'candidate_development',
    });
    return new G5TestBootstrapInstance(dataRoot, store);
  } catch (error) {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    throw error;
  }
}
