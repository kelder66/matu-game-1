// Behaviour test for the NPC pilots. Start a server with NPCs first:
//   PORT=3100 npm start
//   node test/npc.mjs
// Asserts they fly sanely, hunt, respect the altitude band, stay leashed, and that
// difficulty changes take effect mid-flight.
//
// NOTE: this is a behaviour test over a live simulation with a random hit roll, so
// it is not perfectly deterministic -- roughly 1 run in 4 trips a damage-count
// assertion. Re-run before believing a failure; investigate if it fails twice.
// The structural assertions (altitude band, leash, separation, respawn) are stable.
import { WebSocket } from 'ws';
import {
  DIFFICULTIES,
  DIFFICULTY,
  botMaxHitsPerSec,
  humanMaxHitsPerSec,
} from '../dist/shared/protocol.js';

const URL = process.env.TEST_WS || 'ws://localhost:3100/ws';
const D = Math.PI / 180;
const EARTH_R = 6378137;
const HOME = { lat: 60.17 * D, lon: 24.94 * D };

let fails = 0;
const check = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function groundRange(a, b) {
  const dN = (b.lat - a.lat) * EARTH_R;
  const dE = wrapPi(b.lon - a.lon) * EARTH_R * Math.cos(a.lat);
  return Math.hypot(dN, dE);
}

class Client {
  constructor(name) {
    this.msgs = [];
    this.snaps = [];
    this.id = null;
    // Mirrors the SERVER's view of us. Only death/respawned may change it -- setting
    // it locally desyncs from the server, and the bots correctly ignore a dead duck,
    // which silently zeroes every damage measurement below.
    this.alive = true;
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => {
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'join', name })));
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.msgs.push(m);
        if (m.t === 'snapshot') this.snaps.push(m);
        if (m.t === 'welcome') {
          this.id = m.id;
          this.welcome = m;
          res(m);
        }
        // Keep flying: a dead duck is never shot at, which would silently zero out
        // every damage measurement below.
        if (m.t === 'death' && m.id === this.id) {
          this.alive = false;
          setTimeout(() => this.send({ t: 'respawn' }), 2200);
        }
        if (m.t === 'respawned' && m.id === this.id) this.alive = true;
        if (m.t === 'error') res(m);
      });
    });
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  /** Hold position so the bots have a stationary target to converge on. */
  hold(state) {
    this.holdState = state;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.alive) {
        this.send({ t: 'state', ...this.holdState, pit: 0, rol: 0, spd: 130, fire: 0 });
      }
    }, 50);
  }

  /**
   * Fly a lazy 2 km circle at 130 m/s, i.e. what a player actually does.
   * A stationary target is the pathological case for a pursuing aircraft -- a tight,
   * fast bot orbits it forever without ever sweeping its nose across it, so damage
   * comparisons made against a parked duck come out backwards.
   */
  circle(centre) {
    const R_M = 2000;
    const SPD = 130;
    let t = 0;
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      t += 0.05;
      const a = (t * SPD) / R_M;
      this.holdState = {
        lat: centre.lat + (Math.cos(a) * R_M) / EARTH_R,
        lon: centre.lon + (Math.sin(a) * R_M) / (EARTH_R * Math.cos(centre.lat)),
        alt: 900,
        hdg: a + Math.PI / 2,
      };
      if (this.alive) {
        this.send({ t: 'state', ...this.holdState, pit: 0, rol: 0, spd: SPD, fire: 0 });
      }
    }, 50);
  }
  bots() {
    const last = this.snaps[this.snaps.length - 1];
    if (!last) return [];
    const botIds = new Set(this.welcome.players.filter((p) => p.bot).map((p) => p.id));
    return last.players.filter((p) => botIds.has(p.id));
  }
  of(t) {
    return this.msgs.filter((m) => m.t === t);
  }
  close() {
    clearInterval(this.timer);
    this.ws.close();
  }
}

// --- 0. tuning invariants (pure arithmetic, no server needed) ---
// A robot must always be a worse shot than a person, at every difficulty.
for (const level of DIFFICULTIES) {
  const d = DIFFICULTY[level];
  check(
    `${level}: a bot can never out-shoot a human`,
    botMaxHitsPerSec(d) < humanMaxHitsPerSec(),
    `bot ${botMaxHitsPerSec(d).toFixed(2)}/s vs human ${humanMaxHitsPerSec().toFixed(1)}/s ` +
      `(${(humanMaxHitsPerSec() / botMaxHitsPerSec(d)).toFixed(1)}x margin)`,
  );
  check(`${level}: bot hit roll is never certain`, d.hitChance < 1, `hitChance ${d.hitChance}`);
  check(
    `${level}: a bot can never outrun or outrange a player`,
    d.maxSpeed < 220 && d.range < 1500,
    `speed ${d.maxSpeed}/220, range ${d.range}/1500`,
  );
}
// Difficulty must tighten the player's own gunsight, not just the robots.
check(
  'your aim tube shrinks as difficulty rises',
  DIFFICULTY.easy.hitRadius > DIFFICULTY.medium.hitRadius &&
    DIFFICULTY.medium.hitRadius > DIFFICULTY.hard.hitRadius,
  `${DIFFICULTY.easy.hitRadius} > ${DIFFICULTY.medium.hitRadius} > ${DIFFICULTY.hard.hitRadius} m`,
);

const a = new Client('Matu');
const w = await a.ready;

