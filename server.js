const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ---- Fixed shared-world parameters (authoritative; mirrored to client) ----
// Coordinates are integer cell indices. y is up. y = 0 is the immutable
// ground/base layer and is NOT stored as rows — buildable cells are y >= 1.
const DIMS = { w: 32, d: 32, h: 24 }; // x in [0,w-1], z in [0,d-1], y in [0,h-1]

// Block palette (authoritative). id 0 is reserved for "air" (a broken cell).
// `opacity` < 1 renders semi-transparent (glass). Colors are hex strings.
// `material` 'standard' uses MeshStandardMaterial (PBR); default is Lambert.
// `emissive` / `emissiveIntensity` add a glow. `powerup` marks animated blocks.
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
const VALID_TYPES = new Set(PALETTE.map((p) => p.id)); // does NOT include 0

// Points awarded per block placed (type 0 = break = 0 points).
const BLOCK_POINTS = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1,   // Grass, Dirt, Stone, Wood, Leaves, Sand
  7: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 2, // Brick, Glass, Red, Blue, Yellow, White
  13: 2,  // Snow
  14: 5,  // Gold Block
  15: 3,  // Glowstone
  16: 4,  // Obsidian
  17: 5,  // Rainbow Block
};

// Sentinel "user" id for staging seed rows so they never reference a real user.
const SEED_USER_ID = 0;

// Paths that stay open without authentication (exact match).
const PUBLIC_API_PATHS = new Set(['/health']);
// GET-only path prefixes that bypass auth — replay data is explicitly shared.
const PUBLIC_API_PREFIXES = ['/api/replay/'];

