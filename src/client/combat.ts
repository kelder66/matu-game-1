import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import { COMBAT } from '../shared/protocol';
import { MUZZLE_OFFSET } from './plane';

// --- Tracers -------------------------------------------------------------

const MAX_TRACERS = 48;
const TRACER_LEN = 40;

interface Tracer {
  origin: Vector3;
  dir: Vector3;
  dist: number;
  alive: boolean;
}

export class Tracers {
  private mesh: LineSegments;
  private positions: Float32Array;
  private pool: Tracer[] = [];
  private next = 0;

  constructor(scene: Scene) {
    this.positions = new Float32Array(MAX_TRACERS * 6);
    const geo = new BufferGeometry();
    const attr = new BufferAttribute(this.positions, 3);
    attr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', attr);

    this.mesh = new LineSegments(
      geo,
      new LineBasicMaterial({
        color: 0xffee88,
        transparent: true,
        opacity: 0.9,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    for (let i = 0; i < MAX_TRACERS; i++) {
      this.pool.push({
        origin: new Vector3(),
        dir: new Vector3(0, 0, 1),
        dist: 0,
        alive: false,
      });
    }
  }

  spawn(origin: Vector3, dir: Vector3) {
    const t = this.pool[this.next];
    this.next = (this.next + 1) % MAX_TRACERS;
    t.origin.copy(origin);
    t.dir.copy(dir).normalize();
    t.dist = 0;
    t.alive = true;
  }

  update(dt: number) {
    const p = this.positions;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.pool[i];
      const o = i * 6;
      if (!t.alive) {
        p[o] = p[o + 1] = p[o + 2] = p[o + 3] = p[o + 4] = p[o + 5] = 0;
        continue;
      }
      t.dist += COMBAT.TRACER_SPEED * dt;
      if (t.dist > COMBAT.RANGE) {
        t.alive = false;
        continue;
      }
      const head = t.dist;
      const tail = Math.max(0, t.dist - TRACER_LEN);
      p[o] = t.origin.x + t.dir.x * tail;
      p[o + 1] = t.origin.y + t.dir.y * tail;
      p[o + 2] = t.origin.z + t.dir.z * tail;
      p[o + 3] = t.origin.x + t.dir.x * head;
      p[o + 4] = t.origin.y + t.dir.y * head;
      p[o + 5] = t.origin.z + t.dir.z * head;
    }
    const attr = this.mesh.geometry.getAttribute('position') as BufferAttribute;
    attr.needsUpdate = true;
  }
}

/** Muzzle position in world space for a plane at pos/quat. */
const _muzzle = new Vector3();
export function muzzlePoint(pos: Vector3, quat: Quaternion, out: Vector3): Vector3 {
  _muzzle.set(MUZZLE_OFFSET.x, MUZZLE_OFFSET.y, MUZZLE_OFFSET.z).applyQuaternion(quat);
  return out.copy(pos).add(_muzzle);
}

// --- Explosions ----------------------------------------------------------

const PARTICLES = 80;
const EXPLOSION_LIFE = 1.4;
const SHOCK_LIFE = 0.45;
const SHOCK_MAX = 90;

interface Explosion {
  points: Points;
  shock: Mesh;
  velocities: Float32Array;
  base: Vector3;
  age: number;
  active: boolean;
}

export class Explosions {
  private pool: Explosion[] = [];

  constructor(scene: Scene) {
    for (let i = 0; i < 5; i++) {
      const positions = new Float32Array(PARTICLES * 3);
      const geo = new BufferGeometry();
      const attr = new BufferAttribute(positions, 3);
      attr.setUsage(DynamicDrawUsage);
      geo.setAttribute('position', attr);

      const points = new Points(
        geo,
        new PointsMaterial({
          color: 0xffaa33,
          // World-space metres. Larger than this fills the screen when it is your
          // own plane exploding 69 m from the chase camera.
          size: 6,
          sizeAttenuation: true,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      points.frustumCulled = false;
      points.visible = false;
      scene.add(points);

      const shock = new Mesh(
        new SphereGeometry(1, 12, 8),
        new MeshBasicMaterial({
          color: 0xffdd88,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
        }),
      );
      shock.visible = false;
      scene.add(shock);

      this.pool.push({
        points,
        shock,
        velocities: new Float32Array(PARTICLES * 3),
        base: new Vector3(),
        age: 0,
        active: false,
      });
    }
  }

  spawn(at: Vector3) {
    const e = this.pool.find((x) => !x.active) ?? this.pool[0];
    e.active = true;
    e.age = 0;
    e.base.copy(at);
    e.points.visible = true;
    e.shock.visible = true;
    e.shock.position.copy(at);

    for (let i = 0; i < PARTICLES; i++) {
      // Random direction on the unit sphere.
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const speed = 30 + Math.random() * 60;
      e.velocities[i * 3] = s * Math.cos(th) * speed;
      e.velocities[i * 3 + 1] = s * Math.sin(th) * speed;
      e.velocities[i * 3 + 2] = u * speed;
    }
    // Particle positions are stored relative to the explosion origin (see below).
    e.points.position.copy(at);
    const attr = e.points.geometry.getAttribute('position') as BufferAttribute;
    (attr.array as Float32Array).fill(0);
    attr.needsUpdate = true;
  }

  update(dt: number) {
    for (const e of this.pool) {
      if (!e.active) continue;
      e.age += dt;

      if (e.age >= EXPLOSION_LIFE) {
        e.active = false;
        e.points.visible = false;
        e.shock.visible = false;
        continue;
      }

      // Positions stay small and origin-relative; the group transform carries the
      // ECEF magnitude, which keeps float32 vertex data out of the 6.4e6 range.
      const attr = e.points.geometry.getAttribute('position') as BufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < PARTICLES * 3; i++) arr[i] += e.velocities[i] * dt;
      attr.needsUpdate = true;

      const t = e.age / EXPLOSION_LIFE;
      const pm = e.points.material as PointsMaterial;
      pm.opacity = 1 - t;
      pm.color = new Color(0xffaa33).lerp(new Color(0x883311), t);

      if (e.age < SHOCK_LIFE) {
        const st = e.age / SHOCK_LIFE;
        e.shock.scale.setScalar(1 + st * SHOCK_MAX);
        (e.shock.material as MeshBasicMaterial).opacity = 1 - st;
      } else {
        e.shock.visible = false;
      }
    }
  }
}

// --- Hit test ------------------------------------------------------------

const _rel = new Vector3();

/**
 * Sphere-cast down the nose. A narrow cone would be 52 m wide at 1500 m and feel
 * like a homing beam; a fixed-radius tube is honest and forgiving.
 */
export function findTarget(
  myPos: Vector3,
  forward: Vector3,
  targets: Iterable<{ id: string; pos: Vector3; alive: boolean; seen: boolean }>,
): string | null {
  let bestId: string | null = null;
  let bestDist = Infinity;

  for (const t of targets) {
    if (!t.alive || !t.seen) continue;
    _rel.subVectors(t.pos, myPos);
    const along = _rel.dot(forward);
    if (along <= 0 || along > COMBAT.RANGE) continue;
    const perp = Math.sqrt(Math.max(0, _rel.lengthSq() - along * along));
    if (perp > COMBAT.HIT_RADIUS) continue;
    if (along < bestDist) {
      bestDist = along;
      bestId = t.id;
    }
  }
  return bestId;
}
