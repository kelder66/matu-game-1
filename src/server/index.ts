import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { World } from './world.js';
import { MAX_HITS, MAX_PLAYERS } from '../shared/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || '3000', 10);

const app = Fastify({ logger: true });

// dist/server/index.js -> dist/public, which is where `vite build` writes.
app.register(staticPlugin, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
});

app.get('/health', async () => ({ status: 'ok' }));

// The Google Maps key is a browser key (restricted by HTTP referrer in the Cloud
// console). It is handed to the client here rather than baked into the bundle so
// the same build works with or without it.
app.get('/api/config', async () => ({
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || null,
  maxPlayers: MAX_PLAYERS,
  maxHits: MAX_HITS,
}));

// Start the server, THEN attach the WebSocket server to the underlying HTTP
// server -- app.server is not listening before this point (see commit 9eab2fc).
await app.listen({ port, host: '0.0.0.0' });

const world = new World();
world.start();

const wss = new WebSocketServer({ server: app.server, path: '/ws' });
wss.on('connection', (ws) => world.handleConnection(ws));
