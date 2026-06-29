import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ENV_FILE = path.join(__dirname, '.env');

function parseEnvValue(value) {
  let result = String(value || '').trim();
  if (
    (result.startsWith('"') && result.endsWith('"')) ||
    (result.startsWith("'") && result.endsWith("'"))
  ) {
    result = result.slice(1, -1);
  }
  return result.replace(/\\n/g, '\n');
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = parseEnvValue(rawValue);
  }
}

loadEnvFile(ENV_FILE);

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const OPENAI_BASE_URL =
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_DEEP_RESEARCH_DEFAULT_MODEL || 'o3-deep-research';
const OPENAI_MODELS = [
  'o3-deep-research',
  'o4-mini-deep-research',
];
const SUPPORTED_OPENAI_MODELS = new Set(OPENAI_MODELS);
const GPT_RESEARCHER_MODEL = 'gpt-researcher';
const GPT_RESEARCHER_BASE_URL = (
  process.env.GPT_RESEARCHER_BASE_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');
const GPT_RESEARCHER_REPORT_TYPE =
  process.env.GPT_RESEARCHER_REPORT_TYPE || 'research_report';
const GPT_RESEARCHER_REPORT_SOURCE =
  process.env.GPT_RESEARCHER_REPORT_SOURCE || 'web';
const GPT_RESEARCHER_TONE = process.env.GPT_RESEARCHER_TONE || 'Objective';
const GPT_RESEARCHER_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.GPT_RESEARCHER_TIMEOUT_MS || 30 * 60_000),
);
const GPT_RESEARCHER_CONNECT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.GPT_RESEARCHER_CONNECT_TIMEOUT_MS || 10_000),
);
const PROVIDERS = {
  openai: {
    id: 'openai',
    label: 'OpenAI Deep Research',
    models: OPENAI_MODELS,
    defaultModel: DEFAULT_OPENAI_MODEL,
  },
  'gpt-researcher': {
    id: 'gpt-researcher',
    label: 'GPT Researcher API',
    models: [GPT_RESEARCHER_MODEL],
    defaultModel: GPT_RESEARCHER_MODEL,
  },
};
const DEFAULT_PROVIDER = Object.hasOwn(
  PROVIDERS,
  process.env.DEFAULT_RESEARCH_PROVIDER || '',
)
  ? process.env.DEFAULT_RESEARCH_PROVIDER
  : 'openai';
const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'incomplete',
]);
const POLL_THROTTLE_MS = 2500;

