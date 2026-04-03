import { readEnvFile } from './env.js';

export interface ModelSelectionInput {
  prompt: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ModelSelection {
  selectedModel: string;
  reason: string;
}

const modelEnv = readEnvFile([
  'NANOCLAW_MODEL_LIGHT',
  'NANOCLAW_MODEL_DEFAULT',
  'NANOCLAW_MODEL_HEAVY',
  'NANOCLAW_MODEL_FORCE',
  'CREDENTIAL_PROXY_OPENAI_COMPAT',
  'NANOCLAW_MODEL_SELECTOR_URL',
  'NANOCLAW_MODEL_SELECTOR_MODEL',
  'NANOCLAW_MODEL_SELECTOR_TIMEOUT_MS',
]);
const MODEL_LIGHT =
  process.env.NANOCLAW_MODEL_LIGHT || modelEnv.NANOCLAW_MODEL_LIGHT || 'claude-haiku-4-5-20251001';
const MODEL_DEFAULT =
  process.env.NANOCLAW_MODEL_DEFAULT ||
  modelEnv.NANOCLAW_MODEL_DEFAULT ||
  'claude-sonnet-4-6';
const MODEL_HEAVY =
  process.env.NANOCLAW_MODEL_HEAVY || modelEnv.NANOCLAW_MODEL_HEAVY || 'claude-opus-4-6';
const MODEL_FORCE = process.env.NANOCLAW_MODEL_FORCE || modelEnv.NANOCLAW_MODEL_FORCE || '';
const CREDENTIAL_PROXY_OPENAI_COMPAT =
  (process.env.CREDENTIAL_PROXY_OPENAI_COMPAT ||
    modelEnv.CREDENTIAL_PROXY_OPENAI_COMPAT ||
    '')
    .trim()
    .toLowerCase() === 'true';
const SELECTOR_API_BASE_URL =
  process.env.NANOCLAW_MODEL_SELECTOR_URL ||
  modelEnv.NANOCLAW_MODEL_SELECTOR_URL ||
  'http://101.42.48.209:8000/v1';
const SELECTOR_API_MODEL =
  process.env.NANOCLAW_MODEL_SELECTOR_MODEL ||
  modelEnv.NANOCLAW_MODEL_SELECTOR_MODEL ||
  'DeepSeek-R1-Distill-Llama-70B';
const SELECTOR_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(
    process.env.NANOCLAW_MODEL_SELECTOR_TIMEOUT_MS ||
      modelEnv.NANOCLAW_MODEL_SELECTOR_TIMEOUT_MS ||
      '30000',
    10,
  ) || 30000,
);
const SELECTOR_MAX_TOKENS = 512;

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

function selectModelByRules(input: ModelSelectionInput): ModelSelection {
  if (MODEL_FORCE) {
    return { selectedModel: MODEL_FORCE, reason: 'forced' };
  }

  const text = (input.prompt || '').toLowerCase();

  if (input.isScheduledTask) {
    const reminderLike = hasAny(text, [
      /提醒/,
      /在吗/,
      /remind/,
      /notification/,
      /通知/,
    ]);
    const heavyLike = hasAny(text, [
      /分析/,
      /补充/,
      /代码/,
      /查/,
      /开发/,
      /实现/,
      /看下/,
      /测试/,
      /修改/,
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

type SelectorChoice = 'light' | 'default' | 'heavy';

function mapChoiceToModel(choice: SelectorChoice): string {
  if (choice === 'light') return MODEL_LIGHT;
  if (choice === 'heavy') return MODEL_HEAVY;
  return MODEL_DEFAULT;
}

function parseChoiceFromText(text: string): SelectorChoice | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === 'light' || normalized === 'default' || normalized === 'heavy') {
    return normalized;
  }

  // Strict JSON path: {"choice":"light|default|heavy"}
  const jsonChoiceMatch = normalized.match(/"choice"\s*:\s*"(light|default|heavy)"/);
  if (jsonChoiceMatch) {
    return jsonChoiceMatch[1] as SelectorChoice;
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { choice?: unknown };
      if (
        parsed.choice === 'light' ||
        parsed.choice === 'default' ||
        parsed.choice === 'heavy'
      ) {
        return parsed.choice;
      }
    } catch {
      // Continue to heuristics below.
    }
  }

  // Heuristic fallback: infer the final choice from reasoning text.
  // Avoid prompt echoes by removing candidate_models line first.
  const scrubbed = normalized
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<think>[\s\S]*?<\/think>/g, ' ')
    .replace(/^candidate_models:.*$/gm, ' ');

  const decisionPatterns: Array<[RegExp, SelectorChoice]> = [
    [/\b(?:choose|chosen|select|selected|use|using)\s+(?:the\s+)?light\b/i, 'light'],
    [/\b(?:choose|chosen|select|selected|use|using)\s+(?:the\s+)?default\b/i, 'default'],
    [/\b(?:choose|chosen|select|selected|use|using)\s+(?:the\s+)?heavy\b/i, 'heavy'],
    [/(?:选择|选用|应该使用|建议使用)\s*(?:为|是)?\s*light/i, 'light'],
    [/(?:选择|选用|应该使用|建议使用)\s*(?:为|是)?\s*default/i, 'default'],
    [/(?:选择|选用|应该使用|建议使用)\s*(?:为|是)?\s*heavy/i, 'heavy'],
    [/\blight\s*(?:tier|level|model|级别)\b/i, 'light'],
    [/\bdefault\s*(?:tier|level|model|级别)\b/i, 'default'],
    [/\bheavy\s*(?:tier|level|model|级别)\b/i, 'heavy'],
  ];
  for (const [pattern, choice] of decisionPatterns) {
    if (pattern.test(scrubbed)) return choice;
  }

  return null;
}

