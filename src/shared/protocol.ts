// Shared contract between client and server. Compiled by both tsconfigs.

export const TICK_MS = 50; // 20 Hz snapshot broadcast
export const MAX_PLAYERS = 5;
export const MAX_HITS = 10;
export const INTERP_DELAY_MS = 120;
export const RESPAWN_DELAY_MS = 2000;

/**
 * Everyone spawns on a ring around here so players actually find each other.
 *
 * Helsinki, NOT Tallinn: Google's Photorealistic 3D Tiles only carry photogrammetry
 * (buildings, trees) inside published coverage areas. Terrain is worldwide, but the
 * only covered spots in Estonia are Parnu and Haapsalu -- Tallinn renders as flat
 * imagery draped on a hill no matter what the renderer settings say.
 * Coverage map: developers.google.com/maps/documentation/javascript/3d/coverage
 *
 * Moving the world elsewhere means revisiting NPC.GROUND_ALT below, which is a
 * local terrain figure.
 */
export const WORLD_CENTER = { lat: 60.17, lon: 24.94 }; // Helsinki, degrees
export const SPAWN_RING_M = 1500;
export const SPAWN_ALT_M = 800;
/** More than MAX_PLAYERS so humans and NPCs never share a spawn point. */
export const SPAWN_RING_POINTS = 8;

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
  TRACER_SPEED: 900, // m/s (visual only)
  /** Server-side leniency on top of RANGE, for latency. */
  SERVER_RANGE: 2000,
  /** Token bucket: refill per second and capacity. */
  TOKENS_PER_SEC: 12,
  TOKEN_CAPACITY: 15,
  /** A hit is only counted if both players reported state this recently. */
  STATE_FRESH_MS: 1500,
} as const;

// --- NPCs -----------------------------------------------------------------

export const NPC_COUNT = 2;

/** Deliberately desaturated gunmetal: grey-vs-colour reads instantly in the sky. */
export const BOT_COLORS = [0x9099a8, 0x5f6875];
export const BOT_NAMES = ['Robot-1', 'Robot-2'];

export const NPC = {
  /**
   * Metres above the ELLIPSOID that NPCs treat as the ground. The server has no
   * terrain data, so this is a hand-set floor for the current WORLD_CENTER
   * (Helsinki: geoid separation ~+19 m, tallest structure ~134 m). FLIGHT.MIN_AGL
   * stacks on top, so NPCs bottom out around 240 m. Moving the world means
   * revisiting this number.
   */
  GROUND_ALT: 120,
  /** Soft band: outside it the AI biases its pitch back toward the middle. */
  MIN_ALT: 350,
  MAX_ALT: 3000,
  /**
   * When a bot bothers pulling the trigger. This is NOT a skill knob -- it is the
   * floor of what the controller can physically hold: bang-bang steering at 20 Hz
   * with a 0.06 rad roll deadband means the nose is never steadier than ~3.4 deg,
   * and it wanders far wider than that while manoeuvring.
   *
   * Measured, tightening it destroys the bots rather than challenging them:
   *   cone 17 deg -> easy survives, medium 16 s, hard 13 s to kill (good)
   *   cone 15/9/6 deg by tier -> 1-4 hits in 90 s at every tier, nobody dies
   *   full human tube (25 m at range on RASKE, ~3 deg) -> zero hits in 90 s
   * So bot SKILL lives in aimError, hitChance and fireIntervalMs, not here.
   */
  FIRE_CONE: 0.3, // rad, ~17 deg
  /** Two bots closer than this nudge apart, so they don't fly as one plane. */
  SEPARATION_M: 250,
  /** Chase leash: beyond LEASH_M head home until back inside LEASH_HOME_M. */
  LEASH_M: 12000,
  LEASH_HOME_M: 8000,
  RESPAWN_MS: 5000, // longer than a human's, so the kid gets a victory lap
  /** Grace period after respawning during which bots hold fire. */
  SPAWN_GRACE_MS: 2000,
} as const;