const tasks = new Map();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 2_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clipText(value, maxChars) {
  const text = safeText(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function createTaskId() {
  return `dr_${Date.now().toString(36)}_${crypto
    .randomBytes(4)
    .toString('hex')}`;
}

function makeTitle(prompt, outputText = '') {
  const heading = outputText.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return clipText(heading[1], 80);
  return clipText(prompt.replace(/\s+/g, ' '), 80) || 'Deep Research Report';
}

function buildInstructions() {
  return [
    'You are a senior research analyst.',
    'Return a formal Markdown research report.',
    'Use clear headings, an executive summary, methodology, analysis, risks or limitations, and source-grounded conclusions.',
    'Make citations visible and clickable wherever the API provides them.',
    'If evidence is weak or conflicting, state the uncertainty explicitly.',
  ].join('\n');
}

function normalizeProvider(provider) {
  const value = safeText(provider) || DEFAULT_PROVIDER;
  return Object.hasOwn(PROVIDERS, value) ? value : DEFAULT_PROVIDER;
}

function providerLabel(provider) {
  return PROVIDERS[provider]?.label || provider;
}

function normalizeModel(provider, model) {
  const value = safeText(model);
  if (provider === 'gpt-researcher') return GPT_RESEARCHER_MODEL;
  return SUPPORTED_OPENAI_MODELS.has(value) ? value : DEFAULT_OPENAI_MODEL;
}

function normalizeMaxToolCalls(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 80;
  return Math.max(10, Math.min(200, Math.floor(number)));
}

async function openaiRequest(endpoint, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY is not configured');
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(`${OPENAI_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message || body?.message || `OpenAI request failed`,
    );
    error.statusCode = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function gptResearcherRequest(endpoint, options = {}) {
  const url = `${GPT_RESEARCHER_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  const urlObject = new URL(url);
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (process.env.GPT_RESEARCHER_API_KEY) {
    headers.Authorization = `Bearer ${process.env.GPT_RESEARCHER_API_KEY}`;
  }

  const requestBody = options.body || '';
  if (
    requestBody &&
    !headers['Content-Length'] &&
    !headers['content-length']
  ) {
    headers['Content-Length'] = Buffer.byteLength(requestBody);
  }

  const transport = urlObject.protocol === 'https:' ? https : http;
  const { statusCode, text } = await new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let timedOut = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const request = transport.request(
      urlObject,
      {
        method: options.method || 'GET',
        headers,
        timeout: GPT_RESEARCHER_TIMEOUT_MS,
      },
      (response) => {
        connected = true;
        const chunks = [];
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: response.statusCode || 0,
            text: chunks.join(''),
          });
        });
      },
    );

    const connectTimer = setTimeout(() => {
      if (connected || settled) return;
      timedOut = true;
      request.destroy(
        new Error(
          `Timed out connecting to GPT Researcher API at ${GPT_RESEARCHER_BASE_URL}`,
        ),
      );
    }, GPT_RESEARCHER_CONNECT_TIMEOUT_MS);

    request.on('socket', (socket) => {
      socket.on('connect', () => {
        connected = true;
        clearTimeout(connectTimer);
      });
      socket.on('secureConnect', () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });

    request.on('timeout', () => {
      timedOut = true;
      request.destroy(
        new Error(
          `Timed out waiting for GPT Researcher API after ${Math.round(
            GPT_RESEARCHER_TIMEOUT_MS / 1000,
          )}s`,
        ),
      );
    });

    request.on('error', (error) => {
      clearTimeout(connectTimer);
      if (options.signal?.aborted) {
        const abortError = new Error('The operation was aborted');
        abortError.name = 'AbortError';
        fail(abortError);
        return;
      }
      if (timedOut) {
        fail(error);
        return;
      }
      const nextError = new Error(
        `Cannot connect to GPT Researcher API at ${GPT_RESEARCHER_BASE_URL}: ${error.message}`,
      );
      nextError.cause = error;
      fail(nextError);
    });

    options.signal?.addEventListener(
      'abort',
      () => {
        request.destroy();
      },
      { once: true },
    );

    if (requestBody) request.write(requestBody);
    request.end();
  });

  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }

  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(
      body?.detail ||
        body?.error ||
        body?.message ||
        `GPT Researcher request failed`,
    );
    error.statusCode = statusCode;
    error.body = body;
    throw error;
  }

  return body;
}

function normalizeUrlSources(values) {
  const byUrl = new Map();
  const queue = Array.isArray(values) ? [...values] : [];

  while (queue.length > 0) {
    const value = queue.shift();
    if (!value) continue;
    if (Array.isArray(value)) {
      queue.push(...value);
      continue;
    }
    if (typeof value === 'string') {
      const url = safeText(value);
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, {
        id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
        title: url,
        url,
        source_type: 'gpt_researcher',
      });
      continue;
    }
    if (typeof value !== 'object') continue;
    const nested = value.url || value.href || value.link || value.source_url;
    const url = safeText(nested);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
      title: safeText(value.title) || url,
      url,
      source_type: value.source_type || 'gpt_researcher',
    });
  }

  return [...byUrl.values()];
}

function extractGptResearcherReport(response) {
  const research = response?.research_information || {};
  const outputText =
    safeText(response?.report) ||
    safeText(response?.answer) ||
    safeText(response?.output_text) ||
    safeText(response?.output?.report) ||
    safeText(response?.raw);
  const sources = normalizeUrlSources([
    research.source_urls,
    research.visited_urls,
    response?.sources,
    response?.source_urls,
  ]);

  return {
    outputText,
    sources,
    research,
  };
}

