import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import type { MailProfile } from './mail.js';
import {
  confirmTodayPlanMailDraft,
  getTodayPlanMailDraftDetail,
  prepareTodayPlanMailDraft,
} from './today-plan-mail.js';
import {
  createTodayPlanItemForPlan,
  ensureTodayPlan,
  patchTodayPlanItem,
} from './today-plan.js';

function buildMailProfile(): MailProfile {
  return {
    smtp: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      user: 'mailer@example.com',
      pass: 'secret',
    },
    from: {
      address: 'mailer@example.com',
      name: '日报机器人',
    },
    reply_to: 'reply@example.com',
    defaults: {
      to: ['daily@example.com'],
      cc: ['team@example.com'],
      bcc: [],
    },
  };
}

describe('today-plan-mail', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('prepares a pending-confirm draft with summarized body', async () => {
    const plan = ensureTodayPlan('2026-04-21');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '推进今日开发',
      detail: '完成计划邮件闭环设计',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [],
      },
    });

    const draft = await prepareTodayPlanMailDraft(
      {
        planId: plan.id,
        groups: {},
        name: '张頔',
      },
      {
        loadProfile: buildMailProfile,
        summarizeBody: async () =>
          '1. 推进今日开发\n- 完成计划邮件闭环设计与发送链路梳理',
      },
    );

    expect(draft.status).toBe('pending_confirm');
    expect(draft.subject).toBe('日报-张頔-2026-04-21');
    expect(draft.body).toContain('完成计划邮件闭环设计');
    expect(draft.to).toEqual(['daily@example.com']);
    expect(draft.cc).toEqual(['team@example.com']);
    expect(getTodayPlanMailDraftDetail(draft.id)?.status).toBe('pending_confirm');
  });

  it('uses custom to and cc when provided', async () => {
    const plan = ensureTodayPlan('2026-04-21');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '推进今日开发',
      detail: '完成计划邮件闭环设计',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [],
      },
    });

    const draft = await prepareTodayPlanMailDraft(
      {
        planId: plan.id,
        groups: {},
        name: '张頔',
        to: ['owner@example.com', 'reviewer@example.com'],
        cc: ['leader@example.com'],
      },
      {
        loadProfile: buildMailProfile,
        summarizeBody: async () =>
          '1. 推进今日开发\n- 完成计划邮件闭环设计与发送链路梳理',
      },
    );

    expect(draft.to).toEqual(['owner@example.com', 'reviewer@example.com']);
    expect(draft.cc).toEqual(['leader@example.com']);
    expect(draft.bcc).toEqual([]);
  });

  it('confirms and sends a prepared draft without re-summarizing', async () => {
    const plan = ensureTodayPlan('2026-04-21');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '推进今日开发',
      detail: '完成计划邮件闭环设计',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [],
      },
    });

    const draft = await prepareTodayPlanMailDraft(
      {
        planId: plan.id,
        groups: {},
        name: '张頔',
      },
      {
        loadProfile: buildMailProfile,
        summarizeBody: async () =>
          '1. 推进今日开发\n- 完成计划邮件闭环设计与发送链路梳理',
      },
    );

    const sentPayloads: Array<{
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
    }> = [];

    const sent = await confirmTodayPlanMailDraft(
      { draftId: draft.id },
      {
        loadProfile: buildMailProfile,
        sendMail: async (input) => {
          sentPayloads.push({
            to: [...input.to],
            cc: [...(input.cc || [])],
            bcc: [...(input.bcc || [])],
            subject: input.subject,
            body: input.body,
          });
          return { recipients: input.to };
        },
      },
    );

    expect(sent.status).toBe('sent');
    expect(sent.sent_at).toBeTruthy();
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.subject).toBe('日报-张頔-2026-04-21');
    expect(sentPayloads[0]?.body).toContain('发送链路梳理');
    expect(sentPayloads[0]?.to).toEqual(['daily@example.com']);
    expect(getTodayPlanMailDraftDetail(draft.id)?.status).toBe('sent');
  });

  it('sends the edited preview content when confirm overrides draft fields', async () => {
    const plan = ensureTodayPlan('2026-04-21');
    const item = createTodayPlanItemForPlan(plan.id);
    patchTodayPlanItem({
      itemId: item.id,
      title: '推进今日开发',
      detail: '完成计划邮件闭环设计',
      associations: {
        workbench_task_ids: [],
        chat_selections: [],
        services: [],
      },
    });

    const draft = await prepareTodayPlanMailDraft(
      {
        planId: plan.id,
        groups: {},
        name: '张頔',
      },
      {
        loadProfile: buildMailProfile,
        summarizeBody: async () =>
          '1. 推进今日开发\n- 完成计划邮件闭环设计与发送链路梳理',
      },
    );

    const sentPayloads: Array<{
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      body: string;
    }> = [];

    const sent = await confirmTodayPlanMailDraft(
      {
        draftId: draft.id,
        subject: '日报-张頔-手改主题',
        body: '1. 推进今日开发\n- 手动调整后的邮件正文',
        to: ['owner@example.com'],
        cc: ['leader@example.com'],
        bcc: ['audit@example.com'],
      },
      {
        loadProfile: buildMailProfile,
        sendMail: async (input) => {
          sentPayloads.push({
            to: [...input.to],
            cc: [...(input.cc || [])],
            bcc: [...(input.bcc || [])],
            subject: input.subject,
            body: input.body,
          });
          return { recipients: input.to };
        },
      },
    );

    expect(sent.status).toBe('sent');
    expect(sent.subject).toBe('日报-张頔-手改主题');
    expect(sent.body).toContain('手动调整后的邮件正文');
    expect(sent.to).toEqual(['owner@example.com']);
    expect(sent.cc).toEqual(['leader@example.com']);
    expect(sent.bcc).toEqual(['audit@example.com']);
    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]?.subject).toBe('日报-张頔-手改主题');
    expect(sentPayloads[0]?.body).toContain('手动调整后的邮件正文');
    expect(sentPayloads[0]?.to).toEqual(['owner@example.com']);
    expect(sentPayloads[0]?.cc).toEqual(['leader@example.com']);
    expect(sentPayloads[0]?.bcc).toEqual(['audit@example.com']);
  });
});
