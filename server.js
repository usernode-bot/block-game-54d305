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

// Badge definitions (authoritative; mirrored to the client for panel rendering).
const BADGES = [
  { id: 'first_block',     name: 'First Block',    icon: '🏗️', flavour: 'Placed your first block!' },
  { id: 'builder',         name: 'Builder',         icon: '🧱', flavour: 'Placed 10 blocks!' },
  { id: 'architect',       name: 'Architect',       icon: '🏰', flavour: 'Placed 100 blocks!' },
  { id: 'high_scorer',     name: 'High Scorer',     icon: '⭐', flavour: 'Earned 1,000 score points!' },
  { id: 'comboist',        name: 'Comboist',        icon: '⚡', flavour: 'Hit a ×3 combo multiplier!' },
  { id: 'rainbow_placer',  name: 'Rainbow Placer',  icon: '🌈', flavour: 'Placed a Rainbow Block!' },
  { id: 'golden_touch',    name: 'Golden Touch',    icon: '✨', flavour: 'Placed a Gold Block!' },
  { id: 'glowmaster',      name: 'Glowmaster',      icon: '💡', flavour: 'Placed a Glowstone block!' },
  { id: 'shadow_sculptor', name: 'Shadow Sculptor', icon: '🌑', flavour: 'Placed an Obsidian block!' },
  { id: 'material_artist', name: 'Material Artist', icon: '🎨', flavour: 'Used 8+ different block types!' },
  { id: 'streak_3',        name: 'Hot Start',       icon: '🔥', flavour: 'Logged in 3 days in a row!' },
  { id: 'streak_7',        name: 'Week Warrior',     icon: '🗓️', flavour: 'A full week of building!' },
  { id: 'streak_14',       name: 'Fortnight Pro',    icon: '🏆', flavour: 'Two weeks of daily play!' },
  { id: 'streak_30',       name: 'Monthly Master',   icon: '👑', flavour: 'A full month on the block!' },
];

const STREAK_BADGE_MILESTONES = [
  { days: 3,  id: 'streak_3' },
  { days: 7,  id: 'streak_7' },
  { days: 14, id: 'streak_14' },
  { days: 30, id: 'streak_30' },
];

// Returns badges from BADGES that are newly earned given updated leaderboard
// totals, the block type just placed, and distinct type count.
function checkBadges({ lb, justPlacedType, typeCount }, earnedIds) {
  const newBadges = [];
  for (const badge of BADGES) {
    if (earnedIds.has(badge.id)) continue;
    let earned = false;
    switch (badge.id) {
      case 'first_block':     earned = lb.blocks_placed >= 1; break;
      case 'builder':         earned = lb.blocks_placed >= 10; break;
      case 'architect':       earned = lb.blocks_placed >= 100; break;
      case 'high_scorer':     earned = lb.total_score >= 1000; break;
      case 'comboist':        earned = lb.best_combo >= 3; break;
      case 'rainbow_placer':  earned = justPlacedType === 17; break;
      case 'golden_touch':    earned = justPlacedType === 14; break;
      case 'glowmaster':      earned = justPlacedType === 15; break;
      case 'shadow_sculptor': earned = justPlacedType === 16; break;
      case 'material_artist': earned = typeCount >= 8; break;
    }
    if (earned) newBadges.push(badge);
  }
  return newBadges;
}

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

// ---- Daily Challenge: deterministic placement target [20, 100] from UTC date ----
// Using UTC year/month/day so the same date always yields the same target
// regardless of server timezone or restarts. No DB row needed for the target itself.
function dailyTarget(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = dateObj.getUTCMonth() + 1;
  const d = dateObj.getUTCDate();
  return 20 + ((y * 31 + m * 7 + d) % 81);
}

// Returns the ISO date string (YYYY-MM-DD) for the Monday that starts the
// UTC week containing dateObj. Deterministic — same as dailyTarget's UTC approach.
function weekStart(dateObj) {
  const day = dateObj.getUTCDay(); // 0 = Sun, 1 = Mon, …, 6 = Sat
  const offset = day === 0 ? 6 : day - 1; // days since last Monday
  const monday = new Date(Date.UTC(
    dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate() - offset
  ));
  return monday.toISOString().slice(0, 10);
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
    let newly_earned_badges = [];
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
      if (recent >= 10) { combo_multiplier = 5; combo_tier = 4; }
      else if (recent >= 6) { combo_multiplier = 3; combo_tier = 3; }
      else if (recent >= 3) { combo_multiplier = 2; combo_tier = 2; }

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

      // Upsert leaderboard — RETURNING gives post-upsert totals for badge checks.
      const lbRes = await pool.query(
        `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
         VALUES ($1, $2, $3, 1, $4, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           total_score   = leaderboard.total_score + EXCLUDED.total_score,
           blocks_placed = leaderboard.blocks_placed + 1,
           best_combo    = GREATEST(leaderboard.best_combo, EXCLUDED.best_combo),
           username      = EXCLUDED.username,
           updated_at    = NOW()
         RETURNING total_score, blocks_placed, best_combo`,
        [req.user.id, req.user.username, earned, combo_tier]
      );

      const lb = {
        total_score:   Number(lbRes.rows[0].total_score),
        blocks_placed: Number(lbRes.rows[0].blocks_placed),
        best_combo:    lbRes.rows[0].best_combo,
      };

      // Upsert weekly tournament score (same formula; window = current UTC week)
      await pool.query(
        `INSERT INTO tournament_scores (week_start, user_id, username, score, blocks_placed, updated_at)
         VALUES ($1, $2, $3, $4, 1, NOW())
         ON CONFLICT (week_start, user_id) DO UPDATE SET
           score         = tournament_scores.score + EXCLUDED.score,
           blocks_placed = tournament_scores.blocks_placed + 1,
           username      = EXCLUDED.username,
           updated_at    = NOW()`,
        [weekStart(now), req.user.id, req.user.username, earned]
      );

      // Track which block types this player has ever placed.
      await pool.query(
        `INSERT INTO player_type_usage (user_id, block_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.user.id, t]
      );

      // Fetch already-earned badge IDs for this user.
      const earnedRes = await pool.query(
        `SELECT badge_id FROM player_badges WHERE user_id = $1`,
        [req.user.id]
      );
      const earnedIds = new Set(earnedRes.rows.map((r) => r.badge_id));

      // Count distinct block types used (post-insert, so current placement counts).
      const typeCountRes = await pool.query(
        `SELECT COUNT(*)::int AS type_count FROM player_type_usage WHERE user_id = $1`,
        [req.user.id]
      );
      const typeCount = typeCountRes.rows[0].type_count;

      // Evaluate predicates and insert any newly-earned badges.
      const newBadges = checkBadges({ lb, justPlacedType: t, typeCount }, earnedIds);
      for (const badge of newBadges) {
        await pool.query(
          `INSERT INTO player_badges (user_id, badge_id, earned_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
          [req.user.id, badge.id]
        );
      }
      newly_earned_badges = newBadges.map((b) => ({ id: b.id, name: b.name, icon: b.icon, flavour: b.flavour }));
    }

    res.json({ ok: true, seq, ...(challenge ? { challenge } : {}), earned, combo_multiplier, rainbow_multiplier, newly_earned_badges });
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