function extractOutput(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const textParts = [];
  const annotations = [];
  const webCalls = [];
  const fileCalls = [];
  const mcpCalls = [];
  const codeCalls = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'web_search_call') webCalls.push(item);
    if (item.type === 'file_search_call') fileCalls.push(item);
    if (item.type === 'mcp_tool_call') mcpCalls.push(item);
    if (item.type === 'code_interpreter_call') codeCalls.push(item);
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (!part || part.type !== 'output_text') continue;
      if (typeof part.text === 'string') textParts.push(part.text);
      if (Array.isArray(part.annotations)) annotations.push(...part.annotations);
    }
  }

  return {
    outputText: safeText(response?.output_text) || textParts.join('\n\n').trim(),
    annotations,
    webCalls,
    fileCalls,
    mcpCalls,
    codeCalls,
  };
}

function extractSources(response, extracted) {
  const byUrl = new Map();
  for (const annotation of extracted.annotations) {
    const url = safeText(annotation?.url);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, {
      id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
      title: safeText(annotation?.title) || url,
      url,
      source_type: annotation?.type || 'url_citation',
    });
  }

  for (const call of extracted.webCalls) {
    const sources = Array.isArray(call?.action?.sources)
      ? call.action.sources
      : Array.isArray(call?.results)
        ? call.results
        : [];
    for (const source of sources) {
      const url = safeText(source?.url);
      if (!url || byUrl.has(url)) continue;
      byUrl.set(url, {
        id: `SRC-${String(byUrl.size + 1).padStart(3, '0')}`,
        title: safeText(source?.title) || url,
        url,
        source_type: 'web_search',
      });
    }
  }

  return [...byUrl.values()];
}

function buildGptResearcherProgress(task) {
  const terminal = TERMINAL_STATUSES.has(task.status);
  const endedUnfinished = terminal && task.status !== 'completed';
  const hasText = !!safeText(task.outputText);
  const sourceCount = task.sources?.length || 0;

  return [
    {
      key: 'created',
      label: '提交 GPT Researcher 任务',
      detail: GPT_RESEARCHER_BASE_URL,
      status: endedUnfinished ? 'failed' : 'completed',
    },
    {
      key: 'search',
      label: '检索公开网页来源',
      detail: sourceCount > 0 ? `${sourceCount} 个引用来源` : 'GPT Researcher 正在检索资料',
      status: sourceCount > 0 ? 'completed' : endedUnfinished ? 'failed' : 'active',
    },
    {
      key: 'analyze',
      label: '分析来源并组织报告',
      detail: hasText ? '研究内容已返回' : '等待 GPT Researcher 返回报告',
      status: hasText ? 'completed' : endedUnfinished ? 'failed' : 'active',
    },
    {
      key: 'report',
      label: '生成研究报告文档',
      detail: hasText ? '报告已生成' : '等待最终输出',
      status:
        task.status === 'completed'
          ? 'completed'
          : endedUnfinished
            ? 'failed'
            : 'pending',
    },
  ];
}

function buildProgress(response, task) {
  if (task.provider === 'gpt-researcher') return buildGptResearcherProgress(task);

  const extracted = response ? extractOutput(response) : null;
  const status = response?.status || task.status || 'queued';
  const searchCount = extracted?.webCalls.length || 0;
  const sourceCount = task.sources?.length || 0;
  const hasText = !!safeText(extracted?.outputText);
  const terminal = TERMINAL_STATUSES.has(status);
  const endedUnfinished = terminal && status !== 'completed';

  return [
    {
      key: 'created',
      label: '提交 Deep Research 任务',
      detail: task.responseId || '等待 OpenAI 响应',
      status: task.responseId ? 'completed' : endedUnfinished ? 'failed' : 'active',
    },
    {
      key: 'search',
      label: '检索公开网页来源',
      detail:
        searchCount > 0
          ? `${searchCount} 个搜索活动，${sourceCount} 个引用来源`
          : status === 'queued'
            ? '等待调度'
            : '等待搜索活动',
      status:
        searchCount > 0
          ? terminal
            ? 'completed'
            : 'active'
          : endedUnfinished
            ? 'failed'
          : status === 'queued'
            ? 'pending'
            : 'active',
    },
    {
      key: 'analyze',
      label: '分析来源并综合结论',
      detail:
        extracted?.codeCalls.length > 0
          ? `${extracted.codeCalls.length} 个代码分析活动`
          : '模型正在整理证据',
      status:
        hasText
          ? 'completed'
          : endedUnfinished
            ? 'failed'
          : searchCount > 0
            ? 'active'
            : 'pending',
    },
    {
      key: 'report',
      label: '生成研究报告文档',
      detail: hasText ? '报告已生成' : '等待最终输出',
      status:
        status === 'completed'
          ? 'completed'
          : endedUnfinished
            ? 'failed'
            : hasText
              ? 'active'
              : 'pending',
    },
  ];
}

