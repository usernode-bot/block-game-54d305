const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ---- Fixed shared-world parameters (authoritative; mirrored to client) ----
const DIMS = { w: 32, d: 32, h: 24 };

const PALETTE = [
  { id: 1,  name: 'Grass',         color: '#5fae3a' },
  { id: 2,  name: 'Dirt',          color: '#8a5a32' },
  { id: 3,  name: 'Stone',         color: '#8d8d92' },
  { id: 4,  name: 'Wood',          color: '#a9763f' },
  { id: 5,  name: 'Leaves',        color: '#3f8f33' },
  { id: 6,  name: 'Sand',          color: '#ddca8a' },
  { id: 7,  name: 'Brick',         color: '#9c4a3c' },
  { id: 8,  name: 'Glass',         color: '#9fd4e8', opacity: 0.45 },
  { id: 9,  name: 'Red',           color: '#d23b3b' },
  { id: 10, name: 'Blue',          color: '#3b6dd2' },
  { id: 11, name: 'Yellow',        color: '#e3c93b' },
  { id: 12, name: 'White',         color: '#ededed' },
  { id: 13, name: 'Snow',          color: '#d8eeff' },
  { id: 14, name: 'Gold Block',    color: '#f5c842', material: 'standard', metalness: 0.85, roughness: 0.2 },
  { id: 15, name: 'Glowstone',     color: '#ffb040', emissive: '#ff8800', emissiveIntensity: 0.6 },
  { id: 16, name: 'Obsidian',      color: '#18082a', material: 'standard', metalness: 0.3, roughness: 0.1 },
  { id: 17, name: 'Rainbow Block', color: '#ff4488', powerup: true },
];
const VALID_TYPES = new Set(PALETTE.map((p) => p.id));

const BLOCK_POINTS = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1,
  7: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 2,
  13: 2,
  14: 5,
  15: 3,
  16: 4,
  17: 5,
};

const SEED_USER_ID = 0;

// ---- Speed Run levels (authoritative, sent to client on session start) ----
// Zones are non-overlapping and spread across the world to require navigation.
const SPEEDRUN_LEVELS = [
  { id: 1, name: 'Platform', zone: { x: [1, 4],   y: [1, 1],  z: [1, 4]   }, required: 16 },
  { id: 2, name: 'Tower',    zone: { x: [7, 8],   y: [1, 7],  z: [7, 8]   }, required: 28 },
  { id: 3, name: 'Causeway', zone: { x: [12, 12], y: [1, 1],  z: [10, 25] }, required: 16 },
  { id: 4, name: 'Fortress', zone: { x: [18, 23], y: [1, 2],  z: [18, 23] }, required: 36 },
  { id: 5, name: 'Spire',    zone: { x: [25, 30], y: [1, 10], z: [25, 30] }, required: 50 },
];

const PUBLIC_API_PATHS = new Set(['/health']);

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

