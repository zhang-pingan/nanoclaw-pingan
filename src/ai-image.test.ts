import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { aiImagesDir, axiosGetMock, axiosPostMock, readEnvFileMock } =
  vi.hoisted(() => ({
    aiImagesDir: '/tmp/icarus-ai-image-test',
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
  ATTACHMENTS_DIR: '/tmp/icarus-ai-image-attachments',
  DESKTOP_CAPTURES_DIR: '/tmp/icarus-ai-image-desktop-captures',
  AGENTS_DIR: '/tmp/icarus-ai-image-agents',
  WEB_UPLOADS_DIR: '/tmp/icarus-ai-image-uploads',
}));

vi.mock('./env.js', () => ({
  readEnvFile: readEnvFileMock,
}));

import { generateAiImage } from './ai-image.js';
import { createWorkflowPackExecutionFileScopeAuthority } from './workflow-packs/execution-file-scope-authority.js';
import { prepareWorkflowPackReadOnlyFileGate } from './workflow-packs/read-only-file-gate.js';

const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xdb]).toString('base64');
const temporaryRoots: string[] = [];

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
    fs.rmSync('/tmp/icarus-ai-image-agents', {
      recursive: true,
      force: true,
    });
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

  it('reads and writes through a read-only Pack shadow and drives the final file gate', async () => {
    mockEnv({ AI_IMAGE_SIZE: '1024x1024' });
    mockSuccessfulImageResponse();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ai-shadow-'));
    temporaryRoots.push(root);
    const agentSource = '/tmp/icarus-ai-image-agents/main';
    fs.mkdirSync(agentSource, { recursive: true });
    fs.mkdirSync(aiImagesDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentSource, 'input.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const gate = prepareWorkflowPackReadOnlyFileGate({
      parentDirectory: path.join(root, 'gates'),
      runKey: 'ai-run',
      scopes: [
        { scope: 'agent', sourcePath: agentSource },
        { scope: 'ai_images', sourcePath: aiImagesDir },
      ],
    });
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'ai-run',
      queryId: 'ai-query',
      agentFolder: 'main',
      isMain: true,
      hostActions: ['ai_image_generate_image'],
      mappings: [
        {
          scope: 'agent',
          sourcePath: agentSource,
          shadowHostPath: gate.mountPath('agent'),
        },
        {
          scope: 'ai_images',
          sourcePath: aiImagesDir,
          shadowHostPath: gate.mountPath('ai_images'),
        },
      ],
    });

    const result = await generateAiImage(
      {
        prompt: 'use the shadow input',
        image_paths: ['/workspace/agent/input.png'],
      },
      'shadow-output',
      'main',
      authority,
    );

    expect(result).toMatchObject({
      status: 'success',
      images: [
        {
          path: '/workspace/ai-images/shadow-output/image-01.jpg',
          relative_path: 'shadow-output/image-01.jpg',
        },
      ],
    });
    expect(axiosPostMock.mock.calls[0][1]).toMatchObject({
      image: [expect.stringMatching(/^data:image\/png;base64,/)],
    });
    expect(
      fs.existsSync(
        path.join(gate.mountPath('ai_images'), 'shadow-output', 'image-01.jpg'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(aiImagesDir, 'shadow-output'))).toBe(false);
    expect(gate.verify()).toEqual(expect.objectContaining({ clean: false }));

    fs.rmSync(path.join(gate.mountPath('ai_images'), 'shadow-output'), {
      recursive: true,
      force: true,
    });
    expect(gate.verify()).toEqual({ clean: true, changes: [] });
    authority.cleanup();
    gate.cleanup();
  });

  it('rejects unmapped Pack input scopes without falling back to Host globals', async () => {
    mockEnv({ AI_IMAGE_SIZE: '1024x1024' });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'icarus-ai-unmapped-'));
    temporaryRoots.push(root);
    const aiSource = path.join(root, 'ai-source');
    const aiShadow = path.join(root, 'ai-shadow');
    fs.mkdirSync(aiSource, { recursive: true });
    fs.mkdirSync(aiShadow, { recursive: true });
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'unmapped-run',
      queryId: 'unmapped-query',
      agentFolder: 'main',
      isMain: true,
      hostActions: ['ai_image_generate_image'],
      mappings: [
        {
          scope: 'ai_images',
          sourcePath: aiSource,
          shadowHostPath: aiShadow,
        },
      ],
    });

    const result = await generateAiImage(
      {
        prompt: 'do not read global uploads',
        image_paths: ['/workspace/uploads/input.png'],
      },
      'unmapped-output',
      'main',
      authority,
    );

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('outside the allowed scopes'),
    });
    expect(axiosPostMock).not.toHaveBeenCalled();
    authority.cleanup();
  });

  it('rejects a symlinked Pack output parent without writing outside the shadow', async () => {
    mockEnv({ AI_IMAGE_SIZE: '1024x1024' });
    mockSuccessfulImageResponse();
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'icarus-ai-output-symlink-'),
    );
    temporaryRoots.push(root);
    const aiSource = path.join(root, 'ai-source');
    const aiShadow = path.join(root, 'ai-shadow');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(aiSource, { recursive: true });
    fs.mkdirSync(aiShadow, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(aiShadow, 'escape-output'));
    const authority = createWorkflowPackExecutionFileScopeAuthority({
      parentDirectory: path.join(root, 'ipc'),
      runId: 'output-symlink-run',
      queryId: 'output-symlink-query',
      agentFolder: 'main',
      isMain: true,
      hostActions: ['ai_image_generate_image'],
      mappings: [
        {
          scope: 'ai_images',
          sourcePath: aiSource,
          shadowHostPath: aiShadow,
        },
      ],
    });

    const result = await generateAiImage(
      { prompt: 'must stay inside the shadow' },
      'escape-output',
      'main',
      authority,
    );

    expect(result).toMatchObject({
      status: 'error',
      error: expect.stringContaining('parent directory open failed'),
    });
    expect(fs.readdirSync(outside)).toEqual([]);
    authority.cleanup();
  });
});
