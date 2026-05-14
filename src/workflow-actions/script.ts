import { runLocalHostScriptSync } from '../host-script-runner.js';
import { registerWorkflowActionHandler } from './registry.js';
import { asStringArray } from './utils.js';

export function registerScriptWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'script.run_local',
    description: 'Run an allowed local shell script under local/shell.',
    params: [
      {
        name: 'script_path',
        type: 'string',
        required: true,
        description: 'Script path under local/shell.',
        placeholder: 'restart.sh',
      },
      {
        name: 'args',
        type: 'string[]',
        required: false,
        description: 'Arguments passed to the script.',
        defaultValue: [],
      },
      {
        name: 'timeout_ms',
        type: 'number',
        required: false,
        description: 'Optional timeout in milliseconds.',
      },
      {
        name: 'max_output_bytes',
        type: 'number',
        required: false,
        description: 'Optional maximum captured output size in bytes.',
      },
    ],
    run(input) {
      const scriptPath = input.params.script_path;
      if (typeof scriptPath !== 'string' || !scriptPath.trim()) {
        return {
          status: 'failure',
          error: 'script_path must be a non-empty string',
        };
      }

      const args = asStringArray(input.params.args);
      const timeoutMs =
        typeof input.params.timeout_ms === 'number' &&
        Number.isFinite(input.params.timeout_ms)
          ? input.params.timeout_ms
          : undefined;
      const maxOutputBytes =
        typeof input.params.max_output_bytes === 'number' &&
        Number.isFinite(input.params.max_output_bytes)
          ? input.params.max_output_bytes
          : undefined;
      const result = runLocalHostScriptSync(scriptPath, args, {
        timeoutMs,
        maxOutputBytes,
      });

      return {
        status: result.status === 'success' ? 'success' : 'failure',
        output: {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          duration_ms: result.durationMs,
          script_path: result.scriptPath,
        },
        summary:
          result.status === 'success'
            ? `Script completed: ${scriptPath}`
            : `Script failed: ${scriptPath}`,
        error: result.error,
      };
    },
  });
}
