import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, REPOS_DIR } from '../config.js';
import type {
  IosClientConfig,
  ResolvedIosServiceConfig,
  ServiceConfig,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isSafeRelativeRepoPath(repoPath: string): boolean {
  const normalized = repoPath.trim();
  return (
    normalized.length > 0 &&
    !normalized.includes('\0') &&
    !normalized.includes('\\') &&
    !path.isAbsolute(normalized) &&
    normalized.split('/').every((segment) => {
      return segment.length > 0 && segment !== '.' && segment !== '..';
    })
  );
}

function resolveRepoUnderReposDir(repoPath: string): string {
  if (!isSafeRelativeRepoPath(repoPath)) {
    throw new Error(
      'clients.ios.repo_path must be a safe relative path under REPOS_DIR',
    );
  }
  const reposRoot = path.resolve(REPOS_DIR);
  const resolved = path.resolve(path.join(reposRoot, repoPath));
  if (resolved !== reposRoot && !resolved.startsWith(reposRoot + path.sep)) {
    throw new Error('clients.ios.repo_path resolves outside REPOS_DIR');
  }
  return resolved;
}

export function readServiceRegistry(
  servicesPath = path.join(GROUPS_DIR, 'global', 'services.json'),
): Record<string, ServiceConfig> {
  if (!fs.existsSync(servicesPath)) {
    throw new Error(`services.json not found at ${servicesPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(servicesPath, 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error('services.json must be a JSON object');
  }
  return parsed as Record<string, ServiceConfig>;
}

function normalizeIosClientConfig(value: unknown): IosClientConfig {
  if (!isRecord(value)) {
    throw new Error('service clients.ios must be an object');
  }
  const repoPath = typeof value.repo_path === 'string' ? value.repo_path.trim() : '';
  const scheme = typeof value.scheme === 'string' ? value.scheme.trim() : '';
  const bundleId =
    typeof value.bundle_id === 'string' ? value.bundle_id.trim() : '';
  if (!repoPath) throw new Error('clients.ios.repo_path is required');
  if (!scheme) throw new Error('clients.ios.scheme is required');
  if (!bundleId) throw new Error('clients.ios.bundle_id is required');

  if (value.automation !== undefined && !isRecord(value.automation)) {
    throw new Error('clients.ios.automation must be an object when provided');
  }

  return value as unknown as IosClientConfig;
}

export function resolveIosServiceConfig(
  service: string,
  options: {
    registry?: Record<string, ServiceConfig>;
    requireIosRepoExists?: boolean;
    requireBackendRepoExists?: boolean;
  } = {},
): ResolvedIosServiceConfig {
  const serviceName = service.trim();
  if (!serviceName) throw new Error('service is required');

  const registry = options.registry || readServiceRegistry();
  const serviceConfig = registry[serviceName];
  if (!serviceConfig) {
    throw new Error(`service "${serviceName}" not found in services.json`);
  }

  const ios = normalizeIosClientConfig(serviceConfig.clients?.ios);
  const iosRepoHostPath = resolveRepoUnderReposDir(ios.repo_path);
  if (options.requireIosRepoExists !== false && !fs.existsSync(iosRepoHostPath)) {
    throw new Error(
      `iOS client repo does not exist: ${iosRepoHostPath}. First version does not auto-clone.`,
    );
  }

  let backendRepoHostPath: string | null = null;
  if (
    typeof serviceConfig.repo_path === 'string' &&
    serviceConfig.repo_path.trim()
  ) {
    if (!isSafeRelativeRepoPath(serviceConfig.repo_path)) {
      throw new Error(`service "${serviceName}" repo_path is not safe`);
    }
    backendRepoHostPath = resolveRepoUnderReposDir(serviceConfig.repo_path);
    if (
      options.requireBackendRepoExists === true &&
      !fs.existsSync(backendRepoHostPath)
    ) {
      throw new Error(`backend repo does not exist: ${backendRepoHostPath}`);
    }
    if (!fs.existsSync(backendRepoHostPath)) {
      backendRepoHostPath = null;
    }
  }

  return {
    service: serviceName,
    service_config: serviceConfig,
    ios,
    ios_repo_host_path: iosRepoHostPath,
    backend_repo_host_path: backendRepoHostPath,
  };
}
