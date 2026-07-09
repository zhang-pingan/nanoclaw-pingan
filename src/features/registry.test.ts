import { describe, expect, it } from 'vitest';

import { ApiRouteRegistry } from './registry.js';

describe('feature API route registry', () => {
  it('dispatches exact feature routes under the declared prefix', async () => {
    const registry = new ApiRouteRegistry();
    let called = false;
    registry.register({
      featureId: 'example-feature',
      apiPrefix: '/api/features/example-feature',
      method: 'GET',
      path: '/api/features/example-feature/ping',
      handler: ({ res }) => {
        called = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
    });

    const writes: string[] = [];
    const handled = await registry.dispatch({
      req: { method: 'GET' } as never,
      res: {
        writeHead: () => undefined,
        end: (chunk: string) => writes.push(chunk),
      } as never,
      url: new URL('http://localhost/api/features/example-feature/ping'),
    });

    expect(handled).toBe(true);
    expect(called).toBe(true);
    expect(writes).toEqual(['{"ok":true}']);
  });

  it('rejects paths outside the feature API prefix', () => {
    const registry = new ApiRouteRegistry();

    expect(() =>
      registry.register({
        featureId: 'example-feature',
        apiPrefix: '/api/features/example-feature',
        method: 'GET',
        path: '/api/other/ping',
        handler: () => undefined,
      }),
    ).toThrow(/must stay under/);
  });

  it('detects method and path conflicts', () => {
    const registry = new ApiRouteRegistry();
    const route = {
      apiPrefix: '/api/features/example-feature',
      method: 'GET' as const,
      path: '/api/features/example-feature/ping',
      handler: () => undefined,
    };
    registry.register({ featureId: 'example-feature', ...route });

    expect(() =>
      registry.register({ featureId: 'another-feature', ...route }),
    ).toThrow(/conflict/);
  });

  it('detects prefix and exact route overlaps', () => {
    const registry = new ApiRouteRegistry();
    registry.registerPrefix({
      featureId: 'example-feature',
      apiPrefix: '/api/features/example-feature',
      prefix: '/api/features/example-feature',
      handler: () => undefined,
    });

    expect(() =>
      registry.register({
        featureId: 'another-feature',
        apiPrefix: '/api/features/another-feature',
        method: 'GET',
        path: '/api/features/another-feature/ping',
        handler: () => undefined,
      }),
    ).not.toThrow();
    expect(() =>
      registry.register({
        featureId: 'example-feature',
        apiPrefix: '/api/features/example-feature',
        method: 'GET',
        path: '/api/features/example-feature/ping',
        handler: () => undefined,
      }),
    ).toThrow(/overlaps prefix/);
  });
});
