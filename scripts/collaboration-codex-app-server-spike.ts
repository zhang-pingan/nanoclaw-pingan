import process from 'node:process';

import { CodexAppServerClient } from '../src/workflow-execution/codex/app-server-client.js';

interface Options {
  readonly binary: string;
  readonly cwd: string;
  readonly recoverThreadId?: string;
  readonly recoverTurnId?: string;
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function parseOptions(args: readonly string[]): Options {
  const recoverThreadId = valueAfter(args, '--recover-thread');
  const recoverTurnId = valueAfter(args, '--recover-turn');
  if (
    (recoverThreadId && !recoverTurnId) ||
    (!recoverThreadId && recoverTurnId)
  )
    throw new Error(
      '--recover-thread and --recover-turn must be provided together',
    );
  return {
    binary:
      valueAfter(args, '--binary') ||
      process.env.ICARUS_CODEX_BINARY ||
      'codex',
    cwd: valueAfter(args, '--cwd') || process.cwd(),
    recoverThreadId,
    recoverTurnId,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const client = new CodexAppServerClient({
    binary: options.binary,
    cwd: options.cwd,
    requestTimeoutMs: 30_000,
  });
  try {
    const handle =
      options.recoverThreadId && options.recoverTurnId
        ? await client.recoverTask(
            options.recoverThreadId,
            options.recoverTurnId,
          )
        : await client.startTask({
            title: `Icarus Collaboration App Server Spike ${new Date()
              .toISOString()
              .slice(0, 10)}`,
            prompt:
              'This is an Icarus App Server integration spike. Do not modify files or run commands. Reply with exactly: ICARUS_APP_SERVER_SPIKE_OK',
            cwd: options.cwd,
            sandbox: 'read-only',
            approvalPolicy: 'never',
          });
    process.stdout.write(
      `${JSON.stringify({
        phase: options.recoverThreadId ? 'recovered' : 'started',
        threadId: handle.threadId,
        turnId: handle.turnId,
        cliVersion: handle.cliVersion,
        cwd: options.cwd,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: false,
      })}\n`,
    );
    const completion = await handle.completion;
    process.stdout.write(
      `${JSON.stringify({ phase: 'completed', ...completion })}\n`,
    );
    if (
      !options.recoverThreadId &&
      (completion.status !== 'completed' ||
        completion.text.trim() !== 'ICARUS_APP_SERVER_SPIKE_OK')
    ) {
      process.exitCode = 1;
    }
  } finally {
    client.close();
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
