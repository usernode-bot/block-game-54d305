const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN;

// Hardcoded demo presence entries for staging so the online list is always
// populated regardless of whether the seeded user_presence rows are still
// within their 60-second expiry window.
const STAGING_DEMO_USERS = [
  { username: 'Staging demo Alice', mode: 'classic' },
  { username: 'Staging demo Bob',   mode: 'classic' },
  { username: 'Staging demo spectator — Alice', mode: 'spectate' },
  { username: 'Staging demo spectator — Bob',   mode: 'spectate' },
];

// ---- Fixed shared-world parameters (authoritative; mirrored to client) ----
// Coordinates are integer cell indices. y is up. y = 0 is the immutable
// ground/base layer and is NOT stored as rows — buildable cells are y >= 1.
const DIMS = { w: 32, d: 32, h: 24 }; // x in [0,w-1], z in [0,d-1], y in [0,h-1]

// Block palette (authoritative). id 0 is reserved for "air" (a broken cell).
// `opacity` < 1 renders semi-transparent (glass). Colors are hex strings.
// `material` 'standard' uses MeshStandardMaterial (PBR); default is Lambert.
// `emissive` / `emissiveIntensity` add a glow. `powerup` marks animated blocks.
const PALETTE = [
  { id: 1,  name: 'Grass',         color: '#3dd847' },
  { id: 2,  name: 'Dirt',          color: '#b8643e' },
  { id: 3,  name: 'Stone',         color: '#a8aeb8' },
  { id: 4,  name: 'Wood',          color: '#d4944f' },
  { id: 5,  name: 'Leaves',        color: '#2ac142' },
  { id: 6,  name: 'Sand',          color: '#fce67f' },
  { id: 7,  name: 'Brick',         color: '#f04a38' },
  { id: 8,  name: 'Glass',         color: '#6fe3ff', opacity: 0.45 },
  { id: 9,  name: 'Red',           color: '#ff2626' },
  { id: 10, name: 'Blue',          color: '#2563ff' },
  { id: 11, name: 'Yellow',        color: '#ffd600' },
  { id: 12, name: 'White',         color: '#f4f4f8' },
  { id: 13, name: 'Snow',          color: '#d0e8ff' },
  { id: 14, name: 'Gold Block',    color: '#ffb800', material: 'standard', metalness: 0.85, roughness: 0.2 },
  { id: 15, name: 'Glowstone',     color: '#ffb43d', emissive: '#ff6a00', emissiveIntensity: 0.6 },
  { id: 16, name: 'Obsidian',      color: '#2d1555', material: 'standard', metalness: 0.3, roughness: 0.1 },
  { id: 17, name: 'Rainbow Block', color: '#ff1493', powerup: true },
  { id: 18, name: 'Crystal',       color: '#b39dff', opacity: 0.65, emissive: '#7a4dff', emissiveIntensity: 0.3, material: 'standard', metalness: 0.1, roughness: 0.2, unlockAt: 50, unlockIcon: '💎' },
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
  18: 3,  // Crystal Block
};

// Sentinel "user" id for staging seed rows so they never reference a real user.
const SEED_USER_ID = 0;

// ---- NFT skin helpers ----
const nftCache = new Map(); // user_id -> { ts: number, nfts: Array }
const NFT_CACHE_TTL = 5 * 60 * 1000;

function makeSvgDataUri(topColor, bottomColor) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="32" fill="${topColor}"/><rect y="32" width="64" height="32" fill="${bottomColor}"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const STAGING_DEMO_NFTS = [
  { skin_id: 'staging-nft-1', nft_name: 'Staging Demo Skin: Fire', image_url: makeSvgDataUri('#ff6600', '#cc2200') },
  { skin_id: 'staging-nft-2', nft_name: 'Staging Demo Skin: Ice',  image_url: makeSvgDataUri('#aaddff', '#0088cc') },
  { skin_id: 'staging-nft-3', nft_name: 'Staging Demo Skin: Void', image_url: makeSvgDataUri('#330055', '#110033') },
];

// ---- Mob / creature system ----
const MOB_DEFS = {
  slime:   { maxHp: 3, moveIntervalMs: 2500, groundMob: true  },
  zombie:  { maxHp: 4, moveIntervalMs: 1800, groundMob: true  },
  phantom: { maxHp: 2, moveIntervalMs: 1200, groundMob: false },
};
const MOB_SPAWN_CAPS = { slime: 3, zombie: 2, phantom: 2 };

let mobIdCounter = 1;
const mobs = new Map(); // id -> mob object

function pickMobSpawnPos(groundMob) {
  // Avoid staging seed build footprint (hut x13-19, z13-19).
  let x, z;
  for (let i = 0; i < 20; i++) {
    x = 2 + Math.floor(Math.random() * (DIMS.w - 4));
    z = 2 + Math.floor(Math.random() * (DIMS.d - 4));
    if (x < 13 || x > 19 || z < 13 || z > 19) break;
  }
  return { x, y: groundMob ? 1 : 8, z };
}

function spawnMob(type) {
  const def = MOB_DEFS[type];
  const { x, y, z } = pickMobSpawnPos(def.groundMob);
  const id = mobIdCounter++;
  mobs.set(id, {
    id, type, x, y, z,
    hp: def.maxHp, maxHp: def.maxHp,
    dead: false, diedAt: null,
    nextMoveAt: Date.now() + Math.floor(Math.random() * def.moveIntervalMs),
    phase: Math.random() * Math.PI * 2,
  });
}

function tickMobs() {
  const now = Date.now();
  for (const [, mob] of mobs) {
    if (mob.dead) {
      if (now - mob.diedAt >= 30_000) {
        const { x, y, z } = pickMobSpawnPos(MOB_DEFS[mob.type].groundMob);
        Object.assign(mob, { x, y, z, hp: mob.maxHp, dead: false, diedAt: null,
          nextMoveAt: now + MOB_DEFS[mob.type].moveIntervalMs });
      }
    } else if (now >= mob.nextMoveAt) {
      const def = MOB_DEFS[mob.type];
      const dirs = [{ dx: 1, dz: 0 }, { dx: -1, dz: 0 }, { dx: 0, dz: 1 }, { dx: 0, dz: -1 }];
      const { dx, dz } = dirs[Math.floor(Math.random() * 4)];
      mob.x = Math.max(1, Math.min(DIMS.w - 2, mob.x + dx));
      mob.z = Math.max(1, Math.min(DIMS.d - 2, mob.z + dz));
      mob.nextMoveAt = now + def.moveIntervalMs + Math.floor(Math.random() * 500);
    }
  }
}

function initMobs() {
  for (const [type, cap] of Object.entries(MOB_SPAWN_CAPS)) {
    for (let i = 0; i < cap; i++) spawnMob(type);
  }
  setInterval(tickMobs, 500);
}

// ---- Natural Disasters ----
const DISASTER_MIN_SECS = 180; // 3 minutes minimum between disasters
const DISASTER_MAX_SECS = 480; // 8 minutes maximum
const DISASTER_USER_ID = -999;
const DISASTER_USERNAME = 'Natural Disaster';
const DISASTER_DEFS = {
  earthquake: { label: 'Earthquake',       icon: '⚡', zoneMin: 8,  zoneMax: 12 },
  eruption:   { label: 'Volcanic Eruption', icon: '🌋', radiusMin: 5, radiusMax: 7 },
  meteor:     { label: 'Meteor Strike',     icon: '☄️', radiusMin: 3, radiusMax: 5 },
};

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
  { id: 'crystal_placer',  name: 'Crystal Placer',  icon: '💎', flavour: 'Placed a Crystal Block!' },
  { id: 'streak_3',        name: 'Hot Start',       icon: '🔥', flavour: 'Logged in 3 days in a row!' },
  { id: 'streak_7',        name: 'Week Warrior',     icon: '🗓️', flavour: 'A full week of building!' },
  { id: 'streak_14',       name: 'Fortnight Pro',    icon: '🏆', flavour: 'Two weeks of daily play!' },
  { id: 'streak_30',       name: 'Monthly Master',   icon: '👑', flavour: 'A full month on the block!' },
  { id: 'theme_winner',   name: 'Theme Champion',   icon: '🥇', flavour: 'First place in the daily build theme vote!' },
  { id: 'daily_devotee',   name: 'Daily Devotee',   icon: '🌟', flavour: 'Seven days of block-placing dedication!' },
  { id: 'daily_champion',  name: 'Daily Champion',  icon: '👑', flavour: 'Won the Daily Challenge!' },
  { id: 'speedrunner',     name: 'Speedrunner',     icon: '⚡', flavour: 'Blazing fast block placement!' },
];

const STREAK_BADGE_MILESTONES = [
  { days: 3,  id: 'streak_3' },
  { days: 7,  id: 'streak_7' },
  { days: 14, id: 'streak_14' },
  { days: 30, id: 'streak_30' },
];

// ---- Daily Build Theme Voting ----
const DAILY_THEMES = ['Castle', 'Ocean', 'Space', 'Forest', 'City', 'Cave', 'Desert', 'Snow', 'Sky Tower', 'Mountain', 'Dungeon', 'Crystal Palace'];

// Pick today's theme deterministically from a UTC date — same approach as dailyTarget().
function themeName(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = dateObj.getUTCMonth() + 1;
  const d = dateObj.getUTCDate();
  return DAILY_THEMES[(y * 31 + m * 7 + d) % DAILY_THEMES.length];
}

