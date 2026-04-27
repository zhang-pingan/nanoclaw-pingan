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
  GROUPS_DIR,
  WEB_UPLOADS_DIR,
} from './config.js';
import { readEnvFile } from './env.js';

const DEFAULT_BASE_URL = 'https://api.rootflowai.com/v1';
const DEFAULT_MODEL = 'gpt-image-2';
const COUNT_MODEL = 'gpt-image-2-count';
const DEFAULT_SIZE = '1536x1024';
const DEFAULT_QUALITY = 'high';
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_IMAGES = 4;
const MAX_EDIT_IMAGES = 8;

type Profile = 'auto' | 'metered' | 'count';
type ResolvedProfile = 'metered' | 'count';
type Operation = 'generate' | 'edit';
type ImageSource =
  | 'b64_json'
  | 'image_base64'
  | 'base64'
  | 'b64'
  | 'url'
  | 'image_url';

const profileModelDefaults: Record<ResolvedProfile, string> = {
  metered: DEFAULT_MODEL,
  count: COUNT_MODEL,
};

const modelProfileMap: Record<string, ResolvedProfile> = {
  [DEFAULT_MODEL]: 'metered',
  [COUNT_MODEL]: 'count',
};

const envKeys = [
  'ROOTFLOWAI_BASE_URL',
  'ROOTFLOWAI_METERED_API_KEY',
  'ROOTFLOWAI_API_KEY',
  'ROOTFLOWAI_API_TOKEN',
  'ROOTFLOWAI_TOKEN',
  'ROOTFLOWAI_COUNT_API_KEY',
  'ROOTFLOWAI_COUNT_TOKEN',
  'ROOTFLOWAI_IMAGE_DEFAULT_SIZE',
  'ROOTFLOWAI_IMAGE_DEFAULT_QUALITY',
];

const commonArgsSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  profile: z.enum(['auto', 'metered', 'count']).optional().default('auto'),
  model: z.string().trim().min(1).max(100).optional(),
  size: z.string().trim().min(3).max(40).optional(),
  quality: z.string().trim().min(1).max(40).optional(),
  n: z.number().int().min(1).max(MAX_IMAGES).optional().default(1),
  timeout_ms: z
    .number()
    .int()
    .min(5_000)
    .max(600_000)
    .optional()
    .default(DEFAULT_TIMEOUT_MS),
});

const generateArgsSchema = commonArgsSchema;

const editArgsSchema = commonArgsSchema.extend({
  image_paths: z.array(z.string().trim().min(1)).min(1).max(MAX_EDIT_IMAGES),
  mask_path: z.string().trim().min(1).optional(),
  background: z.string().trim().min(1).max(100).optional(),
  input_fidelity: z.string().trim().min(1).max(100).optional(),
});

export interface RootflowAiSavedImage {
  path: string;
  relative_path: string;
  mime_type: string;
  source: ImageSource;
}

export interface RootflowAiResult {
  status: 'success' | 'error';
  request_id: string;
  operation: Operation;
  model?: string;
  profile?: ResolvedProfile;
  images?: RootflowAiSavedImage[];
  error?: string;
  details?: string;
}

interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  apiKeySource: string;
  profile: ResolvedProfile;
  model: string;
  size: string;
  quality: string;
}

interface ResponseImageData {
  bytes: Buffer;
  mimeType: string;
  source: ImageSource;
}

function resolveProfile(profile: Profile, model?: string): ResolvedProfile {
  if (profile !== 'auto') return profile;
  if (model && modelProfileMap[model]) return modelProfileMap[model];
  return 'metered';
}

function resolveModel(profile: Profile, model?: string): string {
  if (model) return model;
  if (profile === 'auto') return DEFAULT_MODEL;
  return profileModelDefaults[profile];
}

