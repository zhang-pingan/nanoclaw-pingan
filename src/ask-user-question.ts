import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  createAskQuestion,
  getAskQuestion,
  getDelegation,
  getExpiredPendingAskQuestions,
  listWorkbenchActionItemsBySource,
  updateAskQuestion,
  updateDelegation,
} from './db.js';
import { logger } from './logger.js';
import {
  AskQuestionField,
  AskQuestionFieldEnumOption,
  AskQuestionItem,
  AskQuestionOption,
  InteractiveCard,
  RegisteredGroup,
} from './types.js';
import { updateWorkbenchInteractionItemStatus } from './workbench-store.js';

export const ASK_ACTION_ANSWER = 'ask_question_answer';
export const ASK_ACTION_SKIP = 'ask_question_skip';

type AskPayload = {
  questions: AskQuestionItem[];
  metadata?: Record<string, string>;
};

type AskAnswers = Record<string, unknown>;

type AskResolution = {
  ok: true;
  value: unknown;
} | {
  ok: false;
  error: string;
  fieldErrors?: Record<string, string>;
};

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(iso: string, sec: number): string {
  return new Date(new Date(iso).getTime() + sec * 1000).toISOString();
}

function writeAskResult(
  groupFolder: string,
  requestId: string,
  payload: Record<string, unknown>,
): void {
  const resultsDir = path.join(DATA_DIR, 'ipc', groupFolder, 'ask-results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `${requestId}.json`);
  const tempPath = `${resultPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, resultPath);
}

function parsePayload(payloadJson: string): AskPayload | null {
  try {
    const parsed = JSON.parse(payloadJson) as AskPayload;
    if (!parsed || !Array.isArray(parsed.questions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseAnswers(answersJson: string | null): AskAnswers {
  if (!answersJson) return {};
  try {
    const parsed = JSON.parse(answersJson) as AskAnswers;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function findChatJidByGroupFolder(
  groupFolder: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | undefined {
  const entry = Object.entries(registeredGroups).find(
    ([, g]) => g.folder === groupFolder,
  );
  return entry?.[0];
}

function isFormQuestion(question: AskQuestionItem): boolean {
  return Array.isArray(question.fields) && question.fields.length > 0;
}

function formatFieldLine(field: AskQuestionField): string {
  const req = field.required ? ' (必填)' : '';
  const type = ` [${field.type}]`;
  const enumHint = Array.isArray(field.enum) && field.enum.length > 0
    ? ` 可选值: ${field.enum.map((o) => o.label || o.value).join(' / ')}`
    : '';
  const desc = field.description ? ` - ${field.description}` : '';
  return `- ${field.label} (${field.id})${type}${req}${desc}${enumHint}`;
}

function renderFallbackQuestionText(
  requestId: string,
  question: AskQuestionItem,
  index: number,
  total: number,
  validationError?: string,
  validationErrors?: Record<string, string>,
): string {
  const errorLines = validationError
    ? [`⚠ 校验失败: ${validationError}`, '']
    : [];
  const fieldErrorLines = validationErrors && Object.keys(validationErrors).length > 0
    ? [
      '字段错误:',
      ...Object.entries(validationErrors).map(([k, v]) => `- ${k}: ${v}`),
      '',
    ]
    : [];
  if (isFormQuestion(question)) {
    const lines = [
      `问题 ${index + 1}/${total}`,
      question.question,
      '',
      ...errorLines,
      ...fieldErrorLines,
      '请填写以下字段：',
      ...(question.fields || []).map(formatFieldLine),
      '',
      `回复方式1(JSON): /answer ${requestId} {"字段id":"值"}`,
      `回复方式2(key=value): /answer ${requestId} key1=value1; key2=value2`,
      `如需跳过: /answer ${requestId} skip`,
    ];
    return lines.join('\n');
  }

  const lines = [
    `问题 ${index + 1}/${total}`,
    question.question,
    '',
    ...errorLines,
    ...fieldErrorLines,
    ...((question.options || []).map((opt, i) => {
      const desc = opt.description ? ` - ${opt.description}` : '';
      return `${i + 1}. ${opt.label}${desc}`;
    })),
    '',
    `请回复: /answer ${requestId} <选项序号或选项文本>`,
    `如需跳过: /answer ${requestId} skip`,
  ];
  return lines.join('\n');
}

function buildFormBody(question: AskQuestionItem): string {
  const fields = question.fields || [];
  const lines = [question.question, '', '字段说明:'];
  for (const f of fields) {
    lines.push(formatFieldLine(f));
  }
  return lines.join('\n');
}

function withValidationError(body: string, validationError?: string): string {
  if (!validationError) return body;
  return `⚠ 校验失败: ${validationError}\n\n${body}`;
}

function fieldPlaceholder(field: AskQuestionField): string {
  if (field.description && field.description.trim()) return field.description.trim();
  if (Array.isArray(field.enum) && field.enum.length > 0) {
    return `可选: ${field.enum.map((o) => o.label || o.value).join(', ')}`;
  }
  if (field.type === 'boolean') return 'true / false';
  if (field.type === 'integer') return '整数';
  if (field.type === 'number') return '数字';
  if (field.format === 'date') return 'YYYY-MM-DD';
  if (field.format === 'date-time') return 'YYYY-MM-DDTHH:mm:ssZ';
  return '';
}

function fieldInputType(field: AskQuestionField): 'text' | 'number' | 'integer' | 'boolean' | 'enum' {
  if (Array.isArray(field.enum) && field.enum.length > 0) return 'enum';
  if (field.type === 'boolean') return 'boolean';
  if (field.type === 'integer') return 'integer';
  if (field.type === 'number') return 'number';
  return 'text';
}

function buildQuestionCard(
  requestId: string,
  groupFolder: string,
  question: AskQuestionItem,
  index: number,
  total: number,
  validationError?: string,
  validationErrors?: Record<string, string>,
): InteractiveCard {
  if (isFormQuestion(question)) {
    const fields = question.fields || [];
    return {
      header: { title: `问题 ${index + 1}/${total}`, color: 'blue' },
      body: withValidationError(buildFormBody(question), validationError),
      buttons: [
        {
          id: `skip-${index}`,
          label: '跳过',
          value: {
            action: ASK_ACTION_SKIP,
            group_folder: groupFolder,
            request_id: requestId,
          },
        },
      ],
      form: {
        name: `ask-form-${requestId}-${question.id}`,
        inputs: fields.map((f) => ({
          name: f.id,
          placeholder: fieldPlaceholder(f),
          type: fieldInputType(f),
          options: f.enum?.map((o) => ({
            value: o.value,
            label: o.label,
          })),
          required: f.required === true,
          min: f.min,
          max: f.max,
          min_length: f.min_length,
          max_length: f.max_length,
          format: f.format,
          error: validationErrors?.[f.id],
        })),
        submitButton: {
          id: `submit-${index}`,
          label: '提交',
          type: 'primary',
          value: {
            action: ASK_ACTION_ANSWER,
            group_folder: groupFolder,
            request_id: requestId,
            question_id: question.id,
          },
        },
      },
    };
  }

  return {
    header: { title: `问题 ${index + 1}/${total}`, color: 'blue' },
    body: withValidationError(question.question, validationError),
    buttons: [
      ...((question.options || []).map((opt, idx) => ({
        id: `answer-${index}-${idx}`,
        label: opt.label,
        value: {
          action: ASK_ACTION_ANSWER,
          group_folder: groupFolder,
          request_id: requestId,
          question_id: question.id,
          answer: opt.label,
        },
      }))),
      {
        id: `skip-${index}`,
        label: '跳过',
        value: {
          action: ASK_ACTION_SKIP,
          group_folder: groupFolder,
          request_id: requestId,
        },
      },
    ],
  };
}

function normalizeToken(s: string): string {
  return s.trim().toLowerCase();
}

function resolveOptionAnswer(
  question: AskQuestionItem,
  rawAnswer: string,
): AskResolution {
  const options = question.options || [];
  const text = rawAnswer.trim();
  if (!text) return { ok: false, error: '答案不能为空。' };

  const findByToken = (token: string): string | null => {
    const n = Number.parseInt(token, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
      return options[n - 1].label;
    }
    const exact = options.find((o) => o.label === token);
    if (exact) return exact.label;
    const ci = options.find((o) => normalizeToken(o.label) === normalizeToken(token));
    return ci?.label || null;
  };

  if (question.multi_select) {
    const tokens = text
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return { ok: false, error: '至少选择一个选项。' };
    const selected: string[] = [];
    for (const token of tokens) {
      const v = findByToken(token);
      if (!v) return { ok: false, error: `无效选项: ${token}` };
      if (!selected.includes(v)) selected.push(v);
    }
    return { ok: true, value: selected };
  }

  const resolved = findByToken(text);
  if (!resolved) {
    return { ok: false, error: '答案无效，请回复选项序号或完整选项文本。' };
  }
  return { ok: true, value: resolved };
}

function parseAnswerPairs(answerText: string): Record<string, string> | null {
  const text = answerText.trim();
  if (!text) return null;

  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          out[k] = String(v);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  const pairs: Record<string, string> = {};
  const chunks = text
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  let hasEq = false;
  for (const chunk of chunks) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    hasEq = true;
    const key = chunk.slice(0, eq).trim();
    const value = chunk.slice(eq + 1).trim();
    if (key) pairs[key] = value;
  }
  if (!hasEq) return null;
  return pairs;
}

function parseBoolean(raw: string): boolean | null {
  const v = normalizeToken(raw);
  if (['true', '1', 'yes', 'y', '是'].includes(v)) return true;
  if (['false', '0', 'no', 'n', '否'].includes(v)) return false;
  return null;
}

function isValidDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().startsWith(raw);
}

function isValidDateTime(raw: string): boolean {
  const d = new Date(raw);
  return !Number.isNaN(d.getTime());
}

function validateFieldValue(field: AskQuestionField, raw: string): AskResolution {
  const text = raw.trim();
  if (!text) return { ok: false, error: `字段 ${field.label} 不能为空。` };

  if (Array.isArray(field.enum) && field.enum.length > 0) {
    const matched = resolveEnumValue(field.enum, text);
    if (!matched) {
      return {
        ok: false,
        error: `字段 ${field.label} 必须是预设选项之一。`,
      };
    }
    return { ok: true, value: matched };
  }

  if (field.type === 'boolean') {
    const b = parseBoolean(text);
    if (b === null) return { ok: false, error: `字段 ${field.label} 必须是 true/false。` };
    return { ok: true, value: b };
  }

  if (field.type === 'integer') {
    const n = Number.parseInt(text, 10);
    if (Number.isNaN(n) || !/^[-+]?\d+$/.test(text)) {
      return { ok: false, error: `字段 ${field.label} 必须是整数。` };
    }
    if (typeof field.min === 'number' && n < field.min) {
      return { ok: false, error: `字段 ${field.label} 不能小于 ${field.min}。` };
    }
    if (typeof field.max === 'number' && n > field.max) {
      return { ok: false, error: `字段 ${field.label} 不能大于 ${field.max}。` };
    }
    return { ok: true, value: n };
  }

  if (field.type === 'number') {
    const n = Number(text);
    if (Number.isNaN(n)) {
      return { ok: false, error: `字段 ${field.label} 必须是数字。` };
    }
    if (typeof field.min === 'number' && n < field.min) {
      return { ok: false, error: `字段 ${field.label} 不能小于 ${field.min}。` };
    }
    if (typeof field.max === 'number' && n > field.max) {
      return { ok: false, error: `字段 ${field.label} 不能大于 ${field.max}。` };
    }
    return { ok: true, value: n };
  }

  if (typeof field.min_length === 'number' && text.length < field.min_length) {
    return {
      ok: false,
      error: `字段 ${field.label} 长度不能少于 ${field.min_length}。`,
    };
  }
  if (typeof field.max_length === 'number' && text.length > field.max_length) {
    return {
      ok: false,
      error: `字段 ${field.label} 长度不能超过 ${field.max_length}。`,
    };
  }

  if (field.format === 'email') {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRe.test(text)) {
      return { ok: false, error: `字段 ${field.label} 不是有效邮箱。` };
    }
  }

  if (field.format === 'uri') {
    try {
      // eslint-disable-next-line no-new
      new URL(text);
    } catch {
      return { ok: false, error: `字段 ${field.label} 不是有效链接。` };
    }
  }

  if (field.format === 'date' && !isValidDate(text)) {
    return { ok: false, error: `字段 ${field.label} 日期格式应为 YYYY-MM-DD。` };
  }

  if (field.format === 'date-time' && !isValidDateTime(text)) {
    return { ok: false, error: `字段 ${field.label} 不是有效时间。` };
  }

  return { ok: true, value: text };
}

function resolveEnumValue(options: AskQuestionFieldEnumOption[], raw: string): string | null {
  const text = raw.trim();
  const n = Number.parseInt(text, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= options.length) {
    return options[n - 1].value;
  }
  const exact = options.find((o) => o.value === text || o.label === text);
  if (exact) return exact.value;
  const ci = options.find(
    (o) => normalizeToken(o.value) === normalizeToken(text)
      || normalizeToken(o.label || '') === normalizeToken(text),
  );
  return ci?.value || null;
}

function resolveFormAnswer(
  question: AskQuestionItem,
  rawAnswer: string,
  formValues?: Record<string, string>,
): AskResolution {
  const fields = question.fields || [];
  const merged: Record<string, string> = {};

  if (formValues && typeof formValues === 'object') {
    for (const field of fields) {
      const v = formValues[field.id];
      if (typeof v === 'string') merged[field.id] = v;
    }
  }

  const parsedByText = parseAnswerPairs(rawAnswer);
  if (parsedByText) {
    for (const [k, v] of Object.entries(parsedByText)) {
      merged[k] = v;
    }
  } else if (rawAnswer.trim() && fields.length === 1 && !merged[fields[0].id]) {
    merged[fields[0].id] = rawAnswer.trim();
  }

  const output: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const field of fields) {
    const provided = merged[field.id];
    if ((provided === undefined || provided.trim() === '')) {
      if (field.required) {
        fieldErrors[field.id] = `缺少必填字段: ${field.label}(${field.id})`;
      }
      if (field.default !== undefined) {
        output[field.id] = field.default;
      }
      continue;
    }

    const validated = validateFieldValue(field, provided);
    if (!validated.ok) {
      fieldErrors[field.id] = validated.error;
      continue;
    }
    output[field.id] = validated.value;
  }

  const errorKeys = Object.keys(fieldErrors);
  if (errorKeys.length > 0) {
    return {
      ok: false,
      error: fieldErrors[errorKeys[0]],
      fieldErrors,
    };
  }

  return { ok: true, value: output };
}

function resolveAnswer(
  question: AskQuestionItem,
  rawAnswer: string,
  formValues?: Record<string, string>,
): AskResolution {
  if (isFormQuestion(question)) {
    return resolveFormAnswer(question, rawAnswer, formValues);
  }
  return resolveOptionAnswer(question, rawAnswer);
}

function normalizeField(
  questionId: string,
  raw: unknown,
  idx: number,
): { ok: true; field: AskQuestionField } | { ok: false; error: string } {
  const f = raw as Partial<AskQuestionField>;
  const id = (f.id || '').trim();
  const label = (f.label || '').trim();
  if (!id) return { ok: false, error: `questions[${questionId}].fields[${idx}].id is required` };
  if (!label) return { ok: false, error: `questions[${questionId}].fields[${idx}].label is required` };
  const t = f.type;
  if (!t || !['string', 'number', 'integer', 'boolean'].includes(t)) {
    return { ok: false, error: `questions[${questionId}].fields[${idx}].type must be string|number|integer|boolean` };
  }

  const field: AskQuestionField = {
    id,
    label,
    type: t,
    description: f.description?.trim() || undefined,
    required: f.required === true,
  };

  if (f.default !== undefined) {
    if (['string', 'number', 'boolean'].includes(typeof f.default)) {
      field.default = f.default;
    } else {
      return { ok: false, error: `questions[${questionId}].fields[${idx}].default type is invalid` };
    }
  }

  if (typeof f.min_length === 'number') field.min_length = Math.max(0, Math.floor(f.min_length));
  if (typeof f.max_length === 'number') field.max_length = Math.max(0, Math.floor(f.max_length));
  if (typeof f.min === 'number') field.min = f.min;
  if (typeof f.max === 'number') field.max = f.max;
  if (field.min_length !== undefined && field.max_length !== undefined && field.min_length > field.max_length) {
    return { ok: false, error: `questions[${questionId}].fields[${idx}] min_length cannot exceed max_length` };
  }
  if (field.min !== undefined && field.max !== undefined && field.min > field.max) {
    return { ok: false, error: `questions[${questionId}].fields[${idx}] min cannot exceed max` };
  }

  if (f.format !== undefined) {
    if (['email', 'uri', 'date', 'date-time'].includes(String(f.format))) {
      field.format = f.format as AskQuestionField['format'];
    } else {
      return { ok: false, error: `questions[${questionId}].fields[${idx}].format is invalid` };
    }
  }

  if (Array.isArray(f.enum) && f.enum.length > 0) {
    const normalizedEnum: AskQuestionFieldEnumOption[] = [];
    const seenValues = new Set<string>();
    for (let i = 0; i < f.enum.length; i += 1) {
      const opt = f.enum[i] as Partial<AskQuestionFieldEnumOption>;
      const value = (opt.value || '').trim();
      if (!value) {
        return { ok: false, error: `questions[${questionId}].fields[${idx}].enum[${i}].value is required` };
      }
      if (seenValues.has(value)) {
        return { ok: false, error: `questions[${questionId}].fields[${idx}] duplicate enum value: ${value}` };
      }
      seenValues.add(value);
      normalizedEnum.push({ value, label: opt.label?.trim() || undefined });
    }
    field.enum = normalizedEnum;
  }

  return { ok: true, field };
}

export function normalizeAskQuestions(raw: unknown): {
  ok: true;
  questions: AskQuestionItem[];
} | {
  ok: false;
  error: string;
} {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) {
    return { ok: false, error: 'questions must be an array with 1-4 items' };
  }

  const seenIds = new Set<string>();
  const questions: AskQuestionItem[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const q = raw[i] as Partial<AskQuestionItem>;
    const id = (q.id || '').trim();
    const question = (q.question || '').trim();
    if (!id) return { ok: false, error: `questions[${i}].id is required` };
    if (seenIds.has(id)) return { ok: false, error: `duplicate question id: ${id}` };
    seenIds.add(id);
    if (!question) {
      return { ok: false, error: `questions[${i}].question is required` };
    }

    const hasOptions = Array.isArray(q.options) && q.options.length > 0;
    const hasFields = Array.isArray(q.fields) && q.fields.length > 0;
    if (!hasOptions && !hasFields) {
      return {
        ok: false,
        error: `questions[${i}] must provide either options or fields`,
      };
    }
    if (hasOptions && hasFields) {
      return {
        ok: false,
        error: `questions[${i}] cannot provide both options and fields`,
      };
    }

    if (hasOptions) {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) {
        return {
          ok: false,
          error: `questions[${i}].options must be an array with 2-6 items`,
        };
      }
      const options: AskQuestionOption[] = [];
      const seenLabels = new Set<string>();
      for (let j = 0; j < q.options.length; j += 1) {
        const opt = q.options[j] as Partial<AskQuestionOption>;
        const label = (opt.label || '').trim();
        if (!label) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].label is required`,
          };
        }
        if (seenLabels.has(label)) {
          return { ok: false, error: `duplicate option label in ${id}: ${label}` };
        }
        seenLabels.add(label);
        options.push({
          label,
          description: opt.description?.trim() || undefined,
        });
      }
      questions.push({
        id,
        question,
        options,
        multi_select: q.multi_select === true,
      });
      continue;
    }

    if (!Array.isArray(q.fields) || q.fields.length < 1 || q.fields.length > 8) {
      return {
        ok: false,
        error: `questions[${i}].fields must be an array with 1-8 items`,
      };
    }

    const fields: AskQuestionField[] = [];
    const seenFieldIds = new Set<string>();
    for (let j = 0; j < q.fields.length; j += 1) {
      const normalizedField = normalizeField(id, q.fields[j], j);
      if (!normalizedField.ok) return normalizedField;
      if (seenFieldIds.has(normalizedField.field.id)) {
        return { ok: false, error: `duplicate field id in ${id}: ${normalizedField.field.id}` };
      }
      seenFieldIds.add(normalizedField.field.id);
      fields.push(normalizedField.field);
    }

    questions.push({ id, question, fields });
  }

  return { ok: true, questions };
}