// --- 1. bots exist and are announced ---
const botInfos = w.players.filter((p) => p.bot);
check('two NPCs in the roster', botInfos.length === 2, `got ${w.players.length} players`);
check('NPCs have names', botInfos.every((b) => b.name.startsWith('Robot')));
check('NPCs have a colour', botInfos.every((b) => typeof b.color === 'number'));
check('NPCs are flagged bot:true', botInfos.every((b) => b.bot === true));
check('welcome carries difficulty', typeof w.difficulty === 'string', w.difficulty);

// Sit still 600 m east of the world centre at 900 m.
a.hold({ lat: HOME.lat, lon: HOME.lon + 600 / (EARTH_R * Math.cos(HOME.lat)), alt: 900, hdg: 0 });
await sleep(500);

check('NPCs appear in snapshots', a.bots().length === 2);

// --- 2. they fly: position changes ---
const p0 = a.bots().map((b) => ({ lat: b.lat, lon: b.lon }));
await sleep(1500);
const p1 = a.bots().map((b) => ({ lat: b.lat, lon: b.lon }));
const moved = p0.map((p, i) => groundRange(p, p1[i]));
check('NPCs are actually flying', moved.every((m) => m > 50), `moved ${moved.map(Math.round)} m in 1.5 s`);

// --- 3. they converge on the player ---
const dStart = a.bots().map((b) => groundRange(b, a.holdState));
await sleep(9000);
const dEnd = a.bots().map((b) => groundRange(b, a.holdState));
check(
  'NPCs close on the player',
  Math.min(...dEnd) < Math.min(...dStart) || Math.min(...dEnd) < 900,
  `start ${dStart.map(Math.round)} -> end ${dEnd.map(Math.round)} m`,
);

// --- 4. altitude band respected over a long sample ---
let altMin = Infinity;
let altMax = -Infinity;
let sepMin = Infinity;
let leashMax = 0;
for (let i = 0; i < 60; i++) {
  const bs = a.bots();
  for (const b of bs) {
    altMin = Math.min(altMin, b.alt);
    altMax = Math.max(altMax, b.alt);
    leashMax = Math.max(leashMax, groundRange(b, HOME));
  }
  if (bs.length === 2) sepMin = Math.min(sepMin, groundRange(bs[0], bs[1]));
  await sleep(200);
}
check('NPCs never dive into the ground', altMin >= 200, `min alt ${Math.round(altMin)} m`);
check('NPCs stay under the ceiling', altMax <= 3400, `max alt ${Math.round(altMax)} m`);
check('NPCs stay inside the leash', leashMax < 13000, `max ${Math.round(leashMax)} m from centre`);
check('NPCs do not fly as one plane', sepMin > 15, `closest approach ${Math.round(sepMin)} m`);

// --- 5. they shoot: the stationary player takes damage on easy ---
const myHits = a.of('hit').filter((h) => h.targetId === a.id);
check('NPCs land hits on a sitting duck', myHits.length > 0, `${myHits.length} hits in ~22 s`);
check(
  'NPC hits come from the NPCs',
  myHits.every((h) => h.shooterId.startsWith('npc-')),
);

// --- 6. difficulty round-trip ---
a.send({ t: 'difficulty', level: 'hard' });
await sleep(300);
const diff = a.of('difficulty');
check('difficulty change is broadcast', diff.length >= 1 && diff[diff.length - 1].level === 'hard');
check('broadcast names the changer', diff[diff.length - 1]?.by === 'Matu');

const beforeNoop = a.of('difficulty').length;
a.send({ t: 'difficulty', level: 'hard' }); // same value -> must not re-broadcast
await sleep(250);
check('no-op difficulty is not broadcast', a.of('difficulty').length === beforeNoop);

// --- 8. a player can kill an NPC, and it comes back ---
const victim = a.bots()[0];
if (victim) {
  for (let i = 0; i < 40 && a.of('death').length === 0; i++) {
    const b = a.bots().find((x) => x.id === victim.id);
    if (b) {
      a.holdState = { lat: b.lat, lon: b.lon, alt: b.alt, hdg: 0 }; // sit on top of it
      a.send({ t: 'hit', targetId: victim.id });
    }
    await sleep(120);
  }
  check('an NPC can be shot down', a.of('death').some((d) => d.id === victim.id));
  await sleep(6000);
  check('a downed NPC respawns', a.of('respawned').some((r) => r.id === victim.id));
}

a.close();
await sleep(1200); // let the bots forget `a` before measuring

// --- 9. hard hurts more than easy ---
// Runs LAST and only after `a` has disconnected: the bots pick targets by range,
// so a parked client sitting 450 m away keeps them from ever reaching a fresh duck.
// Each tier gets a FRESH duck flying a clean circle from the start. Reusing the
// client above measured nothing: the bots were already locked into a merge 450 m
// from its old parked position, and the switch to a circle teleports it 2.6 km,
// so the whole window was spent re-acquiring.
async function damagePerMinute(level) {
  const duck = new Client(`Duck-${level}`);
  await duck.ready;
  // Sent by the duck, not by `a` -- `a`'s socket is closed by this point.
  duck.send({ t: 'difficulty', level });
  await sleep(300);
  duck.circle(HOME);
  await sleep(30000);
  const taken = duck.of('hit').filter((h) => h.targetId === duck.id).length;
  duck.close();
  await sleep(500);
  return taken;
}

const hardHits = await damagePerMinute('hard');
const easyHits = await damagePerMinute('easy');
check(
  'hard hurts more than easy',
  hardHits > easyHits,
  `hard ${hardHits} vs easy ${easyHits} hits per 30 s`,
);

console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
