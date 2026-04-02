export interface ModelSelectionInput {
  prompt: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ModelSelection {
  selectedModel: string;
  reason: string;
}

const MODEL_LIGHT = process.env.NANOCLAW_MODEL_LIGHT || 'claude-haiku-4-5';
const MODEL_DEFAULT = process.env.NANOCLAW_MODEL_DEFAULT || 'claude-sonnet-4-6';
const MODEL_HEAVY = process.env.NANOCLAW_MODEL_HEAVY || 'claude-opus-4-6';
const MODEL_FORCE = process.env.NANOCLAW_MODEL_FORCE || '';

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function scoreKeywordHits(text: string, keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) score++;
  }
  return score;
}

export function getDefaultModel(): string {
  return MODEL_DEFAULT;
}

export function selectModel(input: ModelSelectionInput): ModelSelection {
  if (MODEL_FORCE) {
    return { selectedModel: MODEL_FORCE, reason: 'forced' };
  }

  const text = (input.prompt || '').toLowerCase();

  if (input.isScheduledTask) {
    const reminderLike = hasAny(text, [
      /提醒/,
      /remind/,
      /notification/,
      /通知/,
    ]);
    const heavyLike = hasAny(text, [
      /分析/,
      /research/,
      /debug/,
      /代码/,
      /code/,
      /测试/,
      /test/,
    ]);
    if (reminderLike && !heavyLike) {
      return { selectedModel: MODEL_LIGHT, reason: 'scheduled_simple' };
    }
    return { selectedModel: MODEL_DEFAULT, reason: 'scheduled_general' };
  }

  if (input.isMain) {
    return { selectedModel: MODEL_HEAVY, reason: 'main_group' };
  }

  const hardKeywords = [
    'bug', 'debug', 'fix', 'refactor', 'test', 'trace',
    'sql', 'migration', '架构', '性能', '并发', '故障', '回归',
    '实现', '代码', '编译', '部署', 'workflow',
  ];
  const lightKeywords = [
    '总结', '翻译', '润色', '改写', '提醒', '状态',
    'summarize', 'translate', 'rewrite',
  ];

  const hardScore = scoreKeywordHits(text, hardKeywords);
  const lightScore = scoreKeywordHits(text, lightKeywords);

  if (hardScore >= 2) {
    return { selectedModel: MODEL_HEAVY, reason: 'hard_prompt' };
  }

  if (lightScore >= 1 && hardScore === 0) {
    return { selectedModel: MODEL_LIGHT, reason: 'light_prompt' };
  }

  return { selectedModel: MODEL_DEFAULT, reason: 'default' };
}
