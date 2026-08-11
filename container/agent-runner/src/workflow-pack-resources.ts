import fs from 'fs';
import path from 'path';

export type WorkflowPackEffectCeiling =
  | 'read_only'
  | 'workspace_write'
  | 'external_write';

export interface ContainerWorkflowPackExecutionResources {
  readonly format: 'icarus.workflow-pack-run-resources/1';
  readonly pack_id: string;
  readonly pack_version: string;
  readonly manifest_hash: string;
  readonly registry_snapshot_id: string;
  readonly registry_snapshot_hash: string;
  readonly execution_resource_files: Partial<
    Record<'agents' | 'skills' | 'mcp' | 'scripts' | 'templates', unknown[]>
  >;
  readonly permissions: {
    readonly host_actions: string[];
    readonly file_scopes: string[];
    readonly mcp_servers: string[];
    readonly effect_ceiling: WorkflowPackEffectCeiling;
  };
  readonly root_path: '/workspace/workflow-pack-resources';
  readonly resource_paths: Partial<
    Record<'agents' | 'skills' | 'mcp' | 'scripts' | 'templates', string>
  >;
}

interface McpStdioServer {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

export interface WorkflowPackRuntimeOptions {
  readonly allowedTools: string[];
  readonly settingSources: Array<'user'>;
  readonly mcpServers: Record<string, McpStdioServer>;
  readonly environment: Record<string, string>;
  readonly systemPromptAppend: string;
  readonly permissionMode: 'default' | 'acceptEdits';
}

const HASH = /^sha256:[0-9a-f]{64}$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const COMMANDS = new Set(['node', 'python3', 'bash', 'sh']);

function strings(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`Workflow Pack ${label} is invalid`);
  }
  return [...value].sort();
}

function parseMcpServers(
  resources: ContainerWorkflowPackExecutionResources,
  readTextFile: (pathname: string) => string,
): Record<string, McpStdioServer> {
  const declared = [...resources.permissions.mcp_servers].sort();
  const mcpPath = resources.resource_paths.mcp;
  if (!mcpPath) {
    if (declared.length > 0) {
      throw new Error(
        'Workflow Pack declares MCP servers without MCP resources',
      );
    }
    return {};
  }
  const configPath = path.join(mcpPath, 'mcp.json');
  const parsed = JSON.parse(readTextFile(configPath)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Workflow Pack MCP config is invalid');
  }
  const config = parsed as Record<string, unknown>;
  if (
    Object.keys(config).length !== 1 ||
    !config.mcpServers ||
    typeof config.mcpServers !== 'object' ||
    Array.isArray(config.mcpServers)
  ) {
    throw new Error('Workflow Pack MCP config must contain only mcpServers');
  }
  const rawServers = config.mcpServers as Record<string, unknown>;
  const names = Object.keys(rawServers).sort();
  if (JSON.stringify(names) !== JSON.stringify(declared)) {
    throw new Error(
      'Workflow Pack MCP config does not match pinned permissions',
    );
  }
  const servers: Record<string, McpStdioServer> = {};
  for (const name of names) {
    const value = rawServers[name];
    if (
      !SERVER_NAME.test(name) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      throw new Error(`Workflow Pack MCP server ${name} is invalid`);
    }
    const server = value as Record<string, unknown>;
    const keys = Object.keys(server);
    if (
      keys.some((key) => !['command', 'args', 'env'].includes(key)) ||
      typeof server.command !== 'string' ||
      !COMMANDS.has(server.command)
    ) {
      throw new Error(`Workflow Pack MCP server ${name} is invalid`);
    }
    const args =
      server.args === undefined
        ? []
        : (() => {
            if (
              !Array.isArray(server.args) ||
              server.args.some(
                (entry) => typeof entry !== 'string' || entry.length === 0,
              )
            ) {
              throw new Error(
                `Workflow Pack MCP server ${name} args are invalid`,
              );
            }
            return [...server.args] as string[];
          })();
    for (const argument of args) {
      if (
        path.posix.isAbsolute(argument) &&
        !argument.startsWith(`${resources.root_path}/scripts/`) &&
        !argument.startsWith(`${resources.root_path}/mcp/`)
      ) {
        throw new Error(
          `Workflow Pack MCP server ${name} escapes pinned resources`,
        );
      }
    }
    let env: Record<string, string> | undefined;
    if (server.env !== undefined) {
      if (
        !server.env ||
        typeof server.env !== 'object' ||
        Array.isArray(server.env)
      ) {
        throw new Error(`Workflow Pack MCP server ${name} env is invalid`);
      }
      env = {};
      for (const [key, entry] of Object.entries(server.env)) {
        if (typeof entry !== 'string') {
          throw new Error(`Workflow Pack MCP server ${name} env is invalid`);
        }
        env[key] = entry;
      }
    }
    servers[name] = { command: server.command, args, ...(env ? { env } : {}) };
  }
  return servers;
}

