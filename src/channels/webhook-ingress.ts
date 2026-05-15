import http from 'http';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

const ingressEnv = readEnvFile(['WEBHOOK_PORT']);
const webhookPortRaw =
  process.env.WEBHOOK_PORT || ingressEnv.WEBHOOK_PORT || '3002';
const parsedWebhookPort = Number.parseInt(webhookPortRaw, 10);

export const WEBHOOK_INGRESS_PORT = Number.isFinite(parsedWebhookPort)
  ? parsedWebhookPort
  : 3002;

export interface WebhookRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
}

export type WebhookRouteHandler = (
  context: WebhookRouteContext,
) => void | Promise<void>;

interface WebhookRoute {
  name: string;
  pathPrefix: string;
  handler: WebhookRouteHandler;
}

type UnregisterWebhookRoute = () => Promise<void>;

const routes = new Map<string, WebhookRoute>();
let server: http.Server | null = null;
let startPromise: Promise<void> | null = null;

function normalizePathPrefix(pathPrefix: string): string {
  if (!pathPrefix.startsWith('/')) return `/${pathPrefix}`;
  return pathPrefix;
}

function pathMatches(pathname: string, pathPrefix: string): boolean {
  return pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

function findRoute(pathname: string): WebhookRoute | undefined {
  return [...routes.values()]
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)
    .find((route) => pathMatches(pathname, route.pathPrefix));
}

async function dispatchWebhookRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(
    req.url || '/',
    `http://localhost:${WEBHOOK_INGRESS_PORT}`,
  );
  const route = findRoute(url.pathname);
  if (!route) {
    res.writeHead(404);
    res.end();
    return;
  }

  try {
    await route.handler({ req, res, url });
  } catch (err) {
    logger.error(
      { err, route: route.name, path: url.pathname },
      'Webhook ingress route failed',
    );
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (!res.writableEnded) {
      res.end('internal error');
    }
  }
}

async function startWebhookIngress(): Promise<void> {
  if (server) return startPromise || Promise.resolve();

  server = http.createServer((req, res) => {
    void dispatchWebhookRequest(req, res);
  });

  startPromise = new Promise<void>((resolve, reject) => {
    const currentServer = server!;
    const onError = (err: Error) => {
      currentServer.off('listening', onListening);
      if (server === currentServer) {
        server = null;
        startPromise = null;
      }
      reject(err);
    };
    const onListening = () => {
      currentServer.off('error', onError);
      logger.info(
        { port: WEBHOOK_INGRESS_PORT },
        'Webhook ingress server listening',
      );
      resolve();
    };
    currentServer.once('error', onError);
    currentServer.once('listening', onListening);
    currentServer.listen(WEBHOOK_INGRESS_PORT, '0.0.0.0');
  });

  return startPromise;
}

async function stopWebhookIngressIfIdle(): Promise<void> {
  if (routes.size > 0 || !server) return;
  const currentServer = server;
  server = null;
  startPromise = null;
  await new Promise<void>((resolve, reject) => {
    currentServer.close((err) => (err ? reject(err) : resolve()));
  });
  logger.info('Webhook ingress server stopped');
}

export async function registerWebhookRoute(route: {
  name: string;
  pathPrefix: string;
  handler: WebhookRouteHandler;
}): Promise<UnregisterWebhookRoute> {
  const normalizedRoute: WebhookRoute = {
    ...route,
    pathPrefix: normalizePathPrefix(route.pathPrefix),
  };
  routes.set(route.name, normalizedRoute);
  try {
    await startWebhookIngress();
  } catch (err) {
    if (routes.get(route.name) === normalizedRoute) {
      routes.delete(route.name);
    }
    throw err;
  }
  logger.info(
    { route: normalizedRoute.name, pathPrefix: normalizedRoute.pathPrefix },
    'Webhook route registered',
  );

  return async () => {
    const current = routes.get(route.name);
    if (current === normalizedRoute) {
      routes.delete(route.name);
      logger.info({ route: route.name }, 'Webhook route unregistered');
    }
    await stopWebhookIngressIfIdle();
  };
}
