const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// The world is a finite box of cells: x and z span the ground plane, y the
// height. Cell (x, y, z) is the unit cube whose lowest corner sits at those
// integer grid coordinates. Everything else about the world — block types,
// which cells are solid — lives in the `blocks` table.
const WORLD = { sizeX: 128, sizeY: 64, sizeZ: 128 };

// The palette the Hotbar offers. `air` is not buildable but is accepted by
// POST as the break operation: a broken cell keeps its row with type 'air'
// (a tombstone), so no history is ever destroyed.
const BLOCK_TYPES = new Set([
  'grass', 'dirt', 'stone', 'log', 'planks', 'brick', 'glass', 'leaves',
]);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
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

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// Read the world. Without a parameter: every row (the full state a client
// needs on first load). With `?since=<ISO timestamp>`: only cells changed
// since then, so the client's once-a-second poll stays cheap. `air` rows
// come through as tombstones so a client can clear a cell it has rendered.
//
// serverTime is read from the database clock (never the client's), and the
// client echoes it back as its next `since` so clock skew can't skip or
// replay changes.
app.get('/api/blocks', async (req, res) => {
  try {
    // An unparseable `since` is treated as absent (full dump) rather than
    // erroring — a client that sends garbage still converges on the world.
    let since = null;
    if (typeof req.query.since === 'string' && req.query.since.trim() !== '') {
      const t = new Date(req.query.since);
      if (!Number.isNaN(t.getTime())) since = t;
    }
    // serverTime is captured BEFORE the row query, from the same clock as
    // `updated_at`, and both statements run in the same moment: a row this
    // first query misses (committed a breath later) always has
    // updated_at > serverTime, so the next poll echoes serverTime back as
    // `since` and picks it up. Echoing the client's own clock instead would
    // risk skipping changes on clock skew.
    const ts = await pool.query('SELECT now() AS server_time');
    const { rows } = await pool.query(
      `SELECT x, y, z, type
         FROM blocks${since ? ' WHERE updated_at > $1' : ''}
        ORDER BY updated_at, x, y, z`,
      since ? [since] : []
    );
    res.json({
      blocks: rows.map(r => [r.x, r.y, r.z, r.type]),
      serverTime: new Date(ts.rows[0].server_time).toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Write one cell: a palette type to place it, 'air' to break it. Who did it
// is recorded but not shown anywhere in this first version.
app.post('/api/blocks', async (req, res) => {
  const { x, y, z, type } = req.body || {};
  const isInt = Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z);
  const inBounds = isInt
    && x >= 0 && x < WORLD.sizeX
    && y >= 0 && y < WORLD.sizeY
    && z >= 0 && z < WORLD.sizeZ;
  if (!inBounds) return res.status(400).json({ error: 'Cell out of bounds' });
  if (!BLOCK_TYPES.has(type) && type !== 'air') {
    return res.status(400).json({ error: 'Unknown block type' });
  }
  try {
    await pool.query(`
      INSERT INTO blocks (x, y, z, type, updated_by, updated_by_name)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (x, y, z) DO UPDATE
        SET type = EXCLUDED.type,
            updated_by = EXCLUDED.updated_by,
            updated_by_name = EXCLUDED.updated_by_name,
            updated_at = NOW()
    `, [x, y, z, type, req.user.id, req.user.username]);
    res.json({ ok: true, serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/block-game/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/block-game/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The flat grass ground the shared world starts as: one Grass block per
// ground cell, 16,384 rows in a single statement. Only when the table is
// empty, and each row ON CONFLICT DO NOTHING, so two app instances starting
// at once (or a restart after someone already built) cannot double-seed or
// overwrite the world.
async function seedGround() {
  const { rows } = await pool.query('SELECT 1 AS one FROM blocks LIMIT 1');
  if (rows.length) return;
  await pool.query(`
    INSERT INTO blocks (x, y, z, type, updated_by, updated_by_name)
    SELECT x, 0, z, 'grass', 0, 'block-game'
      FROM generate_series(0, $1) AS x
      CROSS JOIN generate_series(0, $2) AS z
      ON CONFLICT (x, y, z) DO NOTHING
  `, [WORLD.sizeX - 1, WORLD.sizeZ - 1]);
  console.log('Seeded flat grass ground');
}

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      x INTEGER NOT NULL,
      y INTEGER NOT NULL,
      z INTEGER NOT NULL,
      type VARCHAR(16) NOT NULL,
      updated_by INTEGER NOT NULL,
      updated_by_name VARCHAR(255) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (x, y, z)
    )
  `);
  // The incremental poll filters on updated_at once per connected client
  // per second; without this index every poll is a full-table sort.
  await pool.query(
    'CREATE INDEX IF NOT EXISTS blocks_updated_at ON blocks (updated_at)'
  );
  await seedGround();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
