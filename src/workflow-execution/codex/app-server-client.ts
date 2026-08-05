import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type CodexSandboxMode =
  | 'read-only'
  | 'workspace-write'
  | 'danger-full-access';
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface CodexAppServerProcess {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr?: NodeJS.ReadableStream;
  on(event: 'error', listener: (error: Error) => void): this;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CodexAppServerProcessFactory = (
  binary: string,
  args: readonly string[],
  cwd: string,
) => CodexAppServerProcess;

export interface CodexAppServerClientOptions {
  readonly binary: string;
  readonly cwd: string;
  readonly requestTimeoutMs?: number;
  readonly processFactory?: CodexAppServerProcessFactory;
}

export interface CodexTaskStartInput {
  readonly title: string;
  readonly prompt: string;
  readonly system?: string;
  readonly cwd: string;
  readonly model?: string;
  readonly sandbox: CodexSandboxMode;
  readonly approvalPolicy: CodexApprovalPolicy;
}

export interface CodexTurnCompletion {
  readonly status: 'completed' | 'failed' | 'interrupted' | 'blocked';
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly approvalMethod?: string;
}

export interface CodexTaskHandle {
  readonly threadId: string;
  readonly turnId: string;
  readonly cliVersion: string;
  readonly completion: Promise<CodexTurnCompletion>;
  interrupt(): Promise<void>;
}

interface JsonRpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly completion: Promise<CodexTurnCompletion>;
  readonly resolve: (completion: CodexTurnCompletion) => void;
  readonly reject: (error: Error) => void;
  settled: boolean;
  delta: string;
  finalMessage: string;
}

interface CodexTurn {
  readonly id: string;
  readonly status: string;
  readonly items?: unknown[];
  readonly error?: unknown;
}

interface CodexThread {
  readonly id: string;
  readonly cliVersion?: string;
  readonly turns?: CodexTurn[];
}

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);

function defaultProcessFactory(
  binary: string,
  args: readonly string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  return spawn(binary, [...args], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, field: string): string | null {
  const candidate = object(value)?.[field];
  return typeof candidate === 'string' ? candidate : null;
}

function errorMessage(value: unknown): string | null {
  if (typeof value === 'string') return value;
  const candidate = object(value);
  if (!candidate) return null;
  if (typeof candidate.message === 'string') return candidate.message;
  if (typeof candidate.additionalDetails === 'string')
    return candidate.additionalDetails;
  return null;
}

function finalAgentMessage(turn: CodexTurn): string {
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = object(items[index]);
    if (item?.type === 'agentMessage' && typeof item.text === 'string')
      return item.text;
  }
  return '';
}

function terminalCompletion(
  threadId: string,
  turn: CodexTurn,
): CodexTurnCompletion | null {
  if (turn.status === 'completed') {
    return {
      status: 'completed',
      threadId,
      turnId: turn.id,
      text: finalAgentMessage(turn),
      errorCode: null,
      errorMessage: null,
    };
  }
  if (turn.status === 'failed') {
    return {
      status: 'failed',
      threadId,
      turnId: turn.id,
      text: finalAgentMessage(turn),
      errorCode:
        stringField(turn.error, 'codexErrorInfo') || 'codex_turn_failed',
      errorMessage: errorMessage(turn.error) || 'Codex turn failed',
    };
  }
  if (turn.status === 'interrupted') {
    return {
      status: 'interrupted',
      threadId,
      turnId: turn.id,
      text: finalAgentMessage(turn),
      errorCode: 'codex_turn_interrupted',
      errorMessage: 'Codex turn was interrupted',
    };
  }
  return null;
}

function activeKey(threadId: string, turnId: string): string {
  return `${threadId}\n${turnId}`;
}

export class CodexAppServerClient {
  private readonly requestTimeoutMs: number;
  private readonly processFactory: CodexAppServerProcessFactory;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly turns = new Map<string, ActiveTurn>();
  private process: CodexAppServerProcess | null = null;
  private nextRequestId = 1;
  private initializePromise: Promise<void> | null = null;
  private closed = false;
  private stderrTail = '';

  constructor(private readonly options: CodexAppServerClientOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.processFactory = options.processFactory ?? defaultProcessFactory;
  }

