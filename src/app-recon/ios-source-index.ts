import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { IosEvidenceStore } from './ios-evidence-store.js';
import { resolveIosServiceConfig } from './ios-service-config.js';
import { redactText } from './ios-redaction.js';
import type { JsonObject } from './types.js';

const execFileAsync = promisify(execFile);

export interface SearchCodeQuery {
  type: string;
  value: string;
}

export interface SearchCodeInput {
  service: string;
  session_id?: string;
  scope?: Array<'ios_client' | 'backend'>;
  queries: SearchCodeQuery[];
  max_results?: number;
}

function rgPattern(query: SearchCodeQuery): string {
  if (query.type === 'api_path') return query.value;
  if (query.type === 'accessibility_id') return query.value;
  if (query.type === 'screen_title') return query.value;
  return query.value;
}

function parseRgLine(line: string): {
  path: string;
  line: number;
  text: string;
} | null {
  const first = line.indexOf(':');
  if (first <= 0) return null;
  const second = line.indexOf(':', first + 1);
  if (second <= first) return null;
  const lineNo = Number.parseInt(line.slice(first + 1, second), 10);
  if (!Number.isFinite(lineNo)) return null;
  return {
    path: line.slice(0, first),
    line: lineNo,
    text: line.slice(second + 1),
  };
}

async function runRg(root: string, pattern: string, maxResults: number) {
  try {
    const result = await execFileAsync(
      'rg',
      ['--line-number', '--no-heading', '--fixed-strings', pattern, root],
      {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
          HOME: process.env.HOME,
        },
      },
    );
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map(parseRgLine)
      .filter((item): item is NonNullable<ReturnType<typeof parseRgLine>> =>
        item !== null,
      )
      .slice(0, maxResults);
  } catch (err) {
    const maybe = err as { code?: number; stdout?: string };
    if (maybe.code === 1) return [];
    if (typeof maybe.stdout === 'string' && maybe.stdout.trim()) {
      return maybe.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map(parseRgLine)
        .filter((item): item is NonNullable<ReturnType<typeof parseRgLine>> =>
          item !== null,
        )
        .slice(0, maxResults);
    }
    throw err;
  }
}

export async function searchIosCode(input: {
  store: IosEvidenceStore;
  request: SearchCodeInput;
}): Promise<{ matches: JsonObject[]; evidence: string[] }> {
  const resolved = resolveIosServiceConfig(input.request.service, {
    requireIosRepoExists: true,
    requireBackendRepoExists: false,
  });
  const scope = input.request.scope || ['ios_client', 'backend'];
  const maxResults = Math.min(Math.max(input.request.max_results || 20, 1), 100);
  const roots: Array<{
    scope: 'ios_client' | 'backend';
    root: string;
    evidenceType: 'CLIENT_CODE' | 'SERVER_CODE';
    repo: string;
  }> = [];
  if (scope.includes('ios_client')) {
    roots.push({
      scope: 'ios_client',
      root: resolved.ios_repo_host_path,
      evidenceType: 'CLIENT_CODE',
      repo: resolved.ios.repo_path,
    });
  }
  if (scope.includes('backend') && resolved.backend_repo_host_path) {
    roots.push({
      scope: 'backend',
      root: resolved.backend_repo_host_path,
      evidenceType: 'SERVER_CODE',
      repo: resolved.service_config.repo_path || resolved.service,
    });
  }

  const sessionId = input.request.session_id || 'SEARCH-CODE';
  const evidence: string[] = [];
  const matches: JsonObject[] = [];
  for (const query of input.request.queries || []) {
    const pattern = rgPattern(query);
    if (!pattern.trim()) continue;
    for (const root of roots) {
      if (!fs.existsSync(root.root)) continue;
      const rgMatches = await runRg(
        root.root,
        pattern,
        Math.max(1, maxResults - matches.length),
      );
      for (const match of rgMatches) {
        const relativePath = path.relative(root.root, match.path);
        const redacted = redactText(match.text, 'code');
        const record = input.store.createEvidence({
          type: root.evidenceType,
          session_id: sessionId,
          source: 'ios_app_search_code',
          summary: `${root.scope} match for ${query.type}: ${query.value}`,
        payload: {
          repo: root.repo,
          path: relativePath,
          line: match.line,
          query: {
            type: query.type,
            value: query.value,
          },
          snippet: redacted.value.trim().slice(0, 500),
        } as JsonObject,
          redact: false,
        });
        evidence.push(record.id);
        matches.push({
          id: record.id,
          repo: root.repo,
          path: relativePath,
          line: match.line,
          symbols: [],
          summary: `${query.type} "${query.value}" matched ${relativePath}:${match.line}`,
        });
        if (matches.length >= maxResults) break;
      }
      if (matches.length >= maxResults) break;
    }
    if (matches.length >= maxResults) break;
  }

  return { matches, evidence };
}
