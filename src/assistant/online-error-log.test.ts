import { describe, expect, it, vi } from 'vitest';

import {
  listOnlineLogServiceOptions,
  parseOnlineErrorLogText,
  scanOnlineErrorLogRule,
} from './online-error-log.js';
import { DEFAULT_ASSISTANT_SETTINGS } from './types.js';

const LOG_LINE_PATTERN =
  '^(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}\\.\\d{3})\\s+(\\w+)\\s+.*$';
const LOG_LINE_GROUP_MAPPING = {
  time: 1,
  level: 2,
};

function sampleLog(): string {
  return [
    '2026-05-07 09:49:59.999 ERROR [traceId=trace-too-old-0001] com.example.Old - old error',
    'java.lang.IllegalStateException: old failure',
    '2026-05-07 09:55:00.000 INFO  [traceId=trace-info-0001] com.example.Info - ignored info',
    '2026-05-07 09:56:00.000 ERROR [traceId=trace-no-collect-001] [logType=NO_COLLECT] com.example.Skip - ignored error',
    '2026-05-07 09:57:00.000 ERROR [traceId=trace-valid-0001] com.example.UserService - user lookup failed',
    'java.lang.NullPointerException: missing user',
    '\tat com.example.UserService.load(UserService.java:42)',
    '2026-05-07 09:58:00.000 ERROR [traceId=trace-valid-0001] com.example.UserService - duplicate trace ignored',
    '2026-05-07 09:59:00.000 ERROR [traceId=] com.example.PaymentService - payment failed',
    'com.example.PaymentException: payment timeout',
  ].join('\n');
}

describe('online error log scan', () => {
  it('parses recent error log entries without collection-policy filtering', () => {
    const errors = parseOnlineErrorLogText({
      service: 'user-platform',
      host: 'host-a',
      logPath: '/data/log/user-platform/error.log',
      logText: sampleLog(),
      startTime: new Date(2026, 4, 7, 9, 55, 0, 0),
      endTime: new Date(2026, 4, 7, 10, 5, 0, 0),
      config: {
        log_line_pattern: LOG_LINE_PATTERN,
        log_line_group_mapping: LOG_LINE_GROUP_MAPPING,
      },
    });

    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatchObject({
      service: 'user-platform',
      host: 'host-a',
      time: '2026-05-07 09:56:00.000',
      level: 'ERROR',
    });
    expect(errors[0].rawLog).toContain('trace-no-collect-001');
    expect(errors[1]).toMatchObject({
      service: 'user-platform',
      host: 'host-a',
      time: '2026-05-07 09:57:00.000',
      level: 'ERROR',
    });
    expect(errors[1].rawLog).toContain('UserService.java:42');
    expect(errors[2].rawLog).toContain('duplicate trace ignored');
    expect(errors[3].rawLog).toContain('com.example.PaymentException');
  });

  it('requires configured group mapping to parse entries', () => {
    expect(() =>
      parseOnlineErrorLogText({
        service: 'user-platform',
        host: 'host-a',
        logPath: '/data/log/user-platform/error.log',
        logText: sampleLog(),
        startTime: new Date(2026, 4, 7, 9, 55, 0, 0),
        endTime: new Date(2026, 4, 7, 10, 5, 0, 0),
        config: {
          log_line_pattern: LOG_LINE_PATTERN,
        },
      }),
    ).toThrow('log_line_group_mapping');
  });

  it('builds service options from log_hosts and logs_error', () => {
    const options = listOnlineLogServiceOptions({
      ready: {
        log_hosts: ['host-a', 'host-b'],
        logs_error: '/data/log/ready/error.log',
        log_line_pattern: LOG_LINE_PATTERN,
        log_line_group_mapping: LOG_LINE_GROUP_MAPPING,
      },
      missingPath: {
        log_hosts: ['host-c'],
      },
    });

    expect(options).toEqual([
      {
        service: 'missingPath',
        hosts: ['host-c'],
        logsErrorPath: '',
        configured: false,
        disabledReason:
          '缺少 logs_error / log_line_pattern / log_line_group_mapping',
      },
      {
        service: 'ready',
        hosts: ['host-a', 'host-b'],
        logsErrorPath: '/data/log/ready/error.log',
        configured: true,
        disabledReason: null,
      },
    ]);
  });

  it('creates inbox candidates only for selected services with recent errors', () => {
    const readRemoteLog = vi.fn(({ host }) =>
      host === 'host-a'
        ? sampleLog()
        : '2026-05-07 09:57:00.000 INFO  [traceId=trace-ok-0001] com.example.Ok - ok',
    );
    const now = new Date(2026, 4, 7, 10, 5, 0, 0);
    const items = scanOnlineErrorLogRule({
      now,
      readRemoteLog,
      registry: {
        'user-platform': {
          user: 'root',
          log_hosts: ['host-a', 'host-b'],
          logs_error: '/data/log/user-platform/error.log',
          log_line_pattern: LOG_LINE_PATTERN,
          log_line_group_mapping: LOG_LINE_GROUP_MAPPING,
        },
        unselected: {
          log_hosts: ['host-c'],
          logs_error: '/data/log/unselected/error.log',
          log_line_pattern: LOG_LINE_PATTERN,
          log_line_group_mapping: LOG_LINE_GROUP_MAPPING,
        },
      },
      settings: {
        ...DEFAULT_ASSISTANT_SETTINGS,
        triggerRules: {
          ...DEFAULT_ASSISTANT_SETTINGS.triggerRules,
          'online.error_logs': {
            enabled: true,
            investigationEnabled: true,
            autoEnabled: true,
            selectedServices: ['user-platform'],
          },
        },
      },
    });

    expect(readRemoteLog).toHaveBeenCalledTimes(2);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'risk',
      priority: 'high',
      title: '线上 error 日志：user-platform',
      sourceType: 'online_error_log',
      sourceRefId: 'user-platform',
      triggerRuleKey: 'online.error_logs',
    });
    expect(items[0].body).toContain('最近 10 分钟扫描到 4 条 ERROR 日志');
    expect(items[0].extra?.onlineErrorLog).toMatchObject({
      service: 'user-platform',
      hosts: ['host-a', 'host-b'],
      logPath: '/data/log/user-platform/error.log',
      totalErrorCount: 4,
    });
    const details = items[0].extra?.onlineErrorLog as {
      logs?: Array<{ rawLog: string; time: string; level: string }>;
    };
    expect(details.logs?.[1].rawLog).toContain('UserService.java:42');
    expect(details.logs?.[1].time).toBe('2026-05-07 09:57:00.000');
    expect(details.logs?.[1].level).toBe('ERROR');
  });

  it('does not scan when the online error log rule is disabled', () => {
    const readRemoteLog = vi.fn(() => sampleLog());
    const items = scanOnlineErrorLogRule({
      now: new Date(2026, 4, 7, 10, 5, 0, 0),
      readRemoteLog,
      registry: {
        'user-platform': {
          log_hosts: ['host-a'],
          logs_error: '/data/log/user-platform/error.log',
          log_line_pattern: LOG_LINE_PATTERN,
          log_line_group_mapping: LOG_LINE_GROUP_MAPPING,
        },
      },
      settings: {
        ...DEFAULT_ASSISTANT_SETTINGS,
        triggerRules: {
          ...DEFAULT_ASSISTANT_SETTINGS.triggerRules,
          'online.error_logs': {
            enabled: false,
            investigationEnabled: false,
            autoEnabled: false,
            selectedServices: ['user-platform'],
          },
        },
      },
    });

    expect(items).toEqual([]);
    expect(readRemoteLog).not.toHaveBeenCalled();
  });
});
