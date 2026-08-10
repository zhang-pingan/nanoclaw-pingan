import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hostActionToolResponse,
  waitForHostActionReceipt,
} from './host-action-receipts.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function makeResultsDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-receipts-'));
  roots.push(root);
  return root;
}

function writeReceipt(
  directory: string,
  filenameRequestId: string,
  payload: object,
): string {
  const resultPath = path.join(directory, `${filenameRequestId}.json`);
  fs.writeFileSync(resultPath, JSON.stringify(payload));
  return resultPath;
}

describe('protected Host action receipts', () => {
  it('validates requestId and action without deleting the Host-owned receipt', async () => {
    const directory = makeResultsDirectory();
    const requestId = 'sendfile-valid';
    const resultPath = writeReceipt(directory, requestId, {
      status: 'success',
      requestId,
      action: 'send_file',
    });

    const receipt = await waitForHostActionReceipt({
      required: true,
      resultsDirectory: directory,
      requestId,
      action: 'send_file',
      maxWaitMs: 20,
      pollMs: 1,
    });

    expect(receipt).toMatchObject({ status: 'success', requestId });
    expect(fs.existsSync(resultPath)).toBe(true);
  });

  it.each([
    [
      'wrong requestId',
      { status: 'success', requestId: 'forged-other', action: 'send_file' },
      'wrong requestId',
    ],
    [
      'wrong action',
      {
        status: 'success',
        requestId: 'sendfile-forged',
        action: 'send_message',
      },
      'mismatched receipt',
    ],
  ])(
    'rejects a pre-created receipt with %s',
    async (_label, payload, error) => {
      const directory = makeResultsDirectory();
      const requestId = 'sendfile-forged';
      writeReceipt(directory, requestId, payload);

      const receipt = await waitForHostActionReceipt({
        required: true,
        resultsDirectory: directory,
        requestId,
        action: 'send_file',
        maxWaitMs: 20,
        pollMs: 1,
      });

      expect(receipt).toMatchObject({
        status: 'error',
        requestId,
        action: 'send_file',
        error: expect.stringContaining(error),
      });
    },
  );

  it('returns a tool-visible timeout when the Host never publishes a receipt', async () => {
    const directory = makeResultsDirectory();
    const requestId = 'reload-timeout';
    const receipt = await waitForHostActionReceipt({
      required: true,
      resultsDirectory: directory,
      requestId,
      action: 'reload_tools',
      maxWaitMs: 5,
      pollMs: 1,
    });

    expect(receipt).toBeNull();
    expect(
      hostActionToolResponse(
        receipt,
        requestId,
        'reload_tools',
        {
          queuedText: 'request queued',
          completedText: 'unreachable success',
        },
        true,
      ),
    ).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('timed out') }],
    });
  });

  it.each(['ordinary Agent', 'writable Workflow Pack'])(
    'returns requested wording without waiting for an unprotected %s action',
    async (_executionKind) => {
      const receipt = await waitForHostActionReceipt({
        required: false,
        resultsDirectory: path.join(makeResultsDirectory(), 'does-not-exist'),
        requestId: 'pause-unprotected',
        action: 'pause_task',
        maxWaitMs: 60_000,
      });
      expect(receipt).toBeNull();
      expect(
        hostActionToolResponse(
          receipt,
          'pause-unprotected',
          'pause_task',
          {
            queuedText: 'Task task-1 pause requested.',
            completedText: 'Task task-1 paused.',
          },
          false,
        ),
      ).toEqual({
        content: [{ type: 'text', text: 'Task task-1 pause requested.' }],
      });
    },
  );

  it('returns completed wording only after a read_only Pack Host success receipt', async () => {
    const directory = makeResultsDirectory();
    writeReceipt(directory, 'pause-protected', {
      status: 'success',
      requestId: 'pause-protected',
      action: 'pause_task',
    });
    const receipt = await waitForHostActionReceipt({
      required: true,
      resultsDirectory: directory,
      requestId: 'pause-protected',
      action: 'pause_task',
      maxWaitMs: 20,
      pollMs: 1,
    });
    expect(
      hostActionToolResponse(
        receipt,
        'pause-protected',
        'pause_task',
        {
          queuedText: 'Task task-1 pause requested.',
          completedText: 'Task task-1 paused.',
        },
        true,
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'Task task-1 paused.' }],
    });
  });

  it('returns a Host rejection as a read_only Pack tool error', async () => {
    const directory = makeResultsDirectory();
    writeReceipt(directory, 'pause-rejected', {
      status: 'error',
      requestId: 'pause-rejected',
      action: 'pause_task',
      error: 'Task does not exist.',
    });
    const receipt = await waitForHostActionReceipt({
      required: true,
      resultsDirectory: directory,
      requestId: 'pause-rejected',
      action: 'pause_task',
      maxWaitMs: 20,
      pollMs: 1,
    });
    expect(
      hostActionToolResponse(
        receipt,
        'pause-rejected',
        'pause_task',
        {
          queuedText: 'Task task-missing pause requested.',
          completedText: 'Task task-missing paused.',
        },
        true,
      ),
    ).toEqual({
      content: [{ type: 'text', text: 'Task does not exist.' }],
      isError: true,
    });
  });
});
