import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import {
  createAskQuestion,
  getAskQuestion,
  getExpiredPendingAskQuestions,
  updateAskQuestion,
} from './db.js';
import { logger } from './logger.js';
import {
  AskQuestionItem,
  AskQuestionOption,
  InteractiveCard,
  RegisteredGroup,
} from './types.js';

export const ASK_ACTION_ANSWER = 'ask_question_answer';
export const ASK_ACTION_SKIP = 'ask_question_skip';

type AskPayload = {
  questions: AskQuestionItem[];
  metadata?: Record<string, string>;
};

type AskAnswers = Record<string, string | string[]>;

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

function renderFallbackQuestionText(
  requestId: string,
  question: AskQuestionItem,
  index: number,
  total: number,
): string {
  const lines = [
    `问题 ${index + 1}/${total}`,
    question.question,
    '',
    ...question.options.map((opt, i) => {
      const desc = opt.description ? ` - ${opt.description}` : '';
      return `${i + 1}. ${opt.label}${desc}`;
    }),
    '',
    `请回复: /answer ${requestId} <选项序号或选项文本>`,
    `如需跳过: /answer ${requestId} skip`,
  ];
  return lines.join('\n');
}

function buildQuestionCard(
  requestId: string,
  groupFolder: string,
  question: AskQuestionItem,
  index: number,
  total: number,
): InteractiveCard {
  return {
    header: { title: `问题 ${index + 1}/${total}`, color: 'blue' },
    body: question.question,
    buttons: [
      ...question.options.map((opt, idx) => ({
        id: `answer-${index}-${idx}`,
        label: opt.label,
        value: {
          action: ASK_ACTION_ANSWER,
          group_folder: groupFolder,
          request_id: requestId,
          question_id: question.id,
          answer: opt.label,
        },
      })),
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

function resolveAnswer(
  question: AskQuestionItem,
  rawAnswer: string,
): string | string[] | null {
  const text = rawAnswer.trim();
  if (!text) return null;

  const normalize = (s: string) => s.trim().toLowerCase();
  const findByToken = (token: string): string | null => {
    const n = Number.parseInt(token, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= question.options.length) {
      return question.options[n - 1].label;
    }
    const exact = question.options.find((o) => o.label === token);
    if (exact) return exact.label;
    const ci = question.options.find((o) => normalize(o.label) === normalize(token));
    return ci?.label || null;
  };

  if (question.multi_select) {
    const tokens = text
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) return null;
    const selected: string[] = [];
    for (const token of tokens) {
      const v = findByToken(token);
      if (!v) return null;
      if (!selected.includes(v)) selected.push(v);
    }
    return selected;
  }

  return findByToken(text);
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
  skip?: boolean;
  reject?: boolean;
  registeredGroups: Record<string, RegisteredGroup>;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
  sendMessage?: (jid: string, text: string) => Promise<void>;
}): Promise<{ ok: boolean; userMessage: string; completed: boolean }> {
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

  const resolved = resolveAnswer(currentQuestion, params.answer || '');
  if (resolved === null) {
    return {
      ok: false,
      userMessage: '答案无效，请回复选项序号或完整选项文本。',
      completed: false,
    };
  }

  const answers = parseAnswers(rec.answers_json);
  answers[currentQuestion.id] = resolved;
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
