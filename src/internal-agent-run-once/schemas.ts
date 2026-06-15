import { z } from 'zod';

export class UnsupportedMessagesShapeError extends Error {
  status = 400;

  constructor(message = 'unsupported messages shape') {
    super(message);
    this.name = 'UnsupportedMessagesShapeError';
  }
}

export const runOnceMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

export const runOnceRequestSchema = z.object({
  system: z.string().min(1),
  messages: z.array(runOnceMessageSchema).min(1),
  chat_jid: z.string().min(1),
  require_result: z.literal(true).optional().default(true),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type RunOnceRequest = z.infer<typeof runOnceRequestSchema>;

export interface RunOnceSuccessResponse {
  ok: true;
  text: string;
  run_id: string;
  query_id: string;
  model: string;
}

export interface RunOnceFailureResponse {
  ok: false;
  error: string;
  failure?: {
    failureType: string;
    failureSubtype?: string;
    failureOrigin: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  run_id: string;
  query_id: string;
}

export type RunOnceResponse = RunOnceSuccessResponse | RunOnceFailureResponse;

export function parseRunOnceRequest(input: unknown): RunOnceRequest {
  const request = runOnceRequestSchema.parse(input);
  const [message] = request.messages;
  if (request.messages.length !== 1 || message.role !== 'user') {
    throw new UnsupportedMessagesShapeError();
  }
  return request;
}

export function runOnceInputLength(input: RunOnceRequest): number {
  return (
    input.system.length +
    input.messages.reduce((total, message) => total + message.content.length, 0)
  );
}
