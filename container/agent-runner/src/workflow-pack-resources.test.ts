import fs from 'fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveWorkflowPackRuntimeOptions,
  type ContainerWorkflowPackExecutionResources,
} from './workflow-pack-resources.js';

function authority(
  permissions: Partial<
    ContainerWorkflowPackExecutionResources['permissions']
  > = {},
): ContainerWorkflowPackExecutionResources {
  return {
    format: 'icarus.workflow-pack-run-resources/1',
    pack_id: 'example-pack',
    pack_version: '1.0.0',
    manifest_hash: `sha256:${'1'.repeat(64)}`,
    registry_snapshot_id: 'registry-snapshot:example-pack@1.0.0',
    registry_snapshot_hash: `sha256:${'2'.repeat(64)}`,
    execution_resource_files: {
      agents: [{}],
      skills: [{}],
      mcp: [{}],
      scripts: [{}],
      templates: [{}],
    },
    permissions: {
      host_actions: [],
      file_scopes: [],
      mcp_servers: ['pack-tools'],
      effect_ceiling: 'read_only',
      ...permissions,
    },
    root_path: '/workspace/workflow-pack-resources',
    resource_paths: {
      agents: '/workspace/workflow-pack-resources/agents',
      skills: '/workspace/workflow-pack-resources/skills',
      mcp: '/workspace/workflow-pack-resources/mcp',
      scripts: '/workspace/workflow-pack-resources/scripts',
      templates: '/workspace/workflow-pack-resources/templates',
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Workflow Pack container execution resources', () => {
  it('consumes pinned skills, agents, MCP, scripts, and templates read-only', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        mcpServers: {
          'pack-tools': {
            command: 'node',
            args: ['/workspace/workflow-pack-resources/scripts/mcp-server.mjs'],
          },
        },
      }),
    );
    const options = resolveWorkflowPackRuntimeOptions(authority());
    expect(options.settingSources).toEqual(['user']);
    expect(options.mcpServers).toEqual({
      'pack-tools': {
        command: 'node',
        args: ['/workspace/workflow-pack-resources/scripts/mcp-server.mjs'],
      },
    });
    expect(options.allowedTools).toContain('Skill');
    expect(options.allowedTools).toContain('mcp__pack-tools__*');
    expect(options.allowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'NotebookEdit']),
    );
    expect(options.permissionMode).toBe('acceptEdits');
    expect(options.systemPromptAppend).toContain(
      'may modify its mounted persistent file scopes temporarily',
    );
    expect(options.systemPromptAppend).toContain(
      'restore every persistent file to its initial state',
    );
    expect(options.environment).toMatchObject({
      ICARUS_WORKFLOW_PACK_SCRIPTS_DIR:
        '/workspace/workflow-pack-resources/scripts',
      ICARUS_WORKFLOW_PACK_TEMPLATES_DIR:
        '/workspace/workflow-pack-resources/templates',
    });
  });

  it('rejects undeclared MCP and exposes only declared Host actions', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        mcpServers: {
          undeclared: { command: 'node', args: [] },
        },
      }),
    );
    expect(() => resolveWorkflowPackRuntimeOptions(authority())).toThrow(
      'does not match pinned permissions',
    );

    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ mcpServers: {} }),
    );
    const options = resolveWorkflowPackRuntimeOptions(
      authority({
        mcp_servers: [],
        host_actions: ['request_human_input'],
      }),
    );
    expect(options.allowedTools).toContain('mcp__icarus__request_human_input');
    expect(options.allowedTools).not.toContain('mcp__icarus__*');
    expect(options.allowedTools).not.toContain('mcp__icarus__send_message');
  });

  it('keeps tool availability identical across Pack effect ceilings', () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ mcpServers: {} }),
    );
    const workspaceWrite = resolveWorkflowPackRuntimeOptions(
      authority({
        mcp_servers: [],
        effect_ceiling: 'workspace_write',
      }),
    );
    const externalWrite = resolveWorkflowPackRuntimeOptions(
      authority({
        mcp_servers: [],
        effect_ceiling: 'external_write',
      }),
    );
    const readOnly = resolveWorkflowPackRuntimeOptions(
      authority({ mcp_servers: [], effect_ceiling: 'read_only' }),
    );
    expect(workspaceWrite.allowedTools).toEqual(readOnly.allowedTools);
    expect(externalWrite.allowedTools).toEqual(readOnly.allowedTools);
    expect(workspaceWrite.permissionMode).toBe(readOnly.permissionMode);
    expect(externalWrite.permissionMode).toBe(readOnly.permissionMode);
    expect(workspaceWrite.systemPromptAppend).not.toContain(
      'restore every persistent file',
    );
    expect(externalWrite.systemPromptAppend).not.toContain(
      'restore every persistent file',
    );
  });
});