export function createPendingAskQuestion(params: {
  requestId: string;
  groupFolder: string;
  chatJid: string;
  questions: AskQuestionItem[];
  timeoutSec: number;
  metadata?: Record<string, string>;
}): void {
  const createdAt = nowIso();
  createAskQuestion({
    id: params.requestId,
    group_folder: params.groupFolder,
    chat_jid: params.chatJid,
    status: 'pending',
    payload_json: JSON.stringify({
      questions: params.questions,
      metadata: params.metadata,
    } satisfies AskPayload),
    answers_json: JSON.stringify({}),
    current_index: 0,
    created_at: createdAt,
    expires_at: addSeconds(createdAt, params.timeoutSec),
    answered_at: null,
    responder_user_id: null,
  });
}

export async function dispatchCurrentAskQuestion(params: {
  requestId: string;
  groupFolder: string;
  validationError?: string;
  validationErrors?: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
  sendMessage?: (jid: string, text: string) => Promise<void>;
}): Promise<{ ok: boolean; message: string }> {
  const rec = getAskQuestion(params.requestId);
  if (!rec || rec.group_folder !== params.groupFolder) {
    return { ok: false, message: 'ask question not found' };
  }
  if (rec.status !== 'pending') {
    return { ok: false, message: `ask question is not pending (${rec.status})` };
  }
  const payload = parsePayload(rec.payload_json);
  if (!payload) return { ok: false, message: 'invalid ask payload' };
  const q = payload.questions[rec.current_index];
  if (!q) return { ok: false, message: 'invalid question index' };

  const chatJid = findChatJidByGroupFolder(
    params.groupFolder,
    params.registeredGroups,
  ) || rec.chat_jid;
  if (!chatJid) return { ok: false, message: 'target chat not found' };

  if (params.sendCard) {
    try {
      await params.sendCard(
        chatJid,
        buildQuestionCard(
          params.requestId,
          params.groupFolder,
          q,
          rec.current_index,
          payload.questions.length,
          params.validationError,
          params.validationErrors,
        ),
      );
      return { ok: true, message: 'question card sent' };
    } catch (err) {
      logger.warn(
        { err, requestId: params.requestId, chatJid },
        'Failed to send ask question card, falling back to text',
      );
    }
  }

  if (params.sendMessage) {
    await params.sendMessage(
      chatJid,
      renderFallbackQuestionText(
        params.requestId,
        q,
        rec.current_index,
        payload.questions.length,
        params.validationError,
        params.validationErrors,
      ),
    );
    return { ok: true, message: 'question text sent' };
  }

  return { ok: false, message: 'no sendCard/sendMessage available' };
}

