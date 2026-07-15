import { logger as coreLogger } from '../logger.js';
import { recordFeatureAuditEvent } from '../db.js';
import { FeatureApiRegistry, NavigationRegistry } from './registry.js';
import { FeatureManifest } from './manifest.js';
import { FeatureMigrationRegistry } from './migrations.js';
import { FeatureResourceRegistry } from './registry.js';

export interface FeatureModule {
  activate(context: FeatureContext): Promise<void> | void;
  deactivate?(context: FeatureContext): Promise<void> | void;
}

export interface FeatureLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

export interface EventRegistry {
  subscribe: (
    eventName: string,
    handler: (event: unknown) => void,
  ) => () => void;
}

export interface PermissionRegistry {
  requireHostAction: (action: string) => void;
  requireFileScope: (scope: string) => void;
  requireMcpServer: (server: string) => void;
}

export interface AuditService {
  record: (event: {
    action: string;
    status: 'success' | 'failure';
    payloadHash?: string;
    metadata?: Record<string, unknown>;
  }) => void;
}

export interface FeatureContext {
  featureId: string;
  featureRoot: string;
  manifest: FeatureManifest;
  logger: FeatureLogger;
  api: FeatureApiRegistry;
  nav: NavigationRegistry;
  containerResources: FeatureResourceRegistry;
  mcp: FeatureResourceRegistry;
  db: FeatureMigrationRegistry;
  events: EventRegistry;
  permissions: PermissionRegistry;
  audit: AuditService;
}

export function createFeatureLogger(featureId: string): FeatureLogger {
  return {
    info: (obj, msg) => coreLogger.info({ featureId, value: obj }, msg),
    warn: (obj, msg) => coreLogger.warn({ featureId, value: obj }, msg),
    error: (obj, msg) => coreLogger.error({ featureId, value: obj }, msg),
    debug: (obj, msg) => coreLogger.debug({ featureId, value: obj }, msg),
  };
}

type FeatureEventSubscription = {
  featureId: string;
  handler: (event: unknown) => void;
};

const featureEventSubscriptions = new Map<
  string,
  Set<FeatureEventSubscription>
>();

export function createPermissionRegistry(
  manifest: FeatureManifest,
): PermissionRegistry {
  const hostActions = new Set(manifest.permissions?.hostActions || []);
  const fileScopes = new Set(manifest.permissions?.fileScopes || []);
  const mcpServers = new Set(manifest.permissions?.mcpServers || []);
  return {
    requireHostAction: (action) => {
      if (!hostActions.has(action)) {
        throw new Error(
          `Feature ${manifest.id} did not declare host action permission "${action}"`,
        );
      }
    },
    requireFileScope: (scope) => {
      if (!fileScopes.has(scope)) {
        throw new Error(
          `Feature ${manifest.id} did not declare file scope permission "${scope}"`,
        );
      }
    },
    requireMcpServer: (server) => {
      if (!mcpServers.has(server)) {
        throw new Error(
          `Feature ${manifest.id} did not declare MCP server permission "${server}"`,
        );
      }
    },
  };
}

export function createEventRegistry(featureId: string): EventRegistry {
  return {
    subscribe: (eventName, handler) => {
      const subscriptions =
        featureEventSubscriptions.get(eventName) ||
        new Set<FeatureEventSubscription>();
      featureEventSubscriptions.set(eventName, subscriptions);
      const subscription = { featureId, handler };
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
        if (subscriptions.size === 0)
          featureEventSubscriptions.delete(eventName);
      };
    },
  };
}

export function publishFeatureEvent(eventName: string, event: unknown): void {
  const subscriptions = featureEventSubscriptions.get(eventName);
  if (!subscriptions) return;
  for (const subscription of [...subscriptions]) {
    try {
      subscription.handler(event);
    } catch (err) {
      coreLogger.error(
        { err, featureId: subscription.featureId, eventName },
        'Feature event subscription failed',
      );
    }
  }
}

export function clearFeatureEventSubscriptions(featureId: string): void {
  for (const [eventName, subscriptions] of featureEventSubscriptions) {
    for (const subscription of [...subscriptions]) {
      if (subscription.featureId === featureId) {
        subscriptions.delete(subscription);
      }
    }
    if (subscriptions.size === 0) featureEventSubscriptions.delete(eventName);
  }
}

export function createAuditService(featureId: string): AuditService {
  return {
    record: (event) => {
      recordFeatureAuditEvent({
        featureId,
        action: event.action,
        status: event.status,
        metadata: {
          ...(event.metadata || {}),
          ...(event.payloadHash ? { payloadHash: event.payloadHash } : {}),
        },
      });
    },
  };
}
