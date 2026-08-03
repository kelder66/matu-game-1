import { Group, Quaternion, Vector3 } from 'three';
import { COMBAT, TICK_MS, type Spawn } from '../shared/protocol';
import { createFlightState, integrate, type FlightState } from './flight';
import { applyPose } from './geo';
import { Hud } from './hud';
import { initInput, input } from './input';
import { Explosions, Tracers, findTarget, muzzlePoint } from './combat';
import { Net, type Remote } from './net';
import { buildPlane } from './plane';
import { createWorld, type World3D } from './scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let world: World3D;
let net: Net;
let hud: Hud;
let tracers: Tracers;
let explosions: Explosions;

let state: FlightState;
let myPlane: Group;
let alive = true;
let myHits = 0;

const remotePlanes = new Map<string, Group>();

// Scratch vectors, reused every frame.
const forward = new Vector3();
const muzzle = new Vector3();
const worldUp = new Vector3();
const tmpQuat = new Quaternion();

let fireCooldown = 0;
let stateAccum = 0;
let lastTime = 0;

// --- Bootstrap ---

async function main() {
  const cfg = await fetch('/api/config')
    .then((r) => r.json())
    .catch(() => ({ googleMapsApiKey: null }));

  const canvas = $<HTMLCanvasElement>('canvas');
  world = createWorld(canvas, cfg.googleMapsApiKey);
  hud = new Hud();
  if (!cfg.googleMapsApiKey) hud.setOffline();

  tracers = new Tracers(world.scene);
  explosions = new Explosions(world.scene);

  initInput();
  window.addEventListener('resize', () => world.resize());

  const nameInput = $<HTMLInputElement>('name');
  nameInput.value = localStorage.getItem('pilotName') || '';
  nameInput.focus();

  $('fly').addEventListener('click', () => startGame(nameInput.value));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startGame(nameInput.value);
  });
  $('again').addEventListener('click', () => net.send({ t: 'respawn' }));
}

function startGame(rawName: string) {
  const name = rawName.trim() || 'Piloot';
  localStorage.setItem('pilotName', name);

  net = new Net(name, {
    onWelcome: (_id, _name, color, spawn) => {
      $('start').classList.add('hidden');
      $('hud').classList.remove('hidden');
      myPlane = buildPlane(color);
      world.scene.add(myPlane);
      respawnSelf(spawn);
      // Add ?debug to the URL to poke at the scene from the console.
      if (location.search.includes('debug')) {
        (window as unknown as { game: unknown }).game = { world, net, myPlane, get state() {
          return state;
        } };
      }
      lastTime = performance.now();
      requestAnimationFrame(frame);
    },
    onRoster: refreshRoster,
    onHit: (targetId, _shooterId, hits) => {
      if (targetId === net.myId) {
        myHits = hits;
        hud.setHits(hits);
        hud.flashDamage();
      }
    },
    onDeath: (id) => {
      if (id === net.myId) {
        alive = false;
        explodeAt(myPlane.position);
        myPlane.visible = false;
        $('killedBy').textContent = 'Said 10 tabamust.';
        $('dead').classList.remove('hidden');
      } else {
        const r = net.remotes.get(id);
        if (r) explodeAt(r.pos);
        const p = remotePlanes.get(id);
        if (p) p.visible = false;
      }
    },
    onRespawned: (id, spawn) => {
      if (id === net.myId) {
        $('dead').classList.add('hidden');
        respawnSelf(spawn);
      } else {
        const p = remotePlanes.get(id);
        if (p) p.visible = true;
      }
    },
    onError: (message) => {
      $('startError').textContent = message;
    },
    onClosed: () => {
      $('lost').classList.remove('hidden');
    },
  });

  net.connect();
}

function respawnSelf(spawn: Spawn) {
  state = createFlightState(spawn.lat, spawn.lon, spawn.alt, spawn.hdg);
  alive = true;
  myHits = 0;
  hud.setHits(0);
  if (myPlane) {
    myPlane.visible = true;
    applyPose(myPlane, state);
  }
  // Otherwise the camera would swoop in from wherever it last was.
  world.snapCamera();
}

function explodeAt(at: Vector3) {
  explosions.spawn(at);
}

function refreshRoster() {
  const rows = [
    {
      name: net.myName,
      color: net.myColor,
      hits: myHits,
      alive,
      me: true,
    },
    ...[...net.remotes.values()].map((r) => ({
      name: r.info.name,
      color: r.info.color,
      hits: r.info.hits,
      alive: r.info.alive,
      me: false,
    })),
  ];
  hud.setRoster(rows);
}

// --- Frame loop ---

function frame(now: number) {
  requestAnimationFrame(frame);

  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  if (alive) {
    integrate(state, input, world.groundAlt, dt);
    applyPose(myPlane, state);
  }

  net.interpolate();
  updateRemotePlanes();

  if (alive) shoot(dt);
  tracers.update(dt);
  explosions.update(dt);

  // Your own plane is never interpolated -- the camera follows local state, so the
  // controls have zero latency regardless of ping.
  world.update(state, dt);

  hud.update(world.camera, myPlane.position, net.remotes);
  hud.setReadout(state.speed, Math.max(0, state.alt - world.groundAlt));
  const attr = world.attributions();
  if (attr) hud.setAttribution(attr);

  // Report our state at the server tick rate, not once per frame.
  stateAccum += dt * 1000;
  if (stateAccum >= TICK_MS) {
    stateAccum = 0;
    if (alive) {
      net.send({
        t: 'state',
        lat: state.lat,
        lon: state.lon,
        alt: state.alt,
        hdg: state.heading,
        pit: state.pitch,
        rol: state.roll,
        spd: state.speed,
        fire: input.fire ? 1 : 0,
      });
    }
  }
}

function updateRemotePlanes() {
  for (const [id, r] of net.remotes) {
    let p = remotePlanes.get(id);
    if (!p) {
      p = buildPlane(r.info.color);
      remotePlanes.set(id, p);
      world.scene.add(p);
    }
    if (!r.seen || !r.info.alive) {
      p.visible = false;
      continue;
    }
    p.visible = true;
    p.position.copy(r.pos);
    p.quaternion.copy(r.quat);

    // Cosmetic tracers for other players; they never affect hit detection.
    if (r.firing && Math.random() < 0.5) {
      worldUp.set(0, 0, 1).applyQuaternion(r.quat);
      muzzlePoint(r.pos, r.quat, muzzle);
      tracers.spawn(muzzle, worldUp);
    }
  }

  // Remove planes for players who disconnected.
  for (const [id, p] of remotePlanes) {
    if (!net.remotes.has(id)) {
      world.scene.remove(p);
      remotePlanes.delete(id);
    }
  }
}

function shoot(dt: number) {
  fireCooldown -= dt;
  if (!input.fire || fireCooldown > 0) return;
  fireCooldown = COMBAT.FIRE_INTERVAL;

  tmpQuat.copy(myPlane.quaternion);
  forward.set(0, 0, 1).applyQuaternion(tmpQuat); // OBJECT_FRAME: +Z is forward
  muzzlePoint(myPlane.position, tmpQuat, muzzle);
  tracers.spawn(muzzle, forward);

  const targets = [...net.remotes.values()].map((r: Remote) => ({
    id: r.info.id,
    pos: r.pos,
    alive: r.info.alive,
    seen: r.seen,
  }));

  const hitId = findTarget(myPlane.position, forward, targets);
  if (hitId) {
    net.send({ t: 'hit', targetId: hitId });
    hud.flashLock(); // instant local feedback; the server decides the damage
  }
}

main();
