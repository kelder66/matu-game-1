import { FLIGHT } from '../shared/protocol';
import type { Input } from './input';

const EARTH_R = 6378137;

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

  // Roll: the keys command a bank angle, the aircraft eases toward it.
  const bankCmd = (i.right ? 1 : 0) - (i.left ? 1 : 0);
  if (bankCmd !== 0) {
    const target = bankCmd * FLIGHT.MAX_BANK;
    const step = FLIGHT.ROLL_RATE * dt;
    s.roll += clamp(target - s.roll, -step, step);
  } else {
    const step = FLIGHT.ROLL_RECENTER * dt; // auto-level, forgiving for a kid
    s.roll -= clamp(s.roll, -step, step);
  }

  // Pitch.
  const pitchCmd = (i.up ? 1 : 0) - (i.down ? 1 : 0);
  if (pitchCmd !== 0) s.pitch += pitchCmd * FLIGHT.PITCH_RATE * dt;
  else s.pitch -= s.pitch * (1 - Math.exp(-FLIGHT.PITCH_RECENTER * dt));
  s.pitch = clamp(s.pitch, -FLIGHT.MAX_PITCH, FLIGHT.MAX_PITCH);

  // Bank turns the heading: coordinated-turn rate, so one key does bank + turn.
  const turnRate = (FLIGHT.G * Math.tan(s.roll)) / Math.max(s.speed, 1);
  s.heading = wrapPi(s.heading + turnRate * dt);

  // Throttle.
  const thr = (i.faster ? 1 : 0) - (i.slower ? 1 : 0);
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
