import fs from 'node:fs';
import path from 'node:path';

export const HOST_ACTION_RECEIPT_ACTIONS = [
  'send_message',
  'send_file',
  'schedule_task',
  'pause_task',
  'resume_task',
  'cancel_task',
  'update_task',
  'request_delegation',
  'complete_delegation',
  'reload_tools',
] as const;

export type HostActionReceiptAction =
  (typeof HOST_ACTION_RECEIPT_ACTIONS)[number];

export type HostActionReceipt = {
  status: 'success' | 'error';
  requestId: string;
  action: HostActionReceiptAction;
  error?: string;
};

function invalidReceipt(
  requestId: string,
  action: HostActionReceiptAction,
  error: string,
): HostActionReceipt {
  return { status: 'error', requestId, action, error };
}

function validateReceipt(
  value: unknown,
  requestId: string,
  action: HostActionReceiptAction,
): HostActionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidReceipt(
      requestId,
      action,
      'Host returned an invalid receipt.',
    );
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.requestId !== requestId) {
    return invalidReceipt(
      requestId,
      action,
      `Host returned a receipt with the wrong requestId for ${action}.`,
    );
  }
  if (receipt.action !== action) {
    return invalidReceipt(
      requestId,
      action,
      `Host returned a mismatched receipt for ${action}.`,
    );
  }
  if (receipt.status !== 'success' && receipt.status !== 'error') {
    return invalidReceipt(
      requestId,
      action,
      `Host returned an invalid receipt status for ${action}.`,
    );
  }
  if (receipt.error !== undefined && typeof receipt.error !== 'string') {
    return invalidReceipt(
      requestId,
      action,
      `Host returned an invalid receipt error for ${action}.`,
    );
  }
  return receipt as HostActionReceipt;
}

export async function waitForHostActionReceipt(input: {
  readonly required: boolean;
  readonly resultsDirectory: string;
  readonly requestId: string;
  readonly action: HostActionReceiptAction;
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
}): Promise<HostActionReceipt | null> {
  if (!input.required) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(input.requestId)) {
    return invalidReceipt(
      input.requestId,
      input.action,
      'Host action requestId is invalid.',
    );
  }
  const resultPath = path.join(
    input.resultsDirectory,
    `${input.requestId}.json`,
  );
  const startedAt = Date.now();
  const maxWaitMs = input.maxWaitMs ?? 60_000;
  const pollMs = input.pollMs ?? 100;
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const raw = fs.readFileSync(resultPath, 'utf8');
      return validateReceipt(
        JSON.parse(raw) as unknown,
        input.requestId,
        input.action,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return invalidReceipt(
          input.requestId,
          input.action,
          `Host receipt could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

export function hostActionToolResponse(
  receipt: HostActionReceipt | null,
  requestId: string,
  action: HostActionReceiptAction,
  messages: {
    readonly queuedText: string;
    readonly completedText: string;
  },
  required: boolean,
) {
  if (!required) {
    return {
      content: [{ type: 'text' as const, text: messages.queuedText }],
    };
  }
  if (!receipt) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${action} timed out waiting for Host acknowledgement (requestId=${requestId}).`,
        },
      ],
      isError: true,
    };
  }
  if (receipt.status === 'error') {
    return {
      content: [
        {
          type: 'text' as const,
          text: receipt.error || `${action} was rejected by the Host.`,
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text' as const, text: messages.completedText }],
  };
}
