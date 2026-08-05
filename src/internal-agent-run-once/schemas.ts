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

const RUN_ONCE_FILE_PATH_PREFIXES = [
  '/workspace/run-once/',
  '/workspace/uploads/',
  '/workspace/attachments/',
  '/workspace/agent/',
  '/workspace/desktop-captures/',
  '/workspace/ai-images/',
];

export const runOnceFileSchema = z.object({
  name: z.string().min(1),
  agent_path: z
    .string()
    .min(1)
    .refine(
      (value) =>
        RUN_ONCE_FILE_PATH_PREFIXES.some((prefix) => value.startsWith(prefix)),
      'agent_path must use a mounted /workspace path',
    ),
  relative_path: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
  sha256: z.string().min(1).optional(),
  content_type: z.string().min(1).optional(),
});

export const runOnceOutputFileSchema = runOnceFileSchema.extend({
  relative_path: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  download_url: z.string().min(1),
});

export const runOnceRequestSchema = z.object({
  system: z.string().min(1),
  messages: z.array(runOnceMessageSchema).min(1),
  chat_jid: z.string().min(1),
  require_result: z.literal(true).optional().default(true),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
  files: z.array(runOnceFileSchema).optional().default([]),
});

export type RunOnceRequest = z.output<typeof runOnceRequestSchema>;
export type RunOnceRequestInput = z.input<typeof runOnceRequestSchema>;
export type RunOnceFile = z.infer<typeof runOnceFileSchema>;
export type RunOnceOutputFile = z.infer<typeof runOnceOutputFileSchema>;

export interface RunOnceSuccessResponse {
  ok: true;
  text: string;
  run_id: string;
  query_id: string;
  model: string;
  trace_path?: string;
  output_files?: RunOnceOutputFile[];
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
  trace_path?: string;
  output_files?: RunOnceOutputFile[];
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
  const fileChars = input.files.reduce(
    (total, file) =>
      total +
      file.name.length +
      file.agent_path.length +
      (file.relative_path?.length || 0) +
      (file.content_type?.length || 0),
    0,
  );
  return (
    input.system.length +
    input.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    ) +
    fileChars
  );
}