// ---- World bootstrap ----
app.get('/api/world', async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT x, y, z, block_type FROM blocks WHERE block_type <> 0`);
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

// ---- Place / break a single block ----
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
    const seq = Number(rows[0].seq);

    let earned = 0, combo_multiplier = 1, rainbow_multiplier = 1, combo_tier = 1;
    if (t !== 0) {
      const base = BLOCK_POINTS[t] || 1;

      const comboRes = await pool.query(
        `SELECT COUNT(*)::int AS recent FROM blocks
         WHERE updated_by_user_id = $1 AND block_type <> 0
           AND updated_at > NOW() - INTERVAL '10 seconds'
           AND NOT (x = $2 AND y = $3 AND z = $4)`,
        [req.user.id, x, y, z]
      );
      const recent = comboRes.rows[0].recent;
      if (recent >= 10) { combo_multiplier = 3; combo_tier = 3; }
      else if (recent >= 6) { combo_multiplier = 2; combo_tier = 2; }
      else if (recent >= 3) { combo_multiplier = 1.5; combo_tier = 2; }

      const rainbowRes = await pool.query(
        `SELECT 1 FROM blocks WHERE updated_by_user_id = $1 AND block_type = 17
         AND updated_at > NOW() - INTERVAL '30 seconds' LIMIT 1`,
        [req.user.id]
      );
      if (rainbowRes.rows.length > 0) rainbow_multiplier = 2;

      earned = Math.round(base * combo_multiplier * rainbow_multiplier);

      await pool.query(
        `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
         VALUES ($1, $2, $3, 1, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           total_score   = leaderboard.total_score + EXCLUDED.total_score,
           blocks_placed = leaderboard.blocks_placed + 1,
           best_combo    = GREATEST(leaderboard.best_combo, EXCLUDED.best_combo),
           username      = EXCLUDED.username,
           updated_at    = NOW()`,
        [req.user.id, req.user.username, earned, combo_tier]
      );
    }

    res.json({ ok: true, seq, earned, combo_multiplier, rainbow_multiplier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Delta feed ----
app.get('/api/world/changes', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const { rows } = await pool.query(
      `SELECT x, y, z, block_type, seq FROM blocks WHERE seq > $1 ORDER BY seq`,
      [since]
    );
    const cursor = rows.length ? Number(rows[rows.length - 1].seq) : since;
    res.json({ changes: rows.map((r) => ({ x: r.x, y: r.y, z: r.z, t: r.block_type })), cursor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Leaderboard: top 10 + caller's own row ----
app.get('/api/leaderboard', async (req, res) => {
  try {
    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY total_score DESC) AS rank,
              user_id, username, total_score, blocks_placed, best_combo
       FROM leaderboard ORDER BY total_score DESC LIMIT 10`
    );
    const selfRes = await pool.query(
      `SELECT rank() OVER (ORDER BY total_score DESC) AS rank,
              user_id, username, total_score, blocks_placed, best_combo
       FROM leaderboard WHERE user_id = $1`,
      [req.user.id]
    );
    const toRow = (r) => ({
      rank: Number(r.rank), user_id: r.user_id, username: r.username,
      total_score: Number(r.total_score), blocks_placed: Number(r.blocks_placed), best_combo: r.best_combo,
    });
    res.json({ top: topRes.rows.map(toRow), self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Block attribution ----
app.get('/api/block/:x/:y/:z', async (req, res) => {
  try {
    const x = Number(req.params.x), y = Number(req.params.y), z = Number(req.params.z);
    if (y < 1) return res.json(null);
    const { rows } = await pool.query(
      `SELECT updated_by_username, updated_at FROM blocks WHERE x=$1 AND y=$2 AND z=$3 AND block_type<>0`,
      [x, y, z]
    );
    if (!rows.length || !rows[0].updated_by_username) return res.json(null);
    res.json({ username: rows[0].updated_by_username, updated_at: rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Speed Run: start a new run ----
app.post('/api/speedrun/start', async (req, res) => {
  try {
    // Auto-abandon any existing active session for this user.
    await pool.query(
      `UPDATE speedrun_sessions SET status='abandoned' WHERE user_id=$1 AND status='active'`,
      [req.user.id]
    );
    const { rows } = await pool.query(
      `INSERT INTO speedrun_sessions (user_id, username, current_level, status)
       VALUES ($1, $2, 1, 'active') RETURNING id, started_at`,
      [req.user.id, req.user.username]
    );
    res.json({ session_id: Number(rows[0].id), started_at: rows[0].started_at, levels: SPEEDRUN_LEVELS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Speed Run: place a block in the run's private world ----
app.post('/api/speedrun/block', async (req, res) => {
  try {
    const session_id = Number(req.body.session_id);
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    const z = Number(req.body.z);
    const t = Number(req.body.block_type);

    if (!Number.isInteger(session_id) || session_id <= 0) {
      return res.status(400).json({ error: 'invalid session_id' });
    }
    const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!intIn(x, 0, DIMS.w - 1) || !intIn(z, 0, DIMS.d - 1) || !intIn(y, 1, DIMS.h - 1)) {
      return res.status(400).json({ error: 'coordinate out of bounds' });
    }
    // Break action — not tracked server-side; client handles visual removal.
    if (t === 0) return res.json({ already_placed: false, level_progress: null, level_complete: false, run_complete: false });
    if (!VALID_TYPES.has(t)) return res.status(400).json({ error: 'unknown block_type' });

    const sessRes = await pool.query(
      `SELECT id, user_id, current_level, status, started_at FROM speedrun_sessions WHERE id=$1`,
      [session_id]
    );
    if (!sessRes.rows.length) return res.status(404).json({ error: 'session not found' });
    const sess = sessRes.rows[0];
    if (sess.user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    if (sess.status !== 'active') return res.status(409).json({ error: 'session not active', status: sess.status });

    const level = SPEEDRUN_LEVELS[sess.current_level - 1];
    const { zone, required } = level;
    const inZone = x >= zone.x[0] && x <= zone.x[1] &&
                   y >= zone.y[0] && y <= zone.y[1] &&
                   z >= zone.z[0] && z <= zone.z[1];

    const insertRes = await pool.query(
      `INSERT INTO speedrun_blocks (session_id, x, y, z, block_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id, x, y, z) DO NOTHING RETURNING session_id`,
      [session_id, x, y, z, t]
    );
    const already_placed = insertRes.rows.length === 0;

    // Count how many cells in this level's zone have been filled.
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS placed FROM speedrun_blocks
       WHERE session_id=$1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5 AND z BETWEEN $6 AND $7`,
      [session_id, zone.x[0], zone.x[1], zone.y[0], zone.y[1], zone.z[0], zone.z[1]]
    );
    const placed = countRes.rows[0].placed;

    let level_complete = false, run_complete = false, elapsed_ms = null;
    let is_personal_best = false, completed_level = null;
    let level_progress = { level: sess.current_level, placed, required };

    if (inZone && !already_placed && placed >= required) {
      level_complete = true;
      completed_level = sess.current_level;

      if (sess.current_level >= 5) {
        // Complete the entire run atomically.
        const complRes = await pool.query(
          `UPDATE speedrun_sessions
           SET status='complete', completed_at=NOW(),
               elapsed_ms=EXTRACT(EPOCH FROM (NOW()-started_at))*1000, current_level=5
           WHERE id=$1 AND status='active' RETURNING elapsed_ms`,
          [session_id]
        );
        if (complRes.rows.length) {
          run_complete = true;
          elapsed_ms = Number(complRes.rows[0].elapsed_ms);
          level_progress = { level: 5, placed, required };

          await pool.query(
            `INSERT INTO speedrun_best_times (user_id, username, best_ms, achieved_at, session_id)
             VALUES ($1, $2, $3, NOW(), $4)
             ON CONFLICT (user_id) DO UPDATE SET
               username    = EXCLUDED.username,
               best_ms     = CASE WHEN EXCLUDED.best_ms < speedrun_best_times.best_ms
                                  THEN EXCLUDED.best_ms ELSE speedrun_best_times.best_ms END,
               achieved_at = CASE WHEN EXCLUDED.best_ms < speedrun_best_times.best_ms
                                  THEN NOW() ELSE speedrun_best_times.achieved_at END,
               session_id  = CASE WHEN EXCLUDED.best_ms < speedrun_best_times.best_ms
                                  THEN EXCLUDED.session_id ELSE speedrun_best_times.session_id END`,
            [req.user.id, req.user.username, elapsed_ms, session_id]
          );

          const pbRes = await pool.query(`SELECT best_ms FROM speedrun_best_times WHERE user_id=$1`, [req.user.id]);
          is_personal_best = pbRes.rows.length > 0 && Number(pbRes.rows[0].best_ms) === elapsed_ms;
        }
      } else {
        // Advance to the next level.
        await pool.query(
          `UPDATE speedrun_sessions SET current_level=current_level+1 WHERE id=$1 AND status='active'`,
          [session_id]
        );
        const next = SPEEDRUN_LEVELS[sess.current_level]; // 0-indexed → next level def
        level_progress = { level: sess.current_level + 1, placed: 0, required: next.required };
      }
    }

    res.json({ already_placed, level_progress, level_complete, completed_level, run_complete, elapsed_ms, is_personal_best });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Speed Run: get current active session (for resume after refresh) ----
app.get('/api/speedrun/session', async (req, res) => {
  try {
    const sessRes = await pool.query(
      `SELECT id, started_at, current_level FROM speedrun_sessions
       WHERE user_id=$1 AND status='active' ORDER BY started_at DESC LIMIT 1`,
      [req.user.id]
    );
    if (!sessRes.rows.length) return res.json(null);

    const sess = sessRes.rows[0];
    const level = SPEEDRUN_LEVELS[sess.current_level - 1];
    const { zone, required } = level;

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS placed FROM speedrun_blocks
       WHERE session_id=$1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5 AND z BETWEEN $6 AND $7`,
      [sess.id, zone.x[0], zone.x[1], zone.y[0], zone.y[1], zone.z[0], zone.z[1]]
    );
    const filledRes = await pool.query(
      `SELECT x, y, z, block_type FROM speedrun_blocks
       WHERE session_id=$1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5 AND z BETWEEN $6 AND $7`,
      [sess.id, zone.x[0], zone.x[1], zone.y[0], zone.y[1], zone.z[0], zone.z[1]]
    );

    res.json({
      session_id: Number(sess.id),
      started_at: sess.started_at,
      current_level: sess.current_level,
      levels: SPEEDRUN_LEVELS,
      level_progress: { level: sess.current_level, placed: countRes.rows[0].placed, required },
      filled_cells: filledRes.rows.map((r) => ({ x: r.x, y: r.y, z: r.z, block_type: r.block_type })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Speed Run: leaderboard (fastest times) ----
app.get('/api/speedrun/leaderboard', async (req, res) => {
  try {
    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_ms ASC) AS rank, user_id, username, best_ms, achieved_at
       FROM speedrun_best_times ORDER BY best_ms ASC LIMIT 10`
    );
    const selfRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_ms ASC) AS rank, user_id, username, best_ms
       FROM speedrun_best_times WHERE user_id=$1`,
      [req.user.id]
    );
    const toRow = (r) => ({ rank: Number(r.rank), username: r.username, best_ms: Number(r.best_ms) });
    res.json({ top: topRes.rows.map(toRow), self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Speed Run: abandon active session ----
app.post('/api/speedrun/abandon', async (req, res) => {
  try {
    const session_id = Number(req.body.session_id);
    if (!Number.isInteger(session_id) || session_id <= 0) {
      return res.status(400).json({ error: 'invalid session_id' });
    }
    const { rowCount } = await pool.query(
      `UPDATE speedrun_sessions SET status='abandoned'
       WHERE id=$1 AND user_id=$2 AND status='active'`,
      [session_id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'active session not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// ---- Staging seed ----
function buildSeedCells() {
  const cells = [];
  const DEMO  = { userId: SEED_USER_ID, username: 'Staging demo' };
  const ALICE = { userId: -1, username: 'alice_builder' };
  const REZA  = { userId: -2, username: 'reza99' };
  const set = (x, y, z, t, who) => {
    const w = who || DEMO;
    cells.push({ x, y, z, t, userId: w.userId, username: w.username });
  };
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
  set(x0, 2, 16, 8, ALICE);
  set(x1, 2, 16, 8, ALICE);
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) set(x, 4, z, 4, ALICE);
  }
  const tx = 23, tz = 23;
  for (let y = 1; y <= 3; y++) set(tx, y, tz, 4, REZA);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) set(tx + dx, 4, tz + dz, 5, REZA);
  }
  set(tx, 5, tz, 5, REZA);
  set(16, 1, 13, 6);
  set(16, 1, 12, 6);
  set(20, 1, 10, 14);
  set(21, 1, 10, 15);
  set(22, 1, 10, 16);
  set(23, 1, 10, 17);
  set(20, 1, 11, 13);
  return cells;
}

async function seedStaging() {
  const cells = buildSeedCells();
  for (const c of cells) {
    await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, seq, updated_by_user_id, updated_by_username, updated_at)
       VALUES ($1, $2, $3, $4, nextval('block_seq'), $5, $6, NOW())
       ON CONFLICT (x, y, z) DO NOTHING`,
      [c.x, c.y, c.z, c.t, c.userId, c.username]
    );
  }

  const fakeScores = [
    { id: -1, username: 'staging-demo-alice', total_score: 1450, blocks_placed: 320, best_combo: 3 },
    { id: -2, username: 'staging-demo-bob',   total_score: 980,  blocks_placed: 210, best_combo: 2 },
    { id: -3, username: 'staging-demo-carol', total_score: 720,  blocks_placed: 180, best_combo: 2 },
    { id: -4, username: 'staging-demo-dave',  total_score: 440,  blocks_placed:  95, best_combo: 1 },
    { id: -5, username: 'staging-demo-eve',   total_score: 115,  blocks_placed:  30, best_combo: 1 },
  ];
  for (const s of fakeScores) {
    await pool.query(
      `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (user_id) DO NOTHING`,
      [s.id, s.username, s.total_score, s.blocks_placed, s.best_combo]
    );
  }

  // Speed Run staging seed — sessions first (FK dependency), then best_times.
  const srSeeds = [
    { sessId: 900001, userId: -11, username: 'staging-speedrun-alice', ms: 83456  },
    { sessId: 900002, userId: -12, username: 'staging-speedrun-bob',   ms: 105000 },
    { sessId: 900003, userId: -13, username: 'staging-speedrun-carol', ms: 121234 },
    { sessId: 900004, userId: -14, username: 'staging-speedrun-dave',  ms: 153789 },
    { sessId: 900005, userId: -15, username: 'staging-speedrun-eve',   ms: 192000 },
  ];
  for (const s of srSeeds) {
    await pool.query(
      `INSERT INTO speedrun_sessions (id, user_id, username, started_at, completed_at, elapsed_ms, current_level, status)
       VALUES ($1, $2, $3, NOW() - ($4 || ' milliseconds')::INTERVAL, NOW(), $4, 5, 'complete')
       ON CONFLICT (id) DO NOTHING`,
      [s.sessId, s.userId, s.username, s.ms]
    );
  }
  for (const s of srSeeds) {
    await pool.query(
      `INSERT INTO speedrun_best_times (user_id, username, best_ms, achieved_at, session_id)
       VALUES ($1, $2, $3, NOW(), $4) ON CONFLICT (user_id) DO NOTHING`,
      [s.userId, s.username, s.ms, s.sessId]
    );
  }
}

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      x SMALLINT NOT NULL, y SMALLINT NOT NULL, z SMALLINT NOT NULL,
      block_type SMALLINT NOT NULL, seq BIGINT NOT NULL,
      updated_by_user_id INTEGER, updated_by_username VARCHAR(255),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (x, y, z)
    )
  `);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS block_seq`);
  await pool.query(`CREATE INDEX IF NOT EXISTS blocks_seq_idx ON blocks (seq)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS blocks_user_time_idx ON blocks (updated_by_user_id, updated_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS leaderboard (
      user_id       INTEGER PRIMARY KEY,
      username      VARCHAR(255) NOT NULL,
      total_score   BIGINT NOT NULL DEFAULT 0,
      blocks_placed BIGINT NOT NULL DEFAULT 0,
      best_combo    SMALLINT NOT NULL DEFAULT 1,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Speed Run tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS speedrun_sessions (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL,
      username      VARCHAR(255) NOT NULL,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at  TIMESTAMPTZ,
      elapsed_ms    BIGINT,
      current_level SMALLINT NOT NULL DEFAULT 1,
      status        VARCHAR(20) NOT NULL DEFAULT 'active'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS speedrun_sessions_user_status_idx ON speedrun_sessions (user_id, status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS speedrun_blocks (
      session_id BIGINT NOT NULL REFERENCES speedrun_sessions(id),
      x          SMALLINT NOT NULL,
      y          SMALLINT NOT NULL,
      z          SMALLINT NOT NULL,
      block_type SMALLINT NOT NULL,
      placed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, x, y, z)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS speedrun_best_times (
      user_id     INTEGER PRIMARY KEY,
      username    VARCHAR(255) NOT NULL,
      best_ms     BIGINT NOT NULL,
      achieved_at TIMESTAMPTZ NOT NULL,
      session_id  BIGINT
    )
  `);

  if (IS_STAGING) {
    try { await seedStaging(); }
    catch (err) { console.error('staging seed failed', err); }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