export function parseAskAnswerCommand(
  content: string,
  triggerPattern: RegExp,
): { requestId: string; answer: string } | null {
  const text = content.trim().replace(triggerPattern, '').trim();
  if (!text.startsWith('/answer')) return null;
  const rest = text.slice('/answer'.length).trim();
  if (!rest) return null;
  const [requestId, ...answerParts] = rest.split(/\s+/);
  if (!requestId) return null;
  return {
    requestId: requestId.trim(),
    answer: answerParts.join(' ').trim(),
  };
}

export async function handleAskQuestionResponse(params: {
  requestId: string;
  groupFolder: string;
  userId: string;
  answer?: string;
  formValues?: Record<string, string>;
  skip?: boolean;
  reject?: boolean;
  registeredGroups: Record<string, RegisteredGroup>;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
  sendMessage?: (jid: string, text: string) => Promise<void>;
}): Promise<{
  ok: boolean;
  userMessage: string;
  completed: boolean;
  validationErrors?: Record<string, string>;
}> {
  const rec = getAskQuestion(params.requestId);
  if (!rec || rec.group_folder !== params.groupFolder) {
    return { ok: false, userMessage: '未找到对应的问题请求。', completed: false };
  }
  if (rec.status !== 'pending') {
    return {
      ok: false,
      userMessage: `该问题已结束（状态: ${rec.status}）。`,
      completed: true,
    };
  }

  const now = nowIso();
  if (new Date(rec.expires_at).getTime() <= Date.now()) {
    updateAskQuestion(rec.id, {
      status: 'timeout',
      answered_at: now,
      responder_user_id: params.userId,
    });
    writeAskResult(rec.group_folder, rec.id, {
      requestId: rec.id,
      status: 'timeout',
      answers: parseAnswers(rec.answers_json),
      answeredAt: now,
      responder: params.userId,
    });
    const timeoutPayload = parsePayload(rec.payload_json);
    updateWorkbenchInteractionItemStatus({
      sourceType:
        timeoutPayload?.metadata?.source_type === 'request_human_input'
          ? 'request_human_input'
          : 'ask_user_question',
      sourceRefId: rec.id,
      status: 'expired',
    });
    return { ok: false, userMessage: '该问题已超时。', completed: true };
  }

  if (params.skip || params.reject) {
    const status = params.reject ? 'rejected' : 'skipped';
    updateAskQuestion(rec.id, {
      status,
      answered_at: now,
      responder_user_id: params.userId,
    });
    writeAskResult(rec.group_folder, rec.id, {
      requestId: rec.id,
      status,
      answers: parseAnswers(rec.answers_json),
      answeredAt: now,
      responder: params.userId,
    });
    const skipPayload = parsePayload(rec.payload_json);
    updateWorkbenchInteractionItemStatus({
      sourceType:
        skipPayload?.metadata?.source_type === 'request_human_input'
          ? 'request_human_input'
          : 'ask_user_question',
      sourceRefId: rec.id,
      status: params.reject ? 'cancelled' : 'skipped',
    });
    return { ok: true, userMessage: '已记录为跳过。', completed: true };
  }

  const payload = parsePayload(rec.payload_json);
  if (!payload) {
    return { ok: false, userMessage: '问题数据损坏，无法处理。', completed: true };
  }
  const currentQuestion = payload.questions[rec.current_index];
  if (!currentQuestion) {
    return { ok: false, userMessage: '当前问题索引无效。', completed: true };
  }

  const resolved = resolveAnswer(
    currentQuestion,
    params.answer || '',
    params.formValues,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      userMessage: resolved.error,
      completed: false,
      validationErrors: resolved.fieldErrors,
    };
  }

  const answers = parseAnswers(rec.answers_json);
  answers[currentQuestion.id] = resolved.value;
  const nextIndex = rec.current_index + 1;
  const isComplete = nextIndex >= payload.questions.length;

  if (isComplete) {
    updateAskQuestion(rec.id, {
      status: 'answered',
      answers_json: JSON.stringify(answers),
      current_index: nextIndex,
      answered_at: now,
      responder_user_id: params.userId,
    });
    writeAskResult(rec.group_folder, rec.id, {
      requestId: rec.id,
      status: 'answered',
      answers,
      answeredAt: now,
      responder: params.userId,
    });
    updateWorkbenchInteractionItemStatus({
      sourceType:
        payload.metadata?.source_type === 'request_human_input'
          ? 'request_human_input'
          : 'ask_user_question',
      sourceRefId: rec.id,
      status: 'resolved',
    });
    return { ok: true, userMessage: '答案已提交，感谢。', completed: true };
  }

  updateAskQuestion(rec.id, {
    answers_json: JSON.stringify(answers),
    current_index: nextIndex,
    responder_user_id: params.userId,
  });

  const dispatch = await dispatchCurrentAskQuestion({
    requestId: rec.id,
    groupFolder: rec.group_folder,
    registeredGroups: params.registeredGroups,
    sendCard: params.sendCard,
    sendMessage: params.sendMessage,
  });

  if (!dispatch.ok) {
    return {
      ok: false,
      userMessage: `答案已记录，但发送下一题失败: ${dispatch.message}`,
      completed: false,
    };
  }

  return { ok: true, userMessage: '答案已记录，请继续下一题。', completed: false };
}

