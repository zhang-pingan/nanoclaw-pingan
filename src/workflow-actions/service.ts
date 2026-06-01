import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import { WORKFLOW_CONTEXT_KEYS } from '../workflow-context.js';
import { registerWorkflowActionHandler } from './registry.js';
import { isRecord } from './utils.js';

export function findServiceTestToken(
  registry: unknown,
  serviceName: string,
): string {
  if (!isRecord(registry)) return '';

  const service = registry[serviceName];
  if (!isRecord(service)) return '';

  const topLevelToken = service.testToken;
  if (typeof topLevelToken === 'string' && topLevelToken.trim()) {
    return topLevelToken.trim();
  }

  const staging = service.staging;
  if (isRecord(staging)) {
    const stagingToken = staging.testToken;
    if (typeof stagingToken === 'string' && stagingToken.trim()) {
      return stagingToken.trim();
    }
  }

  return '';
}

function getServiceTestToken(serviceName: string): string {
  const servicesPath = path.join(GROUPS_DIR, 'global', 'services.json');
  if (!fs.existsSync(servicesPath)) return '';

  const parsed = JSON.parse(fs.readFileSync(servicesPath, 'utf-8')) as unknown;
  return findServiceTestToken(parsed, serviceName);
}

export function registerServiceWorkflowActions(): void {
  registerWorkflowActionHandler({
    name: 'service.test_token',
    description:
      'Load service testToken from groups/global/services.json into workflow context.',
    params: [
      {
        name: 'service',
        type: 'string',
        required: false,
        description:
          'Service name in groups/global/services.json. Defaults to workflow.service.',
      },
    ],
    run(input) {
      const configuredService =
        typeof input.params.service === 'string'
          ? input.params.service.trim()
          : '';
      const serviceName = configuredService || input.workflow.service;
      if (!serviceName) {
        return {
          status: 'success',
          contextPatch: { test_token_configured: false },
          output: { found: false, reason: 'service_missing' },
          summary: 'No service name available for testToken lookup',
        };
      }

      try {
        const token = getServiceTestToken(serviceName);
        if (!token) {
          return {
            status: 'success',
            contextPatch: { test_token_configured: false },
            output: { service: serviceName, found: false },
            summary: `No testToken configured for service ${serviceName}`,
          };
        }

        return {
          status: 'success',
          contextPatch: {
            [WORKFLOW_CONTEXT_KEYS.accessToken]: token,
            test_token_configured: true,
          },
          output: { service: serviceName, found: true },
          summary: `Loaded testToken for service ${serviceName}`,
        };
      } catch (err) {
        return {
          status: 'success',
          contextPatch: { test_token_configured: false },
          output: {
            service: serviceName,
            found: false,
            error: err instanceof Error ? err.message : String(err),
          },
          summary: `Failed to read testToken for service ${serviceName}`,
        };
      }
    },
  });
}