export type Difficulty = 'easy' | 'medium' | 'hard';
export const DEFAULT_DIFFICULTY: Difficulty = 'easy';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/**
 * NPC skill. Read fresh every tick, and no bot state is derived from it, so a
 * mid-game change applies instantly with nothing to migrate -- do not cache this
 * into a tuning object.
 *
 * A player at 130 m/s in a full 60 deg bank turns in 989 m, and out-ranges every
 * tier (COMBAT.RANGE is 1500 m), so running away always works.
 *
 * MEASURED against a scripted target flying a lazy 2 km circle at 130 m/s
 * (test/npc.mjs drives this): easy never killed it in 120 s, medium ~16 s,
 * hard ~13 s. Re-measure after touching any of these numbers -- the paper
 * arithmetic was off by an order of magnitude because a bang-bang controller
 * only holds a firing solution a few percent of the time.
 */
export const DIFFICULTY = {
  easy: {
    // Your OWN aim tube, metres. Bigger = your bullets forgive a sloppier line-up,
    // so the setting changes player-vs-player as much as it changes the robots.
    // 65 m is ~7.4 deg at 500 m; 25 m is ~2.9 deg.
    hitRadius: 65,
    turnFactor: 0.7, // x FLIGHT.MAX_BANK -> 42 deg -> 1363 m turn radius
    aimError: 0.2, // rad (11 deg) -- the nose wanders well off target
    fireIntervalMs: 600,
    hitChance: 0.45,
    range: 1000,
    decisionMs: 900, // also the reaction delay: it chases a stale bearing between decisions
    leadSeconds: 0, // pure pursuit: always ends up behind you, easy to shake
    maxSpeed: 165, // well under the player's 220, so you can always run away
    cruise: 130,
    turnSpeed: 110, // slows in hard turns -- radius is v^2/(g tan bank)
    evadeAt: 4,
    evadeMs: 3500,
  },
  medium: {
    hitRadius: 40,
    turnFactor: 0.85, // 51 deg -> 906 m
    aimError: 0.09,
    fireIntervalMs: 320,
    hitChance: 0.6,
    range: 1100,
    decisionMs: 550,
    leadSeconds: 0.8,
    maxSpeed: 180,
    cruise: 145,
    turnSpeed: 105,
    evadeAt: 6,
    evadeMs: 2500,
  },
  hard: {
    hitRadius: 25,
    turnFactor: 1.0, // 60 deg -> 528 m, out-turns the player 2:1
    aimError: 0.025,
    fireIntervalMs: 190,
    hitChance: 0.8,
    range: 1200,
    decisionMs: 300,
    leadSeconds: 1.2,
    maxSpeed: 210,
    cruise: 165,
    turnSpeed: 95,
    evadeAt: 8,
    evadeMs: 1500,
  },
} as const;

export type Tuning = (typeof DIFFICULTY)[Difficulty];

/**
 * Best case hits per second with the target perfectly lined up the whole time.
 *
 * This is THE guarantee that a robot is always a worse shot than a person, at every
 * difficulty: a lined-up human lands every single round, while a bot must still pass
 * hitChance, which is below 1 on every tier. The margin is large -- 13x on KERGE,
 * 2.4x even on RASKE -- and in practice much larger still, because a bot only holds
 * a firing solution a few percent of the time while a player can simply aim.
 *
 * It is expressed here rather than as a tighter gunsight because the gunsight route
 * was tried and measured: it does not make bots harder, it makes them harmless
 * (see NPC.FIRE_CONE). test/npc.mjs asserts this holds for every tier.
 */
export function botMaxHitsPerSec(d: Tuning): number {
  return (1000 / d.fireIntervalMs) * d.hitChance;
}

export function humanMaxHitsPerSec(): number {
  return 1 / COMBAT.FIRE_INTERVAL;
}

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  easy: 'KERGE',
  medium: 'KESKMINE',
  hard: 'RASKE',
};

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
  /** True for server-controlled NPCs. Only affects how the client draws them. */
  bot: boolean;
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
  | { t: 'respawn' }
  | { t: 'difficulty'; level: Difficulty };

// --- Server -> client ---

export type ServerMsg =
  | {
      t: 'welcome';
      id: string;
      name: string;
      color: number;
      players: PlayerInfo[];
      spawn: Spawn;
      difficulty: Difficulty;
    }
  | { t: 'difficulty'; level: Difficulty; by: string }
  | { t: 'joined'; player: PlayerInfo }
  | { t: 'left'; id: string }
  | { t: 'snapshot'; ts: number; players: SnapEntry[] }
  | { t: 'hit'; targetId: string; shooterId: string; hits: number }
  | { t: 'death'; id: string; killerId: string }
  | ({ t: 'respawned'; id: string } & Spawn)
  | { t: 'error'; code: 'full' | 'badname'; message: string };

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
