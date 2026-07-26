import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkG4NodeOutputEnvelopeAuthoritySuccessor } from '../contracts/g4-node-output-envelope-authority-successor.js';
import { domainSeparatedSha256 } from '../contracts/hash.js';
import {
  WorkflowRuntimeConnectionFactory,
  type WorkflowRuntimeStore,
} from '../store/runtime-store/index.js';

const CURRENT_G4_SUCCESSOR_HASH =
  'sha256:510fd27b7b1d5698f35b42e4fc7846733c34206dbd55c611c79344e9f1a8ed93';

export class G5TestBootstrapInstance {
  readonly dataRoot: string;
  readonly databasePath: string;
  #store: WorkflowRuntimeStore | null;

  constructor(dataRoot: string, store: WorkflowRuntimeStore) {
    this.dataRoot = dataRoot;
    this.databasePath = path.join(dataRoot, 'workflow-runtime.db');
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
        identityMode: 'candidate_development',
      });
    }
    return this.#store;
  }

  cleanup(): void {
    this.closeStore();
    fs.rmSync(this.dataRoot, { recursive: true, force: true });
  }
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