function updateTaskFromResponse(task, response) {
  const extracted = extractOutput(response);
  const sources = extractSources(response, extracted);
  task.status = response.status || task.status;
  task.error = response.error || null;
  task.incomplete_details = response.incomplete_details || null;
  task.updatedAt = new Date().toISOString();
  task.outputText = extracted.outputText || task.outputText || '';
  task.annotations = extracted.annotations;
  task.sources = sources;
  task.webCalls = extracted.webCalls;
  task.fileCalls = extracted.fileCalls;
  task.mcpCalls = extracted.mcpCalls;
  task.codeCalls = extracted.codeCalls;
  task.usage = response.usage || null;
  task.rawResponse = response;
  task.title = makeTitle(task.prompt, task.outputText);
  task.progress = buildProgress(response, task);
}

function publicTask(task, options = {}) {
  return {
    id: task.id,
    response_id: task.responseId,
    provider: task.provider,
    provider_label: providerLabel(task.provider),
    model: task.model,
    prompt: task.prompt,
    title: task.title,
    status: task.status,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    progress: task.progress || buildProgress(task.rawResponse, task),
    stats: {
      search_count: task.webCalls?.length || 0,
      source_count: task.sources?.length || 0,
      file_search_count: task.fileCalls?.length || 0,
      mcp_call_count: task.mcpCalls?.length || 0,
      code_call_count: task.codeCalls?.length || 0,
    },
    usage: task.usage || null,
    error: task.error,
    incomplete_details: task.incomplete_details,
    sources: task.sources || [],
    output_text: options.full ? task.outputText || '' : undefined,
  };
}

async function refreshTask(task) {
  if (task.provider !== 'openai') return task;
  if (!task.responseId || TERMINAL_STATUSES.has(task.status)) return task;
  const now = Date.now();
  if (task.pollPromise) return task.pollPromise;
  if (task.lastPollAt && now - task.lastPollAt < POLL_THROTTLE_MS) return task;

  task.lastPollAt = now;
  task.pollPromise = openaiRequest(`/responses/${encodeURIComponent(task.responseId)}`)
    .then((response) => {
      updateTaskFromResponse(task, response);
      return task;
    })
    .catch((error) => {
      task.error = {
        message: error.message,
        body: error.body || null,
      };
      task.updatedAt = new Date().toISOString();
      return task;
    })
    .finally(() => {
      task.pollPromise = null;
    });

  return task.pollPromise;
}

function createResearchTask(provider, model, prompt) {
  return {
    id: createTaskId(),
    responseId: '',
    provider,
    model,
    prompt,
    title: makeTitle(prompt),
    status: 'creating',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: [],
    sources: [],
    webCalls: [],
    fileCalls: [],
    mcpCalls: [],
    codeCalls: [],
    outputText: '',
  };
}

function buildGptResearcherPayload(task) {
  return {
    task: task.prompt,
    report_type: GPT_RESEARCHER_REPORT_TYPE,
    report_source: GPT_RESEARCHER_REPORT_SOURCE,
    tone: GPT_RESEARCHER_TONE,
    headers: {},
    repo_name: '',
    branch_name: '',
    generate_in_background: false,
  };
}

