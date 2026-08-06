import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkGatewayImports,
  inspectGatewayImports,
} from './gateway-boundary.js';

describe('Workflow Runtime gateway boundary', () => {
  it('allows only purpose gateways and public contract helpers', () => {
    expect(() => checkGatewayImports()).not.toThrow();
  });

  it('reports the importing file and forbidden module path', () => {
    const importer = path.resolve(import.meta.dirname, '../../example.ts');
    expect(
      inspectGatewayImports(
        importer,
        "import './workflow-runtime/store/runtime-store/index.js';",
      ),
    ).toEqual([
      {
        importer: 'example.ts',
        modulePath: './workflow-runtime/store/runtime-store/index.js',
      },
    ]);
  });
});
