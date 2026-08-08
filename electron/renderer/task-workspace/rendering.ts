export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const escapeAttribute = escapeHtml;

export function formatTime(value: unknown): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '--';
  return new Date(milliseconds).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function compactId(value: unknown): string {
  const id = String(value ?? '');
  if (id.length <= 18) return id || '--';
  return `${id.slice(0, 8)}...${id.slice(-6)}`;
}

export function readableLabel(value: unknown): string {
  return String(value ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const WORKSPACE_DISPLAY_LABELS: Readonly<Record<string, string>> = {
  active: '进行中',
  action_required: '需要处理',
  accepted: '已接受',
  activating: '激活中',
  approved: '已批准',
  approval: '审批',
  applied: '已应用',
  applying: '应用中',
  archived: '已归档',
  armed: '待处理',
  awaiting_confirmation: '等待确认',
  blocked: '已阻塞',
  cancelling: '取消中',
  cancelled: '已取消',
  catching_up: '同步中',
  closed: '已结束',
  command: '命令',
  completed: '已完成',
  confirmed: '已确认',
  conflict: '冲突',
  creating: '创建中',
  degraded: '已降级',
  denied: '已拒绝',
  discarded: '已丢弃',
  draft: '草稿',
  drafting: '生成中',
  dry_run_passed: 'Dry Run 已通过',
  duplicate: '重复',
  executing: '执行中',
  expired: '已过期',
  failed: '失败',
  idle: '空闲',
  interaction: '交互',
  interrupted: '已中断',
  late: '已超时',
  linked: '已关联',
  none: '无',
  open: '进行中',
  paused: '已暂停',
  pending: '待处理',
  processing: '处理中',
  published: '已发布',
  publishing: '发布中',
  ready: '就绪',
  rejected: '已拒绝',
  resolved: '已解决',
  retrying: '重试中',
  reviewed: '已审核',
  running: '运行中',
  skipped: '已跳过',
  succeeded: '成功',
  terminal: '已结束',
  temporary_confirmation: 'Temporary 确认',
  temporary_replan_confirmation: 'Temporary Replan 确认',
  temporary_replan_request: 'Temporary Replan 请求',
  runtime_command_confirmation: 'Runtime 命令确认',
  runtime_wait: 'Runtime 等待',
  signal: 'Signal',
  unavailable: '不可用',
  unknown: '未知',
  unsupported: '不支持',
  validated: '已验证',
  waiting: '等待中',
  waiting_user: '等待用户',
  approve: '批准',
  cancel: '取消',
  pause: '暂停',
  reject: '拒绝',
  resume: '继续',
  submit: '提交',
  overview: '概览',
  artifacts: '产物',
  trace: 'Trace',
};

export function workspaceDisplayLabel(value: unknown): string {
  const key = String(value ?? '');
  if (!key || key === '--') return key;
  return WORKSPACE_DISPLAY_LABELS[key] ?? readableLabel(key);
}

export function safeAssetUrl(value: unknown): string {
  const url = String(value ?? '').trim();
  if (url.startsWith('/') || /^https?:\/\//i.test(url) || /^blob:/i.test(url)) {
    return url;
  }
  return '';
}

function renderInlineMarkdown(line: string): string {
  return escapeHtml(line)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
      return `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${label}</a>`;
    });
}

export function renderMarkdown(value: unknown): string {
  const lines = String(value ?? '').split(/\r?\n/);
  const output: string[] = [];
  let listOpen = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) output.push('<ul>');
      listOpen = true;
      output.push(`<li>${renderInlineMarkdown(bullet[1] ?? '')}</li>`);
      continue;
    }
    if (listOpen) output.push('</ul>');
    listOpen = false;
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = Math.min(4, (heading[1]?.length ?? 1) + 2);
      output.push(
        `<h${level}>${renderInlineMarkdown(heading[2] ?? '')}</h${level}>`,
      );
    } else if (line.trim()) {
      output.push(`<p>${renderInlineMarkdown(line)}</p>`);
    } else {
      output.push('<br>');
    }
  }
  if (listOpen) output.push('</ul>');
  return output.join('');
}

