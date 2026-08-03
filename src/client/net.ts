import { Quaternion, Vector3 } from 'three';
import {
  DEFAULT_DIFFICULTY,
  INTERP_DELAY_MS,
  type ClientMsg,
  type Difficulty,
  type PlayerInfo,
  type ServerMsg,
  type SnapEntry,
  type Spawn,
} from '../shared/protocol';
import { poseToTransform } from './geo';

interface Sample {
  t: number;
  pos: Vector3;
  quat: Quaternion;
  fire: boolean;
}

export interface Remote {
  info: PlayerInfo;
  buf: Sample[];
  /** Latest interpolated transform, written by sampleRemote each frame. */
  pos: Vector3;
  quat: Quaternion;
  firing: boolean;
  /** True once at least one snapshot has arrived. */
  seen: boolean;
}

export interface NetHandlers {
  onWelcome(id: string, name: string, color: number, spawn: Spawn): void;
  onRoster(): void;
  onDifficulty(level: Difficulty, by: string | null): void;
  onHit(targetId: string, shooterId: string, hits: number): void;
  onDeath(id: string, killerId: string): void;
  onRespawned(id: string, spawn: Spawn): void;
  onError(message: string): void;
  onClosed(): void;
}

export class Net {
  ws: WebSocket | null = null;
  myId = '';
  myName = '';
  myColor = 0xffffff;
  difficulty: Difficulty = DEFAULT_DIFFICULTY;
  remotes = new Map<string, Remote>();

  private clockOffset: number | null = null;
  private handlers: NetHandlers;
  private name: string;
  private closedByServer = false;

  constructor(name: string, handlers: NetHandlers) {
    this.name = name;
    this.handlers = handlers;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.addEventListener('open', () => this.send({ t: 'join', name: this.name }));
    ws.addEventListener('message', (e) => this.onMessage(e.data));
    ws.addEventListener('close', () => {
      if (!this.closedByServer) this.handlers.onClosed();
    });
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private onMessage(raw: string) {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      case 'welcome': {
        this.myId = msg.id;
        this.myName = msg.name;
        this.myColor = msg.color;
        this.difficulty = msg.difficulty;
        for (const p of msg.players) this.addRemote(p);
        this.handlers.onWelcome(msg.id, msg.name, msg.color, msg.spawn);
        this.handlers.onDifficulty(msg.difficulty, null);
        this.handlers.onRoster();
        break;
      }
      case 'difficulty':
        this.difficulty = msg.level;
        this.handlers.onDifficulty(msg.level, msg.by);
        break;
      case 'joined':
        this.addRemote(msg.player);
        this.handlers.onRoster();
        break;
      case 'left':
        this.remotes.delete(msg.id);
        this.handlers.onRoster();
        break;
      case 'snapshot':
        this.onSnapshot(msg.ts, msg.players);
        break;
      case 'hit': {
        const r = this.remotes.get(msg.targetId);
        if (r) r.info.hits = msg.hits;
        this.handlers.onHit(msg.targetId, msg.shooterId, msg.hits);
        this.handlers.onRoster();
        break;
      }
      case 'death': {
        const r = this.remotes.get(msg.id);
        if (r) r.info.alive = false;
        this.handlers.onDeath(msg.id, msg.killerId);
        this.handlers.onRoster();
        break;
      }
      case 'respawned': {
        const r = this.remotes.get(msg.id);
        if (r) {
          r.info.alive = true;
          r.info.hits = 0;
          r.buf.length = 0;
          r.seen = false;
        }
        this.handlers.onRespawned(msg.id, {
          lat: msg.lat,
          lon: msg.lon,
          alt: msg.alt,
          hdg: msg.hdg,
        });
        this.handlers.onRoster();
        break;
      }
      case 'error':
        this.closedByServer = true;
        this.handlers.onError(msg.message);
        break;
    }
  }

  private addRemote(info: PlayerInfo) {
    if (info.id === this.myId) return;
    this.remotes.set(info.id, {
      info,
      buf: [],
      pos: new Vector3(),
      quat: new Quaternion(),
      firing: false,
      seen: false,
    });
  }

  private onSnapshot(ts: number, entries: SnapEntry[]) {
    // Min-filter clock offset: no ping round-trip needed.
    const off = ts - performance.now();
    this.clockOffset =
      this.clockOffset === null ? off : Math.min(this.clockOffset, off) * 0.98 + off * 0.02;

    for (const e of entries) {
      if (e.id === this.myId) continue;
      const r = this.remotes.get(e.id);
      if (!r) continue;

      // Convert to ECEF on receipt: interpolating lat/lon breaks at the antimeridian,
      // interpolating Cartesian positions does not.
      const pos = new Vector3();
      const quat = new Quaternion();
      poseToTransform(e.lat, e.lon, e.alt, e.hdg, e.pit, e.rol, pos, quat);
      r.buf.push({ t: ts, pos, quat, fire: e.fire === 1 });
      if (r.buf.length > 12) r.buf.shift();
      r.seen = true;
    }
  }

  /** Server time we should be rendering right now. */
  renderTime(): number {
    if (this.clockOffset === null) return performance.now();
    return performance.now() + this.clockOffset - INTERP_DELAY_MS;
  }

  /** Advance every remote to renderTime. Returns nothing; writes r.pos / r.quat. */
  interpolate() {
    const t = this.renderTime();
    for (const r of this.remotes.values()) sampleRemote(r, t);
  }
}

const _delta = new Vector3();

function sampleRemote(r: Remote, renderTime: number) {
  const b = r.buf;
  if (b.length === 0) return;

  if (renderTime <= b[0].t) {
    r.pos.copy(b[0].pos);
    r.quat.copy(b[0].quat);
    r.firing = b[0].fire;
    return;
  }

  for (let i = b.length - 1; i > 0; i--) {
    if (b[i - 1].t <= renderTime && renderTime <= b[i].t) {
      const a = (renderTime - b[i - 1].t) / Math.max(1, b[i].t - b[i - 1].t);
      r.pos.lerpVectors(b[i - 1].pos, b[i].pos, a);
      r.quat.copy(b[i - 1].quat).slerp(b[i].quat, a);
      r.firing = b[i].fire;
      return;
    }
  }

  // Buffer ran dry (packet loss or a stall): extrapolate, but only briefly.
  const last = b[b.length - 1];
  r.quat.copy(last.quat);
  r.firing = last.fire;
  if (b.length >= 2) {
    const prev = b[b.length - 2];
    const seg = Math.max(1, last.t - prev.t);
    const ahead = Math.min(renderTime - last.t, 250) / seg;
    _delta.subVectors(last.pos, prev.pos);
    r.pos.copy(last.pos).addScaledVector(_delta, ahead);
  } else {
    r.pos.copy(last.pos);
  }
}
