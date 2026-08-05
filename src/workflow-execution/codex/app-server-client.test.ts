import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  CodexAppServerClient,
  type CodexAppServerProcess,
} from './app-server-client.js';

class FakeCodexProcess extends EventEmitter implements CodexAppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Record<string, unknown>[] = [];
  private input = '';

  constructor(
    private readonly respond: (
      message: Record<string, unknown>,
      process: FakeCodexProcess,
    ) => void,
  ) {
    super();
    this.stdin.on('data', (chunk) => {
      this.input += String(chunk);
      for (;;) {
        const newline = this.input.indexOf('\n');
        if (newline < 0) break;
        const line = this.input.slice(0, newline);
        this.input = this.input.slice(newline + 1);
        const message = JSON.parse(line) as Record<string, unknown>;
        this.received.push(message);
        this.respond(message, this);
      }
    });
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  kill(): boolean {
    return true;
  }
}

function standardResponder(
  message: Record<string, unknown>,
  process: FakeCodexProcess,
): void {
  const id = message.id;
  if (typeof id !== 'number') return;
  switch (message.method) {
    case 'initialize':
      process.send({ id, result: { userAgent: 'codex-test' } });
      break;
    case 'thread/start':
      process.send({
        id,
        result: {
          thread: { id: 'thread-1', cliVersion: '0.144.5', turns: [] },
        },
      });
      break;
    case 'thread/name/set':
      process.send({ id, result: {} });
      break;
    case 'turn/start':
      process.send({
        id,
        result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } },
      });
      break;
    case 'turn/interrupt':
      process.send({ id, result: {} });
      break;
  }
}

function createClient(process: FakeCodexProcess): CodexAppServerClient {
  return new CodexAppServerClient({
    binary: 'codex',
    cwd: '/tmp',
    requestTimeoutMs: 1000,
    processFactory: () => process,
  });
}

describe('CodexAppServerClient', () => {
  it('runs initialize, thread naming, and a turn to completion', async () => {
    const process = new FakeCodexProcess(standardResponder);
    const client = createClient(process);
    const handle = await client.startTask({
      title: 'Workflow task',
      prompt: 'Do the work',
      cwd: '/tmp',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    process.send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [{ type: 'agentMessage', id: 'item-1', text: 'finished' }],
          error: null,
        },
      },
    });

    await expect(handle.completion).resolves.toMatchObject({
      status: 'completed',
      text: 'finished',
    });
    expect(handle.cliVersion).toBe('0.144.5');
    expect(process.received.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'thread/name/set',
      'turn/start',
    ]);
    client.close();
  });

  it('declines approval and reports the turn as blocked', async () => {
    const process = new FakeCodexProcess(standardResponder);
    const client = createClient(process);
    const handle = await client.startTask({
      title: 'Workflow task',
      prompt: 'Run a command',
      cwd: '/tmp',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    process.send({
      id: 500,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });

    await expect(handle.completion).resolves.toMatchObject({
      status: 'blocked',
      errorCode: 'codex_approval_required',
      approvalMethod: 'item/commandExecution/requestApproval',
    });
    expect(process.received).toContainEqual({
      id: 500,
      result: { decision: 'decline' },
    });
    client.close();
  });

  it('rejects an active turn when App Server emits malformed JSONL', async () => {
    const process = new FakeCodexProcess(standardResponder);
    const client = createClient(process);
    const handle = await client.startTask({
      title: 'Workflow task',
      prompt: 'Do the work',
      cwd: '/tmp',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    process.sendRaw('{invalid');

    await expect(handle.completion).rejects.toThrow(/Malformed Codex/);
    client.close();
  });

  it('recovers an already completed turn through thread/read', async () => {
    const process = new FakeCodexProcess((message, fake) => {
      if (message.method === 'initialize') {
        fake.send({ id: message.id, result: { userAgent: 'codex-test' } });
      } else if (message.method === 'thread/read') {
        fake.send({
          id: message.id,
          result: {
            thread: {
              id: 'thread-r',
              cliVersion: '0.144.5',
              turns: [
                {
                  id: 'turn-r',
                  status: 'completed',
                  items: [{ type: 'agentMessage', text: 'recovered' }],
                  error: null,
                },
              ],
            },
          },
        });
      }
    });
    const client = createClient(process);
    const handle = await client.recoverTask('thread-r', 'turn-r');

    await expect(handle.completion).resolves.toMatchObject({
      status: 'completed',
      text: 'recovered',
    });
    client.close();
  });
});
