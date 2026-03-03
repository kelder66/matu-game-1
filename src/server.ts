import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.PORT || '3000', 10);

// --- Room management ---

interface Player {
  id: string;
  ws: WebSocket;
}

interface Room {
  id: string;
  players: Player[];
}

const rooms = new Map<string, Room>();

function generateRoomId(): string {
  const words = ['ROCKET', 'COMET', 'NOVA', 'ORBIT', 'LUNAR', 'SOLAR', 'ASTRO', 'NEBULA'];
  const word = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(10 + Math.random() * 90);
  return `${word}-${num}`;
}

function broadcast(room: Room, message: object, excludeId?: string) {
  const data = JSON.stringify(message);
  for (const player of room.players) {
    if (player.id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  }
}

// --- Server setup ---

const app = Fastify({ logger: true });

app.register(staticPlugin, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
});

app.get('/health', async () => ({ status: 'ok' }));

// Start server, then attach WebSocket to the underlying HTTP server
await app.listen({ port, host: '0.0.0.0' });

const wss = new WebSocketServer({ server: app.server });

wss.on('connection', (ws) => {
  let currentRoom: Room | null = null;
  let playerId: string | null = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'create': {
          let roomId = generateRoomId();
          while (rooms.has(roomId)) roomId = generateRoomId();
          playerId = 'p1';
          const room: Room = { id: roomId, players: [{ id: playerId, ws }] };
          rooms.set(roomId, room);
          currentRoom = room;
          ws.send(JSON.stringify({ type: 'created', roomId, playerId }));
          break;
        }

        case 'join': {
          const room = rooms.get(msg.roomId);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }
          if (room.players.length >= 2) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            return;
          }
          playerId = 'p2';
          room.players.push({ id: playerId, ws });
          currentRoom = room;
          ws.send(JSON.stringify({ type: 'joined', roomId: room.id, playerId }));
          broadcast(room, { type: 'start' }, playerId);
          break;
        }

        case 'state': {
          if (currentRoom && playerId) {
            broadcast(currentRoom, { type: 'state', playerId, data: msg.data }, playerId);
          }
          break;
        }

        case 'ihit': {
          // Player reports they were hit — relay to opponent as confirmation
          if (currentRoom && playerId) {
            broadcast(currentRoom, { type: 'hit', data: msg.data }, playerId);
          }
          break;
        }

        case 'gameover': {
          if (currentRoom) {
            broadcast(currentRoom, { type: 'gameover', data: msg.data });
          }
          break;
        }

        case 'heartCaught': {
          if (currentRoom && playerId) {
            broadcast(currentRoom, { type: 'heartGiven', data: msg.data }, playerId);
          }
          break;
        }

        case 'rematch': {
          if (currentRoom) {
            broadcast(currentRoom, { type: 'rematch' });
          }
          break;
        }
      }
    } catch (err) {
      console.error('Message error:', err);
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      currentRoom.players = currentRoom.players.filter(p => p.id !== playerId);
      broadcast(currentRoom, { type: 'playerLeft', playerId });
      if (currentRoom.players.length === 0) {
        rooms.delete(currentRoom.id);
      }
    }
  });
});
