import fs from 'fs';
import path from 'path';

import { PROJECT_ROOT } from './config.js';
import {
  deleteWorkbenchTaskData,
  getWorkbenchTaskById,
  getWorkbenchTaskByWorkflowId,
} from './db.js';
import type { Workflow } from './types.js';
import {
  addWorkbenchComment,
  createWorkbenchTask,
  getWorkbenchTaskDetail,
  listWorkbenchTasks,
  type WorkbenchTaskDetail,
  type WorkbenchTaskItem,
} from './workbench.js';
import {
  getWorkflowContextValue,
  WORKFLOW_CONTEXT_KEYS,
} from './workflow-context.js';

export const DEEP_RESEARCH_WORKFLOW_TYPE = 'deep_research';
export const DEEP_RESEARCH_SERVICE = 'research';

const REPORT_FILE = 'report.json';
const SOURCES_FILE = 'sources.json';
const SOURCE_REVIEW_FILE = 'source_review.json';
const EVIDENCE_FILE = 'evidence.json';
const FINDINGS_FILE = 'findings.json';
const EVIDENCE_REVIEW_FILE = 'evidence_review.json';
const REVIEW_FILE = 'review.json';
const SEARCH_LOG_FILE = 'search_log.json';
const RESEARCH_PLAN_FILE = 'research_plan.json';
const DEFAULT_BUNDLE_SOURCE_LIMIT = 120;
const DEFAULT_BUNDLE_EVIDENCE_LIMIT = 120;
const DEFAULT_BUNDLE_FINDING_LIMIT = 120;
const DEFAULT_BUNDLE_TEXT_LIMIT = 4000;
const CONTINUATION_BUNDLE_TEXT_LIMIT = 1200;
const CONTINUATION_MAX_TASKS = 6;
const DEEP_RESEARCH_FILE_NAMES = new Set([
  REPORT_FILE,
  SOURCES_FILE,
  SOURCE_REVIEW_FILE,
  EVIDENCE_FILE,
  FINDINGS_FILE,
  EVIDENCE_REVIEW_FILE,
  REVIEW_FILE,
  SEARCH_LOG_FILE,
  RESEARCH_PLAN_FILE,
  'traceability.json',
]);

export interface DeepResearchCreateInput {
  title?: string;
  research_query?: string;
  depth?: string;
  language?: string;
  report_style?: string;
  source_scope?: string;
  constraints?: string;
  source_limits?: string;
  source_jid?: string;
  parent_task_id?: string;
  context_task_ids?: string[];
}

export interface DeepResearchExportResult {
  path: string;
  absolute_path: string;
  content_type: string;
  filename: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function slugifyDeliverable(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const base = ascii || 'research';
  const suffix = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 14);
  return `${base}-${suffix}`;
}

