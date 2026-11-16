import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { WatchtowerStore } from './ledger/store.js';
import { WebSocketHub } from './ws/hub.js';
import { registerApiRoutes } from './routes/api.js';
import { notifySlack } from './notify/slack.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';

/**
 * The externally-reachable base URLs to print on startup. On Railway the
 * container binds 0.0.0.0:PORT behind a proxy, so neither the bind host nor
 * Fastify's loopback-normalised callback address is useful — report the public
 * Railway domain (RAILWAY_PUBLIC_DOMAIN) over HTTPS/WSS instead. Locally, fall
 * back to a dialable address (0.0.0.0/:: → localhost) with the port.
 */
export function resolveStartupUrls(
  env: NodeJS.ProcessEnv,
  host: string,
  port: number
): { httpBase: string; wsBase: string } {
  const domain = env.RAILWAY_PUBLIC_DOMAIN;
  if (domain) {
    return { httpBase: `https://${domain}`, wsBase: `wss://${domain}` };
  }
  const dialableHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return {
    httpBase: `http://${dialableHost}:${port}`,
    wsBase: `ws://${dialableHost}:${port}`
  };
}

// Populate req.ips from X-Forwarded-For. Rate limiting (H1) does NOT trust the
// client-controlled left-most entry; getClientIp() keys on the proxy-appended
// hop instead (see routes/api.ts). Set TRUST_PROXY=false to ignore XFF entirely
// when the server is exposed directly with no proxy.
function resolveTrustProxy(): boolean {
  return process.env.TRUST_PROXY !== 'false';
}

export async function createServer() {
  const app = Fastify({
    trustProxy: resolveTrustProxy(),
    logger: {
      level: process.env.LOG_LEVEL || 'info'
    }
  });

  // Security headers (M3). CSP is scoped to same-origin plus the WS the
  // dashboard needs; the SPA loads its own bundle/styles from /assets.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  });

  // CORS: allowlist via env; reflect otherwise but never with credentials (H4).
  // Auth is a bearer header, not a cookie, so credentials are not needed.
  const allowed = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: allowed.length > 0 ? allowed : true,
    credentials: false
  });

  await app.register(fastifyWebsocket);

  const store = new WatchtowerStore();
  const wsHub = new WebSocketHub(store);

  // Register REST APIs
  registerApiRoutes(app, store, wsHub);

  // WebSocket for Windows 11 Rust Client. Device auth (C1) is enforced when
  // REQUIRE_DEVICE_AUTH=true; the client presents a device-bound token minted
  // at enrollment (?token= over wss, or the X-Device-Token header).
  app.get<{ Params: { deviceId: string }; Querystring: { token?: string } }>(
    '/ws/client/:deviceId',
    { websocket: true },
    (socket, req) => {
      const deviceId = req.params.deviceId || 'windows-pc';
      if (process.env.REQUIRE_DEVICE_AUTH === 'true') {
        const token = req.query?.token || (req.headers['x-device-token'] as string) || '';
        if (!store.verifyDeviceToken(deviceId, token)) {
          notifySlack(`🚫 Rejected unauthenticated Watchtower device connection: *${deviceId}*`);
          socket.close(4001, 'Unauthorized device');
          return;
        }
      }
      wsHub.registerClient(deviceId, socket);
    }
  );

  // WebSocket for Parent Web Dashboard. Authenticated with a short-lived,
  // single-use ticket so the session token never appears in a URL (H3).
  app.get<{ Querystring: { ticket?: string } }>('/ws/dashboard', { websocket: true }, (socket, req) => {
    const ticket = req.query?.ticket || '';
    if (!store.consumeWsTicket(ticket)) {
      socket.close(4001, 'Unauthorized');
      return;
    }
    wsHub.registerDashboard(socket);
  });

  // Serve static dashboard if built
  const staticPath = path.join(process.cwd(), 'web', 'dist');
  if (fs.existsSync(staticPath)) {
    await app.register(fastifyStatic, {
      root: staticPath,
      prefix: '/'
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        return reply.code(404).send({ error: 'API route not found' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => {
      return {
        message: 'Watchtower Backend Running',
        status: 'ok',
        docs: '/api/devices'
      };
    });
  }

  return { app, store, wsHub };
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  createServer()
    .then(({ app }) => {
      app.listen({ port: PORT, host: HOST }, (err) => {
        if (err) {
          app.log.error(err);
          process.exit(1);
        }
        // Report the externally-reachable URL: the public Railway domain when
        // deployed, a dialable local address otherwise. The bind host (0.0.0.0)
        // and Fastify's loopback-normalised callback address are both unhelpful.
        const { httpBase, wsBase } = resolveStartupUrls(process.env, HOST, PORT);
        notifySlack(`🛰️ Watchtower server started at ${httpBase}.`);
        console.log(`\n======================================================`);
        console.log(` 🛡️  Watchtower Server running at: ${httpBase}`);
        console.log(` 📡 WebSocket Client Endpoint: ${wsBase}/ws/client/:deviceId`);
        console.log(` 📊 Dashboard WebSocket:       ${wsBase}/ws/dashboard`);
        console.log(`======================================================\n`);
      });
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
