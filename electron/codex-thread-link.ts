const CODEX_THREAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function codexThreadDeepLink(threadId: unknown): string | null {
  if (typeof threadId !== 'string' || !CODEX_THREAD_ID.test(threadId))
    return null;
  return `codex://threads/${threadId}`;
}
