// --- WebSocket connection ---
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${location.host}`);

let myPlayerId = null;
let roomId = null;
let gameStarted = false;

// --- Lobby UI ---
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

// --- WebSocket messages ---
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'created':
      roomId = msg.roomId;
      myPlayerId = msg.playerId;
      document.getElementById('screen-main').style.display = 'none';
      document.getElementById('screen-wait').style.display = 'block';
      document.getElementById('room-code').textContent = roomId;
      break;

    case 'joined':
      roomId = msg.roomId;
      myPlayerId = msg.playerId;
      startGame();
      break;

    case 'start':
      startGame();
      break;

    case 'state':
      // TODO: update opponent state
      // updateOpponent(msg.playerId, msg.data);
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

// --- Game ---
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Player state — to be expanded when building the game
const players = {
  p1: { x: 200, y: 300, angle: 0, color: '#4af' },
  p2: { x: 600, y: 300, angle: Math.PI, color: '#f84' },
};

function startGame() {
  document.getElementById('lobby').style.display = 'none';
  canvas.style.display = 'block';
  gameStarted = true;
  gameLoop();
}

function gameLoop() {
  if (!gameStarted) return;
  update();
  render();
  requestAnimationFrame(gameLoop);
}

function update() {
  // TODO: game physics and input handling
}

function render() {
  ctx.fillStyle = '#0a0a1a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // TODO: draw track

  // Draw placeholder spaceships
  for (const [id, p] of Object.entries(players)) {
    drawShip(p.x, p.y, p.angle, p.color);
  }

  // TODO: draw HUD (laps, speed, etc.)
}

function drawShip(x, y, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(20, 0);
  ctx.lineTo(-12, 10);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-12, -10);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

// Send local player state to server every frame
function sendState() {
  if (!gameStarted || !myPlayerId) return;
  const p = players[myPlayerId];
  ws.send(JSON.stringify({ type: 'state', data: { x: p.x, y: p.y, angle: p.angle } }));
}
