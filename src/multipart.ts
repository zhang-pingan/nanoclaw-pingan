import fs from 'fs';
import path from 'path';

export type MultipartFilePart = {
  name: string;
  filename: string;
  data: Buffer;
  contentType?: string;
};

export type MultipartPart = {
  name: string;
  filename?: string;
  data: Buffer;
  headers: Record<string, string>;
  contentType?: string;
};

export function parseMultipartBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || '').trim() || null;
}

export function parseMultipartFileParts(
  body: Buffer,
  boundary: string,
): MultipartFilePart[] {
  return parseMultipartParts(body, boundary)
    .filter((part) => part.filename)
    .map((part) => ({
      name: part.name,
      filename: part.filename || '',
      data: part.data,
      contentType: part.contentType,
    }));
}

function parseHeaderLines(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

export function parseMultipartParts(
  body: Buffer,
  boundary: string,
): MultipartPart[] {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const parts: MultipartPart[] = [];
  let searchIndex = 0;

  while (searchIndex < body.length) {
    const boundaryIndex = body.indexOf(boundaryBuffer, searchIndex);
    if (boundaryIndex === -1) break;

    let cursor = boundaryIndex + boundaryBuffer.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) {
      break;
    }
    if (body[cursor] === 13 && body[cursor + 1] === 10) {
      cursor += 2;
    }

    const headerEnd = body.indexOf(headerSeparator, cursor);
    if (headerEnd === -1) break;
    const headerText = body.slice(cursor, headerEnd).toString('utf-8');
    const headers = parseHeaderLines(headerText);
    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const filenameMatch =
      headerText.match(/filename\*=UTF-8''([^\r\n;]+)/i) ||
      headerText.match(/filename="([^"]+)"/i);

    const contentStart = headerEnd + headerSeparator.length;
    const nextBoundaryIndex = body.indexOf(boundaryBuffer, contentStart);
    if (nextBoundaryIndex === -1) break;

    let contentEnd = nextBoundaryIndex;
    if (body[contentEnd - 2] === 13 && body[contentEnd - 1] === 10) {
      contentEnd -= 2;
    }

    if (nameMatch?.[1]) {
      const part: MultipartPart = {
        name: nameMatch[1],
        data: body.slice(contentStart, contentEnd),
        headers,
        contentType: headers['content-type'],
      };
      if (filenameMatch?.[1]) {
        let rawFilename = filenameMatch[1];
        try {
          rawFilename = decodeURIComponent(rawFilename);
        } catch {}
        part.filename = rawFilename;
      }
      parts.push(part);
    }

    searchIndex = nextBoundaryIndex;
  }

  return parts;
}

export function sanitizeUploadFilename(rawFilename: string): string {
  const trimmed = path.basename(String(rawFilename || '').trim());
  const ext = path.extname(trimmed);
  const name = path.basename(trimmed, ext);
  const safeName = name
    .replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, '_')
    .trim();
  const safeExt = ext.replace(/[\u0000-\u001f\u007f/\\?%*:|"<>]/g, '_').trim();
  const base = safeName || `upload-${Date.now()}`;
  return `${base}${safeExt}`;
}

export function ensureUniqueUploadPath(
  baseDir: string,
  filename: string,
): string {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(baseDir, filename);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${stem}-${index}${ext}`);
    index += 1;
  }
  return candidate;
}

export function getMultipartTextField(
  parts: MultipartPart[],
  name: string,
): string {
  const part = parts.find((item) => item.name === name && !item.filename);
  return part ? part.data.toString('utf-8').trim() : '';
}
