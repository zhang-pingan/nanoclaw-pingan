import { z } from 'zod';

export const agentChatRequestSchema = z
  .object({
    chat_jid: z.string().min(1),
    session_id: z.string().min(1).optional(),
    message: z.string().min(1),
    system: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional().default({}),
  })
  .strict();

export type AgentChatRequest = z.output<typeof agentChatRequestSchema>;
export type AgentChatRequestInput = z.input<typeof agentChatRequestSchema>;

export interface AgentChatSuccessResponse {
  ok: true;
  text: string;
  session_id: string;
  run_id: string;
  query_id: string;
  model: string;
}

export interface AgentChatFailureResponse {
  ok: false;
  error: string;
  session_id?: string;
  run_id: string;
  query_id: string;
  failure?: {
    failureType: string;
    failureSubtype?: string;
    failureOrigin: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export type AgentChatResponse =
  | AgentChatSuccessResponse
  | AgentChatFailureResponse;

export function parseAgentChatRequest(input: unknown): AgentChatRequest {
  return agentChatRequestSchema.parse(input);
}

export function agentChatInputLength(input: AgentChatRequest): number {
  return (
    input.chat_jid.length +
    (input.session_id?.length || 0) +
    input.message.length +
    (input.system?.length || 0)
  );
}