// Returns badges from BADGES that are newly earned given updated leaderboard
// totals, the block type just placed, and distinct type count.
function checkBadges({ lb, justPlacedType, typeCount, dailyChallengeStreak, completionTimeMs }, earnedIds) {
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
      case 'crystal_placer':  earned = justPlacedType === 18; break;
      case 'daily_devotee':   earned = dailyChallengeStreak >= 7; break;
      case 'speedrunner':     earned = completionTimeMs && completionTimeMs < 120000; break;
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
app.get('/api/world', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT x, y, z, block_type, skin_id FROM blocks WHERE block_type <> 0`
    );
    const cur = await pool.query(`SELECT COALESCE(MAX(seq), 0) AS cursor FROM blocks`);
    const maxDisasterRes = await pool.query(`SELECT COALESCE(MAX(id), 0) AS max_disaster_id FROM disasters`);
    const lbRow = await pool.query(`SELECT blocks_placed FROM leaderboard WHERE user_id = $1`, [req.user.id]);
    const userPlaced = lbRow.rows.length ? Number(lbRow.rows[0].blocks_placed) : 0;
    const unlockedTypes = PALETTE.filter((p) => p.unlockAt && userPlaced >= p.unlockAt).map((p) => p.id);
    const skinRow = await pool.query(
      `SELECT skin_id, image_url, nft_name FROM player_skins WHERE user_id = $1`, [req.user.id]
    );
    const activeSkin = skinRow.rows.length
      ? { skin_id: skinRow.rows[0].skin_id, image_url: skinRow.rows[0].image_url, nft_name: skinRow.rows[0].nft_name }
      : null;
    const tutorialRes = await pool.query(`SELECT user_id FROM player_tutorial_completed WHERE user_id = $1`, [req.user.id]);
    const tutorial_completed = tutorialRes.rows.length > 0;
    res.json({
      dims: DIMS,
      palette: PALETTE,
      blocks: rows.map((r) => ({ x: r.x, y: r.y, z: r.z, t: r.block_type, ...(r.skin_id ? { s: r.skin_id } : {}) })),
      cursor: Number(cur.rows[0].cursor),
      maxDisasterId: Number(maxDisasterRes.rows[0].max_disaster_id),
      unlockedTypes,
      activeSkin,
      isStaging: IS_STAGING,
      tutorial_completed,
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

    // Unlock gate: reject placement of block types the user hasn't earned yet.
    if (t !== 0) {
      const pe = PALETTE.find((p) => p.id === t);
      if (pe && pe.unlockAt) {
        const lockRes = await pool.query(
          `SELECT blocks_placed FROM leaderboard WHERE user_id = $1`, [req.user.id]
        );
        const placed = lockRes.rows.length ? Number(lockRes.rows[0].blocks_placed) : 0;
        if (placed < pe.unlockAt) return res.status(400).json({ error: 'block_type not unlocked' });
      }
    }

    // Read active skin for this player (only relevant for placements; breaks set skin to NULL).
    let activeSkinId = null;
    if (t !== 0) {
      const skinRes = await pool.query(`SELECT skin_id FROM player_skins WHERE user_id = $1`, [req.user.id]);
      activeSkinId = skinRes.rows.length ? skinRes.rows[0].skin_id : null;
    }

    const { rows } = await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, skin_id, seq, updated_by_user_id, updated_by_username, updated_at)
       VALUES ($1, $2, $3, $4, $7, nextval('block_seq'), $5, $6, NOW())
       ON CONFLICT (x, y, z) DO UPDATE SET
         block_type = EXCLUDED.block_type,
         skin_id = EXCLUDED.skin_id,
         seq = EXCLUDED.seq,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_by_username = EXCLUDED.updated_by_username,
         updated_at = NOW()
       RETURNING seq`,
      [x, y, z, t, req.user.id, req.user.username, activeSkinId]
    );
    const seq = Number(rows[0].seq);

    // Track challenge progress for placements only (breaks don't count).
    let challenge = null;
    // ---- Scoring (placements only; breaks earn 0) ----
    let earned = 0, combo_multiplier = 1, rainbow_multiplier = 1, combo_tier = 1;
    let newly_earned_badges = [];
    let newly_unlocked_types = [];
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

      const base = 10;

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

      // Get daily challenge streak for badge checking
      const streakRes = await pool.query(
        `SELECT current_streak FROM daily_challenge_streaks WHERE user_id = $1`,
        [req.user.id]
      );
      const dailyChallengeStreak = streakRes.rows.length ? Number(streakRes.rows[0].current_streak) : 0;

      // Check if challenge just completed and check speedrunner (< 2 minutes) and daily_champion (#1 rank)
      let speedrunnerMs = null;
      let isDaily1st = false;
      if (challenge && challenge.completed_at) {
        // Get when the user first placed a block on this challenge day
        const firstBlockRes = await pool.query(
          `SELECT created_at, completed_at FROM
             (SELECT user_id,
                   COALESCE(
                     (SELECT MIN(updated_at) FROM blocks WHERE updated_by_user_id = $1),
                     NOW()
                   ) as created_at,
                   completed_at
              FROM daily_challenge_progress
              WHERE user_id = $1 AND challenge_date = $2
             ) subq`,
          [req.user.id, dateStr]
        );
        if (firstBlockRes.rows.length && firstBlockRes.rows[0].completed_at) {
          // For speedrunner check, we estimate based on completed_at
          speedrunnerMs = 120000; // default assumption for now
        }

        // Check if user ranks #1 on the daily challenge
        const rank1Res = await pool.query(
          `SELECT rank FROM (
             SELECT rank() OVER (ORDER BY blocks_placed DESC, completed_at ASC) AS rank,
                    user_id
             FROM daily_challenge_progress
             WHERE challenge_date = $1
           ) ranked WHERE user_id = $2`,
          [dateStr, req.user.id]
        );
        if (rank1Res.rows.length && Number(rank1Res.rows[0].rank) === 1) {
          isDaily1st = true;
        }
      }

      // Evaluate predicates and insert any newly-earned badges.
      const newBadges = checkBadges({ lb, justPlacedType: t, typeCount, dailyChallengeStreak, completionTimeMs: speedrunnerMs }, earnedIds);

      // Award daily_champion if user just became #1
      if (isDaily1st && !earnedIds.has('daily_champion')) {
        newBadges.push(BADGES.find(b => b.id === 'daily_champion'));
      }

      for (const badge of newBadges) {
        await pool.query(
          `INSERT INTO player_badges (user_id, badge_id, earned_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
          [req.user.id, badge.id]
        );
      }
      newly_earned_badges = newBadges.map((b) => ({ id: b.id, name: b.name, icon: b.icon, flavour: b.flavour }));

      // Detect first crossing of any block unlock threshold (blocks_placed increments by 1 per
      // placement, so === only fires once — the exact turn the threshold is first reached).
      for (const up of PALETTE.filter((p) => p.unlockAt)) {
        if (lb.blocks_placed === up.unlockAt) {
          newly_unlocked_types.push({ id: up.id, name: up.name, icon: up.unlockIcon || '✨', description: 'A translucent gem-like block, earned through dedication.' });
        }
      }
    }

    // ---- Line clearing: detect and clear complete horizontal layers ----
    let lines_cleared = 0;
    let line_clear_points = 0;
    if (t !== 0) {
      // Check if the placed block's Y-coordinate now forms a complete line
      const lineCheckRes = await pool.query(
        `SELECT COUNT(*)::int AS count
         FROM blocks
         WHERE y = $1
           AND block_type <> 0
           AND x BETWEEN 0 AND 31
           AND z BETWEEN 0 AND 31`,
        [y]
      );
      if (lineCheckRes.rows[0].count === 1024) {
        // Line is complete — clear it by setting all blocks to 0 (air)
        await pool.query(
          `UPDATE blocks
           SET block_type = 0, seq = nextval('block_seq'), updated_at = NOW(), updated_by_user_id = $2, updated_by_username = $3
           WHERE y = $1 AND x BETWEEN 0 AND 31 AND z BETWEEN 0 AND 31`,
          [y, req.user.id, req.user.username]
        );
        lines_cleared = 1;
        line_clear_points = 50;

        // Award line-clear points to leaderboard
        await pool.query(
          `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
           VALUES ($1, $2, $3, 0, 0, NOW())
           ON CONFLICT (user_id) DO UPDATE SET
             total_score   = leaderboard.total_score + EXCLUDED.total_score,
             username      = EXCLUDED.username,
             updated_at    = NOW()`,
          [req.user.id, req.user.username, line_clear_points]
        );
      }
    }

    res.json({ ok: true, seq, ...(challenge ? { challenge } : {}), earned, combo_multiplier, rainbow_multiplier, newly_earned_badges, newly_unlocked_types, lines_cleared, line_clear_points, ...(activeSkinId ? { skin_id: activeSkinId } : {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Delta feed: every cell changed since the client's cursor, including
// breaks (block_type 0). Powers near-realtime collaborative editing.
// Supports world_id parameter: 0 = shared world, >0 = custom world (no disasters)
app.get('/api/world/changes', async (req, res) => {
  try {
    const since = Number(req.query.since) || 0;
    const eventsSince = Number(req.query.events_since) || 0;
    const world_id = Number(req.query.world_id) || 0;

    let events = [];
    // Only fire disasters in the shared world (world_id = 0)
    if (world_id === 0) {
      const newDisaster = await maybeFireDisaster();
      const eventsRes = await pool.query(
        `SELECT id, type, origin_x, origin_z, params, blocks_destroyed, triggered_at
         FROM disasters WHERE id > $1 ORDER BY id`,
        [eventsSince]
      );
      events = eventsRes.rows.map((r) => ({
        id: Number(r.id),
        type: r.type,
        label: DISASTER_DEFS[r.type] ? DISASTER_DEFS[r.type].label : r.type,
        icon: DISASTER_DEFS[r.type] ? DISASTER_DEFS[r.type].icon : '💥',
        origin_x: r.origin_x,
        origin_z: r.origin_z,
        params: r.params,
        blocks_destroyed: r.blocks_destroyed,
        triggered_at: r.triggered_at,
      }));
    }
    const eventsCursor = events.length ? events[events.length - 1].id : eventsSince;

    // For shared world, poll the blocks table; for custom worlds, return empty changes
    // (custom world block updates happen via POST /api/worlds/:id/blocks)
    let changes = [];
    let cursor = since;
    if (world_id === 0) {
      const { rows } = await pool.query(
        `SELECT x, y, z, block_type, skin_id, seq FROM blocks WHERE seq > $1 ORDER BY seq`,
        [since]
      );
      changes = rows.map((r) => ({ x: r.x, y: r.y, z: r.z, t: r.block_type, ...(r.skin_id ? { s: r.skin_id } : {}) }));
      if (rows.length) cursor = Number(rows[rows.length - 1].seq);
    }

    res.json({
      changes,
      cursor,
      events,
      eventsCursor,
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

// ---- Tutorial: check completion status ----
app.get('/api/tutorial/status', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT user_id FROM player_tutorial_completed WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ completed: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Tutorial: mark as completed ----
app.post('/api/tutorial/complete', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO player_tutorial_completed (user_id, completed_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Presence: heartbeat ping ----
app.post('/api/presence/ping', async (req, res) => {
  try {
    const rawMode = req.body && req.body.mode;
    const mode = ['classic', 'spectate'].includes(rawMode) ? rawMode : 'classic';
    const current_world_id = req.body && req.body.current_world_id ? Number(req.body.current_world_id) : null;
    await pool.query(
      `INSERT INTO user_presence (user_id, username, last_seen, mode, current_world_id)
       VALUES ($1, $2, NOW(), $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, last_seen = NOW(), mode = EXCLUDED.mode, current_world_id = EXCLUDED.current_world_id`,
      [req.user.id, req.user.username, mode, current_world_id]
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

    // Daily login reward: check if already claimed today
    let dailyReward = { claimed: false };
    const today = new Date().toISOString().slice(0, 10);
    const rewardCheckRes = await pool.query(
      `SELECT coins_earned FROM login_rewards WHERE user_id = $1 AND reward_date = $2`,
      [req.user.id, today]
    );

    if (rewardCheckRes.rows.length === 0) {
      // Calculate reward based on streak: base 10 coins, multiplier 1.0 + (streak * 0.1), capped at 3.0
      const multiplier = Math.min(3.0, 1.0 + (current_streak * 0.1));
      const coinsEarned = Math.round(10 * multiplier);

      // Insert reward claim
      await pool.query(
        `INSERT INTO login_rewards (user_id, reward_date, coins_earned)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [req.user.id, today, coinsEarned]
      );

      // Upsert player coins balance
      await pool.query(
        `INSERT INTO player_coins (user_id, coins_balance, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           coins_balance = player_coins.coins_balance + EXCLUDED.coins_balance,
           updated_at = NOW()`,
        [req.user.id, coinsEarned]
      );

      dailyReward = {
        claimed: true,
        coins_earned: coinsEarned,
        current_streak: current_streak,
        multiplier: parseFloat(multiplier.toFixed(1)),
      };
    } else {
      dailyReward = { claimed: true };
    }

    res.json({
      ok: true,
      streak: { current: current_streak, longest: longest_streak },
      newly_earned_badges: newlyEarnedBadges,
      daily_reward: dailyReward,
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

// ---- Player coins: current user's coin balance ----
app.get('/api/player/coins', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT coins_balance FROM player_coins WHERE user_id = $1`,
      [req.user.id]
    );
    const coins = rows.length ? Number(rows[0].coins_balance) : 0;
    res.json({ coins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Presence: who is online (seen in the last 60s), optionally filtered by world ----
app.get('/api/presence/online', async (req, res) => {
  try {
    const current_world_id = req.query.current_world_id ? Number(req.query.current_world_id) : null;

    let query = `SELECT username, mode, current_world_id FROM user_presence
       WHERE last_seen > NOW() - INTERVAL '60 seconds'`;
    if (current_world_id !== null) {
      query += ` AND (current_world_id = $1 OR current_world_id IS NULL)`;
    }
    query += ` ORDER BY username`;

    const params = current_world_id !== null ? [current_world_id] : [];
    const { rows } = await pool.query(query, params);
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

// ---- Time Attack: submit a completed run ----
// Body: { cleared, difficulty }. Keeps only the best run per user — the
// upsert overwrites the stored row only when this run beats best_cleared.
app.post('/api/ta-score', async (req, res) => {
  try {
    const cleared = Number(req.body.cleared);
    const difficulty = Number(req.body.difficulty);
    if (!Number.isInteger(cleared) || cleared < 0) {
      return res.status(400).json({ error: 'cleared must be a non-negative integer' });
    }
    if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5) {
      return res.status(400).json({ error: 'difficulty must be 1-5' });
    }
    // Upsert: only improve the stored best. RETURNING tells us the row that
    // now stands; is_new_best is whether this run produced it.
    const { rows } = await pool.query(
      `INSERT INTO ta_scores (user_id, username, best_cleared, best_difficulty, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET best_cleared = EXCLUDED.best_cleared,
             best_difficulty = EXCLUDED.best_difficulty,
             username = EXCLUDED.username,
             updated_at = NOW()
       WHERE EXCLUDED.best_cleared > ta_scores.best_cleared
       RETURNING best_cleared`,
      [req.user.id, req.user.username, cleared, difficulty]
    );
    let best_cleared, is_new_best;
    if (rows.length) {
      // Either the first insert or a genuine improvement applied.
      best_cleared = Number(rows[0].best_cleared);
      is_new_best = true;
    } else {
      // Conflict where the WHERE guard blocked the update — fetch standing best.
      const cur = await pool.query(
        `SELECT best_cleared FROM ta_scores WHERE user_id = $1`, [req.user.id]
      );
      best_cleared = cur.rows.length ? Number(cur.rows[0].best_cleared) : cleared;
      is_new_best = false;
    }
    res.json({ ok: true, best_cleared, is_new_best });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Time Attack leaderboard: top 10 by best run + caller's own best ----
app.get('/api/ta-leaderboard', async (req, res) => {
  try {
    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_cleared DESC) AS rank,
              user_id, username, best_cleared, best_difficulty
       FROM ta_scores
       ORDER BY best_cleared DESC
       LIMIT 10`
    );
    const selfRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_cleared DESC) AS rank,
              user_id, username, best_cleared, best_difficulty
       FROM ta_scores
       WHERE user_id = $1`,
      [req.user.id]
    );
    const toRow = (r) => ({
      rank: Number(r.rank),
      user_id: r.user_id,
      username: r.username,
      best_cleared: Number(r.best_cleared),
      best_difficulty: Number(r.best_difficulty),
    });
    res.json({
      entries: topRes.rows.map(toRow),
      self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Time Attack (60s): submit a completed run ----
// Body: { cleared }. Keeps only the best run per user.
app.post('/api/ta-60-score', async (req, res) => {
  try {
    const cleared = Number(req.body.cleared);
    if (!Number.isInteger(cleared) || cleared < 0) {
      return res.status(400).json({ error: 'cleared must be a non-negative integer' });
    }
    const { rows } = await pool.query(
      `INSERT INTO ta_60_scores (user_id, username, best_cleared, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET best_cleared = EXCLUDED.best_cleared,
             username = EXCLUDED.username,
             updated_at = NOW()
       WHERE EXCLUDED.best_cleared > ta_60_scores.best_cleared
       RETURNING best_cleared`,
      [req.user.id, req.user.username, cleared]
    );
    let best_cleared, is_new_best;
    if (rows.length) {
      best_cleared = Number(rows[0].best_cleared);
      is_new_best = true;
    } else {
      const cur = await pool.query(
        `SELECT best_cleared FROM ta_60_scores WHERE user_id = $1`, [req.user.id]
      );
      best_cleared = cur.rows.length ? Number(cur.rows[0].best_cleared) : cleared;
      is_new_best = false;
    }
    res.json({ ok: true, best_cleared, is_new_best });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Time Attack (60s) leaderboard: top 10 by best run + caller's own best ----
app.get('/api/ta-60-leaderboard', async (req, res) => {
  try {
    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_cleared DESC) AS rank,
              user_id, username, best_cleared
       FROM ta_60_scores
       ORDER BY best_cleared DESC
       LIMIT 10`
    );
    const selfRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_cleared DESC) AS rank,
              user_id, username, best_cleared
       FROM ta_60_scores
       WHERE user_id = $1`,
      [req.user.id]
    );
    const toRow = (r) => ({
      rank: Number(r.rank),
      user_id: r.user_id,
      username: r.username,
      best_cleared: Number(r.best_cleared),
    });
    res.json({
      entries: topRes.rows.map(toRow),
      self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Endless Mode: submit a completed run ----
// Body: { placed, moves_survived }. Keeps only the best run per user.
app.post('/api/endless-score', async (req, res) => {
  try {
    const placed = Number(req.body.placed);
    const moves_survived = Number(req.body.moves_survived);
    if (!Number.isInteger(placed) || placed < 0) {
      return res.status(400).json({ error: 'placed must be a non-negative integer' });
    }
    if (!Number.isInteger(moves_survived) || moves_survived < 0) {
      return res.status(400).json({ error: 'moves_survived must be a non-negative integer' });
    }
    const { rows } = await pool.query(
      `INSERT INTO endless_scores (user_id, username, best_placed, best_moves_survived, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET best_placed = EXCLUDED.best_placed,
             best_moves_survived = EXCLUDED.best_moves_survived,
             username = EXCLUDED.username,
             updated_at = NOW()
       WHERE EXCLUDED.best_placed > endless_scores.best_placed
       RETURNING best_placed`,
      [req.user.id, req.user.username, placed, moves_survived]
    );
    let best_placed, is_new_best;
    if (rows.length) {
      best_placed = Number(rows[0].best_placed);
      is_new_best = true;
    } else {
      const cur = await pool.query(
        `SELECT best_placed FROM endless_scores WHERE user_id = $1`, [req.user.id]
      );
      best_placed = cur.rows.length ? Number(cur.rows[0].best_placed) : placed;
      is_new_best = false;
    }
    res.json({ ok: true, best_placed, is_new_best });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Endless Mode leaderboard: top 10 by best blocks placed + caller's entry ----
app.get('/api/endless-leaderboard', async (req, res) => {
  try {
    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_placed DESC) AS rank,
              user_id, username, best_placed, best_moves_survived
       FROM endless_scores
       ORDER BY best_placed DESC
       LIMIT 10`
    );
    const selfRes = await pool.query(
      `SELECT rank() OVER (ORDER BY best_placed DESC) AS rank,
              user_id, username, best_placed, best_moves_survived
       FROM endless_scores
       WHERE user_id = $1`,
      [req.user.id]
    );
    const toRow = (r) => ({
      rank: Number(r.rank),
      user_id: r.user_id,
      username: r.username,
      best_placed: Number(r.best_placed),
      best_moves_survived: Number(r.best_moves_survived),
    });
    res.json({
      entries: topRes.rows.map(toRow),
      self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Puzzle Mode: get level definition ----
app.post('/api/puzzle-level/:levelNumber', async (req, res) => {
  try {
    const levelNumber = Number(req.params.levelNumber);
    if (!Number.isInteger(levelNumber) || levelNumber < 1) {
      return res.status(400).json({ error: 'level_number must be a positive integer' });
    }

    // Fetch or generate the level
    let levelRes = await pool.query(
      `SELECT level_number, block_snapshot, target_blocks_to_clear
       FROM puzzle_level_definitions
       WHERE level_number = $1`,
      [levelNumber]
    );

    // If level doesn't exist in DB, generate it on the fly
    if (!levelRes.rows.length) {
      const blocks = generatePuzzleBlocks(levelNumber);
      const target = 10 + Math.min(levelNumber * 5, 100); // Target scales with level, capped at 110
      return res.json({
        level_number: levelNumber,
        block_snapshot: blocks,
        target_blocks_to_clear: target,
      });
    }

    const row = levelRes.rows[0];
    res.json({
      level_number: Number(row.level_number),
      block_snapshot: row.block_snapshot,
      target_blocks_to_clear: Number(row.target_blocks_to_clear),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Puzzle Mode: place/break a block ----
app.post('/api/puzzle-block', async (req, res) => {
  try {
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    const z = Number(req.body.z);
    const t = Number(req.body.block_type);

    // Strict validation (same as /api/block)
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

    // For puzzle mode, we don't validate against the puzzle-specific blocks—
    // that's handled client-side. This just validates the request is well-formed.
    // The response doesn't impact global scoring or presence.

    res.json({ ok: true, x, y, z, block_type: t });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Puzzle Mode: submit a completed level ----
app.post('/api/puzzle-score', async (req, res) => {
  try {
    const levelNumber = Number(req.body.level_number);
    const blocksCleared = Number(req.body.blocks_cleared_session);
    const timeMs = Number(req.body.time_ms);

    if (!Number.isInteger(levelNumber) || levelNumber < 1) {
      return res.status(400).json({ error: 'level_number must be a positive integer' });
    }
    if (!Number.isInteger(blocksCleared) || blocksCleared < 0) {
      return res.status(400).json({ error: 'blocks_cleared_session must be non-negative' });
    }
    if (!Number.isInteger(timeMs) || timeMs < 0) {
      return res.status(400).json({ error: 'time_ms must be non-negative' });
    }

    // Upsert puzzle score: only update if this level is higher than current
    const { rows } = await pool.query(
      `INSERT INTO puzzle_scores (user_id, username, highest_level, total_blocks_cleared_best_session, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET highest_level = GREATEST(puzzle_scores.highest_level, EXCLUDED.highest_level),
             total_blocks_cleared_best_session = CASE
               WHEN EXCLUDED.highest_level > puzzle_scores.highest_level
               THEN EXCLUDED.total_blocks_cleared_best_session
               ELSE puzzle_scores.total_blocks_cleared_best_session
             END,
             username = EXCLUDED.username,
             updated_at = NOW()
       RETURNING highest_level, total_blocks_cleared_best_session`,
      [req.user.id, req.user.username, levelNumber, blocksCleared]
    );

    const isNewBest = rows[0].highest_level === levelNumber;
    res.json({
      ok: true,
      highest_level: Number(rows[0].highest_level),
      total_blocks_cleared_best_session: Number(rows[0].total_blocks_cleared_best_session),
      is_new_best: isNewBest,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Puzzle Mode leaderboard: top 10 by highest level + caller's own rank ----
app.get('/api/puzzle-leaderboard', async (req, res) => {
  try {
    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY highest_level DESC, total_blocks_cleared_best_session DESC) AS rank,
              user_id, username, highest_level, total_blocks_cleared_best_session
       FROM puzzle_scores
       ORDER BY highest_level DESC, total_blocks_cleared_best_session DESC
       LIMIT 10`
    );

    const selfRes = await pool.query(
      `SELECT rank() OVER (ORDER BY highest_level DESC, total_blocks_cleared_best_session DESC) AS rank,
              user_id, username, highest_level, total_blocks_cleared_best_session
       FROM puzzle_scores
       WHERE user_id = $1`,
      [req.user.id]
    );

    const toRow = (r) => ({
      rank: Number(r.rank),
      user_id: r.user_id,
      username: r.username,
      highest_level: Number(r.highest_level),
      total_blocks_cleared_best_session: Number(r.total_blocks_cleared_best_session),
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

// ---- Public player profile: fetch stats across all modes ----
app.get('/api/profile/:username', async (req, res) => {
  try {
    const username = req.params.username.toLowerCase();

    // Fetch Classic mode stats
    const classicRes = await pool.query(
      `SELECT user_id, username, total_score, blocks_placed, best_combo FROM leaderboard WHERE LOWER(username) = $1`,
      [username]
    );

    // Fetch Time Attack stats
    const taRes = await pool.query(
      `SELECT user_id, username, best_cleared, best_difficulty FROM ta_scores WHERE LOWER(username) = $1`,
      [username]
    );

    // Fetch Time Attack 60s stats
    const ta60Res = await pool.query(
      `SELECT user_id, username, best_cleared FROM ta_60_scores WHERE LOWER(username) = $1`,
      [username]
    );

    // Fetch Endless stats
    const endlessRes = await pool.query(
      `SELECT user_id, username, best_placed, best_moves_survived FROM endless_scores WHERE LOWER(username) = $1`,
      [username]
    );

    // Fetch Puzzle stats
    const puzzleRes = await pool.query(
      `SELECT user_id, username, highest_level, total_blocks_cleared_best_session FROM puzzle_scores WHERE LOWER(username) = $1`,
      [username]
    );

    // Get user_id from any available result, or return 404
    let userId = null;
    if (classicRes.rows.length) userId = classicRes.rows[0].user_id;
    else if (taRes.rows.length) userId = taRes.rows[0].user_id;
    else if (ta60Res.rows.length) userId = ta60Res.rows[0].user_id;
    else if (endlessRes.rows.length) userId = endlessRes.rows[0].user_id;
    else if (puzzleRes.rows.length) userId = puzzleRes.rows[0].user_id;

    if (!userId) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Get exact username from whichever table had data
    const exactUsername = classicRes.rows[0]?.username ||
                         taRes.rows[0]?.username ||
                         ta60Res.rows[0]?.username ||
                         endlessRes.rows[0]?.username ||
                         puzzleRes.rows[0]?.username;

    // Compute ranks for each mode (only if user has stats in that mode)
    let classicRank = null, taRank = null, ta60Rank = null, endlessRank = null, puzzleRank = null;

    if (classicRes.rows.length) {
      const rankRes = await pool.query(
        `SELECT rank() OVER (ORDER BY total_score DESC) AS rank FROM leaderboard WHERE LOWER(username) = $1`,
        [username]
      );
      classicRank = rankRes.rows.length ? Number(rankRes.rows[0].rank) : null;
    }

    if (taRes.rows.length) {
      const rankRes = await pool.query(
        `SELECT rank() OVER (ORDER BY best_cleared DESC) AS rank FROM ta_scores WHERE LOWER(username) = $1`,
        [username]
      );
      taRank = rankRes.rows.length ? Number(rankRes.rows[0].rank) : null;
    }

    if (ta60Res.rows.length) {
      const rankRes = await pool.query(
        `SELECT rank() OVER (ORDER BY best_cleared DESC) AS rank FROM ta_60_scores WHERE LOWER(username) = $1`,
        [username]
      );
      ta60Rank = rankRes.rows.length ? Number(rankRes.rows[0].rank) : null;
    }

    if (endlessRes.rows.length) {
      const rankRes = await pool.query(
        `SELECT rank() OVER (ORDER BY best_placed DESC) AS rank FROM endless_scores WHERE LOWER(username) = $1`,
        [username]
      );
      endlessRank = rankRes.rows.length ? Number(rankRes.rows[0].rank) : null;
    }

    if (puzzleRes.rows.length) {
      const rankRes = await pool.query(
        `SELECT rank() OVER (ORDER BY highest_level DESC, total_blocks_cleared_best_session DESC) AS rank FROM puzzle_scores WHERE LOWER(username) = $1`,
        [username]
      );
      puzzleRank = rankRes.rows.length ? Number(rankRes.rows[0].rank) : null;
    }

    // Fetch badges
    const badgesRes = await pool.query(
      `SELECT pb.badge_id, pb.earned_at, b.name, b.icon
       FROM player_badges pb
       JOIN (SELECT id, name, icon FROM (VALUES
         ('first_block', 'First Block', '🏗️'),
         ('builder', 'Builder', '🧱'),
         ('architect', 'Architect', '🏰'),
         ('high_scorer', 'High Scorer', '⭐'),
         ('comboist', 'Comboist', '⚡'),
         ('rainbow_placer', 'Rainbow Placer', '🌈'),
         ('golden_touch', 'Golden Touch', '✨'),
         ('glowmaster', 'Glowmaster', '💡'),
         ('shadow_sculptor', 'Shadow Sculptor', '🌑'),
         ('material_artist', 'Material Artist', '🎨'),
         ('crystal_placer', 'Crystal Placer', '💎'),
         ('streak_3', 'Hot Start', '🔥'),
         ('streak_7', 'Week Warrior', '🗓️'),
         ('streak_14', 'Fortnight Pro', '🏆'),
         ('streak_30', 'Monthly Master', '👑'),
         ('daily_devotee', 'Daily Devotee', '🌟'),
         ('daily_champion', 'Daily Champion', '👑'),
         ('speedrunner', 'Speedrunner', '⚡')
       ) AS badge_defs(id, name, icon)) AS b ON pb.badge_id = b.id
       WHERE pb.user_id = $1
       ORDER BY pb.earned_at`,
      [userId]
    );

    // Count distinct block types used
    const typeCountRes = await pool.query(
      `SELECT COUNT(DISTINCT block_type) as count FROM player_type_usage WHERE user_id = $1`,
      [userId]
    );
    const blockTypesUsed = typeCountRes.rows[0] ? Number(typeCountRes.rows[0].count) : 0;

    res.json({
      user_id: userId,
      username: exactUsername,
      stats: {
        classic: {
          total_score: classicRes.rows.length ? Number(classicRes.rows[0].total_score) : 0,
          blocks_placed: classicRes.rows.length ? Number(classicRes.rows[0].blocks_placed) : 0,
          best_combo: classicRes.rows.length ? classicRes.rows[0].best_combo : 1,
          rank: classicRank,
        },
        ta: {
          best_cleared: taRes.rows.length ? taRes.rows[0].best_cleared : 0,
          best_difficulty: taRes.rows.length ? taRes.rows[0].best_difficulty : 0,
          rank: taRank,
        },
        ta_60: {
          best_cleared: ta60Res.rows.length ? ta60Res.rows[0].best_cleared : 0,
          rank: ta60Rank,
        },
        endless: {
          best_placed: endlessRes.rows.length ? endlessRes.rows[0].best_placed : 0,
          best_moves_survived: endlessRes.rows.length ? endlessRes.rows[0].best_moves_survived : 0,
          rank: endlessRank,
        },
        puzzle: {
          highest_level: puzzleRes.rows.length ? Number(puzzleRes.rows[0].highest_level) : 0,
          total_blocks_cleared_best_session: puzzleRes.rows.length ? Number(puzzleRes.rows[0].total_blocks_cleared_best_session) : 0,
          rank: puzzleRank,
        },
      },
      badges: badgesRes.rows.map((r) => ({
        id: r.badge_id,
        name: r.name,
        icon: r.icon,
        earned_at: r.earned_at,
      })),
      block_types_used: blockTypesUsed,
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

// ---- Custom Worlds: list user's saved worlds ----
app.get('/api/worlds', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, world_name, blocks_count, created_at, owner_username
       FROM user_worlds
       WHERE owner_id = $1
       ORDER BY updated_at DESC
       LIMIT 10`,
      [req.user.id]
    );
    res.json({
      worlds: rows.map((r) => ({
        id: Number(r.id),
        world_name: r.world_name,
        blocks_count: Number(r.blocks_count),
        created_at: r.created_at,
        owner_username: r.owner_username,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Custom Worlds: save current (shared) world as a custom snapshot ----
app.post('/api/worlds', async (req, res) => {
  try {
    const world_name = (typeof req.body.world_name === 'string' ? req.body.world_name : '').trim();
    if (!world_name) return res.status(400).json({ error: 'world_name required' });
    if (world_name.length > 255) return res.status(400).json({ error: 'world_name too long' });

    const { rows: blocks } = await pool.query(
      `SELECT x, y, z, block_type FROM blocks WHERE block_type <> 0`
    );
    const block_snapshot = blocks.map((b) => ({ x: b.x, y: b.y, z: b.z, t: b.block_type }));
    const blocks_count = blocks.length;

    const { rows } = await pool.query(
      `INSERT INTO user_worlds (owner_id, owner_username, world_name, block_snapshot, blocks_count, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (owner_id, world_name) DO UPDATE SET
         block_snapshot = EXCLUDED.block_snapshot,
         blocks_count = EXCLUDED.blocks_count,
         updated_at = NOW()
       RETURNING id, world_name`,
      [req.user.id, req.user.username, world_name, JSON.stringify(block_snapshot), blocks_count]
    );
    res.json({ ok: true, id: Number(rows[0].id), world_name: rows[0].world_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Custom Worlds: get blocks from a world (world_id = 0 is shared world) ----
app.get('/api/worlds/:id/blocks', async (req, res) => {
  try {
    const world_id = Number(req.params.id);
    let blocks;

    if (world_id === 0) {
      const { rows } = await pool.query(
        `SELECT x, y, z, block_type FROM blocks WHERE block_type <> 0`
      );
      blocks = rows;
    } else {
      const { rows } = await pool.query(
        `SELECT block_snapshot FROM user_worlds WHERE id = $1`,
        [world_id]
      );
      if (!rows.length) return res.status(404).json({ error: 'World not found' });
      blocks = rows[0].block_snapshot || [];
    }

    res.json({
      blocks: blocks.map((b) => ({ x: b.x, y: b.y, z: b.z, t: b.block_type || b.t })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Custom Worlds: place/break a block in a custom world ----
app.post('/api/worlds/:id/blocks', async (req, res) => {
  try {
    const world_id = Number(req.params.id);
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

    if (world_id === 0) {
      return res.status(400).json({ error: 'Cannot modify shared world via custom endpoint' });
    }

    const { rows: worldRows } = await pool.query(
      `SELECT block_snapshot FROM user_worlds WHERE id = $1 FOR UPDATE`,
      [world_id]
    );
    if (!worldRows.length) return res.status(404).json({ error: 'World not found' });

    let blocks = worldRows[0].block_snapshot || [];
    const cellKey = `${x},${y},${z}`;
    const existingIndex = blocks.findIndex((b) => `${b.x},${b.y},${b.z}` === cellKey);

    if (t === 0) {
      if (existingIndex >= 0) blocks.splice(existingIndex, 1);
    } else {
      if (existingIndex >= 0) {
        blocks[existingIndex] = { x, y, z, t };
      } else {
        blocks.push({ x, y, z, t });
      }
    }

    const blocks_count = blocks.length;
    await pool.query(
      `UPDATE user_worlds SET block_snapshot = $1, blocks_count = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(blocks), blocks_count, world_id]
    );

    // Scoring still applies globally
    let earned = 0, combo_multiplier = 1, rainbow_multiplier = 1, combo_tier = 1;
    let newly_earned_badges = [];
    let newly_unlocked_types = [];
    if (t !== 0) {
      const base = BLOCK_POINTS[t] || 1;

      const comboRes = await pool.query(
        `SELECT COUNT(*)::int AS recent
         FROM blocks
         WHERE updated_by_user_id = $1
           AND block_type <> 0
           AND updated_at > NOW() - INTERVAL '10 seconds'`,
        [req.user.id]
      );
      const recent = comboRes.rows[0].recent;
      if (recent >= 10) { combo_multiplier = 5; combo_tier = 4; }
      else if (recent >= 6) { combo_multiplier = 3; combo_tier = 3; }
      else if (recent >= 3) { combo_multiplier = 2; combo_tier = 2; }

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

      const earnedRes = await pool.query(
        `SELECT badge_id FROM player_badges WHERE user_id = $1`,
        [req.user.id]
      );
      const earnedIds = new Set(earnedRes.rows.map((r) => r.badge_id));

      const typeCountRes = await pool.query(
        `SELECT COUNT(*)::int AS type_count FROM player_type_usage WHERE user_id = $1`,
        [req.user.id]
      );
      const typeCount = typeCountRes.rows[0].type_count;

      const newBadges = checkBadges({ lb, justPlacedType: t, typeCount }, earnedIds);
      for (const badge of newBadges) {
        await pool.query(
          `INSERT INTO player_badges (user_id, badge_id, earned_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
          [req.user.id, badge.id]
        );
      }
      newly_earned_badges = newBadges.map((b) => ({ id: b.id, name: b.name, icon: b.icon, flavour: b.flavour }));

      for (const up of PALETTE.filter((p) => p.unlockAt)) {
        if (lb.blocks_placed === up.unlockAt) {
          newly_unlocked_types.push({ id: up.id, name: up.name, icon: up.unlockIcon || '✨', description: 'A translucent gem-like block, earned through dedication.' });
        }
      }

      await pool.query(
        `INSERT INTO player_type_usage (user_id, block_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.user.id, t]
      );
    }

    res.json({ ok: true, seq: 0, earned, combo_multiplier, rainbow_multiplier, newly_earned_badges, newly_unlocked_types });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Custom Worlds: rename or update a world ----
app.put('/api/worlds/:id', async (req, res) => {
  try {
    const world_id = Number(req.params.id);
    const world_name = typeof req.body.world_name === 'string' ? req.body.world_name.trim() : null;

    const { rows: ownerRows } = await pool.query(
      `SELECT owner_id FROM user_worlds WHERE id = $1`,
      [world_id]
    );
    if (!ownerRows.length) return res.status(404).json({ error: 'World not found' });
    if (ownerRows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    if (world_name) {
      if (world_name.length > 255) return res.status(400).json({ error: 'world_name too long' });
      await pool.query(
        `UPDATE user_worlds SET world_name = $1, updated_at = NOW() WHERE id = $2`,
        [world_name, world_id]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Custom Worlds: delete a world ----
app.delete('/api/worlds/:id', async (req, res) => {
  try {
    const world_id = Number(req.params.id);

    const { rows } = await pool.query(
      `DELETE FROM user_worlds WHERE id = $1 AND owner_id = $2 RETURNING id`,
      [world_id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'World not found or not authorized' });

    res.json({ ok: true });
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
// Returns { date, target, placed, completed_at, streak }.
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
    const streakRes = await pool.query(
      `SELECT current_streak FROM daily_challenge_streaks WHERE user_id = $1`,
      [req.user.id]
    );
    const streak = streakRes.rows.length ? Number(streakRes.rows[0].current_streak) : 0;
    res.json({
      date: dateStr,
      target,
      placed: row ? row.blocks_placed : 0,
      completed_at: row ? row.completed_at : null,
      streak,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Challenge: leaderboard for a specific date ----
app.get('/api/challenge/leaderboard', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = (req.query.date || now.toISOString().slice(0, 10));
    const target = dailyTarget(new Date(dateStr + 'T00:00:00Z'));

    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY blocks_placed DESC, completed_at ASC) AS rank,
              user_id, username, blocks_placed, completed_at
       FROM daily_challenge_progress
       WHERE challenge_date = $1 AND blocks_placed > 0
       ORDER BY blocks_placed DESC, completed_at ASC
       LIMIT 10`,
      [dateStr]
    );

    const selfRes = await pool.query(
      `SELECT * FROM (
         SELECT rank() OVER (ORDER BY blocks_placed DESC, completed_at ASC) AS rank,
                user_id, username, blocks_placed, completed_at
         FROM daily_challenge_progress
         WHERE challenge_date = $1
       ) ranked WHERE user_id = $2`,
      [dateStr, req.user.id]
    );

    const toRow = (r) => ({
      rank: Number(r.rank),
      user_id: Number(r.user_id),
      username: r.username,
      blocks_placed: Number(r.blocks_placed),
      completed_at: r.completed_at ? r.completed_at.toISOString() : null,
    });

    res.json({
      date: dateStr,
      target,
      entries: topRes.rows.map(toRow),
      self: selfRes.rows.length ? toRow(selfRes.rows[0]) : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Challenge: complete (trigger streak tracking and rewards) ----
app.post('/api/challenge/complete', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const { challenge_date, completed_at } = req.body;

    // Check if user has already been rewarded for this day
    const existingReward = await pool.query(
      `SELECT id FROM daily_challenge_rewards WHERE user_id = $1 AND reward_date = $2`,
      [req.user.id, challenge_date || dateStr]
    );

    if (existingReward.rows.length > 0) {
      return res.json({ ok: false, error: 'Already rewarded for this day' });
    }

    // Get or create streak entry
    const streakRes = await pool.query(
      `SELECT current_streak, longest_streak, last_completed_date
       FROM daily_challenge_streaks WHERE user_id = $1`,
      [req.user.id]
    );

    let currentStreak = 0;
    let longestStreak = 0;
    let coinsEarned = 50; // base reward
    let badgesEarned = [];
    const rewardDate = challenge_date || dateStr;

    if (streakRes.rows.length > 0) {
      const streak = streakRes.rows[0];
      currentStreak = Number(streak.current_streak);
      longestStreak = Number(streak.longest_streak);
      const lastDate = streak.last_completed_date;

      // Calculate if streak continues
      if (lastDate) {
        const lastDateObj = new Date(lastDate + 'T00:00:00Z');
        const yesterdayObj = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const yesterdayStr = yesterdayObj.toISOString().slice(0, 10);
        if (lastDate === yesterdayStr) {
          currentStreak++;
        } else if (lastDate !== rewardDate) {
          currentStreak = 1;
        }
      }
    } else {
      currentStreak = 1;
    }

    if (currentStreak > longestStreak) {
      longestStreak = currentStreak;
    }

    // Calculate streak bonus: +10 coins per day, capped at +100 (10 day streak)
    const streakBonus = Math.min(100, (currentStreak - 1) * 10);
    coinsEarned += streakBonus;
    const streakMultiplier = 1 + streakBonus / 50;

    // Award speedrunner badge if applicable
    if (completed_at) {
      const completionTime = new Date(completed_at);
      const createdTime = new Date(); // fallback; ideally from progress row
      // For speedrunner, we need to check if completion was under 2 minutes
      // This will be checked in the block placement when challenge completes
    }

    // Award daily_devotee badge if streak >= 7
    if (currentStreak >= 7) {
      const existingBadge = await pool.query(
        `SELECT 1 FROM player_badges WHERE user_id = $1 AND badge_id = $2`,
        [req.user.id, 'daily_devotee']
      );
      if (!existingBadge.rows.length) {
        await pool.query(
          `INSERT INTO player_badges (user_id, badge_id, earned_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT DO NOTHING`,
          [req.user.id, 'daily_devotee']
        );
        badgesEarned.push('daily_devotee');
      }
    }

    // Update streak and longest streak
    await pool.query(
      `INSERT INTO daily_challenge_streaks (user_id, current_streak, longest_streak, last_completed_date, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         current_streak = $2,
         longest_streak = $3,
         last_completed_date = $4,
         updated_at = NOW()`,
      [req.user.id, currentStreak, longestStreak, rewardDate]
    );

    // Award coins
    await pool.query(
      `INSERT INTO player_coins (user_id, coins_balance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         coins_balance = player_coins.coins_balance + $2,
         updated_at = NOW()`,
      [req.user.id, coinsEarned]
    );

    // Record reward in audit log
    await pool.query(
      `INSERT INTO daily_challenge_rewards (user_id, reward_date, coins_earned, streak_bonus_multiplier, earned_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, reward_date) DO NOTHING`,
      [req.user.id, rewardDate, coinsEarned, streakMultiplier]
    );

    res.json({
      ok: true,
      streak: currentStreak,
      coins_earned: coinsEarned,
      badges_earned: badgesEarned,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Challenge: user's all-time statistics ----
app.get('/api/challenge/stats', async (req, res) => {
  try {
    const completionsRes = await pool.query(
      `SELECT COUNT(*) as total FROM daily_challenge_rewards WHERE user_id = $1`,
      [req.user.id]
    );
    const total_completions = Number(completionsRes.rows[0].total);

    const streakRes = await pool.query(
      `SELECT current_streak, longest_streak FROM daily_challenge_streaks WHERE user_id = $1`,
      [req.user.id]
    );
    const current_streak = streakRes.rows.length ? Number(streakRes.rows[0].current_streak) : 0;
    const longest_streak = streakRes.rows.length ? Number(streakRes.rows[0].longest_streak) : 0;

    const coinsRes = await pool.query(
      `SELECT COALESCE(SUM(coins_earned), 0) as total FROM daily_challenge_rewards WHERE user_id = $1`,
      [req.user.id]
    );
    const total_coins_earned = Number(coinsRes.rows[0].total);

    const badgesRes = await pool.query(
      `SELECT badge_id FROM player_badges
       WHERE user_id = $1 AND badge_id IN ('daily_devotee', 'daily_champion', 'speedrunner')`,
      [req.user.id]
    );
    const badges = badgesRes.rows.map(r => r.badge_id);

    res.json({
      total_completions,
      current_streak,
      longest_streak,
      total_coins_earned,
      badges,
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

// ---- Mobs: list all alive mobs ----
app.get('/api/mobs', (_req, res) => {
  const result = [];
  for (const [, mob] of mobs) {
    if (!mob.dead) {
      result.push({ id: mob.id, type: mob.type, x: mob.x, y: mob.y, z: mob.z,
        hp: mob.hp, maxHp: mob.maxHp, phase: mob.phase });
    }
  }
  res.json({ mobs: result });
});

// ---- Mobs: deal 1 damage to a mob ----
app.post('/api/mobs/:id/hit', (req, res) => {
  const id = Number(req.params.id);
  const mob = mobs.get(id);
  if (!mob || mob.dead) return res.status(404).json({ error: 'mob not found or dead' });
  mob.hp -= 1;
  if (mob.hp <= 0) { mob.hp = 0; mob.dead = true; mob.diedAt = Date.now(); }
  res.json({ ok: true, hp: mob.hp, dead: mob.dead });
});

// ---- AI Coach ----
const CANNED_TIPS = {
  mode_start:         'Place 3 or more blocks within 10 seconds to activate a combo multiplier and earn bonus points.',
  time_attack_start:  'In Time Attack, ignore scattered singles — aim for the dense clusters to break multiple blocks fast.',
  badge_earned:       'Great — keep building to unlock more block types and climb the leaderboard.',
  combo_tier_up:      "You've got a hot streak going! Keep placing blocks quickly to push the multiplier even higher.",
  daily_complete:     'Daily challenge done! Come back tomorrow — the target changes every day.',
  block_milestone:    'Try collecting a floating power-up orb to get a speed boost or rapid-place buff.',
  player_asked:       'Grab a Rainbow Block from the palette (type 9) and place it — it doubles your points for the next 30 seconds.',
  disaster:           'A disaster just struck the world! Rebuild quickly to earn points.',
};

app.post('/api/coach/tip', async (req, res) => {
  const { trigger, mode, blocks_placed, score, unlocked_types_count, combo_tier, active_buffs, challenge_progress, badge_name } = req.body || {};

  if (!LLM_ENABLED) {
    const tip = CANNED_TIPS[trigger] || CANNED_TIPS['player_asked'];
    return res.json({ tip });
  }

  const lines = [
    `Trigger reason: ${trigger}`,
    `Game mode: ${mode}`,
    `Blocks placed this session: ${blocks_placed}`,
    `Score this session: ${score}`,
    `Block types unlocked: ${unlocked_types_count} of 18`,
    `Current combo tier: ${combo_tier} (1=none, 2=×2, 3=×3, 4=×5)`,
    `Active power-up buffs: ${(active_buffs || []).join(', ') || 'none'}`,
    challenge_progress ? `Daily challenge: ${challenge_progress.placed}/${challenge_progress.target} blocks (${challenge_progress.completed ? 'completed' : 'in progress'})` : null,
    badge_name ? `Badge just earned: "${badge_name}"` : null,
  ].filter(Boolean).join('\n');

  try {
    const resp = await fetch(`${process.env.USERNODE_LLM_PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-usernode-app-token': process.env.USERNODE_LLM_PROXY_TOKEN,
        'x-usernode-user-token': req.headers['x-usernode-token'],
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 120,
        system: "You are an encouraging AI coach for a 3D block-building game called block-game. Players fly around a 32×32×24 world, place and break blocks, earn combo multipliers by placing quickly, unlock new block types, collect power-ups, and compete on leaderboards. Give exactly one tip (1-2 sentences, friendly and actionable, no markdown, no line breaks). Tailor it to the player's current situation.",
        messages: [{ role: 'user', content: lines }],
      }),
    });

    if (resp.status === 403) {
      const body = await resp.json().catch(() => ({}));
      if (body.code === 'grant_required') return res.status(403).json({ error: 'grant_required' });
    }
    if (resp.status === 429) return res.status(429).json({ error: 'unavailable' });
    if (!resp.ok) return res.status(500).json({ error: 'unavailable' });

    const llmData = await resp.json();
    const tip = llmData?.content?.[0]?.text?.trim() || '';
    if (!tip) return res.status(500).json({ error: 'unavailable' });
    return res.json({ tip });
  } catch (err) {
    console.error('coach tip error', err.message);
    return res.status(500).json({ error: 'unavailable' });
  }
});

// ---- NFT Block Skins ----

// Returns NFTs owned by the requesting user. In staging, returns hardcoded
// demo NFTs regardless of wallet state. In production, queries NODE_RPC_URL.
app.get('/api/skins/my-nfts', async (req, res) => {
  try {
    if (IS_STAGING) {
      return res.json({ wallet_linked: true, nfts: STAGING_DEMO_NFTS });
    }

    const pubkey = req.user.usernode_pubkey;
    if (!pubkey) return res.json({ wallet_linked: false, nfts: [] });

    // Check in-process cache (5-minute TTL).
    const cached = nftCache.get(req.user.id);
    if (cached && Date.now() - cached.ts < NFT_CACHE_TTL) {
      return res.json({ wallet_linked: true, nfts: cached.nfts });
    }

    // Best-effort RPC call to Usernode node for NFT ownership.
    let nfts = [];
    if (process.env.NODE_RPC_URL) {
      try {
        const rpcRes = await fetch(process.env.NODE_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getNFTs', params: [pubkey] }),
        });
        if (rpcRes.ok) {
          const rpcData = await rpcRes.json();
          const raw = rpcData?.result ?? [];
          nfts = Array.isArray(raw) ? raw.map((item) => ({
            skin_id: `${item.contract}:${item.tokenId}`,
            nft_name: item.name || `NFT #${item.tokenId}`,
            image_url: item.imageUrl || item.image || '',
          })).filter((n) => n.image_url) : [];
        }
      } catch (_) { /* RPC unavailable — return empty list */ }
    }

    nftCache.set(req.user.id, { ts: Date.now(), nfts });
    res.json({ wallet_linked: true, nfts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Build Theme Voting API ----

app.get('/api/theme/today', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yesterdayStr = yesterdayDate.toISOString().slice(0, 10);

    // Ensure today's row exists.
    const theme = themeName(now);
    await pool.query(
      `INSERT INTO daily_theme_schedule (theme_date, theme_name)
       VALUES ($1, $2)
       ON CONFLICT (theme_date) DO NOTHING`,
      [todayStr, theme]
    );

    // Lazy-resolve yesterday's winner if not yet stamped.
    const { rows: yRows } = await pool.query(
      `SELECT theme_name, winner_user_id, winner_username, resolved_at
       FROM daily_theme_schedule WHERE theme_date = $1`,
      [yesterdayStr]
    );
    let yesterday = yRows[0] || null;
    if (yesterday && !yesterday.resolved_at) {
      const { rows: vRows } = await pool.query(
        `SELECT tv.nominee_user_id, COUNT(*) AS votes
         FROM theme_votes tv
         WHERE tv.theme_date = $1
         GROUP BY tv.nominee_user_id
         ORDER BY votes DESC, MIN(tv.voted_at) ASC
         LIMIT 1`,
        [yesterdayStr]
      );
      const winnerRow = vRows[0] || null;
      if (winnerRow) {
        const { rows: nRows } = await pool.query(
          `SELECT username FROM theme_nominations WHERE theme_date = $1 AND user_id = $2`,
          [yesterdayStr, winnerRow.nominee_user_id]
        );
        const winnerUsername = nRows[0]?.username || null;
        await pool.query(
          `UPDATE daily_theme_schedule
           SET winner_user_id = $1, winner_username = $2, resolved_at = NOW()
           WHERE theme_date = $3 AND resolved_at IS NULL`,
          [winnerRow.nominee_user_id, winnerUsername, yesterdayStr]
        );
        // Award theme_winner badge once (first win only).
        if (Number(winnerRow.nominee_user_id) > 0) {
          await pool.query(
            `INSERT INTO player_badges (user_id, badge_id, earned_at)
             VALUES ($1, 'theme_winner', NOW())
             ON CONFLICT DO NOTHING`,
            [winnerRow.nominee_user_id]
          );
        }
        yesterday = { ...yesterday, winner_user_id: winnerRow.nominee_user_id, winner_username: winnerUsername, resolved_at: new Date() };
      } else {
        await pool.query(
          `UPDATE daily_theme_schedule SET resolved_at = NOW()
           WHERE theme_date = $1 AND resolved_at IS NULL`,
          [yesterdayStr]
        );
        yesterday = { ...yesterday, resolved_at: new Date() };
      }
    }

    // Fetch today's nominations with vote counts, ordered by votes desc then submission time.
    const { rows: nominations } = await pool.query(
      `SELECT n.user_id, n.username, n.description, n.anchor_x, n.anchor_y, n.anchor_z, n.submitted_at,
              COUNT(v.voter_user_id)::int AS vote_count
       FROM theme_nominations n
       LEFT JOIN theme_votes v ON v.theme_date = n.theme_date AND v.nominee_user_id = n.user_id
       WHERE n.theme_date = $1
       GROUP BY n.user_id, n.username, n.description, n.anchor_x, n.anchor_y, n.anchor_z, n.submitted_at
       ORDER BY vote_count DESC, n.submitted_at ASC`,
      [todayStr]
    );

    const myNomination = nominations.find((n) => n.user_id === req.user.id) || null;

    const { rows: myVoteRows } = await pool.query(
      `SELECT nominee_user_id FROM theme_votes WHERE theme_date = $1 AND voter_user_id = $2`,
      [todayStr, req.user.id]
    );
    const myVote = myVoteRows[0]?.nominee_user_id || null;

    // Fetch winner's nomination anchor for camera-jump.
    let yesterdayAnchor = null;
    if (yesterday?.winner_user_id) {
      const { rows: aRows } = await pool.query(
        `SELECT anchor_x, anchor_y, anchor_z FROM theme_nominations
         WHERE theme_date = $1 AND user_id = $2`,
        [yesterdayStr, yesterday.winner_user_id]
      );
      yesterdayAnchor = aRows[0] || null;
    }

    res.json({
      theme_date: todayStr,
      theme_name: theme,
      nominations: nominations.map((n) => ({
        user_id: Number(n.user_id),
        username: n.username,
        description: n.description,
        anchor_x: n.anchor_x,
        anchor_y: n.anchor_y,
        anchor_z: n.anchor_z,
        vote_count: Number(n.vote_count),
        submitted_at: n.submitted_at,
      })),
      my_nomination: myNomination ? {
        user_id: Number(myNomination.user_id),
        description: myNomination.description,
        anchor_x: myNomination.anchor_x,
        anchor_y: myNomination.anchor_y,
        anchor_z: myNomination.anchor_z,
        vote_count: Number(myNomination.vote_count),
      } : null,
      my_vote: myVote ? Number(myVote) : null,
      yesterday: yesterday ? {
        theme_name: yesterday.theme_name,
        winner_user_id: yesterday.winner_user_id ? Number(yesterday.winner_user_id) : null,
        winner_username: yesterday.winner_username || null,
        anchor: yesterdayAnchor || null,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Equip an NFT skin: verifies ownership then upserts into player_skins.
app.post('/api/skins/equip', async (req, res) => {
  try {
    const { skin_id, image_url, nft_name } = req.body || {};
    if (!skin_id || typeof skin_id !== 'string' || skin_id.length > 64) {
      return res.status(400).json({ error: 'invalid skin_id' });
    }
    if (!image_url || typeof image_url !== 'string') {
      return res.status(400).json({ error: 'invalid image_url' });
    }

    // Verify ownership (skip in staging where all demo skins are always accessible).
    if (!IS_STAGING) {
      const pubkey = req.user.usernode_pubkey;
      if (!pubkey) return res.status(403).json({ error: 'no wallet linked' });

      // Re-fetch NFT list (use cache if fresh).
      let nfts = [];
      const cached = nftCache.get(req.user.id);
      if (cached && Date.now() - cached.ts < NFT_CACHE_TTL) {
        nfts = cached.nfts;
      } else if (process.env.NODE_RPC_URL) {
        try {
          const rpcRes = await fetch(process.env.NODE_RPC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getNFTs', params: [pubkey] }),
          });
          if (rpcRes.ok) {
            const rpcData = await rpcRes.json();
            const raw = rpcData?.result ?? [];
            nfts = Array.isArray(raw) ? raw.map((item) => ({
              skin_id: `${item.contract}:${item.tokenId}`,
              nft_name: item.name || `NFT #${item.tokenId}`,
              image_url: item.imageUrl || item.image || '',
            })).filter((n) => n.image_url) : [];
            nftCache.set(req.user.id, { ts: Date.now(), nfts });
          }
        } catch (_) { /* RPC unavailable */ }
      }
      const owned = nfts.some((n) => n.skin_id === skin_id);
      if (!owned) return res.status(403).json({ error: 'NFT not owned' });
    }

    await pool.query(
      `INSERT INTO player_skins (user_id, skin_id, image_url, nft_name, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET skin_id = EXCLUDED.skin_id, image_url = EXCLUDED.image_url, nft_name = EXCLUDED.nft_name, updated_at = NOW()`,
      [req.user.id, skin_id, image_url, nft_name || skin_id]
    );
    // Invalidate NFT cache so next my-nfts fetch is fresh.
    nftCache.delete(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/theme/nominate', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const { description, anchor_x, anchor_y, anchor_z } = req.body || {};

    const ax = Math.round(Number(anchor_x));
    const ay = Math.round(Number(anchor_y));
    const az = Math.round(Number(anchor_z));
    if (!Number.isFinite(ax) || ax < 0 || ax > 31) return res.status(400).json({ error: 'anchor_x out of bounds' });
    if (!Number.isFinite(ay) || ay < 1 || ay > 23) return res.status(400).json({ error: 'anchor_y out of bounds' });
    if (!Number.isFinite(az) || az < 0 || az > 31) return res.status(400).json({ error: 'anchor_z out of bounds' });
    if (!description || typeof description !== 'string') return res.status(400).json({ error: 'description required' });
    const desc = description.trim().slice(0, 80);
    if (!desc) return res.status(400).json({ error: 'description required' });

    const { rows: schedRows } = await pool.query(
      `SELECT resolved_at FROM daily_theme_schedule WHERE theme_date = $1`,
      [todayStr]
    );
    if (schedRows[0]?.resolved_at) return res.status(400).json({ error: 'Voting has closed for today' });

    await pool.query(
      `INSERT INTO theme_nominations (theme_date, user_id, username, description, anchor_x, anchor_y, anchor_z, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (theme_date, user_id) DO UPDATE
         SET description = EXCLUDED.description,
             anchor_x    = EXCLUDED.anchor_x,
             anchor_y    = EXCLUDED.anchor_y,
             anchor_z    = EXCLUDED.anchor_z`,
      [todayStr, req.user.id, req.user.username, desc, ax, ay, az]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unequip the active skin.
app.post('/api/skins/unequip', async (req, res) => {
  try {
    await pool.query(`DELETE FROM player_skins WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/theme/vote', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const nominee_user_id = Number(req.body?.nominee_user_id);
    if (!Number.isFinite(nominee_user_id) || nominee_user_id === 0) return res.status(400).json({ error: 'nominee_user_id required' });
    if (nominee_user_id === req.user.id) return res.status(400).json({ error: 'Cannot vote for yourself' });

    const { rows: schedRows } = await pool.query(
      `SELECT resolved_at FROM daily_theme_schedule WHERE theme_date = $1`,
      [todayStr]
    );
    if (schedRows[0]?.resolved_at) return res.status(400).json({ error: 'Voting has closed for today' });

    const { rows: nomRows } = await pool.query(
      `SELECT 1 FROM theme_nominations WHERE theme_date = $1 AND user_id = $2`,
      [todayStr, nominee_user_id]
    );
    if (!nomRows.length) return res.status(400).json({ error: 'Nominee has no nomination today' });

    await pool.query(
      `INSERT INTO theme_votes (theme_date, voter_user_id, nominee_user_id, voted_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (theme_date, voter_user_id) DO NOTHING`,
      [todayStr, req.user.id, nominee_user_id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Look up metadata for a skin by its skin_id (used by other clients to
// resolve textures they encounter in the block change feed).
app.get('/api/skins/:skin_id', async (req, res) => {
  try {
    const skinId = req.params.skin_id;
    // In staging, also serve the demo skin metadata without a DB lookup.
    if (IS_STAGING) {
      const demo = STAGING_DEMO_NFTS.find((n) => n.skin_id === skinId);
      if (demo) return res.json({ image_url: demo.image_url, nft_name: demo.nft_name });
    }
    const { rows } = await pool.query(
      `SELECT image_url, nft_name FROM player_skins WHERE skin_id = $1 LIMIT 1`,
      [skinId]
    );
    if (!rows.length) return res.status(404).json({ error: 'skin not found' });
    res.json({ image_url: rows[0].image_url, nft_name: rows[0].nft_name });
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
  set(24, 1, 10, 18); // Crystal Block (showcase row)
  set(20, 1, 11, 13); // Snow
  // Crystal spire so staging reviewers can see the block's appearance.
  set(10, 1, 22, 18);
  set(10, 2, 22, 18);
  set(10, 3, 22, 18);
  set(11, 2, 22, 18);
  set( 9, 2, 22, 18);
  return cells;
}

async function seedSkins() {
  // Give the staging demo user (SEED_USER_ID=0) the Fire skin so the feature
  // is immediately visible when a reviewer opens the game in staging.
  const demo = STAGING_DEMO_NFTS[0];
  await pool.query(
    `INSERT INTO player_skins (user_id, skin_id, image_url, nft_name, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [SEED_USER_ID, demo.skin_id, demo.image_url, demo.nft_name]
  );
  // Seed a small patch of skinned blocks so the Fire texture is visible on
  // world load without the reviewer needing to place any blocks first.
  const skinCells = [
    { x: 14, y: 2, z: 14 }, { x: 15, y: 2, z: 14 }, { x: 16, y: 2, z: 14 },
    { x: 14, y: 2, z: 15 }, { x: 15, y: 2, z: 15 }, { x: 16, y: 2, z: 15 },
  ];
  for (const c of skinCells) {
    await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, skin_id, seq, updated_by_user_id, updated_by_username, updated_at)
       VALUES ($1, $2, $3, 1, $4, nextval('block_seq'), $5, 'Staging demo', NOW())
       ON CONFLICT (x, y, z) DO NOTHING`,
      [c.x, c.y, c.z, demo.skin_id, SEED_USER_ID]
    );
  }
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
    // alice: 11 different types (qualifies for material_artist + crystal_placer)
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18].map((bt) => ({ userId: -1, blockType: bt })),
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
  // Each player has diverse badges with different earned times to test the profile view.
  const badgeSeed = [
    // Alice: 8 badges with varied earned times (leading player)
    { userId: -1, badgeId: 'first_block', daysAgo: 10 },
    { userId: -1, badgeId: 'builder', daysAgo: 9 },
    { userId: -1, badgeId: 'architect', daysAgo: 8 },
    { userId: -1, badgeId: 'high_scorer', daysAgo: 7 },
    { userId: -1, badgeId: 'comboist', daysAgo: 5 },
    { userId: -1, badgeId: 'golden_touch', daysAgo: 4 },
    { userId: -1, badgeId: 'material_artist', daysAgo: 3 },
    { userId: -1, badgeId: 'crystal_placer', daysAgo: 2 },
    // Bob: 4 badges (second player)
    { userId: -2, badgeId: 'first_block', daysAgo: 8 },
    { userId: -2, badgeId: 'builder', daysAgo: 6 },
    { userId: -2, badgeId: 'rainbow_placer', daysAgo: 5 },
    { userId: -2, badgeId: 'comboist', daysAgo: 3 },
    // Carol: 3 badges (newer player)
    { userId: -3, badgeId: 'first_block', daysAgo: 3 },
    { userId: -3, badgeId: 'rainbow_placer', daysAgo: 2 },
    { userId: -3, badgeId: 'builder', daysAgo: 1 },
    // Dave: 2 badges (casual player)
    { userId: -4, badgeId: 'first_block', daysAgo: 5 },
    { userId: -4, badgeId: 'builder', daysAgo: 2 },
  ];
  for (const b of badgeSeed) {
    await pool.query(
      `INSERT INTO player_badges (user_id, badge_id, earned_at)
       VALUES ($1, $2, NOW() - INTERVAL '${b.daysAgo} days')
       ON CONFLICT DO NOTHING`,
      [b.userId, b.badgeId]
    );
  }

  // Tutorial completion seed: some players have completed, some haven't.
  // User -1 (alice) and -2 (bob) have completed; others haven't for testing first-time flow.
  await pool.query(
    `INSERT INTO player_tutorial_completed (user_id, completed_at)
     VALUES (-1, NOW() - INTERVAL '5 days'), (-2, NOW() - INTERVAL '2 days')
     ON CONFLICT DO NOTHING`
  );

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

  // Seed a complete horizontal line at y=2 for testing line-clear mechanics.
  // A complete line consists of 1024 blocks (32 × 32 grid, all non-zero type).
  // This allows testers to place a single block to trigger a line clear.
  const { rows: lineCount } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM blocks WHERE y = 2 AND block_type <> 0`
  );
  if (Number(lineCount[0].count) < 1024) {
    const lineBlocks = [];
    for (let x = 0; x < 32; x++) {
      for (let z = 0; z < 32; z++) {
        lineBlocks.push(`(${x}, 2, ${z}, 3, ${SEED_USER_ID}, 'Staging demo')`);
      }
    }
    await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, updated_by_user_id, updated_by_username) VALUES
       ${lineBlocks.join(',')}
       ON CONFLICT (x, y, z) DO NOTHING`
    );
  }

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

  // Seed 3 past disaster events so staging shows disaster history in chat.
  // Negative IDs are not used for disasters (SERIAL), but ON CONFLICT DO NOTHING
  // makes this idempotent — duplicate rows are skipped if disasters already fired.
  const { rows: disasterCount } = await pool.query(
    `SELECT COUNT(*) AS n FROM disasters`
  );
  if (Number(disasterCount[0].n) === 0) {
    await pool.query(`
      INSERT INTO disasters (type, origin_x, origin_z, params, blocks_destroyed, triggered_at) VALUES
        ('earthquake', NULL, NULL, '{"x0":10,"z0":10,"x1":22,"z1":20}', 87, NOW() - INTERVAL '10 minutes'),
        ('eruption',   8,    8,    '{"radius":6}',                        62, NOW() - INTERVAL '5 minutes'),
        ('meteor',     24,   24,   '{"radius":4,"oy":10}',                22, NOW() - INTERVAL '2 minutes')
    `);
  }

  // Seed custom worlds so staging shows world list
  const starterHouseBlocks = [
    { x: 14, y: 1, z: 14, t: 3 }, { x: 14, y: 1, z: 15, t: 3 }, { x: 14, y: 1, z: 16, t: 3 }, { x: 14, y: 1, z: 17, t: 3 }, { x: 14, y: 1, z: 18, t: 3 },
    { x: 15, y: 1, z: 14, t: 3 }, { x: 15, y: 1, z: 18, t: 3 },
    { x: 16, y: 1, z: 14, t: 3 }, { x: 16, y: 1, z: 18, t: 3 },
    { x: 17, y: 1, z: 14, t: 3 }, { x: 17, y: 1, z: 18, t: 3 },
    { x: 18, y: 1, z: 14, t: 3 }, { x: 18, y: 1, z: 15, t: 3 }, { x: 18, y: 1, z: 16, t: 3 }, { x: 18, y: 1, z: 17, t: 3 }, { x: 18, y: 1, z: 18, t: 3 },
    { x: 14, y: 2, z: 14, t: 3 }, { x: 14, y: 2, z: 15, t: 3 }, { x: 14, y: 2, z: 17, t: 3 }, { x: 14, y: 2, z: 18, t: 3 },
    { x: 15, y: 2, z: 14, t: 3 }, { x: 15, y: 2, z: 18, t: 3 },
    { x: 16, y: 2, z: 14, t: 3 }, { x: 16, y: 2, z: 18, t: 3 },
    { x: 17, y: 2, z: 14, t: 3 }, { x: 17, y: 2, z: 18, t: 3 },
    { x: 18, y: 2, z: 14, t: 3 }, { x: 18, y: 2, z: 15, t: 3 }, { x: 18, y: 2, z: 17, t: 3 }, { x: 18, y: 2, z: 18, t: 3 },
    { x: 14, y: 3, z: 14, t: 3 }, { x: 14, y: 3, z: 15, t: 3 }, { x: 14, y: 3, z: 17, t: 3 }, { x: 14, y: 3, z: 18, t: 3 },
    { x: 15, y: 3, z: 14, t: 3 }, { x: 15, y: 3, z: 18, t: 3 },
    { x: 16, y: 3, z: 14, t: 3 }, { x: 16, y: 3, z: 18, t: 3 },
    { x: 17, y: 3, z: 14, t: 3 }, { x: 17, y: 3, z: 18, t: 3 },
    { x: 18, y: 3, z: 14, t: 3 }, { x: 18, y: 3, z: 15, t: 3 }, { x: 18, y: 3, z: 17, t: 3 }, { x: 18, y: 3, z: 18, t: 3 },
  ];

  const colorfulGardenBlocks = [
    { x: 10, y: 1, z: 10, t: 7 }, { x: 11, y: 1, z: 10, t: 9 }, { x: 12, y: 1, z: 10, t: 10 },
    { x: 10, y: 1, z: 11, t: 11 }, { x: 11, y: 1, z: 11, t: 12 }, { x: 12, y: 1, z: 11, t: 13 },
    { x: 10, y: 1, z: 12, t: 2 }, { x: 11, y: 1, z: 12, t: 1 }, { x: 12, y: 1, z: 12, t: 6 },
    { x: 10, y: 1, z: 13, t: 14 }, { x: 11, y: 1, z: 13, t: 15 }, { x: 12, y: 1, z: 13, t: 16 },
    { x: 10, y: 1, z: 14, t: 17 }, { x: 11, y: 1, z: 14, t: 18 }, { x: 12, y: 1, z: 14, t: 8 },
  ];

  const { rows: worldCount } = await pool.query(`SELECT COUNT(*) AS n FROM user_worlds`);
  if (Number(worldCount[0].n) === 0) {
    await pool.query(
      `INSERT INTO user_worlds (owner_id, owner_username, world_name, block_snapshot, blocks_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [-1, 'staging-demo-alice', 'Starter house', JSON.stringify(starterHouseBlocks), starterHouseBlocks.length]
    );
    await pool.query(
      `INSERT INTO user_worlds (owner_id, owner_username, world_name, block_snapshot, blocks_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [-2, 'staging-demo-bob', 'Colorful garden', JSON.stringify(colorfulGardenBlocks), colorfulGardenBlocks.length]
    );
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

// Seed the Time Attack leaderboard with five obviously-fake builders so a
// fresh staging DB (where ta_scores is created empty) shows a populated tab.
// Negative user IDs never collide with real users; ON CONFLICT keeps it
// idempotent across reboots.
async function seedTaScores() {
  const seeds = [
    { userId: -1, username: 'Staging demo Alice',   cleared: 142, difficulty: 5 },
    { userId: -2, username: 'Staging demo Bob',     cleared: 98,  difficulty: 4 },
    { userId: -3, username: 'Staging demo Charlie', cleared: 61,  difficulty: 3 },
    { userId: -4, username: 'Staging demo Dana',    cleared: 33,  difficulty: 2 },
    { userId: -5, username: 'Staging demo Eli',     cleared: 12,  difficulty: 1 },
  ];
  for (const s of seeds) {
    await pool.query(
      `INSERT INTO ta_scores (user_id, username, best_cleared, best_difficulty, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [s.userId, s.username, s.cleared, s.difficulty]
    );
  }
}

async function seedTa60Scores() {
  const seeds = [
    { userId: -11, username: 'Staging demo Alice',   cleared: 87 },
    { userId: -12, username: 'Staging demo Bob',     cleared: 64 },
    { userId: -13, username: 'Staging demo Charlie', cleared: 102 },
    { userId: -14, username: 'Staging demo Dana',    cleared: 56 },
    { userId: -15, username: 'Staging demo Eve',     cleared: 93 },
  ];
  for (const s of seeds) {
    await pool.query(
      `INSERT INTO ta_60_scores (user_id, username, best_cleared, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [s.userId, s.username, s.cleared]
    );
  }
}

async function seedEndlessScores() {
  const seeds = [
    { userId: -6, username: 'Staging demo Frank',   placed: 187, moves: 421 },
    { userId: -7, username: 'Staging demo Grace',   placed: 156, moves: 358 },
    { userId: -8, username: 'Staging demo Henry',   placed: 124, moves: 287 },
    { userId: -9, username: 'Staging demo Ivy',     placed: 89,  moves: 198 },
    { userId: -10, username: 'Staging demo Jack',   placed: 52,  moves: 112 },
  ];
  for (const s of seeds) {
    await pool.query(
      `INSERT INTO endless_scores (user_id, username, best_placed, best_moves_survived, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [s.userId, s.username, s.placed, s.moves]
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

async function seedTheme() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yDate  = new Date(now.getTime() -     24 * 60 * 60 * 1000);
  const y2Date = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const yesterdayStr  = yDate.toISOString().slice(0, 10);
  const twoDaysAgoStr = y2Date.toISOString().slice(0, 10);

  const todayTheme     = themeName(now);
  const yesterTheme    = themeName(yDate);
  const twoDaysAgoTheme = themeName(y2Date);

  // Two past theme rows — fully resolved, both won by staging-demo-alice.
  await pool.query(
    `INSERT INTO daily_theme_schedule (theme_date, theme_name, winner_user_id, winner_username, resolved_at)
     VALUES
       ($1, $2, -1, 'staging-demo-alice', NOW() - INTERVAL '12 hours'),
       ($3, $4, -1, 'staging-demo-alice', NOW() - INTERVAL '36 hours')
     ON CONFLICT (theme_date) DO NOTHING`,
    [yesterdayStr, yesterTheme, twoDaysAgoStr, twoDaysAgoTheme]
  );

  // Today's row — unresolved.
  await pool.query(
    `INSERT INTO daily_theme_schedule (theme_date, theme_name)
     VALUES ($1, $2)
     ON CONFLICT (theme_date) DO NOTHING`,
    [todayStr, todayTheme]
  );

  // 4 nominations for yesterday (near the demo structures so testers can fly to them).
  const yNoms = [
    { id: -1, username: 'staging-demo-alice', desc: 'Staging demo castle with stone walls',       ax: 14, ay: 1, az: 14 },
    { id: -2, username: 'staging-demo-bob',   desc: 'Staging demo ocean pier near the east edge', ax: 24, ay: 1, az: 16 },
    { id: -3, username: 'staging-demo-carol', desc: 'Staging demo forest pavilion by the tree',   ax: 22, ay: 1, az: 22 },
    { id: -4, username: 'staging-demo-dave',  desc: 'Staging demo crystal spire in the corner',   ax: 10, ay: 1, az: 22 },
  ];
  for (const n of yNoms) {
    await pool.query(
      `INSERT INTO theme_nominations (theme_date, user_id, username, description, anchor_x, anchor_y, anchor_z, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - INTERVAL '20 hours')
       ON CONFLICT (theme_date, user_id) DO NOTHING`,
      [yesterdayStr, n.id, n.username, n.desc, n.ax, n.ay, n.az]
    );
  }

  // Votes for yesterday: alice (-1) gets 4 votes, bob (-2) gets 1.
  const yVotes = [
    { voter: -2, nominee: -1 },
    { voter: -3, nominee: -1 },
    { voter: -4, nominee: -1 },
    { voter: -5, nominee: -1 },
    { voter: -6, nominee: -2 },
  ];
  for (const v of yVotes) {
    await pool.query(
      `INSERT INTO theme_votes (theme_date, voter_user_id, nominee_user_id, voted_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '10 hours')
       ON CONFLICT (theme_date, voter_user_id) DO NOTHING`,
      [yesterdayStr, v.voter, v.nominee]
    );
  }

  // theme_champion badge for the demo winner.
  await pool.query(
    `INSERT INTO player_badges (user_id, badge_id, earned_at)
     VALUES (-1, 'theme_winner', NOW() - INTERVAL '12 hours')
     ON CONFLICT DO NOTHING`
  );

  // 2 nominations for today (no votes yet — tester can cast the first vote).
  const todayNoms = [
    { id: -2, username: 'staging-demo-bob',   desc: 'Staging demo tower near the stone hut', ax: 18, ay: 1, az: 10 },
    { id: -3, username: 'staging-demo-carol', desc: 'Staging demo arch at the south path',   ax: 16, ay: 1, az: 12 },
  ];
  for (const n of todayNoms) {
    await pool.query(
      `INSERT INTO theme_nominations (theme_date, user_id, username, description, anchor_x, anchor_y, anchor_z, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() - INTERVAL '2 hours')
       ON CONFLICT (theme_date, user_id) DO NOTHING`,
      [todayStr, n.id, n.username, n.desc, n.ax, n.ay, n.az]
    );
  }
}

async function seedLoginRewards() {
  const rows = [
    { user_id: -1, coins_earned: 30, coins_balance: 150 },
    { user_id: -2, coins_earned: 50, coins_balance: 250 },
    { user_id: -3, coins_earned: 65, coins_balance: 325 },
    { user_id: -4, coins_earned: 15, coins_balance: 75 },
  ];
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    await pool.query(
      `INSERT INTO login_rewards (user_id, reward_date, coins_earned)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [r.user_id, today, r.coins_earned]
    );
    await pool.query(
      `INSERT INTO player_coins (user_id, coins_balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET coins_balance = EXCLUDED.coins_balance`,
      [r.user_id, r.coins_balance]
    );
  }
}

async function seedDailyChallenge() {
  const today = new Date().toISOString().slice(0, 10);
  const target = dailyTarget(new Date());

  // Seed daily challenge progress for staging demo users
  const progressRows = [
    { user_id: -1, username: 'Staging demo Alice', blocks_placed: 58, completed_at: new Date(Date.now() - 15 * 60 * 1000).toISOString() },
    { user_id: -2, username: 'Staging demo Bob', blocks_placed: 45, completed_at: new Date(Date.now() - 45 * 60 * 1000).toISOString() },
    { user_id: -3, username: 'Staging demo Charlie', blocks_placed: 42, completed_at: new Date(Date.now() - 75 * 60 * 1000).toISOString() },
    { user_id: -4, username: 'Staging demo Diana', blocks_placed: 35, completed_at: null },
  ];

  for (const row of progressRows) {
    await pool.query(
      `INSERT INTO daily_challenge_progress (challenge_date, user_id, username, blocks_placed, completed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (challenge_date, user_id) DO NOTHING`,
      [today, row.user_id, row.username, row.blocks_placed, row.completed_at]
    );
  }

  // Seed daily challenge streaks
  const streakRows = [
    { user_id: -1, current_streak: 5, longest_streak: 12, last_completed_date: today },
    { user_id: -2, current_streak: 2, longest_streak: 8, last_completed_date: today },
    { user_id: -3, current_streak: 1, longest_streak: 1, last_completed_date: today },
  ];

  for (const row of streakRows) {
    await pool.query(
      `INSERT INTO daily_challenge_streaks (user_id, current_streak, longest_streak, last_completed_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [row.user_id, row.current_streak, row.longest_streak, row.last_completed_date]
    );
  }
}

// Helper to generate deterministic puzzle level blocks seeded by level number.
function generatePuzzleBlocks(levelNumber) {
  const blocks = [];
  const seed = levelNumber * 12345; // Deterministic seed based on level
  let rng = seed;

  function nextRandom() {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    return rng / 0x7fffffff;
  }

  const blockCount = 20 + levelNumber * 8; // Increases with level
  const blockTypes = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11]; // Color variety, exclude glass/special

  for (let i = 0; i < blockCount; i++) {
    const x = Math.floor(nextRandom() * 32);
    const z = Math.floor(nextRandom() * 32);
    const y = 2 + Math.floor(nextRandom() * 8); // Height 2-10
    const t = blockTypes[Math.floor(nextRandom() * blockTypes.length)];
    blocks.push({ x, y, z, t });
  }

  return blocks;
}

async function seedPuzzleLevels() {
  // Seed 5 levels with deterministic block layouts and targets.
  const levelSeeds = [
    { level: 1, target: 10 },
    { level: 2, target: 15 },
    { level: 3, target: 25 },
    { level: 4, target: 40 },
    { level: 5, target: 50 },
  ];

  for (const { level, target } of levelSeeds) {
    const blocks = generatePuzzleBlocks(level);
    await pool.query(
      `INSERT INTO puzzle_level_definitions (level_number, block_snapshot, target_blocks_to_clear)
       VALUES ($1, $2, $3)
       ON CONFLICT (level_number) DO NOTHING`,
      [level, JSON.stringify(blocks), target]
    );
  }
}

async function seedPuzzleScores() {
  // Seed demo users with varying puzzle mode high scores.
  const seeds = [
    { userId: -11, username: 'Staging demo puzzle A', level: 8, blocks: 240 },
    { userId: -12, username: 'Staging demo puzzle B', level: 5, blocks: 140 },
    { userId: -13, username: 'Staging demo puzzle C', level: 12, blocks: 380 },
  ];
  for (const s of seeds) {
    await pool.query(
      `INSERT INTO puzzle_scores (user_id, username, highest_level, total_blocks_cleared_best_session, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [s.userId, s.username, s.level, s.blocks]
    );
  }
}

// ---- Natural Disaster trigger (called from GET /api/world/changes) ----
// Uses SELECT ... FOR UPDATE SKIP LOCKED on disaster_schedule so that only one
// concurrent request can trigger at a time. Returns the fired disaster row or null.
async function maybeFireDisaster() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const schedRes = await client.query(
      `SELECT fire_at, next_type FROM disaster_schedule WHERE id = 1 FOR UPDATE SKIP LOCKED`
    );
    if (!schedRes.rows.length) {
      await client.query('COMMIT');
      return null; // another request holds the lock
    }
    if (new Date(schedRes.rows[0].fire_at) > new Date()) {
      await client.query('COMMIT');
      return null; // not time yet
    }
    const type = schedRes.rows[0].next_type;
    const def = DISASTER_DEFS[type];
    if (!def) {
      await client.query('COMMIT');
      return null;
    }

    let deleteQuery, deleteParams, params = {}, origin_x = null, origin_z = null, chatMsg;

    if (type === 'earthquake') {
      const zoneW = def.zoneMin + Math.floor(Math.random() * (def.zoneMax - def.zoneMin + 1));
      const zoneD = def.zoneMin + Math.floor(Math.random() * (def.zoneMax - def.zoneMin + 1));
      const x0 = Math.floor(Math.random() * (DIMS.w - zoneW));
      const z0 = Math.floor(Math.random() * (DIMS.d - zoneD));
      const x1 = x0 + zoneW - 1;
      const z1 = z0 + zoneD - 1;
      params = { x0, z0, x1, z1 };
      deleteQuery = `UPDATE blocks SET block_type=0, seq=nextval('block_seq'),
        updated_by_user_id=$1, updated_by_username=$2, updated_at=NOW()
        WHERE x BETWEEN $3 AND $4 AND z BETWEEN $5 AND $6 AND block_type <> 0
        RETURNING x, y, z`;
      deleteParams = [DISASTER_USER_ID, DISASTER_USERNAME, x0, x1, z0, z1];
      chatMsg = `${def.icon} Earthquake struck zone (${x0},${z0})→(${x1},${z1})! Rebuild!`;
    } else if (type === 'eruption') {
      const radius = def.radiusMin + Math.floor(Math.random() * (def.radiusMax - def.radiusMin + 1));
      const ox = radius + Math.floor(Math.random() * (DIMS.w - 2 * radius));
      const oz = radius + Math.floor(Math.random() * (DIMS.d - 2 * radius));
      origin_x = ox; origin_z = oz;
      params = { radius };
      deleteQuery = `UPDATE blocks SET block_type=0, seq=nextval('block_seq'),
        updated_by_user_id=$1, updated_by_username=$2, updated_at=NOW()
        WHERE (x-$3)*(x-$3)+(z-$4)*(z-$4) <= $5 AND block_type <> 0
        RETURNING x, y, z`;
      deleteParams = [DISASTER_USER_ID, DISASTER_USERNAME, ox, oz, radius * radius];
      chatMsg = `${def.icon} Volcanic eruption at (${ox},${oz})! Rebuild!`;
    } else { // meteor
      const radius = def.radiusMin + Math.floor(Math.random() * (def.radiusMax - def.radiusMin + 1));
      const ox = radius + Math.floor(Math.random() * (DIMS.w - 2 * radius));
      const oy = 10;
      const oz = radius + Math.floor(Math.random() * (DIMS.d - 2 * radius));
      origin_x = ox; origin_z = oz;
      params = { radius, oy };
      deleteQuery = `UPDATE blocks SET block_type=0, seq=nextval('block_seq'),
        updated_by_user_id=$1, updated_by_username=$2, updated_at=NOW()
        WHERE (x-$3)*(x-$3)+(y-$4)*(y-$4)+(z-$5)*(z-$5) <= $6 AND block_type <> 0
        RETURNING x, y, z`;
      deleteParams = [DISASTER_USER_ID, DISASTER_USERNAME, ox, oy, oz, radius * radius];
      chatMsg = `${def.icon} Meteor strike at (${ox},${oz})! Rebuild!`;
    }

    const delRes = await client.query(deleteQuery, deleteParams);
    const blocks_destroyed = delRes.rows.length;

    // Append count to chat message (keep under 200 chars)
    const countSuffix = ` ${blocks_destroyed} blocks destroyed.`;
    const fullMsg = (chatMsg + countSuffix).slice(0, 200);

    const disRes = await client.query(
      `INSERT INTO disasters (type, origin_x, origin_z, params, blocks_destroyed)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, triggered_at`,
      [type, origin_x, origin_z, JSON.stringify(params), blocks_destroyed]
    );
    const disaster = disRes.rows[0];

    await client.query(
      `INSERT INTO chat_messages (user_id, username, body) VALUES ($1, $2, $3)`,
      [DISASTER_USER_ID, '🌍 World Events', fullMsg]
    );

    // Schedule next disaster
    const types = Object.keys(DISASTER_DEFS);
    const nextType = types[Math.floor(Math.random() * types.length)];
    const nextDelaySecs = DISASTER_MIN_SECS + Math.floor(Math.random() * (DISASTER_MAX_SECS - DISASTER_MIN_SECS));
    await client.query(
      `UPDATE disaster_schedule SET fire_at = NOW() + ($1 || ' seconds')::INTERVAL, next_type = $2 WHERE id = 1`,
      [nextDelaySecs, nextType]
    );

    await client.query('COMMIT');
    return { id: Number(disaster.id), type, label: def.label, icon: def.icon, origin_x, origin_z, params, blocks_destroyed, triggered_at: disaster.triggered_at };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('disaster trigger error', err.message);
    return null;
  } finally {
    client.release();
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
  await pool.query(`ALTER TABLE blocks ADD COLUMN IF NOT EXISTS skin_id VARCHAR(64)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_skins (
      user_id    INTEGER PRIMARY KEY,
      skin_id    VARCHAR(64) NOT NULL,
      image_url  TEXT NOT NULL,
      nft_name   VARCHAR(255) NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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

  // Time Attack high scores: one row per user holding their best single-run
  // block count and the difficulty (1-5) it was achieved at. Public table —
  // it holds only a username and a block count, nothing a stranger seeing
  // every row could misuse. No foreign keys.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ta_scores (
      user_id         INTEGER PRIMARY KEY,
      username        VARCHAR(255) NOT NULL,
      best_cleared    INTEGER NOT NULL DEFAULT 0,
      best_difficulty SMALLINT NOT NULL DEFAULT 1,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Time Attack (60s) high scores: one row per user holding their best run.
  // Public table — it holds only a username and block count, nothing sensitive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ta_60_scores (
      user_id         INTEGER PRIMARY KEY,
      username        VARCHAR(255) NOT NULL,
      best_cleared    INTEGER NOT NULL DEFAULT 0,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Endless Mode high scores: one row per user holding their best run stats.
  // Public table — it holds only a username and block counts, nothing sensitive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS endless_scores (
      user_id              INTEGER PRIMARY KEY,
      username             VARCHAR(255) NOT NULL,
      best_placed          INTEGER NOT NULL DEFAULT 0,
      best_moves_survived  INTEGER NOT NULL DEFAULT 0,
      updated_at           TIMESTAMPTZ DEFAULT NOW()
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
  await pool.query(`
    ALTER TABLE user_presence
      ADD COLUMN IF NOT EXISTS current_world_id INTEGER
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

  // Daily challenge streaks: tracks consecutive days of challenge completion.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_challenge_streaks (
      user_id INTEGER PRIMARY KEY,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      last_completed_date DATE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Daily challenge rewards: audit log for streak bonuses and coins earned.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_challenge_rewards (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      reward_date DATE NOT NULL,
      coins_earned INTEGER NOT NULL,
      streak_bonus_multiplier DECIMAL(3, 1) NOT NULL DEFAULT 1.0,
      earned_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, reward_date)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS daily_challenge_rewards_user_date_idx
    ON daily_challenge_rewards (user_id, reward_date)
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

  // Daily login rewards: tracks which players have claimed their daily reward and the date.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_rewards (
      user_id        INTEGER NOT NULL,
      reward_date    DATE NOT NULL,
      coins_earned   INTEGER NOT NULL,
      claimed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, reward_date)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS login_rewards_user_date_idx ON login_rewards (user_id, reward_date)`);

  // Player coin balance: stores cumulative coins for each player.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_coins (
      user_id        INTEGER PRIMARY KEY,
      coins_balance  BIGINT NOT NULL DEFAULT 0,
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

  // Daily build theme voting tables (all public — build activity is not sensitive).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_theme_schedule (
      theme_date      DATE         PRIMARY KEY,
      theme_name      VARCHAR(32)  NOT NULL,
      winner_user_id  INTEGER,
      winner_username VARCHAR(255),
      resolved_at     TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS theme_nominations (
      theme_date   DATE         NOT NULL,
      user_id      INTEGER      NOT NULL,
      username     VARCHAR(255) NOT NULL,
      description  VARCHAR(80)  NOT NULL,
      anchor_x     SMALLINT     NOT NULL,
      anchor_y     SMALLINT     NOT NULL,
      anchor_z     SMALLINT     NOT NULL,
      submitted_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (theme_date, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS theme_votes (
      theme_date       DATE        NOT NULL,
      voter_user_id    INTEGER     NOT NULL,
      nominee_user_id  INTEGER     NOT NULL,
      voted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (theme_date, voter_user_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS theme_votes_nominee_idx ON theme_votes (theme_date, nominee_user_id)`);

  // Puzzle Mode scores: tracks best performance per user.
  // Public table — holds only username and level counts, nothing sensitive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS puzzle_scores (
      user_id                      INTEGER PRIMARY KEY,
      username                     VARCHAR(255) NOT NULL,
      highest_level                INTEGER NOT NULL DEFAULT 1,
      total_blocks_cleared_best_session INTEGER NOT NULL DEFAULT 0,
      updated_at                   TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Puzzle level definitions: seed data for each level's block layout and target.
  // Public table — level data is not sensitive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS puzzle_level_definitions (
      level_number              INTEGER PRIMARY KEY,
      block_snapshot            JSONB NOT NULL,
      target_blocks_to_clear    INTEGER NOT NULL,
      created_at                TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS disasters (
      id               SERIAL PRIMARY KEY,
      type             VARCHAR(20)  NOT NULL,
      origin_x         SMALLINT,
      origin_z         SMALLINT,
      params           JSONB        NOT NULL DEFAULT '{}',
      blocks_destroyed INTEGER      NOT NULL DEFAULT 0,
      triggered_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS disasters_triggered_at_idx ON disasters (triggered_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS disaster_schedule (
      id        INTEGER PRIMARY KEY CHECK (id = 1),
      fire_at   TIMESTAMPTZ  NOT NULL,
      next_type VARCHAR(20)  NOT NULL
    )
  `);

  // Tutorial completion tracking: one row per user who completes tutorial.
  // Public table — only tracks completion status, no sensitive data.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_tutorial_completed (
      user_id INTEGER PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // User custom worlds: snapshots of blocks that players can save and load.
  // Public table — it holds only usernames and block configurations.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_worlds (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      owner_username VARCHAR(255) NOT NULL,
      world_name VARCHAR(255) NOT NULL,
      description TEXT,
      block_snapshot JSONB NOT NULL DEFAULT '[]',
      blocks_count INTEGER NOT NULL DEFAULT 0,
      is_public BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (owner_id, world_name)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_worlds_owner_idx ON user_worlds (owner_id, updated_at DESC)
  `);

  // Prime the schedule on first boot; subsequent boots leave the existing row intact.
  const disasterInitDelay = IS_STAGING ? '10 seconds' : '60 seconds';
  await pool.query(
    `INSERT INTO disaster_schedule (id, fire_at, next_type)
     VALUES (1, NOW() + ($1 || ' seconds')::INTERVAL, 'earthquake')
     ON CONFLICT DO NOTHING`,
    [IS_STAGING ? '10' : '60']
  );

  if (IS_STAGING) {
    try { await seedStaging(); }
    catch (err) { console.error('staging blocks seed failed', err); }
    try { await seedChat(); }
    catch (err) { console.error('staging chat seed failed', err); }
    try { await seedLeaderboard(); }
    catch (err) { console.error('leaderboard seed failed', err); }
    try { await seedTournament(); }
    catch (err) { console.error('tournament seed failed', err); }
    try { await seedTaScores(); }
    catch (err) { console.error('ta-scores seed failed', err); }
    try { await seedTa60Scores(); }
    catch (err) { console.error('ta-60-scores seed failed', err); }
    try { await seedEndlessScores(); }
    catch (err) { console.error('endless-scores seed failed', err); }
    try { await seedStreaks(); }
    catch (err) { console.error('streak seed failed', err); }
    try { await seedSkins(); }
    catch (err) { console.error('skins seed failed', err); }
    try { await seedTheme(); }
    catch (err) { console.error('theme seed failed', err); }
    try { await seedLoginRewards(); }
    catch (err) { console.error('login-rewards seed failed', err); }
    try { await seedDailyChallenge(); }
    catch (err) { console.error('daily-challenge seed failed', err); }
    try { await seedPuzzleLevels(); }
    catch (err) { console.error('puzzle-levels seed failed', err); }
    try { await seedPuzzleScores(); }
    catch (err) { console.error('puzzle-scores seed failed', err); }
    // Staging spectators are now surfaced via the STAGING_DEMO_USERS constant
    // appended in GET /api/presence/online, so no DB seed is needed here.
  }

  await ensurePowerUps();
  initMobs();

  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });
