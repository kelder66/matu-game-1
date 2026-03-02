// ─── Constants ───────────────────────────────────────────────────────────────
const W = 800, H = 600;
const SHIP_X = { p1: 80, p2: 720 };
const SHIP_HALF_H = 22;
const SHIP_SPEED = 5;
const ROCKET_SPEED = 9;
const MAX_ROCKETS = 3;
const SHOOT_COOLDOWN = 400;
const START_LIVES = 3;
const FLASH_DURATION = 40; // frames

// ─── WebSocket ────────────────────────────────────────────────────────────────
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${location.host}`);

// ─── State ────────────────────────────────────────────────────────────────────
let myId = null;
let gameStarted = false;

const me = {
  y: H / 2, vy: 0,
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

// ─── Stars (background) ───────────────────────────────────────────────────────
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
  el.addEventListener('mousedown',  e => { onDown(); });
  el.addEventListener('mouseup',    e => { onUp();   });
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

function createRoom() {
  ws.send(JSON.stringify({ type: 'create' }));
}

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
      // Opponent confirmed a hit on themselves
      opp.lives = msg.data.lives;
      opp.flash = FLASH_DURATION;
      checkGameOver();
      break;

    case 'ihit':
      // Server tells me I was hit
      me.lives = msg.data.lives;
      me.flash = FLASH_DURATION;
      checkGameOver();
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
  const wrapper = document.getElementById('game-wrapper');
  wrapper.classList.add('active');

  // Always show touch controls overlay (contains restart button)
  // Hide movement/shoot buttons on non-touch devices via CSS
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
  const scaleX = window.innerWidth / W;
  const scaleY = window.innerHeight / H;
  const scale = Math.min(scaleX, scaleY);
  canvas.style.width  = (W * scale) + 'px';
  canvas.style.height = (H * scale) + 'px';
}

function resetGame() {
  me.y = H / 2; me.vy = 0; me.lives = START_LIVES; me.rockets = []; me.flash = 0; me.lastShot = 0;
  opp.y = H / 2; opp.lives = START_LIVES; opp.rockets = []; opp.flash = 0;
  gameOver = false;
  winner = null;
  processedHits.clear();
  document.getElementById('btn-restart').classList.remove('active');
}

function requestRematch() {
  ws.send(JSON.stringify({ type: 'rematch' }));
}

function checkGameOver() {
  if (me.lives <= 0 || opp.lives <= 0) {
    const w = me.lives <= 0 ? (myId === 'p1' ? 'p2' : 'p1') : myId;
    ws.send(JSON.stringify({ type: 'gameover', data: { winner: w } }));
    gameOver = true;
    winner = w;
    document.getElementById('btn-restart').classList.add('active');
  }
}

// ─── Rocket ID counter ────────────────────────────────────────────────────────
let rocketId = 0;
const processedHits = new Set(); // rocket IDs that have already hit me

// ─── Game loop ────────────────────────────────────────────────────────────────
function gameLoop() {
  if (!gameStarted) return;
  update();
  render();
  requestAnimationFrame(gameLoop);
}

function update() {
  if (gameOver) return;

  // Movement
  if (isUp())   me.y = Math.max(SHIP_HALF_H, me.y - SHIP_SPEED);
  if (isDown()) me.y = Math.min(H - SHIP_HALF_H, me.y + SHIP_SPEED);

  // Shoot
  const now = Date.now();
  if (isShoot() && me.rockets.length < MAX_ROCKETS && now - me.lastShot > SHOOT_COOLDOWN) {
    me.rockets.push({ id: rocketId++, x: SHIP_X[myId], y: me.y });
    me.lastShot = now;
  }

  // Move my rockets
  const dir = myId === 'p1' ? 1 : -1;
  me.rockets = me.rockets.filter(r => r.x > 0 && r.x < W);
  me.rockets.forEach(r => r.x += ROCKET_SPEED * dir);

  // Check if opponent's rockets hit me
  opp.rockets.forEach(r => {
    if (!processedHits.has(r.id) && hitsMe(r)) {
      processedHits.add(r.id);
      me.lives = Math.max(0, me.lives - 1);
      me.flash = FLASH_DURATION;
      ws.send(JSON.stringify({ type: 'ihit', data: { lives: me.lives } }));
      checkGameOver();
    }
  });

  // Tick flash
  if (me.flash > 0)  me.flash--;
  if (opp.flash > 0) opp.flash--;

  // Send state
  ws.send(JSON.stringify({
    type: 'state',
    data: { y: me.y, rockets: me.rockets },
  }));
}

function hitsMe(rocket) {
  const myX = SHIP_X[myId];
  return Math.abs(rocket.x - myX) < 28 && Math.abs(rocket.y - me.y) < SHIP_HALF_H;
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
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();
  ctx.setLineDash([]);

  if (!gameStarted) return;

  // Ships
  const p1Id = 'p1', p2Id = 'p2';
  const myShipX  = SHIP_X[myId];
  const oppShipX = myId === 'p1' ? SHIP_X.p2 : SHIP_X.p1;
  const myFacing  = myId === 'p1' ? 1 : -1;
  const oppFacing = -myFacing;

  drawShip(myShipX,  me.y,  myFacing,  me.flash  > 0 ? '#fff' : (myId  === 'p1' ? '#4af' : '#f84'));
  drawShip(oppShipX, opp.y, oppFacing, opp.flash > 0 ? '#fff' : (myId === 'p1' ? '#f84' : '#4af'));

  // Rockets — mine
  ctx.fillStyle = myId === 'p1' ? '#4af' : '#f84';
  for (const r of me.rockets) drawRocket(r.x, r.y, myFacing);

  // Rockets — opponent's
  ctx.fillStyle = myId === 'p1' ? '#f84' : '#4af';
  for (const r of opp.rockets) drawRocket(r.x, r.y, oppFacing);

  // HUD — lives
  drawLives(20,  20, me.lives,  myId  === 'p1' ? '#4af' : '#f84', 'left');
  drawLives(W - 20, 20, opp.lives, myId === 'p1' ? '#f84' : '#4af', 'right');

  // Player labels
  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.textAlign = 'left';
  ctx.fillText('YOU', 20, H - 16);
  ctx.textAlign = 'right';
  ctx.fillText('ENEMY', W - 20, H - 16);

  // Game over overlay
  if (gameOver) renderGameOver();
}

function drawShip(x, y, facing, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(facing, 1);

  // Body
  ctx.beginPath();
  ctx.moveTo(28, 0);
  ctx.lineTo(-14, -SHIP_HALF_H + 4);
  ctx.lineTo(-8, 0);
  ctx.lineTo(-14, SHIP_HALF_H - 4);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // Cockpit
  ctx.beginPath();
  ctx.ellipse(6, 0, 8, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();

  // Engine glow
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
  ctx.moveTo(18, -3);
  ctx.lineTo(26, 0);
  ctx.lineTo(18, 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawLives(x, y, count, color, align) {
  ctx.font = 'bold 18px monospace';
  ctx.fillStyle = color;
  ctx.textAlign = align;
  const hearts = '❤️'.repeat(count) + '🖤'.repeat(START_LIVES - count);
  ctx.fillText(hearts, x, y + 16);
}

function renderGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, W, H);

  const isWinner = winner === myId;
  ctx.textAlign = 'center';

  ctx.font = 'bold 64px monospace';
  ctx.fillStyle = isWinner ? '#4f4' : '#f44';
  ctx.fillText(isWinner ? '🏆 YOU WIN!' : '💀 YOU LOSE', W / 2, H / 2 - 30);

  ctx.font = '20px monospace';
  ctx.fillStyle = '#aaa';
  ctx.fillText('Tap or press Space to play again', W / 2, H / 2 + 30);
}

// Rematch trigger
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && gameOver) {
    ws.send(JSON.stringify({ type: 'rematch' }));
  }
});
canvas.addEventListener('click', () => {
  if (gameOver) ws.send(JSON.stringify({ type: 'rematch' }));
});
canvas.addEventListener('touchend', () => {
  if (gameOver) ws.send(JSON.stringify({ type: 'rematch' }));
});
