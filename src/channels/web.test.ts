import { describe, expect, it } from 'vitest';

import {
  parseMultipartBoundary,
  parseMultipartFileParts,
  parseMultipartParts,
  sanitizeUploadFilename,
} from './web.js';

describe('web upload helpers', () => {
  it('preserves non-ascii filenames while sanitizing only unsafe path characters', () => {
    expect(sanitizeUploadFilename('需求说明.pdf')).toBe('需求说明.pdf');
    expect(sanitizeUploadFilename('迭代计划_v2(终版).md')).toBe(
      '迭代计划_v2(终版).md',
    );
  });

  it('parses multipart file parts without corrupting utf-8 filenames or binary payloads', () => {
    const boundary = '----WebKitFormBoundarynanoclaw';
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
