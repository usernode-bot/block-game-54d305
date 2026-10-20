const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

// The platform's address, injected by the platform at deploy. Never written
// out here: a hardcoded hostname is what broke this app when the platform
// moved domains. Empty only outside the platform (local runs).
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '').replace(/\/+$/, '');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const USERNODE_JWT_PUBLIC_KEY = process.env.USERNODE_JWT_PUBLIC_KEY;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ---- Fixed shared-world parameters (authoritative; mirrored to client) ----
// Coordinates are integer cell indices. y is up. y = 0 is the immutable
// ground/base layer and is NOT stored as rows — buildable cells are y >= 1.
const DIMS = { w: 32, d: 32, h: 24 }; // x in [0,w-1], z in [0,d-1], y in [0,h-1]

// Block palette (authoritative). id 0 is reserved for "air" (a broken cell).
// `opacity` < 1 renders semi-transparent (glass). Colors are hex strings.
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
const VALID_TYPES = new Set(PALETTE.map((p) => p.id)); // does NOT include 0

// Sentinel "user" id for staging seed rows so they never reference a real user.
const SEED_USER_ID = 0;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && USERNODE_JWT_PUBLIC_KEY) {
    try {
      const payload = jwt.verify(token, USERNODE_JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: 'usernode:app:' + process.env.USERNODE_APP_ID,
      });
      if (payload.pur === 'iframe') req.user = payload;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---- World bootstrap: dimensions, palette, current blocks, poll cursor ----
app.get('/api/world', async (_req, res) => {
  try {
    // Types 13-28 belonged to later palettes this reverted build no longer
    // knows. Map them to Stone (3) so they stay visible and solid instead of
    // becoming invisible occupied cells. The stored value is not rewritten.
    const { rows } = await pool.query(
      `SELECT x, y, z,
              CASE WHEN block_type BETWEEN 1 AND 12 THEN block_type ELSE 3 END AS block_type
       FROM blocks WHERE block_type <> 0`
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
app.post('/api/block', async (req, res) => {
  try {
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    const z = Number(req.body.z);
    const t = Number(req.body.block_type);

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
    res.json({ ok: true, seq: Number(rows[0].seq) });
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
      `SELECT x, y, z,
              CASE WHEN block_type = 0 THEN 0
                   WHEN block_type BETWEEN 1 AND 12 THEN block_type
                   ELSE 3 END AS block_type,
              seq FROM blocks WHERE seq > $1 ORDER BY seq`,
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
    <a href="${PLATFORM_ORIGIN}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- The starter world: the early game's one starter house standing
// alone on empty grass. Shared by the one-time world reset (below) and the
// staging seed, so every copy of the world starts the same way. ----
function buildStarterHouse() {
  const cells = [];
  const set = (x, y, z, t) => cells.push({ x, y, z, t });
  // A 5x5 hollow stone hut near plot center (x 14..18, z 14..18).
  const x0 = 14, x1 = 18, z0 = 14, z1 = 18;
  for (let y = 1; y <= 3; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const perimeter = x === x0 || x === x1 || z === z0 || z === z1;
        if (!perimeter) continue;
        // Door gap on the south wall (z0) at x = 16, lower two rows.
        if (x === 16 && z === z0 && y <= 2) continue;
        set(x, y, z, 3); // Stone
      }
    }
  }
  // Glass windows on the east/west walls.
  set(x0, 2, 16, 8);
  set(x1, 2, 16, 8);
  // Wood roof covering the 5x5 footprint.
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) set(x, 4, z, 4);
  }
  return cells;
}

// Seed rows are written by the sentinel user so they never reference a real
// one. `username` differs per environment: staging rows stay obviously fake.
async function seedStarterWorld(username) {
  for (const c of buildStarterHouse()) {
    await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, seq, updated_by_user_id, updated_by_username, updated_at)
       VALUES ($1, $2, $3, $4, nextval('block_seq'), $5, $6, NOW())
       ON CONFLICT (x, y, z) DO NOTHING`,
      [c.x, c.y, c.z, c.t, SEED_USER_ID, username]
    );
  }
}

// The key marking the 2026-10 world reset as applied in a given database.
const WORLD_RESET_KEY = 'world-reset-starter-house-2026-10';

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

  // ---- One-time world reset (2026-10): go back to the early world. ----
  // Every block people have built in the shared world since is permanently
  // deleted, and the world comes back as empty grass plus the starter
  // house. The app_meta marker makes this run exactly once per database:
  // later boots never wipe again, and anything built afterwards stays.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const reset = await pool.query(
    `INSERT INTO app_meta (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key`,
    [WORLD_RESET_KEY]
  );
  if (reset.rowCount > 0) {
    await pool.query(`DELETE FROM blocks`);
    await pool.query(`ALTER SEQUENCE block_seq RESTART WITH 1`);
    console.log('world reset applied: player-built blocks wiped, starter house restored');
    try { await seedStarterWorld(IS_STAGING ? 'Staging demo' : 'Starter house'); }
    catch (err) { console.error('starter house seed failed', err); }
  }

  // Staging seed: a fresh staging DB (blocks table created empty) gets the
  // starter house too, so it always has something to render, target,
  // break, and sync. Idempotent; never touches production. ----
  if (IS_STAGING) {
    try { await seedStarterWorld('Staging demo'); }
    catch (err) { console.error('staging seed failed', err); }
  }

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
