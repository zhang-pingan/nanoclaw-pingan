import axios, { AxiosError } from 'axios';
import { lookup } from 'dns/promises';
import FormData from 'form-data';
import fs from 'fs';
import { isIP } from 'net';
import path from 'path';
import { z } from 'zod';

import {
  AI_IMAGES_DIR,
  ATTACHMENTS_DIR,
  DESKTOP_CAPTURES_DIR,
  GROUPS_DIR,
  WEB_UPLOADS_DIR,
} from './config.js';
import { readEnvFile } from './env.js';

const MAX_IMAGES = 4;
const MAX_GENERATE_INPUT_IMAGES = 16;
const MAX_EDIT_IMAGES = 8;
const imageSizeSchema = z.string().trim().min(1).max(100);

type Operation = 'generate' | 'edit';
type ImageSource =
  | 'b64_json'
  | 'image_base64'
  | 'base64'
  | 'b64'
  | 'url'
  | 'image_url';

const envKeys = [
  'AI_IMAGE_BASE_URL',
  'AI_IMAGE_MODEL',
  'AI_IMAGE_API_KEY',
  'AI_IMAGE_SIZE',
  'AI_IMAGE_QUALITY',
  'AI_IMAGE_TIMEOUT_MS',
];

const commonArgsSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  size: imageSizeSchema.optional(),
  n: z.number().int().min(1).max(MAX_IMAGES).optional().default(1),
});

const generateArgsSchema = commonArgsSchema.extend({
  image_paths: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_GENERATE_INPUT_IMAGES)
    .optional(),
  image_urls: z
    .array(z.string().trim().url())
    .min(1)
    .max(MAX_GENERATE_INPUT_IMAGES)
    .optional(),
});

const editArgsSchema = commonArgsSchema.extend({
  image_paths: z.array(z.string().trim().min(1)).min(1).max(MAX_EDIT_IMAGES),
  mask_path: z.string().trim().min(1).optional(),
  background: z.string().trim().min(1).max(100).optional(),
  input_fidelity: z.string().trim().min(1).max(100).optional(),
});

export interface AiImageSavedImage {
  path: string;
  relative_path: string;
  mime_type: string;
  source: ImageSource;
}

export interface AiImageResult {
  status: 'success' | 'error';
  request_id: string;
  operation: Operation;
  model?: string;
  images?: AiImageSavedImage[];
  error?: string;
  details?: string;
}

interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  size: string;
  quality: string;
  timeoutMs: number;
}

interface ResponseImageData {
  bytes: Buffer;
  mimeType: string;
  source: ImageSource;
}

function getRequiredConfigValue(
  env: Record<string, string>,
  key: string,
): string {
  const value = process.env[key] || env[key];
  if (!value) {
    throw new Error(`AI_IMAGE config is missing. Set ${key} in .env.`);
  }
  return value;
}

