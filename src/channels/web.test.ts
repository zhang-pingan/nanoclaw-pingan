import { describe, expect, it } from 'vitest';

import {
  parseMultipartBoundary,
  parseMultipartFileParts,
  parseMultipartParts,
  sanitizeUploadFilename,
} from './web.js';
import { buildAgentQueryTraceDetail } from '../agent-query-trace-detail.js';
import { agentQueryTraceManager } from '../agent-query-trace.js';
import {
  _initTestDatabase,
  getAgentQueriesOverview,
  listAgentQueries,
} from '../db.js';

describe('web trace detail helpers', () => {
  it('builds detail response compatible with the trace detail API shape', () => {
    _initTestDatabase();
    agentQueryTraceManager.startQuery({
      queryId: 'web-trace-detail',
      sourceType: 'message',
      sourceRefId: 'msg-web',
      service: 'billing',
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'web-trace-detail',
      category: 'tool',
      eventName: 'tool_started',
      status: 'running',
      payload: { toolName: 'Bash' },
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'web-trace-detail',
      category: 'error',
      eventName: 'query_failed',
      status: 'error',
      summary: 'failed',
    });

    const detail = buildAgentQueryTraceDetail('web-trace-detail');
    expect(detail).toMatchObject({
      query: { query_id: 'web-trace-detail', service: 'billing' },
      summary: { toolCallCount: 1, errorCount: 1 },
    });
    expect(detail?.events).toHaveLength(3);
    expect(detail?.highlights.tools).toHaveLength(1);
    expect(detail?.highlights.errors).toHaveLength(1);

    expect(listAgentQueries(10, 0, { service: 'billing' })).toHaveLength(1);
  });

  it('filters trace history by workflow metadata and derived error/file flags', () => {
    _initTestDatabase();
    agentQueryTraceManager.startQuery({
      queryId: 'web-trace-filter-dev',
      sourceType: 'workflow_delegation',
      sourceRefId: 'del-filter-dev',
      workflowType: 'dev_test',
      service: 'billing',
      role: 'dev',
      workflowId: 'wf-filter',
      stageKey: 'dev',
      delegationId: 'del-filter-dev',
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'web-trace-filter-dev',
      category: 'file',
      eventName: 'file_edit',
      status: 'success',
      payload: { path: 'src/billing.ts' },
    });
    agentQueryTraceManager.finishQuery('web-trace-filter-dev', 'success');

    agentQueryTraceManager.startQuery({
      queryId: 'web-trace-filter-test',
      sourceType: 'workflow_delegation',
      sourceRefId: 'del-filter-test',
      workflowType: 'dev_test',
      service: 'billing',
      role: 'test',
      workflowId: 'wf-filter',
      stageKey: 'testing',
      delegationId: 'del-filter-test',
    });
    agentQueryTraceManager.appendStructuredEvent({
      queryId: 'web-trace-filter-test',
      category: 'error',
      eventName: 'query_failed',
      status: 'error',
      summary: 'failed',
    });
    agentQueryTraceManager.finishQuery('web-trace-filter-test', 'error');

    expect(
      listAgentQueries(10, 0, {
        workflowType: 'dev_test',
        stageKey: 'dev',
        role: 'dev',
        hasFileChanges: true,
      }).map((item) => item.query_id),
    ).toEqual(['web-trace-filter-dev']);
    expect(
      listAgentQueries(10, 0, {
        workflowId: 'wf-filter',
        hasErrors: true,
      }).map((item) => item.query_id),
    ).toEqual(['web-trace-filter-test']);
    expect(
      listAgentQueries(10, 0, {
        delegationId: 'del-filter-dev',
      }).map((item) => item.query_id),
    ).toEqual(['web-trace-filter-dev']);

    const overview = getAgentQueriesOverview(
      new Date('2026-05-23T12:00:00.000Z'),
    );
    expect(overview.last24h).toMatchObject({
      success: 1,
      failure: 1,
      total: 2,
    });
    expect(overview.topFailureTypes[0]?.failureType).toBe('error');
    expect(overview.slowStages.map((item) => item.stageKey)).toContain('dev');
  });
});

describe('web upload helpers', () => {
  it('preserves non-ascii filenames while sanitizing only unsafe path characters', () => {
    expect(sanitizeUploadFilename('需求说明.pdf')).toBe('需求说明.pdf');
    expect(sanitizeUploadFilename('迭代计划_v2(终版).md')).toBe(
      '迭代计划_v2(终版).md',
    );
  });

  it('parses multipart file parts without corrupting utf-8 filenames or binary payloads', () => {
    const boundary = '----WebKitFormBoundaryicarus';
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="测试资料.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      'utf-8',
    );
    const payload = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37,
    ]);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([header, payload, footer]);

    expect(
      parseMultipartBoundary(`multipart/form-data; boundary=${boundary}`),
    ).toBe(boundary);

    const parts = parseMultipartFileParts(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.name).toBe('file');
    expect(parts[0]?.filename).toBe('测试资料.pdf');
    expect(parts[0]?.data.equals(payload)).toBe(true);
  });

  it('parses multipart text fields and named file fields together', () => {
    const boundary = '----WebKitFormBoundaryFields';
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="workflow_type"\r\n\r\n`,
        'utf-8',
      ),
      Buffer.from('dev_test', 'utf-8'),
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file_0"; filename="方案.md"\r\nContent-Type: text/markdown\r\n\r\n`,
        'utf-8',
      ),
      Buffer.from('# 方案\n', 'utf-8'),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'),
    ]);

    const parts = parseMultipartParts(body, boundary);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ name: 'workflow_type' });
    expect(parts[0]?.data.toString('utf-8')).toBe('dev_test');
    expect(parts[1]).toMatchObject({ name: 'file_0', filename: '方案.md' });
  });
});
