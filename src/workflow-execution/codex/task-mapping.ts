import type {
  CodexTaskHandle,
  CodexTurnCompletion,
} from './app-server-client.js';

export type CodexNormalizedState =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked';
export type CodexNormalizedOutcome =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'blocked';

export interface CodexNormalizedCompletion {
  readonly state: CodexNormalizedState;
  readonly outcome: CodexNormalizedOutcome;
  readonly summary: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
  readonly metadata: Record<string, unknown>;
}

export function codexProviderMetadata(
  handle: Pick<CodexTaskHandle, 'threadId' | 'turnId' | 'cliVersion'>,
): Record<string, unknown> {
  return {
    transport: 'app_server_stdio',
    thread_id: handle.threadId,
    turn_id: handle.turnId,
    cli_version: handle.cliVersion,
    ephemeral: false,
  };
}

export function normalizeCodexCompletion(
  completion: CodexTurnCompletion,
  providerMetadata: Record<string, unknown>,
): CodexNormalizedCompletion {
  const outcome =
    completion.status === 'completed'
      ? 'success'
      : completion.status === 'interrupted'
        ? 'cancelled'
        : completion.status === 'blocked'
          ? 'blocked'
          : 'failure';
  const state =
    completion.status === 'completed'
      ? 'succeeded'
      : completion.status === 'interrupted'
        ? 'cancelled'
        : completion.status === 'blocked'
          ? 'blocked'
          : 'failed';
  const summary =
    completion.text || completion.errorMessage || `Codex turn ${state}`;
  return {
    state,
    outcome,
    summary,
    metadata: {
      ...providerMetadata,
      ...(completion.approvalMethod
        ? { approval_method: completion.approvalMethod }
        : {}),
    },
    error:
      outcome === 'success'
        ? null
        : {
            code:
              completion.errorCode ||
              (outcome === 'cancelled'
                ? 'codex_turn_interrupted'
                : 'codex_turn_failed'),
            message:
              completion.errorMessage || `Codex turn ended as ${outcome}`,
            retryable: outcome === 'failure',
          },
  };
}
