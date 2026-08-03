import { PerspectiveCamera, Vector3 } from 'three';
import { DIFFICULTY_LABEL, MAX_HITS, RAD2DEG, type Difficulty } from '../shared/protocol';
import type { FlightState } from '../shared/flight';
import { Minimap } from './minimap';
import type { Remote } from './net';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// Defensive default: a missing colour used to throw here and blank the whole HUD.
const hex = (c: number) => '#' + (c ?? 0xffffff).toString(16).padStart(6, '0');

export class Hud {
  private pips = $('pips');
  private roster = $('roster');
  private speed = $('speed');
  private alt = $('alt');
  private attribution = $('attribution');
  private nametagRoot = $('nametags');
  private crosshair = $('crosshair');
  private arrow = $('arrow');
  private arrowGlyph = $('arrowGlyph');
  private arrowDist = $('arrowDist');
  private hitFlash = $('hitFlash');
  private diffBadge = $('diffBadge');
  private minimap = new Minimap($<HTMLCanvasElement>('minimap'));

  private tags = new Map<string, HTMLElement>();
  private flashUntil = 0;
  private lockUntil = 0;
  private diffFlashUntil = 0;

  constructor() {
    for (let i = 0; i < MAX_HITS; i++) {
      const el = document.createElement('div');
      el.className = 'pip';
      this.pips.appendChild(el);
    }
  }

  setDifficulty(level: Difficulty, by: string | null) {
    this.diffBadge.textContent = by
      ? `${by} valis: ${DIFFICULTY_LABEL[level]}`
      : `RASKUS: ${DIFFICULTY_LABEL[level]}`;
    if (by) {
      this.diffBadge.classList.add('changed');
      this.diffFlashUntil = performance.now() + 1600;
    }
  }

  setOffline() {
    $('offlineBadge').classList.remove('hidden');
  }

  setHits(hits: number) {
    const remaining = MAX_HITS - hits;
    this.pips.childNodes.forEach((n, i) => {
      (n as HTMLElement).classList.toggle('gone', i >= remaining);
    });
  }

  /** Red vignette when we take a hit. */
  flashDamage() {
    this.flashUntil = performance.now() + 160;
    this.hitFlash.classList.add('on');
  }

  /** Crosshair turns red when we land one. */
  flashLock() {
    this.lockUntil = performance.now() + 120;
    this.crosshair.classList.add('locked');
  }

  setRoster(
    rows: {
      name: string;
      color: number;
      hits: number;
      alive: boolean;
      me: boolean;
      bot: boolean;
    }[],
  ) {
    this.roster.replaceChildren();
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'rosterRow' + (r.alive ? '' : ' dead');

      const hp = document.createElement('span');
      hp.className = 'hp';
      hp.textContent = r.alive ? `${MAX_HITS - r.hits}/${MAX_HITS}` : '💥';

      const name = document.createElement('span');
      name.textContent = r.me ? `${r.name} (sina)` : r.bot ? `🤖 ${r.name}` : r.name;

      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = hex(r.color);

      row.append(hp, name, sw);
      this.roster.appendChild(row);
    }
  }

  setReadout(speedMs: number, altAgl: number) {
    this.speed.textContent = String(Math.round(speedMs * 3.6));
    this.alt.textContent = String(Math.round(altAgl));
  }

  setAttribution(text: string) {
    if (this.attribution.textContent !== text) this.attribution.textContent = text;
  }

  /**
   * Nametags and the off-screen direction arrow. Without the arrow a kid spends the
   * whole session alone over Estonia.
   */
  update(
    camera: PerspectiveCamera,
    myPos: Vector3,
    state: FlightState,
    remotes: Map<string, Remote>,
  ) {
    const now = performance.now();
    if (this.flashUntil && now > this.flashUntil) {
      this.flashUntil = 0;
      this.hitFlash.classList.remove('on');
    }
    if (this.lockUntil && now > this.lockUntil) {
      this.lockUntil = 0;
      this.crosshair.classList.remove('locked');
    }
    if (this.diffFlashUntil && now > this.diffFlashUntil) {
      this.diffFlashUntil = 0;
      this.diffBadge.classList.remove('changed');
    }

    this.minimap.draw(state, myPos, remotes);

    const w = window.innerWidth;
    const h = window.innerHeight;
    const p = new Vector3();

    let nearest: { pos: Vector3; dist: number } | null = null;

    // Drop tags for players who left.
    for (const [id, el] of this.tags) {
      if (!remotes.has(id)) {
        el.remove();
        this.tags.delete(id);
      }
    }

    for (const [id, r] of remotes) {
      let el = this.tags.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'nametag';
        el.innerHTML = '<span></span><div class="bar"><i></i></div>';
        this.nametagRoot.appendChild(el);
        this.tags.set(id, el);
      }

      if (!r.seen || !r.info.alive) {
        el.style.display = 'none';
        continue;
      }

      const dist = myPos.distanceTo(r.pos);
      if (!nearest || dist < nearest.dist) nearest = { pos: r.pos, dist };

      p.copy(r.pos).project(camera);
      const onScreen = p.z < 1 && Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && dist < 6000;
      if (!onScreen) {
        el.style.display = 'none';
        continue;
      }

      el.style.display = 'block';
      el.style.color = hex(r.info.color);
      // transform keeps this on the compositor; left/top would not.
      el.style.transform = `translate(-50%, -50%) translate(${(p.x * 0.5 + 0.5) * w}px, ${
        (-p.y * 0.5 + 0.5) * h
      }px)`;
      (el.firstChild as HTMLElement).textContent = `${r.info.name}  ${Math.round(dist)}m`;
      const frac = Math.max(0, (MAX_HITS - r.info.hits) / MAX_HITS);
      ((el.lastChild as HTMLElement).firstChild as HTMLElement).style.width = `${frac * 100}%`;
    }

    this.updateArrow(camera, nearest, w, h);
  }

  private updateArrow(
    camera: PerspectiveCamera,
    nearest: { pos: Vector3; dist: number } | null,
    w: number,
    h: number,
  ) {
    if (!nearest) {
      this.arrow.classList.add('hidden');
      return;
    }

    const p = nearest.pos.clone().project(camera);
    const behind = p.z > 1;
    const onScreen = !behind && Math.abs(p.x) < 0.92 && Math.abs(p.y) < 0.92;
    if (onScreen) {
      this.arrow.classList.add('hidden');
      return;
    }

    // Flip the projection when the target is behind the camera.
    let x = p.x;
    let y = p.y;
    if (behind) {
      x = -x;
      y = -y;
    }

    const angle = Math.atan2(y, x);
    const radius = Math.min(w, h) * 0.34;
    const px = Math.cos(angle) * radius;
    const py = -Math.sin(angle) * radius;

    this.arrow.classList.remove('hidden');
    this.arrow.style.transform = `translate(-50%, -50%) translate(${px}px, ${py}px)`;
    // Rotate only the glyph, so the distance label stays readable.
    this.arrowGlyph.style.transform = `rotate(${90 - angle * RAD2DEG}deg)`;
    this.arrowDist.textContent = `${Math.round(nearest.dist)}m`;
  }
}
