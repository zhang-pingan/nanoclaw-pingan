import { MemoryRecord } from './types.js';

export function buildMemoryPack(
  memories: MemoryRecord[],
  prompt: string,
): string {
  const all = memories.filter((m) => m.status !== 'deprecated');
  if (all.length === 0) return '';

  const terms = new Set(
    prompt
      .toLowerCase()
      .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
      .filter((w) => w.length >= 2),
  );
  const now = Date.now();
  const score = (content: string, updatedAt: string): number => {
    const c = content.toLowerCase();
    let s = 0;
    for (const t of terms) {
      if (c.includes(t)) s += 2;
    }
    const age = Math.max(0, now - Number(updatedAt || 0));
    const day = 24 * 60 * 60 * 1000;
    if (age <= day) s += 1.2;
    else if (age <= 7 * day) s += 0.6;
    return s;
  };

  const withScore = all
    .map((m) => ({ ...m, _score: score(m.content, m.updated_at) }))
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

  for (const m of withScore) {
    const line = `[${m.layer}/${m.memory_type}/${m.status}] ${m.content}`;
    const len = line.length + 1;
    const layer = m.layer;
    if (used[layer] + len > quotas[layer]) continue;
    used[layer] += len;
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

