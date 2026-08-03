import { WebSocket } from 'ws';
import {
  COLORS,
  COMBAT,
  MAX_HITS,
  MAX_PLAYERS,
  RESPAWN_DELAY_MS,
  SPAWN_ALT_M,
  SPAWN_RING_M,
  TICK_MS,
  WORLD_CENTER,
  DEG2RAD,
  type ClientMsg,
  type PlayerInfo,
  type ServerMsg,
  type Spawn,
  type WireState,
} from '../shared/protocol.js';

const EARTH_R = 6378137;

interface Player {
  id: string;
  name: string;
  slot: number;
  ws: WebSocket;
  hits: number;
  alive: boolean;
  diedAt: number;
  state: WireState | null;
  stateAt: number;
  tokens: number;
  tokensAt: number;
  spawnCount: number;
  socketAlive: boolean;
}

/** Great-circle destination point, then the initial bearing back toward the centre. */
function ringSpawn(index: number): Spawn {
  const lat1 = WORLD_CENTER.lat * DEG2RAD;
  const lon1 = WORLD_CENTER.lon * DEG2RAD;
  const brg = (index * 2 * Math.PI) / MAX_PLAYERS;
  const d = SPAWN_RING_M / EARTH_R;

  const lat = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg),
  );
  const lon =
    lon1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat),
    );

  // Initial bearing from the spawn point back to the centre -- nose pointed at the action.
  const dLon = lon1 - lon;
  const hdg = Math.atan2(
    Math.sin(dLon) * Math.cos(lat1),
    Math.cos(lat) * Math.sin(lat1) - Math.sin(lat) * Math.cos(lat1) * Math.cos(dLon),
  );

  return { lat, lon, alt: SPAWN_ALT_M, hdg };
}

/** Geodetic (radians, metres) -> ECEF metres. Spherical is plenty for a range check. */
function toEcef(s: WireState): [number, number, number] {
  const r = EARTH_R + s.alt;
  const cl = Math.cos(s.lat);
  return [r * cl * Math.cos(s.lon), r * cl * Math.sin(s.lon), r * Math.sin(s.lat)];
}

function distance(a: WireState, b: WireState): number {
  const p = toEcef(a);
  const q = toEcef(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Drop control characters, keep everything printable (including ä ö õ ü). */
function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c >= 32 && c !== 127 && !(c >= 128 && c <= 159)) out += ch;
  }
  return out.trim().slice(0, 12);
}

const r = (x: number, n: number) => Number(x.toFixed(n));

function round(s: WireState) {
  return {
    lat: r(s.lat, 8), // ~6 cm
    lon: r(s.lon, 8),
    alt: r(s.alt, 1),
    hdg: r(s.hdg, 4),
    pit: r(s.pit, 4),
    rol: r(s.rol, 4),
    spd: r(s.spd, 1),
    fire: s.fire,
  };
}

export class World {
  private players = new Map<string, Player>();
  private timers: NodeJS.Timeout[] = [];

  start() {
    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    // Railway drops idle upgrades; without this we accumulate ghost planes.
    this.timers.push(setInterval(() => this.keepalive(), 30_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private info(p: Player): PlayerInfo {
    return { id: p.id, name: p.name, color: COLORS[p.slot], hits: p.hits, alive: p.alive };
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMsg, exceptId?: string) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id !== exceptId && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
  }

  private tick() {
    const entries = [];
    for (const p of this.players.values()) {
      if (p.alive && p.state) entries.push({ id: p.id, ...round(p.state) });
    }
    if (entries.length === 0) return;

    // Serialise once, send to everyone including the sender so all clocks agree.
    const data = JSON.stringify({ t: 'snapshot', ts: Date.now(), players: entries });
    for (const p of this.players.values()) {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
    }
  }

  private keepalive() {
    for (const p of this.players.values()) {
      if (!p.socketAlive) {
        p.ws.terminate();
        continue;
      }
      p.socketAlive = false;
      p.ws.ping();
    }
  }

  handleConnection(ws: WebSocket) {
    let me: Player | null = null;

    ws.on('pong', () => {
      if (me) me.socketAlive = true;
    });

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;

      if (msg.t === 'join') {
        if (me) return; // already joined
        me = this.join(ws, msg.name);
        return;
      }

      if (!me) return;

      switch (msg.t) {
        case 'state':
          this.onState(me, msg);
          break;
        case 'hit':
          this.onHit(me, msg.targetId);
          break;
        case 'respawn':
          this.onRespawn(me);
          break;
      }
    });

    ws.on('close', () => {
      if (!me) return;
      this.players.delete(me.id);
      this.broadcast({ t: 'left', id: me.id });
      me = null;
    });

    ws.on('error', () => ws.terminate());
  }

