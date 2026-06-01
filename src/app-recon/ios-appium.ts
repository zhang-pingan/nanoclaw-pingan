import axios, { AxiosError } from 'axios';

import type {
  IosActionResult,
  IosObserveElement,
  IosObservationResult,
  IosSessionRecord,
  JsonObject,
  JsonValue,
} from './types.js';

const DEFAULT_APPIUM_URL = 'http://127.0.0.1:4723';

export interface AppiumClientOptions {
  serverUrl?: string;
  timeoutMs?: number;
}

interface AppiumSessionResponse {
  value?: {
    sessionId?: string;
    capabilities?: Record<string, unknown>;
  };
  sessionId?: string;
}

function appiumUrl(options: AppiumClientOptions): string {
  return (options.serverUrl || DEFAULT_APPIUM_URL).replace(/\/+$/, '');
}

function formatAppiumError(err: unknown): string {
  if (err instanceof AxiosError) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
      return `Appium server is unavailable at ${err.config?.baseURL || DEFAULT_APPIUM_URL}`;
    }
    const data = err.response?.data;
    return typeof data === 'string'
      ? data
      : data
        ? JSON.stringify(data)
        : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function ensureAppiumSession(
  session: IosSessionRecord,
  options: AppiumClientOptions = {},
): Promise<string> {
  const payload = {
    capabilities: {
      alwaysMatch: {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': session.simulator_udid,
        'appium:bundleId': session.bundle_id,
        'appium:noReset': true,
        'appium:newCommandTimeout': 300,
      },
      firstMatch: [{}],
    },
  };
  try {
    const response = await axios.post<AppiumSessionResponse>(
      `${appiumUrl(options)}/session`,
      payload,
      { timeout: options.timeoutMs || 15_000 },
    );
    const sessionId =
      response.data.value?.sessionId || response.data.sessionId || '';
    if (!sessionId) throw new Error('Appium did not return a session id');
    return sessionId;
  } catch (err) {
    throw new Error(formatAppiumError(err));
  }
}

async function deleteAppiumSession(
  appiumSessionId: string,
  options: AppiumClientOptions = {},
): Promise<void> {
  try {
    await axios.delete(`${appiumUrl(options)}/session/${appiumSessionId}`, {
      timeout: options.timeoutMs || 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

async function withAppiumSession<T>(
  session: IosSessionRecord,
  options: AppiumClientOptions,
  fn: (appiumSessionId: string) => Promise<T>,
): Promise<T> {
  const appiumSessionId = await ensureAppiumSession(session, options);
  try {
    return await fn(appiumSessionId);
  } finally {
    await deleteAppiumSession(appiumSessionId, options);
  }
}

function parseXmlAttributes(xmlTag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xmlTag)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function extractElementsFromSource(source: string): IosObserveElement[] {
  const elements: IosObserveElement[] = [];
  const tagRe = /<([A-Za-z0-9_.:-]+)\s+([^>]+)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source)) !== null && elements.length < 200) {
    const attrs = parseXmlAttributes(match[2]);
    const type = attrs.type || match[1];
    const label = attrs.label || attrs.name || attrs.value;
    const identifier = attrs.name || attrs.identifier;
    const visible = attrs.visible !== 'false';
    const enabled = attrs.enabled !== 'false';
    const x = Number(attrs.x);
    const y = Number(attrs.y);
    const width = Number(attrs.width);
    const height = Number(attrs.height);
    if (!label && !identifier && !visible) continue;
    elements.push({
      ref: `@ios-${elements.length + 1}`,
      type,
      label,
      identifier,
      enabled,
      visible,
      clickable:
        enabled &&
        visible &&
        /(Button|Cell|TextField|SecureTextField|Switch|Link)/i.test(type),
      frame:
        [x, y, width, height].every((n) => Number.isFinite(n))
          ? { x, y, width, height }
          : undefined,
    });
  }
  return elements;
}

function screenFromElements(elements: IosObserveElement[]): JsonObject {
  const title = elements.find((item) => /NavigationBar/i.test(item.type))?.label;
  return {
    id: title ? `SCREEN-${title}` : 'SCREEN-UNKNOWN',
    name: title || 'Unknown',
    title: title || '',
  };
}

export async function observeWithAppium(input: {
  session: IosSessionRecord;
  observeId: string;
  screenshotArtifact?: string;
  uiTreeArtifact?: string;
  options?: AppiumClientOptions;
}): Promise<
  Omit<IosObservationResult, 'evidence'> & {
    raw_screenshot_base64?: string;
    raw_ui_tree?: string;
  }
> {
  return withAppiumSession(input.session, input.options || {}, async (appiumSessionId) => {
    const base = `${appiumUrl(input.options || {})}/session/${appiumSessionId}`;
    const [sourceResponse, screenshotResponse] = await Promise.all([
      axios.get<{ value?: string }>(`${base}/source`, { timeout: 20_000 }),
      axios.get<{ value?: string }>(`${base}/screenshot`, { timeout: 20_000 }),
    ]);
    const source = sourceResponse.data.value || '';
    const elements = extractElementsFromSource(source);
    return {
      id: input.observeId,
      session_id: input.session.session_id,
      screen: screenFromElements(elements),
      artifacts: {
        screenshot: input.screenshotArtifact || '',
        ui_tree: input.uiTreeArtifact || '',
        screenshot_base64: screenshotResponse.data.value ? '[stored]' : '',
      },
      elements,
      network_cursor: new Date().toISOString(),
      app_state: {
        keyboard_visible: false,
        system_alert_visible: false,
        loading: false,
      },
      raw_screenshot_base64: screenshotResponse.data.value || '',
      raw_ui_tree: source,
    };
  });
}

async function findElement(input: {
  appiumSessionId: string;
  target: unknown;
  options: AppiumClientOptions;
}): Promise<{ elementId: string; matchedCount: number; strategy: string; value: string }> {
  const target =
    typeof input.target === 'string'
      ? { strategy: 'accessibility_id', value: input.target }
      : input.target && typeof input.target === 'object'
        ? (input.target as Record<string, unknown>)
        : {};
  const strategy =
    typeof target.strategy === 'string' ? target.strategy : 'accessibility_id';
  const value = typeof target.value === 'string' ? target.value : '';
  if (!value) throw new Error('action target value is required');

  const using =
    strategy === 'accessibility_id'
      ? 'accessibility id'
      : strategy === 'label' || strategy === 'text'
        ? 'xpath'
        : strategy === 'xpath' || strategy === 'element_path'
          ? 'xpath'
          : '-ios predicate string';
  const selector =
    strategy === 'label' || strategy === 'text'
      ? `//*[@label=${JSON.stringify(value)} or @name=${JSON.stringify(value)} or @value=${JSON.stringify(value)}]`
      : value;

  const response = await axios.post<{
    value?: Array<Record<string, string>>;
  }>(
    `${appiumUrl(input.options)}/session/${input.appiumSessionId}/elements`,
    { using, value: selector },
    { timeout: 15_000 },
  );
  const elements = response.data.value || [];
  const first = elements[0] || {};
  const elementId =
    first.ELEMENT ||
    first['element-6066-11e4-a52e-4f735466cecf'] ||
    Object.values(first)[0];
  if (!elementId) throw new Error(`No element matched ${strategy}: ${value}`);
  return { elementId, matchedCount: elements.length, strategy, value };
}

async function waitForAction(waitFor: unknown): Promise<JsonValue> {
  if (!waitFor || typeof waitFor !== 'object') return { type: 'none' };
  const wait = waitFor as Record<string, unknown>;
  const timeoutMs =
    typeof wait.timeout_ms === 'number' && Number.isFinite(wait.timeout_ms)
      ? wait.timeout_ms
      : 0;
  if (wait.type === 'duration' || wait.type === 'wait') {
    await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 30_000)));
    return { type: wait.type, timeout_ms: timeoutMs, result: 'satisfied' };
  }
  return {
    type: typeof wait.type === 'string' ? wait.type : 'unknown',
    timeout_ms: timeoutMs,
    result: 'not_implemented',
  };
}

export async function actWithAppium(input: {
  session: IosSessionRecord;
  actionId: string;
  action: string;
  target?: unknown;
  text?: string;
  clear?: boolean;
  waitFor?: unknown;
  options?: AppiumClientOptions;
}): Promise<Omit<IosActionResult, 'before' | 'after' | 'evidence'>> {
  const startedAt = new Date().toISOString();
  try {
    const result = await withAppiumSession(
      input.session,
      input.options || {},
      async (appiumSessionId) => {
        const base = `${appiumUrl(input.options || {})}/session/${appiumSessionId}`;
        let targetSummary: JsonValue | undefined;
        if (input.action === 'tap' || input.action === 'type') {
          const element = await findElement({
            appiumSessionId,
            target: input.target,
            options: input.options || {},
          });
          targetSummary = {
            strategy: element.strategy,
            value: element.value,
            matched_count: element.matchedCount,
          };
          if (input.action === 'tap') {
            await axios.post(
              `${base}/element/${element.elementId}/click`,
              {},
              { timeout: 15_000 },
            );
          } else {
            if (input.clear) {
              await axios.post(
                `${base}/element/${element.elementId}/clear`,
                {},
                { timeout: 15_000 },
              );
            }
            await axios.post(
              `${base}/element/${element.elementId}/value`,
              { text: input.text || '', value: Array.from(input.text || '') },
              { timeout: 15_000 },
            );
          }
        } else if (input.action === 'back') {
          await axios.post(`${base}/back`, {}, { timeout: 15_000 });
        } else if (input.action === 'home') {
          await axios.post(`${base}/appium/device/press_button`, { name: 'home' }, {
            timeout: 15_000,
          });
        } else if (input.action === 'scroll') {
          await axios.post(
            `${base}/execute/sync`,
            {
              script: 'mobile: scroll',
              args: [input.target || { direction: 'down' }],
            },
            { timeout: 15_000 },
          );
          targetSummary = (input.target || { direction: 'down' }) as JsonValue;
        } else if (input.action === 'dismiss_keyboard') {
          await axios.post(`${base}/appium/device/hide_keyboard`, {}, {
            timeout: 15_000,
          });
        } else if (input.action === 'handle_system_alert') {
          const mode =
            input.target &&
            typeof input.target === 'object' &&
            (input.target as Record<string, unknown>).mode === 'dismiss'
              ? 'dismiss'
              : 'accept';
          await axios.post(`${base}/${mode}_alert`, {}, { timeout: 15_000 });
          targetSummary = { strategy: 'system_alert', value: mode };
        } else if (input.action === 'wait') {
          // Handled by waitForAction below.
        } else {
          throw new Error(`Unsupported Appium action: ${input.action}`);
        }
        const wait = await waitForAction(input.waitFor);
        return { targetSummary, wait };
      },
    );
    return {
      id: input.actionId,
      type: input.action,
      target: result.targetSummary,
      wait: result.wait,
      time_window: {
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      },
      status: 'success',
    };
  } catch (err) {
    return {
      id: input.actionId,
      type: input.action,
      target: input.target as JsonValue,
      time_window: {
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      },
      status: 'blocked',
      error: formatAppiumError(err),
    };
  }
}