function resolveConfig(args: z.infer<typeof commonArgsSchema>): ResolvedConfig {
  const env = readEnvFile(envKeys);
  const model = resolveModel(args.profile, args.model);
  const profile = resolveProfile(args.profile, model);
  const baseUrl =
    process.env.ROOTFLOWAI_BASE_URL ||
    env.ROOTFLOWAI_BASE_URL ||
    DEFAULT_BASE_URL;
  const candidates =
    profile === 'count'
      ? ['ROOTFLOWAI_COUNT_API_KEY', 'ROOTFLOWAI_COUNT_TOKEN']
      : [
          'ROOTFLOWAI_METERED_API_KEY',
          'ROOTFLOWAI_API_KEY',
          'ROOTFLOWAI_API_TOKEN',
          'ROOTFLOWAI_TOKEN',
        ];

  for (const key of candidates) {
    const value = process.env[key] || env[key];
    if (value) {
      return {
        baseUrl: baseUrl.replace(/\/+$/, ''),
        apiKey: value,
        apiKeySource: key,
        profile,
        model,
        size:
          args.size ||
          process.env.ROOTFLOWAI_IMAGE_DEFAULT_SIZE ||
          env.ROOTFLOWAI_IMAGE_DEFAULT_SIZE ||
          DEFAULT_SIZE,
        quality:
          args.quality ||
          process.env.ROOTFLOWAI_IMAGE_DEFAULT_QUALITY ||
          env.ROOTFLOWAI_IMAGE_DEFAULT_QUALITY ||
          DEFAULT_QUALITY,
      };
    }
  }

  throw new Error(
    profile === 'count'
      ? 'RootFlowAI count API key is not configured. Set ROOTFLOWAI_COUNT_API_KEY in .env.'
      : 'RootFlowAI metered API key is not configured. Set ROOTFLOWAI_METERED_API_KEY or ROOTFLOWAI_API_KEY in .env.',
  );
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
      containerPrefix: '/workspace/ai-images/',
      hostBase: AI_IMAGES_DIR,
    },
  ];

  const mapping = mappings.find((item) =>
    containerPath.startsWith(item.containerPrefix),
  );
  if (!mapping) {
    throw new Error(
      'Image path must start with /workspace/group/, /workspace/uploads/, /workspace/attachments/, or /workspace/ai-images/.',
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
        ? `RootFlowAI request failed with HTTP ${status}.`
        : `RootFlowAI request failed: ${err.message}`,
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
    throw new Error(
      'Only HTTPS image URLs are allowed in RootFlowAI responses.',
    );
  }
  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname === 'localhost.localdomain'
  ) {
    throw new Error(
      'Localhost image URLs are not allowed in RootFlowAI responses.',
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
): Promise<RootflowAiSavedImage[]> {
  if (!payload || typeof payload !== 'object') {
    throw new Error('RootFlowAI returned an unexpected non-object response.');
  }
  const items = (payload as { data?: unknown }).data;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(
      'RootFlowAI response does not contain a non-empty data array.',
    );
  }

  const safeRequestId = sanitizeRequestId(requestId);
  const hostDir = path.join(AI_IMAGES_DIR, safeRequestId);
  fs.mkdirSync(hostDir, { recursive: true });

  const images: RootflowAiSavedImage[] = [];
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
      'RootFlowAI responded, but no image files could be extracted.',
    );
  }

  return images;
}

export async function generateRootflowAiImage(
  args: unknown,
  requestId: string,
): Promise<RootflowAiResult> {
  try {
    const parsed = generateArgsSchema.parse(args);
    const config = resolveConfig(parsed);
    const payload = {
      model: config.model,
      prompt: parsed.prompt,
      size: config.size,
      quality: config.quality,
      n: parsed.n,
    };
    const response = await axios.post(
      `${config.baseUrl}/images/generations`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: parsed.timeout_ms,
      },
    );
    const images = await saveResponseImages(
      response.data,
      requestId,
      'generate',
      parsed.timeout_ms,
    );
    return {
      status: 'success',
      request_id: requestId,
      operation: 'generate',
      model: config.model,
      profile: config.profile,
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

export async function editRootflowAiImage(
  args: unknown,
  requestId: string,
  sourceGroup: string,
): Promise<RootflowAiResult> {
  try {
    const parsed = editArgsSchema.parse(args);
    const config = resolveConfig(parsed);
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
      timeout: parsed.timeout_ms,
    });
    const images = await saveResponseImages(
      response.data,
      requestId,
      'edit',
      parsed.timeout_ms,
    );
    return {
      status: 'success',
      request_id: requestId,
      operation: 'edit',
      model: config.model,
      profile: config.profile,
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
