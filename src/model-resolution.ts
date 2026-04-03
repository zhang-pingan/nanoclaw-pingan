export interface ModelResolutionEntry {
  runId: string;
  queryId: string;
  requestedModel?: string;
  actualModel: string;
  source: 'proxy_forward' | 'compat_response' | 'fallback';
  updatedAt: number;
}

const MODEL_RESOLUTION_TTL_MS = 60 * 60 * 1000;
const resolutions = new Map<string, ModelResolutionEntry>();

function toKey(runId: string, queryId: string): string {
  return `${runId}:${queryId}`;
}

function cleanupExpired(): void {
  const cutoff = Date.now() - MODEL_RESOLUTION_TTL_MS;
  for (const [key, value] of resolutions) {
    if (value.updatedAt < cutoff) {
      resolutions.delete(key);
    }
  }
}

export function recordModelResolution(entry: ModelResolutionEntry): void {
  cleanupExpired();
  resolutions.set(toKey(entry.runId, entry.queryId), entry);
}

export function consumeModelResolution(
  runId: string,
  queryId: string,
): ModelResolutionEntry | undefined {
  cleanupExpired();
  const key = toKey(runId, queryId);
  const entry = resolutions.get(key);
  if (entry) {
    resolutions.delete(key);
  }
  return entry;
}

export function clearModelResolutionsForRun(runId: string): void {
  for (const [key, value] of resolutions) {
    if (value.runId === runId) {
      resolutions.delete(key);
    }
  }
}
