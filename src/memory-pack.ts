import { MemoryRecord } from './types.js';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
    .filter((w) => w.length >= 2);
}

export function buildMemoryPack(
  memories: MemoryRecord[],
  prompt: string,
): string {
  const all = memories.filter((m) => m.status === 'active');
  if (all.length === 0) return '';

  const terms = new Set(tokenize(prompt));
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

  const scored = all
    .map((m) => {
      const contentTerms = new Set(tokenize(m.content));
      const matchedTerms = Array.from(terms).filter((t) => contentTerms.has(t));
      const matchCount = matchedTerms.length;
      const overlapRatio = terms.size > 0 ? matchCount / terms.size : 0;
      const score =
        matchCount * 2.5 +
        overlapRatio * 2 +
        layerBaseWeight[m.layer] +
        typeBaseWeight[m.memory_type] +
        recencyBoost(m.layer, m.updated_at);

      const keepAsFallback =
        m.layer === 'canonical' &&
        (m.memory_type === 'rule' || m.memory_type === 'preference');

      return {
        ...m,
        _score: score,
        _matchCount: matchCount,
        _keepAsFallback: keepAsFallback,
      };
    })
    .filter((m) => m._matchCount > 0 || m._keepAsFallback || terms.size === 0)
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