export async function expirePendingAskQuestions(params: {
  registeredGroups: Record<string, RegisteredGroup>;
  sendMessage?: (jid: string, text: string) => Promise<void>;
  onDelegationComplete?: (delegationId: string) => void;
}): Promise<void> {
  const now = nowIso();
  const expired = getExpiredPendingAskQuestions(now);
  if (expired.length === 0) return;

  for (const rec of expired) {
    updateAskQuestion(rec.id, {
      status: 'timeout',
      answered_at: now,
    });
    writeAskResult(rec.group_folder, rec.id, {
      requestId: rec.id,
      status: 'timeout',
      answers: parseAnswers(rec.answers_json),
      answeredAt: now,
      responder: null,
    });
    const payload = parsePayload(rec.payload_json);
    const sourceType =
      payload?.metadata?.source_type === 'request_human_input'
        ? 'request_human_input'
        : 'ask_user_question';
    updateWorkbenchInteractionItemStatus({
      sourceType,
      sourceRefId: rec.id,
      status: 'expired',
    });

    // Auto-complete pending delegation when ask_user_question times out
    if (params.onDelegationComplete) {
      const actionItems = listWorkbenchActionItemsBySource(sourceType, rec.id);
      for (const item of actionItems) {
        if (item.delegation_id) {
          const delegation = getDelegation(item.delegation_id);
          if (delegation && delegation.status === 'pending') {
            logger.info(
              { delegationId: item.delegation_id, requestId: rec.id },
              'Ask question timed out — auto-completing delegation',
            );
            updateDelegation(item.delegation_id, {
              status: 'completed',
              result: `问题超时未获得用户回复，已停止（requestId=${rec.id}）`,
              outcome: 'failure',
            });
            try {
              params.onDelegationComplete(item.delegation_id);
            } catch (err) {
              logger.error(
                { err, delegationId: item.delegation_id },
                'Auto delegation complete hook failed',
              );
            }
          }
          break;
        }
      }
    }

    if (params.sendMessage) {
      const chatJid =
        findChatJidByGroupFolder(rec.group_folder, params.registeredGroups) ||
        rec.chat_jid;
      if (chatJid) {
        await params.sendMessage(
          chatJid,
          `问题请求已超时（requestId=${rec.id}），已自动跳过。`,
        );
      }
    }
  }
}
