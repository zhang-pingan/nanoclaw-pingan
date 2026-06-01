import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ios-appium.js', () => ({
  actWithAppium: vi.fn(),
  observeWithAppium: vi.fn(),
}));

vi.mock('./ios-simulator.js', () => ({
  bootSimulator: vi.fn(),
  buildIosApp: vi.fn(),
  checkoutGitBranch: vi.fn(),
  findSimulatorDevice: vi.fn(),
  getAppContainerPath: vi.fn(),
  getInstalledAppPath: vi.fn(),
  installIosApp: vi.fn(),
  launchIosApp: vi.fn(),
  openDeepLink: vi.fn(),
  runHostCommand: vi.fn(),
  runDebugShellCommand: vi.fn(),
  terminateIosApp: vi.fn(),
  uninstallIosApp: vi.fn(),
  withIosSimulatorLock: async <T>(fn: () => Promise<T>) => fn(),
}));

import { actWithAppium, observeWithAppium } from './ios-appium.js';
import { IosAppRequestDispatcher } from './ios-app-request-dispatcher.js';
import { IosEvidenceStore } from './ios-evidence-store.js';
import { readIosTrace } from './ios-network-log.js';
import {
  checkoutGitBranch,
  findSimulatorDevice,
  getAppContainerPath,
  launchIosApp,
  runHostCommand,
} from './ios-simulator.js';
import { searchIosCode } from './ios-source-index.js';
import type { IosSessionRecord } from './types.js';

const tempDirs: string[] = [];

function makeStore(): IosEvidenceStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ios-dispatcher-'));
  tempDirs.push(dir);
  return new IosEvidenceStore({ rootDir: dir });
}

function createSession(
  store: IosEvidenceStore,
  overrides: Partial<IosSessionRecord> = {},
): IosSessionRecord {
  const session: IosSessionRecord = {
    session_id: 'SESSION-001',
    service: 'catstory',
    purpose: 'test',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    simulator_name: 'iPhone 16',
    simulator_udid: 'SIM-001',
    bundle_id: 'com.example.catstory',
    build_id: 'BUILD-001',
    state_id: 'STATE-001',
    artifact_dir: '',
    ios_repo_host_path: '/tmp/catstory-ios',
    backend_repo_host_path: null,
    config: {
      service: 'catstory',
      automation: {},
    },
    ...overrides,
  };
  store.createSessionRecord(session);
  store.createEvidence({
    id: session.session_id,
    type: 'SESSION',
    session_id: session.session_id,
    source: 'test',
    summary: 'session',
  });
  return session;
}

function mockSuccessfulObservation() {
  vi.mocked(observeWithAppium).mockResolvedValue({
    id: 'OBS-MOCK',
    session_id: 'SESSION-001',
    screen: { name: 'Profile', title: 'Profile' },
    artifacts: {},
    elements: [
      {
        ref: '@ios-id-cHJvZmlsZS5zYXZlLmJ1dHRvbg',
        type: 'XCUIElementTypeButton',
        identifier: 'profile.save.button',
        label: 'Save',
        enabled: true,
        visible: true,
        clickable: true,
      },
    ],
    network_cursor: '2026-06-01T00:00:01.000Z',
    app_state: {
      keyboard_visible: false,
      system_alert_visible: false,
      loading: false,
    },
    raw_screenshot_base64: '',
    raw_ui_tree: '',
  });
}

afterEach(() => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  mockSuccessfulObservation();
  vi.mocked(findSimulatorDevice).mockResolvedValue({
    name: 'iPhone 16',
    udid: 'SIM-001',
    state: 'Booted',
  });
  vi.mocked(checkoutGitBranch).mockResolvedValue({
    command: 'git',
    args: ['checkout', 'feature/ios'],
    exit_code: 0,
    stdout: '',
    stderr: '',
    duration_ms: 10,
  });
  vi.mocked(runHostCommand).mockResolvedValue({
    command: 'git',
    args: ['rev-parse', 'HEAD'],
    exit_code: 0,
    stdout: 'abc123\n',
    stderr: '',
    duration_ms: 10,
  });
  vi.mocked(launchIosApp).mockResolvedValue(undefined);
});

describe('IosAppRequestDispatcher prepare_session', () => {
  it('checks out explicit ios_branch before launching the app', async () => {
    const store = makeStore();
    const repoName = path.basename(process.cwd());
    const repoDir = process.cwd();

    const result = await new IosAppRequestDispatcher(store).dispatch(
      {
        action: 'prepare_session',
        args: {
          service: 'catstory',
          ios_branch: 'feature/ios-ready',
          registry: {
            catstory: {
              clients: {
                ios: {
                  repo_path: repoName,
                  scheme: 'CatstoryDebug',
                  bundle_id: 'com.example.catstory',
                  simulator: 'iPhone 16',
                },
              },
            },
          },
        },
      },
      { sourceGroup: 'test', isMain: true },
    );

    expect(result).toMatchObject({ status: 'ready' });
    expect(checkoutGitBranch).toHaveBeenCalledWith(
      repoDir,
      'feature/ios-ready',
    );
    expect(launchIosApp).toHaveBeenCalledWith(
      expect.objectContaining({
        udid: 'SIM-001',
        bundleId: 'com.example.catstory',
      }),
    );
    const session = store.getSession(
      (result as { session_id: string }).session_id,
    );
    expect(session?.config.ios_branch).toBe('feature/ios-ready');
  });
});

