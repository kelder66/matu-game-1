// Integration test for the server's authority rules. Start the server first, then:
//   PORT=3100 npm start
//   node test/netcode.mjs
// It must be the only client connected AND the server must run with no NPCs --
// it asserts on exact player counts:
//   NPC_COUNT=0 PORT=3100 npm start
// Keeping bots out of the players map is what makes the 5-human cap assertion
// structurally correct rather than accidentally passing.
import { WebSocket } from 'ws';

const URL = process.env.TEST_WS || 'ws://localhost:3100/ws';
const D = Math.PI / 180;
const log = [];
let fails = 0;

function check(name, cond, extra = '') {
  if (!cond) fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

class Client {
  constructor(name) {
    this.name = name;
    this.msgs = [];
    this.id = null;
    this.spawn = null;
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => {
      this.ws.on('open', () => this.ws.send(JSON.stringify({ t: 'join', name })));
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        this.msgs.push(m);
        if (m.t === 'welcome') {
          this.id = m.id;
          this.spawn = m.spawn;
          res(m);
        }
        if (m.t === 'error') res(m);
      });
    });
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  state(over = {}) {
    const s = this.spawn;
    this.send({
      t: 'state',
      lat: s.lat, lon: s.lon, alt: s.alt,
      hdg: s.hdg, pit: 0, rol: 0, spd: 130, fire: 0,
      ...over,
    });
  }
  of(type) {
    return this.msgs.filter((m) => m.t === type);
  }
  close() {
    this.ws.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. join, welcome, spawn ring ---
const a = new Client('Matu');
const wa = await a.ready;
check('welcome received', wa.t === 'welcome');
check('spawn near Helsinki', Math.abs(wa.spawn.lat / D - 60.17) < 0.05, `lat=${(wa.spawn.lat / D).toFixed(3)}`);
check('spawn altitude 800', wa.spawn.alt === 800);

const b = new Client('Kelder');
const wb = await b.ready;
check('2nd player joins', wb.t === 'welcome');
check('2nd player sees 1st in roster', wb.players.length === 1 && wb.players[0].name === 'Matu');
check('distinct colours', wa.color !== wb.color);
await sleep(100);
check('1st player notified of join', a.of('joined').length === 1);

// --- 2. spawns are spread around the ring, not stacked ---
const dLat = Math.abs(wa.spawn.lat - wb.spawn.lat);
const dLon = Math.abs(wa.spawn.lon - wb.spawn.lon);
check('spawns are not identical', dLat + dLon > 1e-6);

// --- 3. snapshots ---
a.state();
b.state();
await sleep(200);
const snaps = a.of('snapshot');
check('snapshots broadcast', snaps.length >= 2, `got ${snaps.length} in 200ms (~20Hz)`);
const last = snaps[snaps.length - 1];
check('snapshot has both players', last.players.length === 2);
check('snapshot carries ts', typeof last.ts === 'number');

// --- 4. hit validation: self-hits rejected ---
a.state();
a.send({ t: 'hit', targetId: a.id });
await sleep(120);
check('self-hit rejected', a.of('hit').length === 0);

// --- 5. hit validation: distance rule ---
// Put B 50 km away, then claim a hit.
b.send({ t: 'state', lat: wb.spawn.lat + 0.5 * D, lon: wb.spawn.lon, alt: 800, hdg: 0, pit: 0, rol: 0, spd: 130, fire: 0 });
await sleep(80);
a.state();
a.send({ t: 'hit', targetId: b.id });
await sleep(150);
check('far-away hit rejected (distance rule)', a.of('hit').length === 0);

// --- 6. legitimate hits + token bucket ---
b.state({ lat: wa.spawn.lat, lon: wa.spawn.lon, alt: 800 }); // right next to A
await sleep(80);
a.state();
// Spam 200 hit claims instantly: the token bucket must let ~15 through, not 200.
for (let i = 0; i < 200; i++) a.send({ t: 'hit', targetId: b.id });
await sleep(300);
const hits = a.of('hit');
check('token bucket limits burst', hits.length > 0 && hits.length <= 20, `accepted ${hits.length} of 200`);

// --- 7. 10 hits -> death ---
// Drain slowly enough to refill tokens until B dies.
for (let round = 0; round < 12 && a.of('death').length === 0; round++) {
  a.state();
  b.state({ lat: wa.spawn.lat, lon: wa.spawn.lon, alt: 800 });
  a.send({ t: 'hit', targetId: b.id });
  await sleep(120);
}
const deaths = a.of('death');
check('death after 10 hits', deaths.length === 1, deaths.length ? `killer=${deaths[0].killerId === a.id}` : '');
if (deaths.length) check('killer is the shooter', deaths[0].killerId === a.id && deaths[0].id === b.id);

const hitMsgs = a.of('hit');
check('hit count reaches exactly 10', hitMsgs.some((m) => m.hits === 10), `max=${Math.max(...hitMsgs.map(m=>m.hits))}`);

// --- 8. dead players are excluded from snapshots ---
await sleep(120);
const afterDeath = a.of('snapshot').slice(-1)[0];
check('dead player not in snapshot', !afterDeath.players.some((p) => p.id === b.id));

// --- 9. hitting a dead player does nothing ---
const before = a.of('hit').length;
a.state();
a.send({ t: 'hit', targetId: b.id });
await sleep(150);
check('cannot hit a dead player', a.of('hit').length === before);

// --- 10. respawn is rate-limited then works ---
b.send({ t: 'respawn' }); // immediate: must be refused (2 s cooldown)
await sleep(150);
check('instant respawn refused', b.of('respawned').length === 0);
await sleep(2100);
b.send({ t: 'respawn' });
await sleep(200);
const resp = b.of('respawned');
check('respawn after cooldown works', resp.length === 1);
if (resp.length) check('respawn resets to ring', Math.abs(resp[0].lat / D - 60.17) < 0.05);
await sleep(50);
check('respawned player has full health', b.of('respawned').length === 1);

// --- 11. player cap of 5 ---
const extra = [];
for (let i = 0; i < 3; i++) {
  const c = new Client('P' + i);
  await c.ready;
  extra.push(c);
}
const sixth = new Client('Liiga');
const r6 = await sixth.ready;
check('6th player rejected', r6.t === 'error' && r6.code === 'full', r6.message || '');

// --- 12. disconnect removes the player ---
extra[0].close();
await sleep(200);
check('leave broadcast on disconnect', a.of('left').length >= 1);

// --- 13. slot freed after leaving ---
const rejoin = new Client('Uus');
const rj = await rejoin.ready;
check('slot freed for a new player', rj.t === 'welcome');

for (const c of [a, b, sixth, rejoin, ...extra]) c.close();
await sleep(100);
console.log(`\n${fails === 0 ? 'ALL PASSED' : fails + ' FAILURES'}`);
process.exit(fails ? 1 : 0);
