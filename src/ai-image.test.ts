import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { aiImagesDir, axiosGetMock, axiosPostMock, readEnvFileMock } =
  vi.hoisted(() => ({
    aiImagesDir: '/tmp/nanoclaw-ai-image-test',
    axiosGetMock: vi.fn(),
    axiosPostMock: vi.fn(),
    readEnvFileMock: vi.fn(),
  }));

vi.mock('axios', () => ({
  default: {
    get: axiosGetMock,
    post: axiosPostMock,
  },
  AxiosError: class AxiosError extends Error {},
}));

vi.mock('./config.js', () => ({
  AI_IMAGES_DIR: aiImagesDir,
  ATTACHMENTS_DIR: '/tmp/nanoclaw-ai-image-attachments',
  GROUPS_DIR: '/tmp/nanoclaw-ai-image-groups',
  WEB_UPLOADS_DIR: '/tmp/nanoclaw-ai-image-uploads',
}));

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

import { generateAiImage } from './ai-image.js';

const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xdb]).toString('base64');

function mockSuccessfulImageResponse() {
  axiosPostMock.mockResolvedValue({
    data: {
      data: [{ b64_json: jpegBase64 }],
    },
  });
}

function mockEnv(values: Record<string, string> = {}) {
  readEnvFileMock.mockReturnValue({
    AI_IMAGE_BASE_URL: 'https://images.example.test/v1/',
    AI_IMAGE_API_KEY: 'sk-test',
    AI_IMAGE_MODEL: 'gpt-image-test',
    AI_IMAGE_QUALITY: 'high',
    AI_IMAGE_TIMEOUT_MS: '10000',
    ...values,
  });
}

describe('generateAiImage', () => {
  afterEach(() => {
    axiosGetMock.mockReset();
    axiosPostMock.mockReset();
    readEnvFileMock.mockReset();
    fs.rmSync(aiImagesDir, { recursive: true, force: true });
  });

  it('uses the MCP size argument when provided', async () => {
    mockEnv();
    mockSuccessfulImageResponse();

    const result = await generateAiImage(
      { prompt: 'draw a compact robot', size: '1792x1024' },
      'size-override',
    );

    expect(result.status).toBe('success');
    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://images.example.test/v1/images/generations',
      expect.objectContaining({
        size: '1792x1024',
      }),
      expect.any(Object),
    );
  });

  it('falls back to AI_IMAGE_SIZE when size is omitted', async () => {
    mockEnv({ AI_IMAGE_SIZE: '1024x1024' });
    mockSuccessfulImageResponse();

    const result = await generateAiImage(
      { prompt: 'draw a square robot' },
      'size-default',
    );

    expect(result.status).toBe('success');
    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://images.example.test/v1/images/generations',
      expect.objectContaining({
        size: '1024x1024',
      }),
      expect.any(Object),
    );
  });
});
