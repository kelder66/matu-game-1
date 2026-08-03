// Shared contract between client and server. Compiled by both tsconfigs.

export const TICK_MS = 50; // 20 Hz snapshot broadcast
export const MAX_PLAYERS = 5;
export const MAX_HITS = 10;
export const INTERP_DELAY_MS = 120;
export const RESPAWN_DELAY_MS = 2000;

/** Everyone spawns on a ring around here so players actually find each other. */
export const WORLD_CENTER = { lat: 59.437, lon: 24.7536 }; // Tallinn Old Town, degrees
export const SPAWN_RING_M = 1500;
export const SPAWN_ALT_M = 800;

/** Player plane colours, one per slot. */
export const COLORS = [0xff4444, 0x4488ff, 0xffcc33, 0x44dd66, 0xdd55dd];

export const FLIGHT = {
  SPEED_MIN: 70,
  SPEED_MAX: 220,
  SPEED_DEFAULT: 130,
  THROTTLE_ACCEL: 45, // m/s^2
  MAX_BANK: 1.05, // 60 deg
  ROLL_RATE: 2.2, // rad/s toward commanded bank
  ROLL_RECENTER: 1.6, // rad/s back to level
  PITCH_RATE: 0.7, // rad/s
  PITCH_RECENTER: 0.9, // 1/s exponential decay
  MAX_PITCH: 0.87, // 50 deg -- never inverted
  G: 9.81,
  MIN_AGL: 120, // metres above sampled ground
  MAX_ALT: 12000,
  MAX_LAT: 1.4835, // +-85 deg, stay off the poles
} as const;

export const COMBAT = {
  FIRE_INTERVAL: 0.1, // 10 rounds/s
  RANGE: 1500, // m
  // Forgiving on purpose: with bank-to-turn controls and no mouse aim, a tighter
  // tube than this is frustrating for a kid. 40 m at 1500 m is still only ~1.5 deg.
  HIT_RADIUS: 40, // m
  TRACER_SPEED: 900, // m/s (visual only)
  /** Server-side leniency on top of RANGE, for latency. */
  SERVER_RANGE: 2000,
  /** Token bucket: refill per second and capacity. */
  TOKENS_PER_SEC: 12,
  TOKEN_CAPACITY: 15,
  /** A hit is only counted if both players reported state this recently. */
  STATE_FRESH_MS: 1500,
} as const;

// --- Plane state on the wire (angles in radians, alt/spd in metres) ---

export interface WireState {
  lat: number;
  lon: number;
  alt: number;
  hdg: number;
  pit: number;
  rol: number;
  spd: number;
  fire: 0 | 1;
}

export interface SnapEntry extends WireState {
  id: string;
}

export interface PlayerInfo {
  id: string;
  name: string;
  color: number;
  hits: number;
  alive: boolean;
}

export interface Spawn {
  lat: number; // radians
  lon: number; // radians
  alt: number;
  hdg: number;
}

// --- Client -> server ---

export type ClientMsg =
  | { t: 'join'; name: string }
  | ({ t: 'state' } & WireState)
  | { t: 'hit'; targetId: string }
  | { t: 'respawn' };

// --- Server -> client ---

export type ServerMsg =
  | {
      t: 'welcome';
      id: string;
      name: string;
      color: number;
      players: PlayerInfo[];
      spawn: Spawn;
    }
  | { t: 'joined'; player: PlayerInfo }
  | { t: 'left'; id: string }
  | { t: 'snapshot'; ts: number; players: SnapEntry[] }
  | { t: 'hit'; targetId: string; shooterId: string; hits: number }
  | { t: 'death'; id: string; killerId: string }
  | ({ t: 'respawned'; id: string } & Spawn)
  | { t: 'error'; code: 'full' | 'badname'; message: string };

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
