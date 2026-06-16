const express = require('express');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');

const app = express();
const httpServer = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ---- Fixed shared-world parameters (authoritative; mirrored to client) ----
const DIMS = { w: 32, d: 32, h: 24 };

const PALETTE = [
  { id: 1,  name: 'Grass',  color: '#5fae3a' },
  { id: 2,  name: 'Dirt',   color: '#8a5a32' },
  { id: 3,  name: 'Stone',  color: '#8d8d92' },
  { id: 4,  name: 'Wood',   color: '#a9763f' },
  { id: 5,  name: 'Leaves', color: '#3f8f33' },
  { id: 6,  name: 'Sand',   color: '#ddca8a' },
  { id: 7,  name: 'Brick',  color: '#9c4a3c' },
  { id: 8,  name: 'Glass',  color: '#9fd4e8', opacity: 0.45 },
  { id: 9,  name: 'Red',    color: '#d23b3b' },
  { id: 10, name: 'Blue',   color: '#3b6dd2' },
  { id: 11, name: 'Yellow', color: '#e3c93b' },
  { id: 12, name: 'White',  color: '#ededed' },
];
const VALID_TYPES = new Set(PALETTE.map((p) => p.id));
const SEED_USER_ID = 0;

const PUBLIC_API_PATHS = new Set(['/health']);

// ---- In-memory Tetris room state ----
// room_code -> { hostWs, guestWs, status, countdownTimer }
const rooms = new Map();

// Room code: A-Z minus O and I, plus 2-9 (avoids confusable chars)
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

function sendWs(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }
}

app.use(express.json());

