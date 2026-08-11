import http from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import type { WorkflowPackManager } from './management.js';
import { WorkflowPackWebApi } from './web-api.js';

function managerStub() {
  return {
    list: vi.fn(() => [{ pack_id: 'example-pack' }]),
    setDesiredEnabled: vi.fn((packId: string, enabled: boolean) => ({
      restart_required: true,
      desired_enabled: enabled,
      runtime_disabled: !enabled,
      pack_id: packId,
    })),
    uninstall: vi.fn(() => ({
      archived_path: '/archive/example-pack',
      restart_required: true,
    })),
    purgePreview: vi.fn(() => ({
      pack_id: 'example-pack',
      managed_paths: [],
      registry_resource_ids: [],
      retained_release_count: 1,
      active_run_pins: 0,
      preserves: [
        'task_sessions',
        'runtime_history',
        'shared_artifacts',
        'audit',
        'external_workspaces',
      ],
    })),
    purge: vi.fn(() => ({ pack_id: 'example-pack' })),
  };
}

async function withApiServer(
  api: WorkflowPackWebApi,
  work: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    void api
      .handle(req, res, new URL(req.url ?? '/', 'http://localhost'))
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  try {
    await work(`http://127.0.0.1:${String(address.port)}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function request(
  baseUrl: string,
  pathname: string,
  options: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe('Workflow Pack Web API', () => {
  it('exposes only the fixed Pack management route set', async () => {
    const manager = managerStub();
    const api = new WorkflowPackWebApi(
      manager as unknown as WorkflowPackManager,
    );
    await withApiServer(api, async (baseUrl) => {
      expect(await request(baseUrl, '/api/workflow-packs')).toMatchObject({
        status: 200,
        body: { packs: [{ pack_id: 'example-pack' }] },
      });
      expect(
        await request(baseUrl, '/api/workflow-packs/example-pack/enable', {
          method: 'POST',
        }),
      ).toMatchObject({
        status: 200,
        body: { ok: true, desired_enabled: true },
      });
      expect(
        await request(baseUrl, '/api/workflow-packs/example-pack/disable', {
          method: 'POST',
        }),
      ).toMatchObject({
        status: 200,
        body: { ok: true, desired_enabled: false },
      });
      expect(
        await request(
          baseUrl,
          '/api/workflow-packs/example-pack/purge-preview',
        ),
      ).toMatchObject({
        status: 200,
        body: { preview: { pack_id: 'example-pack' } },
      });
      expect(await request(baseUrl, '/api/features/enabled')).toMatchObject({
        status: 404,
      });
    });
    expect(manager.setDesiredEnabled).toHaveBeenNthCalledWith(
      1,
      'example-pack',
      true,
    );
    expect(manager.setDesiredEnabled).toHaveBeenNthCalledWith(
      2,
      'example-pack',
      false,
    );
  });

  it('requires the exact confirmation body for destructive actions', async () => {
    const manager = managerStub();
    const api = new WorkflowPackWebApi(
      manager as unknown as WorkflowPackManager,
    );
    await withApiServer(api, async (baseUrl) => {
      for (const body of [
        {},
        { confirm: false },
        { confirm: true, extra: 1 },
      ]) {
        expect(
          await request(baseUrl, '/api/workflow-packs/example-pack/uninstall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        ).toMatchObject({ status: 400 });
      }
      expect(manager.uninstall).not.toHaveBeenCalled();
      expect(
        await request(baseUrl, '/api/workflow-packs/example-pack/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        }),
      ).toMatchObject({ status: 200, body: { ok: true } });
      expect(
        await request(baseUrl, '/api/workflow-packs/example-pack/purge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        }),
      ).toMatchObject({ status: 200, body: { ok: true } });
    });
    expect(manager.uninstall).toHaveBeenCalledOnce();
    expect(manager.purge).toHaveBeenCalledOnce();
  });

  it('rejects unsupported methods and invalid encoded Pack ids', async () => {
    const manager = managerStub();
    const api = new WorkflowPackWebApi(
      manager as unknown as WorkflowPackManager,
    );
    await withApiServer(api, async (baseUrl) => {
      expect(
        await request(baseUrl, '/api/workflow-packs/example-pack/enable'),
      ).toMatchObject({ status: 405 });
      expect(
        await request(baseUrl, '/api/workflow-packs/bad%2Fid/purge-preview'),
      ).toMatchObject({ status: 400 });
    });
    expect(manager.purgePreview).not.toHaveBeenCalled();
  });
});
