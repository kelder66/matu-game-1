// Shared by the browser and the server (the NPCs fly with this exact model).
// No three.js and no DOM in here -- this file compiles into the server bundle,
// where `three` is only a devDependency and DOM types do not exist.
import { FLIGHT } from './protocol.js';

const EARTH_R = 6378137;

/**
 * What the flight model reads each step. Keyboard and touch on the client, AI on
 * the server.
 *
 * Axes are analog in [-1, 1] rather than boolean pairs, so a thumbstick can command
 * a gentle bank. A key (or the AI) simply pushes the axis to a full +/-1, which is
 * arithmetically identical to the old boolean pairs -- worth knowing, because the
 * NPC difficulty tiers are tuned against measured behaviour that must not shift.
 */
export interface Input {
  /** + = bank right, - = bank left. */
  roll: number;
  /** + = nose up, - = nose down. */
  pitch: number;
  /** + = faster, - = slower. */
  throttle: number;
  fire: boolean;
}

export function createInput(): Input {
  return { roll: 0, pitch: 0, throttle: 0, fire: false };
}

export interface FlightState {
  lat: number; // radians, geodetic
  lon: number; // radians
  alt: number; // metres above the ellipsoid
  heading: number; // radians, azimuth from true north toward east
  pitch: number; // radians, nose-up positive
  roll: number; // radians, bank
  speed: number; // m/s along the body forward axis
}

export function createFlightState(
  lat: number,
  lon: number,
  alt: number,
  heading: number,
): FlightState {
  return { lat, lon, alt, heading, pitch: 0, roll: 0, speed: FLIGHT.SPEED_DEFAULT };
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Arcade flight, integrated per second. Everything here is dt-based on purpose:
 * a fixed per-frame step makes the plane fly twice as fast on a 120 Hz screen.
 */
export function integrate(s: FlightState, i: Input, groundAlt: number, dt: number) {
  dt = Math.min(dt, 0.1); // a backgrounded tab must not teleport us through the planet

  // Roll: the stick commands a bank angle, the aircraft eases toward it. A key or
  // the AI pushes this to +/-1, giving exactly the old full-deflection behaviour.
  const bankCmd = clamp(i.roll, -1, 1);
  if (bankCmd !== 0) {
    const target = bankCmd * FLIGHT.MAX_BANK;
    const step = FLIGHT.ROLL_RATE * dt;
    s.roll += clamp(target - s.roll, -step, step);
  } else {
    const step = FLIGHT.ROLL_RECENTER * dt; // auto-level, forgiving for a kid
    s.roll -= clamp(s.roll, -step, step);
  }

  // Pitch.
  const pitchCmd = clamp(i.pitch, -1, 1);
  if (pitchCmd !== 0) s.pitch += pitchCmd * FLIGHT.PITCH_RATE * dt;
  else s.pitch -= s.pitch * (1 - Math.exp(-FLIGHT.PITCH_RECENTER * dt));
  s.pitch = clamp(s.pitch, -FLIGHT.MAX_PITCH, FLIGHT.MAX_PITCH);

  // Bank turns the heading: coordinated-turn rate, so one key does bank + turn.
  const turnRate = (FLIGHT.G * Math.tan(s.roll)) / Math.max(s.speed, 1);
  s.heading = wrapPi(s.heading + turnRate * dt);

  // Throttle.
  const thr = clamp(i.throttle, -1, 1);
  s.speed = clamp(
    s.speed + thr * FLIGHT.THROTTLE_ACCEL * dt,
    FLIGHT.SPEED_MIN,
    FLIGHT.SPEED_MAX,
  );

  // Position: velocity in the local ENU frame, converted metres -> radians.
  const vh = s.speed * Math.cos(s.pitch);
  const dNorth = vh * Math.cos(s.heading) * dt;
  const dEast = vh * Math.sin(s.heading) * dt;
  s.alt += s.speed * Math.sin(s.pitch) * dt;

  const rEff = EARTH_R + s.alt;
  s.lat = clamp(s.lat + dNorth / rEff, -FLIGHT.MAX_LAT, FLIGHT.MAX_LAT);
  s.lon = wrapPi(s.lon + dEast / (rEff * Math.cos(s.lat)));

  // Terrain is a soft floor, not a crash -- only bullets kill in this game.
  const floor = groundAlt + FLIGHT.MIN_AGL;
  if (s.alt < floor) {
    s.alt = floor;
    if (s.pitch < 0) s.pitch = 0;
  }
  if (s.alt > FLIGHT.MAX_ALT) {
    s.alt = FLIGHT.MAX_ALT;
    if (s.pitch > 0) s.pitch = 0;
  }
}
