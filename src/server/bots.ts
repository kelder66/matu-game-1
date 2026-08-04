// NPC pilots. Pure functions over a small host interface -- no sockets, no three.js,
// no DOM. They fly the same `integrate()` the humans do, so they obey exactly the
// same physics and can never do something a player couldn't.
import {
  FLIGHT,
  NPC,
  SPAWN_AGL_M,
  DEG2RAD,
  type City,
  type Tuning,
  type WireState,
} from '../shared/protocol.js';
import { createInput, type FlightState, type Input } from '../shared/flight.js';

const EARTH_R = 6378137;

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export interface Bot {
  index: number;
  fs: FlightState;
  input: Input;
  targetId: string;
  /** Next time to re-pick a target and re-roll the aim error. */
  decideAt: number;
  fireAt: number;
  evadeUntil: number;
  aimBias: number;
  pitchBias: number;
  /** Distance/bearing to the other bot, refreshed each tick. */
  sibRange: number;
  sibBearing: number;
  firing: boolean;
}

/** Reused every tick -- this runs 40x/second and must not allocate. */
const _aim = { bearing: 0, elevation: 0, range: 0 };

/**
 * Bearing (rad from true north toward east) and elevation to a target, optionally
 * led by `lead` seconds of the target's velocity.
 *
 * This is the algebraic inverse of the position update inside `integrate()`
 * (dNorth = v*cos(pit)*cos(hdg)*dt, lat += dNorth/rEff, ...), so the bearing it
 * returns is exactly the heading `integrate()` would need. The flat tangent plane
 * is accurate to well under a degree at the ranges we fight at.
 */
export function aimAt(a: FlightState, t: WireState, lead: number) {
  const rEff = EARTH_R + a.alt;
  let dN = (t.lat - a.lat) * rEff;
  let dE = wrapPi(t.lon - a.lon) * rEff * Math.cos(a.lat);
  let dU = t.alt - a.alt;

  if (lead > 0) {
    const vh = t.spd * Math.cos(t.pit);
    dN += vh * Math.cos(t.hdg) * lead;
    dE += vh * Math.sin(t.hdg) * lead;
    dU += t.spd * Math.sin(t.pit) * lead;
  }

  const ground = Math.hypot(dN, dE);
  _aim.bearing = Math.atan2(dE, dN);
  _aim.elevation = Math.atan2(dU, Math.max(ground, 1));
  _aim.range = Math.hypot(ground, dU);
  return _aim;
}

/** Ground distance between two geodetic points, metres. */
export function groundRange(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dN = (b.lat - a.lat) * EARTH_R;
  const dE = wrapPi(b.lon - a.lon) * EARTH_R * Math.cos(a.lat);
  return Math.hypot(dN, dE);
}

/** Bearing only. Separate from aimAt so it can't clobber the shared scratch. */
export function bearingTo(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dN = (b.lat - a.lat) * EARTH_R;
  const dE = wrapPi(b.lon - a.lon) * EARTH_R * Math.cos(a.lat);
  return Math.atan2(dE, dN);
}

/** The world centre moves with the chosen city, so nothing may cache it. */
function home(city: City) {
  return { lat: city.lat * DEG2RAD, lon: city.lon * DEG2RAD, alt: city.groundAlt + SPAWN_AGL_M };
}

export function createBot(index: number, spawn: FlightState): Bot {
  return {
    index,
    fs: spawn,
    input: createInput(),
    targetId: '',
    decideAt: 0,
    fireAt: 0,
    evadeUntil: 0,
    aimBias: 0,
    pitchBias: 0,
    sibRange: Infinity,
    sibBearing: 0,
    firing: false,
  };
}

/**
 * Turn "the target is over there" into the seven booleans `integrate()` eats.
 * Bang-bang with a deadband, on purpose: the result moves like a kid on a keyboard
 * rather than like a guided missile.
 */