  async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeInternal();
    return this.initializePromise;
  }

  async startTask(input: CodexTaskStartInput): Promise<CodexTaskHandle> {
    await this.initialize();
    const started = object(
      await this.request('thread/start', {
        cwd: input.cwd,
        ...(input.model ? { model: input.model } : {}),
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
        ephemeral: false,
        ...(input.system ? { baseInstructions: input.system } : {}),
      }),
    );
    const thread = object(started?.thread) as CodexThread | null;
    if (!thread || typeof thread.id !== 'string')
      throw new Error('Codex thread/start response has no thread id');

    await this.request('thread/name/set', {
      threadId: thread.id,
      name: input.title,
    });
    const turnResponse = object(
      await this.request('turn/start', {
        threadId: thread.id,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        cwd: input.cwd,
        approvalPolicy: input.approvalPolicy,
        ...(input.model ? { model: input.model } : {}),
      }),
    );
    const turn = object(turnResponse?.turn) as CodexTurn | null;
    if (!turn || typeof turn.id !== 'string')
      throw new Error('Codex turn/start response has no turn id');
    const active = this.createActiveTurn(thread.id, turn.id);
    const immediate = terminalCompletion(thread.id, turn);
    if (immediate) this.settle(active, immediate);
    return this.handleFor(active, thread.cliVersion || 'unknown');
  }

  async recoverTask(
    threadId: string,
    turnId: string,
  ): Promise<CodexTaskHandle> {
    await this.initialize();
    const readResponse = object(
      await this.request('thread/read', { threadId, includeTurns: true }),
    );
    const thread = object(readResponse?.thread) as CodexThread | null;
    if (!thread || thread.id !== threadId)
      throw new Error(`Codex thread cannot be recovered: ${threadId}`);
    const turn = thread.turns?.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error(`Codex turn cannot be recovered: ${turnId}`);
    const active = this.createActiveTurn(threadId, turnId);
    const terminal = terminalCompletion(threadId, turn);
    if (terminal) {
      this.settle(active, terminal);
      return this.handleFor(active, thread.cliVersion || 'unknown');
    }

    const resumed = object(await this.request('thread/resume', { threadId }));
    const resumedThread = object(resumed?.thread) as CodexThread | null;
    const resumedTurn = resumedThread?.turns?.find(
      (candidate) => candidate.id === turnId,
    );
    const resumedTerminal = resumedTurn
      ? terminalCompletion(threadId, resumedTurn)
      : null;
    if (resumedTerminal) this.settle(active, resumedTerminal);
    return this.handleFor(
      active,
      resumedThread?.cliVersion || thread.cliVersion || 'unknown',
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('Codex App Server client closed'));
    this.process?.kill('SIGTERM');
    this.process = null;
  }

  private async initializeInternal(): Promise<void> {
    if (this.closed) throw new Error('Codex App Server client is closed');
    const child = this.processFactory(
      this.options.binary,
      ['app-server', '--listen', 'stdio://'],
      this.options.cwd,
    );
    this.process = child;
    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => {
      if (this.closed) return;
      const detail = this.stderrTail.trim();
      this.failAll(
        new Error(
          `Codex App Server exited (${code ?? signal ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-4096);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLine(line));
    lines.on('error', (error) => this.failAll(error));

    await this.request('initialize', {
      clientInfo: {
        name: 'icarus-workflow-adapter',
        title: 'Icarus Workflow Adapter',
        version: '0.1.0-experimental',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify('initialized');
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (!this.process) {
      return Promise.reject(new Error('Codex App Server is not running'));
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.write({ id, method, params } satisfies JsonRpcRequest);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(message: unknown): void {
    if (!this.process || !this.process.stdin.writable)
      throw new Error('Codex App Server stdin is unavailable');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      const candidate = object(parsed);
      if (!candidate) throw new Error('message is not an object');
      message = candidate;
    } catch (error) {
      this.failAll(
        new Error(
          `Malformed Codex App Server JSONL: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      this.process?.kill('SIGTERM');
      return;
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) {
        pending.reject(
          new Error(
            `Codex App Server ${pending.method} failed: ${errorMessage(message.error) || JSON.stringify(message.error)}`,
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === 'string')
      this.handleNotification(message.method, message.params);
  }

  private handleServerRequest(
    id: number,
    method: string,
    params: unknown,
  ): void {
    if (method === 'item/commandExecution/requestApproval') {
      this.write({ id, result: { decision: 'decline' } });
    } else if (method === 'item/fileChange/requestApproval') {
      this.write({ id, result: { decision: 'decline' } });
    } else if (
      method === 'applyPatchApproval' ||
      method === 'execCommandApproval'
    ) {
      this.write({ id, result: { decision: 'denied' } });
    } else {
      this.write({
        id,
        error: {
          code: -32001,
          message: `Icarus Workflow Adapter cannot satisfy server request: ${method}`,
        },
      });
    }
    if (
      APPROVAL_METHODS.has(method) ||
      method === 'item/tool/requestUserInput'
    ) {
      this.blockTurnForServerRequest(method, params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const value = object(params);
    if (!value) return;
    if (method === 'item/agentMessage/delta') {
      const threadId = stringField(value, 'threadId');
      const turnId = stringField(value, 'turnId');
      if (!threadId || !turnId || typeof value.delta !== 'string') return;
      const active = this.turns.get(activeKey(threadId, turnId));
      if (active && !active.settled) active.delta += value.delta;
      return;
    }
    if (method === 'item/completed') {
      const threadId = stringField(value, 'threadId');
      const turnId = stringField(value, 'turnId');
      const item = object(value.item);
      if (
        threadId &&
        turnId &&
        item?.type === 'agentMessage' &&
        typeof item.text === 'string'
      ) {
        const active = this.turns.get(activeKey(threadId, turnId));
        if (active && !active.settled) active.finalMessage = item.text;
      }
      return;
    }
    if (method !== 'turn/completed') return;
    const threadId = stringField(value, 'threadId');
    const turn = object(value.turn) as CodexTurn | null;
    if (!threadId || !turn || typeof turn.id !== 'string') return;
    const active = this.turns.get(activeKey(threadId, turn.id));
    if (!active || active.settled) return;
    const completion = terminalCompletion(threadId, turn) || {
      status: 'failed' as const,
      threadId,
      turnId: turn.id,
      text: '',
      errorCode: 'codex_turn_status_invalid',
      errorMessage: `Unexpected terminal Codex turn status: ${turn.status}`,
    };
    this.settle(active, {
      ...completion,
      text: completion.text || active.finalMessage || active.delta,
    });
  }

  private blockTurnForServerRequest(method: string, params: unknown): void {
    const value = object(params);
    const threadId = stringField(value, 'threadId');
    const turnId = stringField(value, 'turnId');
    if (!threadId || !turnId) return;
    const active = this.turns.get(activeKey(threadId, turnId));
    if (!active || active.settled) return;
    this.settle(active, {
      status: 'blocked',
      threadId,
      turnId,
      text: active.finalMessage || active.delta,
      errorCode: 'codex_approval_required',
      errorMessage: `Codex requested interactive approval: ${method}`,
      approvalMethod: method,
    });
    void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  }

  private createActiveTurn(threadId: string, turnId: string): ActiveTurn {
    const key = activeKey(threadId, turnId);
    const existing = this.turns.get(key);
    if (existing) return existing;
    let resolve!: (completion: CodexTurnCompletion) => void;
    let reject!: (error: Error) => void;
    const completion = new Promise<CodexTurnCompletion>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const active: ActiveTurn = {
      threadId,
      turnId,
      completion,
      resolve,
      reject,
      settled: false,
      delta: '',
      finalMessage: '',
    };
    this.turns.set(key, active);
    return active;
  }

  private handleFor(active: ActiveTurn, cliVersion: string): CodexTaskHandle {
    return {
      threadId: active.threadId,
      turnId: active.turnId,
      cliVersion,
      completion: active.completion,
      interrupt: async () => {
        if (active.settled) return;
        await this.request('turn/interrupt', {
          threadId: active.threadId,
          turnId: active.turnId,
        });
        this.settle(active, {
          status: 'interrupted',
          threadId: active.threadId,
          turnId: active.turnId,
          text: active.finalMessage || active.delta,
          errorCode: 'codex_turn_interrupted',
          errorMessage: 'Codex turn was interrupted by the Workflow Host',
        });
      },
    };
  }

  private settle(active: ActiveTurn, completion: CodexTurnCompletion): void {
    if (active.settled) return;
    active.settled = true;
    active.resolve(completion);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const active of this.turns.values()) {
      if (active.settled) continue;
      active.settled = true;
      active.reject(error);
    }
  }
}