  private join(ws: WebSocket, rawName: unknown): Player | null {
    if (this.players.size >= MAX_PLAYERS) {
      this.send(ws, {
        t: 'error',
        code: 'full',
        message: `Taevas on täis (${MAX_PLAYERS} pilooti). Proovi hiljem uuesti.`,
      });
      return null;
    }

    const name = sanitizeName(rawName) || 'Piloot';

    const used = new Set([...this.players.values()].map((p) => p.slot));
    let slot = 0;
    while (used.has(slot)) slot++;

    const now = Date.now();
    const player: Player = {
      id: Math.random().toString(36).slice(2, 10),
      name,
      slot,
      ws,
      hits: 0,
      alive: true,
      diedAt: 0,
      state: null,
      stateAt: 0,
      tokens: COMBAT.TOKEN_CAPACITY,
      tokensAt: now,
      spawnCount: 0,
      socketAlive: true,
    };
    this.players.set(player.id, player);

    const others = [...this.players.values()]
      .filter((p) => p.id !== player.id)
      .map((p) => this.info(p));

    this.send(ws, {
      t: 'welcome',
      id: player.id,
      name: player.name,
      color: COLORS[slot],
      players: others,
      spawn: this.nextSpawn(player),
    });
    this.broadcast({ t: 'joined', player: this.info(player) }, player.id);
    return player;
  }

  /** Rotate through ring points so repeated respawns don't stack in one spot. */
  private nextSpawn(p: Player): Spawn {
    const s = ringSpawn((p.slot + p.spawnCount) % MAX_PLAYERS);
    p.spawnCount++;
    return s;
  }

  private onState(p: Player, m: ClientMsg & { t: 'state' }) {
    const nums = [m.lat, m.lon, m.alt, m.hdg, m.pit, m.rol, m.spd];
    if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n))) return;
    p.state = {
      lat: m.lat,
      lon: m.lon,
      alt: m.alt,
      hdg: m.hdg,
      pit: m.pit,
      rol: m.rol,
      spd: m.spd,
      fire: m.fire ? 1 : 0,
    };
    p.stateAt = Date.now();
  }

  /**
   * The client raycasts and claims a hit; the server owns the damage. Position is
   * client-authoritative (no rubber-banding), health is not (no forging kills).
   */
  private onHit(shooter: Player, targetId: string) {
    const now = Date.now();
    const target = this.players.get(targetId);

    if (!shooter.alive || !shooter.state) return;
    if (!target || !target.alive || !target.state) return;
    if (target.id === shooter.id) return;
    if (now - shooter.stateAt > COMBAT.STATE_FRESH_MS) return;
    if (now - target.stateAt > COMBAT.STATE_FRESH_MS) return;

    // Token bucket caps the claim rate at roughly the real fire rate.
    shooter.tokens = Math.min(
      COMBAT.TOKEN_CAPACITY,
      shooter.tokens + ((now - shooter.tokensAt) / 1000) * COMBAT.TOKENS_PER_SEC,
    );
    shooter.tokensAt = now;
    if (shooter.tokens < 1) return;
    shooter.tokens -= 1;

    if (distance(shooter.state, target.state) > COMBAT.SERVER_RANGE) return;

    target.hits += 1;
    this.broadcast({
      t: 'hit',
      targetId: target.id,
      shooterId: shooter.id,
      hits: target.hits,
    });

    if (target.hits >= MAX_HITS) {
      target.alive = false;
      target.diedAt = now;
      this.broadcast({ t: 'death', id: target.id, killerId: shooter.id });
    }
  }

  private onRespawn(p: Player) {
    if (p.alive) return;
    if (Date.now() - p.diedAt < RESPAWN_DELAY_MS) return;
    p.hits = 0;
    p.alive = true;
    p.state = null;
    const s = this.nextSpawn(p);
    this.broadcast({ t: 'respawned', id: p.id, ...s });
  }
}
