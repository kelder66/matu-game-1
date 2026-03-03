// ─── Constants ───────────────────────────────────────────────────────────────
const W = 800, H = 600;
const SHIP_X = { p1: 80, p2: 720 };
const SHIP_HALF_H = 22;
const SHIP_SPEED = 5;
const ROCKET_SPEED = 18;       // 2x faster
const MAX_ROCKETS = 3;
const SHOOT_COOLDOWN = 1000;   // 1 rocket per second
const START_LIVES = 3;
const MAX_LIVES = 5;
const HIT_PAUSE_MS = 2000;     // 2 second pause on hit
const HEART_CHANCE = 0.1;      // 10% chance to fire a heart

// ─── WebSocket ────────────────────────────────────────────────────────────────
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${location.host}`);

// ─── State ────────────────────────────────────────────────────────────────────
let myId = null;
let gameStarted = false;
let pauseUntil = 0;

const me = {
  y: H / 2,
  lives: START_LIVES,
  rockets: [],
  lastShot: 0,
  flash: 0,
};

const opp = {
  y: H / 2,
  lives: START_LIVES,
  rockets: [],
  flash: 0,
};

let gameOver = false;
let winner = null;
let explosions = [];

// ─── Stars ────────────────────────────────────────────────────────────────────
const stars = Array.from({ length: 120 }, () => ({
  x: Math.random() * W,
  y: Math.random() * H,
  r: Math.random() * 1.5 + 0.3,
  a: Math.random() * 0.6 + 0.3,
}));

// ─── Input ────────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  e.preventDefault();
});
window.addEventListener('keyup', e => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = false;
});

let touchUp = false, touchDown = false, touchShoot = false;

function setupTouchBtn(id, onDown, onUp) {
  const el = document.getElementById(id);
  el.addEventListener('touchstart', e => { e.preventDefault(); onDown(); }, { passive: false });
  el.addEventListener('touchend',   e => { e.preventDefault(); onUp();   }, { passive: false });
  el.addEventListener('mousedown',  () => onDown());
  el.addEventListener('mouseup',    () => onUp());
}

setupTouchBtn('btn-up',    () => touchUp = true,    () => touchUp = false);
setupTouchBtn('btn-down',  () => touchDown = true,  () => touchDown = false);
setupTouchBtn('btn-shoot', () => touchShoot = true, () => touchShoot = false);

function isUp()    { return keys['ArrowUp']   || keys['KeyW'] || touchUp; }
function isDown()  { return keys['ArrowDown'] || keys['KeyS'] || touchDown; }
function isShoot() { return keys['Space'] || touchShoot; }

// ─── Lobby ───────────────────────────────────────────────────────────────────
function showJoin() {
  document.getElementById('screen-main').style.display = 'none';
  document.getElementById('screen-join').style.display = 'block';
}
function createRoom() { ws.send(JSON.stringify({ type: 'create' })); }
function joinRoom() {
  const code = document.getElementById('room-input').value.trim().toUpperCase();
  if (!code) return;
  ws.send(JSON.stringify({ type: 'join', roomId: code }));
}

// ─── WebSocket messages ───────────────────────────────────────────────────────
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'created':
      myId = msg.playerId;
      document.getElementById('screen-main').style.display = 'none';
      document.getElementById('screen-wait').style.display = 'block';
      document.getElementById('room-code').textContent = msg.roomId;
      break;

    case 'joined':
      myId = msg.playerId;
      startGame();
      break;

    case 'start':
      startGame();
      break;

    case 'state':
      opp.y = msg.data.y;
      opp.rockets = msg.data.rockets;
      break;

    case 'hit':
      // Opponent was hit — update their lives, show explosion on their ship
      opp.lives = msg.data.lives;
      opp.flash = 30;
      spawnExplosion(SHIP_X[myId === 'p1' ? 'p2' : 'p1'], opp.y);
      pauseUntil = Date.now() + HIT_PAUSE_MS;
      checkGameOver();
      break;

    case 'ihit':
      // I was hit — handled locally
      break;

    case 'heartGiven':
      // Opponent caught my heart — update their lives
      opp.lives = msg.data.lives;
      break;

    case 'gameover':
      gameOver = true;
      winner = msg.data.winner;
      document.getElementById('btn-restart').classList.add('active');
      break;

    case 'rematch':
      resetGame();
      break;

    case 'playerLeft':
      alert('Other player disconnected.');
      location.reload();
      break;

    case 'error':
      alert(msg.message);
      break;
  }
});

// ─── Game control ─────────────────────────────────────────────────────────────
function startGame() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game-wrapper').classList.add('active');

  document.getElementById('touch-controls').classList.add('active');
  if (!('ontouchstart' in window)) {
    document.getElementById('btn-up').style.display = 'none';
    document.getElementById('btn-down').style.display = 'none';
    document.getElementById('btn-shoot').style.display = 'none';
  }

  scaleCanvas();
  window.addEventListener('resize', scaleCanvas);
  gameStarted = true;
  requestAnimationFrame(gameLoop);
}

function scaleCanvas() {
  const canvas = document.getElementById('canvas');
  const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width  = (W * scale) + 'px';
  canvas.style.height = (H * scale) + 'px';
}

function resetGame() {
  me.y = H / 2; me.lives = START_LIVES; me.rockets = []; me.flash = 0; me.lastShot = 0;
  opp.y = H / 2; opp.lives = START_LIVES; opp.rockets = []; opp.flash = 0;
  gameOver = false; winner = null;
  explosions = [];
  processedHits.clear();
  pauseUntil = 0;
  document.getElementById('btn-restart').classList.remove('active');
}

function requestRematch() {
  ws.send(JSON.stringify({ type: 'rematch' }));
}

function checkGameOver() {
  if (gameOver) return;
  if (me.lives <= 0 || opp.lives <= 0) {
    const w = me.lives <= 0 ? (myId === 'p1' ? 'p2' : 'p1') : myId;
    ws.send(JSON.stringify({ type: 'gameover', data: { winner: w } }));
    gameOver = true;
    winner = w;
    document.getElementById('btn-restart').classList.add('active');
  }
}

// ─── Rocket ID & hit tracking ─────────────────────────────────────────────────
let rocketId = 0;
const processedHits = new Set();

// ─── Explosion system ─────────────────────────────────────────────────────────
function spawnHeartCatch(x, y) {
  const particles = Array.from({ length: 16 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 3 + 1;
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: 0.02,
      size: Math.random() * 3 + 2,
      color: '#ff69b4',
    };
  });
  explosions.push({ x, y, ring: 0, ringColor: '#ff69b4', particles });
}

function spawnExplosion(x, y) {
  const particles = Array.from({ length: 24 }, () => {
    const angle = Math.random() * Math.PI * 2;
    const speed = Math.random() * 5 + 1;
    return {
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 1.0,
      decay: Math.random() * 0.02 + 0.015,
      size: Math.random() * 4 + 2,
      color: Math.random() > 0.5 ? '#ff8800' : '#ffee00',
    };
  });
  explosions.push({ x, y, ring: 0, particles });
}

function updateExplosions() {
  for (const e of explosions) {
    e.ring += 4;
    for (const p of e.particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;
      p.vx *= 0.95;
      p.vy *= 0.95;
    }
    e.particles = e.particles.filter(p => p.life > 0);
  }
  explosions = explosions.filter(e => e.ring < 100 || e.particles.length > 0);
}

function drawExplosions() {
  for (const e of explosions) {
    if (e.ring < 100) {
      const a = 1 - e.ring / 100;
      const ringColor = e.ringColor || 'rgba(255,200,50,';
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.ring, 0, Math.PI * 2);
      ctx.strokeStyle = e.ringColor ? `rgba(255,105,180,${a})` : `rgba(255,200,50,${a})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      if (!e.ringColor) {
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.ring * 0.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,100,0,${a * 0.7})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    for (const p of e.particles) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = p.color + Math.floor(p.life * 255).toString(16).padStart(2, '0');
      ctx.fill();
    }
  }
}

// ─── Game loop ────────────────────────────────────────────────────────────────
function gameLoop() {
  if (!gameStarted) return;
  update();
  render();
  requestAnimationFrame(gameLoop);
}

function update() {
  if (gameOver) { updateExplosions(); return; }

  updateExplosions();

  const paused = Date.now() < pauseUntil;

  if (!paused) {
    // Movement
    if (isUp())   me.y = Math.max(SHIP_HALF_H, me.y - SHIP_SPEED);
    if (isDown()) me.y = Math.min(H - SHIP_HALF_H, me.y + SHIP_SPEED);

    // Shoot
    const now = Date.now();
    if (isShoot() && me.rockets.length < MAX_ROCKETS && now - me.lastShot > SHOOT_COOLDOWN) {
      const type = Math.random() < HEART_CHANCE ? 'heart' : 'rocket';
      me.rockets.push({ id: rocketId++, x: SHIP_X[myId], y: me.y, type });
      me.lastShot = now;
    }

    // Move my rockets
    const dir = myId === 'p1' ? 1 : -1;
    me.rockets = me.rockets.filter(r => r.x > 0 && r.x < W);
    me.rockets.forEach(r => r.x += ROCKET_SPEED * dir);

    // Check if opponent's projectiles hit me
    opp.rockets.forEach(r => {
      if (!processedHits.has(r.id) && hitsMe(r)) {
        processedHits.add(r.id);
        if (r.type === 'heart') {
          // Catch a heart — gain a life (max 5)
          if (me.lives < MAX_LIVES) {
            me.lives = me.lives + 1;
            spawnHeartCatch(SHIP_X[myId], me.y);
          }
          ws.send(JSON.stringify({ type: 'heartCaught', data: { rocketId: r.id, lives: me.lives } }));
        } else {
          // Hit by a rocket — lose a life
          me.lives = Math.max(0, me.lives - 1);
          me.flash = 30;
          spawnExplosion(SHIP_X[myId], me.y);
          pauseUntil = Date.now() + HIT_PAUSE_MS;
          ws.send(JSON.stringify({ type: 'ihit', data: { lives: me.lives } }));
          checkGameOver();
        }
      }
    });
  }

  // Tick flash
  if (me.flash > 0)  me.flash--;
  if (opp.flash > 0) opp.flash--;

  // Always send state so opponent sees us
  ws.send(JSON.stringify({ type: 'state', data: { y: me.y, rockets: me.rockets } }));
}

function hitsMe(rocket) {
  return Math.abs(rocket.x - SHIP_X[myId]) < 28 && Math.abs(rocket.y - me.y) < SHIP_HALF_H;
}

// ─── Rendering ────────────────────────────────────────────────────────────────
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

function render() {
  // Background
  ctx.fillStyle = '#080818';
  ctx.fillRect(0, 0, W, H);

  // Stars
  for (const s of stars) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${s.a})`;
    ctx.fill();
  }

  // Centre divider
  ctx.setLineDash([10, 14]);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.setLineDash([]);

  if (!gameStarted) return;

  // Pause countdown
  if (Date.now() < pauseUntil && !gameOver) {
    const secs = Math.ceil((pauseUntil - Date.now()) / 1000);
    ctx.font = 'bold 48px monospace';
    ctx.fillStyle = 'rgba(255,255,100,0.8)';
    ctx.textAlign = 'center';
    ctx.fillText(`💥 ${secs}...`, W / 2, H / 2);
  }

  // Ships
  const myFacing  = myId === 'p1' ? 1 : -1;
  const oppFacing = -myFacing;
  drawShip(SHIP_X[myId],                      me.y,  myFacing,  me.flash  > 0 ? '#fff' : (myId === 'p1' ? '#4af' : '#f84'));
  drawShip(SHIP_X[myId === 'p1' ? 'p2':'p1'], opp.y, oppFacing, opp.flash > 0 ? '#fff' : (myId === 'p1' ? '#f84' : '#4af'));

  // Rockets & hearts
  for (const r of me.rockets) {
    if (r.type === 'heart') {
      drawHeartProjectile(r.x, r.y);
    } else {
      ctx.fillStyle = myId === 'p1' ? '#4af' : '#f84';
      drawRocket(r.x, r.y, myFacing);
    }
  }
  for (const r of opp.rockets) {
    if (r.type === 'heart') {
      drawHeartProjectile(r.x, r.y);
    } else {
      ctx.fillStyle = myId === 'p1' ? '#f84' : '#4af';
      drawRocket(r.x, r.y, oppFacing);
    }
  }

  // Explosions
  drawExplosions();

  // HUD — lives always tied to ship side (P1=left, P2=right)
  const p1Lives = myId === 'p1' ? me.lives : opp.lives;
  const p2Lives = myId === 'p1' ? opp.lives : me.lives;
  drawLives(20,     20, p1Lives, '#4af', 'left');
  drawLives(W - 20, 20, p2Lives, '#f84', 'right');

  // Labels always tied to ship side
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.textAlign = 'left';
  ctx.fillText(myId === 'p1' ? 'YOU' : 'ENEMY', 20, H - 16);
  ctx.textAlign = 'right';
  ctx.fillText(myId === 'p1' ? 'ENEMY' : 'YOU', W - 20, H - 16);

  if (gameOver) renderGameOver();
}

function drawShip(x, y, facing, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);
  ctx.beginPath();
  ctx.moveTo(28, 0);
  ctx.lineTo(-14, -SHIP_HALF_H + 4);
  ctx.lineTo(-8, 0);
  ctx.lineTo(-14, SHIP_HALF_H - 4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(6, 0, 8, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-10, 0, 5, 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,180,60,0.7)';
  ctx.fill();
  ctx.restore();
}

function drawRocket(x, y, facing) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);
  ctx.fillRect(0, -3, 18, 6);
  ctx.beginPath();
  ctx.moveTo(18, -3); ctx.lineTo(26, 0); ctx.lineTo(18, 3);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawHeartProjectile(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.font = 'bold 22px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('💗', 0, 0);
  ctx.restore();
}

function drawLives(x, y, count, color, align) {
  ctx.font = 'bold 18px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.fillText('❤️'.repeat(count) + '🖤'.repeat(Math.max(0, MAX_LIVES - count)), x, y + 16);
}

function renderGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  const isWinner = winner === myId;
  ctx.font = 'bold 64px monospace';
  ctx.fillStyle = isWinner ? '#4f4' : '#f44';
  ctx.fillText(isWinner ? '🏆 YOU WIN!' : '💀 YOU LOSE', W / 2, H / 2 - 30);
}

// Rematch
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && gameOver) requestRematch();
});