app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---- Block world routes ----
app.get('/api/world', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT x, y, z, block_type FROM blocks WHERE block_type <> 0`
    );
    const cur = await pool.query(`SELECT COALESCE(MAX(seq), 0) AS cursor FROM blocks`);
    res.json({
      dims: DIMS,
      palette: PALETTE,
      blocks: rows.map((r) => ({ x: r.x, y: r.y, z: r.z, t: r.block_type })),
      cursor: Number(cur.rows[0].cursor),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/block', async (req, res) => {
  try {
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    const z = Number(req.body.z);
    const t = Number(req.body.block_type);
    const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!intIn(x, 0, DIMS.w - 1) || !intIn(z, 0, DIMS.d - 1)) {
      return res.status(400).json({ error: 'coordinate out of bounds' });
    }
    if (!intIn(y, 1, DIMS.h - 1)) {
      return res.status(400).json({ error: 'y out of buildable range' });
    }
    if (t !== 0 && !VALID_TYPES.has(t)) {
      return res.status(400).json({ error: 'unknown block_type' });
    }
    const { rows } = await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, seq, updated_by_user_id, updated_by_username, updated_at)
       VALUES ($1, $2, $3, $4, nextval('block_seq'), $5, $6, NOW())
       ON CONFLICT (x, y, z) DO UPDATE SET
         block_type = EXCLUDED.block_type,
         seq = EXCLUDED.seq,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_by_username = EXCLUDED.updated_by_username,
         updated_at = NOW()
       RETURNING seq`,
      [x, y, z, t, req.user.id, req.user.username]
    );
    res.json({ ok: true, seq: Number(rows[0].seq) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/world/changes', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const { rows } = await pool.query(
      `SELECT x, y, z, block_type, seq FROM blocks WHERE seq > $1 ORDER BY seq`,
      [since]
    );
    const cursor = rows.length ? Number(rows[rows.length - 1].seq) : since;
    res.json({
      changes: rows.map((r) => ({ x: r.x, y: r.y, z: r.z, t: r.block_type })),
      cursor,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Tetris REST API ----
app.post('/api/tetris/rooms', async (req, res) => {
  let tries = 0;
  while (tries < 3) {
    const code = generateRoomCode();
    try {
      await pool.query(
        `INSERT INTO tetris_rooms (room_code, host_user_id, host_username)
         VALUES ($1, $2, $3)`,
        [code, req.user.id, req.user.username]
      );
      rooms.set(code, { hostWs: null, guestWs: null, status: 'waiting', countdownTimer: null });
      return res.json({ room_code: code });
    } catch (err) {
      if (err.code === '23505') { tries++; continue; }
      return res.status(500).json({ error: err.message });
    }
  }
  res.status(500).json({ error: 'Could not generate unique room code' });
});

app.post('/api/tetris/rooms/:code/join', async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM tetris_rooms WHERE room_code = $1`, [code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found' });
    const room = rows[0];
    if (room.status !== 'waiting') return res.status(400).json({ error: 'Room is not open for joining' });
    if (room.host_user_id === req.user.id) return res.status(400).json({ error: 'You created this room' });
    await pool.query(
      `UPDATE tetris_rooms SET guest_user_id = $1, guest_username = $2 WHERE room_code = $3`,
      [req.user.id, req.user.username, code]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/tetris/rooms/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  try {
    const { rows } = await pool.query(
      `SELECT status, host_username, guest_username FROM tetris_rooms WHERE room_code = $1`, [code]
    );
    if (!rows.length) return res.status(404).json({ error: 'Room not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Static + HTML shell ----
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- WebSocket upgrade handler ----
httpServer.on('upgrade', (request, socket, head) => {
  let url;
  try { url = new URL(request.url, 'http://localhost'); } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== '/ws/tetris') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token');
  const code = (url.searchParams.get('code') || '').toUpperCase();

  if (!token || !JWT_SECRET) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    handleTetrisConnection(ws, user, code).catch(err => {
      console.error('WS connect error:', err);
      try { ws.close(1011, 'Server error'); } catch {}
    });
  });
});

async function handleTetrisConnection(ws, user, code) {
  const { rows } = await pool.query(`SELECT * FROM tetris_rooms WHERE room_code = $1`, [code]);
  if (!rows.length) { ws.close(1008, 'Room not found'); return; }
  const roomRow = rows[0];

  const isHost = roomRow.host_user_id === user.id;
  const isGuest = roomRow.guest_user_id === user.id;
  if (!isHost && !isGuest) { ws.close(1008, 'Not in room'); return; }

  if (!rooms.has(code)) {
    rooms.set(code, { hostWs: null, guestWs: null, status: roomRow.status, countdownTimer: null });
  }
  const mem = rooms.get(code);

  // Replace any stale connection for this role
  if (isHost) {
    if (mem.hostWs) try { mem.hostWs.close(1000, 'Reconnected'); } catch {}
    mem.hostWs = ws;
  } else {
    if (mem.guestWs) try { mem.guestWs.close(1000, 'Reconnected'); } catch {}
    mem.guestWs = ws;
    sendWs(mem.hostWs, { type: 'guest_joined', guest_username: user.username });
  }

  // Both connected and room is open — start countdown
  if (mem.hostWs && mem.guestWs && mem.status === 'waiting') {
    mem.status = 'countdown';
    mem.countdownTimer = setTimeout(async () => {
      mem.countdownTimer = null;
      // Re-read room for latest guest_username (set by REST join)
      const { rows: fresh } = await pool.query(`SELECT * FROM tetris_rooms WHERE room_code = $1`, [code]);
      const fr = fresh[0];
      if (!fr) return;
      sendWs(mem.hostWs, { type: 'game_start', you: 'host', opponent_username: fr.guest_username });
      sendWs(mem.guestWs, { type: 'game_start', you: 'guest', opponent_username: fr.host_username });
      mem.status = 'active';
      await pool.query(`UPDATE tetris_rooms SET status='active', started_at=NOW() WHERE room_code=$1`, [code]);
    }, 3000);
  }

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'ping') {
      sendWs(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'board_update' && mem.status === 'active') {
      const oppWs = isHost ? mem.guestWs : mem.hostWs;
      sendWs(oppWs, { type: 'opponent_update', board: msg.board, piece: msg.piece, score: msg.score });
      return;
    }

    if (msg.type === 'game_over' && mem.status === 'active') {
      mem.status = 'finished';
      sendWs(ws, { type: 'game_end', result: 'loss', reason: 'topped_out' });
      sendWs(isHost ? mem.guestWs : mem.hostWs, { type: 'game_end', result: 'win', reason: 'topped_out' });
      updateGameResult(code, !isHost).catch(console.error);
    }
  });

  ws.on('close', () => {
    if (isHost) mem.hostWs = null;
    else mem.guestWs = null;

    if (mem.countdownTimer) {
      clearTimeout(mem.countdownTimer);
      mem.countdownTimer = null;
    }

    if (mem.status === 'active') {
      mem.status = 'finished';
      const survivorWs = isHost ? mem.guestWs : mem.hostWs;
      sendWs(survivorWs, { type: 'game_end', result: 'win', reason: 'opponent_disconnected' });
      updateGameResult(code, !isHost).catch(console.error);
    } else if (mem.status === 'countdown') {
      mem.status = 'waiting';
      const otherWs = isHost ? mem.guestWs : mem.hostWs;
      sendWs(otherWs, { type: 'opponent_disconnected' });
    }
  });

  ws.on('error', () => { try { ws.close(); } catch {} });
}

async function updateGameResult(code, winnerIsHost) {
  await pool.query(`
    UPDATE tetris_rooms SET
      status = 'finished',
      finished_at = NOW(),
      winner_user_id = CASE WHEN $1 THEN host_user_id ELSE guest_user_id END,
      winner_username = CASE WHEN $1 THEN host_username ELSE guest_username END
    WHERE room_code = $2
  `, [winnerIsHost, code]);
}

// ---- Staging seed ----
function buildSeedCells() {
  const cells = [];
  const set = (x, y, z, t) => cells.push({ x, y, z, t });
  const x0 = 14, x1 = 18, z0 = 14, z1 = 18;
  for (let y = 1; y <= 3; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const perimeter = x === x0 || x === x1 || z === z0 || z === z1;
        if (!perimeter) continue;
        if (x === 16 && z === z0 && y <= 2) continue;
        set(x, y, z, 3);
      }
    }
  }
  set(x0, 2, 16, 8);
  set(x1, 2, 16, 8);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) set(x, 4, z, 4);
  }
  const tx = 23, tz = 23;
  for (let y = 1; y <= 3; y++) set(tx, y, tz, 4);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) set(tx + dx, 4, tz + dz, 5);
  }
  set(tx, 5, tz, 5);
  set(16, 1, 13, 6);
  set(16, 1, 12, 6);
  return cells;
}

async function seedStaging() {
  const cells = buildSeedCells();
  for (const c of cells) {
    await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, seq, updated_by_user_id, updated_by_username, updated_at)
       VALUES ($1, $2, $3, $4, nextval('block_seq'), $5, 'Staging demo', NOW())
       ON CONFLICT (x, y, z) DO NOTHING`,
      [c.x, c.y, c.z, c.t, SEED_USER_ID]
    );
  }
  // Seed one waiting room so the join flow can be tested
  await pool.query(
    `INSERT INTO tetris_rooms (room_code, host_user_id, host_username, status)
     VALUES ('STAGE', $1, 'Staging demo', 'waiting')
     ON CONFLICT (room_code) DO NOTHING`,
    [SEED_USER_ID]
  );
}

async function start() {
  // Block world tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      x SMALLINT NOT NULL,
      y SMALLINT NOT NULL,
      z SMALLINT NOT NULL,
      block_type SMALLINT NOT NULL,
      seq BIGINT NOT NULL,
      updated_by_user_id INTEGER,
      updated_by_username VARCHAR(255),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (x, y, z)
    )
  `);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS block_seq`);
  await pool.query(`CREATE INDEX IF NOT EXISTS blocks_seq_idx ON blocks (seq)`);

  // Tetris rooms table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tetris_rooms (
      id SERIAL PRIMARY KEY,
      room_code VARCHAR(5) UNIQUE NOT NULL,
      host_user_id INTEGER NOT NULL,
      host_username VARCHAR(255) NOT NULL,
      guest_user_id INTEGER,
      guest_username VARCHAR(255),
      status VARCHAR(20) NOT NULL DEFAULT 'waiting',
      winner_user_id INTEGER,
      winner_username VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS tetris_rooms_status_idx ON tetris_rooms (status)`);

  if (IS_STAGING) {
    try { await seedStaging(); }
    catch (err) { console.error('staging seed failed', err); }
  }

  // Cleanup stale rooms (waiting/active older than 1 hour) every 30 minutes
  setInterval(async () => {
    try {
      await pool.query(`
        UPDATE tetris_rooms SET status='finished', finished_at=NOW()
        WHERE status IN ('waiting','active') AND created_at < NOW() - INTERVAL '1 hour'
      `);
    } catch (e) { console.error('room cleanup:', e); }
    for (const [code, room] of rooms) {
      if (room.status === 'finished') rooms.delete(code);
    }
  }, 30 * 60 * 1000);

  httpServer.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