export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function renderKeyValueTable(value: Record<string, unknown>): string {
  const rows = Object.entries(value)
    .slice(0, 40)
    .map(
      ([key, item]) => `
        <tr>
          <th>${escapeHtml(readableLabel(key))}</th>
          <td>${escapeHtml(isRecord(item) || Array.isArray(item) ? stringifyJson(item) : item)}</td>
        </tr>`,
    )
    .join('');
  return `<div class="tw-table-wrap"><table class="tw-data-table"><tbody>${rows}</tbody></table></div>`;
}

function renderRows(value: unknown[]): string {
  const rows = value.filter(isRecord).slice(0, 100);
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(
    0,
    12,
  );
  if (!rows.length || !keys.length) {
    return `<pre class="tw-json">${escapeHtml(stringifyJson(value))}</pre>`;
  }
  return `
    <div class="tw-table-wrap">
      <table class="tw-data-table">
        <thead><tr>${keys.map((key) => `<th>${escapeHtml(readableLabel(key))}</th>`).join('')}</tr></thead>
        <tbody>${rows
          .map(
            (row) =>
              `<tr>${keys.map((key) => `<td>${escapeHtml(isRecord(row[key]) || Array.isArray(row[key]) ? stringifyJson(row[key]) : row[key])}</td>`).join('')}</tr>`,
          )
          .join('')}</tbody>
      </table>
    </div>`;
}

export function renderArtifact(payload: Record<string, unknown>): string {
  const artifact = isRecord(payload.artifact) ? payload.artifact : payload;
  const display = isRecord(artifact.display_json)
    ? artifact.display_json
    : isRecord(artifact.display)
      ? artifact.display
      : artifact;
  const mime = String(
    display.mime_type ??
      display.media_type ??
      display.content_type ??
      display.mime ??
      '',
  ).toLocaleLowerCase();
  const format = String(
    display.format ?? display.kind ?? '',
  ).toLocaleLowerCase();
  const title = String(
    display.title ?? display.name ?? display.filename ?? 'Artifact',
  );
  const url = safeAssetUrl(
    display.download_url ?? display.url ?? display.file_url,
  );
  const content = display.content ?? display.value ?? display.data ?? null;
  let preview = '';
  if (url && mime.startsWith('image/')) {
    preview = `<img class="tw-artifact-media" src="${escapeAttribute(url)}" alt="${escapeAttribute(title)}">`;
  } else if (url && mime.startsWith('audio/')) {
    preview = `<audio class="tw-artifact-media" src="${escapeAttribute(url)}" controls></audio>`;
  } else if (url && mime.startsWith('video/')) {
    preview = `<video class="tw-artifact-media" src="${escapeAttribute(url)}" controls></video>`;
  } else if (format.includes('diff') || mime.includes('diff')) {
    preview = `<pre class="tw-diff">${escapeHtml(content ?? display.diff ?? '')}</pre>`;
  } else if (
    format.includes('markdown') ||
    mime.includes('markdown') ||
    mime === 'text/md'
  ) {
    preview = `<div class="tw-markdown">${renderMarkdown(content)}</div>`;
  } else if (Array.isArray(content)) {
    preview = renderRows(content);
  } else if (isRecord(content)) {
    preview = renderKeyValueTable(content);
  } else if (typeof content === 'string') {
    preview = `<pre class="tw-text-artifact">${escapeHtml(content)}</pre>`;
  } else if (format.includes('archive') || mime.includes('zip')) {
    preview = renderKeyValueTable(display);
  } else {
    preview = `<pre class="tw-json">${escapeHtml(stringifyJson(display))}</pre>`;
  }
  return `
    <article class="tw-artifact" data-artifact-ref="${escapeAttribute(artifact.artifact_ref ?? artifact.ref ?? '')}">
      <header><strong>${escapeHtml(title)}</strong><span>${escapeHtml(mime || format || 'data')}</span></header>
      ${preview}
      ${url ? `<a class="tw-command-link" href="${escapeAttribute(url)}" target="_blank" rel="noreferrer" download>下载</a>` : ''}
    </article>`;
}