async function runGptResearcherTask(task) {
  const abortController = new AbortController();
  task.abortController = abortController;
  task.status = 'running';
  task.updatedAt = new Date().toISOString();
  task.progress = buildProgress(null, task);

  try {
    const response = await gptResearcherRequest('/report/', {
      method: 'POST',
      body: JSON.stringify(buildGptResearcherPayload(task)),
      signal: abortController.signal,
    });
    if (task.status === 'cancelled') return;

    const extracted = extractGptResearcherReport(response);
    if (!safeText(extracted.outputText)) {
      const error = new Error('GPT Researcher did not return report content');
      error.body = response;
      throw error;
    }

    task.responseId = safeText(response?.research_id) || task.id;
    task.status = 'completed';
    task.outputText = extracted.outputText;
    task.sources = extracted.sources;
    task.webCalls = extracted.sources.map((source) => ({
      type: 'gpt_researcher_source',
      source,
    }));
    task.rawResponse = response;
    task.usage = response?.research_costs
      ? { research_costs: response.research_costs }
      : null;
    task.title = makeTitle(task.prompt, task.outputText);
    task.updatedAt = new Date().toISOString();
    task.progress = buildProgress(null, task);
  } catch (error) {
    if (error.name === 'AbortError' || task.status === 'cancelled') {
      task.status = 'cancelled';
      task.error = null;
    } else {
      task.status = 'failed';
      task.error = {
        message: error.message,
        body: error.body || null,
      };
    }
    task.updatedAt = new Date().toISOString();
    task.progress = buildProgress(null, task);
  } finally {
    task.abortController = null;
  }
}

