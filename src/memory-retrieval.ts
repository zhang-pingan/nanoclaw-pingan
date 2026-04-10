import { getMemoryById, listMemories, searchMemoriesActive } from './db.js';
import { MemoryRecord, MemorySearchResult } from './types.js';

export const MEMORY_SYNONYM_GROUPS = [
  ['reply', 'respond', 'response', '回答', '回复'],
  ['delete', 'remove', 'cleanup', '删除', '移除', '清理'],
  ['release', 'deploy', 'shipment', '发布', '上线', '部署'],
  ['plan', 'roadmap', '规划', '计划'],
  ['summary', 'summarize', 'overview', '总结', '概述'],
  ['bug', 'issue', 'problem', '故障', '问题', '缺陷'],
] as const;

export interface ExpandedMemoryQuery {
  directTerms: string[];
  weightedTerms: Map<string, number>;
  rawQuery: string;
  expandedMatchQuery: string;
}

export interface StructuredMemoryHit extends MemorySearchResult {
  sourceScore: number;
  matchedTerms: string[];
  directMatchCount: number;
  matchSource: 'fts' | 'cjk_fallback';
}

export function tokenizeMemoryQuery(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-zA-Z0-9\u4e00-\u9fa5]+/)
    .filter((w) => w.length >= 2);
}

function extractCjkSegments(text: string): string[] {
  return text.toLowerCase().match(/[\u4e00-\u9fa5]{2,}/g) || [];
}

function extractCjkNgrams(text: string): string[] {
  const out = new Set<string>();
  for (const segment of extractCjkSegments(text)) {
    for (let size = 2; size <= 3; size += 1) {
      if (segment.length < size) continue;
      for (let i = 0; i <= segment.length - size; i += 1) {
        out.add(segment.slice(i, i + size));
      }
    }
  }
  return Array.from(out);
}

function toFtsMatchQuery(terms: Iterable<string>): string {
  const uniqueTerms = Array.from(new Set(terms)).filter(Boolean);
  return uniqueTerms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

export function expandMemoryQuery(prompt: string): ExpandedMemoryQuery {
  const directTerms = tokenizeMemoryQuery(prompt);
  const weightedTerms = new Map<string, number>();

  for (const term of directTerms) {
    weightedTerms.set(term, Math.max(weightedTerms.get(term) || 0, 1));
  }

  for (const group of MEMORY_SYNONYM_GROUPS) {
    const hasDirectHit = group.some((term) => weightedTerms.has(term));
    if (!hasDirectHit) continue;
    for (const synonym of group) {
      weightedTerms.set(
        synonym,
        Math.max(
          weightedTerms.get(synonym) || 0,
          weightedTerms.has(synonym) ? 1 : 0.35,
        ),
      );
    }
  }

  return {
    directTerms,
    weightedTerms,
    rawQuery: prompt.trim(),
    expandedMatchQuery: toFtsMatchQuery(weightedTerms.keys()),
  };
}

function normalizeBm25Score(score: number): number {
  return 1 / (1 + Math.max(0, score));
}

export function retrieveStructuredMemories(
  groupFolder: string,
  prompt: string,
  opts?: { limit?: number },
): StructuredMemoryHit[] {
  const limit = Math.max(1, opts?.limit || 10);
  const expanded = expandMemoryQuery(prompt);
  const queryVariants = Array.from(
    new Set(
      [expanded.rawQuery, expanded.expandedMatchQuery].filter(
        (query) => query.length > 0,
      ),
    ),
  );

  const merged = new Map<string, MemorySearchResult>();
  for (const query of queryVariants) {
    for (const result of searchMemoriesActive(
      groupFolder,
      query,
      Math.max(limit * 2, limit),
    )) {
      const prev = merged.get(result.id);
      if (!prev || result.score < prev.score) {
        merged.set(result.id, result);
      }
    }
  }

  const weightedTerms = expanded.weightedTerms;
  const directTerms = new Set(expanded.directTerms);
  const cjkPromptNgrams = extractCjkNgrams(prompt);

  const hits: StructuredMemoryHit[] = [];
  for (const result of merged.values()) {
    const record = getMemoryById(result.id);
    if (!record || record.status !== 'active') continue;

    const contentTerms = new Set(tokenizeMemoryQuery(result.content));
    const matchedTerms = Array.from(weightedTerms.keys()).filter((term) =>
      contentTerms.has(term),
    );
    const directMatchCount = Array.from(directTerms).filter((term) =>
      contentTerms.has(term),
    ).length;

    hits.push({
      ...result,
      sourceScore: normalizeBm25Score(result.score),
      matchedTerms,
      directMatchCount,
      matchSource: 'fts',
    });
  }

  if (cjkPromptNgrams.length > 0) {
    const fallbackCandidates = listMemories(groupFolder, 300).filter(
      (m) => m.status === 'active' && !merged.has(m.id),
    );
    for (const memory of fallbackCandidates) {
      const contentLower = memory.content.toLowerCase();
      const matchedNgrams = cjkPromptNgrams.filter((gram) =>
        contentLower.includes(gram),
      );
      if (matchedNgrams.length === 0) continue;

      const overlapRatio = matchedNgrams.length / cjkPromptNgrams.length;
      const substringBoost = extractCjkSegments(prompt).some(
        (segment) => segment.length >= 4 && contentLower.includes(segment),
      )
        ? 0.25
        : 0;
      const sourceScore = Math.min(
        0.72,
        0.22 + overlapRatio * 0.5 + substringBoost,
      );
      if (sourceScore < 0.3) continue;

      hits.push({
        id: memory.id,
        layer: memory.layer,
        memory_type: memory.memory_type,
        content: memory.content,
        updated_at: memory.updated_at,
        score: 1 / Math.max(sourceScore, 0.001) - 1,
        sourceScore,
        matchedTerms: matchedNgrams,
        directMatchCount: matchedNgrams.length,
        matchSource: 'cjk_fallback',
      });
    }
  }

  return hits
    .sort(
      (a, b) =>
        b.sourceScore - a.sourceScore ||
        b.directMatchCount - a.directMatchCount ||
        Date.parse(b.updated_at) - Date.parse(a.updated_at),
    )
    .slice(0, limit);
}

export function listCanonicalFallbackMemories(
  groupFolder: string,
  limit: number = 12,
): MemoryRecord[] {
  return listMemories(groupFolder, 200)
    .filter((m) => m.status === 'active' && m.layer === 'canonical')
    .filter(
      (m) => m.memory_type === 'rule' || m.memory_type === 'preference',
    )
    .slice(0, limit);
}
