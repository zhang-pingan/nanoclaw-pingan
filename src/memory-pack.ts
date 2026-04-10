import { listCanonicalFallbackMemories, retrieveStructuredMemories } from './memory-retrieval.js';
import { MemoryRecord } from './types.js';

interface MemoryPackCandidate extends MemoryRecord {
  retrievalScore?: number;
  directMatchCount?: number;
}

function rankMemoryForPack(
  memory: MemoryPackCandidate,
  now: number,
): number {
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

  const age = Math.max(0, now - Number(memory.updated_at || 0));
  const day = 24 * 60 * 60 * 1000;

  let recencyBoost = 0;
  if (memory.layer === 'working') {
    if (age <= day) recencyBoost = 0.9;
    else if (age <= 7 * day) recencyBoost = 0.3;
  } else if (memory.layer === 'episodic') {
    if (age <= 3 * day) recencyBoost = 0.5;
    else if (age <= 14 * day) recencyBoost = 0.2;
  } else if (age <= 30 * day) {
    recencyBoost = 0.15;
  } else if (age <= 180 * day) {
    recencyBoost = 0.05;
  }

  return (
    (memory.retrievalScore || 0) * 4 +
    (memory.directMatchCount || 0) * 1.2 +
    layerBaseWeight[memory.layer] +
    typeBaseWeight[memory.memory_type] +
    recencyBoost
  );
}

function buildMemoryPackFromCandidates(candidates: MemoryPackCandidate[]): string {
  if (candidates.length === 0) return '';

  const quotas = {
    canonical: 1900,
    episodic: 1200,
    working: 800,
  } as const;
  const perLayerLimit: Record<MemoryRecord['layer'], number> = {
    canonical: 8,
    episodic: 4,
    working: 6,
  };

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
  const picked: MemoryPackCandidate[] = [];

  for (const memory of candidates) {
    const line = `[${memory.layer}/${memory.memory_type}/${memory.status}] ${memory.content}`;
    const len = line.length + 1;
    const layer = memory.layer;
    if (pickedPerLayer[layer] >= perLayerLimit[layer]) continue;
    if (used[layer] + len > quotas[layer]) continue;
    used[layer] += len;
    pickedPerLayer[layer] += 1;
    picked.push(memory);
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

export function buildMemoryPack(
  memories: MemoryRecord[],
  _prompt: string,
): string {
  const now = Date.now();
  const candidates = memories
    .filter((m) => m.status === 'active')
    .map((m) => ({ ...m }))
    .sort(
      (a, b) => rankMemoryForPack(b, now) - rankMemoryForPack(a, now),
    );
  return buildMemoryPackFromCandidates(candidates);
}

export function buildMemoryPackForGroup(
  groupFolder: string,
  prompt: string,
): string {
  const now = Date.now();
  const retrieved = retrieveStructuredMemories(groupFolder, prompt, {
    limit: 24,
  }).map((hit) => ({
    id: hit.id,
    group_folder: groupFolder,
    layer: hit.layer,
    memory_type: hit.memory_type,
    status: 'active' as const,
    content: hit.content,
    source: 'retrieved',
    created_at: hit.updated_at,
    updated_at: hit.updated_at,
    retrievalScore: hit.sourceScore,
    directMatchCount: hit.directMatchCount,
  }));

  const seen = new Set(retrieved.map((m) => m.id));
  const fallback = listCanonicalFallbackMemories(groupFolder)
    .filter((m) => !seen.has(m.id))
    .map((m) => ({ ...m, retrievalScore: 0, directMatchCount: 0 }));

  const candidates = [...retrieved, ...fallback].sort(
    (a, b) => rankMemoryForPack(b, now) - rankMemoryForPack(a, now),
  );

  return buildMemoryPackFromCandidates(candidates);
}