function getRequiredConfigInteger(
  env: Record<string, string>,
  key: string,
  min: number,
  max: number,
): number {
  const raw = getRequiredConfigValue(env, key);
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || String(value) !== raw.trim()) {
    throw new Error(`AI_IMAGE config ${key} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(
      `AI_IMAGE config ${key} must be between ${min} and ${max}.`,
    );
  }
  return value;
}

function resolveConfig(overrides: { size?: string } = {}): ResolvedConfig {
  const env = readEnvFile(envKeys);
  return {
    baseUrl: getRequiredConfigValue(env, 'AI_IMAGE_BASE_URL').replace(
      /\/+$/,
      '',
    ),
    apiKey: getRequiredConfigValue(env, 'AI_IMAGE_API_KEY'),
    model: getRequiredConfigValue(env, 'AI_IMAGE_MODEL'),
    size: overrides.size || getRequiredConfigValue(env, 'AI_IMAGE_SIZE'),
    quality: getRequiredConfigValue(env, 'AI_IMAGE_QUALITY'),
    timeoutMs: getRequiredConfigInteger(
      env,
      'AI_IMAGE_TIMEOUT_MS',
      5_000,
      600_000,
    ),
  };
}

export function getAiImageWaitTimeoutMs(): number {
  const env = readEnvFile(['AI_IMAGE_TIMEOUT_MS']);
  return getRequiredConfigInteger(env, 'AI_IMAGE_TIMEOUT_MS', 5_000, 600_000);
}

function sanitizeRequestId(requestId: string): string {
  return requestId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'request';
}

function resolveWorkspaceInputPath(
  containerPath: string,
  sourceGroup: string,
): string {
  const mappings = [
    {
      containerPrefix: '/workspace/group/',
      hostBase: path.join(GROUPS_DIR, sourceGroup),
    },
    {
      containerPrefix: '/workspace/uploads/',
      hostBase: WEB_UPLOADS_DIR,
    },
    {
      containerPrefix: '/workspace/attachments/',
      hostBase: ATTACHMENTS_DIR,
    },
    {
      containerPrefix: '/workspace/desktop-captures/',
      hostBase: DESKTOP_CAPTURES_DIR,
    },
    {
      containerPrefix: '/workspace/ai-images/',
      hostBase: AI_IMAGES_DIR,
    },
  ];

  const mapping = mappings.find((item) =>
    containerPath.startsWith(item.containerPrefix),
  );
  if (!mapping) {
    throw new Error(
      'Image path must start with /workspace/group/, /workspace/uploads/, /workspace/attachments/, /workspace/desktop-captures/, or /workspace/ai-images/.',
    );
  }

  const hostBase = path.resolve(mapping.hostBase);
  const relativePath = containerPath.slice(mapping.containerPrefix.length);
  const hostPath = path.resolve(path.join(hostBase, relativePath));
  if (!hostPath.startsWith(hostBase + path.sep) && hostPath !== hostBase) {
    throw new Error(
      `Image path escapes its allowed directory: ${containerPath}`,
    );
  }
  if (!fs.existsSync(hostPath)) {
    throw new Error(`Image file does not exist: ${containerPath}`);
  }
  if (!fs.statSync(hostPath).isFile()) {
    throw new Error(`Image path is not a file: ${containerPath}`);
  }
  return hostPath;
}

function formatAxiosError(err: unknown): { error: string; details?: string } {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const responseData = err.response?.data;
    const details =
      typeof responseData === 'string'
        ? responseData.slice(0, 2000)
        : responseData
          ? JSON.stringify(responseData).slice(0, 2000)
          : undefined;
    return {
      error: status
        ? `AI_IMAGE request failed with HTTP ${status}.`
        : `AI_IMAGE request failed: ${err.message}`,
      details,
    };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
  };
}

function inferMimeAndExtension(
  data: Buffer,
  contentType?: string,
): { mimeType: string; extension: string } {
  const normalized = contentType?.toLowerCase() || '';
  if (normalized.includes('png')) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (normalized.includes('jpeg') || normalized.includes('jpg')) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (normalized.includes('webp')) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  if (normalized.includes('gif')) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (
    data
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { mimeType: 'image/png', extension: '.png' };
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return { mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (
    data.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    data.subarray(0, 6).toString('ascii') === 'GIF89a'
  ) {
    return { mimeType: 'image/gif', extension: '.gif' };
  }
  if (
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: '.webp' };
  }
  return { mimeType: 'application/octet-stream', extension: '.bin' };
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part)))
    return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return false;
  }
  return true;
}

function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function validateRemoteImageUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS image URLs are allowed in AI_IMAGE responses.');
  }
  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname === 'localhost.localdomain'
  ) {
    throw new Error(
      'Localhost image URLs are not allowed in AI_IMAGE responses.',
    );
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new Error(`Could not resolve image URL hostname: ${hostname}`);
  }
  for (const item of addresses) {
    if (!isPublicIp(item.address)) {
      throw new Error(
        `Image URL resolved to a non-public address: ${item.address}`,
      );
    }
  }
}

async function fetchRemoteImage(
  url: string,
  timeoutMs: number,
): Promise<ResponseImageData> {
  await validateRemoteImageUrl(url);
  const response = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: timeoutMs,
    maxRedirects: 0,
  });
  const bytes = Buffer.from(response.data);
  const contentType = String(response.headers['content-type'] || '');
  const { mimeType } = inferMimeAndExtension(bytes, contentType);
  return {
    bytes,
    mimeType,
    source: 'url',
  };
}

async function extractImageData(
  item: unknown,
  timeoutMs: number,
): Promise<ResponseImageData | null> {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  for (const source of ['b64_json', 'image_base64', 'base64', 'b64'] as const) {
    const value = obj[source];
    if (typeof value === 'string' && value.trim()) {
      const base64Text = value.includes(',')
        ? value.slice(value.indexOf(',') + 1)
        : value;
      const bytes = Buffer.from(base64Text, 'base64');
      const { mimeType } = inferMimeAndExtension(bytes);
      return { bytes, mimeType, source };
    }
  }
  for (const source of ['url', 'image_url'] as const) {
    const value = obj[source];
    if (typeof value === 'string' && value.trim()) {
      const data = await fetchRemoteImage(value, timeoutMs);
      return { ...data, source };
    }
  }
  return null;
}

async function saveResponseImages(
  payload: unknown,
  requestId: string,
  operation: Operation,
  timeoutMs: number,
): Promise<AiImageSavedImage[]> {
  if (!payload || typeof payload !== 'object') {
    throw new Error('AI_IMAGE returned an unexpected non-object response.');
  }
  const items = (payload as { data?: unknown }).data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      'AI_IMAGE response does not contain a non-empty data array.',
    );
  }

  const safeRequestId = sanitizeRequestId(requestId);
  const hostDir = path.join(AI_IMAGES_DIR, safeRequestId);
  fs.mkdirSync(hostDir, { recursive: true });

  const images: AiImageSavedImage[] = [];
  for (const [idx, item] of items.entries()) {
    const imageData = await extractImageData(item, timeoutMs);
    if (!imageData) continue;
    const { extension, mimeType } = inferMimeAndExtension(
      imageData.bytes,
      imageData.mimeType,
    );
    const filename = `${operation === 'edit' ? 'edit' : 'image'}-${String(idx + 1).padStart(2, '0')}${extension}`;
    const hostPath = path.join(hostDir, filename);
    fs.writeFileSync(hostPath, imageData.bytes);
    const relativePath = `${safeRequestId}/${filename}`;
    images.push({
      path: `/workspace/ai-images/${relativePath}`,
      relative_path: relativePath,
      mime_type: mimeType,
      source: imageData.source,
    });
  }

  if (images.length === 0) {
    throw new Error(
      'AI_IMAGE responded, but no image files could be extracted.',
    );
  }

  return images;
}

function encodeInputImageAsDataUri(hostPath: string): string {
  const bytes = fs.readFileSync(hostPath);
  const { mimeType } = inferMimeAndExtension(bytes);
  if (!mimeType.startsWith('image/')) {
    throw new Error(`Unsupported image file type: ${hostPath}`);
  }
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

async function resolveGenerateInputImages(
  parsed: z.infer<typeof generateArgsSchema>,
  sourceGroup?: string,
): Promise<string[] | undefined> {
  const images: string[] = [];
  for (const item of parsed.image_paths || []) {
    if (!sourceGroup) {
      throw new Error('sourceGroup is required for image-to-image requests.');
    }
    images.push(
      encodeInputImageAsDataUri(resolveWorkspaceInputPath(item, sourceGroup)),
    );
  }
  for (const url of parsed.image_urls || []) {
    await validateRemoteImageUrl(url);
    images.push(url);
  }
  if (images.length > MAX_GENERATE_INPUT_IMAGES) {
    throw new Error(
      `AI_IMAGE generation accepts at most ${MAX_GENERATE_INPUT_IMAGES} input images.`,
    );
  }
  return images.length > 0 ? images : undefined;
}

export async function generateAiImage(
  args: unknown,
  requestId: string,
  sourceGroup?: string,
): Promise<AiImageResult> {
  try {
    const parsed = generateArgsSchema.parse(args);
    const config = resolveConfig({ size: parsed.size });
    const inputImages = await resolveGenerateInputImages(parsed, sourceGroup);
    const payload = {
      model: config.model,
      prompt: parsed.prompt,
      size: config.size,
      quality: config.quality,
      n: parsed.n,
      ...(inputImages ? { image: inputImages } : {}),
    };
    const response = await axios.post(
      `${config.baseUrl}/images/generations`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: config.timeoutMs,
      },
    );
    const images = await saveResponseImages(
      response.data,
      requestId,
      'generate',
      config.timeoutMs,
    );
    return {
      status: 'success',
      request_id: requestId,
      operation: 'generate',
      model: config.model,
      images,
    };
  } catch (err) {
    const formatted = formatAxiosError(err);
    return {
      status: 'error',
      request_id: requestId,
      operation: 'generate',
      ...formatted,
    };
  }
}

export async function editAiImage(
  args: unknown,
  requestId: string,
  sourceGroup: string,
): Promise<AiImageResult> {
  try {
    const parsed = editArgsSchema.parse(args);
    const config = resolveConfig({ size: parsed.size });
    const imageHostPaths = parsed.image_paths.map((item) =>
      resolveWorkspaceInputPath(item, sourceGroup),
    );
    const maskHostPath = parsed.mask_path
      ? resolveWorkspaceInputPath(parsed.mask_path, sourceGroup)
      : undefined;

    const form = new FormData();
    form.append('model', config.model);
    form.append('prompt', parsed.prompt);
    form.append('size', config.size);
    form.append('quality', config.quality);
    form.append('n', String(parsed.n));
    if (parsed.background) form.append('background', parsed.background);
    if (parsed.input_fidelity)
      form.append('input_fidelity', parsed.input_fidelity);
    for (const imageHostPath of imageHostPaths) {
      form.append('image', fs.createReadStream(imageHostPath), {
        filename: path.basename(imageHostPath),
      });
    }
    if (maskHostPath) {
      form.append('mask', fs.createReadStream(maskHostPath), {
        filename: path.basename(maskHostPath),
      });
    }

    const response = await axios.post(`${config.baseUrl}/images/edits`, form, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: config.timeoutMs,
    });
    const images = await saveResponseImages(
      response.data,
      requestId,
      'edit',
      config.timeoutMs,
    );
    return {
      status: 'success',
      request_id: requestId,
      operation: 'edit',
      model: config.model,
      images,
    };
  } catch (err) {
    const formatted = formatAxiosError(err);
    return {
      status: 'error',
      request_id: requestId,
      operation: 'edit',
      ...formatted,
    };
  }
}
