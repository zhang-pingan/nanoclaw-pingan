import { MemoryRecord } from './types.js';

const SYNONYM_GROUPS = [
  ['reply', 'respond', 'response', '回答', '回复'],
  ['delete', 'remove', 'cleanup', '删除', '移除', '清理'],
  ['release', 'deploy', 'shipment', '发布', '上线', '部署'],
  ['plan', 'roadmap', '规划', '计划'],
  ['summary', 'summarize', 'overview', '总结', '概述'],
  ['bug', 'issue', 'problem', '故障', '问题', '缺陷'],
] as const;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
    .filter((w) => w.length >= 2);
}

function buildExpandedQueryTerms(prompt: string): Map<string, number> {
  const directTerms = tokenize(prompt);
  const weightedTerms = new Map<string, number>();

  for (const term of directTerms) {
    weightedTerms.set(term, Math.max(weightedTerms.get(term) || 0, 1));
  }

  for (const group of SYNONYM_GROUPS) {
    const hasDirectHit = group.some((term) => weightedTerms.has(term));
    if (!hasDirectHit) continue;
    for (const synonym of group) {
      weightedTerms.set(
        synonym,
        Math.max(weightedTerms.get(synonym) || 0, weightedTerms.has(synonym) ? 1 : 0.35),
      );
    }
  }

  return weightedTerms;
}

export function buildMemoryPack(
  memories: MemoryRecord[],
  prompt: string,
): string {
  const all = memories.filter((m) => m.status === 'active');
  if (all.length === 0) return '';

  const queryTerms = buildExpandedQueryTerms(prompt);
  const now = Date.now();

  const layerBaseWeight: Record<MemoryRecord['layer'], number> = {
    canonical: 0.8,
    episodic: 0.35,
    working: 0.25,
  };
  const typeBaseWeight: Record<MemoryRecord['memory_type'], number> = {
    rule: 0.9,
    preference: 0.75,
    fact: 0.45,
    summary: 0.3,
  };
  const perLayerLimit: Record<MemoryRecord['layer'], number> = {
    canonical: 8,
    episodic: 4,
    working: 6,
  };

  const recencyBoost = (
    layer: MemoryRecord['layer'],
    updatedAt: string,
  ): number => {
    const age = Math.max(0, now - Number(updatedAt || 0));
    const day = 24 * 60 * 60 * 1000;

    if (layer === 'working') {
      if (age <= day) return 0.9;
      if (age <= 7 * day) return 0.3;
      return 0;
    }
    if (layer === 'episodic') {
      if (age <= 3 * day) return 0.5;
      if (age <= 14 * day) return 0.2;
      return 0;
    }
    if (age <= 30 * day) return 0.15;
    if (age <= 180 * day) return 0.05;
    return 0;
  };

  const documents = all.map((m) => {
    const terms = tokenize(m.content);
    const termCounts = new Map<string, number>();
    for (const term of terms) {
      termCounts.set(term, (termCounts.get(term) || 0) + 1);
    }
    return {
      memory: m,
      terms,
      termCounts,
      length: terms.length,
    };
  });

  const averageDocLength =
    documents.reduce((sum, doc) => sum + doc.length, 0) / Math.max(documents.length, 1);
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const term of new Set(doc.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }

  const bm25Score = (termCounts: Map<string, number>, docLength: number): number => {
    if (queryTerms.size === 0) return 0;
    const k1 = 1.2;
    const b = 0.75;
    let score = 0;
    for (const [term, queryWeight] of queryTerms.entries()) {
      const tf = termCounts.get(term) || 0;
      if (tf === 0) continue;
      const df = documentFrequency.get(term) || 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const denom =
        tf + k1 * (1 - b + b * (docLength / Math.max(averageDocLength, 1)));
      score += queryWeight * idf * ((tf * (k1 + 1)) / denom);
    }
    return score;
  };

  const scored = documents
    .map((doc) => {
      const contentTerms = new Set(doc.terms);
      const matchedTerms = Array.from(queryTerms.keys()).filter((t) =>
        contentTerms.has(t),
      );
      const directPromptTerms = new Set(tokenize(prompt));
      const directMatchCount = Array.from(directPromptTerms).filter((t) =>
        contentTerms.has(t),
      ).length;
      const overlapRatio =
        queryTerms.size > 0 ? matchedTerms.length / queryTerms.size : 0;
      const m = doc.memory;
      const score =
        bm25Score(doc.termCounts, doc.length) * 3 +
        directMatchCount * 1.6 +
        overlapRatio * 1.4 +
        layerBaseWeight[m.layer] +
        typeBaseWeight[m.memory_type] +
        recencyBoost(m.layer, m.updated_at);

      const keepAsFallback =
        m.layer === 'canonical' &&
        (m.memory_type === 'rule' || m.memory_type === 'preference');

      return {
        ...m,
        _score: score,
        _matchCount: matchedTerms.length,
        _directMatchCount: directMatchCount,
        _keepAsFallback: keepAsFallback,
      };
    })
    .filter(
      (m) => m._matchCount > 0 || m._keepAsFallback || queryTerms.size === 0,
    )
    .sort(
      (a, b) =>
        b._score - a._score || Number(b.updated_at) - Number(a.updated_at),
    );

  const quotas = {
    canonical: 1900,
    episodic: 1200,
    working: 800,
  } as const;

  const picked: Array<{
    layer: 'working' | 'episodic' | 'canonical';
    memory_type: string;
    content: string;
    status: string;
  }> = [];
  const used: Record<'canonical' | 'episodic' | 'working', number> = {
    canonical: 0,
    episodic: 0,
    working: 0,
  };
  const pickedPerLayer: Record<'canonical' | 'episodic' | 'working', number> = {
    canonical: 0,
    episodic: 0,
    working: 0,
  };

  for (const m of scored) {
    const line = `[${m.layer}/${m.memory_type}/${m.status}] ${m.content}`;
    const len = line.length + 1;
    const layer = m.layer;
    if (pickedPerLayer[layer] >= perLayerLimit[layer]) continue;
    if (used[layer] + len > quotas[layer]) continue;
    used[layer] += len;
    pickedPerLayer[layer] += 1;
    picked.push(m);
  }

  if (picked.length === 0) return '';
  const lines = picked.map(
    (m) => `- [${m.layer}/${m.memory_type}/${m.status}] ${m.content}`,
  );
  return [
    '[MEMORY PACK]',
    'Use these memories as prior context. Newer user instruction overrides stale/conflicted memories.',
    ...lines,
    '[/MEMORY PACK]',
    '',
  ].join('\n');
}
