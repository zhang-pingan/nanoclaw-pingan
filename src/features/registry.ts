import http from 'http';
import path from 'path';

import {
  FeatureManifest,
  FeatureNavItem,
  FeatureResources,
} from './manifest.js';

export type FeatureHttpMethod =
  | 'GET'
  | 'POST'
  | 'PATCH'
  | 'PUT'
  | 'DELETE'
  | 'OPTIONS';

export interface FeatureRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type FeatureRouteHandler = (
  context: FeatureRouteContext,
) => Promise<void> | void;

export interface FeatureApiRegistry {
  register: (route: {
    method: FeatureHttpMethod;
    path: string;
    handler: FeatureRouteHandler;
  }) => void;
  registerPrefix: (route: {
    prefix: string;
    handler: FeatureRouteHandler;
  }) => void;
}

interface ExactRoute {
  featureId: string;
  method: FeatureHttpMethod;
  path: string;
  handler: FeatureRouteHandler;
}

interface PrefixRoute {
  featureId: string;
  prefix: string;
  handler: FeatureRouteHandler;
}

export class ApiRouteRegistry {
  private readonly exactRoutes = new Map<string, ExactRoute>();
  private readonly prefixRoutes: PrefixRoute[] = [];

  register(route: {
    featureId: string;
    method: FeatureHttpMethod;
    path: string;
    apiPrefix: string;
    handler: FeatureRouteHandler;
  }): void {
    const normalizedPath = normalizeApiPath(route.path);
    const normalizedPrefix = normalizeApiPath(route.apiPrefix);
    assertPathUnderPrefix(normalizedPath, normalizedPrefix, route.featureId);
    const key = `${route.method} ${normalizedPath}`;
    const existing = this.exactRoutes.get(key);
    if (existing) {
      throw new Error(
        `Feature API route conflict: ${key} already registered by ${existing.featureId}`,
      );
    }
    this.exactRoutes.set(key, {
      featureId: route.featureId,
      method: route.method,
      path: normalizedPath,
      handler: route.handler,
    });
  }

  registerPrefix(route: {
    featureId: string;
    prefix: string;
    apiPrefix: string;
    handler: FeatureRouteHandler;
  }): void {
    const normalizedPrefix = normalizeApiPath(route.prefix);
    const allowedPrefix = normalizeApiPath(route.apiPrefix);
    assertPathUnderPrefix(normalizedPrefix, allowedPrefix, route.featureId);
    for (const existing of this.prefixRoutes) {
      if (
        normalizedPrefix === existing.prefix ||
        normalizedPrefix.startsWith(existing.prefix + '/') ||
        existing.prefix.startsWith(normalizedPrefix + '/')
      ) {
        throw new Error(
          `Feature API prefix conflict: ${normalizedPrefix} overlaps ${existing.prefix} registered by ${existing.featureId}`,
        );
      }
    }
    this.prefixRoutes.push({
      featureId: route.featureId,
      prefix: normalizedPrefix,
      handler: route.handler,
    });
    this.prefixRoutes.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  async dispatch(context: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    url: URL;
  }): Promise<boolean> {
    const method = normalizeMethod(context.req.method);
    if (!method) return false;
    const pathname = normalizeApiPath(context.url.pathname);
    const exact = this.exactRoutes.get(`${method} ${pathname}`);
    if (exact) {
      await exact.handler({ ...context, params: {} });
      return true;
    }
    const prefix = this.prefixRoutes.find(
      (route) =>
        pathname === route.prefix || pathname.startsWith(route.prefix + '/'),
    );
    if (!prefix) return false;
    await prefix.handler({ ...context, params: {} });
    return true;
  }

  clear(): void {
    this.exactRoutes.clear();
    this.prefixRoutes.length = 0;
  }
}

export interface RegisteredFeatureResourceSource {
  featureId: string | null;
  kind: keyof FeatureResources;
  dir: string;
}

export class FeatureResourceRegistry {
  private readonly sources: RegisteredFeatureResourceSource[] = [];

  register(source: RegisteredFeatureResourceSource): void {
    const normalizedDir = path.resolve(source.dir);
    if (
      this.sources.some(
        (existing) =>
          existing.kind === source.kind &&
          existing.featureId === source.featureId &&
          existing.dir === normalizedDir,
      )
    ) {
      return;
    }
    this.sources.push({ ...source, dir: normalizedDir });
  }

  list(kind?: keyof FeatureResources): RegisteredFeatureResourceSource[] {
    return this.sources
      .filter((source) => !kind || source.kind === kind)
      .map((source) => ({ ...source }));
  }

  clear(): void {
    this.sources.length = 0;
  }
}

export interface RegisteredFeatureNavItem extends FeatureNavItem {
  featureId: string;
  rendererEntryUrl?: string;
}

export class NavigationRegistry {
  private readonly items = new Map<string, RegisteredFeatureNavItem>();

  register(item: RegisteredFeatureNavItem): void {
    const existing = this.items.get(item.key);
    if (existing) {
      throw new Error(
        `Feature navigation key conflict: ${item.key} already registered by ${existing.featureId}`,
      );
    }
    this.items.set(item.key, item);
  }

  list(): RegisteredFeatureNavItem[] {
    return [...this.items.values()].sort((a, b) => {
      const order = (a.order ?? 0) - (b.order ?? 0);
      return order || a.label.localeCompare(b.label);
    });
  }

  clear(): void {
    this.items.clear();
  }
}

export interface EnabledFeatureRuntimeInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  apiPrefix?: string;
  rendererEntryUrl?: string;
  nav: RegisteredFeatureNavItem[];
  manifest: FeatureManifest;
  root: string;
}

export const featureApiRoutes = new ApiRouteRegistry();
export const featureResources = new FeatureResourceRegistry();
export const featureNavigation = new NavigationRegistry();

export function createScopedApiRegistry(input: {
  featureId: string;
  apiPrefix: string;
  registry: ApiRouteRegistry;
}): FeatureApiRegistry {
  return {
    register: (route) =>
      input.registry.register({
        featureId: input.featureId,
        apiPrefix: input.apiPrefix,
        ...route,
      }),
    registerPrefix: (route) =>
      input.registry.registerPrefix({
        featureId: input.featureId,
        apiPrefix: input.apiPrefix,
        ...route,
      }),
  };
}

export function resetFeatureRegistries(): void {
  featureApiRoutes.clear();
  featureResources.clear();
  featureNavigation.clear();
}

function normalizeApiPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    throw new Error(`API path "${value}" must start with /`);
  }
  return trimmed.replace(/\/+$/, '') || '/';
}

function assertPathUnderPrefix(
  pathName: string,
  apiPrefix: string,
  featureId: string,
): void {
  if (pathName !== apiPrefix && !pathName.startsWith(apiPrefix + '/')) {
    throw new Error(
      `Feature ${featureId} API path "${pathName}" must stay under "${apiPrefix}"`,
    );
  }
}

function normalizeMethod(method: string | undefined): FeatureHttpMethod | null {
  const normalized = (method || '').toUpperCase();
  if (
    normalized === 'GET' ||
    normalized === 'POST' ||
    normalized === 'PATCH' ||
    normalized === 'PUT' ||
    normalized === 'DELETE' ||
    normalized === 'OPTIONS'
  ) {
    return normalized;
  }
  return null;
}
