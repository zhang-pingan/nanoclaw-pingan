import axios from 'axios';

import { describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
  },
}));

import { ensureAppiumSession } from './ios-appium.js';
import type { IosSessionRecord } from './types.js';

function session(
  overrides: Partial<IosSessionRecord> = {},
): IosSessionRecord {
  return {
    session_id: 'SESSION-001',
    service: 'catstory',
    purpose: 'test',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    simulator_name: 'iPhone 17',
    simulator_udid: 'SIM-001',
    bundle_id: 'net.maoli.history.cn',
    build_id: 'BUILD-001',
    state_id: 'STATE-001',
    artifact_dir: '',
    ios_repo_host_path: '/tmp/catapp',
    backend_repo_host_path: null,
    config: {
      service: 'catstory',
      automation: {
        launch_args: ['-UITestMode', '1'],
        launch_env: {
          ICARUS_NETWORK_LOG_ENABLED: '1',
        },
      },
    },
    ...overrides,
  };
}

describe('ensureAppiumSession', () => {
  it('passes session launch args and env to XCUITest process arguments', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { value: { sessionId: 'APPIUM-001' } },
    });

    const sessionId = await ensureAppiumSession(session(), {
      serverUrl: 'http://127.0.0.1:4723',
    });

    expect(sessionId).toBe('APPIUM-001');
    expect(axios.post).toHaveBeenCalledWith(
      'http://127.0.0.1:4723/session',
      expect.objectContaining({
        capabilities: {
          alwaysMatch: expect.objectContaining({
            'appium:bundleId': 'net.maoli.history.cn',
            'appium:processArguments': {
              args: ['-UITestMode', '1'],
              env: {
                ICARUS_NETWORK_LOG_ENABLED: '1',
              },
            },
          }),
          firstMatch: [{}],
        },
      }),
      { timeout: 15_000 },
    );
  });
});
