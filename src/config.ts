import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Model/provider secrets are loaded only by the credential proxy
// (credential-proxy.ts). The internal API token below is host-only and is
// never passed into containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ICARUS_INTERNAL_API_HOST',
  'ICARUS_INTERNAL_API_PORT',
  'ICARUS_INTERNAL_API_TOKEN',
  'ICARUS_INTERNAL_API_MAX_BODY_BYTES',
  'ICARUS_INTERNAL_AGENT_MAX_INPUT_CHARS',
  'REPOS_DIR',
  'SSH_KEY_PATH',
  'ASSISTANT_INBOX_BROADCAST_TARGETS',
  'ONE_SHOT_AGENT_SLOT_TIMEOUT_MS',
  'ONE_SHOT_AGENT_MAX_QUEUE_LENGTH',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
export const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'icarus',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'icarus',
  'sender-allowlist.json',
);
const reposDir = process.env.REPOS_DIR || envConfig.REPOS_DIR;
export const REPOS_DIR = reposDir
  ? path.resolve(reposDir.replace(/^~/, HOME_DIR))
  : path.resolve(HOME_DIR, 'IdeaProjects');
const sshKeyPath = process.env.SSH_KEY_PATH || envConfig.SSH_KEY_PATH;
export const SSH_KEY_PATH = sshKeyPath
  ? path.resolve(sshKeyPath.replace(/^~/, HOME_DIR))
  : null;
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const CONTAINER_NODE_MODULES_DIR = path.join(
  HOME_DIR,
  '.cache',
  'icarus',
  'container-node-modules',
  'project',
);
export const ATTACHMENTS_DIR = path.resolve(DATA_DIR, 'attachments');
export const DESKTOP_CAPTURES_DIR = path.resolve(DATA_DIR, 'desktop-captures');
export const AI_IMAGES_DIR = path.resolve(DATA_DIR, 'ai-images');
export const WEB_UPLOADS_DIR = path.resolve(DATA_DIR, 'web-uploads');
export const KNOWLEDGE_DIR = path.resolve(PROJECT_ROOT, 'knowledge');
export const KNOWLEDGE_WIKI_DIR = path.join(KNOWLEDGE_DIR, 'wiki');

const DEFAULT_CONTAINER_IMAGE = 'icarus-agent:latest';

function containerImageRepositoryName(image: string): string {
  const withoutDigest = image.split('@')[0] || image;
  const lastPathSegment = withoutDigest.slice(
    withoutDigest.lastIndexOf('/') + 1,
  );
  return lastPathSegment.split(':')[0] || lastPathSegment;
}

function resolveContainerImage(): string {
  const image = process.env.CONTAINER_IMAGE || DEFAULT_CONTAINER_IMAGE;
  if (containerImageRepositoryName(image) !== 'icarus-agent') {
    throw new Error(
      'CONTAINER_IMAGE must use the icarus-agent image repository after the Icarus container rename: ' +
        image,
    );
  }
  return image;
}

export const CONTAINER_IMAGE = resolveContainerImage();
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const MYSQL_PROXY_PORT = parseInt(
  process.env.MYSQL_PROXY_PORT || '3003',
  10,
);
export const ICARUS_INTERNAL_API_HOST =
  process.env.ICARUS_INTERNAL_API_HOST ||
  envConfig.ICARUS_INTERNAL_API_HOST ||
  '127.0.0.1';
export const ICARUS_INTERNAL_API_PORT = Math.max(
  1,
  parseInt(
    process.env.ICARUS_INTERNAL_API_PORT ||
      envConfig.ICARUS_INTERNAL_API_PORT ||
      '3004',
    10,
  ) || 3004,
);
export const ICARUS_INTERNAL_API_TOKEN =
  process.env.ICARUS_INTERNAL_API_TOKEN ||
  envConfig.ICARUS_INTERNAL_API_TOKEN ||
  '';
export const ICARUS_INTERNAL_API_MAX_BODY_BYTES = Math.max(
  1024,
  parseInt(
    process.env.ICARUS_INTERNAL_API_MAX_BODY_BYTES ||
      envConfig.ICARUS_INTERNAL_API_MAX_BODY_BYTES ||
      '1048576',
    10,
  ) || 1048576,
);
export const ICARUS_INTERNAL_AGENT_MAX_INPUT_CHARS = Math.max(
  1000,
  parseInt(
    process.env.ICARUS_INTERNAL_AGENT_MAX_INPUT_CHARS ||
      envConfig.ICARUS_INTERNAL_AGENT_MAX_INPUT_CHARS ||
      '200000',
    10,
  ) || 200000,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1200000', 10); // 20min default — how long to keep container alive after last result (must be < CONTAINER_TIMEOUT to allow graceful exit)
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const ONE_SHOT_AGENT_SLOT_TIMEOUT_MS = Math.max(
  1,
  parseInt(
    process.env.ONE_SHOT_AGENT_SLOT_TIMEOUT_MS ||
      envConfig.ONE_SHOT_AGENT_SLOT_TIMEOUT_MS ||
      '120000',
    10,
  ) || 120000,
);
export const ONE_SHOT_AGENT_MAX_QUEUE_LENGTH = Math.max(
  1,
  parseInt(
    process.env.ONE_SHOT_AGENT_MAX_QUEUE_LENGTH ||
      envConfig.ONE_SHOT_AGENT_MAX_QUEUE_LENGTH ||
      '10',
    10,
  ) || 10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

function parseCsvList(value?: string): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const ASSISTANT_INBOX_BROADCAST_TARGETS = parseCsvList(
  process.env.ASSISTANT_INBOX_BROADCAST_TARGETS ||
    envConfig.ASSISTANT_INBOX_BROADCAST_TARGETS,
);