export function resolveWorkflowPackRuntimeOptions(
  value: ContainerWorkflowPackExecutionResources,
  dependencies: {
    readonly readTextFile?: (pathname: string) => string;
  } = {},
): WorkflowPackRuntimeOptions {
  if (
    value.format !== 'icarus.workflow-pack-run-resources/1' ||
    value.root_path !== '/workspace/workflow-pack-resources' ||
    !HASH.test(value.manifest_hash) ||
    !HASH.test(value.registry_snapshot_hash)
  ) {
    throw new Error('Workflow Pack Run resource authority is invalid');
  }
  const hostActions = strings(
    value.permissions.host_actions,
    'host action permissions',
  );
  strings(value.permissions.file_scopes, 'file scope permissions');
  const mcpServers = parseMcpServers(
    value,
    dependencies.readTextFile ??
      ((pathname) => fs.readFileSync(pathname, 'utf8')),
  );
  const effect = value.permissions.effect_ceiling;
  if (!['read_only', 'workspace_write', 'external_write'].includes(effect)) {
    throw new Error('Workflow Pack effect ceiling is invalid');
  }
  const allowedTools = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'WebSearch',
    'WebFetch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'TodoWrite',
    'NotebookEdit',
    ...(value.resource_paths.skills ? ['Skill'] : []),
  ];
  allowedTools.push(
    ...hostActions.map((action) => `mcp__icarus__${action}`),
    ...Object.keys(mcpServers).map((server) => `mcp__${server}__*`),
  );
  const environment: Record<string, string> = {
    ICARUS_WORKFLOW_PACK_ROOT: value.root_path,
    ICARUS_WORKFLOW_PACK_ID: value.pack_id,
    ICARUS_WORKFLOW_PACK_VERSION: value.pack_version,
  };
  for (const kind of ['scripts', 'templates'] as const) {
    const resourcePath = value.resource_paths[kind];
    if (resourcePath) {
      environment[`ICARUS_WORKFLOW_PACK_${kind.toUpperCase()}_DIR`] =
        resourcePath;
    }
  }
  const paths = Object.entries(value.resource_paths)
    .map(([kind, resourcePath]) => `${kind}: ${resourcePath}`)
    .join('\n');
  return {
    allowedTools,
    settingSources: ['user'],
    mcpServers,
    environment,
    systemPromptAppend: [
      `Workflow Pack ${value.pack_id}@${value.pack_version} resources are pinned for this Run.`,
      paths,
      'Use scripts and templates only through the pinned paths above.',
      effect === 'read_only'
        ? 'This read_only Workflow Pack Run may modify its mounted persistent file scopes temporarily while working, but before your final answer you must restore every persistent file to its initial state, including file contents, additions, deletions, symlink targets, and permissions. /workspace/run-once is Host-managed output space and does not need to be restored.'
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
    permissionMode: 'acceptEdits',
  };
}
