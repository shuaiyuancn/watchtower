import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { WatchtowerStore } from './ledger/store.js';
import { WebSocketHub } from './ws/hub.js';
import { registerApiRoutes } from './routes/api.js';

dotenv.config();

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';

export async function createServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info'
    }
  });

  await app.register(cors, {
    origin: true,
    credentials: true
  });

  await app.register(fastifyWebsocket);

  const store = new WatchtowerStore();
  const wsHub = new WebSocketHub(store);

  // Register REST APIs
  registerApiRoutes(app, store, wsHub);

  // WebSocket for Windows 11 Rust Client
  app.get<{ Params: { deviceId: string } }>('/ws/client/:deviceId', { websocket: true }, (socket, req) => {
    const deviceId = req.params.deviceId || 'windows-pc';
    wsHub.registerClient(deviceId, socket);
  });

  // WebSocket for Parent Web Dashboard
  app.get<{ Querystring: { token?: string } }>('/ws/dashboard', { websocket: true }, (socket, req) => {
    const token = req.query?.token || (req.headers['sec-websocket-protocol'] as string) || '';
    if (!store.verifySessionToken(token)) {
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
      app.listen({ port: PORT, host: HOST }, (err, address) => {
        if (err) {
          app.log.error(err);
          process.exit(1);
        }
        console.log(`\n======================================================`);
        console.log(` 🛡️  Watchtower Server running at: ${address}`);
        console.log(` 📡 WebSocket Client Endpoint: ws://${HOST}:${PORT}/ws/client/:deviceId`);
        console.log(` 📊 Dashboard WebSocket:       ws://${HOST}:${PORT}/ws/dashboard`);
        console.log(`======================================================\n`);
      });
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}