function isSafePathSegment(value: string): boolean {
  return (
    !!value && value !== '.' && value !== '..' && !/[\u0000/\\]/.test(value)
  );
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function formatDateTime(value: unknown): string {
  const raw = safeText(value);
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function buildDeepResearchTitle(input: DeepResearchCreateInput): string {
  const explicitTitle = safeText(input.title);
  if (explicitTitle) return explicitTitle;
  const query = safeText(input.research_query);
  if (!query) return 'Deep Research';
  return query.length > 60 ? `${query.slice(0, 57)}...` : query;
}

export function buildDeepResearchContext(
  input: DeepResearchCreateInput,
): Record<string, unknown> {
  const researchQuery = safeText(input.research_query);
  const deliverable = slugifyDeliverable(researchQuery || 'research');
  if (!isSafePathSegment(deliverable)) {
    throw new Error('failed to generate safe deliverable name');
  }
  const continuation = buildContinuationContext(input);
  return {
    research_query: researchQuery,
    depth: safeText(input.depth) || 'deep',
    source_scope: safeText(input.source_scope) || 'public_web',
    language: safeText(input.language) || 'zh',
    report_style: safeText(input.report_style) || 'deep_report',
    constraints: safeText(input.constraints),
    source_limits: safeText(input.source_limits),
    previous_research_context: continuation?.prompt || '',
    previous_research_task_ids: continuation?.contextTaskIds || [],
    parent_research_task_id: continuation?.parentTaskId || '',
    [WORKFLOW_CONTEXT_KEYS.deliverable]: deliverable,
  };
}

export function createDeepResearchTask(input: DeepResearchCreateInput): {
  workflowId: string;
  taskId?: string;
  detail?: WorkbenchTaskDetail | null;
  error?: string;
} {
  if (Object.prototype.hasOwnProperty.call(input, 'exclusions')) {
    return {
      workflowId: '',
      error: 'exclusions is no longer supported; use constraints',
    };
  }
  const researchQuery = safeText(input.research_query);
  const sourceJid = safeText(input.source_jid);
  if (!researchQuery)
    return { workflowId: '', error: 'research_query required' };
  if (!sourceJid) return { workflowId: '', error: 'source_jid required' };

  const result = createWorkbenchTask({
    title: buildDeepResearchTitle(input),
    service: DEEP_RESEARCH_SERVICE,
    sourceJid,
    startFrom: 'plan',
    workflowType: DEEP_RESEARCH_WORKFLOW_TYPE,
    context: buildDeepResearchContext(input),
  });
  if (result.error)
    return { workflowId: result.workflowId, error: result.error };

  const detail = getWorkbenchTaskDetail(result.workflowId);
  return {
    workflowId: result.workflowId,
    taskId: detail?.task.id,
    detail,
  };
}

export function listDeepResearchTasks(): WorkbenchTaskItem[] {
  return listWorkbenchTasks().filter(
    (task) => task.workflow_type === DEEP_RESEARCH_WORKFLOW_TYPE,
  );
}

export function getDeepResearchTaskDetail(
  taskId: string,
): WorkbenchTaskDetail | null {
  const detail = getWorkbenchTaskDetail(taskId);
  if (!detail || detail.task.workflow_type !== DEEP_RESEARCH_WORKFLOW_TYPE) {
    return null;
  }
  return detail;
}

export function resolveDeepResearchTaskId(id: string): string | null {
  const task = getWorkbenchTaskById(id);
  if (task?.workflow_type === DEEP_RESEARCH_WORKFLOW_TYPE) return task.id;
  const byWorkflow = getWorkbenchTaskByWorkflowId(id);
  if (byWorkflow?.workflow_type === DEEP_RESEARCH_WORKFLOW_TYPE) {
    return byWorkflow.id;
  }
  return null;
}

export function deleteDeepResearchTask(id: string): {
  deleted?: ReturnType<typeof deleteWorkbenchTaskData>;
  error?: string;
} {
  const taskId = resolveDeepResearchTaskId(id);
  if (!taskId) return { error: 'Deep Research task not found' };
  const deleted = deleteWorkbenchTaskData(taskId);
  if (!deleted) return { error: 'Deep Research task not found' };
  return { deleted };
}

function getTaskBundleDir(task: WorkbenchTaskItem): string | null {
  const deliverable = String(
    task.context?.[WORKFLOW_CONTEXT_KEYS.deliverable] || '',
  ).trim();
  if (!task.service || !isSafePathSegment(deliverable)) return null;
  return path.join(
    PROJECT_ROOT,
    'projects',
    task.service,
    'iteration',
    deliverable,
  );
}

function getExistingBundleDirForDeliverable(
  service: string,
  deliverable: unknown,
): string | null {
  const value = safeText(deliverable);
  if (!service || !isSafePathSegment(value)) return null;
  const candidate = path.join(
    PROJECT_ROOT,
    'projects',
    service,
    'iteration',
    value,
  );
  return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    ? candidate
    : null;
}

function getBundleDirFromArtifactPath(artifactPath: string): string | null {
  const resolved = path.resolve(PROJECT_ROOT, artifactPath);
  const fileName = path.basename(resolved);
  if (!DEEP_RESEARCH_FILE_NAMES.has(fileName)) return null;
  const dir = path.dirname(resolved);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}

function findDeepResearchBundleDir(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.replace(/\\/g, '/');
    const match = normalized.match(
      /(?:^|\/)(projects\/[^/]+\/iteration\/[^/\s"']+)/,
    );
    if (!match) return null;
    const candidate = path.resolve(PROJECT_ROOT, match[1]);
    return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
      ? candidate
      : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepResearchBundleDir(item);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const entry of Object.values(value)) {
    const found = findDeepResearchBundleDir(entry);
    if (found) return found;
  }
  return null;
}

function getDetailBundleDir(detail: WorkbenchTaskDetail): string | null {
  const contextDir = getTaskBundleDir(detail.task);
  if (
    contextDir &&
    fs.existsSync(contextDir) &&
    fs.statSync(contextDir).isDirectory()
  ) {
    return contextDir;
  }
  for (const artifact of detail.artifacts) {
    if (!artifact.exists) continue;
    const artifactDir = getBundleDirFromArtifactPath(artifact.path);
    if (artifactDir) return artifactDir;
  }
  const stageResults = isRecord(detail.task.context?.stage_results)
    ? detail.task.context.stage_results
    : {};
  for (const result of Object.values(stageResults)) {
    if (!isRecord(result)) continue;
    const resultDir = getExistingBundleDirForDeliverable(
      detail.task.service,
      result.deliverable,
    );
    if (resultDir) return resultDir;
  }
  return findDeepResearchBundleDir(detail.task.context) || contextDir;
}

function readJsonFile(filePath: string): unknown | null {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  } catch {
    return null;
  }
}

export function readDeepResearchArtifact(
  taskId: string,
  fileName: string,
): unknown | null {
  const detail = getDeepResearchTaskDetail(taskId);
  if (!detail) return null;
  const bundleDir = getDetailBundleDir(detail);
  if (!bundleDir) return null;
  return readJsonFile(path.join(bundleDir, fileName));
}

export function readDeepResearchReport(taskId: string): unknown | null {
  return readDeepResearchArtifact(taskId, REPORT_FILE);
}

export function readDeepResearchSources(taskId: string): unknown | null {
  return readDeepResearchArtifact(taskId, SOURCES_FILE);
}

export function readDeepResearchEvidence(taskId: string): unknown | null {
  return readDeepResearchArtifact(taskId, EVIDENCE_FILE);
}

interface CitationRenderContext {
  sources: Map<string, Record<string, unknown>>;
  sourceNumbers: Map<string, number>;
  orderedSourceIds: string[];
}

function createCitationRenderContext(
  sources: Map<string, Record<string, unknown>>,
): CitationRenderContext {
  return {
    sources,
    sourceNumbers: new Map(),
    orderedSourceIds: [],
  };
}

function getCitationNumber(
  sourceId: string,
  context: CitationRenderContext,
): number {
  const existing = context.sourceNumbers.get(sourceId);
  if (existing) return existing;
  const next = context.orderedSourceIds.length + 1;
  context.sourceNumbers.set(sourceId, next);
  context.orderedSourceIds.push(sourceId);
  return next;
}

function citationMarkers(
  citations: unknown,
  context: CitationRenderContext,
): string {
  const ids = normalizeStringArray(citations);
  if (ids.length === 0) return '';
  return ids.map((id) => `[${getCitationNumber(id, context)}]`).join('');
}

function textWithCitationMarkers(
  text: string,
  citations: unknown,
  context: CitationRenderContext,
): string {
  const markers = citationMarkers(citations, context);
  return markers ? `${text} ${markers}` : text;
}

function citationAppendixLabel(
  sourceId: string,
  source: Record<string, unknown> | undefined,
): string {
  const title = safeText(source?.title) || sourceId;
  const publisher =
    safeText(source?.publisher) || safeText(source?.source_type);
  const publishedAt = safeText(source?.published_at);
  const retrievedAt = safeText(source?.retrieved_at);
  const url = safeText(source?.url);
  const meta = [sourceId, publisher, publishedAt || retrievedAt]
    .filter(Boolean)
    .join(' · ');
  return `${meta ? `${meta} · ` : ''}${title}${url ? `：${url}` : ''}`;
}

function reportValueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(reportValueText).filter(Boolean).join('、');
  }
  if (isRecord(value)) {
    return (
      safeText(value.text) ||
      safeText(value.title) ||
      safeText(value.name) ||
      safeText(value.label) ||
      JSON.stringify(value)
    );
  }
  return '';
}

