import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const SWIFT_MODULE_CACHE_DIR = path.resolve(DATA_DIR, 'swift-module-cache');
const PDF_TEXT_EXTRACT_SWIFT = `
import Foundation
import PDFKit

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)
guard let document = PDFDocument(url: url) else {
  FileHandle.standardError.write(Data("failed to open pdf".utf8))
  exit(2)
}
var pages: [String] = []
for index in 0..<document.pageCount {
  pages.append(document.page(at: index)?.string ?? "")
}
FileHandle.standardOutput.write(Data(pages.joined(separator: "\\u{0C}\\n").utf8))
`;

const PDF_STANDALONE_BLOCK_LINES = new Set([
  '步骤',
  '页面名称',
  '一句话说明',
  '衡量指标',
  '页面结构：',
  '页面结构',
  '状态',
  '规则',
  '判定条件',
  '场景',
  '处理方式',
]);

export interface PdfTextExtractor {
  readonly name: string;
  isSupported(): boolean;
  extract(filePath: string): string;
}

export interface PdfTextExtractionResult {
  engine: string;
  text: string;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function mergeOverlappingPdfTokens(line: string): string {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return line.trim();

  let output = '';
  for (const token of tokens) {
    if (!output) {
      output = token;
      continue;
    }
    if (token === output.slice(-token.length)) continue;

    let merged = false;
    for (let overlap = Math.min(output.length, token.length); overlap >= 1; overlap -= 1) {
      if (output.slice(-overlap) === token.slice(0, overlap)) {
        output += token.slice(overlap);
        merged = true;
        break;
      }
    }

    if (!merged) {
      output += ` ${token}`;
    }
  }

  return output;
}

function normalizePdfExtractedLine(line: string): string {
  if (!line.trim()) return '';

  let normalized = mergeOverlappingPdfTokens(line);
  normalized = normalized.replace(
    /\b([A-Za-z])(?:\s+[A-Za-z])+\b/g,
    (value) => value.replace(/\s+/g, ''),
  );
  normalized = normalized.replace(
    /\b([A-Za-z])\s+([A-Za-z]{2,})\b/g,
    '$1$2',
  );
  normalized = normalized.replace(
    /(?<=[\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu,
    '',
  );
  normalized = normalized.replace(
    /(?<=[\p{Script=Han}])\s+(?=[A-Za-z0-9])/gu,
    '',
  );
  normalized = normalized.replace(
    /(?<=[A-Za-z0-9])\s+(?=[\p{Script=Han}])/gu,
    '',
  );
  normalized = normalized.replace(
    /(?<=[【（《“‘])\s+/gu,
    '',
  );
  normalized = normalized.replace(
    /\s+(?=[】）》”’])/gu,
    '',
  );
  normalized = normalized.replace(
    /(?<=[\p{Script=Han}])\s+(?=[，。；：？！、])/gu,
    '',
  );
  normalized = normalized.replace(
    /(?<=[，。；：？！、】【（）《》“”‘’])\s+(?=[\p{Script=Han}A-Za-z0-9])/gu,
    '',
  );
  normalized = normalized.replace(/[ \t]{2,}/g, ' ');
  return normalized.trim();
}

function isPdfListMarker(line: string): boolean {
  return /^[●•○▪◦*-]$/.test(line);
}

function isPdfHeadingMarker(line: string): boolean {
  return /^(?:\d+(?:\.\d+)*[.、]?|[一二三四五六七八九十]+、)$/.test(line);
}

function isPdfBulletLine(line: string): boolean {
  return /^[●•○▪◦*-]\s+\S/.test(line);
}

function isPdfHeadingLine(line: string): boolean {
  return /^(?:\d+(?:\.\d+)*[.、]?|[一二三四五六七八九十]+、)\s*\S+/.test(line);
}

function isPdfStructuredBreak(line: string): boolean {
  return (
    isPdfListMarker(line) ||
    isPdfHeadingMarker(line) ||
    PDF_STANDALONE_BLOCK_LINES.has(line) ||
    /^\d+$/.test(line) ||
    /^V\d+(?:\.\d+)*$/i.test(line)
  );
}

function isPdfLineDuplicate(previous: string, current: string): boolean {
  const prevCanonical = previous.replace(/\s+/g, '');
  const currentCanonical = current.replace(/\s+/g, '');
  return prevCanonical.length > 0 && prevCanonical === currentCanonical;
}

function shouldMergePdfLines(previous: string, current: string): boolean {
  if (!previous || !current) return false;

  if (isPdfListMarker(previous) || isPdfHeadingMarker(previous)) return true;
  if (isPdfHeadingLine(previous)) return false;
  if (isPdfBulletLine(previous) && previous.length <= 16) return false;
  if (isPdfStructuredBreak(current)) return false;
  if (isPdfStructuredBreak(previous)) return false;
  if (/[。！？；]$/u.test(previous)) return false;
  if (/^[，。；：？！、）》】]/u.test(current)) return true;
  if (
    previous.length <= 2 ||
    current.length <= 2
  ) {
    return false;
  }
  if (
    /^[\p{Script=Han}]+$/u.test(previous) &&
    /^[\p{Script=Han}]+$/u.test(current)
  ) {
    return true;
  }
  return (
    /[\p{Script=Han}A-Za-z0-9"”’）】》→-]$/u.test(previous) &&
    /^[\p{Script=Han}A-Za-z0-9“‘（【《]/u.test(current)
  );
}

function joinPdfLines(previous: string, current: string): string {
  if (isPdfListMarker(previous)) return `${previous} ${current}`;
  if (/^\d+(?:\.\d+)*[.]?$/.test(previous)) return `${previous} ${current}`;
  if (/[A-Za-z0-9]$/.test(previous) && /^[A-Za-z0-9]/.test(current)) {
    return `${previous} ${current}`;
  }
  return `${previous}${current}`;
}

function normalizePdfPageText(pageText: string): string {
  const rawLines = pageText.replace(/\r\n/g, '\n').split('\n');
  const normalizedLines = rawLines.map(normalizePdfExtractedLine);
  const mergedLines: string[] = [];

  for (const line of normalizedLines) {
    if (!line) {
      if (mergedLines.length === 0 || mergedLines[mergedLines.length - 1] === '') continue;
      mergedLines.push('');
      continue;
    }

    if (mergedLines.length === 0) {
      mergedLines.push(line);
      continue;
    }

    const previous = mergedLines[mergedLines.length - 1];
    if (!previous) {
      mergedLines.push(line);
      continue;
    }

    if (isPdfLineDuplicate(previous, line)) continue;

    if (shouldMergePdfLines(previous, line)) {
      mergedLines[mergedLines.length - 1] = joinPdfLines(previous, line);
      continue;
    }

    mergedLines.push(line);
  }

  return mergedLines.join('\n').trim();
}

export function normalizePdfExtractedText(rawText: string): string {
  const normalizedSource = rawText.replace(/\r\n/g, '\n').replace(/\u0000/g, '');
  const pages = normalizedSource
    .split(/\f+/)
    .map((page) => page.trim())
    .filter((page) => page.length > 0);

  if (pages.length === 0) {
    return normalizePdfPageText(normalizedSource);
  }

  return pages
    .map(normalizePdfPageText)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

const pdftotextExtractor: PdfTextExtractor = {
  name: 'pdftotext',
  isSupported() {
    return true;
  },
  extract(filePath: string): string {
    return execFileSync(
      'pdftotext',
      ['-enc', 'UTF-8', '-eol', 'unix', filePath, '-'],
      { encoding: 'utf-8' },
    );
  },
};

const pdfKitExtractor: PdfTextExtractor = {
  name: 'pdfkit',
  isSupported() {
    return process.platform === 'darwin';
  },
  extract(filePath: string): string {
    ensureDir(SWIFT_MODULE_CACHE_DIR);
    return execFileSync(
      'swift',
      ['-e', PDF_TEXT_EXTRACT_SWIFT, filePath],
      {
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLANG_MODULE_CACHE_PATH: SWIFT_MODULE_CACHE_DIR,
        },
      },
    );
  },
};

const PDF_TEXT_EXTRACTORS: PdfTextExtractor[] = [
  pdftotextExtractor,
  pdfKitExtractor,
];

export function extractPdfText(filePath: string): PdfTextExtractionResult {
  const errors: string[] = [];

  for (const extractor of PDF_TEXT_EXTRACTORS) {
    if (!extractor.isSupported()) continue;
    try {
      const rawText = extractor.extract(filePath);
      const text = normalizePdfExtractedText(rawText.replace(/^\uFEFF/, '').trim());
      if (!text) {
        throw new Error('no extractable text');
      }
      return {
        engine: extractor.name,
        text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${extractor.name}: ${message}`);
      logger.warn(
        { err, filePath, extractor: extractor.name },
        'Failed to extract PDF text',
      );
    }
  }

  throw new Error(
    errors.length > 0
      ? `PDF 解析失败：${errors.join(' | ')}`
      : 'PDF 解析失败；当前环境没有可用的 PDF 文本提取器',
  );
}