// ---- Chat: fetch messages since a cursor (message id) ----
// On initial load (since=0), returns the 50 most recent messages so the
// history doesn't dump the entire table. Delta polls are unbounded since
// the cursor bounds them naturally.
app.get('/api/chat', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const limit = since === 0 ? 50 : 500;
    const { rows } = await pool.query(
      `SELECT id, username, body, created_at FROM chat_messages WHERE id > $1 ORDER BY id LIMIT $2`,
      [since, limit]
    );
    const cursor = rows.length ? Number(rows[rows.length - 1].id) : since;
    res.json({
      messages: rows.map((r) => ({
        id: Number(r.id),
        username: r.username,
        body: r.body,
        created_at: r.created_at,
      })),
      cursor,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Presence: heartbeat ping ----
app.post('/api/presence/ping', async (req, res) => {
  try {
    const rawMode = req.body && req.body.mode;
    const mode = ['classic', 'spectate'].includes(rawMode) ? rawMode : 'classic';
    await pool.query(
      `INSERT INTO user_presence (user_id, username, last_seen, mode)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, last_seen = NOW(), mode = EXCLUDED.mode`,
      [req.user.id, req.user.username, mode]
    );

    // Upsert login streak. Idempotent for the same UTC day.
    const streakRes = await pool.query(
      `INSERT INTO login_streaks (user_id, username, last_login_date, current_streak, longest_streak)
       VALUES ($1, $2, CURRENT_DATE, 1, 1)
       ON CONFLICT (user_id) DO UPDATE SET
         username        = EXCLUDED.username,
         current_streak  = CASE
           WHEN login_streaks.last_login_date = CURRENT_DATE     THEN login_streaks.current_streak
           WHEN login_streaks.last_login_date = CURRENT_DATE - 1 THEN login_streaks.current_streak + 1
           ELSE 1
         END,
         longest_streak  = GREATEST(login_streaks.longest_streak, CASE
           WHEN login_streaks.last_login_date = CURRENT_DATE     THEN login_streaks.current_streak
           WHEN login_streaks.last_login_date = CURRENT_DATE - 1 THEN login_streaks.current_streak + 1
           ELSE 1
         END),
         last_login_date = CASE
           WHEN login_streaks.last_login_date = CURRENT_DATE THEN login_streaks.last_login_date
           ELSE CURRENT_DATE
         END,
         updated_at = NOW()
       RETURNING current_streak, longest_streak`,
      [req.user.id, req.user.username]
    );
    const { current_streak, longest_streak } = streakRes.rows[0];

    // Check which streak milestone badges the user already has.
    const earnedRes = await pool.query(
      `SELECT badge_id FROM player_badges WHERE user_id = $1 AND badge_id LIKE 'streak_%'`,
      [req.user.id]
    );
    const earnedStreakIds = new Set(earnedRes.rows.map((r) => r.badge_id));

    // Award any newly crossed milestone badges.
    const newlyEarnedBadges = [];
    for (const { days, id } of STREAK_BADGE_MILESTONES) {
      if (current_streak >= days && !earnedStreakIds.has(id)) {
        const ins = await pool.query(
          `INSERT INTO player_badges (user_id, badge_id, earned_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT DO NOTHING
           RETURNING badge_id`,
          [req.user.id, id]
        );
        if (ins.rows.length > 0) {
          const def = BADGES.find((b) => b.id === id);
          if (def) newlyEarnedBadges.push({ ...def, earned_at: new Date().toISOString() });
        }
      }
    }

    res.json({
      ok: true,
      streak: { current: current_streak, longest: longest_streak },
      newly_earned_badges: newlyEarnedBadges,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Streak: current user's login streak ----
app.get('/api/streak', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT current_streak, longest_streak FROM login_streaks WHERE user_id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.json({ current_streak: 0, longest_streak: 0 });
    res.json({
      current_streak: rows[0].current_streak,
      longest_streak: rows[0].longest_streak,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Presence: who is online (seen in the last 60s) ----
app.get('/api/presence/online', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT username, mode FROM user_presence
       WHERE last_seen > NOW() - INTERVAL '60 seconds'
       ORDER BY username`
    );
    const users = rows.map((r) => ({ username: r.username, mode: r.mode || 'classic' }));
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

// ---- Badges: current player's earned badges ----
app.get('/api/badges', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT badge_id, earned_at FROM player_badges WHERE user_id = $1 ORDER BY earned_at`,
      [req.user.id]
    );
    res.json({
      badges: rows.map((r) => ({ id: r.badge_id, earned_at: r.earned_at })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Chat: post a new message ----
app.post('/api/chat', async (req, res) => {
  try {
    const body = (typeof req.body.body === 'string' ? req.body.body : '').trim();
    if (!body) return res.status(400).json({ error: 'message body is required' });
    if (body.length > 200) return res.status(400).json({ error: 'message exceeds 200 characters' });

    const { rows } = await pool.query(
      `INSERT INTO chat_messages (user_id, username, body) VALUES ($1, $2, $3) RETURNING id`,
      [req.user.id, req.user.username, body]
    );
    res.json({ ok: true, id: Number(rows[0].id) });
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

// ---- Power-up spawn position: picks an unoccupied cell at y=2 ----
async function pickSpawnPosition() {
  let chosen = { x: 1, y: 2, z: 1 };
  for (let i = 0; i < 10; i++) {
    const x = 1 + Math.floor(Math.random() * (DIMS.w - 2));
    const z = 1 + Math.floor(Math.random() * (DIMS.d - 2));
    chosen = { x, y: 2, z };
    const { rows } = await pool.query(
      `SELECT 1 FROM blocks WHERE x = $1 AND y = 2 AND z = $2 AND block_type <> 0`,
      [x, z]
    );
    if (!rows.length) return chosen;
  }
  return chosen; // use last attempt even if occupied
}

// ---- Power-ups: list all unclaimed items ----
app.get('/api/powerups', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, type, x, y, z FROM powerups WHERE claimed_at IS NULL`
    );
    res.json({ powerups: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Power-ups: collect one (atomic claim + spawn replacement) ----
app.post('/api/powerups/:id/collect', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `UPDATE powerups
         SET claimed_at = NOW(), claimed_by_user_id = $1, claimed_by_username = $2
       WHERE id = $3 AND claimed_at IS NULL
       RETURNING type`,
      [req.user.id, req.user.username, id]
    );
    if (!rows.length) return res.status(409).json({ error: 'already claimed' });
    const type = rows[0].type;
    // Immediately spawn a replacement of the same type.
    const pos = await pickSpawnPosition();
    await pool.query(
      `INSERT INTO powerups (type, x, y, z) VALUES ($1, $2, $3, $4)`,
      [type, pos.x, pos.y, pos.z]
    );
    res.json({ ok: true, type, duration: 12 });
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

// ---- Weekly Tournament: current week top-10 + self row + last week's top-3 ----
app.get('/api/tournament', async (req, res) => {
  try {
    const now = new Date();
    const curWeek = weekStart(now);
    const weekStartDate = new Date(curWeek + 'T00:00:00Z');
    const weekEndDate = new Date(weekStartDate.getTime() + 6 * 24 * 60 * 60 * 1000);
    const curWeekEnd = weekEndDate.toISOString().slice(0, 10);
    const prevWeekDate = new Date(weekStartDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const prevWeek = prevWeekDate.toISOString().slice(0, 10);

    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY score DESC) AS rank,
              user_id, username, score, blocks_placed
       FROM tournament_scores
       WHERE week_start = $1
       ORDER BY score DESC
       LIMIT 10`,
      [curWeek]
    );
    const selfRes = await pool.query(
      `SELECT * FROM (
         SELECT rank() OVER (ORDER BY score DESC) AS rank,
                user_id, username, score, blocks_placed
         FROM tournament_scores
         WHERE week_start = $1
       ) ranked WHERE user_id = $2`,
      [curWeek, req.user.id]
    );
    const prevRes = await pool.query(
      `SELECT rank() OVER (ORDER BY score DESC) AS rank,
              user_id, username, score, blocks_placed
       FROM tournament_scores
       WHERE week_start = $1
       ORDER BY score DESC
       LIMIT 3`,
      [prevWeek]
    );

    const toRow = (r) => ({
      rank: Number(r.rank),
      user_id: Number(r.user_id),
      username: r.username,
      score: Number(r.score),
      blocks_placed: Number(r.blocks_placed),
    });

    res.json({
      week_start: curWeek,
      week_end: curWeekEnd,
      entries: topRes.rows.map(toRow),
      self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null,
      last_week: {
        week_start: prevWeek,
        entries: prevRes.rows.map(toRow),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Friends: list accepted friends + pending requests ----
app.get('/api/friends', async (req, res) => {
  const uid = req.user.id;
  try {
    const { rows: friendRows } = await pool.query(
      `SELECT f.id,
              CASE WHEN f.requester_id = $1 THEN f.addressee_id       ELSE f.requester_id       END AS friend_id,
              CASE WHEN f.requester_id = $1 THEN f.addressee_username  ELSE f.requester_username  END AS friend_username,
              (up.user_id IS NOT NULL) AS online
       FROM friendships f
       LEFT JOIN user_presence up ON (
         CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END = up.user_id
         AND up.last_seen > NOW() - INTERVAL '60 seconds'
       )
       WHERE (f.requester_id = $1 OR f.addressee_id = $1) AND f.status = 'accepted'
       ORDER BY online DESC NULLS LAST, friend_username`,
      [uid]
    );
    const { rows: incomingRows } = await pool.query(
      `SELECT id, requester_id, requester_username FROM friendships
       WHERE addressee_id = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [uid]
    );
    const { rows: outgoingRows } = await pool.query(
      `SELECT id, addressee_id, addressee_username FROM friendships
       WHERE requester_id = $1 AND status = 'pending'
       ORDER BY created_at ASC`,
      [uid]
    );

    const friends = friendRows.map((r) => ({
      id: Number(r.id),
      friend_id: r.friend_id,
      username: r.friend_username,
      online: r.online,
    }));
    const incoming = incomingRows.map((r) => ({
      id: Number(r.id),
      from_id: r.requester_id,
      username: r.requester_username,
    }));
    const outgoing = outgoingRows.map((r) => ({
      id: Number(r.id),
      to_id: r.addressee_id,
      username: r.addressee_username,
    }));

    if (IS_STAGING) {
      friends.push(
        { id: -10, friend_id: -101, username: 'Staging Friend A', online: true },
        { id: -11, friend_id: -102, username: 'Staging Friend B', online: false },
        { id: -12, friend_id: -103, username: 'Staging Friend C', online: false }
      );
      incoming.push({ id: -1, from_id: -201, username: 'Staging Requester X' });
      outgoing.push({ id: -2, to_id: -202, username: 'Staging Pending Y' });
    }

    res.json({ friends, incoming, outgoing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Friends: send a friend request by username ----
app.post('/api/friends/request', async (req, res) => {
  const uid = req.user.id;
  const uname = req.user.username;
  const targetUsername = (typeof req.body.username === 'string' ? req.body.username : '').trim();
  if (!targetUsername) return res.status(400).json({ error: 'username required' });

  try {
    // Look up the target across leaderboard + user_presence (case-insensitive).
    // user_presence is preferred when both contain the same user since it is fresher.
    const { rows } = await pool.query(
      `SELECT user_id, username FROM (
         SELECT user_id, username, 1 AS priority FROM user_presence
         UNION
         SELECT user_id, username, 2 AS priority FROM leaderboard
       ) u
       WHERE LOWER(username) = LOWER($1)
       ORDER BY priority ASC
       LIMIT 1`,
      [targetUsername]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const { user_id: tid, username: tusername } = rows[0];
    if (tid === uid) return res.status(400).json({ error: 'Cannot add yourself' });

    const { rows: existing } = await pool.query(
      `SELECT id FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2)
          OR (requester_id = $2 AND addressee_id = $1)`,
      [uid, tid]
    );
    if (existing.length) return res.status(409).json({ error: 'Already friends or request pending' });

    const { rows: inserted } = await pool.query(
      `INSERT INTO friendships (requester_id, addressee_id, requester_username, addressee_username)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [uid, tid, uname, tusername]
    );
    res.json({ ok: true, id: Number(inserted[0].id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Friends: accept an incoming request ----
app.post('/api/friends/:id/accept', async (req, res) => {
  const rowId = Number(req.params.id);
  if (IS_STAGING && rowId < 0) return res.json({ ok: true });
  try {
    const { rows } = await pool.query(
      `UPDATE friendships SET status = 'accepted', updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING id`,
      [rowId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Friends: decline an incoming request ----
// The row is kept (status = 'declined') so the requester can't immediately spam again.
app.post('/api/friends/:id/decline', async (req, res) => {
  const rowId = Number(req.params.id);
  if (IS_STAGING && rowId < 0) return res.json({ ok: true });
  try {
    const { rows } = await pool.query(
      `UPDATE friendships SET status = 'declined', updated_at = NOW()
       WHERE id = $1 AND addressee_id = $2 AND status = 'pending'
       RETURNING id`,
      [rowId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Request not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Friends: remove an accepted friendship or cancel an outgoing request ----
app.delete('/api/friends/:id', async (req, res) => {
  const rowId = Number(req.params.id);
  if (IS_STAGING && rowId < 0) return res.json({ ok: true });
  try {
    const { rows } = await pool.query(
      `DELETE FROM friendships
       WHERE id = $1 AND (requester_id = $2 OR addressee_id = $2)
       RETURNING id`,
      [rowId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Friendship not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Duels: send a challenge ----
app.post('/api/duels', async (req, res) => {
  const uid = req.user.id;
  const uname = req.user.username;
  const targetUsername = (typeof req.body.targetUsername === 'string' ? req.body.targetUsername : '').trim();
  if (!targetUsername) return res.status(400).json({ error: 'targetUsername required' });
  if (targetUsername.toLowerCase() === uname.toLowerCase()) {
    return res.status(400).json({ error: 'Cannot challenge yourself' });
  }
  try {
    const { rows: targetRows } = await pool.query(
      `SELECT user_id, username FROM (
         SELECT user_id, username, 1 AS priority FROM user_presence
         UNION
         SELECT user_id, username, 2 AS priority FROM leaderboard
       ) u
       WHERE LOWER(username) = LOWER($1)
       ORDER BY priority ASC LIMIT 1`,
      [targetUsername]
    );
    if (!targetRows.length) return res.status(404).json({ error: 'User not found' });
    const { user_id: tid, username: tusername } = targetRows[0];

    const { rows: existing } = await pool.query(
      `SELECT id FROM duels
       WHERE status IN ('pending','active')
         AND (challenger_id = $1 OR challenged_id = $1 OR challenger_id = $2 OR challenged_id = $2)`,
      [uid, tid]
    );
    if (existing.length) return res.status(409).json({ error: 'A duel is already in progress' });

    const { rows: inserted } = await pool.query(
      `INSERT INTO duels (challenger_id, challenger_username, challenged_id, challenged_username)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [uid, uname, tid, tusername]
    );
    const { id, created_at } = inserted[0];
    const expiresAt = new Date(new Date(created_at).getTime() + 30000);
    res.json({ id: Number(id), expiresAt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Duels: accept an incoming challenge ----
app.post('/api/duels/:id/accept', async (req, res) => {
  const rowId = Number(req.params.id);
  const uid = req.user.id;
  const uname = req.user.username;

  // Staging shortcircuit for injected fake challenges (negative IDs)
  if (IS_STAGING && rowId < 0) {
    try {
      const { rows: ins } = await pool.query(
        `INSERT INTO duels (challenger_id, challenger_username, challenged_id, challenged_username,
          status, started_at, ends_at)
         VALUES (-3, 'Staging demo Carol', $1, $2, 'active', NOW(), NOW() + INTERVAL '90 seconds')
         RETURNING started_at, ends_at`,
        [uid, uname]
      );
      if (ins.length) return res.json({ ok: true, started_at: ins[0].started_at, ends_at: ins[0].ends_at });
    } catch (_) {}
    return res.json({ ok: true, started_at: new Date(), ends_at: new Date(Date.now() + 90000) });
  }

  try {
    const { rows: checkRows } = await pool.query(
      `SELECT id, created_at, status FROM duels WHERE id = $1 AND challenged_id = $2`,
      [rowId, uid]
    );
    if (!checkRows.length) return res.status(404).json({ error: 'Challenge not found' });
    const d = checkRows[0];
    if (d.status !== 'pending') return res.status(400).json({ error: 'Challenge is not pending' });
    if (new Date() > new Date(new Date(d.created_at).getTime() + 30000)) {
      await pool.query(`UPDATE duels SET status = 'expired', updated_at = NOW() WHERE id = $1`, [rowId]);
      return res.status(400).json({ error: 'Challenge has expired' });
    }

    const { rows: updated } = await pool.query(
      `UPDATE duels
       SET status = 'active', started_at = NOW(), ends_at = NOW() + INTERVAL '90 seconds', updated_at = NOW()
       WHERE id = $1 AND challenged_id = $2 AND status = 'pending'
       RETURNING started_at, ends_at`,
      [rowId, uid]
    );
    if (!updated.length) return res.status(404).json({ error: 'Challenge not found or already handled' });
    res.json({ ok: true, started_at: updated[0].started_at, ends_at: updated[0].ends_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Duels: decline an incoming challenge ----
app.post('/api/duels/:id/decline', async (req, res) => {
  const rowId = Number(req.params.id);
  if (IS_STAGING && rowId < 0) return res.json({ ok: true });
  try {
    const { rows } = await pool.query(
      `UPDATE duels SET status = 'declined', updated_at = NOW()
       WHERE id = $1 AND challenged_id = $2 AND status = 'pending'
       RETURNING id`,
      [rowId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Challenge not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Duels: get the caller's active/pending duel (with live block counts) ----
app.get('/api/duels/active', async (req, res) => {
  const uid = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM duels
       WHERE (challenger_id = $1 OR challenged_id = $1)
         AND status IN ('pending','active','finished','declined')
       ORDER BY created_at DESC LIMIT 1`,
      [uid]
    );
    if (!rows.length) return res.json({ duel: null });
    let duel = rows[0];

    // Treat expired pending challenges as gone
    if (duel.status === 'pending') {
      if (new Date() > new Date(new Date(duel.created_at).getTime() + 30000)) {
        await pool.query(`UPDATE duels SET status = 'expired', updated_at = NOW() WHERE id = $1`, [duel.id]);
        return res.json({ duel: null });
      }
    }

    // Finalize an active duel whose time has expired (idempotent)
    if (duel.status === 'active' && new Date() > new Date(duel.ends_at)) {
      const cRes = await pool.query(
        `SELECT COUNT(*) FROM blocks
         WHERE updated_by_user_id = $1 AND block_type <> 0
           AND updated_at >= $2 AND updated_at <= $3`,
        [duel.challenger_id, duel.started_at, duel.ends_at]
      );
      const dRes = await pool.query(
        `SELECT COUNT(*) FROM blocks
         WHERE updated_by_user_id = $1 AND block_type <> 0
           AND updated_at >= $2 AND updated_at <= $3`,
        [duel.challenged_id, duel.started_at, duel.ends_at]
      );
      const cBlocks = Number(cRes.rows[0].count);
      const dBlocks = Number(dRes.rows[0].count);
      let winnerId = null;
      if (cBlocks > dBlocks) winnerId = duel.challenger_id;
      else if (dBlocks > cBlocks) winnerId = duel.challenged_id;

      const { rows: upd } = await pool.query(
        `UPDATE duels
         SET status = 'finished', challenger_blocks = $1, challenged_blocks = $2,
             winner_id = $3, updated_at = NOW()
         WHERE id = $4 AND status = 'active'
         RETURNING *`,
        [cBlocks, dBlocks, winnerId, duel.id]
      );
      if (upd.length) duel = upd[0];
    }

    // For a still-active duel compute live block counts
    if (duel.status === 'active') {
      const cRes = await pool.query(
        `SELECT COUNT(*) FROM blocks
         WHERE updated_by_user_id = $1 AND block_type <> 0 AND updated_at >= $2`,
        [duel.challenger_id, duel.started_at]
      );
      const dRes = await pool.query(
        `SELECT COUNT(*) FROM blocks
         WHERE updated_by_user_id = $1 AND block_type <> 0 AND updated_at >= $2`,
        [duel.challenged_id, duel.started_at]
      );
      duel = {
        ...duel,
        challenger_blocks: Number(cRes.rows[0].count),
        challenged_blocks: Number(dRes.rows[0].count),
      };
    }

    res.json({ duel: {
      id: Number(duel.id),
      challenger_id: Number(duel.challenger_id),
      challenger_username: duel.challenger_username,
      challenged_id: Number(duel.challenged_id),
      challenged_username: duel.challenged_username,
      status: duel.status,
      started_at: duel.started_at,
      ends_at: duel.ends_at,
      challenger_blocks: Number(duel.challenger_blocks || 0),
      challenged_blocks: Number(duel.challenged_blocks || 0),
      winner_id: duel.winner_id != null ? Number(duel.winner_id) : null,
      created_at: duel.created_at,
    }});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Duels: get incoming pending challenges for the caller ----
app.get('/api/duels/pending', async (req, res) => {
  const uid = req.user.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, challenger_id, challenger_username, created_at FROM duels
       WHERE challenged_id = $1
         AND status = 'pending'
         AND created_at > NOW() - INTERVAL '30 seconds'
       ORDER BY created_at DESC LIMIT 1`,
      [uid]
    );
    if (rows.length) {
      const d = rows[0];
      const expiresAt = new Date(new Date(d.created_at).getTime() + 30000);
      return res.json({ duel: {
        id: Number(d.id),
        challenger_id: Number(d.challenger_id),
        challenger_username: d.challenger_username,
        created_at: d.created_at,
        expires_at: expiresAt,
      }});
    }
    // Staging: inject a fake pending challenge so reviewers can test the banner
    if (IS_STAGING) {
      return res.json({ duel: {
        id: -101,
        challenger_id: -3,
        challenger_username: 'Staging demo Carol',
        created_at: new Date(Date.now() - 5000),
        expires_at: new Date(Date.now() + 25000),
      }});
    }
    res.json({ duel: null });
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

  // Seed leaderboard with obviously-fake entries (negative user IDs avoid
  // colliding with real platform user IDs, which are positive integers).
  const fakeScores = [
    { id: -1, username: 'staging-demo-alice', total_score: 1450, blocks_placed: 320, best_combo: 3 },
    { id: -2, username: 'staging-demo-bob',   total_score: 980,  blocks_placed: 210, best_combo: 3 },
    { id: -3, username: 'staging-demo-carol', total_score: 720,  blocks_placed: 180, best_combo: 2 },
    { id: -4, username: 'staging-demo-dave',  total_score: 440,  blocks_placed:  95, best_combo: 1 },
    { id: -5, username: 'staging-demo-eve',   total_score: 115,  blocks_placed:  30, best_combo: 1 },
  ];
  for (const s of fakeScores) {
    await pool.query(
      `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [s.id, s.username, s.total_score, s.blocks_placed, s.best_combo]
    );
  }

  // Seed player_type_usage for staging users so the material_artist badge
  // and type-based badge logic are exercised with realistic data.
  const typeUsageSeed = [
    // alice: 10 different types (qualifies for material_artist)
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((bt) => ({ userId: -1, blockType: bt })),
    // bob: 6 types including Rainbow Block
    ...[1, 2, 3, 4, 5, 17].map((bt) => ({ userId: -2, blockType: bt })),
    // carol: 3 types
    ...[1, 2, 3].map((bt) => ({ userId: -3, blockType: bt })),
    // dave: 5 types including Gold Block
    ...[1, 2, 3, 4, 14].map((bt) => ({ userId: -4, blockType: bt })),
  ];
  for (const u of typeUsageSeed) {
    await pool.query(
      `INSERT INTO player_type_usage (user_id, block_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [u.userId, u.blockType]
    );
  }

  // Seed player_badges for staging users to showcase the panel.
  const badgeSeed = [
    { userId: -1, badgeId: 'first_block' },
    { userId: -1, badgeId: 'builder' },
    { userId: -1, badgeId: 'architect' },
    { userId: -1, badgeId: 'high_scorer' },
    { userId: -1, badgeId: 'comboist' },
    { userId: -1, badgeId: 'golden_touch' },
    { userId: -1, badgeId: 'material_artist' },
    { userId: -2, badgeId: 'first_block' },
    { userId: -2, badgeId: 'builder' },
    { userId: -2, badgeId: 'rainbow_placer' },
    { userId: -2, badgeId: 'comboist' },
    { userId: -3, badgeId: 'first_block' },
    { userId: -4, badgeId: 'first_block' },
    { userId: -4, badgeId: 'builder' },
  ];
  for (const b of badgeSeed) {
    await pool.query(
      `INSERT INTO player_badges (user_id, badge_id, earned_at)
       VALUES ($1, $2, NOW() - INTERVAL '3 days')
       ON CONFLICT DO NOTHING`,
      [b.userId, b.badgeId]
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

  // Seed one of each power-up type at fixed, open positions so testers can
  // immediately see and collect them. Skipped if any unclaimed power-ups
  // already exist (e.g. after a hot-reload during the same staging run).
  const { rows: pwCount } = await pool.query(
    `SELECT COUNT(*) AS n FROM powerups WHERE claimed_at IS NULL`
  );
  if (Number(pwCount[0].n) === 0) {
    await pool.query(`
      INSERT INTO powerups (type, x, y, z) VALUES
        ('speed_boost', 5, 2, 16),
        ('super_jump',  28, 2, 16),
        ('rapid_place', 16, 2, 28)
    `);
  }
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

// ---- Ensure at least one of each power-up type is live in the world ----
// Runs on every boot (after staging seed). In production the first boot
// inserts all three; subsequent boots are no-ops. In staging the seed above
// takes priority; this is a safety net for any type the seed missed.
async function ensurePowerUps() {
  for (const type of ['speed_boost', 'super_jump', 'rapid_place']) {
    const { rows } = await pool.query(
      `SELECT 1 FROM powerups WHERE type = $1 AND claimed_at IS NULL LIMIT 1`,
      [type]
    );
    if (!rows.length) {
      const pos = await pickSpawnPosition();
      await pool.query(
        `INSERT INTO powerups (type, x, y, z) VALUES ($1, $2, $3, $4)`,
        [type, pos.x, pos.y, pos.z]
      );
    }
  }
}

// ---- Staging seed: a few obviously-fake chat messages so the chat drawer
// has visible content when a reviewer first opens it. Uses explicit IDs with
// ON CONFLICT DO NOTHING for idempotency across reboots. ----
async function seedChat() {
  const msgs = [
    { id: 1, body: 'Hello from staging! Chat is now live.' },
    { id: 2, body: 'Try placing a glass block on top of the hut.' },
    { id: 3, body: 'Chat messages appear here in real time.' },
  ];
  for (const m of msgs) {
    await pool.query(
      `INSERT INTO chat_messages (id, user_id, username, body)
       OVERRIDING SYSTEM VALUE
       VALUES ($1, $2, 'Staging demo', $3)
       ON CONFLICT (id) DO NOTHING`,
      [m.id, SEED_USER_ID, m.body]
    );
  }
  // Advance the sequence past the seed IDs so real messages start at ID 4+.
  await pool.query(
    `SELECT setval('chat_messages_id_seq', GREATEST((SELECT MAX(id) FROM chat_messages), 3))`
  );
}

async function seedTournament() {
  const now = new Date();
  const curWeek = weekStart(now);
  const prevWeekDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const prevWeek = weekStart(prevWeekDate);

  const seeds = [
    { userId: -1, username: 'Staging demo Alice',   score: 320, blocks: 85 },
    { userId: -2, username: 'Staging demo Bob',     score: 210, blocks: 60 },
    { userId: -3, username: 'Staging demo Charlie', score: 155, blocks: 45 },
    { userId: -4, username: 'Staging demo Dana',    score: 90,  blocks: 30 },
    { userId: -5, username: 'Staging demo Eli',     score: 40,  blocks: 18 },
    { userId: -6, username: 'Staging demo Faye',    score: 15,  blocks: 8  },
  ];

  for (const s of seeds) {
    await pool.query(
      `INSERT INTO tournament_scores (week_start, user_id, username, score, blocks_placed, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (week_start, user_id) DO NOTHING`,
      [curWeek, s.userId, s.username, s.score, s.blocks]
    );
    await pool.query(
      `INSERT INTO tournament_scores (week_start, user_id, username, score, blocks_placed, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (week_start, user_id) DO NOTHING`,
      [prevWeek, s.userId, s.username, Math.round(s.score * 0.75), Math.round(s.blocks * 0.75)]
    );
  }
}

async function seedStreaks() {
  // Negative user IDs so they never collide with real platform user IDs (positive integers).
  const rows = [
    { user_id: -1, username: 'Staging demo builder A', current_streak: 3,  longest_streak: 7 },
    { user_id: -2, username: 'Staging demo builder B', current_streak: 7,  longest_streak: 14 },
    { user_id: -3, username: 'Staging demo builder C', current_streak: 14, longest_streak: 30 },
    { user_id: -4, username: 'Staging demo builder D', current_streak: 1,  longest_streak: 3 },
  ];
  for (const r of rows) {
    await pool.query(
      `INSERT INTO login_streaks (user_id, username, last_login_date, current_streak, longest_streak)
       VALUES ($1, $2, CURRENT_DATE, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [r.user_id, r.username, r.current_streak, r.longest_streak]
    );
  }
  // Seed streak milestone badges for the demo users so the badge panel shows mixed states.
  const milestoneSeeds = [
    { user_id: -1, badge_id: 'streak_3' },
    { user_id: -2, badge_id: 'streak_3' },
    { user_id: -2, badge_id: 'streak_7' },
    { user_id: -3, badge_id: 'streak_3' },
    { user_id: -3, badge_id: 'streak_7' },
    { user_id: -3, badge_id: 'streak_14' },
  ];
  for (const s of milestoneSeeds) {
    await pool.query(
      `INSERT INTO player_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [s.user_id, s.badge_id]
    );
  }
}

async function seedDuels() {
  // One finished duel for historical context (Alice beat Bob).
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const threeHalfMinAgo = new Date(Date.now() - 3.5 * 60 * 1000);
  await pool.query(
    `INSERT INTO duels
       (id, challenger_id, challenger_username, challenged_id, challenged_username,
        status, started_at, ends_at, challenger_blocks, challenged_blocks, winner_id,
        created_at, updated_at)
     VALUES (-1, -1, 'Staging demo Alice', -2, 'Staging demo Bob',
       'finished', $1, $2, 42, 31, -1, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [fiveMinAgo, threeHalfMinAgo]
  );
  // Ensure the sequence stays above 0 so real inserts don't collide with the seed row.
  await pool.query(`SELECT setval('duels_id_seq', GREATEST((SELECT COALESCE(MAX(id),0) FROM duels WHERE id > 0), 0), true)`);
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

  // Tracks which block types each player has ever placed. The blocks table
  // records only the current placer of each cell, so overwrites erase
  // history — this table preserves the full per-player type inventory.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_type_usage (
      user_id    INTEGER NOT NULL,
      block_type SMALLINT NOT NULL,
      PRIMARY KEY (user_id, block_type)
    )
  `);

  // One row per badge per player; append-only (badges are never revoked).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_badges (
      user_id   INTEGER NOT NULL,
      badge_id  VARCHAR(32) NOT NULL,
      earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, badge_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         BIGSERIAL PRIMARY KEY,
      user_id    INTEGER      NOT NULL,
      username   VARCHAR(255) NOT NULL,
      body       VARCHAR(200) NOT NULL,
      created_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS chat_messages_id_idx ON chat_messages (id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_presence (
      user_id   INTEGER PRIMARY KEY,
      username  VARCHAR(255) NOT NULL,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mode      VARCHAR(20) NOT NULL DEFAULT 'classic'
    )
  `);
  await pool.query(`
    ALTER TABLE user_presence
      ADD COLUMN IF NOT EXISTS mode VARCHAR(20) NOT NULL DEFAULT 'classic'
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_scores (
      week_start    DATE         NOT NULL,
      user_id       INTEGER      NOT NULL,
      username      VARCHAR(255) NOT NULL,
      score         BIGINT       NOT NULL DEFAULT 0,
      blocks_placed BIGINT       NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ  DEFAULT NOW(),
      PRIMARY KEY (week_start, user_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS tournament_scores_week_score_idx
    ON tournament_scores (week_start, score DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS powerups (
      id SERIAL PRIMARY KEY,
      type VARCHAR(20) NOT NULL,
      x SMALLINT NOT NULL,
      y SMALLINT NOT NULL,
      z SMALLINT NOT NULL,
      spawned_at TIMESTAMPTZ DEFAULT NOW(),
      claimed_at TIMESTAMPTZ,
      claimed_by_user_id INTEGER,
      claimed_by_username VARCHAR(255)
    )
  `);

  // Login streak tracking: one row per user, updated on each daily first visit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_streaks (
      user_id        INTEGER PRIMARY KEY,
      username       VARCHAR(255) NOT NULL,
      last_login_date DATE NOT NULL,
      current_streak INTEGER NOT NULL DEFAULT 1,
      longest_streak INTEGER NOT NULL DEFAULT 1,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Social graph: friend requests and accepted friendships.
  // Marked staging:private — the friend relationships between real users must
  // not be copied to staging containers.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      id                 BIGSERIAL PRIMARY KEY,
      requester_id       INTEGER      NOT NULL,
      addressee_id       INTEGER      NOT NULL,
      requester_username VARCHAR(255) NOT NULL,
      addressee_username VARCHAR(255) NOT NULL,
      status             VARCHAR(20)  NOT NULL DEFAULT 'pending',
      created_at         TIMESTAMPTZ  DEFAULT NOW(),
      updated_at         TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE (requester_id, addressee_id)
    )
  `);
  await pool.query(`COMMENT ON TABLE friendships IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS friendships_addressee_status_idx ON friendships (addressee_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS friendships_requester_status_idx ON friendships (requester_id, status)`);

  // Duel challenge history. Marked staging:private — pairs real user IDs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS duels (
      id                  BIGSERIAL    PRIMARY KEY,
      challenger_id       INTEGER      NOT NULL,
      challenger_username VARCHAR(255) NOT NULL,
      challenged_id       INTEGER      NOT NULL,
      challenged_username VARCHAR(255) NOT NULL,
      status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
      started_at          TIMESTAMPTZ,
      ends_at             TIMESTAMPTZ,
      challenger_blocks   INTEGER      NOT NULL DEFAULT 0,
      challenged_blocks   INTEGER      NOT NULL DEFAULT 0,
      winner_id           INTEGER,
      created_at          TIMESTAMPTZ  DEFAULT NOW(),
      updated_at          TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE duels IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS duels_challenger_status_idx ON duels (challenger_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS duels_challenged_status_idx ON duels (challenged_id, status)`);


  if (IS_STAGING) {
    try { await seedStaging(); }
    catch (err) { console.error('staging blocks seed failed', err); }
    try { await seedChat(); }
    catch (err) { console.error('staging chat seed failed', err); }
    try { await seedLeaderboard(); }
    catch (err) { console.error('leaderboard seed failed', err); }
    try { await seedTournament(); }
    catch (err) { console.error('tournament seed failed', err); }
    try { await seedStreaks(); }
    catch (err) { console.error('streak seed failed', err); }
    try { await seedDuels(); }
    catch (err) { console.error('staging duels seed failed', err); }
    try {
      // Two fake spectators so the eye-icon path is exercisable in staging.
      await pool.query(
        `INSERT INTO user_presence (user_id, username, last_seen, mode)
         VALUES (-9001, 'Staging demo spectator — Alice', NOW(), 'spectate'),
                (-9002, 'Staging demo spectator — Bob',   NOW(), 'spectate')
         ON CONFLICT (user_id) DO UPDATE SET last_seen = NOW(), mode = EXCLUDED.mode`
      );
    } catch (err) { console.error('staging spectator seed failed', err); }
  }

  await ensurePowerUps();

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