function markdownTableCell(value: unknown): string {
  return reportValueText(value)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim();
}

function appendMarkdownTable(
  lines: string[],
  headers: string[],
  rows: string[][],
): void {
  if (headers.length === 0 || rows.length === 0) return;
  lines.push(`| ${headers.map(markdownTableCell).join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    const cells = headers.map((_, index) =>
      markdownTableCell(row[index] || ''),
    );
    lines.push(`| ${cells.join(' | ')} |`);
  }
}

function appendReportTableBlock(
  lines: string[],
  block: Record<string, unknown>,
  context: CitationRenderContext,
): void {
  const rows = Array.isArray(block.rows)
    ? block.rows.filter(isRecord)
    : Array.isArray(block.items)
      ? block.items.filter(isRecord)
      : [];
  if (rows.length === 0) return;

  const columns = Array.isArray(block.columns)
    ? block.columns
        .map((column) => {
          if (typeof column === 'string') {
            return { key: column, label: column };
          }
          if (!isRecord(column)) return null;
          const key = safeText(column.key) || safeText(column.id);
          if (!key) return null;
          return { key, label: safeText(column.label) || key };
        })
        .filter((column): column is { key: string; label: string } => !!column)
    : Object.keys(rows[0])
        .filter((key) => key !== 'citations' && key !== 'source_ids')
        .slice(0, 6)
        .map((key) => ({ key, label: key }));

  if (columns.length === 0) return;

  const tableRows = rows.map((row) => {
    const cells = columns.map((column) => reportValueText(row[column.key]));
    const markers = citationMarkers(row.citations || row.source_ids, context);
    if (markers && cells.length > 0) {
      cells[cells.length - 1] = `${cells[cells.length - 1]} ${markers}`.trim();
    }
    return cells;
  });

  appendMarkdownTable(
    lines,
    columns.map((column) => column.label),
    tableRows,
  );
}

function appendReportBlock(
  lines: string[],
  block: Record<string, unknown>,
  context: CitationRenderContext,
): void {
  const type = safeText(block.type) || 'paragraph';
  if (type === 'paragraph') {
    const text = safeText(block.text);
    if (text)
      lines.push(textWithCitationMarkers(text, block.citations, context));
    return;
  }
  if (type === 'insight_card') {
    const title = safeText(block.title) || '洞察';
    const body = safeText(block.body);
    lines.push(
      textWithCitationMarkers(
        `> ${title}${body ? `：${body}` : ''}`,
        block.citations,
        context,
      ),
    );
    return;
  }
  if (type === 'metric_grid' && Array.isArray(block.items)) {
    lines.push('| 指标 | 数值 | 说明 |');
    lines.push('| --- | --- | --- |');
    for (const item of block.items) {
      if (!isRecord(item)) continue;
      const note = textWithCitationMarkers(
        safeText(item.note),
        item.citations,
        context,
      );
      lines.push(
        `| ${markdownTableCell(item.label)} | ${markdownTableCell(item.value)} | ${markdownTableCell(note)} |`,
      );
    }
    return;
  }
  if (type === 'table') {
    appendReportTableBlock(lines, block, context);
    return;
  }
  if (type === 'timeline' && Array.isArray(block.events)) {
    for (const event of block.events) {
      if (!isRecord(event)) continue;
      const description = safeText(event.description)
        ? `：${safeText(event.description)}`
        : '';
      lines.push(
        textWithCitationMarkers(
          `- ${safeText(event.date)} ${safeText(event.title)}${description}`,
          event.citations,
          context,
        ),
      );
    }
    return;
  }
  if (type === 'source_cluster') {
    const ids = normalizeStringArray(block.source_ids);
    if (ids.length > 0) {
      lines.push(
        ids
          .map((id) => {
            const source = context.sources.get(id);
            const title = safeText(source?.title) || id;
            return `- ${title} ${citationMarkers([id], context)}`;
          })
          .join('\n'),
      );
    }
    return;
  }
  const text = safeText(block.text) || safeText(block.body);
  if (text) lines.push(textWithCitationMarkers(text, block.citations, context));
}

function appendMethodology(lines: string[], methodology: unknown): void {
  if (!isRecord(methodology)) return;
  const labels: Record<string, string> = {
    scope: '研究范围',
    ranking_basis: '排序口径',
    important_caveat: '关键限制',
    data_window: '数据窗口',
    evidence_basis: '证据基础',
    source_policy: '来源策略',
  };
  const entries = Object.entries(methodology).filter(
    ([, value]) => reportValueText(value).length > 0,
  );
  if (entries.length === 0) return;
  lines.push('', '## 方法与数据口径', '');
  for (const [key, value] of entries) {
    lines.push(`- ${labels[key] || key}：${reportValueText(value)}`);
  }
}

function appendCandidateTop10(
  lines: string[],
  candidates: unknown,
  context: CitationRenderContext,
): void {
  const rows = Array.isArray(candidates) ? candidates.filter(isRecord) : [];
  if (rows.length === 0) return;
  lines.push('', '## Top10/关键对象清单', '');
  appendMarkdownTable(
    lines,
    ['排名', '对象', '赛道/类别', '公开指标', '置信度', '判断依据'],
    rows.map((row, index) => {
      const project = reportValueText(row.project || row.name || row.app);
      const repo = reportValueText(row.repo);
      const label = repo && repo !== project ? `${project} / ${repo}` : project;
      const basis = reportValueText(
        row.why_included || row.rationale || row.notes || row.description,
      );
      return [
        reportValueText(row.rank) || String(index + 1),
        label,
        reportValueText(row.segment || row.category || row.classification),
        reportValueText(
          row.current_visible_stars ||
            row.observed_value ||
            row.metric ||
            row.public_metric,
        ),
        reportValueText(row.ranking_confidence || row.confidence),
        textWithCitationMarkers(
          basis,
          row.citations || row.source_ids,
          context,
        ),
      ];
    }),
  );
}

function appendBoundaryCandidates(
  lines: string[],
  candidates: unknown,
  context: CitationRenderContext,
): void {
  const rows = Array.isArray(candidates) ? candidates.filter(isRecord) : [];
  if (rows.length === 0) return;
  lines.push('', '## 边界样本与排除项', '');
  for (const row of rows) {
    const name = reportValueText(row.project || row.name || row.app);
    const reason = reportValueText(row.reason || row.notes);
    lines.push(
      `- ${textWithCitationMarkers(`${name}${reason ? `：${reason}` : ''}`, row.citations || row.source_ids, context)}`,
    );
  }
}

function appendSourceAppendix(
  lines: string[],
  context: CitationRenderContext,
): void {
  if (context.sources.size === 0) return;
  for (const id of context.sources.keys()) {
    getCitationNumber(id, context);
  }
  lines.push('', '## 资料来源', '');
  for (const id of context.orderedSourceIds) {
    const number = getCitationNumber(id, context);
    lines.push(
      `- [${number}] ${citationAppendixLabel(id, context.sources.get(id))}`,
    );
  }
}

export function renderDeepResearchMarkdown(input: {
  report: unknown;
  sources: unknown;
}): string {
  const report = isRecord(input.report) ? input.report : {};
  const sourceItems = Array.isArray(input.sources) ? input.sources : [];
  const sources = new Map<string, Record<string, unknown>>();
  for (const source of sourceItems) {
    if (!isRecord(source)) continue;
    const id = safeText(source.id);
    if (id) sources.set(id, source);
  }
  const citations = createCitationRenderContext(sources);

  const lines: string[] = [];
  lines.push(`# ${safeText(report.title) || 'Deep Research Report'}`);
  const subtitle = safeText(report.subtitle);
  if (subtitle) lines.push('', subtitle);
  const generatedAt = formatDateTime(report.generated_at);
  if (generatedAt) lines.push('', `生成时间：${generatedAt}`);
  const researchQuestion = safeText(report.research_question);
  if (researchQuestion) lines.push('', `研究问题：${researchQuestion}`);

  const summary = isRecord(report.summary) ? report.summary : null;
  if (summary) {
    lines.push('', '## 执行摘要');
    const headline = safeText(summary.headline);
    if (headline) lines.push('', headline);
    if (Array.isArray(summary.bullets)) {
      lines.push('');
      for (const bullet of summary.bullets) {
        if (!isRecord(bullet)) continue;
        const text = safeText(bullet.text);
        if (!text) continue;
        lines.push(
          `- ${textWithCitationMarkers(text, bullet.citations, citations)}`,
        );
      }
    }
  }

  appendMethodology(lines, report.methodology);
  appendCandidateTop10(lines, report.candidate_top10, citations);

  if (Array.isArray(report.sections)) {
    for (const section of report.sections) {
      if (!isRecord(section)) continue;
      lines.push('', `## ${safeText(section.title) || 'Section'}`);
      if (Array.isArray(section.blocks)) {
        for (const block of section.blocks) {
          if (!isRecord(block)) continue;
          lines.push('');
          appendReportBlock(lines, block, citations);
        }
      }
    }
  }

  appendBoundaryCandidates(
    lines,
    report.excluded_or_boundary_candidates,
    citations,
  );

  if (Array.isArray(report.limitations) && report.limitations.length > 0) {
    lines.push('', '## 限制与未确认事项', '');
    for (const item of report.limitations) {
      if (isRecord(item)) {
        lines.push(`- ${safeText(item.text)}`);
      } else if (typeof item === 'string') {
        lines.push(`- ${item}`);
      }
    }
  }

  appendSourceAppendix(lines, citations);

  return `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInlineMarkdownHtml(value: string): string {
  return escapeHtml(value).replace(/\[(\d+)\]/g, '<sup>[$1]</sup>');
}

function splitMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function renderMarkdownTableHtml(lines: string[]): string {
  if (lines.length < 2) return '';
  const headers = splitMarkdownTableRow(lines[0]);
  const rows = lines.slice(2).map(splitMarkdownTableRow);
  return `<table><thead><tr>${headers
    .map((header) => `<th>${renderInlineMarkdownHtml(header)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${headers
          .map(
            (_, index) =>
              `<td>${renderInlineMarkdownHtml(row[index] || '')}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('')}</tbody></table>`;
}

function markdownToPrintHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let listOpen = false;

  const closeList = (): void => {
    if (!listOpen) return;
    html.push('</ul>');
    listOpen = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }

    if (
      trimmed.startsWith('|') &&
      lines[index + 1] &&
      isMarkdownTableSeparator(lines[index + 1])
    ) {
      closeList();
      const tableLines = [trimmed, lines[index + 1].trim()];
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        tableLines.push(lines[index].trim());
        index += 1;
      }
      index -= 1;
      html.push(renderMarkdownTableHtml(tableLines));
      continue;
    }

    if (trimmed.startsWith('# ')) {
      closeList();
      html.push(`<h1>${renderInlineMarkdownHtml(trimmed.slice(2))}</h1>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      closeList();
      html.push(`<h2>${renderInlineMarkdownHtml(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('### ')) {
      closeList();
      html.push(`<h3>${renderInlineMarkdownHtml(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith('- ')) {
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdownHtml(trimmed.slice(2))}</li>`);
      continue;
    }
    if (trimmed.startsWith('> ')) {
      closeList();
      html.push(
        `<blockquote>${renderInlineMarkdownHtml(trimmed.slice(2))}</blockquote>`,
      );
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdownHtml(trimmed)}</p>`);
  }

  closeList();
  return html.join('\n');
}

function buildPrintHtml(input: { report: unknown; sources: unknown }): string {
  const body = markdownToPrintHtml(renderDeepResearchMarkdown(input));
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Deep Research Report</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; line-height: 1.62; margin: 42px auto; max-width: 980px; padding: 0 36px; }
    h1 { font-size: 30px; line-height: 1.2; margin: 0 0 14px; }
    h2 { font-size: 21px; line-height: 1.3; margin: 34px 0 12px; padding-top: 6px; border-top: 1px solid #e5e7eb; }
    h3 { font-size: 16px; margin: 20px 0 8px; }
    p { margin: 8px 0 12px; }
    ul { margin: 8px 0 16px; padding-left: 22px; }
    li { margin: 5px 0; }
    blockquote { margin: 14px 0; padding: 10px 14px; border-left: 3px solid #94a3b8; background: #f8fafc; }
    table { width: 100%; border-collapse: collapse; margin: 14px 0 22px; font-size: 12px; line-height: 1.45; }
    th, td { border: 1px solid #d9dee7; padding: 7px 8px; vertical-align: top; text-align: left; }
    th { background: #f3f6fa; font-weight: 700; }
    sup { color: #2563eb; font-size: 10px; margin-left: 1px; }
    @media print { body { margin: 18mm auto; max-width: none; padding: 0; } h2 { break-after: avoid; } table { break-inside: avoid; } }
  </style>
</head>
<body>${body}<script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script></body>
</html>`;
}

export function exportDeepResearchMarkdown(
  taskOrWorkflowId: string,
): DeepResearchExportResult | { error: string } {
  const taskId = resolveDeepResearchTaskId(taskOrWorkflowId);
  if (!taskId) return { error: 'Deep Research task not found' };
  const detail = getDeepResearchTaskDetail(taskId);
  if (!detail) return { error: 'Deep Research task not found' };
  const bundleDir = getDetailBundleDir(detail);
  if (!bundleDir) return { error: 'Deep Research bundle path unavailable' };
  const report = readJsonFile(path.join(bundleDir, REPORT_FILE));
  if (!report) return { error: 'report.json not found or invalid' };
  const sources = readJsonFile(path.join(bundleDir, SOURCES_FILE)) || [];
  const markdown = renderDeepResearchMarkdown({ report, sources });
  const exportDir = path.join(bundleDir, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const outputPath = path.join(exportDir, 'report.md');
  fs.writeFileSync(outputPath, markdown, 'utf-8');
  return {
    path: path.relative(PROJECT_ROOT, outputPath),
    absolute_path: outputPath,
    content_type: 'text/markdown; charset=utf-8',
    filename: 'report.md',
  };
}

export function exportDeepResearchPdf(
  taskOrWorkflowId: string,
): DeepResearchExportResult | { error: string } {
  const taskId = resolveDeepResearchTaskId(taskOrWorkflowId);
  if (!taskId) return { error: 'Deep Research task not found' };
  const detail = getDeepResearchTaskDetail(taskId);
  if (!detail) return { error: 'Deep Research task not found' };
  const bundleDir = getDetailBundleDir(detail);
  if (!bundleDir) return { error: 'Deep Research bundle path unavailable' };
  const report = readJsonFile(path.join(bundleDir, REPORT_FILE));
  if (!report) return { error: 'report.json not found or invalid' };
  const sources = readJsonFile(path.join(bundleDir, SOURCES_FILE)) || [];
  const exportDir = path.join(bundleDir, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  const outputPath = path.join(exportDir, 'report.html');
  fs.writeFileSync(outputPath, buildPrintHtml({ report, sources }), 'utf-8');
  return {
    path: path.relative(PROJECT_ROOT, outputPath),
    absolute_path: outputPath,
    content_type: 'text/html; charset=utf-8',
    filename: 'report.html',
  };
}

function truncateDeepResearchText(value: unknown, maxChars: number): unknown {
  if (typeof value !== 'string') return value;
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function compactDeepResearchValue(
  value: unknown,
  maxTextChars: number,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => compactDeepResearchValue(item, maxTextChars));
  }
  if (!isRecord(value)) return truncateDeepResearchText(value, maxTextChars);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      compactDeepResearchValue(entry, maxTextChars),
    ]),
  );
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function truncateContinuationArray(value: unknown, maxItems: number): unknown {
  if (!Array.isArray(value)) return value ?? null;
  return value
    .slice(0, maxItems)
    .map((item) =>
      compactDeepResearchValue(item, CONTINUATION_BUNDLE_TEXT_LIMIT),
    );
}

function buildContinuationContextTask(
  taskId: string,
): Record<string, unknown> | null {
  const detail = getDeepResearchTaskDetail(taskId);
  if (!detail) return null;
  if (
    detail.task.task_state === 'cancelled' ||
    detail.task.workflow_status === 'cancelled'
  ) {
    return null;
  }
  const bundleDir = getDetailBundleDir(detail);
  const read = (fileName: string) =>
    bundleDir ? readJsonFile(path.join(bundleDir, fileName)) : null;
  return {
    task_id: detail.task.id,
    workflow_id: detail.task.id,
    title: detail.task.title,
    research_query:
      typeof detail.task.context?.research_query === 'string'
        ? detail.task.context.research_query
        : '',
    created_at: detail.task.created_at,
    updated_at: detail.task.updated_at,
    status: detail.task.workflow_status_label || detail.task.workflow_status,
    stage_outputs: detail.subtasks.map((item) => ({
      stage_key: item.stage_key,
      stage_label: item.stage_label,
      status: item.status,
      output_summary: item.result || '',
      delegation_id: item.delegation_id || '',
    })),
    artifacts: {
      research_plan: compactDeepResearchValue(
        read(RESEARCH_PLAN_FILE),
        CONTINUATION_BUNDLE_TEXT_LIMIT,
      ),
      sources: truncateContinuationArray(read(SOURCES_FILE), 30),
      source_review: compactDeepResearchValue(
        read(SOURCE_REVIEW_FILE),
        CONTINUATION_BUNDLE_TEXT_LIMIT,
      ),
      evidence: truncateContinuationArray(read(EVIDENCE_FILE), 30),
      findings: truncateContinuationArray(read(FINDINGS_FILE), 30),
      evidence_review: compactDeepResearchValue(
        read(EVIDENCE_REVIEW_FILE),
        CONTINUATION_BUNDLE_TEXT_LIMIT,
      ),
      report: compactDeepResearchValue(
        read(REPORT_FILE),
        CONTINUATION_BUNDLE_TEXT_LIMIT,
      ),
      review: compactDeepResearchValue(
        read(REVIEW_FILE),
        CONTINUATION_BUNDLE_TEXT_LIMIT,
      ),
    },
  };
}

function buildContinuationContext(input: DeepResearchCreateInput): {
  parentTaskId: string;
  contextTaskIds: string[];
  prompt: string;
} | null {
  const parentTaskId = safeText(input.parent_task_id);
  const explicitIds = parseStringArray(input.context_task_ids);
  const ids = Array.from(
    new Set(
      [parentTaskId, ...explicitIds].map((id) => safeText(id)).filter(Boolean),
    ),
  ).slice(0, CONTINUATION_MAX_TASKS);
  if (ids.length === 0) return null;

  const tasks = ids
    .map((id) => {
      const resolved = resolveDeepResearchTaskId(id);
      return resolved ? buildContinuationContextTask(resolved) : null;
    })
    .filter((item): item is Record<string, unknown> => item !== null);
  if (tasks.length === 0) return null;

  const payload = {
    generated_at: new Date().toISOString(),
    instruction:
      '本次是 Deep Research 续研。以下历史研究问题、各阶段产物和最终产物只能作为参考上下文；新报告必须围绕当前研究问题重新检索、验证和引用公开网页来源。',
    parent_task_id: parentTaskId || (ids[0] ?? ''),
    tasks,
  };
  return {
    parentTaskId: parentTaskId || (ids[0] ?? ''),
    contextTaskIds: tasks
      .map((task) => String(task.task_id || ''))
      .filter(Boolean),
    prompt: JSON.stringify(payload, null, 2),
  };
}

function limitDeepResearchArray(
  value: unknown,
  maxItems: number,
  maxTextChars = DEFAULT_BUNDLE_TEXT_LIMIT,
): unknown | null {
  if (!Array.isArray(value)) return value ?? null;
  return value
    .slice(0, maxItems)
    .map((item) => compactDeepResearchValue(item, maxTextChars));
}

export interface DeepResearchBundleOptions {
  full?: boolean;
  sourceLimit?: number;
  evidenceLimit?: number;
  findingLimit?: number;
}

export function getDeepResearchBundle(taskId: string): {
  detail: WorkbenchTaskDetail;
  bundle_dir: string | null;
  files: Record<string, unknown | null>;
} | null {
  return getDeepResearchBundleWithOptions(taskId);
}

export function getDeepResearchBundleWithOptions(
  taskId: string,
  options: DeepResearchBundleOptions = {},
): {
  detail: WorkbenchTaskDetail;
  bundle_dir: string | null;
  files: Record<string, unknown | null>;
} | null {
  const detail = getDeepResearchTaskDetail(taskId);
  if (!detail) return null;
  const bundleDir = getDetailBundleDir(detail);
  const read = (fileName: string) =>
    bundleDir ? readJsonFile(path.join(bundleDir, fileName)) : null;
  const sourceLimit = options.sourceLimit || DEFAULT_BUNDLE_SOURCE_LIMIT;
  const evidenceLimit = options.evidenceLimit || DEFAULT_BUNDLE_EVIDENCE_LIMIT;
  const findingLimit = options.findingLimit || DEFAULT_BUNDLE_FINDING_LIMIT;
  const sources = read(SOURCES_FILE);
  const evidence = read(EVIDENCE_FILE);
  const findings = read(FINDINGS_FILE);
  if (options.full) {
    return {
      detail,
      bundle_dir: bundleDir,
      files: {
        research_plan: read(RESEARCH_PLAN_FILE),
        search_log: read(SEARCH_LOG_FILE),
        sources,
        source_review: read(SOURCE_REVIEW_FILE),
        evidence,
        findings,
        evidence_review: read(EVIDENCE_REVIEW_FILE),
        report: read(REPORT_FILE),
        review: read(REVIEW_FILE),
      },
    };
  }
  return {
    detail,
    bundle_dir: bundleDir,
    files: {
      research_plan: null,
      search_log: null,
      sources: limitDeepResearchArray(sources, sourceLimit),
      source_review: null,
      evidence: limitDeepResearchArray(evidence, evidenceLimit),
      findings: limitDeepResearchArray(findings, findingLimit),
      evidence_review: null,
      report: read(REPORT_FILE),
      review: null,
    },
  };
}

export function steerDeepResearchTask(input: {
  taskId: string;
  instruction: string;
}): { error?: string } {
  const taskId = resolveDeepResearchTaskId(input.taskId);
  if (!taskId) return { error: 'Deep Research task not found' };
  const instruction = safeText(input.instruction);
  if (!instruction) return { error: 'instruction required' };
  return addWorkbenchComment({
    taskId,
    author: 'deep-research',
    content: `[Steering]\n${instruction}`,
  });
}

export function exportDeepResearchForWorkflowAction(workflow: Workflow): {
  status: 'success' | 'failure';
  output?: Record<string, unknown>;
  error?: string;
} {
  const task = getWorkbenchTaskByWorkflowId(workflow.id);
  const taskOrWorkflowId = task?.id || workflow.id;
  const markdown = exportDeepResearchMarkdown(taskOrWorkflowId);
  if ('error' in markdown) {
    return { status: 'failure', error: markdown.error };
  }
  const pdf = exportDeepResearchPdf(taskOrWorkflowId);
  if ('error' in pdf) {
    return { status: 'failure', error: pdf.error };
  }
  return {
    status: 'success',
    output: {
      markdown_path: markdown.path,
      pdf_path: pdf.path,
      deliverable: getWorkflowContextValue(
        workflow,
        WORKFLOW_CONTEXT_KEYS.deliverable,
      ),
    },
  };
}
