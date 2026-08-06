/**
 * Container Runner for Icarus
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import os from 'os';

import {
  AI_IMAGES_DIR,
  ATTACHMENTS_DIR,
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_NODE_MODULES_DIR,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  DESKTOP_CAPTURES_DIR,
  AGENTS_DIR,
  IDLE_TIMEOUT,
  MYSQL_PROXY_PORT,
  REPOS_DIR,
  SSH_KEY_PATH,
  TIMEZONE,
} from './config.js';
import { readEnvFile } from './env.js';
import { resolveAgentFolderPath, resolveAgentIpcPath } from './agent-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { ClassifiedFailure, classifyFailure } from './failure-taxonomy.js';
import {
  prepareFeatureResourceMountDir,
  prepareMergedMcpConfigDir,
  syncContainerAgents,
  syncContainerSkills,
} from './features/container-resources.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredAgent } from './types.js';

const HOME_DIR = process.env.HOME || os.homedir();
const DEFAULT_HOST_MAVEN_SETTINGS_PATH = path.join(
  HOME_DIR,
  '.m2',
  'settings.xml',
);
const DEFAULT_HOST_MAVEN_REPOSITORY_PATH = path.join(
  HOME_DIR,
  '.m2',
  'repository',
);
const CONTAINER_MAVEN_SETTINGS_PATH = '/home/node/.m2/settings.xml';
const CONTAINER_MAVEN_REPOSITORY_PATH = '/home/node/.m2/repository';
const MAVEN_SETTINGS_ENV_KEYS = [
  'MAVEN_SETTINGS_XML',
  'MAVEN_SETTINGS_PATH',
  'MVN_SETTINGS_XML',
];
const TRACE_PREVIEW_MAX_CHARS = Number.parseInt(
  process.env.TRACE_PREVIEW_MAX_CHARS || '2000',
  10,
);

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---ICARUS_OUTPUT_START---';
const OUTPUT_END_MARKER = '---ICARUS_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  system?: string;
  sessionId?: string;
  selectedModel?: string;
  runId?: string;
  queryId?: string;
  requireResult?: boolean;
  isolatedSession?: boolean;
  executionMode?: 'external_system_once';
  workspace?: {
    readonly hostPath: string;
    readonly readonly: boolean;
  };
  agentFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  isOneShot?: boolean;
  assistantName?: string;
  executionContext?: {
    delegationId?: string;
  };
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  final?: boolean;
  newSessionId?: string;
  error?: string;
  failure?: ClassifiedFailure;
  selectedModel?: string;
  runId?: string;
  queryId?: string;
  event?:
    | {
        type: string;
        name: string;
        status?: string;
        summary?: string;
        payload?: Record<string, unknown>;
      }
    | undefined;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

type TraceEventWriter = (event: NonNullable<ContainerOutput['event']>) => void;

function classifyContainerFailure(
  err: unknown,
  defaultSubtype: string,
  retryable: boolean,
): ClassifiedFailure {
  return classifyFailure(err, {
    module: 'container-runner',
    defaultType: 'container_runtime_error',
    defaultSubtype,
    defaultOrigin: 'container',
    retryable,
  });
}

function makeContainerErrorOutput(
  error: string,
  failure: ClassifiedFailure,
): ContainerOutput {
  return {
    status: 'error',
    result: null,
    error,
    failure,
  };
}

function makeMissingRequiredResultOutput(): ContainerOutput {
  const error = 'Container completed without required text result';
  return makeContainerErrorOutput(
    error,
    classifyFailure(new Error(error), {
      module: 'container-runner',
      action: 'wait_for_required_result',
      defaultType: 'model_output_invalid',
      defaultSubtype: 'agent_result_missing',
      defaultOrigin: 'model',
      retryable: true,
    }),
  );
}

function sanitizeTracePreview(
  value: string,
  maxChars = TRACE_PREVIEW_MAX_CHARS,
): string {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 2000;
  return value
    .slice(0, limit)
    .replace(/(authorization\s*:\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/(x-api-key\s*:\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/(password\s*=\s*)[^\s]+/gi, '$1[redacted]')
    .replace(/(token\s*=\s*)[^\s]+/gi, '$1[redacted]')
    .replace(
      /CLAUDE_CODE_OAUTH_TOKEN=[^\s]+/g,
      'CLAUDE_CODE_OAUTH_TOKEN=[redacted]',
    )
    .replace(/ANTHROPIC_API_KEY=[^\s]+/g, 'ANTHROPIC_API_KEY=[redacted]')
    .replace(/JENKINS_PASSWORD=[^\s]+/g, 'JENKINS_PASSWORD=[redacted]')
    .replace(
      /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,
      '[redacted private key]',
    );
}

function summarizeProcessOutputTail(value: string, maxLines = 4): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith(OUTPUT_START_MARKER))
    .filter((line) => !line.startsWith(OUTPUT_END_MARKER))
    .filter((line) => !line.startsWith('{'));
  return sanitizeTracePreview(lines.slice(-maxLines).join('\n'), 800);
}

function formatContainerExitError(params: {
  code: number | null;
  duration: number;
  logFile?: string;
  stderr: string;
  stdout: string;
  timedOut?: boolean;
}): string {
  const { code, duration, logFile, stderr, stdout, timedOut } = params;
  const codeText = code ?? 'unknown';
  const reason =
    code === 137
      ? 'process was killed with SIGKILL; possible causes include external stop, runtime cleanup, or host/container memory pressure'
      : timedOut
        ? 'container timed out'
        : 'container exited non-zero';
  const tail =
    summarizeProcessOutputTail(stderr) || summarizeProcessOutputTail(stdout);
  return [
    `Container exited with code ${codeText} after ${duration}ms (${reason})`,
    logFile ? `Log: ${logFile}` : '',
    tail ? `Last output:\n${tail}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function summarizeMounts(mounts: VolumeMount[]): string[] {
  return mounts.map(
    (mount) => `${mount.containerPath}${mount.readonly ? ' (ro)' : ''}`,
  );
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return HOME_DIR;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(HOME_DIR, trimmed.slice(2));
  }
  return trimmed;
}

function resolveHostPath(value: string, baseDir = process.cwd()): string {
  const expanded = expandHomePath(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
}

function expandMavenPathExpressions(value: string): string {
  return value
    .replace(/\$\{user\.home\}/g, HOME_DIR)
    .replace(/\$\{env\.HOME\}/g, HOME_DIR)
    .replace(/\$\{env\.([^}]+)\}/g, (match, name: string) => {
      return process.env[name] || match;
    });
}

function statIsFile(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    return typeof stat.isFile === 'function'
      ? stat.isFile()
      : !stat.isDirectory();
  } catch {
    return false;
  }
}

function decodeXmlText(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, body: string) => {
      const lower = body.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      if (lower.startsWith('#x')) {
        const codePoint = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (lower.startsWith('#')) {
        const codePoint = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return entity;
    },
  );
}

function resolveMavenSettingsPath(): {
  path: string;
  source: 'configured' | 'default';
} {
  const env = readEnvFile(MAVEN_SETTINGS_ENV_KEYS);
  const configured =
    process.env.MAVEN_SETTINGS_XML ||
    process.env.MAVEN_SETTINGS_PATH ||
    process.env.MVN_SETTINGS_XML ||
    env.MAVEN_SETTINGS_XML ||
    env.MAVEN_SETTINGS_PATH ||
    env.MVN_SETTINGS_XML;

  if (configured) {
    return {
      path: resolveHostPath(configured),
      source: 'configured',
    };
  }

  return {
    path: DEFAULT_HOST_MAVEN_SETTINGS_PATH,
    source: 'default',
  };
}

function readMavenLocalRepository(settingsPath: string): string | null {
  if (!statIsFile(settingsPath)) return null;

  let content: string;
  try {
    content = fs.readFileSync(settingsPath, 'utf-8');
  } catch (err) {
    logger.warn(
      { err, settingsPath },
      'Failed to read Maven settings.xml for localRepository',
    );
    return null;
  }

  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');
  const match = withoutComments.match(
    /<(?:[A-Za-z_][\w.-]*:)?localRepository\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?localRepository>/i,
  );
  const localRepository = decodeXmlText(match?.[1]?.trim() || '');
  if (!localRepository) return null;

  return resolveHostPath(
    expandMavenPathExpressions(localRepository),
    path.dirname(settingsPath),
  );
}

function addMavenMounts(mounts: VolumeMount[]): void {
  const settings = resolveMavenSettingsPath();
  const settingsExists = statIsFile(settings.path);

  if (settingsExists) {
    mounts.push({
      hostPath: settings.path,
      containerPath: CONTAINER_MAVEN_SETTINGS_PATH,
      readonly: true,
    });
  } else if (settings.source === 'configured') {
    logger.warn(
      { settingsPath: settings.path },
      'Configured Maven settings.xml does not exist; skipping settings mount',
    );
  } else {
    logger.debug(
      { settingsPath: settings.path },
      'Default Maven settings.xml not found; skipping settings mount',
    );
  }

  const localRepository = settingsExists
    ? readMavenLocalRepository(settings.path)
    : null;
  const repositoryPath = localRepository || DEFAULT_HOST_MAVEN_REPOSITORY_PATH;

  try {
    fs.mkdirSync(repositoryPath, { recursive: true });
    mounts.push({
      hostPath: repositoryPath,
      containerPath: CONTAINER_MAVEN_REPOSITORY_PATH,
      readonly: false,
    });
  } catch (err) {
    logger.warn(
      { err, repositoryPath },
      'Failed to prepare Maven repository mount',
    );
  }
}

function buildMavenOpts(): string {
  const env = readEnvFile(['MAVEN_OPTS']);
  const configured = process.env.MAVEN_OPTS || env.MAVEN_OPTS || '';
  return `${configured} -Dmaven.repo.local=${CONTAINER_MAVEN_REPOSITORY_PATH}`.trim();
}

function emitTraceEvent(
  emit: TraceEventWriter | undefined,
  event: NonNullable<ContainerOutput['event']>,
): void {
  if (!emit) return;
  try {
    emit(event);
  } catch (err) {
    logger.warn(
      { err, eventName: event.name },
      'Container trace event skipped',
    );
  }
}

function buildVolumeMounts(
  agent: RegisteredAgent,
  isMain: boolean,
  opts: {
    externalSystemOnce?: boolean;
    workspace?: ContainerInput['workspace'];
  } = {},
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const agentDir = resolveAgentFolderPath(agent.folder);
  const isExternalSystemOnce = opts.externalSystemOnce === true;

  const explicitProjectWorkspace = isExternalSystemOnce
    ? opts.workspace
    : undefined;
  if (explicitProjectWorkspace) {
    mounts.push({
      hostPath: explicitProjectWorkspace.hostPath,
      containerPath: '/workspace/project',
      readonly: explicitProjectWorkspace.readonly,
    });
    const envFile = path.join(explicitProjectWorkspace.hostPath, '.env');
    if (fs.existsSync(envFile))
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
  } else if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (agent folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    fs.mkdirSync(CONTAINER_NODE_MODULES_DIR, { recursive: true });
    mounts.push({
      hostPath: CONTAINER_NODE_MODULES_DIR,
      containerPath: '/workspace/project/node_modules',
      readonly: false,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }
  }

  mounts.push({
    hostPath: agentDir,
    containerPath: '/workspace/agent',
    readonly: false,
  });
  if (!isMain) {
    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(AGENTS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-agent Claude sessions directory (isolated from other agents)
  // Each agent gets their own .claude/ to prevent cross-agent session access
  const agentSessionsDir = isExternalSystemOnce
    ? path.join(DATA_DIR, 'run-once-sessions', agent.folder, '.claude')
    : path.join(DATA_DIR, 'sessions', agent.folder, '.claude');
  fs.mkdirSync(agentSessionsDir, { recursive: true });
  const settingsFile = path.join(agentSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: isExternalSystemOnce
              ? '0'
              : '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: isExternalSystemOnce ? '1' : '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync enabled core/feature skills into each agent's .claude/skills/.
  const skillsDst = path.join(agentSessionsDir, 'skills');
  if (!isExternalSystemOnce) {
    syncContainerSkills({ agentFolder: agent.folder, skillsDst });
    syncContainerAgents({
      agentFolder: agent.folder,
      agentsDst: path.join(agentSessionsDir, 'agents'),
    });
  }
  mounts.push({
    hostPath: agentSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  if (isExternalSystemOnce) {
    const runOnceWorkspaceDir = path.join(
      DATA_DIR,
      'run-once-workspaces',
      agent.folder,
    );
    fs.mkdirSync(runOnceWorkspaceDir, { recursive: true });
    mounts.push({
      hostPath: runOnceWorkspaceDir,
      containerPath: '/workspace/run-once',
      readonly: false,
    });
  }

  // Per-agent IPC namespace: each agent gets its own IPC directory
  // This prevents cross-agent privilege escalation via IPC
  const agentIpcDir = resolveAgentIpcPath(agent.folder);
  fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: agentIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  const mcpConfigDir = prepareMergedMcpConfigDir(agent.folder);
  if (mcpConfigDir && fs.existsSync(mcpConfigDir)) {
    mounts.push({
      hostPath: mcpConfigDir,
      containerPath: '/workspace/mcp',
      readonly: true,
    });
  }

  const featureResourceDir = !isExternalSystemOnce
    ? prepareFeatureResourceMountDir(agent.folder)
    : null;
  if (featureResourceDir && fs.existsSync(featureResourceDir)) {
    mounts.push({
      hostPath: featureResourceDir,
      containerPath: '/workspace/feature-resources',
      readonly: true,
    });
  }

  // Shared attachments directory: inbound channel files are stored here.
  // Mounted for all agents so agents can reference files with stable paths.
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  mounts.push({
    hostPath: ATTACHMENTS_DIR,
    containerPath: '/workspace/attachments',
    readonly: false,
  });

  // Shared desktop capture directory: screenshots captured through the host
  // desktop client are stored here, separate from inbound attachments.
  fs.mkdirSync(DESKTOP_CAPTURES_DIR, { recursive: true });
  mounts.push({
    hostPath: DESKTOP_CAPTURES_DIR,
    containerPath: '/workspace/desktop-captures',
    readonly: false,
  });

  // Shared AI image directory: generated and edited images are stored here.
  fs.mkdirSync(AI_IMAGES_DIR, { recursive: true });
  mounts.push({
    hostPath: AI_IMAGES_DIR,
    containerPath: '/workspace/ai-images',
    readonly: false,
  });

  // Mount agent-runner source directly because entrypoint compiles /app/src.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    mounts.push({
      hostPath: agentRunnerSrc,
      containerPath: '/app/src',
      readonly: true,
    });
  }

  // Shared uploads directory: web client uploads are stored here.
  // Mounted at /workspace/uploads for all agents so agents can access uploaded files.
  const uploadsDir = path.join(DATA_DIR, 'web-uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  mounts.push({
    hostPath: uploadsDir,
    containerPath: '/workspace/uploads',
    readonly: false,
  });

  // Per-agent custom tools directory (plugin mechanism).
  // Agents can add .ts tool files here; reload_tools restarts the container
  // to pick them up.
  const customToolsDir = path.join(agentDir, 'custom-tools');
  fs.mkdirSync(customToolsDir, { recursive: true });
  mounts.push({
    hostPath: customToolsDir,
    containerPath: '/app/custom-tools',
    readonly: false,
  });

  // Per-agent service repo mounts: only mount repos this agent needs
  const agentServices = agent.containerConfig?.services as string[] | undefined;
  if (agentServices && agentServices.length > 0) {
    const servicesJsonPath = path.join(AGENTS_DIR, 'global', 'services.json');
    if (fs.existsSync(servicesJsonPath)) {
      try {
        const allServices = JSON.parse(
          fs.readFileSync(servicesJsonPath, 'utf-8'),
        );
        const isWildcard = agentServices.includes('*');
        const serviceNames = isWildcard
          ? Object.keys(allServices)
          : agentServices;
        for (const svcName of serviceNames) {
          const svc = allServices[svcName];
          if (!svc?.repo_path) continue;
          const hostPath = path.join(REPOS_DIR, svc.repo_path);
          if (fs.existsSync(hostPath)) {
            mounts.push({
              hostPath,
              containerPath: `/workspace/repos/${svc.repo_path}`,
              readonly: false,
            });
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to parse services.json');
      }
    }
  }

  // SSH keys: needed for git push and SSH to remote servers (including macOS control skill).
  // Build a synthetic .ssh directory per agent, combining git keys from
  // ~/.ssh with a dedicated devops key (SSH_KEY_PATH). This avoids the
  // Docker limitation where file mounts cannot overlay read-only dir mounts.
  if ((agentServices && agentServices.length > 0) || isMain) {
    const hostSshDir = path.join(HOME_DIR, '.ssh');
    const synthSshDir = path.join(DATA_DIR, 'sessions', agent.folder, 'ssh');
    fs.mkdirSync(synthSshDir, { recursive: true });

    // Copy key files and known_hosts from ~/.ssh
    if (fs.existsSync(hostSshDir)) {
      const filesToCopy = [
        'id_rsa',
        'id_rsa.pub',
        'id_ed25519',
        'id_ed25519.pub',
        'known_hosts',
      ];
      for (const file of filesToCopy) {
        const src = path.join(hostSshDir, file);
        const dst = path.join(synthSshDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
          // Preserve private key permissions
          if (!file.endsWith('.pub') && file !== 'known_hosts') {
            fs.chmodSync(dst, 0o600);
          }
        }
      }
    }

    // Copy devops key and generate SSH config that prioritizes it
    if (SSH_KEY_PATH && fs.existsSync(SSH_KEY_PATH)) {
      const devopsKeyDst = path.join(synthSshDir, 'id_devops');
      fs.copyFileSync(SSH_KEY_PATH, devopsKeyDst);
      fs.chmodSync(devopsKeyDst, 0o600);

      fs.writeFileSync(
        path.join(synthSshDir, 'config'),
        [
          'Host *',
          '    IdentityFile ~/.ssh/id_devops',
          '    IdentityFile ~/.ssh/id_rsa',
          '    IdentityFile ~/.ssh/id_ed25519',
          '    StrictHostKeyChecking no',
          '    UserKnownHostsFile /dev/null',
          '    HostkeyAlgorithms +ssh-rsa,ssh-dss',
          '    PubkeyAcceptedAlgorithms +ssh-rsa',
          '',
        ].join('\n'),
      );
      fs.chmodSync(path.join(synthSshDir, 'config'), 0o644);
    }

    mounts.push({
      hostPath: synthSshDir,
      containerPath: '/home/node/.ssh',
      readonly: true,
    });
  }

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (agent.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      agent.containerConfig.additionalMounts,
      agent.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  addMavenMounts(mounts);

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Jenkins credentials for deployment operations
  const devopsSecrets = readEnvFile([
    'JENKINS_URL',
    'JENKINS_USER',
    'JENKINS_PASSWORD',
  ]);
  if (devopsSecrets.JENKINS_URL) {
    args.push('-e', `JENKINS_URL=${devopsSecrets.JENKINS_URL}`);
    args.push('-e', `JENKINS_USER=${devopsSecrets.JENKINS_USER || ''}`);
    args.push('-e', `JENKINS_PASSWORD=${devopsSecrets.JENKINS_PASSWORD || ''}`);
  }

  // MySQL proxy URL for database queries
  args.push(
    '-e',
    `MYSQL_PROXY_URL=http://${CONTAINER_HOST_GATEWAY}:${MYSQL_PROXY_PORT}`,
  );

  // Keep Maven cache stable at the container default path even when the
  // mounted settings.xml contains a host-specific <localRepository>.
  args.push('-e', `MAVEN_OPTS=${buildMavenOpts()}`);

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  agent: RegisteredAgent,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const agentDir = resolveAgentFolderPath(agent.folder);
  fs.mkdirSync(agentDir, { recursive: true });

  const mounts = buildVolumeMounts(agent, input.isMain, {
    externalSystemOnce: input.executionMode === 'external_system_once',
    workspace: input.workspace,
  });
  const safeName = agent.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `icarus-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);
  const emitContainerTraceEvent: TraceEventWriter | undefined =
    onOutput && input.queryId
      ? (event) =>
          onOutput({
            status: 'success',
            result: null,
            newSessionId: undefined,
            selectedModel: input.selectedModel,
            runId: input.runId,
            queryId: input.queryId,
            event,
          }).catch((err) => {
            logger.warn(
              { err, eventName: event.name },
              'Container trace event failed',
            );
          })
      : undefined;

  logger.debug(
    {
      agent: agent.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      agent: agent.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(agentDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  emitTraceEvent(emitContainerTraceEvent, {
    type: 'container',
    name: 'container_args_built',
    status: 'success',
    summary: `Container args built for ${containerName}`,
    payload: {
      category: 'container',
      severity: 'info',
      visibility: 'detail',
      containerName,
      runtime: CONTAINER_RUNTIME_BIN,
      image: CONTAINER_IMAGE,
      mountCount: mounts.length,
      mountSummary: summarizeMounts(mounts),
      envKeys: containerArgs
        .flatMap((arg, index) =>
          arg === '-e' && containerArgs[index + 1]
            ? [String(containerArgs[index + 1]).split('=')[0]]
            : [],
        )
        .filter(Boolean),
    },
  });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);
    emitTraceEvent(emitContainerTraceEvent, {
      type: 'container',
      name: 'container_spawned',
      status: 'running',
      summary: `Container spawned: ${containerName}`,
      payload: {
        category: 'container',
        severity: 'info',
        visibility: 'summary',
        containerName,
        runtime: CONTAINER_RUNTIME_BIN,
        image: CONTAINER_IMAGE,
        timeoutMs: agent.containerConfig?.timeout || CONTAINER_TIMEOUT,
      },
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    const { workspace: _workspace, ...containerInput } = input;
    container.stdin.write(
      JSON.stringify({
        ...containerInput,
        projectWorkspaceMounted: Boolean(input.workspace),
      }),
    );
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let selectedModel: string | undefined;
    let streamingParseFailure: ClassifiedFailure | null = null;
    let streamingParseError: string | null = null;
    let hadValidStreamingOutput = false;
    let hadTextResult = false;
    let lastErrorOutput: ContainerOutput | null = null;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { agent: agent.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            emitTraceEvent(emitContainerTraceEvent, {
              type: 'container',
              name: 'container_stdout_marker_seen',
              status: parsed.status === 'error' ? 'error' : 'success',
              summary: parsed.event
                ? `Output marker event: ${parsed.event.name}`
                : parsed.result
                  ? 'Output marker contained agent result'
                  : 'Output marker parsed',
              payload: {
                category: 'container',
                severity: parsed.status === 'error' ? 'error' : 'debug',
                visibility: 'debug',
                containerName,
                markerStatus: parsed.status,
                hasResult:
                  typeof parsed.result === 'string' && parsed.result.length > 0,
                eventName: parsed.event?.name,
                resultLength:
                  typeof parsed.result === 'string' ? parsed.result.length : 0,
              },
            });
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            if (parsed.selectedModel) {
              selectedModel = parsed.selectedModel;
            }
            if (
              parsed.status === 'success' &&
              typeof parsed.result === 'string' &&
              parsed.result.trim()
            ) {
              hadTextResult = true;
            }
            if (parsed.status === 'error') {
              lastErrorOutput = parsed;
            }
            hadStreamingOutput = true;
            hadValidStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            // Catch errors to prevent a single failed callback from breaking
            // the entire chain (which would leave runContainerAgent hanging).
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { agent: agent.name, err },
                  'Error in onOutput callback',
                );
              });
          } catch (err) {
            streamingParseFailure = classifyFailure(err, {
              module: 'container-runner',
              action: 'parse_streaming_output_marker',
              defaultType: 'tool_contract_error',
              defaultSubtype: 'container_output_parse_failed',
              defaultOrigin: 'container',
              retryable: false,
            });
            streamingParseError = `Failed to parse streamed output chunk: ${
              err instanceof Error ? err.message : String(err)
            }`;
            logger.warn(
              { agent: agent.name, error: err },
              'Failed to parse streamed output chunk',
            );
            resetTimeout();
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: agent.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { agent: agent.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = agent.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { agent: agent.name, containerName },
        'Container timeout, stopping gracefully',
      );
      emitTraceEvent(emitContainerTraceEvent, {
        type: 'container',
        name: 'container_timeout',
        status: 'error',
        summary: `Container timed out after ${timeoutMs}ms`,
        payload: {
          category: 'container',
          severity: 'error',
          visibility: 'summary',
          containerName,
          runtime: CONTAINER_RUNTIME_BIN,
          image: CONTAINER_IMAGE,
          timeoutMs,
          configuredTimeoutMs: configTimeout,
          terminatedReason: 'timeout',
          hadStreamingOutput,
        },
      });
      emitTraceEvent(emitContainerTraceEvent, {
        type: 'container',
        name: 'container_stop_requested',
        status: 'running',
        summary: `Stopping timed out container ${containerName}`,
        payload: {
          category: 'container',
          severity: 'warn',
          visibility: 'summary',
          containerName,
          reason: 'timeout',
        },
      });
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { agent: agent.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
        emitTraceEvent(emitContainerTraceEvent, {
          type: 'container',
          name: 'container_stop_completed',
          status: err ? 'error' : 'success',
          summary: err
            ? `Graceful stop failed for ${containerName}`
            : `Stop completed for ${containerName}`,
          payload: {
            category: 'container',
            severity: err ? 'error' : 'info',
            visibility: 'summary',
            containerName,
            reason: 'timeout',
            error: err ? sanitizeTracePreview(err.message) : undefined,
          },
        });
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;
      emitTraceEvent(emitContainerTraceEvent, {
        type: 'container',
        name: timedOut ? 'container_timeout' : 'container_exited',
        status: timedOut || code !== 0 ? 'error' : 'success',
        summary: timedOut
          ? `Container timed out: ${containerName}`
          : `Container exited with code ${code ?? 'unknown'}`,
        payload: {
          category: 'container',
          severity: timedOut || code !== 0 ? 'error' : 'info',
          visibility: 'summary',
          containerName,
          runtime: CONTAINER_RUNTIME_BIN,
          image: CONTAINER_IMAGE,
          exitCode: code,
          durationMs: duration,
          timeoutMs,
          terminatedReason: timedOut
            ? 'timeout'
            : code === 0
              ? 'completed'
              : 'nonzero_exit',
          stdoutPreview: sanitizeTracePreview(
            stdout.slice(-TRACE_PREVIEW_MAX_CHARS),
          ),
          stderrPreview: sanitizeTracePreview(
            stderr.slice(-TRACE_PREVIEW_MAX_CHARS),
          ),
          stdoutTruncated,
          stderrTruncated,
          hadStreamingOutput,
        },
      });

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Agent: ${agent.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadValidStreamingOutput) {
          if (lastErrorOutput && !hadTextResult) {
            logger.warn(
              { agent: agent.name, containerName, duration, code },
              'Container timed out after streamed error output',
            );
            outputChain.then(() => {
              resolve(lastErrorOutput!);
            });
            return;
          }
          if (input.requireResult && !hadTextResult) {
            logger.warn(
              { agent: agent.name, containerName, duration, code },
              'Container timed out without required text result',
            );
            outputChain.then(() => {
              resolve(makeMissingRequiredResultOutput());
            });
            return;
          }
          logger.info(
            { agent: agent.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
              selectedModel,
            });
          });
          return;
        }

        if (streamingParseFailure) {
          const error =
            streamingParseError || 'Failed to parse streamed output chunk';
          logger.error(
            { agent: agent.name, containerName, duration, code },
            'Container timed out after invalid streamed output',
          );
          outputChain.then(() => {
            resolve(makeContainerErrorOutput(error, streamingParseFailure!));
          });
          return;
        }

        logger.error(
          { agent: agent.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
          failure: classifyFailure(
            new Error(`Container timed out after ${configTimeout}ms`),
            {
              module: 'container-runner',
              action: 'wait_for_container_output',
              defaultType: 'timeout',
              defaultSubtype: 'container_timeout_no_output',
              defaultOrigin: 'container',
              retryable: true,
            },
          ),
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Agent: ${agent.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          sanitizeTracePreview(
            containerArgs.join(' '),
            Number.MAX_SAFE_INTEGER,
          ),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.isolatedSession ? 'isolated' : input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (streamingParseFailure && !hadValidStreamingOutput) {
        const failure = streamingParseFailure;
        const error =
          streamingParseError || 'Failed to parse streamed output chunk';
        outputChain.then(() => {
          resolve(makeContainerErrorOutput(error, failure));
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          {
            agent: agent.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        // Wait for outputChain to settle (like success path) to avoid
        // race where wrappedOnOutput writes a stale session ID after
        // isSessionInvalid clears it.
        outputChain.then(() => {
          const error = formatContainerExitError({
            code,
            duration,
            logFile,
            stderr,
            stdout,
          });
          resolve(
            makeContainerErrorOutput(
              error,
              classifyContainerFailure(
                new Error(error),
                code === 137
                  ? 'container_killed_137'
                  : 'container_exit_nonzero',
                true,
              ),
            ),
          );
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          if (lastErrorOutput && !hadTextResult) {
            logger.warn(
              { agent: agent.name, duration, newSessionId },
              'Container completed after streamed error output',
            );
            resolve(lastErrorOutput!);
            return;
          }
          if (input.requireResult && !hadTextResult) {
            logger.warn(
              { agent: agent.name, duration, newSessionId },
              'Container completed without required text result',
            );
            resolve(makeMissingRequiredResultOutput());
            return;
          }
          logger.info(
            { agent: agent.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            final: true,
            newSessionId,
            selectedModel,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        emitTraceEvent(emitContainerTraceEvent, {
          type: 'container',
          name: 'container_output_parsed',
          status: output.status === 'error' ? 'error' : 'success',
          summary: `Container output parsed: ${output.status}`,
          payload: {
            category: 'container',
            severity: output.status === 'error' ? 'error' : 'info',
            visibility: 'summary',
            containerName,
            status: output.status,
            hasResult: Boolean(output.result),
            resultLength:
              typeof output.result === 'string' ? output.result.length : 0,
            error: output.error
              ? sanitizeTracePreview(output.error)
              : undefined,
          },
        });

        logger.info(
          {
            agent: agent.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        emitTraceEvent(emitContainerTraceEvent, {
          type: 'container',
          name: 'container_output_parsed',
          status: 'error',
          summary: 'Failed to parse container output',
          payload: {
            category: 'container',
            severity: 'error',
            visibility: 'summary',
            containerName,
            error: err instanceof Error ? err.message : String(err),
            stdoutPreview: sanitizeTracePreview(
              stdout.slice(-TRACE_PREVIEW_MAX_CHARS),
            ),
            stderrPreview: sanitizeTracePreview(
              stderr.slice(-TRACE_PREVIEW_MAX_CHARS),
            ),
          },
        });
        logger.error(
          {
            agent: agent.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        const error = `Failed to parse container output: ${
          err instanceof Error ? err.message : String(err)
        }`;
        resolve(
          makeContainerErrorOutput(
            error,
            classifyFailure(err, {
              module: 'container-runner',
              action: 'parse_container_output',
              defaultType: 'tool_contract_error',
              defaultSubtype: 'container_output_parse_failed',
              defaultOrigin: 'container',
              retryable: false,
            }),
          ),
        );
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      emitTraceEvent(emitContainerTraceEvent, {
        type: 'container',
        name: 'container_exited',
        status: 'error',
        summary: `Container spawn error: ${err.message}`,
        payload: {
          category: 'container',
          severity: 'error',
          visibility: 'summary',
          containerName,
          runtime: CONTAINER_RUNTIME_BIN,
          image: CONTAINER_IMAGE,
          terminatedReason: 'spawn_error',
          error: sanitizeTracePreview(err.message),
        },
      });
      logger.error(
        { agent: agent.name, containerName, error: err },
        'Container spawn error',
      );
      resolve(
        makeContainerErrorOutput(
          `Container spawn error: ${err.message}`,
          classifyContainerFailure(err, 'container_spawn_error', true),
        ),
      );
    });
  });
}

export function writeTasksSnapshot(
  agentFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    agentFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the agent's IPC directory
  const agentIpcDir = resolveAgentIpcPath(agentFolder);
  fs.mkdirSync(agentIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.agentFolder === agentFolder);

  const tasksFile = path.join(agentIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableAgent {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
  description?: string | null;
}

/**
 * Write available agents snapshot for the container to read.
 * Only main agent can see all available agents (for activation).
 * Non-main agents only see their own registration status.
 */
export function writeAgentsSnapshot(
  agentFolder: string,
  isMain: boolean,
  agents: AvailableAgent[],
  registeredJids: Set<string>,
): void {
  const agentIpcDir = resolveAgentIpcPath(agentFolder);
  fs.mkdirSync(agentIpcDir, { recursive: true });

  // Main sees all agents; others see nothing (they can't activate agents)
  const visibleAgents = isMain ? agents : [];

  const agentsFile = path.join(agentIpcDir, 'available_agents.json');
  fs.writeFileSync(
    agentsFile,
    JSON.stringify(
      {
        agents: visibleAgents,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
