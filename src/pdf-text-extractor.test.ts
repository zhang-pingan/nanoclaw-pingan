import { describe, expect, it, vi, beforeEach } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

import { extractPdfText, normalizePdfExtractedText } from './pdf-text-extractor.js';

beforeEach(() => {
  execFileSyncMock.mockReset();
});

describe('pdf text extractor', () => {
  it('prefers pdftotext before falling back to PDFKit', () => {
    execFileSyncMock.mockImplementation((command: unknown) => {
      if (command === 'pdftotext') {
        return ['漫 漫画 画需 需求 求文 文档 档', 'V V1 1. .0 0'].join('\n');
      }
      throw new Error(`unexpected command ${String(command)}`);
    });

    const result = extractPdfText('/tmp/demo.pdf');

    expect(result.engine).toBe('pdftotext');
    expect(result.text).toBe(['漫画需求文档', 'V1.0'].join('\n'));
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to PDFKit when pdftotext is unavailable', () => {
    execFileSyncMock.mockImplementation((command: unknown) => {
      if (command === 'pdftotext') {
        const err = new Error('spawn pdftotext ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      if (command === 'swift') {
        return ['一、', '漫 漫画 画页 页面 面设 设计 计', '滑到底完', '成章节'].join('\n');
      }
      throw new Error(`unexpected command ${String(command)}`);
    });

    const result = extractPdfText('/tmp/demo.pdf');

    expect(result.engine).toBe('pdfkit');
    expect(result.text).toBe(['一、漫画页面设计', '滑到底完成章节'].join('\n'));
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      1,
      'pdftotext',
      ['-enc', 'UTF-8', '-eol', 'unix', '/tmp/demo.pdf', '-'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(execFileSyncMock).toHaveBeenNthCalledWith(
      2,
      'swift',
      ['-e', expect.stringContaining('PDFKit'), '/tmp/demo.pdf'],
      expect.objectContaining({
        encoding: 'utf-8',
        env: expect.objectContaining({
          CLANG_MODULE_CACHE_PATH: expect.any(String),
        }),
      }),
    );
  });

  it('normalizes per-page overlaps, bullets and wrapped lines', () => {
    const normalized = normalizePdfExtractedText(
      [
        '3 3. .功 功能 能详 详情 情',
        '●',
        '漫 漫画 画Tab 日活 用户 数',
        '核 核心 心路 路径 径： ：用户点击漫画页面按钮 → 看到书架 → 点击一册漫画 → 直接进入阅读 → 滑到底完',
        '成章节 → 答题 → 获得猫猫卡',
        '\f',
        '一、',
        '漫 漫画 画交 交互 互组 组件 件',
      ].join('\n'),
    );

    expect(normalized).toBe(
      [
        '3.功能详情',
        '● 漫画Tab日活用户数',
        '核心路径：用户点击漫画页面按钮 → 看到书架 → 点击一册漫画 → 直接进入阅读 → 滑到底完成章节 → 答题 → 获得猫猫卡',
        '',
        '一、漫画交互组件',
      ].join('\n'),
    );
  });
});
