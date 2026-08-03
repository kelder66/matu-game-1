import { Vector3 } from 'three';
import { WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { COMBAT } from '../shared/protocol';
import type { FlightState } from '../shared/flight';
import type { Remote } from './net';

const SIZE = 150; // css px
const R = 70; // radar radius in px
const RANGE_M = 4000; // whole engagement envelope fits well inside

const _east = new Vector3();
const _north = new Vector3();
const _up = new Vector3();
const _rel = new Vector3();

const hex = (c: number) => '#' + (c ?? 0xffffff).toString(16).padStart(6, '0');

/**
 * Nose-up radar. Canvas rather than DOM: a player who leaves is simply not drawn,
 * so there is no element map and no teardown path to get wrong.
 */
export class Minimap {
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = `${SIZE}px`;
    canvas.style.height = `${SIZE}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('minimap: no 2d context');
    // Fixed size, so this scale is set once and never touched again.
    ctx.scale(dpr, dpr);
    this.ctx = ctx;
  }

  draw(s: FlightState, myPos: Vector3, remotes: Map<string, Remote>) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.translate(SIZE / 2, SIZE / 2);

    this.drawRings();

    // One ENU basis per frame serves every contact.
    WGS84_ELLIPSOID.getEastNorthUpAxes(s.lat, s.lon, _east, _north, _up);
    // Heading is measured from north toward east, so forward is (sin h, cos h)
    // and the right wing is (cos h, -sin h) in the east/north plane.
    const c = Math.cos(s.heading);
    const sn = Math.sin(s.heading);
    const k = R / RANGE_M;

    for (const r of remotes.values()) {
      if (!r.seen || !r.info.alive) continue;

      _rel.subVectors(r.pos, myPos);
      const e = _rel.dot(_east);
      const n = _rel.dot(_north);
      const u = _rel.dot(_up); // positive = above me

      const fwd = n * c + e * sn;
      const right = -n * sn + e * c;

      let x = right * k;
      let y = -fwd * k; // canvas +y points down, the nose points up

      // Out-of-range contacts pin to the rim, so "someone is 6 km that way" still reads.
      const dist = Math.hypot(x, y);
      const off = dist > R - 6;
      if (off && dist > 0) {
        const f = (R - 6) / dist;
        x *= f;
        y *= f;
      }

      ctx.fillStyle = hex(r.info.color);
      ctx.strokeStyle = ctx.fillStyle;

      if (off) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.atan2(y, x) + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(0, -5);
        ctx.lineTo(4, 3);
        ctx.lineTo(-4, 3);
        ctx.closePath();
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
      } else if (r.info.bot) {
        // Shape as well as colour: a square always reads as "robot", even to a kid
        // who cannot tell two greys apart.
        ctx.fillRect(x - 3.5, y - 3.5, 7, 7);
        ctx.strokeStyle = '#ff5544';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Altitude chevron, with a deadband so it doesn't flicker in level flight.
      if (Math.abs(u) > 60) {
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillStyle = hex(r.info.color);
        ctx.fillText(u > 0 ? '▲' : '▼', x + 5, y + 3);
      }
    }

    // North tick: east 0, north 1 rotated into the nose-up frame.
    ctx.fillStyle = '#9fb6cc';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', -sn * (R - 9), -c * (R - 9));

    this.drawOwnShip();
    ctx.restore();
  }

  private drawRings() {
    const ctx = this.ctx;
    ctx.lineWidth = 1;

    for (const m of [2500, 4000]) {
      ctx.beginPath();
      ctx.arc(0, 0, (m / RANGE_M) * R, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff22';
      ctx.stroke();
    }

    // Gun range in red: inside this ring you can actually shoot.
    ctx.beginPath();
    ctx.arc(0, 0, (COMBAT.RANGE / RANGE_M) * R, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff4d4d55';
    ctx.stroke();
  }

  private drawOwnShip() {
    const ctx = this.ctx;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(4.5, 5);
    ctx.lineTo(0, 2.5);
    ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
  }
}
