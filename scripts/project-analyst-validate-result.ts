#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  collaborationAnalysisInputSchema,
  collaborationAnalysisResultSchema,
  collaborationRepositoryAnalysisInputSchema,
  collaborationRepositoryAnalysisResultSchema,
} from '../src/collaboration/analysis-contracts.js';
import { collaborationCanonicalHashV3 } from '../src/collaboration/protocol/v3-reducer.js';
import { strictParseJson } from '../src/collaboration/protocol/canonical-json.js';

interface Arguments {
  readonly resultPath: string;
  readonly contextPath: string | null;
  readonly manifestPath: string | null;
  readonly catalogPath: string | null;
}

function usage(): never {
  process.stderr.write(
    'usage: node validate-result.mjs <result.json> [--context context.json] [--manifest manifest.json] [--catalog resources/catalog.json]\n',
  );
  process.exit(2);
}

function parseArguments(argv: readonly string[]): Arguments {
  const resultPath = argv[0];
  if (!resultPath || resultPath.startsWith('--')) usage();
  let contextPath: string | null = null;
  let manifestPath: string | null = null;
  let catalogPath: string | null = null;
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!value) usage();
    if (name === '--context') contextPath = value;
    else if (name === '--manifest') manifestPath = value;
    else if (name === '--catalog') catalogPath = value;
    else throw new Error(`unknown option: ${name}`);
  }
  return { resultPath, contextPath, manifestPath, catalogPath };
}

function readJson(file: string): unknown {
  return strictParseJson(readFileSync(path.resolve(file), 'utf8'));
}

function requireEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
}

function validatePackageResult(
  value: unknown,
  contextValue: unknown | null,
  manifestValue: unknown | null,
): void {
  const result = collaborationAnalysisResultSchema.parse(value);
  if (contextValue !== null) {
    const context = collaborationAnalysisInputSchema.parse(contextValue);
    requireEqual('analysis_id', result.analysis_id, context.analysis_id);
    requireEqual('snapshot_head', result.snapshot_head, context.snapshot_head);
    requireEqual(
      'context_hash',
      result.context_hash,
      collaborationCanonicalHashV3(context),
    );
  }
  if (manifestValue !== null) {
    const manifest = manifestValue as Record<string, unknown>;
    for (const field of [
      'analysis_id',
      'snapshot_head',
      'context_hash',
      'prompt_hash',
      'challenge',
      'contract_version',
    ] as const)
      requireEqual(field, result[field], manifest[field]);
  }
}

function validateRepositoryResult(
  value: unknown,
  contextValue: unknown | null,
  manifestValue: unknown | null,
  catalogValue: unknown,
): void {
  const result = collaborationRepositoryAnalysisResultSchema.parse(value);
  const catalogHash = collaborationCanonicalHashV3(catalogValue);
  requireEqual(
    'resource_catalog_hash',
    result.resource_catalog_hash,
    catalogHash,
  );
  if (contextValue !== null) {
    const context =
      collaborationRepositoryAnalysisInputSchema.parse(contextValue);
    requireEqual(
      'repository_head',
      result.repository_head,
      context.repository.repository_head,
    );
    requireEqual('scope', result.scope, context.scope);
    requireEqual(
      'verification_level',
      result.verification_level,
      context.verification.level,
    );
    requireEqual(
      'resource_catalog_hash',
      result.resource_catalog_hash,
      context.resource_catalog_hash,
    );
    requireEqual(
      'context_hash',
      result.context_hash,
      collaborationCanonicalHashV3(context),
    );
  }
  if (manifestValue !== null) {
    const manifest = manifestValue as Record<string, unknown>;
    if (manifest.host_analysis_run_binding !== false)
      throw new Error(
        'repository manifest must state host_analysis_run_binding=false',
      );
    for (const field of [
      'repository_head',
      'context_hash',
      'resource_catalog_hash',
      'scope',
      'verification_level',
      'contract_version',
    ] as const)
      requireEqual(field, result[field], manifest[field]);
  }
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const value = readJson(args.resultPath) as { format?: unknown };
  const context = args.contextPath ? readJson(args.contextPath) : null;
  const manifest = args.manifestPath ? readJson(args.manifestPath) : null;
  if (value?.format === 'icarus.collaboration-analysis-result/1')
    validatePackageResult(value, context, manifest);
  else if (
    value?.format === 'icarus.collaboration-repository-analysis-result/1'
  ) {
    const catalogPath =
      args.catalogPath ??
      path.join(
        path.dirname(args.contextPath ?? args.resultPath),
        'resources/catalog.json',
      );
    validateRepositoryResult(value, context, manifest, readJson(catalogPath));
  } else
    throw new Error(`unsupported analysis result format: ${value?.format}`);
  process.stdout.write(
    `${String(value.format)} is structurally valid and all supplied bindings match.\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
