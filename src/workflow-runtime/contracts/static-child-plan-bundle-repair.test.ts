import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseContractArtifactEnvelope } from './artifact.js';
import { strictParseJsonBytes } from './strict-json.js';
import {
  checkStaticChildPlanBundleRepair,
  STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS,
} from './static-child-plan-bundle-repair.js';

const contractsRoot = import.meta.dirname;

describe('static child Plan bundle directed repair Contract', () => {
  it('checks the additive candidate and its frozen v6 predecessor binding', () => {
    const pack = checkStaticChildPlanBundleRepair();
    expect(pack.payload.status).toBe(
      'DIRECTED_REPAIR_CANDIDATE_PENDING_INDEPENDENT_AFFECTED_CHAIN_REGRESSION',
    );
    expect(pack.payload.g2_g5_closed).toBe(false);
    expect(pack.payload.g6_ready).toBe(false);
    expect(pack.payload.independent_review_required).toBe(true);
  });

  it.each([
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.positive, 4],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.negative, 12],
    [STATIC_CHILD_PLAN_BUNDLE_REPAIR_PATHS.fault, 6],
  ])('keeps %s closed with %i unique cases', (relativePath, count) => {
    const artifact = parseContractArtifactEnvelope(
      strictParseJsonBytes(
        fs.readFileSync(path.join(contractsRoot, relativePath)),
      ),
    );
    const cases = artifact.payload.cases as Array<Record<string, unknown>>;
    expect(cases).toHaveLength(count);
    expect(new Set(cases.map((entry) => entry.case_id)).size).toBe(count);
    expect(
      cases.every(
        (entry) =>
          Object.keys(entry).sort().join(',') === 'assertion,case_id' &&
          typeof entry.case_id === 'string' &&
          typeof entry.assertion === 'string',
      ),
    ).toBe(true);
  });
});
