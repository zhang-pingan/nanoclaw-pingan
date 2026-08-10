import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { assertSafeWorkflowPackId } from './manifest.js';

export interface WorkflowPackManagedDataRoot {
  readonly pack_id: string;
  readonly root_path: string;
  readonly managed: true;
}

export function getWorkflowPackManagedDataRoot(
  packId: string,
): WorkflowPackManagedDataRoot {
  const safePackId = assertSafeWorkflowPackId(packId);
  return {
    pack_id: safePackId,
    root_path: path.join(DATA_DIR, 'workflow-packs', safePackId),
    managed: true,
  };
}
