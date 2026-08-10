import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CollaborationStorePreflightResult,
  preflightCollaborationStore,
} from './store-preflight.js';

export function parseCollaborationStorePreflightArguments(
  args: readonly string[],
): { readonly storeDir: string } {
  if (args.length !== 2 || args[0] !== '--store-dir' || !args[1])
    throw new Error('Usage: store-preflight-cli --store-dir <path>');
  return { storeDir: path.resolve(args[1]) };
}

function printResult(
  result: CollaborationStorePreflightResult,
  output: (line: string) => void,
): void {
  output(`collaboration_store_decision=${result.decision}`);
  output(
    `collaboration_store_observed_schema=${
      result.observedSchemaVersion === null
        ? 'none'
        : String(result.observedSchemaVersion)
    }`,
  );
  output(
    `collaboration_store_target_schema=${String(result.targetSchemaVersion)}`,
  );
  if (result.decision === 'archived') {
    output(`collaboration_store_archive=${result.archiveDirectory}`);
    output(
      `Collaboration schema v${String(result.observedSchemaVersion)} is incompatible with current v${String(result.targetSchemaVersion)}; archived to ${result.archiveDirectory}`,
    );
    output(
      `The Host will initialize a new Collaboration schema v${String(result.targetSchemaVersion)}`,
    );
  }
}

export function runCollaborationStorePreflightCli(
  args: readonly string[],
  dependencies: {
    readonly output?: (line: string) => void;
    readonly errorOutput?: (line: string) => void;
  } = {},
): number {
  const output = dependencies.output ?? console.log;
  const errorOutput = dependencies.errorOutput ?? console.error;
  try {
    const options = parseCollaborationStorePreflightArguments(args);
    printResult(preflightCollaborationStore(options), output);
    return 0;
  } catch (error) {
    errorOutput(
      `Collaboration store preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule())
  process.exitCode = runCollaborationStorePreflightCli(process.argv.slice(2));