function extractJsonOnlyText(text: string): string {
  // Drop reasoning/thinking blocks first.
  const noThink = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim();
  // Drop code fence markers but keep fenced payload.
  const noFence = noThink.replace(/```(?:json)?/gi, ' ').trim();
  const firstBrace = noFence.indexOf('{');
  const lastBrace = noFence.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return noFence.slice(firstBrace, lastBrace + 1);
  }
  return noFence;
}

async function selectModelByApi(input: ModelSelectionInput): Promise<ModelSelection> {
  const endpoint = `${SELECTOR_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SELECTOR_TIMEOUT_MS);
  const systemPrompt = [
    'You are a model router. Choose exactly one tier: light, default, or heavy.',
    'Map user intent to tier with these rules:',
    '1) light: simple greetings/salutations; basic objective fact queries (for example weather, identity, simple lookups).',
    '2) default: simple knowledge/dev tasks using existing knowledge; no complex reasoning required.',
    '3) heavy: requirement/solution discussion; tasks likely requiring broad codebase search for implementation; complex logical reasoning.',
    'Prefer the lowest tier that can reliably complete the task.',
    'Output must be exactly one line of JSON with no prefix/suffix and no markdown/code fences.',
    'Do not output analysis, chain-of-thought, <think> tags, explanations, or any extra text.',
    'If uncertain, choose "default".',
    'Required schema: {"choice":"light|default|heavy","reason":"..."}',
  ].join(' ');
  const userPrompt = [
    `candidate_models: light=${MODEL_LIGHT}, default=${MODEL_DEFAULT}, heavy=${MODEL_HEAVY}`,
    `prompt:`,
    input.prompt || '',
  ].join('\n');

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: SELECTOR_API_MODEL,
        temperature: 0,
        max_tokens: SELECTOR_MAX_TOKENS,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`selector api status ${res.status}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || '';
    const sanitized = extractJsonOnlyText(content);
    const choice = parseChoiceFromText(sanitized) || parseChoiceFromText(content);
    if (!choice) {
      throw new Error('selector api returned invalid choice');
    }

    return {
      selectedModel: mapChoiceToModel(choice),
      reason: `api_${choice}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function selectModel(input: ModelSelectionInput): Promise<ModelSelection> {
  if (MODEL_FORCE) {
    return { selectedModel: MODEL_FORCE, reason: 'forced' };
  }

  if (CREDENTIAL_PROXY_OPENAI_COMPAT) {
    return { selectedModel: MODEL_LIGHT, reason: 'openai_compat' };
  }

  try {
    return await selectModelByApi(input);
  } catch {
    const fallback = selectModelByRules(input);
    return { ...fallback, reason: `fallback_${fallback.reason}` };
  }
}

export { selectModelByRules };