// ---- Daily Challenge: deterministic placement target [20, 100] from UTC date ----
function dailyTarget(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = dateObj.getUTCMonth() + 1;
  const d = dateObj.getUTCDate();
  return 20 + ((y * 31 + m * 7 + d) % 81);
}

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (req.method === 'GET' && PUBLIC_API_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---- World bootstrap: dimensions, palette, current blocks, poll cursor ----
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

// ---- Place / break a single block. block_type 0 means break (air). ----
// Air-as-row: breaking writes block_type = 0 (never DELETE) with a bumped
// seq, so the change feed below can surface breaks to other clients.
// Placements (block_type > 0) also increment the player's daily challenge counter.
app.post('/api/block', async (req, res) => {
  try {
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    const z = Number(req.body.z);
    const t = Number(req.body.block_type);
    const sessionId = req.body.session_id || null;

    // Strict server-side validation — the only guard against a client
    // writing garbage cells into the shared, persistent world.
    const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!intIn(x, 0, DIMS.w - 1) || !intIn(z, 0, DIMS.d - 1)) {
      return res.status(400).json({ error: 'coordinate out of bounds' });
    }
    // y = 0 is the immutable ground layer; buildable range is [1, h-1].
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

    // Track challenge progress for placements only (breaks don't count).
    let challenge = null;
    // ---- Scoring (placements only; breaks earn 0) ----
    let earned = 0, combo_multiplier = 1, rainbow_multiplier = 1, combo_tier = 1;
    if (t !== 0) {
      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const target = dailyTarget(now);
      const cr = await pool.query(
        `INSERT INTO daily_challenge_progress
           (challenge_date, user_id, username, blocks_placed, completed_at, updated_at)
         VALUES ($1, $2, $3, 1,
           CASE WHEN 1 >= $4 THEN NOW() ELSE NULL END,
           NOW())
         ON CONFLICT (challenge_date, user_id) DO UPDATE SET
           blocks_placed = daily_challenge_progress.blocks_placed + 1,
           username = EXCLUDED.username,
           completed_at = CASE
             WHEN daily_challenge_progress.completed_at IS NOT NULL
               THEN daily_challenge_progress.completed_at
             WHEN daily_challenge_progress.blocks_placed + 1 >= $4
               THEN NOW()
             ELSE NULL
           END,
           updated_at = NOW()
         RETURNING blocks_placed, completed_at`,
        [dateStr, req.user.id, req.user.username, target]
      );
      const cr0 = cr.rows[0];
      challenge = { placed: cr0.blocks_placed, target, completed_at: cr0.completed_at };

      const base = BLOCK_POINTS[t] || 1;

      // Combo: count placements this user made in the last 10 seconds
      // (exclude the just-inserted cell to avoid double-counting).
      const comboRes = await pool.query(
        `SELECT COUNT(*)::int AS recent
         FROM blocks
         WHERE updated_by_user_id = $1
           AND block_type <> 0
           AND updated_at > NOW() - INTERVAL '10 seconds'
           AND NOT (x = $2 AND y = $3 AND z = $4)`,
        [req.user.id, x, y, z]
      );
      const recent = comboRes.rows[0].recent;
      if (recent >= 10) { combo_multiplier = 3; combo_tier = 3; }
      else if (recent >= 6) { combo_multiplier = 2; combo_tier = 2; }
      else if (recent >= 3) { combo_multiplier = 1.5; combo_tier = 2; }

      // Rainbow power-up: did this user place a Rainbow Block in the last 30s?
      const rainbowRes = await pool.query(
        `SELECT 1 FROM blocks
         WHERE updated_by_user_id = $1
           AND block_type = 17
           AND updated_at > NOW() - INTERVAL '30 seconds'
         LIMIT 1`,
        [req.user.id]
      );
      if (rainbowRes.rows.length > 0) rainbow_multiplier = 2;

      earned = Math.round(base * combo_multiplier * rainbow_multiplier);

      // Upsert leaderboard
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

    // ---- Replay session event logging (best-effort, non-fatal) ----
    let session_auto_stopped = false;
    if (sessionId) {
      try {
        const sessRes = await pool.query(
          `SELECT id, started_at, event_count FROM replay_sessions
           WHERE id = $1 AND user_id = $2 AND ended_at IS NULL`,
          [sessionId, req.user.id]
        );
        if (sessRes.rows.length > 0) {
          const sess = sessRes.rows[0];
          if (sess.event_count >= 500) {
            await pool.query(
              `UPDATE replay_sessions SET ended_at = NOW() WHERE id = $1`,
              [sessionId]
            );
            session_auto_stopped = true;
          } else {
            const offsetMs = Date.now() - new Date(sess.started_at).getTime();
            const seqInSession = Number(sess.event_count) + 1;
            await pool.query(
              `INSERT INTO replay_events (session_id, seq_in_session, x, y, z, block_type, offset_ms)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [sessionId, seqInSession, x, y, z, t, offsetMs]
            );
            await pool.query(
              `UPDATE replay_sessions SET event_count = event_count + 1 WHERE id = $1`,
              [sessionId]
            );
          }
        }
      } catch (sessErr) {
        console.error('replay event log error', sessErr.message);
      }
    }

    res.json({
      ok: true, seq,
      ...(challenge ? { challenge } : {}),
      earned, combo_multiplier, rainbow_multiplier,
      ...(session_auto_stopped ? { session_auto_stopped: true } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Delta feed: every cell changed since the client's cursor, including
// breaks (block_type 0). Powers near-realtime collaborative editing. ----
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

// ---- Presence: heartbeat ping ----
app.post('/api/presence/ping', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO user_presence (user_id, username, last_seen)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, last_seen = NOW()`,
      [req.user.id, req.user.username]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Presence: who is online (seen in the last 60s) ----
const STAGING_DEMO_USERS = [
  { username: 'Staging Builder A' },
  { username: 'Staging Builder B' },
  { username: 'Staging Builder C' },
  { username: 'Staging Builder D' },
];
app.get('/api/presence/online', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT username FROM user_presence
       WHERE last_seen > NOW() - INTERVAL '60 seconds'
       ORDER BY username`
    );
    const users = rows.map((r) => ({ username: r.username }));
    if (IS_STAGING) users.push(...STAGING_DEMO_USERS);
    res.json({ users });
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
       FROM leaderboard
       ORDER BY total_score DESC
       LIMIT 10`
    );
    const selfRes = await pool.query(
      `SELECT rank() OVER (ORDER BY total_score DESC) AS rank,
              user_id, username, total_score, blocks_placed, best_combo
       FROM leaderboard
       WHERE user_id = $1`,
      [req.user.id]
    );
    const toRow = (r) => ({
      rank: Number(r.rank),
      user_id: r.user_id,
      username: r.username,
      total_score: Number(r.total_score),
      blocks_placed: Number(r.blocks_placed),
      best_combo: r.best_combo,
      count: Number(r.blocks_placed),
    });
    res.json({
      entries: topRes.rows.map(toRow),
      self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Block attribution: who placed the block at (x, y, z) and when. ----
// Returns { username, updated_at } for a placed block, or null for empty /
// ground cells. Ground (y < 1) is the immutable grass layer — never stored.
app.get('/api/block/:x/:y/:z', async (req, res) => {
  try {
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const z = Number(req.params.z);
    if (y < 1) return res.json(null);
    const { rows } = await pool.query(
      `SELECT updated_by_username, updated_at
       FROM blocks
       WHERE x = $1 AND y = $2 AND z = $3 AND block_type <> 0`,
      [x, y, z]
    );
    if (!rows.length || !rows[0].updated_by_username) return res.json(null);
    res.json({ username: rows[0].updated_by_username, updated_at: rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Challenge: today's goal and the requesting user's progress. ----
// Target is derived deterministically from the UTC date — no DB write needed.
// Returns { date, target, placed, completed_at }.
app.get('/api/challenge/today', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const target = dailyTarget(now);
    const { rows } = await pool.query(
      `SELECT blocks_placed, completed_at
       FROM daily_challenge_progress
       WHERE challenge_date = $1 AND user_id = $2`,
      [dateStr, req.user.id]
    );
    const row = rows[0];
    res.json({
      date: dateStr,
      target,
      placed: row ? row.blocks_placed : 0,
      completed_at: row ? row.completed_at : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Replay: start a recording session ----
// Captures current world state as the session's starting snapshot.
app.post('/api/replay/start', async (req, res) => {
  try {
    const { rows: blockRows } = await pool.query(
      `SELECT x, y, z, block_type FROM blocks WHERE block_type <> 0`
    );
    const snapshot = blockRows.map((r) => ({ x: r.x, y: r.y, z: r.z, t: r.block_type }));
    const sessionId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO replay_sessions (id, user_id, username, started_at, world_snapshot, event_count)
       VALUES ($1, $2, $3, NOW(), $4, 0)`,
      [sessionId, req.user.id, req.user.username, JSON.stringify(snapshot)]
    );
    res.json({ session_id: sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Replay: stop a recording session ----
// Finalises the session and returns the share path.
app.post('/api/replay/stop/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(
      `UPDATE replay_sessions SET ended_at = NOW()
       WHERE id = $1 AND user_id = $2 AND ended_at IS NULL`,
      [id, req.user.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'session not found or already stopped' });
    res.json({ ok: true, share_path: '/replay/' + id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Replay: fetch a completed session for playback (public) ----
// Returns { session, events } — session includes world_snapshot.
// 404 if session doesn't exist or hasn't been stopped yet.
app.get('/api/replay/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT id, user_id, username, started_at, ended_at, world_snapshot, event_count
       FROM replay_sessions
       WHERE id = $1 AND ended_at IS NOT NULL`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'replay not found' });
    const sess = rows[0];
    const { rows: evRows } = await pool.query(
      `SELECT x, y, z, block_type, offset_ms
       FROM replay_events
       WHERE session_id = $1
       ORDER BY seq_in_session`,
      [id]
    );
    res.json({
      session: {
        id: sess.id,
        username: sess.username,
        started_at: sess.started_at,
        ended_at: sess.ended_at,
        world_snapshot: sess.world_snapshot,
        event_count: sess.event_count,
      },
      events: evRows.map((r) => ({ x: r.x, y: r.y, z: r.z, block_type: r.block_type, offset_ms: r.offset_ms })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // The entire game is inline in index.html, so a cached shell hides a
    // deploy wholesale. Force the HTML to revalidate every load (304 when
    // unchanged); other static assets keep Express defaults.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
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

// ---- Staging seed: an obviously-fake starter build so a fresh staging DB
// has something to render, target, break, and sync. Uses three distinct fake
// usernames so the "Who built this?" attribution tooltip shows variety.
// No-op in production. ----

// Helper: return all {x,z} pairs in a w×d rectangle starting at (x0,z0).
function makeRect(x0, z0, w, d) {
  const cells = [];
  for (let x = x0; x < x0 + w; x++)
    for (let z = z0; z < z0 + d; z++)
      cells.push({ x, z });
  return cells;
}
function buildSeedCells() {
  const cells = [];
  const DEMO  = { userId: SEED_USER_ID, username: 'Staging demo' };
  const ALICE = { userId: -1, username: 'alice_builder' };
  const REZA  = { userId: -2, username: 'reza99' };
  const set = (x, y, z, t, who) => {
    const w = who || DEMO;
    cells.push({ x, y, z, t, userId: w.userId, username: w.username });
  };
  // A 5x5 hollow stone hut near plot center (x 14..18, z 14..18).
  // Walls: Staging demo. Windows + roof: alice_builder. Tree: reza99.
  const x0 = 14, x1 = 18, z0 = 14, z1 = 18;
  for (let y = 1; y <= 3; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const perimeter = x === x0 || x === x1 || z === z0 || z === z1;
        if (!perimeter) continue;
        // Door gap on the south wall (z0) at x = 16, lower two rows.
        if (x === 16 && z === z0 && y <= 2) continue;
        set(x, y, z, 3); // Stone, Staging demo
      }
    }
  }
  // Glass windows on the east/west walls — placed by alice_builder.
  set(x0, 2, 16, 8, ALICE);
  set(x1, 2, 16, 8, ALICE);
  // Wood roof covering the 5x5 footprint — placed by alice_builder.
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) set(x, 4, z, 4, ALICE);
  }
  // A small tree to the side: wood trunk + leaf canopy — planted by reza99.
  const tx = 23, tz = 23;
  for (let y = 1; y <= 3; y++) set(tx, y, tz, 4, REZA);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      set(tx + dx, 4, tz + dz, 5, REZA);
    }
  }
  set(tx, 5, tz, 5, REZA);
  // A short sand path leading to the door — Staging demo.
  set(16, 1, 13, 6);
  set(16, 1, 12, 6);
  // A few new block types to showcase them.
  set(20, 1, 10, 14); // Gold Block
  set(21, 1, 10, 15); // Glowstone
  set(22, 1, 10, 16); // Obsidian
  set(23, 1, 10, 17); // Rainbow Block
  set(20, 1, 11, 13); // Snow
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

  // Daily challenge progress seed: three personas at different completion states
  // so both in-progress and complete widget states can be verified.
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const targetToday = dailyTarget(now);
  await pool.query(
    `INSERT INTO daily_challenge_progress
       (challenge_date, user_id, username, blocks_placed, completed_at, updated_at)
     VALUES
       ($1,  0, 'Staging demo',  5,           NULL, NOW()),
       ($1, -1, 'alice_builder', 38,          NULL, NOW()),
       ($1, -2, 'reza99',        $2, NOW(), NOW())
     ON CONFLICT (challenge_date, user_id) DO NOTHING`,
    [todayStr, targetToday]
  );
}

// Seed the leaderboard with 6 fake builders so staging shows a populated panel.
// Blocks are placed at y=1 in x=1..9, z=1..12 — clear of the stone hut (x 14..18,
// z 14..18), tree (x 23, z 23), and path (x 16, z 12..13).
// Negative user_id sentinels (-1..-6) avoid collisions with real user IDs.
async function seedLeaderboard() {
  const patches = [
    { userId: -1, username: 'Staging demo Alice',   type: 1,  cells: makeRect(1, 1, 8, 5) },  // 40
    { userId: -2, username: 'Staging demo Bob',     type: 2,  cells: makeRect(1, 6, 5, 5) },  // 25
    { userId: -3, username: 'Staging demo Charlie', type: 7,  cells: makeRect(6, 1, 3, 5) },  // 15
    { userId: -4, username: 'Staging demo Dana',    type: 9,  cells: makeRect(6, 6, 3, 3) },  //  9
    { userId: -5, username: 'Staging demo Eli',     type: 10, cells: makeRect(1, 11, 5, 1) }, //  5
    { userId: -6, username: 'Staging demo Faye',    type: 11, cells: makeRect(1, 12, 2, 1) }, //  2
  ];
  for (const p of patches) {
    for (const c of p.cells) {
      await pool.query(
        `INSERT INTO blocks (x, y, z, block_type, seq, updated_by_user_id, updated_by_username, updated_at)
         VALUES ($1, 1, $2, $3, nextval('block_seq'), $4, $5, NOW())
         ON CONFLICT (x, y, z) DO NOTHING`,
        [c.x, c.z, p.type, p.userId, p.username]
      );
    }
  }
}

// Seed one demo replay so staging has a watchable replay at a known URL.
// Session ID: a0000000-0000-0000-0000-000000000001
const DEMO_REPLAY_ID = 'a0000000-0000-0000-0000-000000000001';
async function seedReplay() {
  // Empty world snapshot — the demo replay starts from a blank slate.
  const snapshot = [];
  await pool.query(
    `INSERT INTO replay_sessions (id, user_id, username, started_at, ended_at, world_snapshot, event_count)
     VALUES ($1, -10, 'Staging demo', NOW() - INTERVAL '5 minutes', NOW() - INTERVAL '4 minutes', $2, 12)
     ON CONFLICT (id) DO NOTHING`,
    [DEMO_REPLAY_ID, JSON.stringify(snapshot)]
  );

  // 12 events: stone pillar at (16,1-4,16) and (17,1-4,16), plus brick caps.
  const events = [
    { seq: 1,  x: 16, y: 1, z: 16, t: 3,  ms: 1000  },
    { seq: 2,  x: 16, y: 2, z: 16, t: 3,  ms: 3000  },
    { seq: 3,  x: 16, y: 3, z: 16, t: 3,  ms: 5000  },
    { seq: 4,  x: 16, y: 4, z: 16, t: 3,  ms: 7000  },
    { seq: 5,  x: 17, y: 1, z: 16, t: 3,  ms: 9000  },
    { seq: 6,  x: 17, y: 2, z: 16, t: 3,  ms: 11000 },
    { seq: 7,  x: 17, y: 3, z: 16, t: 3,  ms: 13000 },
    { seq: 8,  x: 17, y: 4, z: 16, t: 3,  ms: 15000 },
    { seq: 9,  x: 16, y: 5, z: 16, t: 7,  ms: 18000 }, // Brick cap
    { seq: 10, x: 17, y: 5, z: 16, t: 7,  ms: 20000 }, // Brick cap
    { seq: 11, x: 16, y: 5, z: 17, t: 15, ms: 23000 }, // Glowstone accent
    { seq: 12, x: 17, y: 5, z: 17, t: 15, ms: 25000 }, // Glowstone accent
  ];
  for (const e of events) {
    await pool.query(
      `INSERT INTO replay_events (session_id, seq_in_session, x, y, z, block_type, offset_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [DEMO_REPLAY_ID, e.seq, e.x, e.y, e.z, e.t, e.ms]
    );
  }
}

async function start() {
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_presence (
      user_id  INTEGER PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Daily challenge progress: one row per (date, user). Public table —
  // placement counts and usernames are not sensitive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_challenge_progress (
      challenge_date DATE NOT NULL,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      blocks_placed INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (challenge_date, user_id)
    )
  `);
  // Index for future leaderboard queries (challenge_date + ranked by blocks_placed).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS daily_challenge_progress_date_placed_idx
    ON daily_challenge_progress (challenge_date, blocks_placed DESC)
  `);

  // Replay sessions: one row per recorded session. Public — replays are
  // explicitly shared by the recording user.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS replay_sessions (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      world_snapshot JSONB NOT NULL DEFAULT '[]',
      event_count INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Replay events: one row per block action within a session.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS replay_events (
      id SERIAL PRIMARY KEY,
      session_id UUID NOT NULL REFERENCES replay_sessions(id),
      seq_in_session INTEGER NOT NULL,
      x SMALLINT NOT NULL,
      y SMALLINT NOT NULL,
      z SMALLINT NOT NULL,
      block_type SMALLINT NOT NULL,
      offset_ms INTEGER NOT NULL
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS replay_events_session_seq_idx
    ON replay_events (session_id, seq_in_session)
  `);

  if (IS_STAGING) {
    try { await seedStaging(); }
    catch (err) { console.error('staging seed failed', err); }
    try { await seedLeaderboard(); }
    catch (err) { console.error('leaderboard seed failed', err); }
    try { await seedReplay(); }
    catch (err) { console.error('replay seed failed', err); }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