export function steer(
  b: Bot,
  aim: typeof _aim,
  d: Tuning,
  now: number,
  ground: number,
  targetSpd = 0,
) {
  const i = b.input;
  const evading = now < b.evadeUntil;

  // --- Heading, commanded through bank ---
  const want = evading ? aim.bearing + Math.PI : aim.bearing + b.aimBias;
  const hdgErr = wrapPi(want - b.fs.heading);

  const maxBank = FLIGHT.MAX_BANK * d.turnFactor;
  // 1.6 means a ~37 deg heading error already asks for full bank.
  let bankWant = clamp(hdgErr * 1.6, -maxBank, maxBank);

  // Only two bots, so wingman spacing is one special case rather than a flocking rule.
  if (b.sibRange < NPC.SEPARATION_M) {
    bankWant += wrapPi(b.sibBearing - b.fs.heading) > 0 ? -0.4 : 0.4;
    bankWant = clamp(bankWant, -maxBank, maxBank);
  }

  // Full deflection only: +1 eases roll toward +MAX_BANK, and +roll gives +turnRate
  // gives +heading. The 0.06 deadband stops the controls chattering every tick.
  // Deliberately still bang-bang -- the difficulty tiers are tuned against measured
  // behaviour, and going proportional here would invalidate all of it.
  i.roll = b.fs.roll < bankWant - 0.06 ? 1 : b.fs.roll > bankWant + 0.06 ? -1 : 0;

  // --- Pitch ---
  // In this flight model pitch is world-referenced (alt += speed*sin(pitch)*dt,
  // regardless of bank), so aiming the nose at the target's elevation angle is
  // literally correct -- no bank-to-pitch compensation needed.
  let bias = b.pitchBias + (evading ? 0.2 : 0);
  const floor = ground + NPC.MIN_AGL;
  const ceiling = ground + NPC.MAX_AGL;
  if (b.fs.alt < floor) bias += (floor - b.fs.alt) / 300;
  if (b.fs.alt > ceiling) bias -= (b.fs.alt - ceiling) / 300;

  const pitchWant = clamp(aim.elevation + bias, -FLIGHT.MAX_PITCH * 0.8, FLIGHT.MAX_PITCH * 0.8);
  i.pitch = b.fs.pitch < pitchWant - 0.04 ? 1 : b.fs.pitch > pitchWant + 0.04 ? -1 : 0;

  // --- Throttle ---
  // Turn radius is v^2/(g tan bank), so a faster bot turns wider. Bleeding speed is
  // honest physics and is what actually lets a bot hold a gun solution.
  //
  // Measured: cruising at 165 m/s gives a ~1600 m turn radius, so a bot sitting 400 m
  // from its target simply orbits it and never points the nose long enough to shoot.
  // Slowing inside CLOSE_M is what turns "circles impressively" into "actually a threat".
  const CLOSE_M = 700;
  const turning = Math.abs(hdgErr) > 0.6;

  let wantSpd: number;
  if (evading) {
    wantSpd = d.maxSpeed;
  } else if (turning) {
    wantSpd = d.turnSpeed;
  } else if (aim.range < CLOSE_M) {
    // Settle into a trailing gun position by MATCHING the target's speed rather than
    // flying a fixed number. Closing faster than the target only causes an overshoot,
    // after which the bot orbits at a radius wider than the range and never shoots.
    wantSpd = targetSpd > 0 ? targetSpd : d.turnSpeed;
  } else if (aim.range > 900) {
    wantSpd = d.maxSpeed;
  } else {
    wantSpd = d.cruise;
  }
  wantSpd = clamp(wantSpd, FLIGHT.SPEED_MIN, d.maxSpeed);

  i.throttle = b.fs.speed < wantSpd - 4 ? 1 : b.fs.speed > wantSpd + 4 ? -1 : 0;
}

export interface BotTarget {
  id: string;
  state: WireState;
}

/**
 * Re-pick a target and re-roll the aim error. Called every `decisionMs`, which is
 * what makes a slow tier feel slow: in between, the bot chases a stale bearing.
 */
export function decide(b: Bot, sibTargetId: string, candidates: BotTarget[], d: Tuning) {
  b.aimBias = (Math.random() * 2 - 1) * d.aimError;
  b.pitchBias = (Math.random() * 2 - 1) * d.aimError * 0.5;

  let bestId = '';
  let bestScore = Infinity;
  for (const c of candidates) {
    let score = groundRange(b.fs, c.state);
    if (c.id === sibTargetId) score *= 2.5; // don't both dogpile the same player
    if (c.id === b.targetId) score *= 0.8; // hysteresis: don't flip-flop
    if (score < bestScore) {
      bestScore = score;
      bestId = c.id;
    }
  }
  b.targetId = bestId;
}

/**
 * Vertical stagger, metres. With a single human both bots must pick the same target
 * (the anti-stacking score has nothing else to choose), and they converge to within
 * tens of metres, at which point the separation nudge permanently fights their own
 * pursuit and neither can hold a firing solution. Aiming at a point above/below the
 * target keeps them on different levels and attacking from different angles.
 */
export function stackOffset(index: number): number {
  return index === 0 ? 130 : -130;
}

/** A slowly orbiting point to circle when nobody is worth chasing. */
export function patrolTarget(index: number, now: number, city: City): WireState {
  const h = home(city);
  const ang = now / 30000 + (index * Math.PI) / 2;
  const r = 2500 / EARTH_R;
  return {
    lat: h.lat + Math.cos(ang) * r,
    lon: h.lon + (Math.sin(ang) * r) / Math.cos(h.lat),
    alt: h.alt,
    hdg: 0,
    pit: 0,
    rol: 0,
    spd: 0,
    fire: 0,
  };
}

/**
 * If a bot has been dragged too far from the play area, fly it home. Without this,
 * one player heading east takes both bots with him permanently.
 */
export function applyLeash(b: Bot, aim: typeof _aim, leashed: boolean, city: City): boolean {
  const h = home(city);
  const fromHome = groundRange(b.fs, h);
  if (!leashed && fromHome > NPC.LEASH_M) leashed = true;
  else if (leashed && fromHome < NPC.LEASH_HOME_M) leashed = false;

  if (leashed) {
    const back = aimAt(b.fs, {
      lat: h.lat, lon: h.lon, alt: h.alt,
      hdg: 0, pit: 0, rol: 0, spd: 0, fire: 0,
    }, 0);
    aim.bearing = back.bearing;
    aim.elevation = back.elevation;
    aim.range = back.range;
  }
  return leashed;
}

/**
 * Is the target lined up well enough to shoot? Skill lives in aimError (which biases
 * where the nose settles) and in the hitChance roll, not in this angle -- see the
 * measurements on NPC.FIRE_CONE.
 */
export function canFire(b: Bot, aim: typeof _aim, d: Tuning): boolean {
  if (aim.range > d.range) return false;
  const off = Math.hypot(wrapPi(aim.bearing - b.fs.heading), aim.elevation - b.fs.pitch);
  return off <= NPC.FIRE_CONE;
}

export { wrapPi };
