import { callAnthropicMessages } from './agent-api.js';
import {
  cancelPendingTodayPlanMailDrafts,
  createTodayPlanMailDraft,
  getTodayPlanMailDraftById,
  updateTodayPlanMailDraft,
} from './db.js';
import { loadMailProfile, MailProfile, sendMail } from './mail.js';
import {
  buildTodayPlanMailPrompt,
  getTodayPlanDateKey,
} from './today-plan.js';
import type { RegisteredGroup, TodayPlanMailDraftRecord } from './types.js';

export interface TodayPlanMailDraftDetail {
  id: string;
  plan_id: string;
  plan_date: string;
  sender_name: string;
  subject: string;
  body: string;
  to: string[];
  cc: string[];
  bcc: string[];
  attachments: string[];
  status: TodayPlanMailDraftRecord['status'];
  error_message: string | null;
  prepared_at: string | null;
  confirmed_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PrepareTodayPlanMailDraftDeps {
  loadProfile?: () => MailProfile;
  summarizeBody?: (prompt: string) => Promise<string>;
  now?: () => string;
}

interface ConfirmTodayPlanMailDraftDeps {
  loadProfile?: () => MailProfile;
  sendMail?: typeof sendMail;
  now?: () => string;
}

function nowTimestamp(): string {
  return Date.now().toString();
}

function uniqueTrimmed(values: string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function stringifyAddressList(values: string[]): string {
  return JSON.stringify(uniqueTrimmed(values));
}

function parseAddressList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? uniqueTrimmed(parsed.map((entry) => String(entry)))
      : [];
  } catch {
    return [];
  }
}

function toDraftDetail(record: TodayPlanMailDraftRecord): TodayPlanMailDraftDetail {
  return {
    id: record.id,
    plan_id: record.plan_id,
    plan_date: record.plan_date,
    sender_name: record.sender_name,
    subject: record.subject,
    body: record.body || '',
    to: parseAddressList(record.to_json),
    cc: parseAddressList(record.cc_json),
    bcc: parseAddressList(record.bcc_json),
    attachments: parseAddressList(record.attachments_json),
    status: record.status,
    error_message: record.error_message,
    prepared_at: record.prepared_at,
    confirmed_at: record.confirmed_at,
    sent_at: record.sent_at,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function normalizeGeneratedBody(text: string): string {
  let body = text.trim();
  body = body.replace(/^```[a-zA-Z0-9_-]*\s*/, '').replace(/\s*```$/, '');
  return body.trim();
}

async function summarizeTodayPlanMailBody(prompt: string): Promise<string> {
  const response = await callAnthropicMessages({
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 1600,
    temperature: 0,
  });
  return response.text;
}

export function getTodayPlanMailDraftDetail(
  draftId: string,
): TodayPlanMailDraftDetail | null {
  const record = getTodayPlanMailDraftById(draftId);
  return record ? toDraftDetail(record) : null;
}

export async function prepareTodayPlanMailDraft(
  input: {
    planId: string;
    groups: Record<string, RegisteredGroup>;
    name: string;
    to?: string[];
    cc?: string[];
  },
  deps: PrepareTodayPlanMailDraftDeps = {},
): Promise<TodayPlanMailDraftDetail> {
  const senderName = input.name.trim();
  if (!senderName) throw new Error('name required');

  const payload = buildTodayPlanMailPrompt({
    planId: input.planId,
    groups: input.groups,
    name: senderName,
  });
  if (!payload) throw new Error('Today plan not found');

  const loadProfileFn = deps.loadProfile || loadMailProfile;
  const summarizeBodyFn = deps.summarizeBody || summarizeTodayPlanMailBody;
  const now = deps.now || nowTimestamp;
  const profile = loadProfileFn();
  const customTo = uniqueTrimmed(input.to || []);
  const customCc = uniqueTrimmed(input.cc || []);
  const to =
    customTo.length > 0 ? customTo : uniqueTrimmed(profile.defaults.to);
  const cc =
    customCc.length > 0 ? customCc : uniqueTrimmed(profile.defaults.cc);
  const bcc = uniqueTrimmed(profile.defaults.bcc);
  if (to.length === 0) {
    throw new Error('邮件配置缺少默认收件人 defaults.to');
  }

  cancelPendingTodayPlanMailDrafts(payload.plan.plan.id);
  const draft = createTodayPlanMailDraft({
    plan_id: payload.plan.plan.id,
    plan_date: payload.plan.plan.plan_date || getTodayPlanDateKey(),
    sender_name: senderName,
    subject: payload.subject,
    body: null,
    to_json: stringifyAddressList(to),
    cc_json: stringifyAddressList(cc),
    bcc_json: stringifyAddressList(bcc),
    attachments_json: JSON.stringify([]),
    status: 'drafting',
  });

  try {
    const rawBody = await summarizeBodyFn(payload.prompt);
    const body = normalizeGeneratedBody(rawBody);
    if (!body) throw new Error('计划邮件正文生成结果为空');
    const preparedAt = now();
    updateTodayPlanMailDraft(draft.id, {
      body,
      status: 'pending_confirm',
      error_message: null,
      prepared_at: preparedAt,
      updated_at: preparedAt,
    });
    const prepared = getTodayPlanMailDraftDetail(draft.id);
    if (!prepared) throw new Error('Prepared draft not found');
    return prepared;
  } catch (err) {
    const updatedAt = now();
    updateTodayPlanMailDraft(draft.id, {
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      updated_at: updatedAt,
    });
    throw err;
  }
}

export async function confirmTodayPlanMailDraft(
  input: { draftId: string },
  deps: ConfirmTodayPlanMailDraftDeps = {},
): Promise<TodayPlanMailDraftDetail> {
  const record = getTodayPlanMailDraftById(input.draftId);
  if (!record) throw new Error('Mail draft not found');
  if (record.status === 'sent') throw new Error('计划邮件已发送');
  if (record.status !== 'pending_confirm') {
    throw new Error(`当前草稿状态不可发送: ${record.status}`);
  }

  const draft = toDraftDetail(record);
  if (!draft.body.trim()) throw new Error('邮件正文为空，无法发送');
  if (draft.to.length === 0) throw new Error('邮件收件人为空，无法发送');

  const loadProfileFn = deps.loadProfile || loadMailProfile;
  const sendMailFn = deps.sendMail || sendMail;
  const now = deps.now || nowTimestamp;
  const confirmedAt = now();

  updateTodayPlanMailDraft(draft.id, {
    status: 'sending',
    confirmed_at: confirmedAt,
    error_message: null,
    updated_at: confirmedAt,
  });

  try {
    const profile = loadProfileFn();
    await sendMailFn(
      {
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        body: draft.body,
        attachments: draft.attachments,
      },
      profile,
    );
    const sentAt = now();
    updateTodayPlanMailDraft(draft.id, {
      status: 'sent',
      error_message: null,
      sent_at: sentAt,
      updated_at: sentAt,
    });
    const sent = getTodayPlanMailDraftDetail(draft.id);
    if (!sent) throw new Error('Sent draft not found');
    return sent;
  } catch (err) {
    const updatedAt = now();
    updateTodayPlanMailDraft(draft.id, {
      status: 'failed',
      error_message: err instanceof Error ? err.message : String(err),
      updated_at: updatedAt,
    });
    throw err;
  }
}
