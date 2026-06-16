import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { ClassifiedFailure } from '../failure-taxonomy.js';
import { assertValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import type { ContainerOutput } from '../container-runner.js';
import type { RunOnceRequest } from './schemas.js';

export interface RunOnceTraceEventRecord {
  index: number;
  at: string;
  kind: 'container_output' | 'container_error' | 'result' | 'final';
  output?: ContainerOutput;
  error?: string;
  failure?: ClassifiedFailure;
  status?: 'success' | 'error';
}

export interface RunOnceTraceDocument {
  schema_version: 1;
  run_id: string;
  query_id: string;
  chat_jid: string;
  group_folder: string;
  created_at: string;
  updated_at: string;
  status: 'running' | 'success' | 'error';
  model: {
    selected: string;
    selected_reason?: string;
    actual?: string;
  };
  request: RunOnceRequest;
  container_input?: {
    executionMode: 'external_system_once';
    isolatedSession: true;
    requireResult: boolean;
    isOneShot: true;
    cwd: '/workspace/run-once';
  };
  response?: {
    ok: boolean;
    text?: string;
    error?: string;
    failure?: ClassifiedFailure;
  };
  agent_trace?: unknown;
  events: RunOnceTraceEventRecord[];
}

export interface RunOnceTraceWriter {
  hostPath: string;
  containerPath: string;
  recordOutput(output: ContainerOutput): void;
  recordError(error: string, failure?: ClassifiedFailure): void;
  finalize(input: {
    status: 'success' | 'error';
    actualModel?: string;
    response: NonNullable<RunOnceTraceDocument['response']>;
    agentTrace?: unknown;
  }): void;
}

function safeTraceTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

function writeTraceFile(
  hostPath: string,
  document: RunOnceTraceDocument,
): void {
  fs.mkdirSync(path.dirname(hostPath), { recursive: true });
  fs.writeFileSync(hostPath, JSON.stringify(document, null, 2) + '\n');
}

export function runOnceWorkspaceHostPath(groupFolder: string): string {
  assertValidGroupFolder(groupFolder);
  return path.join(DATA_DIR, 'run-once-workspaces', groupFolder);
}

export function createRunOnceTraceWriter(input: {
  groupFolder: string;
  chatJid: string;
  request: RunOnceRequest;
  runId: string;
  queryId: string;
  selectedModel: string;
  selectedModelReason?: string;
  createdAt?: Date;
}): RunOnceTraceWriter {
  const createdAt = input.createdAt || new Date();
  const traceDir = path.join(
    runOnceWorkspaceHostPath(input.groupFolder),
    'traces',
  );
  const fileName = `${safeTraceTimestamp(createdAt)}-${input.queryId}.json`;
  const hostPath = path.join(traceDir, fileName);
  const containerPath = `/workspace/run-once/traces/${fileName}`;
  let eventIndex = 0;
  const document: RunOnceTraceDocument = {
    schema_version: 1,
    run_id: input.runId,
    query_id: input.queryId,
    chat_jid: input.chatJid,
    group_folder: input.groupFolder,
    created_at: createdAt.toISOString(),
    updated_at: createdAt.toISOString(),
    status: 'running',
    model: {
      selected: input.selectedModel,
      selected_reason: input.selectedModelReason,
    },
    request: input.request,
    container_input: {
      executionMode: 'external_system_once',
      isolatedSession: true,
      requireResult: input.request.require_result,
      isOneShot: true,
      cwd: '/workspace/run-once',
    },
    events: [],
  };

  const persist = () => {
    document.updated_at = new Date().toISOString();
    try {
      writeTraceFile(hostPath, document);
    } catch (err) {
      logger.warn({ err, hostPath }, 'Failed to write internal run-once trace');
    }
  };

  persist();

  return {
    hostPath,
    containerPath,
    recordOutput(output: ContainerOutput): void {
      document.events.push({
        index: ++eventIndex,
        at: new Date().toISOString(),
        kind: output.result ? 'result' : 'container_output',
        output,
      });
      persist();
    },
    recordError(error: string, failure?: ClassifiedFailure): void {
      document.events.push({
        index: ++eventIndex,
        at: new Date().toISOString(),
        kind: 'container_error',
        error,
        failure,
      });
      persist();
    },
    finalize(finalInput): void {
      document.status = finalInput.status;
      document.model.actual = finalInput.actualModel;
      document.response = finalInput.response;
      document.agent_trace = finalInput.agentTrace;
      document.events.push({
        index: ++eventIndex,
        at: new Date().toISOString(),
        kind: 'final',
        status: finalInput.status,
        error: finalInput.response.error,
        failure: finalInput.response.failure,
      });
      persist();
    },
  };
}