async function handleCreateResearch(req, res) {
  const body = await readJsonBody(req);
  const prompt = safeText(body.prompt);
  if (!prompt) {
    sendJson(res, 400, { error: 'prompt required' });
    return;
  }

  const provider = normalizeProvider(body.provider);
  const model = normalizeModel(provider, body.model);
  const maxToolCalls = normalizeMaxToolCalls(body.max_tool_calls);
  const task = createResearchTask(provider, model, prompt);
  tasks.set(task.id, task);

  if (provider === 'gpt-researcher') {
    task.status = 'queued';
    task.progress = buildProgress(null, task);
    setTimeout(() => {
      runGptResearcherTask(task);
    }, 0);
    sendJson(res, 200, { task: publicTask(task, { full: true }) });
    return;
  }

  const payload = {
    model,
    input: prompt,
    instructions: buildInstructions(),
    background: true,
    store: true,
    tools: [{ type: 'web_search_preview' }],
    max_tool_calls: maxToolCalls,
    include: ['web_search_call.action.sources'],
    metadata: {
      app: 'openai-deep-research-web',
      local_task_id: task.id,
    },
  };

  let response;
  try {
    response = await openaiRequest('/responses', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  } catch (error) {
    task.status = 'failed';
    task.error = {
      message: error.message,
      body: error.body || null,
    };
    task.updatedAt = new Date().toISOString();
    task.progress = buildProgress(null, task);
    throw error;
  }

  task.responseId = response.id;
  updateTaskFromResponse(task, response);
  sendJson(res, 200, { task: publicTask(task, { full: true }) });
}

async function handleCancelTask(task, res) {
  if (task.provider === 'gpt-researcher') {
    if (task.abortController) task.abortController.abort();
    task.status = 'cancelled';
    task.updatedAt = new Date().toISOString();
    task.progress = buildProgress(null, task);
    sendJson(res, 200, { task: publicTask(task, { full: true }) });
    return;
  }

  if (!task.responseId) {
    sendJson(res, 400, { error: 'response id unavailable' });
    return;
  }
  const response = await openaiRequest(
    `/responses/${encodeURIComponent(task.responseId)}/cancel`,
    { method: 'POST', body: '{}' },
  );
  updateTaskFromResponse(task, response);
  sendJson(res, 200, { task: publicTask(task, { full: true }) });
}

function reportMarkdown(task) {
  const body = safeText(task.outputText) || '# Deep Research Report\n\nNo report content available.\n';
  const sources = Array.isArray(task.sources) ? task.sources : [];
  if (sources.length === 0) return `${body.trim()}\n`;
  const hasSourcesHeading = /^##\s+(Sources|References|资料来源|来源)/im.test(body);
  if (hasSourcesHeading) return `${body.trim()}\n`;
  return `${body.trim()}\n\n## Sources\n\n${sources
    .map((source, index) => {
      const title = source.title || source.url;
      return `${index + 1}. [${title}](${source.url})`;
    })
    .join('\n')}\n`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
      const safeUrl = escapeHtml(url);
      return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a>`;
    });
}

function markdownToHtml(markdown) {
  const lines = markdown.split(/\r?\n/);
  const html = [];
  let listOpen = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listOpen) return;
    html.push('</ul>');
    listOpen = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      flushParagraph();
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(trimmed.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return html.join('\n');
}

function printableHtml(task) {
  const markdown = reportMarkdown(task);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(task.title || 'Deep Research Report')}</title>
  <style>
    body { color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.62; margin: 42px auto; max-width: 960px; padding: 0 36px; }
    h1 { font-size: 30px; line-height: 1.2; margin: 0 0 18px; }
    h2 { border-top: 1px solid #e5e7eb; font-size: 21px; margin: 34px 0 12px; padding-top: 18px; }
    h3 { font-size: 17px; margin: 24px 0 8px; }
    p, li { font-size: 14px; }
    a { color: #2563eb; overflow-wrap: anywhere; }
    @media print { body { margin: 18mm auto; max-width: none; padding: 0; } }
  </style>
</head>
<body>
${markdownToHtml(markdown)}
<script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>
</body>
</html>`;
}

async function handleExport(task, type, res) {
  if (!TERMINAL_STATUSES.has(task.status)) await refreshTask(task);
  if (!safeText(task.outputText)) {
    sendJson(res, 400, { error: 'report is not ready' });
    return;
  }
  if (type === 'markdown') {
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="deep-research-report.md"',
      'Cache-Control': 'no-store',
    });
    res.end(reportMarkdown(task));
    return;
  }
  if (type === 'pdf') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'inline; filename="deep-research-report.html"',
      'Cache-Control': 'no-store',
    });
    res.end(printableHtml(task));
    return;
  }
  sendJson(res, 404, { error: 'export type not found' });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (target !== PUBLIC_DIR && !target.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const ext = path.extname(target).toLowerCase();
  const contentType =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(target).pipe(res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, {
        providers: [
          {
            id: 'openai',
            label: PROVIDERS.openai.label,
            models: PROVIDERS.openai.models,
            default_model: PROVIDERS.openai.defaultModel,
            configured: !!process.env.OPENAI_API_KEY,
          },
          {
            id: 'gpt-researcher',
            label: PROVIDERS['gpt-researcher'].label,
            models: PROVIDERS['gpt-researcher'].models,
            default_model: PROVIDERS['gpt-researcher'].defaultModel,
            configured: !!GPT_RESEARCHER_BASE_URL,
          },
        ],
        default_provider: DEFAULT_PROVIDER,
        models: PROVIDERS[DEFAULT_PROVIDER].models,
        default_model: PROVIDERS[DEFAULT_PROVIDER].defaultModel,
        api_configured: !!process.env.OPENAI_API_KEY,
      });
      return;
    }

    if (pathname === '/api/research' && req.method === 'POST') {
      await handleCreateResearch(req, res);
      return;
    }

    if (pathname === '/api/research/tasks' && req.method === 'GET') {
      const items = [...tasks.values()]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((task) => publicTask(task));
      sendJson(res, 200, { tasks: items });
      return;
    }

    const match = pathname.match(/^\/api\/research\/([^/]+)(?:\/(.+))?$/);
    if (match) {
      const task = tasks.get(decodeURIComponent(match[1]));
      if (!task) {
        sendJson(res, 404, { error: 'task not found' });
        return;
      }
      const suffix = match[2] || '';
      if (!suffix && req.method === 'GET') {
        await refreshTask(task);
        sendJson(res, 200, { task: publicTask(task, { full: true }) });
        return;
      }
      if (suffix === 'cancel' && req.method === 'POST') {
        await handleCancelTask(task, res);
        return;
      }
      if (suffix === 'export/markdown' && req.method === 'GET') {
        await handleExport(task, 'markdown', res);
        return;
      }
      if (suffix === 'export/pdf' && req.method === 'GET') {
        await handleExport(task, 'pdf', res);
        return;
      }
      sendJson(res, 404, { error: 'route not found' });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || 'server error',
      detail: error.body || null,
    });
  }
}

const server = http.createServer((req, res) => {
  route(req, res);
});

server.on('error', (error) => {
  console.error(`Failed to start OpenAI Deep Research web app: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`OpenAI Deep Research web app listening on http://${HOST}:${PORT}`);
});
