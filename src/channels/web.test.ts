import { describe, expect, it } from 'vitest';

import {
  parseMultipartBoundary,
  parseMultipartFileParts,
  sanitizeUploadFilename,
} from './web.js';

describe('web upload helpers', () => {
  it('preserves non-ascii filenames while sanitizing only unsafe path characters', () => {
    expect(sanitizeUploadFilename('需求说明.pdf')).toBe('需求说明.pdf');
    expect(sanitizeUploadFilename('迭代计划_v2(终版).md')).toBe('迭代计划_v2(终版).md');
  });

  it('parses multipart file parts without corrupting utf-8 filenames or binary payloads', () => {
    const boundary = '----WebKitFormBoundarynanoclaw';
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="测试资料.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
      'utf-8',
    );
    const payload = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const body = Buffer.concat([header, payload, footer]);

    expect(parseMultipartBoundary(`multipart/form-data; boundary=${boundary}`)).toBe(boundary);

    const parts = parseMultipartFileParts(body, boundary);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.filename).toBe('测试资料.pdf');
    expect(parts[0]?.data.equals(payload)).toBe(true);
  });
});
