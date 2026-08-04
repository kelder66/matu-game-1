import { WebSocket } from 'ws';
import {
  BOT_COLORS,
  BOT_NAMES,
  COLORS,
  COMBAT,
  DEFAULT_DIFFICULTY,
  DIFFICULTY,
  MAX_HITS,
  MAX_PLAYERS,
  NPC,
  NPC_COUNT,
  RESPAWN_DELAY_MS,
  SPAWN_AGL_M,
  SPAWN_RING_M,
  SPAWN_RING_POINTS,
  TICK_MS,
  DEFAULT_CITY,
  getCity,
  CITIES,
  DEG2RAD,
  type City,
  type ClientMsg,
  type Difficulty,
  type PlayerInfo,
  type ServerMsg,
  type Spawn,
  type Tuning,
  type WireState,
} from '../shared/protocol.js';
import { createFlightState, integrate, type FlightState } from '../shared/flight.js';
import {
  aimAt,
  applyLeash,
  bearingTo,
  canFire,
  createBot,
  decide,
  groundRange,
  patrolTarget,
  stackOffset,
  steer,
  type Bot,
  type BotTarget,
} from './bots.js';

const EARTH_R = 6378137;

/** Reused each bot tick -- the AI runs 40x/second and must not allocate. */
const _aimState: WireState = { lat: 0, lon: 0, alt: 0, hdg: 0, pit: 0, rol: 0, spd: 0, fire: 0 };

/** Anything that can be shot: humans and NPCs share the damage model. */
interface Combatant {
  id: string;
  name: string;
  hits: number;
  alive: boolean;
  diedAt: number;
  state: WireState | null;
  stateAt: number;
  bot: boolean;
}

interface Player extends Combatant {
  bot: false;
  slot: number;
  ws: WebSocket;
  tokens: number;
  tokensAt: number;
  spawnCount: number;
  socketAlive: boolean;
  diffAt: number;
  cityAt: number;
  /** Bots hold fire until this time, so a respawn isn't instantly punished. */
  botSafeUntil: number;
}

/** An NPC. Kept OUT of `players` so the 5-human cap and every ws deref stay simple. */
interface BotPlayer extends Combatant {
  bot: true;
  ai: Bot;
  respawnAt: number;
  leashed: boolean;
  spawnCount: number;
}