describe('IosAppRequestDispatcher run_test_case', () => {
  it('fails a case that has no assertions', async () => {
    const store = makeStore();
    createSession(store);
    vi.mocked(actWithAppium).mockResolvedValue({
      id: 'ACT-001',
      type: 'tap',
      target: {
        strategy: 'accessibility_id',
        value: 'profile.save.button',
        matched_count: 1,
      },
      time_window: {
        started_at: '2026-06-01T00:00:01.000Z',
        ended_at: '2026-06-01T00:00:02.000Z',
      },
      status: 'success',
      wait: { type: 'none' },
    });

    const result = await new IosAppRequestDispatcher(store).dispatch(
      {
        action: 'run_test_case',
        args: {
          session_id: 'SESSION-001',
          case_id: 'TC-empty',
          steps: [{ action: 'tap', target: 'profile.save.button' }],
          assertions: [],
        },
      },
      { sourceGroup: 'test', isMain: true },
    );

    expect(result).toMatchObject({
      case_id: 'TC-empty',
      result: 'failed',
      flow_status: 'success',
    });
    expect((result as { errors?: string[] }).errors).toContain(
      'test case must contain at least one assertion',
    );
  });

  it('fails a case when the flow is blocked even if assertions pass', async () => {
    const store = makeStore();
    createSession(store);
    vi.mocked(actWithAppium).mockResolvedValue({
      id: 'ACT-001',
      type: 'tap',
      target: {
        strategy: 'accessibility_id',
        value: 'profile.save.button',
        matched_count: 0,
      },
      time_window: {
        started_at: '2026-06-01T00:00:01.000Z',
        ended_at: '2026-06-01T00:00:02.000Z',
      },
      status: 'blocked',
      error: 'No element matched accessibility_id: profile.save.button',
    });

    const result = await new IosAppRequestDispatcher(store).dispatch(
      {
        action: 'run_test_case',
        args: {
          session_id: 'SESSION-001',
          case_id: 'TC-blocked',
          steps: [{ action: 'tap', target: 'profile.save.button' }],
          assertions: [{ type: 'ui_text', contains: 'Profile' }],
        },
      },
      { sourceGroup: 'test', isMain: true },
    );

    expect(result).toMatchObject({
      case_id: 'TC-blocked',
      result: 'failed',
      flow_status: 'blocked',
    });
  });

  it('fails network_absent when network trace is not configured', async () => {
    const store = makeStore();
    createSession(store);
    vi.mocked(actWithAppium).mockResolvedValue({
      id: 'ACT-001',
      type: 'tap',
      target: {
        strategy: 'accessibility_id',
        value: 'profile.save.button',
        matched_count: 1,
      },
      time_window: {
        started_at: '2026-06-01T00:00:01.000Z',
        ended_at: '2026-06-01T00:00:02.000Z',
      },
      status: 'success',
      wait: { type: 'none' },
    });

    const result = await new IosAppRequestDispatcher(store).dispatch(
      {
        action: 'run_test_case',
        args: {
          session_id: 'SESSION-001',
          case_id: 'TC-network-absent',
          steps: [{ action: 'tap', target: 'profile.save.button' }],
          assertions: [{ type: 'network_absent', path: '/api/user/profile' }],
        },
      },
      { sourceGroup: 'test', isMain: true },
    );

    expect(result).toMatchObject({
      case_id: 'TC-network-absent',
      result: 'failed',
    });
    expect(
      (result as { assertions?: Array<{ error?: string }> }).assertions?.[0]
        ?.error,
    ).toBe('network trace is not configured for this session');
  });

  it('fails crash_absent when crash trace is not configured', async () => {
    const store = makeStore();
    createSession(store);

    const result = await new IosAppRequestDispatcher(store).dispatch(
      {
        action: 'run_test_case',
        args: {
          session_id: 'SESSION-001',
          case_id: 'TC-crash-absent',
          steps: [],
          assertions: [{ type: 'crash_absent' }],
        },
      },
      { sourceGroup: 'test', isMain: true },
    );

    expect(result).toMatchObject({
      case_id: 'TC-crash-absent',
      result: 'failed',
    });
    expect(
      (result as { assertions?: Array<{ error?: string }> }).assertions?.[0]
        ?.error,
    ).toBe('crash trace is not configured for this session');
  });

  it('requires a passed UI or state assertion for a passed case', async () => {
    const store = makeStore();
    createSession(store, {
      config: {
        service: 'catstory',
        automation: {
          network_log_path: 'Library/Caches/IcarusNetworkLog/network.jsonl',
        },
      },
    });
    vi.mocked(actWithAppium).mockResolvedValue({
      id: 'ACT-001',
      type: 'tap',
      target: {
        strategy: 'accessibility_id',
        value: 'profile.save.button',
        matched_count: 1,
      },
      time_window: {
        started_at: '2026-06-01T00:00:01.000Z',
        ended_at: '2026-06-01T00:00:02.000Z',
      },
      status: 'success',
      wait: { type: 'none' },
    });
    const appContainer = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-ios-app-'),
    );
    tempDirs.push(appContainer);
    const logDir = path.join(
      appContainer,
      'Library',
      'Caches',
      'IcarusNetworkLog',
    );
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'network.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-06-01T00:00:01.500Z',
        method: 'PATCH',
        path: '/api/user/profile',
        status: 200,
      })}\n`,
    );
    vi.mocked(getAppContainerPath).mockResolvedValue(appContainer);

    const result = await new IosAppRequestDispatcher(store).dispatch(
      {
        action: 'run_test_case',
        args: {
          session_id: 'SESSION-001',
          case_id: 'TC-network-only',
          steps: [{ action: 'tap', target: 'profile.save.button' }],
          assertions: [
            {
              type: 'network',
              path: '/api/user/profile',
              method: 'PATCH',
              status: 200,
            },
          ],
        },
      },
      { sourceGroup: 'test', isMain: true },
    );

    expect(result).toMatchObject({
      case_id: 'TC-network-only',
      result: 'failed',
    });
    expect((result as { errors?: string[] }).errors).toContain(
      'test case must contain at least one passed UI or state assertion',
    );
  });

  it('passes a case with a matching app_state assertion', async () => {
    const store = makeStore();
    createSession(store);

    const result = await new IosAppRequestDispatcher(store).dispatch(
      {
        action: 'run_test_case',
        args: {
          session_id: 'SESSION-001',
          case_id: 'TC-app-state',
          steps: [],
          assertions: [
            {
              type: 'app_state',
              expected: {
                keyboard_visible: false,
                system_alert_visible: false,
                loading: false,
              },
            },
          ],
        },
      },
      { sourceGroup: 'test', isMain: true },
    );

    expect(result).toMatchObject({
      case_id: 'TC-app-state',
      result: 'passed',
      flow_status: 'success',
    });
  });
});

describe('readIosTrace', () => {
  it('filters network events to the referenced action time window', async () => {
    const store = makeStore();
    const appContainer = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-ios-app-'),
    );
    tempDirs.push(appContainer);
    const logDir = path.join(
      appContainer,
      'Library',
      'Caches',
      'IcarusNetworkLog',
    );
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, 'network.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-06-01T00:00:00.000Z',
          method: 'PATCH',
          path: '/api/user/profile',
          status: 200,
        }),
        JSON.stringify({
          timestamp: '2026-06-01T00:00:01.500Z',
          method: 'PATCH',
          path: '/api/user/profile',
          status: 200,
        }),
      ].join('\n') + '\n',
    );
    const session = createSession(store, {
      config: {
        service: 'catstory',
        automation: {
          network_log_path: 'Library/Caches/IcarusNetworkLog/network.jsonl',
        },
      },
    });
    vi.mocked(getAppContainerPath).mockResolvedValue(appContainer);
    store.createEvidence({
      id: 'ACT-001',
      type: 'ACT',
      session_id: session.session_id,
      source: 'test',
      summary: 'tap success',
      payload: {
        id: 'ACT-001',
        type: 'tap',
        status: 'success',
        time_window: {
          started_at: '2026-06-01T00:00:01.000Z',
          ended_at: '2026-06-01T00:00:02.000Z',
        },
      },
    });

    const trace = await readIosTrace({
      store,
      session,
      request: {
        session_id: session.session_id,
        after_action: 'ACT-001',
        types: ['network'],
        filters: {
          path_contains: '/api/user/profile',
          method: 'PATCH',
          status: 200,
        },
      },
    });

    expect(trace.network_events).toHaveLength(1);
    expect(trace.network_events[0]).toMatchObject({
      path: '/api/user/profile',
      triggered_by: 'ACT-001',
    });
  });
});

describe('searchIosCode', () => {
  it('rejects searches when request service does not match the session service', async () => {
    const store = makeStore();
    createSession(store, { service: 'catstory' });

    await expect(
      searchIosCode({
        store,
        request: {
          service: 'other',
          session_id: 'SESSION-001',
          scope: ['ios_client'],
          queries: [{ type: 'screen_title', value: 'Profile' }],
          registry: {
            other: {
              clients: {
                ios: {
                  repo_path: path.basename(process.cwd()),
                  scheme: 'OtherDebug',
                  bundle_id: 'com.example.other',
                },
              },
            },
          },
        },
      }),
    ).rejects.toThrow(
      'ios_app_search_code service "other" does not match session service "catstory"',
    );
  });
});
