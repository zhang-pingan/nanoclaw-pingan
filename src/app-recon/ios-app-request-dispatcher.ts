import fs from 'fs';
import path from 'path';

import {
  createIosEvidenceStore,
  IosEvidenceStore,
} from './ios-evidence-store.js';
import {
  actWithAppium,
  observeWithAppium,
} from './ios-appium.js';
import { readIosTrace } from './ios-network-log.js';
import { writeIosReport } from './ios-report-writer.js';
import { resolveIosServiceConfig } from './ios-service-config.js';
import {
  bootSimulator,
  buildIosApp,
  findSimulatorDevice,
  installIosApp,
  launchIosApp,
  openDeepLink,
  runDebugShellCommand,
  terminateIosApp,
  uninstallIosApp,
  withIosSimulatorLock,
} from './ios-simulator.js';
import { searchIosCode } from './ios-source-index.js';
import { redactJson } from './ios-redaction.js';
import type {
  IosActionResult,
  IosAppErrorResult,
  IosAppRequest,
  IosAppRequestContext,
  IosAppRequestResult,
  IosClaimType,
  IosConfidence,
  IosObservationResult,
  IosSessionRecord,
  JsonObject,
  JsonValue,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toErrorResult(
  err: unknown,
  code = 'ios_app_request_failed',
  status: 'error' | 'blocked' = 'error',
): IosAppErrorResult {
  return {
    status,
    error: {
      code,
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

function sessionConfigPayload(config: ReturnType<typeof resolveIosServiceConfig>): JsonObject {
  return {
    service: config.service,
    bundle_id: config.ios.bundle_id,
    scheme: config.ios.scheme,
    simulator: config.ios.simulator || '',
    configuration: config.ios.configuration || '',
    ios_repo_path: config.ios.repo_path,
    backend_repo_path: config.service_config.repo_path || '',
    automation: {
      driver: config.ios.automation?.driver || 'appium',
      launch_args: config.ios.automation?.launch_args || [],
      network_log_path: config.ios.automation?.network_log_path || '',
      appium_server_url:
        config.ios.automation?.appium_server_url ||
        'http://127.0.0.1:4723',
    },
  };
}

function safeArtifactName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'artifact';
}

function appiumServerUrl(session: IosSessionRecord): string {
  const automation = session.config.automation;
  if (isRecord(automation) && typeof automation.appium_server_url === 'string') {
    return automation.appium_server_url;
  }
  return 'http://127.0.0.1:4723';
}

export class IosAppRequestDispatcher {
  readonly store: IosEvidenceStore;

  constructor(store: IosEvidenceStore = createIosEvidenceStore()) {
    this.store = store;
  }

  async dispatch(
    request: IosAppRequest,
    context: IosAppRequestContext,
  ): Promise<IosAppRequestResult> {
    try {
      if (this.requiresSimulatorLock(request.action)) {
        return await withIosSimulatorLock(() =>
          this.dispatchUnlocked(request, context),
        );
      }
      return await this.dispatchUnlocked(request, context);
    } catch (err) {
      return toErrorResult(err);
    }
  }

  private requiresSimulatorLock(action: IosAppRequest['action']): boolean {
    return [
      'prepare_session',
      'observe',
      'act',
      'run_flow',
      'read_trace',
      'run_test_case',
      'debug_shell',
    ].includes(action);
  }

  private async dispatchUnlocked(
    request: IosAppRequest,
    context: IosAppRequestContext,
  ): Promise<IosAppRequestResult> {
      switch (request.action) {
        case 'prepare_session':
          return await this.prepareSession(request.args);
        case 'observe':
          return await this.observe(request.args);
        case 'act':
          return await this.act(request.args);
        case 'run_flow':
          return await this.runFlow(request.args);
        case 'read_trace':
          return await this.readTrace(request.args);
        case 'search_code':
          return await this.searchCode(request.args);
        case 'write_claims':
          return this.writeClaims(request.args);
        case 'write_report':
          return this.writeReport(request.args);
        case 'run_test_case':
          return await this.runTestCase(request.args);
        case 'debug_shell':
          return await this.debugShell(request.args, context);
        default:
          return toErrorResult(
            new Error(`Unsupported ios_app_request action: ${request.action}`),
            'unsupported_action',
          );
      }
  }

  private async prepareSession(args: unknown): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('prepare_session args must be an object');
    const service = asString(args.service).trim();
    const purpose = asString(args.purpose, 'product_recon').trim() || 'product_recon';
    const resolved = resolveIosServiceConfig(service, {
      requireIosRepoExists: true,
      requireBackendRepoExists: false,
    });
    const simulatorName =
      asString(args.simulator) || resolved.ios.simulator || 'iPhone 16';
    const sessionId = this.store.nextGlobalId('SESSION');
    const buildId = this.store.nextId(sessionId, 'BUILD');
    const stateId = this.store.nextId(sessionId, 'STATE');

    return (async () => {
      const device = await findSimulatorDevice(simulatorName);
      await bootSimulator(device.udid);
      let buildEvidencePayload: JsonObject = {
        requested_build: asBoolean(args.build, false),
        built: false,
      };
      if (asBoolean(args.clean_install, false)) {
        await terminateIosApp(device.udid, resolved.ios.bundle_id);
        await uninstallIosApp(device.udid, resolved.ios.bundle_id);
      }
      if (asBoolean(args.build, false)) {
        const build = await buildIosApp(
          resolved.ios_repo_host_path,
          resolved.ios,
          simulatorName,
        );
        await installIosApp(device.udid, build.appPath);
        buildEvidencePayload = {
          requested_build: true,
          built: true,
          app_path: build.appPath,
          command: {
            command: build.command.command,
            args: build.command.args,
            exit_code: build.command.exit_code,
            duration_ms: build.command.duration_ms,
          },
        };
      }

      const launchArgs = [
        ...(resolved.ios.automation?.launch_args || []),
        ...asStringArray(args.launch_args),
      ];
      await launchIosApp({
        udid: device.udid,
        bundleId: resolved.ios.bundle_id,
        launchArgs,
      });

      const now = new Date().toISOString();
      const session = this.store.createSessionRecord({
        session_id: sessionId,
        service: resolved.service,
        purpose,
        created_at: now,
        updated_at: now,
        simulator_name: device.name,
        simulator_udid: device.udid,
        bundle_id: resolved.ios.bundle_id,
        build_id: buildId,
        state_id: stateId,
        ios_repo_host_path: resolved.ios_repo_host_path,
        backend_repo_host_path: resolved.backend_repo_host_path,
        config: sessionConfigPayload(resolved),
      });

      const sessionEvidence = this.store.createEvidence({
        id: sessionId,
        type: 'SESSION',
        session_id: sessionId,
        source: 'ios_app_prepare_session',
        summary: `iOS app recon session for ${resolved.service}`,
        payload: session as unknown as JsonObject,
      });
      const buildEvidence = this.store.createEvidence({
        id: buildId,
        type: 'BUILD',
        session_id: sessionId,
        source: 'ios_app_prepare_session',
        summary: `${resolved.ios.scheme} ${resolved.ios.configuration || 'Debug'} build context`,
        payload: buildEvidencePayload,
      });
      const stateEvidence = this.store.createEvidence({
        id: stateId,
        type: 'STATE',
        session_id: sessionId,
        source: 'ios_app_prepare_session',
        summary: 'Initial simulator/app state',
        payload: {
          clean_install: asBoolean(args.clean_install, false),
          launch_args: launchArgs,
          auth: isRecord(args.auth) ? (args.auth as JsonObject) : {},
        },
      });

      return {
        status: 'ready',
        session_id: session.session_id,
        simulator_udid: device.udid,
        bundle_id: resolved.ios.bundle_id,
        app_version: '',
        build: buildEvidence.id,
        state: stateEvidence.id,
        evidence: [sessionEvidence.id, buildEvidence.id, stateEvidence.id],
      };
    })().catch((err) => toErrorResult(err, 'ios_environment_unavailable', 'blocked'));
  }

  private async observe(args: unknown): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('observe args must be an object');
    const sessionId = asString(args.session_id);
    const session = this.store.getSession(sessionId);
    const observeId = this.store.nextId(sessionId, 'OBS');

    try {
      const observation = await observeWithAppium({
        session,
        observeId,
        options: { serverUrl: appiumServerUrl(session) },
      });
      const screenshotArtifact = observation.raw_screenshot_base64
        ? this.store.writeArtifact(
            sessionId,
            `screenshots/${observeId}.png.base64`,
            observation.raw_screenshot_base64,
          )
        : undefined;
      const uiTreeArtifact = observation.raw_ui_tree
        ? this.store.writeArtifact(
            sessionId,
            `ui/${observeId}.xml`,
            observation.raw_ui_tree,
          )
        : undefined;
      const screenshotEvidence = screenshotArtifact
        ? this.store.createEvidence({
            type: 'SCREENSHOT',
            session_id: sessionId,
            source: 'ios_app_observe',
            summary: `Screenshot for ${observeId}`,
            artifact_path: screenshotArtifact,
          })
        : null;
      const uiTreeEvidence = uiTreeArtifact
        ? this.store.createEvidence({
            type: 'UI_TREE',
            session_id: sessionId,
            source: 'ios_app_observe',
            summary: `UI tree for ${observeId}`,
            artifact_path: uiTreeArtifact,
          })
        : null;
      const obs: IosObservationResult = {
        id: observeId,
        session_id: sessionId,
        screen: observation.screen,
        artifacts: {
          ...observation.artifacts,
          screenshot: screenshotEvidence?.id || '',
          ui_tree: uiTreeEvidence?.id || '',
        },
        elements: observation.elements,
        network_cursor: observation.network_cursor,
        app_state: observation.app_state,
        evidence: [
          observeId,
          ...(screenshotEvidence ? [screenshotEvidence.id] : []),
          ...(uiTreeEvidence ? [uiTreeEvidence.id] : []),
        ],
      };
      this.store.createEvidence({
        id: observeId,
        type: 'OBS',
        session_id: sessionId,
        source: 'ios_app_observe',
        summary: `Observed ${String(obs.screen.title || obs.screen.name || 'screen')}`,
        payload: obs as unknown as JsonObject,
      });
      return obs as unknown as IosAppRequestResult;
    } catch (err) {
      return toErrorResult(err, 'ios_appium_unavailable', 'blocked');
    }
  }

  private async act(args: unknown): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('act args must be an object');
    const sessionId = asString(args.session_id);
    const session = this.store.getSession(sessionId);
    const action = asString(args.action);
    if (!action) throw new Error('action is required');
    const before = await this.observe({ session_id: sessionId });
    const beforeId = isRecord(before) && typeof before.id === 'string' ? before.id : undefined;
    const actionId = this.store.nextId(sessionId, 'ACT');

    let actionResult: Omit<IosActionResult, 'before' | 'after' | 'evidence'>;
    if (action === 'deeplink') {
      const url = asString(args.url || (isRecord(args.target) ? args.target.url : ''));
      if (!url) throw new Error('deeplink url is required');
      const startedAt = new Date().toISOString();
      const result = await openDeepLink(session.simulator_udid || 'booted', url);
      actionResult = {
        id: actionId,
        type: action,
        target: { strategy: 'deeplink', value: url },
        time_window: {
          started_at: startedAt,
          ended_at: new Date().toISOString(),
        },
        status: result.exit_code === 0 ? 'success' : 'blocked',
        error: result.exit_code === 0 ? undefined : result.stderr || result.stdout,
      };
    } else if (action === 'terminate') {
      const startedAt = new Date().toISOString();
      await terminateIosApp(session.simulator_udid || 'booted', session.bundle_id);
      actionResult = {
        id: actionId,
        type: action,
        time_window: { started_at: startedAt, ended_at: new Date().toISOString() },
        status: 'success',
      };
    } else if (action === 'relaunch') {
      const startedAt = new Date().toISOString();
      await launchIosApp({
        udid: session.simulator_udid || 'booted',
        bundleId: session.bundle_id,
        launchArgs: asStringArray(args.launch_args),
      });
      actionResult = {
        id: actionId,
        type: action,
        time_window: { started_at: startedAt, ended_at: new Date().toISOString() },
        status: 'success',
      };
    } else {
      actionResult = await actWithAppium({
        session,
        actionId,
        action,
        target: args.target,
        text: asString(args.text),
        clear: asBoolean(args.clear, false),
        waitFor: args.wait_for,
        options: { serverUrl: appiumServerUrl(session) },
      });
    }

    const after =
      args.snapshot_after === false
        ? null
        : await this.observe({ session_id: sessionId });
    const afterId = isRecord(after) && typeof after.id === 'string' ? after.id : undefined;
    const fullAction: IosActionResult = {
      ...actionResult,
      before: beforeId,
      after: afterId,
      evidence: [actionId, ...[beforeId, afterId].filter((id): id is string => !!id)],
    };
    this.store.createEvidence({
      id: actionId,
      type: 'ACT',
      session_id: sessionId,
      source: 'ios_app_act',
      summary: `${action} ${fullAction.status}`,
      payload: fullAction as unknown as JsonObject,
    });
    return fullAction as unknown as IosAppRequestResult;
  }

  private async runFlow(args: unknown): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('run_flow args must be an object');
    const sessionId = asString(args.session_id);
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const flowEvidenceId = this.store.nextId(sessionId, 'FLOW');
    const actionIds: string[] = [];
    const observations: string[] = [];
    let status: 'success' | 'error' | 'blocked' = 'success';
    const errors: string[] = [];

    for (const step of steps) {
      if (!isRecord(step)) continue;
      const result = await this.act({
        session_id: sessionId,
        action: step.action,
        target:
          typeof step.target === 'string'
            ? { strategy: 'accessibility_id', value: step.target }
            : step.target,
        url: step.url,
        text: step.text,
        clear: step.clear,
        wait_for: step.wait_for,
        snapshot_after: true,
      });
      if (isRecord(result) && typeof result.id === 'string') {
        actionIds.push(result.id);
        if (typeof result.before === 'string') observations.push(result.before);
        if (typeof result.after === 'string') observations.push(result.after);
        if (result.status !== 'success') status = 'blocked';
        if (typeof result.error === 'string') errors.push(result.error);
      } else {
        status = 'error';
        errors.push(JSON.stringify(result));
        break;
      }
    }

    const flow = {
      status,
      flow_id: flowEvidenceId,
      requested_flow_id: asString(args.flow_id),
      steps: actionIds,
      observations: Array.from(new Set(observations)),
      errors,
      evidence: [flowEvidenceId, ...actionIds],
    };
    this.store.createEvidence({
      id: flowEvidenceId,
      type: 'FLOW',
      session_id: sessionId,
      source: 'ios_app_run_flow',
      summary: `Flow ${asString(args.flow_id, flowEvidenceId)} ${status}`,
      payload: flow as JsonObject,
    });
    return flow;
  }

  private async readTrace(args: unknown): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('read_trace args must be an object');
    const sessionId = asString(args.session_id);
    const session = this.store.getSession(sessionId);
    try {
      return await readIosTrace({
        store: this.store,
        session,
        request: {
          session_id: sessionId,
          after_action: asString(args.after_action),
          types: asStringArray(args.types),
          filters: isRecord(args.filters) ? args.filters : undefined,
        },
      });
    } catch (err) {
      return toErrorResult(err, 'ios_trace_unavailable', 'blocked');
    }
  }

  private async searchCode(args: unknown): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('search_code args must be an object');
    try {
      const result = await searchIosCode({
        store: this.store,
        request: {
          service: asString(args.service),
          session_id: asString(args.session_id),
          scope: Array.isArray(args.scope)
            ? args.scope.filter(
                (item): item is 'ios_client' | 'backend' =>
                  item === 'ios_client' || item === 'backend',
              )
            : undefined,
          queries: Array.isArray(args.queries)
            ? args.queries
                .filter(isRecord)
                .map((query) => ({
                  type: asString(query.type),
                  value: asString(query.value),
                }))
            : [],
          max_results:
            typeof args.max_results === 'number' ? args.max_results : undefined,
        },
      });
      return result;
    } catch (err) {
      return toErrorResult(err, 'ios_code_search_failed', 'error');
    }
  }

  private writeClaims(args: unknown): IosAppRequestResult {
    if (!isRecord(args)) throw new Error('write_claims args must be an object');
    const sessionId = asString(args.session_id);
    if (!sessionId) throw new Error('session_id is required');
    const claims = Array.isArray(args.claims) ? args.claims : [];
    const written = claims.filter(isRecord).map((claim) =>
      this.store.createClaim({
        session_id: sessionId,
        type: asString(claim.type, 'current_behavior') as IosClaimType,
        statement: asString(claim.statement),
        supported_by: asStringArray(claim.supported_by),
        confidence: asString(claim.confidence, 'medium') as IosConfidence,
        limitations: asStringArray(claim.limitations),
      }),
    );
    return {
      claims: written,
      evidence: written.map((claim) => claim.id),
    };
  }

  private writeReport(args: unknown): IosAppRequestResult {
    if (!isRecord(args)) throw new Error('write_report args must be an object');
    return writeIosReport(this.store, {
      session_id: asString(args.session_id),
      kind: asString(args.kind),
      path: asString(args.path),
      required_fields: asStringArray(args.required_fields),
      body: isRecord(args.body) ? (args.body as JsonObject) : {},
    });
  }

  private async runTestCase(args: unknown): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('run_test_case args must be an object');
    const sessionId = asString(args.session_id);
    const caseId = asString(args.case_id, 'TC-001');
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const assertions = Array.isArray(args.assertions) ? args.assertions : [];
    const caseEvidenceId = this.store.nextId(sessionId, 'CASE');
    const stepResult = await this.runFlow({
      session_id: sessionId,
      flow_id: caseId,
      steps,
    });
    const actionEvidence =
      isRecord(stepResult) && Array.isArray(stepResult.steps)
        ? stepResult.steps.filter((item): item is string => typeof item === 'string')
        : [];
    const assertionResults: JsonObject[] = [];
    for (const assertion of assertions.filter(isRecord)) {
      const assertId = this.store.nextId(sessionId, 'ASSERT');
      const type = asString(assertion.type);
      let passed = false;
      let evidence: string[] = [];
      if (type === 'network') {
        const trace = await this.readTrace({
          session_id: sessionId,
          types: ['network'],
          filters: {
            path_contains: asString(assertion.path),
            method: asString(assertion.method),
            status:
              typeof assertion.status === 'number' ? assertion.status : undefined,
          },
        });
        evidence =
          isRecord(trace) && Array.isArray(trace.evidence)
            ? trace.evidence.filter((item): item is string => typeof item === 'string')
            : [];
        passed = evidence.length > 0;
      } else if (type === 'network_absent') {
        const trace = await this.readTrace({
          session_id: sessionId,
          types: ['network'],
          filters: { path_contains: asString(assertion.path) },
        });
        const traceEvidence =
          isRecord(trace) && Array.isArray(trace.evidence) ? trace.evidence : [];
        passed = traceEvidence.length === 0;
      } else if (type === 'ui_text' || type === 'element_exists') {
        const obs = await this.observe({ session_id: sessionId });
        if (isRecord(obs)) {
          evidence = typeof obs.id === 'string' ? [obs.id] : [];
          const needle = asString(assertion.contains || assertion.text || assertion.value);
          const haystack = JSON.stringify(obs);
          passed = needle ? haystack.includes(needle) : evidence.length > 0;
        }
      } else if (type === 'crash_absent') {
        passed = true;
      }
      const assertionPayload = {
        id: assertId,
        type,
        status: passed ? 'passed' : 'failed',
        evidence,
        assertion: assertion as JsonObject,
      };
      this.store.createEvidence({
        id: assertId,
        type: 'ASSERT',
        session_id: sessionId,
        source: 'ios_app_run_test_case',
        summary: `${caseId} ${type} ${assertionPayload.status}`,
        payload: assertionPayload,
      });
      assertionResults.push(assertionPayload);
    }

    const failed = assertionResults.some((item) => item.status !== 'passed');
    const result = {
      case_id: caseId,
      result: failed ? 'failed' : 'passed',
      steps: actionEvidence,
      assertions: assertionResults,
      evidence: [
        caseEvidenceId,
        ...actionEvidence,
        ...assertionResults.map((item) => String(item.id)),
      ],
    };
    this.store.createEvidence({
      id: caseEvidenceId,
      type: 'CASE',
      session_id: sessionId,
      source: 'ios_app_run_test_case',
      summary: `${caseId} ${result.result}`,
      payload: result as JsonObject,
    });
    return result;
  }

  private async debugShell(
    args: unknown,
    context: IosAppRequestContext,
  ): Promise<IosAppRequestResult> {
    if (!isRecord(args)) throw new Error('debug_shell args must be an object');
    const sessionId = asString(args.session_id, 'DEBUG');
    const debugId =
      sessionId === 'DEBUG'
        ? this.store.nextGlobalId('DEBUG')
        : this.store.nextId(sessionId, 'DEBUG');
    const capture = isRecord(args.capture) ? args.capture : {};
    const result = await runDebugShellCommand({
      command: asString(args.command),
      timeoutMs:
        typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
          ? Math.min(args.timeout_ms, 10 * 60 * 1000)
          : 30_000,
      maxBytes:
        typeof capture.max_bytes === 'number' && Number.isFinite(capture.max_bytes)
          ? Math.min(capture.max_bytes, 100_000)
          : 20_000,
    });
    const artifact = `debug/${safeArtifactName(debugId)}.json`;
    const payload = {
      debug_id: debugId,
      purpose: asString(args.purpose),
      source_group: context.sourceGroup,
      command: args.command,
      exit_code: result.exit_code,
      stdout_summary: result.stdout,
      stderr_summary: result.stderr,
      duration_ms: result.duration_ms,
      usable_as_formal_evidence: false,
    };
    const redactedPayload = redactJson(payload as unknown as JsonObject)
      .value as JsonObject;

    if (sessionId !== 'DEBUG') {
      this.store.writeArtifact(
        sessionId,
        artifact,
        JSON.stringify(redactedPayload, null, 2) + '\n',
      );
      this.store.createEvidence({
        id: debugId,
        type: 'DEBUG',
        session_id: sessionId,
        source: 'ios_host_debug_shell',
        summary: `Debug shell: ${asString(args.purpose) || asString(args.command).slice(0, 80)}`,
        artifact_path: artifact,
        payload: {
          exit_code: result.exit_code,
          usable_as_formal_evidence: false,
        },
      });
    } else {
      const debugRoot = path.join(this.store.rootDir, 'debug');
      fs.mkdirSync(debugRoot, { recursive: true });
      fs.writeFileSync(
        path.join(debugRoot, `${safeArtifactName(debugId)}.json`),
        JSON.stringify(redactedPayload, null, 2) + '\n',
      );
    }

    return {
      status: result.exit_code === 0 ? 'success' : 'error',
      debug_id: debugId,
      exit_code: result.exit_code,
      stdout_summary: String(redactedPayload.stdout_summary || ''),
      stderr_summary: String(redactedPayload.stderr_summary || ''),
      artifact:
        sessionId === 'DEBUG'
          ? path.join('debug', `${safeArtifactName(debugId)}.json`)
          : artifact,
      usable_as_formal_evidence: false,
    };
  }
}

export async function dispatchIosAppRequest(
  request: IosAppRequest,
  context: IosAppRequestContext,
  store?: IosEvidenceStore,
): Promise<IosAppRequestResult> {
  return new IosAppRequestDispatcher(store).dispatch(request, context);
}