/** Great-circle destination point, then the initial bearing back toward the centre. */
function ringSpawn(index: number, city: City): Spawn {
  const lat1 = city.lat * DEG2RAD;
  const lon1 = city.lon * DEG2RAD;
  const brg = (index * 2 * Math.PI) / SPAWN_RING_POINTS;
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

  return { lat, lon, alt: city.groundAlt + SPAWN_AGL_M, hdg };
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
  private bots: BotPlayer[] = [];
  private timers: NodeJS.Timeout[] = [];
  private difficulty: Difficulty = readDifficultyEnv();
  private cityId: string = process.env.CITY || DEFAULT_CITY;
  /** Set while no humans are connected, so the first joiner finds bots on the ring. */
  private botsParked = true;

  start() {
    const count = readNpcCountEnv();
    for (let i = 0; i < count; i++) this.bots.push(this.makeBot(i));

    this.timers.push(setInterval(() => this.tick(), TICK_MS));
    // Railway drops idle upgrades; without this we accumulate ghost planes.
    this.timers.push(setInterval(() => this.keepalive(), 30_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private get city(): City {
    return getCity(this.cityId);
  }

  private info(p: Combatant): PlayerInfo {
    const color = p.bot
      ? BOT_COLORS[(p as BotPlayer).ai.index % BOT_COLORS.length]
      : COLORS[(p as Player).slot % COLORS.length];
    return { id: p.id, name: p.name, color, hits: p.hits, alive: p.alive, bot: p.bot };
  }

  /** Humans and bots, for roster and hit lookups. */
  private roster(): Combatant[] {
    return [...this.players.values(), ...this.bots];
  }

  private find(id: string): Combatant | undefined {
    return this.players.get(id) ?? this.bots.find((b) => b.id === id);
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
    const now = Date.now();
    this.stepBots(now);

    const entries = [];
    for (const p of this.roster()) {
      if (p.alive && p.state) entries.push({ id: p.id, ...round(p.state) });
    }
    if (entries.length === 0) return;

    // Serialise once, send to everyone including the sender so all clocks agree.
    const data = JSON.stringify({ t: 'snapshot', ts: now, players: entries });
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
        case 'difficulty':
          this.onDifficulty(me, msg.level);
          break;
        case 'city':
          this.onCity(me, msg.id);
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
      bot: false,
      diffAt: 0,
      cityAt: 0,
      botSafeUntil: now + NPC.SPAWN_GRACE_MS,
    };
    this.players.set(player.id, player);

    // Bots drift while nobody is watching; put them back on the ring for the first
    // arrival so a kid never joins to an empty-looking sky.
    if (this.botsParked) {
      this.botsParked = false;
      for (const b of this.bots) this.resetBot(b);
    }

    const others = this.roster()
      .filter((p) => p.id !== player.id)
      .map((p) => this.info(p));

    this.send(ws, {
      t: 'welcome',
      id: player.id,
      name: player.name,
      color: COLORS[slot % COLORS.length],
      players: others,
      spawn: this.nextSpawn(player),
      difficulty: this.difficulty,
      city: this.cityId,
    });
    this.broadcast({ t: 'joined', player: this.info(player) }, player.id);
    return player;
  }

  /** Rotate through ring points so repeated respawns don't stack in one spot. */
  private nextSpawn(p: { slot: number; spawnCount: number }): Spawn {
    const s = ringSpawn((p.slot + p.spawnCount) % SPAWN_RING_POINTS, this.city);
    p.spawnCount++;
    return s;
  }

  private onDifficulty(p: Player, level: Difficulty) {
    if (!(level in DIFFICULTY)) return;
    if (level === this.difficulty) return; // don't broadcast a no-op
    const now = Date.now();
    if (now - p.diffAt < 500) return; // trivial anti-spam
    p.diffAt = now;
    this.difficulty = level;
    // Nothing to migrate: stepBots reads DIFFICULTY[this.difficulty] fresh each tick.
    this.broadcast({ t: 'difficulty', level, by: p.name });
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
    const target = this.find(targetId);

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

    this.applyHit(shooter.id, target, now);
  }

  /** The one place damage happens, for both the client-claim and NPC paths. */
  private applyHit(shooterId: string, target: Combatant, now: number) {
    target.hits += 1;
    this.broadcast({ t: 'hit', targetId: target.id, shooterId, hits: target.hits });

    if (target.hits >= MAX_HITS) {
      target.alive = false;
      target.diedAt = now;
      this.broadcast({ t: 'death', id: target.id, killerId: shooterId });
      if (target.bot) (target as BotPlayer).respawnAt = now + NPC.RESPAWN_MS;
    }
  }

  private onRespawn(p: Player) {
    if (p.alive) return;
    const now = Date.now();
    if (now - p.diedAt < RESPAWN_DELAY_MS) return;
    p.hits = 0;
    p.alive = true;
    p.state = null;
    p.botSafeUntil = now + NPC.SPAWN_GRACE_MS;
    const s = this.nextSpawn(p);
    this.broadcast({ t: 'respawned', id: p.id, ...s });
  }

  /**
   * Changing city teleports the whole world. Everyone has to move together: leaving
   * anyone behind would put them a thousand kilometres from the fight with no way
   * back, so every living player and both bots are respawned on the new ring.
   */
  private onCity(p: Player, id: string) {
    if (!CITIES.some((c) => c.id === id)) return;
    if (id === this.cityId) return; // no-op, don't broadcast
    const now = Date.now();
    if (now - p.cityAt < 1000) return; // it is an expensive move; rate limit harder
    p.cityAt = now;

    this.cityId = id;
    this.broadcast({ t: 'city', id, by: p.name });

    // Bots must be announced, not merely moved: `respawned` is what makes each client
    // clear its interpolation buffer. Without it the plane slides smoothly from
    // Helsinki to Munich rather than simply being there.
    for (const b of this.bots) {
      this.resetBot(b);
      this.broadcast({ t: 'respawned', id: b.id, ...this.botSpawn(b) });
    }
    for (const other of this.players.values()) {
      if (!other.alive) continue;
      other.state = null;
      other.botSafeUntil = now + NPC.SPAWN_GRACE_MS;
      this.broadcast({ t: 'respawned', id: other.id, ...this.nextSpawn(other) });
    }
  }

  // --- NPCs ---------------------------------------------------------------

  private makeBot(index: number): BotPlayer {
    const bot: BotPlayer = {
      id: `npc-${index}`,
      name: BOT_NAMES[index % BOT_NAMES.length],
      hits: 0,
      alive: true,
      diedAt: 0,
      state: null,
      stateAt: 0,
      bot: true,
      ai: createBot(index, createFlightState(0, 0, 0, 0)),
      respawnAt: 0,
      leashed: false,
      spawnCount: 0,
    };
    this.resetBot(bot);
    return bot;
  }

  /** The bot's current pose as a Spawn, for the messages that announce a move. */
  private botSpawn(b: BotPlayer): Spawn {
    const fs = b.ai.fs;
    return { lat: fs.lat, lon: fs.lon, alt: fs.alt, hdg: fs.heading };
  }

  private resetBot(b: BotPlayer) {
    // Bots take the ring points above MAX_PLAYERS, so they never collide with humans.
    const s = ringSpawn((MAX_PLAYERS + b.ai.index + b.spawnCount) % SPAWN_RING_POINTS, this.city);
    b.spawnCount++;
    b.ai.fs = createFlightState(s.lat, s.lon, s.alt, s.hdg);
    b.ai.targetId = '';
    b.ai.decideAt = 0;
    b.ai.evadeUntil = 0;
    b.ai.firing = false;
    b.leashed = false;
    b.hits = 0;
    b.alive = true;
    b.state = writeState(b.ai.fs, false);
    b.stateAt = Date.now();
  }

  private stepBots(now: number) {
    if (this.bots.length === 0) return;

    // Nobody watching: freeze completely. Zero CPU, and no drifting over the sea.
    if (this.players.size === 0) {
      this.botsParked = true;
      return;
    }

    const d = DIFFICULTY[this.difficulty];
    const dt = TICK_MS / 1000;

    const candidates: BotTarget[] = [];
    for (const p of this.players.values()) {
      if (p.alive && p.state && now - p.stateAt < COMBAT.STATE_FRESH_MS) {
        candidates.push({ id: p.id, state: p.state });
      }
    }

    for (const b of this.bots) {
      if (!b.alive) {
        if (now >= b.respawnAt) {
          this.resetBot(b);
          this.broadcast({ t: 'respawned', id: b.id, ...this.botSpawn(b) });
        }
        continue;
      }
      this.stepBot(b, candidates, d, dt, now);
    }
  }

  private stepBot(b: BotPlayer, candidates: BotTarget[], d: Tuning, dt: number, now: number) {
    const ai = b.ai;
    const sib = this.bots.find((o) => o !== b);

    if (now >= ai.decideAt) {
      ai.decideAt = now + d.decisionMs;
      decide(ai, sib?.ai.targetId ?? '', candidates, d);
    }

    // Never hold a reference across ticks -- a disconnect would leave it dangling.
    const target = ai.targetId ? this.players.get(ai.targetId) : undefined;
    const targetState =
      target && target.alive && target.state ? target.state : patrolTarget(ai.index, now, this.city);
    const hunting = Boolean(target && target.alive && target.state);

    // Wingman spacing first: bearingTo is scratch-free, so it can't clobber the aim.
    if (sib && sib.alive) {
      ai.sibRange = groundRange(ai.fs, sib.ai.fs);
      ai.sibBearing = bearingTo(ai.fs, sib.ai.fs);
    } else {
      ai.sibRange = Infinity;
    }

    // Aim at a point offset above/below the target so the two bots stay on separate
    // levels instead of converging into each other and jamming their own steering.
    _aimState.lat = targetState.lat;
    _aimState.lon = targetState.lon;
    _aimState.alt = targetState.alt + (hunting ? stackOffset(ai.index) : 0);
    _aimState.hdg = targetState.hdg;
    _aimState.pit = targetState.pit;
    _aimState.rol = targetState.rol;
    _aimState.spd = targetState.spd;

    const aim = aimAt(ai.fs, _aimState, hunting ? d.leadSeconds : 0);
    b.leashed = applyLeash(ai, aim, b.leashed, this.city);

    steer(ai, aim, d, now, this.city.groundAlt, hunting ? targetState.spd : 0);
    integrate(ai.fs, ai.input, this.city.groundAlt + NPC.GROUND_CLEARANCE, dt);
    if (ai.fs.speed > d.maxSpeed) ai.fs.speed = d.maxSpeed;

    this.botFire(b, target, d, now, hunting && !b.leashed);

    b.state = writeState(ai.fs, ai.firing);
    b.stateAt = now;
  }

  private botFire(
    b: BotPlayer,
    target: Player | undefined,
    d: Tuning,
    now: number,
    engaged: boolean,
  ) {
    const ai = b.ai;
    ai.firing = false;
    if (!engaged || now < ai.evadeUntil) return;
    if (!target || !target.alive || !target.state) return;
    if (now - target.stateAt > COMBAT.STATE_FRESH_MS) return;
    if (now < target.botSafeUntil) return;

    // No lead here: the round is hitscan, so aim at where the target actually is.
    const aim = aimAt(ai.fs, target.state, 0);
    if (!canFire(ai, aim, d)) return;

    // Set `firing` whenever the target is in the sights, not only on trigger ticks.
    // The client already draws tracers from this flag, so it becomes a free
    // "break NOW" telegraph -- which is what keeps hard mode fair.
    ai.firing = true;

    if (now < ai.fireAt) return;
    ai.fireAt = now + d.fireIntervalMs;
    if (Math.random() > d.hitChance) return; // the miss IS the difficulty
    this.applyHit(b.id, target, now);

    if (b.hits >= d.evadeAt) ai.evadeUntil = now + d.evadeMs;
  }
}

function writeState(fs: FlightState, firing: boolean): WireState {
  return {
    lat: fs.lat,
    lon: fs.lon,
    alt: fs.alt,
    hdg: fs.heading,
    pit: fs.pitch,
    rol: fs.roll,
    spd: fs.speed,
    fire: firing ? 1 : 0,
  };
}

function readNpcCountEnv(): number {
  const raw = process.env.NPC_COUNT;
  if (raw === undefined) return NPC_COUNT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : NPC_COUNT;
}

function readDifficultyEnv(): Difficulty {
  const raw = process.env.NPC_DIFFICULTY;
  return raw && raw in DIFFICULTY ? (raw as Difficulty) : DEFAULT_DIFFICULTY;
}
