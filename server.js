const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;

// Validate required environment variables
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is not set. Cannot start.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const LLM_ENABLED = !!process.env.USERNODE_LLM_PROXY_TOKEN;

// Daily energy system configuration
const ENERGY_TICKETS_PER_DAY = 5;
const ENERGY_COST_POINTS_PER_TICKET = 100;

// Startup flag to track when initialization completes
let startupComplete = false;
let startupError = null;

// Hardcoded demo presence entries for staging so the online list is always
// populated regardless of whether the seeded user_presence rows are still
// within their 60-second expiry window.
const STAGING_DEMO_USERS = [
  { username: 'Staging demo Alice', mode: 'classic',  active_pet: 'cat'  },
  { username: 'Staging demo Bob',   mode: 'classic',  active_pet: 'dog'  },
  { username: 'Staging demo spectator — Alice', mode: 'spectate', active_pet: null },
  { username: 'Staging demo spectator — Bob',   mode: 'spectate', active_pet: null },
];

// ---- Fixed shared-world parameters (authoritative; mirrored to client) ----
const DIMS = { w: 32, d: 32, h: 24 };

const PALETTE = [
  { id: 1,  name: 'Grass',         color: '#7ed98a' },
  { id: 2,  name: 'Dirt',          color: '#c9917a' },
  { id: 3,  name: 'Stone',         color: '#c2c6cf' },
  { id: 4,  name: 'Wood',          color: '#ddb680' },
  { id: 5,  name: 'Leaves',        color: '#6ec67a' },
  { id: 6,  name: 'Sand',          color: '#fdf0a8' },
  { id: 7,  name: 'Brick',         color: '#e88c82' },
  { id: 8,  name: 'Glass',         color: '#b3e8f5', opacity: 0.45 },
  { id: 9,  name: 'Red',           color: '#f09090' },
  { id: 10, name: 'Blue',          color: '#80a8f0' },
  { id: 11, name: 'Yellow',        color: '#ffe580' },
  { id: 12, name: 'White',         color: '#f8f6ff' },
  { id: 13, name: 'Snow',          color: '#e4eeff' },
  { id: 14, name: 'Gold Block',    color: '#f5d27a', material: 'standard', metalness: 0.85, roughness: 0.2 },
  { id: 15, name: 'Glowstone',     color: '#ffd099', emissive: '#f0a870', emissiveIntensity: 0.6 },
  { id: 16, name: 'Obsidian',      color: '#6b5588', material: 'standard', metalness: 0.3, roughness: 0.1 },
  { id: 17, name: 'Rainbow Block', color: '#f0a8c5', powerup: true },
  { id: 18, name: 'Crystal',       color: '#d4c8ff', opacity: 0.65, emissive: '#b0a0ff', emissiveIntensity: 0.3, material: 'standard', metalness: 0.1, roughness: 0.2, unlockAt: 50, unlockIcon: '💎' },
  { id: 19, name: 'Ice',           color: '#aadeef', opacity: 0.55 },
  { id: 20, name: 'Lava',          color: '#e8540f', emissive: '#ff2200', emissiveIntensity: 0.8 },
  { id: 21, name: 'Lime',          color: '#78de3e' },
  { id: 22, name: 'Orange',        color: '#f08030' },
  { id: 23, name: 'Purple',        color: '#8a2fc8' },
  { id: 24, name: 'Cyan',          color: '#29b8b8' },
  { id: 25, name: 'Iron Block',    color: '#d4d4dc', material: 'standard', metalness: 0.9, roughness: 0.3 },
  { id: 26, name: 'Terracotta',    color: '#c5694a' },
  { id: 27, name: 'Bomb',          color: '#3d3a52', emissive: '#e8500a', emissiveIntensity: 0.45, material: 'standard', metalness: 0.2, roughness: 0.65, unlockAt: 75, unlockIcon: '💣' },
  { id: 28, name: 'Gold Star',     color: '#ffd700', wildcard: true, material: 'standard', metalness: 0.85, roughness: 0.12, emissive: '#ffa500', emissiveIntensity: 0.4, unlockIcon: '⭐' },
];
const VALID_TYPES = new Set(PALETTE.map((p) => p.id));

const BLOCK_POINTS = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1,   // Grass, Dirt, Stone, Wood, Leaves, Sand
  7: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 2, // Brick, Glass, Red, Blue, Yellow, White
  13: 2,  // Snow
  14: 5,  // Gold Block
  15: 3,  // Glowstone
  16: 4,  // Obsidian
  17: 5,  // Rainbow Block
  18: 3,  // Crystal
  19: 2,  // Ice
  20: 3,  // Lava
  21: 2, 22: 2, 23: 2, 24: 2, // Lime, Orange, Purple, Cyan
  25: 4,  // Iron Block
  26: 1,  // Terracotta
  27: 3,  // Bomb
  28: 5,  // Gold Star
};

const SEED_USER_ID = 0;

// AI opponent constants.
const AI_USER_ID = -100;
const AI_USERNAME = '🤖 BlockBot';
const AI_DIFFICULTY_MAP = { easy: 15000, medium: 6000, hard: 3000 };
const AI_INTERVAL_MS = AI_DIFFICULTY_MAP[process.env.AI_DIFFICULTY] || AI_DIFFICULTY_MAP.medium;

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

// ---- Speed Run levels (authoritative, sent to client on session start) ----
// Zones are non-overlapping and spread across the world to require navigation.
const SPEEDRUN_LEVELS = [
  { id: 1, name: 'Platform', zone: { x: [1, 4],   y: [1, 1],  z: [1, 4]   }, required: 16 },
  { id: 2, name: 'Tower',    zone: { x: [7, 8],   y: [1, 7],  z: [7, 8]   }, required: 28 },
  { id: 3, name: 'Causeway', zone: { x: [12, 12], y: [1, 1],  z: [10, 25] }, required: 16 },
  { id: 4, name: 'Fortress', zone: { x: [18, 23], y: [1, 2],  z: [18, 23] }, required: 36 },
  { id: 5, name: 'Spire',    zone: { x: [25, 30], y: [1, 10], z: [25, 30] }, required: 50 },
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

// ---- Community Monuments ----
const SECTOR_SIZE = 4;
const MONUMENT_BLOCK_THRESHOLD = 15;
const MONUMENT_CONTRIBUTOR_THRESHOLD = 3;
function sectorCoord(v) { return Math.floor(v / SECTOR_SIZE) * SECTOR_SIZE; }

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
  { id: 'streak_7',         name: 'Week Warrior',     icon: '🗓️', flavour: 'A full week of building!' },
  { id: 'streak_14',        name: 'Fortnight Pro',    icon: '🏆', flavour: 'Two weeks of daily play!' },
  { id: 'streak_30',        name: 'Monthly Master',   icon: '👑', flavour: 'A full month on the block!' },
  { id: 'master_comboist',  name: 'Combo King',       icon: '💥', flavour: 'Achieved a ×5 combo!' },
  { id: 'overachiever',     name: 'Overachiever',     icon: '🏅', flavour: 'Earned 5,000 total score!' },
  { id: 'legendary_builder',name: 'Legendary Builder',icon: '🌟', flavour: 'Placed 500 blocks!' },
  { id: 'daily_regular',    name: 'Daily Regular',    icon: '📅', flavour: 'Completed 5 daily challenges!' },
  { id: 'speed_demon',      name: 'Speed Demon',      icon: '⚡', flavour: 'Cleared 30+ blocks in Time Attack!' },
  { id: 'mission_complete',  name: 'Mission Complete', icon: '🎯', flavour: 'Completed your first daily mission!' },
  { id: 'mission_streak_3',  name: 'Mission Regular',  icon: '📋', flavour: 'Completed missions 3 days in a row!' },
  { id: 'mission_streak_7',  name: 'Mission Pro',      icon: '📊', flavour: 'Completed missions 7 days in a row!' },
  { id: 'mission_streak_30', name: 'Mission Master',   icon: '🏅', flavour: 'Completed missions 30 days in a row!' },
  { id: 'theme_winner',     name: 'Theme Champion',   icon: '🥇', flavour: 'First place in the daily build theme vote!' },
  { id: 'daily_devotee',    name: 'Daily Devotee',    icon: '🌟', flavour: 'Completed the daily challenge 7 days in a row!' },
  { id: 'daily_champion',   name: 'Daily Champion',   icon: '👑', flavour: 'Won the Daily Challenge!' },
  { id: 'speedrunner',      name: 'Speedrunner',      icon: '⚡', flavour: 'Blazing fast block placement!' },
];

const STREAK_BADGE_MILESTONES = [
  { days: 3, id: 'streak_3' },
  { days: 7, id: 'streak_7' },
];

// Wager tier definitions (authoritative; mirrored to the client).
const WAGER_TIERS = {
  easy:   { target: 20,  multiplier: 1.5 },
  medium: { target: 50,  multiplier: 2.0 },
  hard:   { target: 80,  multiplier: 3.0 },
  expert: { target: 110, multiplier: 5.0 },
};

// Pet companion definitions. Unlocked automatically when blocks_placed reaches
// the threshold — no separate ownership table, same pattern as Crystal block.
const PET_TYPES = [
  { id: 'cat',    name: 'Cat',    icon: '🐱', unlockAt: 25,   color: '#e8a857' },
  { id: 'dog',    name: 'Dog',    icon: '🐶', unlockAt: 100,  color: '#c8a070' },
  { id: 'ghost',  name: 'Ghost',  icon: '👻', unlockAt: 300,  color: '#ddeeff', opacity: 0.75 },
  { id: 'dragon', name: 'Dragon', icon: '🐲', unlockAt: 750,  color: '#7c5ea8' },
  { id: 'robot',  name: 'Robot',  icon: '🤖', unlockAt: 1500, color: '#8090a0' },
];
const PET_MAP = new Map(PET_TYPES.map((p) => [p.id, p]));

// Creative prompts shown to players each day. Rotated deterministically by date
// (same UTC approach as dailyTarget). Add more entries freely — modulo adjusts.
const DAILY_PROMPTS = [
  'Build a lighthouse',
  'Build a bridge',
  'Make a cosy cottage',
  'Sculpt a tower',
  'Design a market stall',
  'Build a fountain',
  'Create a castle gate',
  'Make a garden',
  'Build a treehouse',
  'Design a windmill',
  'Sculpt a pyramid',
  'Build a ship',
  'Create a campsite',
  'Make a clock tower',
  'Build a greenhouse',
  'Design a cave entrance',
  'Create an arch',
  'Build an observatory',
  'Make a barn',
  'Design a waterfall',
  'Build a fortress wall',
  'Create a monument',
  'Make a mine entrance',
  'Build a dock',
  'Design a shrine',
  'Create a maze',
  'Build an amphitheater',
  'Make a snowfort',
  'Design a portal',
  'Build a volcano',
];

const MISSION_STREAK_BADGE_MILESTONES = [
  { days: 3,  id: 'mission_streak_3' },
  { days: 7,  id: 'mission_streak_7' },
  { days: 30, id: 'mission_streak_30' },
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
      case 'material_artist':   earned = typeCount >= 8; break;
      case 'crystal_placer':    earned = justPlacedType === 18; break;
      case 'master_comboist':   earned = lb.best_combo >= 4; break;
      case 'overachiever':      earned = lb.total_score >= 5000; break;
      case 'legendary_builder': earned = lb.blocks_placed >= 500; break;
    }
    if (earned) newBadges.push(badge);
  }
  return newBadges;
}

// Recomputes the monument status for the 4×4 sector whose top-left corner is (sx, sz).
// Returns the monument row (with is_new flag) if thresholds are met, or null.
async function recomputeMonument(sx, sz) {
  const statsRes = await pool.query(
    `SELECT COUNT(*)::int AS block_count,
            COUNT(DISTINCT updated_by_user_id)::int AS contributor_count
     FROM blocks
     WHERE x >= $1 AND x < $2
       AND z >= $3 AND z < $4
       AND block_type <> 0
       AND updated_by_user_id > 0`,
    [sx, sx + SECTOR_SIZE, sz, sz + SECTOR_SIZE]
  );
  const { block_count, contributor_count } = statsRes.rows[0];

  if (block_count >= MONUMENT_BLOCK_THRESHOLD && contributor_count >= MONUMENT_CONTRIBUTOR_THRESHOLD) {
    const typeRes = await pool.query(
      `SELECT block_type, COUNT(*)::int AS cnt
       FROM blocks
       WHERE x >= $1 AND x < $2
         AND z >= $3 AND z < $4
         AND block_type <> 0
       GROUP BY block_type
       ORDER BY cnt DESC, block_type DESC
       LIMIT 1`,
      [sx, sx + SECTOR_SIZE, sz, sz + SECTOR_SIZE]
    );
    const topType = typeRes.rows.length ? typeRes.rows[0].block_type : 1;
    const palEntry = PALETTE.find((p) => p.id === topType);
    const name = (palEntry ? palEntry.name : 'Block') + ' Monument';

    const existRes = await pool.query(
      `SELECT id FROM monuments WHERE sector_x = $1 AND sector_z = $2`,
      [sx, sz]
    );
    const alreadyExisted = existRes.rows.length > 0;

    const upsertRes = await pool.query(
      `INSERT INTO monuments (sector_x, sector_z, name, block_count, contributor_count, crowned_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (sector_x, sector_z) DO UPDATE SET
         name              = EXCLUDED.name,
         block_count       = EXCLUDED.block_count,
         contributor_count = EXCLUDED.contributor_count,
         updated_at        = NOW()
       RETURNING id, sector_x, sector_z, name, block_count, contributor_count, crowned_at`,
      [sx, sz, name, block_count, contributor_count]
    );
    const row = upsertRes.rows[0];
    return {
      id: Number(row.id),
      name: row.name,
      sector_x: row.sector_x,
      sector_z: row.sector_z,
      block_count: Number(row.block_count),
      contributor_count: Number(row.contributor_count),
      crowned_at: row.crowned_at,
      is_new: !alreadyExisted,
    };
  } else {
    await pool.query(`DELETE FROM monuments WHERE sector_x = $1 AND sector_z = $2`, [sx, sz]);
    return null;
  }
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

// Fixed pool of daily missions rotated deterministically by UTC date.
// Three mission types: place_type (place N blocks of a specific type),
// reach_height (place any block at y >= target), break_blocks (break N blocks).
const MISSION_POOL = [
  { type: 'place_type',   target: 20, blockType: 3,  label: 'Place 20 Stone blocks' },
  { type: 'place_type',   target: 15, blockType: 7,  label: 'Place 15 Brick blocks' },
  { type: 'place_type',   target: 12, blockType: 8,  label: 'Place 12 Glass blocks' },
  { type: 'place_type',   target: 25, blockType: 1,  label: 'Place 25 Grass blocks' },
  { type: 'place_type',   target: 10, blockType: 14, label: 'Place 10 Gold Blocks' },
  { type: 'place_type',   target: 15, blockType: 15, label: 'Place 15 Glowstone blocks' },
  { type: 'place_type',   target: 20, blockType: 6,  label: 'Place 20 Sand blocks' },
  { type: 'place_type',   target: 15, blockType: 16, label: 'Place 15 Obsidian blocks' },
  { type: 'reach_height', target: 8,  label: 'Reach height 8 — place any block at y ≥ 8' },
  { type: 'reach_height', target: 10, label: 'Reach height 10 — place any block at y ≥ 10' },
  { type: 'reach_height', target: 12, label: 'Reach height 12 — place any block at y ≥ 12' },
  { type: 'reach_height', target: 15, label: 'Reach height 15 — place any block at y ≥ 15' },
  { type: 'break_blocks', target: 15, label: 'Break 15 blocks' },
  { type: 'break_blocks', target: 20, label: 'Break 20 blocks' },
  { type: 'break_blocks', target: 30, label: 'Break 30 blocks' },
  { type: 'break_blocks', target: 40, label: 'Break 40 blocks' },
];

function dailyMission(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = dateObj.getUTCMonth() + 1;
  const d = dateObj.getUTCDate();
  return MISSION_POOL[(y * 31 + m * 7 + d * 13 + 5) % MISSION_POOL.length];
}

// Returns today's creative building prompt, derived deterministically from the
// UTC date using a different multiplier from dailyTarget to avoid correlation.
function dailyPrompt(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = dateObj.getUTCMonth() + 1;
  const d = dateObj.getUTCDate();
  const idx = ((y * 31 + m * 7 + d) * 13) % DAILY_PROMPTS.length;
  return DAILY_PROMPTS[idx];
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

// ---- World bootstrap: dimensions, palette, current blocks, poll cursor ----
app.get('/api/world', async (req, res) => {
  if (!startupComplete) {
    if (startupError) {
      return res.status(500).json({ error: 'Server initialization failed: ' + startupError });
    }
    return res.status(503).json({ error: 'Server is still initializing. Please try again in a moment.' });
  }
  try {
    const { rows } = await pool.query(
      `SELECT b.x, b.y, b.z, b.block_type, b.skin_id,
              (bm.x IS NOT NULL) AS has_message
       FROM blocks b
       LEFT JOIN block_messages bm
         ON bm.x = b.x AND bm.y = b.y AND bm.z = b.z AND bm.found_at IS NULL
       WHERE b.block_type <> 0`
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
    const unlockedPets = PET_TYPES.filter((p) => userPlaced >= p.unlockAt).map((p) => p.id);
    const presRow = await pool.query(`SELECT active_pet FROM user_presence WHERE user_id = $1`, [req.user.id]);
    const activePet = presRow.rows.length ? (presRow.rows[0].active_pet || null) : null;
    const monumentsRes = await pool.query(
      `SELECT id, name, sector_x, sector_z, block_count, contributor_count, crowned_at
       FROM monuments ORDER BY block_count DESC`
    );
    const monuments = monumentsRes.rows.map((r) => ({
      id: Number(r.id), name: r.name,
      sector_x: r.sector_x, sector_z: r.sector_z,
      block_count: Number(r.block_count), contributor_count: Number(r.contributor_count),
      crowned_at: r.crowned_at,
    }));
    const tutorialRes = await pool.query(`SELECT user_id FROM player_tutorial_completed WHERE user_id = $1`, [req.user.id]);
    const tutorial_completed = tutorialRes.rows.length > 0;
    res.json({
      dims: DIMS,
      palette: PALETTE,
      petTypes: PET_TYPES,
      blocks: rows.map((r) => { const b = { x: r.x, y: r.y, z: r.z, t: r.block_type }; if (r.skin_id) b.s = r.skin_id; if (r.has_message) b.m = 1; return b; }),
      cursor: Number(cur.rows[0].cursor),
      maxDisasterId: Number(maxDisasterRes.rows[0].max_disaster_id),
      unlockedTypes,
      activeSkin,
      unlockedPets,
      activePet,
      monuments,
      isStaging: IS_STAGING,
      tutorial_completed,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load world data: ' + err.message });
  }
});

// ---- Shared block-placement logic used by both the HTTP handler and the AI loop ----
// Validates, persists, and scores a single placement or break. Returns the same
// shape the HTTP handler sends to the client. Throws on validation failure
// (err.statusCode = 400) or DB error.
async function applyBlock({ userId, username, x, y, z, blockType }) {
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!intIn(x, 0, DIMS.w - 1) || !intIn(z, 0, DIMS.d - 1)) {
    const e = new Error('coordinate out of bounds'); e.statusCode = 400; throw e;
  }
  if (!intIn(y, 1, DIMS.h - 1)) {
    const e = new Error('y out of buildable range'); e.statusCode = 400; throw e;
  }
  if (blockType !== 0 && !VALID_TYPES.has(blockType)) {
    const e = new Error('unknown block_type'); e.statusCode = 400; throw e;
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
    [x, y, z, blockType, userId, username]
  );
  const seq = Number(rows[0].seq);

  let challenge = null;
  let earned = 0, combo_multiplier = 1, rainbow_multiplier = 1, combo_tier = 1;
  let newly_earned_badges = [];

  if (blockType !== 0) {
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
      [dateStr, userId, username, target]
    );
    const cr0 = cr.rows[0];
    challenge = { placed: cr0.blocks_placed, target, completed_at: cr0.completed_at };

    const base = BLOCK_POINTS[blockType] || 1;

    // Combo: count placements this user made in the last 10 seconds
    // (exclude the just-inserted cell to avoid double-counting).
    const comboRes = await pool.query(
      `SELECT COUNT(*)::int AS recent
       FROM blocks
       WHERE updated_by_user_id = $1
         AND block_type <> 0
         AND updated_at > NOW() - INTERVAL '10 seconds'
         AND NOT (x = $2 AND y = $3 AND z = $4)`,
      [userId, x, y, z]
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
      [userId]
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
      [userId, username, earned, combo_tier]
    );

    const lb = {
      total_score:   Number(lbRes.rows[0].total_score),
      blocks_placed: Number(lbRes.rows[0].blocks_placed),
      best_combo:    lbRes.rows[0].best_combo,
    };

    await pool.query(
      `INSERT INTO tournament_scores (week_start, user_id, username, score, blocks_placed, updated_at)
       VALUES ($1, $2, $3, $4, 1, NOW())
       ON CONFLICT (week_start, user_id) DO UPDATE SET
         score         = tournament_scores.score + EXCLUDED.score,
         blocks_placed = tournament_scores.blocks_placed + 1,
         username      = EXCLUDED.username,
         updated_at    = NOW()`,
      [weekStart(now), userId, username, earned]
    );

    await pool.query(
      `INSERT INTO player_type_usage (user_id, block_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, blockType]
    );

    const earnedRes = await pool.query(
      `SELECT badge_id FROM player_badges WHERE user_id = $1`,
      [userId]
    );
    const earnedIds = new Set(earnedRes.rows.map((r) => r.badge_id));

    const typeCountRes = await pool.query(
      `SELECT COUNT(*)::int AS type_count FROM player_type_usage WHERE user_id = $1`,
      [userId]
    );
    const typeCount = typeCountRes.rows[0].type_count;

    const newBadges = checkBadges({ lb, justPlacedType: blockType, typeCount }, earnedIds);
    for (const badge of newBadges) {
      await pool.query(
        `INSERT INTO player_badges (user_id, badge_id, earned_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING`,
        [userId, badge.id]
      );
    }
    newly_earned_badges = newBadges.map((b) => ({ id: b.id, name: b.name, icon: b.icon, flavour: b.flavour }));
  }

  return { seq, ...(challenge ? { challenge } : {}), earned, combo_multiplier, rainbow_multiplier, newly_earned_badges };
}

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

    // Remove any existing hidden message at this coordinate (handles both
    // overwrites and breaks — a new placer starts with a clean slate).
    await pool.query(`DELETE FROM block_messages WHERE x = $1 AND y = $2 AND z = $3`, [x, y, z]);

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

    // Optionally attach a hidden message to the newly placed block.
    if (t !== 0) {
      const rawMsg = typeof req.body.message === 'string' ? req.body.message.trim() : '';
      if (rawMsg.length > 0 && rawMsg.length <= 200) {
        await pool.query(
          `INSERT INTO block_messages (x, y, z, author_user_id, author_username, body, hidden_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           ON CONFLICT (x, y, z) DO NOTHING`,
          [x, y, z, req.user.id, req.user.username, rawMsg]
        );
      }
    }

    // Track challenge progress for placements only (breaks don't count).
    let challenge = null;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    // ---- Scoring (placements only; breaks earn 0) ----
    let earned = 0, combo_multiplier = 1, rainbow_multiplier = 1, combo_tier = 1;
    let newly_earned_badges = [];
    let newly_unlocked_types = [];
    let newly_unlocked_pets = [];
    if (t !== 0) {
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

      const comboRes = await pool.query(
        `SELECT COUNT(*)::int AS recent FROM blocks
         WHERE updated_by_user_id = $1 AND block_type <> 0
           AND updated_at > NOW() - INTERVAL '10 seconds'
           AND NOT (x = $2 AND y = $3 AND z = $4)`,
        [req.user.id, x, y, z]
      );
      const recent = comboRes.rows[0].recent;
      if (recent >= 10) { combo_multiplier = 5; combo_tier = 4; }
      else if (recent >= 6) { combo_multiplier = 3; combo_tier = 3; }
      else if (recent >= 3) { combo_multiplier = 2; combo_tier = 2; }

      const rainbowRes = await pool.query(
        `SELECT 1 FROM blocks WHERE updated_by_user_id = $1 AND block_type = 17
         AND updated_at > NOW() - INTERVAL '30 seconds' LIMIT 1`,
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

      // Award 1 coin per placement. First-ever placement inserts 51 (50 starter + 1).
      await pool.query(
        `INSERT INTO player_coins (user_id, username, balance, updated_at)
         VALUES ($1, $2, 51, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           balance = player_coins.balance + 1,
           username = EXCLUDED.username,
           updated_at = NOW()`,
        [req.user.id, req.user.username]
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

      // Check daily_regular badge: fires when the challenge is completed and the
      // player hasn't earned it yet. Queries total completions only at that moment.
      if (challenge && challenge.completed_at && !earnedIds.has('daily_regular')) {
        const { rows: dcRows } = await pool.query(
          `SELECT COUNT(*)::int AS c FROM daily_challenge_progress WHERE user_id = $1 AND completed_at IS NOT NULL`,
          [req.user.id]
        );
        if (Number(dcRows[0].c) >= 5) {
          const ins = await pool.query(
            `INSERT INTO player_badges (user_id, badge_id, earned_at) VALUES ($1, 'daily_regular', NOW()) ON CONFLICT DO NOTHING RETURNING badge_id`,
            [req.user.id]
          );
          if (ins.rows.length > 0) {
            const def = BADGES.find((b) => b.id === 'daily_regular');
            if (def) newly_earned_badges.push({ id: def.id, name: def.name, icon: def.icon, flavour: def.flavour });
          }
        }
      }

      // Detect first crossing of any block unlock threshold (blocks_placed increments by 1 per
      // placement, so === only fires once — the exact turn the threshold is first reached).
      for (const up of PALETTE.filter((p) => p.unlockAt)) {
        if (lb.blocks_placed === up.unlockAt) {
          newly_unlocked_types.push({ id: up.id, name: up.name, icon: up.unlockIcon || '✨', description: 'A translucent gem-like block, earned through dedication.' });
        }
      }

      // Detect pet unlock milestones (same exact-crossing pattern as block types).
      for (const pet of PET_TYPES) {
        if (lb.blocks_placed === pet.unlockAt) {
          newly_unlocked_pets.push({ id: pet.id, name: pet.name, icon: pet.icon });
        }
      }
    }

    // ---- Daily mission progress (runs for placements and breaks) ----
    let newly_earned_mission_badges = [];
    let mission_data = null;
    {
      const mission = dailyMission(now);
      let advances = false;
      let delta = 0;
      if (mission.type === 'place_type' && t === mission.blockType) {
        advances = true; delta = 1;
      } else if (mission.type === 'reach_height' && t !== 0 && y >= mission.target) {
        advances = true; delta = mission.target;
      } else if (mission.type === 'break_blocks' && t === 0) {
        advances = true; delta = 1;
      }

      if (advances) {
        const prevRes = await pool.query(
          `SELECT progress, completed_at FROM daily_mission_progress WHERE mission_date = $1 AND user_id = $2`,
          [dateStr, req.user.id]
        );
        const prevRow = prevRes.rows[0];
        const wasCompleted = prevRow && prevRow.completed_at !== null;

        if (!wasCompleted) {
          const currentProgress = prevRow ? Number(prevRow.progress) : 0;
          const newProgress = mission.type === 'reach_height'
            ? mission.target
            : Math.min(mission.target, currentProgress + delta);
          const justCompleted = newProgress >= mission.target;
          const completedAtVal = justCompleted ? new Date() : null;

          await pool.query(
            `INSERT INTO daily_mission_progress
               (mission_date, user_id, username, mission_type, progress, target, completed_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
             ON CONFLICT (mission_date, user_id) DO UPDATE SET
               progress = $5,
               username = EXCLUDED.username,
               completed_at = COALESCE(daily_mission_progress.completed_at, $7),
               updated_at = NOW()`,
            [dateStr, req.user.id, req.user.username, mission.type, newProgress, mission.target, completedAtVal]
          );

          if (justCompleted) {
            // Award 50 bonus points to leaderboard and weekly tournament.
            await pool.query(
              `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
               VALUES ($1, $2, 50, 0, 1, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 total_score = leaderboard.total_score + 50,
                 username = EXCLUDED.username,
                 updated_at = NOW()`,
              [req.user.id, req.user.username]
            );
            await pool.query(
              `INSERT INTO tournament_scores (week_start, user_id, username, score, blocks_placed, updated_at)
               VALUES ($1, $2, $3, 50, 0, NOW())
               ON CONFLICT (week_start, user_id) DO UPDATE SET
                 score = tournament_scores.score + 50,
                 username = EXCLUDED.username,
                 updated_at = NOW()`,
              [weekStart(now), req.user.id, req.user.username]
            );

            // Update mission completion streak.
            const missionStreakRes = await pool.query(
              `INSERT INTO mission_streaks (user_id, username, last_completed_date, current_streak, longest_streak, updated_at)
               VALUES ($1, $2, CURRENT_DATE, 1, 1, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 username = EXCLUDED.username,
                 current_streak = CASE
                   WHEN mission_streaks.last_completed_date = CURRENT_DATE     THEN mission_streaks.current_streak
                   WHEN mission_streaks.last_completed_date = CURRENT_DATE - 1 THEN mission_streaks.current_streak + 1
                   ELSE 1
                 END,
                 longest_streak = GREATEST(mission_streaks.longest_streak, CASE
                   WHEN mission_streaks.last_completed_date = CURRENT_DATE     THEN mission_streaks.current_streak
                   WHEN mission_streaks.last_completed_date = CURRENT_DATE - 1 THEN mission_streaks.current_streak + 1
                   ELSE 1
                 END),
                 last_completed_date = CASE
                   WHEN mission_streaks.last_completed_date = CURRENT_DATE THEN mission_streaks.last_completed_date
                   ELSE CURRENT_DATE
                 END,
                 updated_at = NOW()
               RETURNING current_streak`,
              [req.user.id, req.user.username]
            );
            const missionStreak = Number(missionStreakRes.rows[0].current_streak);

            // Check and award mission-specific badges.
            const missionEarnedRes = await pool.query(
              `SELECT badge_id FROM player_badges WHERE user_id = $1 AND badge_id LIKE 'mission_%'`,
              [req.user.id]
            );
            const missionEarnedIds = new Set(missionEarnedRes.rows.map((r) => r.badge_id));
            const missionBadgesToCheck = [
              { id: 'mission_complete', condition: true },
              ...MISSION_STREAK_BADGE_MILESTONES.map(({ days, id }) => ({ id, condition: missionStreak >= days })),
            ];
            for (const { id, condition } of missionBadgesToCheck) {
              if (condition && !missionEarnedIds.has(id)) {
                const ins = await pool.query(
                  `INSERT INTO player_badges (user_id, badge_id, earned_at)
                   VALUES ($1, $2, NOW())
                   ON CONFLICT DO NOTHING
                   RETURNING badge_id`,
                  [req.user.id, id]
                );
                if (ins.rows.length > 0) {
                  const def = BADGES.find((b) => b.id === id);
                  if (def) newly_earned_mission_badges.push({ id: def.id, name: def.name, icon: def.icon, flavour: def.flavour });
                }
              }
            }
          }

          mission_data = {
            progress: newProgress,
            target: mission.target,
            completed_at: completedAtVal ? completedAtVal.toISOString() : null,
            newly_earned_mission_badges,
          };
        }
      }
    }

    // ---- Line clearing: detect and clear complete horizontal layers ----
    let lines_cleared = 0;
    let line_clear_points = 0;
    let bomb_explosions = [];
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
        // Scan for Bomb blocks in this row BEFORE clearing (positions won't exist after)
        const bombScanRes = await pool.query(
          `SELECT x, y, z FROM blocks WHERE y = $1 AND block_type = 27`,
          [y]
        );
        const bombPositions = bombScanRes.rows;

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

        // Detonate each Bomb: destroy non-air blocks within a radius-2 sphere.
        // Bombs are scanned once before clearing so positions are stable — no chaining.
        for (const bomb of bombPositions) {
          const { x: bx, y: by, z: bz } = bomb;
          const explodeRes = await pool.query(
            `UPDATE blocks
             SET block_type = 0, seq = nextval('block_seq'),
                 updated_by_user_id = $4, updated_by_username = $5, updated_at = NOW()
             WHERE (x-$1)*(x-$1)+(y-$2)*(y-$2)+(z-$3)*(z-$3) <= 4
               AND block_type <> 0
             RETURNING x, y, z`,
            [bx, by, bz, req.user.id, req.user.username]
          );
          const bonus_destroyed = explodeRes.rows.length;
          await pool.query(
            `DELETE FROM block_messages
             WHERE (x-$1)*(x-$1)+(y-$2)*(y-$2)+(z-$3)*(z-$3) <= 4`,
            [bx, by, bz]
          );
          const bonus_points = bonus_destroyed * 2;
          if (bonus_points > 0) {
            await pool.query(
              `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
               VALUES ($1, $2, $3, 0, 0, NOW())
               ON CONFLICT (user_id) DO UPDATE SET
                 total_score   = leaderboard.total_score + EXCLUDED.total_score,
                 username      = EXCLUDED.username,
                 updated_at    = NOW()`,
              [req.user.id, req.user.username, bonus_points]
            );
          }
          bomb_explosions.push({ x: bx, y: by, z: bz, bonus_points });
        }
      }
    }

    // Recompute monument for the sector containing the placed/broken block.
    let newly_crowned_monuments = [];
    const monument = await recomputeMonument(sectorCoord(x), sectorCoord(z));
    if (monument && monument.is_new) newly_crowned_monuments = [{ id: monument.id, name: monument.name, sector_x: monument.sector_x, sector_z: monument.sector_z }];

    res.json({ ok: true, seq, ...(challenge ? { challenge } : {}), earned, combo_multiplier, rainbow_multiplier, newly_earned_badges, newly_unlocked_types, newly_unlocked_pets, lines_cleared, line_clear_points, bomb_explosions, newly_crowned_monuments, ...(mission_data ? { mission: mission_data } : {}), ...(activeSkinId ? { skin_id: activeSkinId } : {}) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
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
        `SELECT b.x, b.y, b.z, b.block_type, b.skin_id, b.seq,
                (bm.x IS NOT NULL) AS has_message
         FROM blocks b
         LEFT JOIN block_messages bm
           ON bm.x = b.x AND bm.y = b.y AND bm.z = b.z AND bm.found_at IS NULL
         WHERE b.seq > $1 ORDER BY b.seq`,
        [since]
      );
      changes = rows.map((r) => { const c = { x: r.x, y: r.y, z: r.z, t: r.block_type }; if (r.skin_id) c.s = r.skin_id; if (r.has_message) c.m = 1; return c; });
      cursor = rows.length ? Number(rows[rows.length - 1].seq) : since;
    }

    const monRes = await pool.query(
      `SELECT id, name, sector_x, sector_z, block_count, contributor_count, crowned_at
       FROM monuments ORDER BY block_count DESC`
    );
    const monuments = monRes.rows.map((r) => ({
      id: Number(r.id), name: r.name,
      sector_x: r.sector_x, sector_z: r.sector_z,
      block_count: Number(r.block_count), contributor_count: Number(r.contributor_count),
      crowned_at: r.crowned_at,
    }));

    res.json({
      changes,
      cursor,
      events,
      eventsCursor,
      monuments,
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
    let rows;
    if (since === 0) {
      // Initial load: grab the 50 NEWEST messages (id DESC) then re-sort
      // ascending so they render oldest-to-newest in the drawer.
      const r = await pool.query(
        `SELECT id, username, body, created_at FROM (
           SELECT id, username, body, created_at FROM chat_messages
           ORDER BY id DESC LIMIT 50
         ) recent ORDER BY id ASC`
      );
      rows = r.rows;
    } else {
      // Delta poll: everything strictly newer than the client's cursor.
      const r = await pool.query(
        `SELECT id, username, body, created_at FROM chat_messages WHERE id > $1 ORDER BY id LIMIT 500`,
        [since]
      );
      rows = r.rows;
    }
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
    const mode = ['classic', 'spectate', 'versus'].includes(rawMode) ? rawMode : 'classic';
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

    // Daily coin login bonus: +10 per UTC day; +60 for brand-new players (50 starter + 10).
    const coinLoginRes = await pool.query(
      `INSERT INTO player_coins (user_id, username, balance, last_coin_login_date, updated_at)
       VALUES ($1, $2, 60, CURRENT_DATE, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         balance = CASE
           WHEN player_coins.last_coin_login_date IS NULL
             OR player_coins.last_coin_login_date < CURRENT_DATE
           THEN player_coins.balance + 10
           ELSE player_coins.balance
         END,
         last_coin_login_date = CURRENT_DATE,
         username = EXCLUDED.username,
         updated_at = NOW()
       RETURNING balance`,
      [req.user.id, req.user.username]
    );
    const coins_balance = Number(coinLoginRes.rows[0].balance);

    res.json({
      ok: true,
      streak: { current: current_streak, longest: longest_streak },
      newly_earned_badges: newlyEarnedBadges,
      coins_balance,
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

// ---- Pet: equip or unequip a companion ----
app.post('/api/pet/equip', async (req, res) => {
  try {
    const { pet_id } = req.body;
    if (pet_id !== null && pet_id !== undefined && !PET_MAP.has(pet_id)) {
      return res.status(400).json({ error: 'Unknown pet_id' });
    }
    if (pet_id) {
      const lbRow = await pool.query(`SELECT blocks_placed FROM leaderboard WHERE user_id = $1`, [req.user.id]);
      const placed = lbRow.rows.length ? Number(lbRow.rows[0].blocks_placed) : 0;
      const pet = PET_MAP.get(pet_id);
      if (placed < pet.unlockAt) return res.status(403).json({ error: 'Pet not yet unlocked' });
    }
    await pool.query(
      `INSERT INTO user_presence (user_id, username, last_seen, active_pet)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (user_id) DO UPDATE SET active_pet = $3`,
      [req.user.id, req.user.username, pet_id || null]
    );
    res.json({ ok: true, active_pet: pet_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Player coins: current user's coin balance ----
app.get('/api/player/coins', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT balance FROM player_coins WHERE user_id = $1`,
      [req.user.id]
    );
    const coins = rows.length ? Number(rows[0].balance) : 0;
    res.json({ coins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Energy: get current energy status ----
app.get('/api/energy/status', async (req, res) => {
  try {
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Get today's energy row; if no row for today exists, assume 5 free tickets available
    const energyRes = await pool.query(
      `SELECT tickets_used, points_burned, tokens_burned FROM player_daily_energy
       WHERE user_id = $1 AND energy_date = $2`,
      [req.user.id, todayStr]
    );

    const ticketsUsed = energyRes.rows.length ? Number(energyRes.rows[0].tickets_used) : 0;
    const pointsBurned = energyRes.rows.length ? Number(energyRes.rows[0].points_burned) : 0;
    const ticketsRemaining = Math.max(0, ENERGY_TICKETS_PER_DAY - ticketsUsed);

    // Get user's current points from leaderboard
    const lbRes = await pool.query(
      `SELECT total_score FROM leaderboard WHERE user_id = $1`,
      [req.user.id]
    );
    const pointsAvailable = lbRes.rows.length ? Number(lbRes.rows[0].total_score) : 0;

    // Calculate next reset time (midnight UTC tomorrow)
    const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const nextResetUtc = tomorrow.toISOString();
    const secondsUntilReset = Math.max(0, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));

    res.json({
      date: todayStr,
      tickets_remaining: ticketsRemaining,
      tickets_limit: ENERGY_TICKETS_PER_DAY,
      points_available: pointsAvailable,
      cost_per_ticket_points: ENERGY_COST_POINTS_PER_TICKET,
      tokens_available: 0,
      cost_per_ticket_tokens: null,
      next_reset_utc: nextResetUtc,
      seconds_until_reset: secondsUntilReset,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Energy: attempt to consume a ticket and start a game ----
app.post('/api/energy/start-game', async (req, res) => {
  try {
    const { mode, spend_type } = req.body || {};
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    if (!['free', 'points', 'tokens'].includes(spend_type)) {
      return res.status(400).json({ error: 'Invalid spend_type' });
    }

    if (spend_type === 'free') {
      // Consume a free ticket
      const result = await pool.query(
        `INSERT INTO player_daily_energy (user_id, energy_date, tickets_used, points_burned, tokens_burned, updated_at)
         VALUES ($1, $2, 1, 0, 0, NOW())
         ON CONFLICT (user_id, energy_date) DO UPDATE SET
           tickets_used = player_daily_energy.tickets_used + 1,
           updated_at = NOW()
         WHERE player_daily_energy.tickets_used < $3
         RETURNING tickets_used`,
        [req.user.id, todayStr, ENERGY_TICKETS_PER_DAY]
      );

      if (!result.rows.length) {
        // Conflict: user has no free tickets left
        const energyRes = await pool.query(
          `SELECT tickets_used FROM player_daily_energy WHERE user_id = $1 AND energy_date = $2`,
          [req.user.id, todayStr]
        );
        const ticketsUsed = energyRes.rows.length ? Number(energyRes.rows[0].tickets_used) : 0;
        const ticketsRemaining = Math.max(0, ENERGY_TICKETS_PER_DAY - ticketsUsed);

        const lbRes = await pool.query(`SELECT total_score FROM leaderboard WHERE user_id = $1`, [req.user.id]);
        const pointsAvailable = lbRes.rows.length ? Number(lbRes.rows[0].total_score) : 0;

        const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

        return res.status(400).json({
          ok: false,
          error: 'No tickets remaining',
          tickets_remaining: ticketsRemaining,
          points_available: pointsAvailable,
          next_reset_utc: tomorrow.toISOString(),
        });
      }

      const ticketsUsed = Number(result.rows[0].tickets_used);
      const ticketsRemaining = Math.max(0, ENERGY_TICKETS_PER_DAY - ticketsUsed);

      return res.json({
        ok: true,
        tickets_remaining: ticketsRemaining,
        points_burned: null,
        tokens_burned: null,
      });
    } else if (spend_type === 'points') {
      // User wants to burn points; this endpoint handles the start-game call
      // The actual burning will be done in /api/energy/burn-points before calling this again
      // For now, we'll allow the game to start and the UI will handle the burn flow
      const energyRes = await pool.query(
        `SELECT tickets_used FROM player_daily_energy WHERE user_id = $1 AND energy_date = $2`,
        [req.user.id, todayStr]
      );
      const ticketsUsed = energyRes.rows.length ? Number(energyRes.rows[0].tickets_used) : 0;
      const ticketsRemaining = Math.max(0, ENERGY_TICKETS_PER_DAY - ticketsUsed);

      if (ticketsRemaining > 0) {
        // Still have free tickets; consume one
        const result = await pool.query(
          `UPDATE player_daily_energy SET tickets_used = tickets_used + 1, updated_at = NOW()
           WHERE user_id = $1 AND energy_date = $2 AND tickets_used < $3
           RETURNING tickets_used`,
          [req.user.id, todayStr, ENERGY_TICKETS_PER_DAY]
        );
        if (result.rows.length) {
          const newTicketsUsed = Number(result.rows[0].tickets_used);
          return res.json({
            ok: true,
            tickets_remaining: Math.max(0, ENERGY_TICKETS_PER_DAY - newTicketsUsed),
            points_burned: null,
            tokens_burned: null,
          });
        }
      }

      // No free tickets left; user must burn points
      return res.status(400).json({
        ok: false,
        error: 'Must burn points to play',
      });
    }

    res.status(400).json({ error: 'Unimplemented spend_type' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Daily Energy: burn points to grant a ticket ----
app.post('/api/energy/burn-points', async (req, res) => {
  try {
    const { points } = req.body || {};
    const pointsToBurn = Number(points) || ENERGY_COST_POINTS_PER_TICKET;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Get user's current points
    const lbRes = await pool.query(
      `SELECT total_score FROM leaderboard WHERE user_id = $1`,
      [req.user.id]
    );
    const pointsAvailable = lbRes.rows.length ? Number(lbRes.rows[0].total_score) : 0;

    if (pointsAvailable < pointsToBurn) {
      return res.status(400).json({
        ok: false,
        error: 'Insufficient points',
        points_available: pointsAvailable,
        points_needed: pointsToBurn,
      });
    }

    // Deduct points and insert/update energy record with burned points tracked
    // First deduct points from leaderboard
    await pool.query(
      `UPDATE leaderboard SET total_score = total_score - $1, updated_at = NOW()
       WHERE user_id = $2`,
      [pointsToBurn, req.user.id]
    );

    // Then update energy record
    const energyResult = await pool.query(
      `INSERT INTO player_daily_energy (user_id, energy_date, tickets_used, points_burned, tokens_burned, updated_at)
       VALUES ($1, $2, 0, $3, 0, NOW())
       ON CONFLICT (user_id, energy_date) DO UPDATE SET
         points_burned = player_daily_energy.points_burned + EXCLUDED.points_burned,
         updated_at = NOW()
       RETURNING tickets_used, points_burned`,
      [req.user.id, todayStr, pointsToBurn]
    );

    const ticketsUsed = Number(energyResult.rows[0].tickets_used);
    const pointsBurned = Number(energyResult.rows[0].points_burned);
    const ticketsRemaining = Math.max(0, ENERGY_TICKETS_PER_DAY - ticketsUsed);
    const newPointsAvailable = pointsAvailable - pointsToBurn;

    res.json({
      ok: true,
      points_available: newPointsAvailable,
      tickets_remaining: ticketsRemaining,
      points_burned_today: pointsBurned,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Presence: who is online (seen in the last 60s), optionally filtered by world ----
app.get('/api/presence/online', async (req, res) => {
  try {
    const current_world_id = req.query.current_world_id ? Number(req.query.current_world_id) : null;

    let query = `SELECT username, mode, active_pet, current_world_id FROM user_presence
       WHERE last_seen > NOW() - INTERVAL '60 seconds'`;
    if (current_world_id !== null) {
      query += ` AND (current_world_id = $1 OR current_world_id IS NULL)`;
    }
    query += ` ORDER BY username`;

    const params = current_world_id !== null ? [current_world_id] : [];
    const { rows } = await pool.query(query, params);
    const users = rows.map((r) => ({ username: r.username, mode: r.mode || 'classic', active_pet: r.active_pet || null }));
    if (IS_STAGING) users.push(...STAGING_DEMO_USERS);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Fog of War: get all revealed (x,z) cells for the current user ----
app.get('/api/fog/revealed', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT x, z FROM player_fog_revealed WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ cells: rows.map((r) => [r.x, r.z]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Fog of War: batch-reveal newly visited (x,z) cells ----
app.post('/api/fog/reveal', async (req, res) => {
  try {
    const cells = req.body && Array.isArray(req.body.cells) ? req.body.cells : [];
    if (cells.length > 1024) return res.status(400).json({ error: 'too many cells' });
    const valid = cells.filter(
      (c) => Array.isArray(c) && Number.isInteger(c[0]) && Number.isInteger(c[1])
            && c[0] >= 0 && c[0] <= 31 && c[1] >= 0 && c[1] <= 31
    );
    if (valid.length === 0) return res.json({ ok: true });
    const values = valid.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
    const params = [req.user.id, ...valid.flat()];
    await pool.query(
      `INSERT INTO player_fog_revealed (user_id, x, z) VALUES ${values}
       ON CONFLICT (user_id, x, z) DO NOTHING`,
      params
    );
    res.json({ ok: true });
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

// ---- Player stats: full snapshot for the current user's Profile panel ----
app.get('/api/stats/me', async (req, res) => {
  try {
    const uid = req.user.id;
    const [lbRes, streakRes, typeRes, dcRes, badgeRes] = await Promise.all([
      pool.query(`SELECT total_score, blocks_placed, best_combo, best_time_attack_score FROM leaderboard WHERE user_id = $1`, [uid]),
      pool.query(`SELECT current_streak, longest_streak FROM login_streaks WHERE user_id = $1`, [uid]),
      pool.query(`SELECT COUNT(*)::int AS c FROM player_type_usage WHERE user_id = $1`, [uid]),
      pool.query(`SELECT COUNT(*)::int AS c FROM daily_challenge_progress WHERE user_id = $1 AND completed_at IS NOT NULL`, [uid]),
      pool.query(`SELECT COUNT(*)::int AS c FROM player_badges WHERE user_id = $1`, [uid]),
    ]);
    const lb = lbRes.rows[0];
    const streak = streakRes.rows[0];
    res.json({
      total_score:              lb ? Number(lb.total_score)   : 0,
      blocks_placed:            lb ? Number(lb.blocks_placed) : 0,
      best_combo:               lb ? lb.best_combo            : 1,
      best_time_attack_score:   lb ? Number(lb.best_time_attack_score) : 0,
      current_streak:           streak ? streak.current_streak  : 0,
      longest_streak:           streak ? streak.longest_streak  : 0,
      distinct_types_used:      typeRes.rows[0].c,
      daily_challenges_completed: dcRes.rows[0].c,
      badges_earned:            badgeRes.rows[0].c,
      badges_total:             BADGES.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Community Monuments: ranked list of all crowned sectors ----
app.get('/api/monuments', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, sector_x, sector_z, block_count, contributor_count, crowned_at
       FROM monuments ORDER BY block_count DESC`
    );
    res.json({
      monuments: rows.map((r) => ({
        id: Number(r.id), name: r.name,
        sector_x: r.sector_x, sector_z: r.sector_z,
        block_count: Number(r.block_count), contributor_count: Number(r.contributor_count),
        crowned_at: r.crowned_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Time Attack score: persist personal best, award speed_demon badge ----
app.post('/api/time-attack/score', async (req, res) => {
  try {
    const blocksCleared = Number(req.body.blocks_cleared);
    if (!Number.isInteger(blocksCleared) || blocksCleared < 0 || blocksCleared > 1800) {
      return res.status(400).json({ error: 'invalid blocks_cleared value' });
    }
    // Upsert leaderboard row (ensures it exists) and update TA best only if higher.
    await pool.query(
      `INSERT INTO leaderboard (user_id, username, best_time_attack_score, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         best_time_attack_score = GREATEST(leaderboard.best_time_attack_score, EXCLUDED.best_time_attack_score),
         username = EXCLUDED.username,
         updated_at = NOW()`,
      [req.user.id, req.user.username, blocksCleared]
    );
    const { rows: [lbRow] } = await pool.query(
      `SELECT best_time_attack_score FROM leaderboard WHERE user_id = $1`, [req.user.id]
    );
    const best = Number(lbRow.best_time_attack_score);

    // Check speed_demon badge (clear 30+ blocks in a single TA run).
    const earned = [];
    if (blocksCleared >= 30) {
      const { rows: alreadyEarned } = await pool.query(
        `SELECT 1 FROM player_badges WHERE user_id = $1 AND badge_id = 'speed_demon'`, [req.user.id]
      );
      if (!alreadyEarned.length) {
        const ins = await pool.query(
          `INSERT INTO player_badges (user_id, badge_id, earned_at) VALUES ($1, 'speed_demon', NOW()) ON CONFLICT DO NOTHING RETURNING badge_id`,
          [req.user.id]
        );
        if (ins.rows.length > 0) earned.push('speed_demon');
      }
    }
    res.json({ best, earned });
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

// ---- Daily leaderboard: today's challenge completers (earliest first) ----
app.get('/api/leaderboard/daily', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const target = dailyTarget(now);
    const topRes = await pool.query(
      `SELECT rank() OVER (ORDER BY completed_at ASC) AS rank,
              user_id, username, completed_at
       FROM daily_challenge_progress
       WHERE challenge_date = $1 AND completed_at IS NOT NULL
       ORDER BY completed_at ASC
       LIMIT 10`,
      [dateStr]
    );
    const selfRes = await pool.query(
      `SELECT user_id, username, blocks_placed, completed_at
       FROM daily_challenge_progress
       WHERE challenge_date = $1 AND user_id = $2`,
      [dateStr, req.user.id]
    );
    const toEntry = (r, i) => ({
      rank: Number(r.rank),
      user_id: r.user_id,
      username: r.username,
      completed_at: r.completed_at,
    });
    const selfRow = selfRes.rows[0];
    res.json({
      entries: topRes.rows.map(toEntry),
      self: selfRow ? {
        user_id: selfRow.user_id,
        username: selfRow.username,
        blocks_placed: Number(selfRow.blocks_placed),
        completed_at: selfRow.completed_at,
        target,
      } : { user_id: req.user.id, username: req.user.username, blocks_placed: 0, completed_at: null, target },
    });
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

// ---- Versus Mode ----

function generateRoomCode() {
  // Omit easily confused chars: 0/O, 1/I/L
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// POST /api/versus/create — create a new match and become host
app.post('/api/versus/create', async (req, res) => {
  try {
    let roomCode;
    for (let attempt = 0; attempt < 10; attempt++) {
      roomCode = generateRoomCode();
      const existing = await pool.query(`SELECT id FROM versus_matches WHERE room_code = $1`, [roomCode]);
      if (!existing.rows.length) break;
    }
    const matchRes = await pool.query(
      `INSERT INTO versus_matches (room_code, status, host_user_id, host_username, max_players, duration_secs)
       VALUES ($1, 'waiting', $2, $3, 4, 60) RETURNING id`,
      [roomCode, req.user.id, req.user.username]
    );
    const matchId = matchRes.rows[0].id;
    await pool.query(
      `INSERT INTO versus_players (match_id, user_id, username) VALUES ($1, $2, $3)
       ON CONFLICT (match_id, user_id) DO NOTHING`,
      [matchId, req.user.id, req.user.username]
    );
    res.json({ match_id: matchId, room_code: roomCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/versus/join — join a match by room code
app.post('/api/versus/join', async (req, res) => {
  try {
    const roomCode = (req.body.room_code || '').toString().toUpperCase().trim();
    if (!roomCode) return res.status(400).json({ error: 'room_code required' });
    const matchRes = await pool.query(
      `SELECT id, status, max_players, host_username, created_at
       FROM versus_matches WHERE room_code = $1`,
      [roomCode]
    );
    if (!matchRes.rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchRes.rows[0];
    if (match.status !== 'waiting') return res.status(400).json({ error: 'Match already started' });
    const ageMs = Date.now() - new Date(match.created_at).getTime();
    if (ageMs > 10 * 60 * 1000) return res.status(400).json({ error: 'Match expired' });
    const countRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM versus_players WHERE match_id = $1`, [match.id]
    );
    if (Number(countRes.rows[0].cnt) >= match.max_players) {
      return res.status(400).json({ error: 'Match is full' });
    }
    await pool.query(
      `INSERT INTO versus_players (match_id, user_id, username) VALUES ($1, $2, $3)
       ON CONFLICT (match_id, user_id) DO UPDATE SET username = EXCLUDED.username`,
      [match.id, req.user.id, req.user.username]
    );
    res.json({ ok: true, match_id: match.id, host_username: match.host_username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/versus/start — host starts the match (triggers 5-second countdown)
app.post('/api/versus/start', async (req, res) => {
  try {
    const matchId = Number(req.body.match_id);
    if (!matchId) return res.status(400).json({ error: 'match_id required' });
    const matchRes = await pool.query(
      `SELECT id, status, host_user_id, duration_secs FROM versus_matches WHERE id = $1`, [matchId]
    );
    if (!matchRes.rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchRes.rows[0];
    if (match.host_user_id !== req.user.id) return res.status(403).json({ error: 'Only the host can start' });
    if (match.status !== 'waiting') return res.status(400).json({ error: 'Match already started' });
    const countRes = await pool.query(
      `SELECT COUNT(*) AS cnt FROM versus_players WHERE match_id = $1`, [matchId]
    );
    if (Number(countRes.rows[0].cnt) < 2) {
      return res.status(400).json({ error: 'Need at least 2 players to start' });
    }
    const startAt = new Date(Date.now() + 5000);
    const endAt = new Date(startAt.getTime() + match.duration_secs * 1000);
    await pool.query(
      `UPDATE versus_matches SET status = 'countdown', start_at = $1, end_at = $2 WHERE id = $3`,
      [startAt, endAt, matchId]
    );
    res.json({ ok: true, start_at: startAt.toISOString(), end_at: endAt.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/versus/match/:id — poll match state, optionally report live score
app.get('/api/versus/match/:id', async (req, res) => {
  try {
    const matchId = Number(req.params.id);
    const liveScoreParam = req.query.live_score;
    const liveScore = liveScoreParam !== undefined ? Number(liveScoreParam) : null;

    const matchRes = await pool.query(
      `SELECT id, room_code, status, host_user_id, host_username, start_at, end_at,
              winner_user_id, winner_username, duration_secs
       FROM versus_matches WHERE id = $1`,
      [matchId]
    );
    if (!matchRes.rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchRes.rows[0];

    // Only players in the match may poll
    const callerRes = await pool.query(
      `SELECT user_id FROM versus_players WHERE match_id = $1 AND user_id = $2`,
      [matchId, req.user.id]
    );
    if (!callerRes.rows.length) return res.status(403).json({ error: 'Not in this match' });

    // Update live score when match is active
    if (liveScore !== null && Number.isFinite(liveScore) && match.status === 'active') {
      await pool.query(
        `UPDATE versus_players SET live_score = $1, live_score_at = NOW()
         WHERE match_id = $2 AND user_id = $3`,
        [Math.max(0, Math.floor(liveScore)), matchId, req.user.id]
      );
    }

    // Countdown -> active transition
    if (match.status === 'countdown' && match.start_at && new Date(match.start_at) <= new Date()) {
      await pool.query(
        `UPDATE versus_matches SET status = 'active' WHERE id = $1 AND status = 'countdown'`,
        [matchId]
      );
      match.status = 'active';
    }

    // Check for match completion when active
    if (match.status === 'active') {
      const allRes = await pool.query(
        `SELECT user_id, username, final_score, submitted_at FROM versus_players WHERE match_id = $1`,
        [matchId]
      );
      const allPlayers = allRes.rows;
      const allSubmitted = allPlayers.every(p => p.submitted_at !== null);
      const gracePassed = match.end_at &&
        new Date() > new Date(new Date(match.end_at).getTime() + 15000);

      if (allSubmitted || gracePassed) {
        let winner = null, topScore = -1;
        for (const p of allPlayers) {
          const s = Number(p.final_score) || 0;
          if (s > topScore) { topScore = s; winner = p; }
        }
        await pool.query(
          `UPDATE versus_matches SET status = 'finished', winner_user_id = $1, winner_username = $2
           WHERE id = $3 AND status = 'active'`,
          [winner ? winner.user_id : null, winner ? winner.username : null, matchId]
        );
        match.status = 'finished';
        match.winner_user_id = winner ? winner.user_id : null;
        match.winner_username = winner ? winner.username : null;
      }
    }

    const playersRes = await pool.query(
      `SELECT user_id, username, live_score, final_score, submitted_at
       FROM versus_players WHERE match_id = $1 ORDER BY joined_at`,
      [matchId]
    );
    res.json({
      match: {
        id: match.id,
        room_code: match.room_code,
        status: match.status,
        host_user_id: match.host_user_id,
        host_username: match.host_username,
        start_at: match.start_at,
        end_at: match.end_at,
        winner_user_id: match.winner_user_id,
        winner_username: match.winner_username,
      },
      players: playersRes.rows.map(p => ({
        user_id: p.user_id,
        username: p.username,
        live_score: Number(p.live_score) || 0,
        final_score: p.final_score !== null ? Number(p.final_score) : null,
        submitted_at: p.submitted_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/versus/submit — record final score at end of match
app.post('/api/versus/submit', async (req, res) => {
  try {
    const matchId = Number(req.body.match_id);
    const score = Number(req.body.score);
    if (!matchId || !Number.isFinite(score) || score < 0) {
      return res.status(400).json({ error: 'match_id and non-negative score required' });
    }
    const matchRes = await pool.query(
      `SELECT id, status, end_at FROM versus_matches WHERE id = $1`, [matchId]
    );
    if (!matchRes.rows.length) return res.status(404).json({ error: 'Match not found' });
    const match = matchRes.rows[0];
    const gracePassed = match.end_at &&
      new Date() > new Date(new Date(match.end_at).getTime() + 15000);
    if (match.status === 'finished' || gracePassed) {
      return res.status(400).json({ error: 'Submission window closed' });
    }
    if (match.status !== 'active' && match.status !== 'countdown') {
      return res.status(400).json({ error: 'Match is not active' });
    }

    // Ensure caller is in the match
    const callerRes = await pool.query(
      `SELECT user_id FROM versus_players WHERE match_id = $1 AND user_id = $2`,
      [matchId, req.user.id]
    );
    if (!callerRes.rows.length) return res.status(403).json({ error: 'Not in this match' });

    await pool.query(
      `UPDATE versus_players SET final_score = $1, submitted_at = NOW(), live_score = $1
       WHERE match_id = $2 AND user_id = $3`,
      [Math.floor(score), matchId, req.user.id]
    );

    // Check if all players submitted
    const allRes = await pool.query(
      `SELECT user_id, username, final_score, submitted_at FROM versus_players WHERE match_id = $1`,
      [matchId]
    );
    const allSubmitted = allRes.rows.every(p => p.submitted_at !== null);
    let winnerDetermined = false;
    if (allSubmitted && match.status === 'active') {
      let winner = null, topScore = -1;
      for (const p of allRes.rows) {
        const s = Number(p.final_score) || 0;
        if (s > topScore) { topScore = s; winner = p; }
      }
      await pool.query(
        `UPDATE versus_matches SET status = 'finished', winner_user_id = $1, winner_username = $2
         WHERE id = $3`,
        [winner ? winner.user_id : null, winner ? winner.username : null, matchId]
      );
      winnerDetermined = true;
    }
    res.json({ ok: true, final_score: Math.floor(score), winner_determined: winnerDetermined });
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

    // Fetch badges — join against the in-memory BADGES array so the profile
    // stays in sync automatically whenever BADGES is updated.
    const badgesRes = await pool.query(
      `SELECT badge_id, earned_at FROM player_badges WHERE user_id = $1 ORDER BY earned_at`,
      [userId]
    );
    const badgeRows = badgesRes.rows.map((r) => {
      const def = BADGES.find((b) => b.id === r.badge_id);
      if (!def) return null;
      return { badge_id: r.badge_id, earned_at: r.earned_at, name: def.name, icon: def.icon };
    }).filter(Boolean);

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
      badges: badgeRows.map((r) => ({
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
    const x = Number(req.params.x), y = Number(req.params.y), z = Number(req.params.z);
    if (y < 1) return res.json(null);
    const { rows } = await pool.query(
      `SELECT b.updated_by_username, b.updated_at,
              bm.author_user_id, bm.hidden_at,
              bm.found_at, bm.found_by_username
       FROM blocks b
       LEFT JOIN block_messages bm ON bm.x = b.x AND bm.y = b.y AND bm.z = b.z
       WHERE b.x = $1 AND b.y = $2 AND b.z = $3 AND b.block_type <> 0`,
      [x, y, z]
    );
    if (!rows.length || !rows[0].updated_by_username) return res.json(null);
    const row = rows[0];
    const result = { username: row.updated_by_username, updated_at: row.updated_at };
    if (row.author_user_id !== null && row.author_user_id !== undefined) {
      if (Number(row.author_user_id) === req.user.id) {
        result.ownMessage = row.found_at
          ? { found: true, found_by_username: row.found_by_username, found_at: row.found_at, hidden_at: row.hidden_at }
          : { found: false, hidden_at: row.hidden_at };
      } else if (!row.found_at) {
        result.hasMessage = true;
      }
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Block message reveal: claim the hidden message in a block ----
app.post('/api/block/:x/:y/:z/reveal', async (req, res) => {
  try {
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    const z = Number(req.params.z);

    const blockRes = await pool.query(
      `SELECT 1 FROM blocks WHERE x = $1 AND y = $2 AND z = $3 AND block_type <> 0`,
      [x, y, z]
    );
    if (!blockRes.rows.length) return res.status(404).json({ error: 'No block at this position' });

    const msgRes = await pool.query(
      `SELECT author_user_id, author_username, body, hidden_at
       FROM block_messages WHERE x = $1 AND y = $2 AND z = $3 AND found_at IS NULL`,
      [x, y, z]
    );
    if (!msgRes.rows.length) return res.status(404).json({ error: 'No hidden message here' });

    if (Number(msgRes.rows[0].author_user_id) === req.user.id) {
      return res.status(403).json({ error: 'Cannot reveal your own message' });
    }

    const updateRes = await pool.query(
      `UPDATE block_messages
       SET found_by_user_id = $4, found_by_username = $5, found_at = NOW()
       WHERE x = $1 AND y = $2 AND z = $3 AND found_at IS NULL
       RETURNING body, author_username, hidden_at, found_by_username, found_at`,
      [x, y, z, req.user.id, req.user.username]
    );
    if (!updateRes.rows.length) return res.status(404).json({ error: 'Message already found' });

    const r = updateRes.rows[0];
    res.json({
      body: r.body,
      author_username: r.author_username,
      hidden_at: r.hidden_at,
      found_by_username: r.found_by_username,
      found_at: r.found_at,
    });
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
      `INSERT INTO player_coins (user_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         balance = player_coins.balance + $2,
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
       WHERE user_id = $1 AND badge_id = 'daily_devotee'`,
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

// ---- Daily Mission: today's mission definition and the requesting user's progress. ----
app.get('/api/mission/today', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const mission = dailyMission(now);

    const progressRes = await pool.query(
      `SELECT progress, completed_at FROM daily_mission_progress WHERE mission_date = $1 AND user_id = $2`,
      [dateStr, req.user.id]
    );
    const row = progressRes.rows[0];

    const streakRes = await pool.query(
      `SELECT current_streak, longest_streak FROM mission_streaks WHERE user_id = $1`,
      [req.user.id]
    );
    const streakRow = streakRes.rows[0];

    res.json({
      date: dateStr,
      type: mission.type,
      label: mission.label,
      target: mission.target,
      ...(mission.blockType ? { blockType: mission.blockType } : {}),
      progress: row ? Number(row.progress) : 0,
      completed_at: row ? row.completed_at : null,
      mission_streak: streakRow
        ? { current: streakRow.current_streak, longest: streakRow.longest_streak }
        : { current: 0, longest: 0 },
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

// ---- Wager Matches: send a challenge ----
app.post('/api/matches/challenge', async (req, res) => {
  try {
    const { opponent_username, wager_amount } = req.body;
    const wager = Number(wager_amount);
    const opponentLower = opponent_username?.toLowerCase();

    if (!opponent_username || !Number.isInteger(wager) || wager < 1) {
      return res.status(400).json({ error: 'Invalid opponent_username or wager_amount' });
    }

    if (opponentLower === req.user.username.toLowerCase()) {
      return res.status(400).json({ error: 'Cannot challenge yourself' });
    }

    // Find opponent by username (case-insensitive)
    const opponentRes = await pool.query(
      `SELECT user_id, username FROM leaderboard WHERE LOWER(username) = $1 LIMIT 1`,
      [opponentLower]
    );
    if (!opponentRes.rows.length) {
      return res.status(404).json({ error: 'Opponent not found' });
    }
    const opponent = opponentRes.rows[0];

    // Check challenger has enough coins
    const coinsRes = await pool.query(
      `SELECT balance FROM player_coins WHERE user_id = $1`,
      [req.user.id]
    );
    const coins = coinsRes.rows.length ? Number(coinsRes.rows[0].balance) : 0;
    if (coins < wager) {
      return res.status(400).json({ error: 'Insufficient coins' });
    }

    // Check for existing active/pending match
    const existingRes = await pool.query(
      `SELECT id FROM wager_matches
       WHERE ((challenger_id = $1 AND opponent_id = $2) OR (challenger_id = $2 AND opponent_id = $1))
       AND status IN ('pending', 'accepted')`,
      [req.user.id, opponent.user_id]
    );
    if (existingRes.rows.length) {
      return res.status(400).json({ error: 'Active or pending match already exists with this opponent' });
    }

    // Deduct coins immediately (reservation)
    await pool.query(
      `UPDATE player_coins SET balance = balance - $1 WHERE user_id = $2`,
      [wager, req.user.id]
    );

    // Create match
    const matchRes = await pool.query(
      `INSERT INTO wager_matches
       (challenger_id, challenger_username, opponent_id, opponent_username, wager_amount, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id, status`,
      [req.user.id, req.user.username, opponent.user_id, opponent.username, wager]
    );

    res.json({ ok: true, match_id: matchRes.rows[0].id, status: matchRes.rows[0].status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Coins: current player's balance ----
app.get('/api/coins', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT balance FROM player_coins WHERE user_id = $1`,
      [req.user.id]
    );
    res.json({ balance: rows.length ? Number(rows[0].balance) : 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Wager Matches: accept a challenge ----
app.post('/api/matches/:match_id/accept', async (req, res) => {
  try {
    const matchId = Number(req.params.match_id);

    // Fetch match
    const matchRes = await pool.query(
      `SELECT * FROM wager_matches WHERE id = $1`,
      [matchId]
    );
    if (!matchRes.rows.length) {
      return res.status(404).json({ error: 'Match not found' });
    }
    const match = matchRes.rows[0];

    if (match.opponent_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the opponent can accept this match' });
    }
    if (match.status !== 'pending') {
      return res.status(400).json({ error: 'Match is not pending' });
    }

    // Check if match has expired
    if (new Date(match.expires_at) < new Date()) {
      // Auto-decline and refund
      await pool.query(
        `UPDATE wager_matches SET status = 'expired' WHERE id = $1`,
        [matchId]
      );
      await pool.query(
        `UPDATE player_coins SET balance = balance + $1 WHERE user_id = $2`,
        [match.wager_amount, match.challenger_id]
      );
      return res.status(400).json({ error: 'Match has expired' });
    }

    // Re-check opponent has enough coins
    const coinsRes = await pool.query(
      `SELECT balance FROM player_coins WHERE user_id = $1`,
      [req.user.id]
    );
    const coins = coinsRes.rows.length ? Number(coinsRes.rows[0].balance) : 0;
    if (coins < match.wager_amount) {
      return res.status(400).json({ error: 'Insufficient coins to accept this match' });
    }

    // Deduct coins from opponent
    await pool.query(
      `UPDATE player_coins SET balance = balance - $1 WHERE user_id = $2`,
      [match.wager_amount, req.user.id]
    );

    // Update match status
    await pool.query(
      `UPDATE wager_matches SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
      [matchId]
    );

    res.json({ ok: true, status: 'accepted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Wager Matches: decline a challenge ----
app.post('/api/matches/:match_id/decline', async (req, res) => {
  try {
    const matchId = Number(req.params.match_id);

    const matchRes = await pool.query(
      `SELECT * FROM wager_matches WHERE id = $1`,
      [matchId]
    );
    if (!matchRes.rows.length) {
      return res.status(404).json({ error: 'Match not found' });
    }
    const match = matchRes.rows[0];

    if (match.opponent_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the opponent can decline this match' });
    }
    if (match.status !== 'pending') {
      return res.status(400).json({ error: 'Match is not pending' });
    }

    // Update match status
    await pool.query(
      `UPDATE wager_matches SET status = 'declined' WHERE id = $1`,
      [matchId]
    );

    // Refund challenger coins
    await pool.query(
      `UPDATE player_coins SET balance = balance + $1 WHERE user_id = $2`,
      [match.wager_amount, match.challenger_id]
    );

    res.json({ ok: true, status: 'declined' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Wager Matches: submit score ----
app.post('/api/matches/:match_id/submit-score', async (req, res) => {
  try {
    const matchId = Number(req.params.match_id);
    const score = Number(req.body.score);

    if (!Number.isInteger(score) || score < 0) {
      return res.status(400).json({ error: 'Invalid score' });
    }

    const matchRes = await pool.query(
      `SELECT * FROM wager_matches WHERE id = $1`,
      [matchId]
    );
    if (!matchRes.rows.length) {
      return res.status(404).json({ error: 'Match not found' });
    }
    const match = matchRes.rows[0];

    if (match.status !== 'accepted') {
      return res.status(400).json({ error: 'Match is not accepted' });
    }

    let isChallenger = match.challenger_id === req.user.id;
    let isOpponent = match.opponent_id === req.user.id;
    if (!isChallenger && !isOpponent) {
      return res.status(403).json({ error: 'You are not part of this match' });
    }

    // Check if user already submitted
    if (isChallenger && match.challenger_score !== null) {
      return res.status(400).json({ error: 'You have already submitted your score' });
    }
    if (isOpponent && match.opponent_score !== null) {
      return res.status(400).json({ error: 'You have already submitted your score' });
    }

    // Record score
    let updateCol = isChallenger ? 'challenger_score' : 'opponent_score';
    await pool.query(
      `UPDATE wager_matches SET ${updateCol} = $1 WHERE id = $2`,
      [score, matchId]
    );

    // Re-fetch match to check if both scores are now recorded
    const updatedRes = await pool.query(
      `SELECT * FROM wager_matches WHERE id = $1`,
      [matchId]
    );
    const updated = updatedRes.rows[0];

    let completed = false;
    let winner_id = null;

    if (updated.challenger_score !== null && updated.opponent_score !== null) {
      completed = true;
      // Determine winner
      if (updated.challenger_score > updated.opponent_score) {
        winner_id = updated.challenger_id;
      } else if (updated.opponent_score > updated.challenger_score) {
        winner_id = updated.opponent_id;
      }
      // On tie, winner_id stays null

      // Update match with winner and completion time
      await pool.query(
        `UPDATE wager_matches SET winner_id = $1, completed_at = NOW() WHERE id = $2`,
        [winner_id, matchId]
      );

      // Settle coins
      if (winner_id !== null) {
        // Winner gets wager pool
        await pool.query(
          `UPDATE player_coins SET balance = balance + $1 WHERE user_id = $2`,
          [updated.wager_amount * 2, winner_id]
        );
      } else {
        // Tie: refund both players
        await pool.query(
          `UPDATE player_coins SET balance = balance + $1 WHERE user_id = $2`,
          [updated.wager_amount, updated.challenger_id]
        );
        await pool.query(
          `UPDATE player_coins SET balance = balance + $1 WHERE user_id = $2`,
          [updated.wager_amount, updated.opponent_id]
        );
      }
    }

    res.json({
      ok: true,
      challenger_score: updated.challenger_score,
      opponent_score: updated.opponent_score,
      winner_id: winner_id,
      completed: completed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Wager Matches: get pending challenges (inbox) ----
app.get('/api/matches/pending', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, challenger_username, wager_amount, created_at
       FROM wager_matches
       WHERE opponent_id = $1 AND status = 'pending' AND expires_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({ pending_challenges: rows.map((r) => ({ ...r, wager_amount: Number(r.wager_amount) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Wager Matches: get current active match ----
app.get('/api/matches/active', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, challenger_id, challenger_username, opponent_id, opponent_username, wager_amount, status, challenger_score, opponent_score
       FROM wager_matches
       WHERE (challenger_id = $1 OR opponent_id = $1) AND status = 'accepted'
       LIMIT 1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.json({ active_match: null });
    }
    const m = rows[0];
    const opponent_username = m.challenger_id === req.user.id ? m.opponent_username : m.challenger_username;
    const opponent_id = m.challenger_id === req.user.id ? m.opponent_id : m.challenger_id;
    const my_score_submitted = m.challenger_id === req.user.id ? m.challenger_score !== null : m.opponent_score !== null;

    res.json({
      active_match: {
        id: m.id,
        opponent_username,
        opponent_id,
        wager_amount: Number(m.wager_amount),
        status: m.status,
        challenger_score: m.challenger_score,
        opponent_score: m.opponent_score,
        my_score_submitted,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Wager Matches: get match history ----
app.get('/api/matches/history', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;

    const { rows } = await pool.query(
      `SELECT id, challenger_id, challenger_username, opponent_id, opponent_username, wager_amount, challenger_score, opponent_score, winner_id, completed_at
       FROM wager_matches
       WHERE (challenger_id = $1 OR opponent_id = $1) AND status = 'completed'
       ORDER BY completed_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );

    const matches = rows.map((r) => {
      const is_challenger = r.challenger_id === req.user.id;
      const opponent_username = is_challenger ? r.opponent_username : r.challenger_username;
      const my_score = is_challenger ? r.challenger_score : r.opponent_score;
      const opponent_score = is_challenger ? r.opponent_score : r.challenger_score;
      const result = r.winner_id === null ? 'tie' : (r.winner_id === req.user.id ? 'won' : 'lost');

      return {
        id: r.id,
        opponent_username,
        wager_amount: Number(r.wager_amount),
        my_score,
        opponent_score,
        result,
        completed_at: r.completed_at,
      };
    });

    res.json({ matches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Wager: place a bet before a Time Attack round ----
app.post('/api/wager', async (req, res) => {
  try {
    const bet_amount = Number(req.body.bet_amount);
    const tier = req.body.tier;

    if (!WAGER_TIERS[tier]) return res.status(400).json({ error: 'invalid tier' });
    if (!Number.isInteger(bet_amount) || bet_amount < 5 || bet_amount > 100) {
      return res.status(400).json({ error: 'bet_amount must be between 5 and 100' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // One pending wager at a time.
      const pendingCheck = await client.query(
        `SELECT id FROM wager_history WHERE user_id = $1 AND outcome = 'pending'`,
        [req.user.id]
      );
      if (pendingCheck.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'pending wager already exists' });
      }

      // Ensure a coin row exists (0-balance placeholder) before deducting.
      await client.query(
        `INSERT INTO player_coins (user_id, username, balance, updated_at)
         VALUES ($1, $2, 0, NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [req.user.id, req.user.username]
      );

      // Atomic deduct — WHERE balance >= bet guards against overspending.
      const deductRes = await client.query(
        `UPDATE player_coins SET
           balance    = balance - $1,
           username   = $2,
           updated_at = NOW()
         WHERE user_id = $3 AND balance >= $1
         RETURNING balance`,
        [bet_amount, req.user.username, req.user.id]
      );
      if (!deductRes.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'insufficient coins' });
      }
      const newBalance = Number(deductRes.rows[0].balance);

      const td = WAGER_TIERS[tier];
      const { rows } = await client.query(
        `INSERT INTO wager_history
           (user_id, username, bet_amount, tier, target_blocks, payout_multiplier)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [req.user.id, req.user.username, bet_amount, tier, td.target, td.multiplier]
      );

      await client.query('COMMIT');
      res.json({ wager_id: Number(rows[0].id), balance: newBalance });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Time Attack result: resolve a pending wager ----
app.post('/api/timeattack/result', async (req, res) => {
  try {
    const wager_id    = Number(req.body.wager_id);
    const final_blocks = Number(req.body.final_blocks);

    if (!Number.isInteger(wager_id) || wager_id <= 0) {
      return res.status(400).json({ error: 'invalid wager_id' });
    }
    // Cap at 150 — the TA layout scatters exactly 150 blocks.
    if (!Number.isInteger(final_blocks) || final_blocks < 0 || final_blocks > 150) {
      return res.status(400).json({ error: 'invalid final_blocks' });
    }

    const wagerRes = await pool.query(
      `SELECT id, user_id, bet_amount, tier, target_blocks, payout_multiplier, outcome, payout
       FROM wager_history WHERE id = $1`,
      [wager_id]
    );
    if (!wagerRes.rows.length) return res.status(404).json({ error: 'wager not found' });

    const wager = wagerRes.rows[0];
    if (Number(wager.user_id) !== req.user.id) {
      return res.status(403).json({ error: 'not your wager' });
    }

    // Already resolved — return existing outcome (idempotent retry).
    if (wager.outcome !== 'pending') {
      const balRes = await pool.query(
        `SELECT balance FROM player_coins WHERE user_id = $1`, [req.user.id]
      );
      return res.json({
        outcome: wager.outcome,
        payout:  Number(wager.payout),
        balance: balRes.rows.length ? Number(balRes.rows[0].balance) : 0,
      });
    }

    const won    = final_blocks >= Number(wager.target_blocks);
    const payout = won ? Math.round(Number(wager.bet_amount) * Number(wager.payout_multiplier)) : 0;
    const outcome = won ? 'won' : 'lost';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE wager_history SET
           outcome = $1, payout = $2, final_blocks = $3, resolved_at = NOW()
         WHERE id = $4`,
        [outcome, payout, final_blocks, wager_id]
      );

      let newBalance;
      if (won) {
        const balRes = await client.query(
          `UPDATE player_coins SET balance = balance + $1, updated_at = NOW()
           WHERE user_id = $2
           RETURNING balance`,
          [payout, req.user.id]
        );
        newBalance = Number(balRes.rows[0].balance);
      } else {
        const balRes = await client.query(
          `SELECT balance FROM player_coins WHERE user_id = $1`, [req.user.id]
        );
        newBalance = balRes.rows.length ? Number(balRes.rows[0].balance) : 0;
      }

      await client.query('COMMIT');
      res.json({ outcome, payout, balance: newBalance });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

// ---- AI Placement Hints ----
const CANNED_HINT = { x: 16, y: 4, z: 16, reason: 'Building upward near the center is a great way to start a combo chain.' };

async function checkHintCell(x, y, z) {
  if (x < 0 || x > 31 || y < 1 || y > 23 || z < 0 || z > 31) return false;
  const occupied = await pool.query(
    'SELECT 1 FROM blocks WHERE x=$1 AND y=$2 AND z=$3 AND block_type != 0 LIMIT 1',
    [x, y, z]
  );
  if (occupied.rows.length > 0) return false;
  const neighbors = [[x-1,y,z],[x+1,y,z],[x,y-1,z],[x,y+1,z],[x,y,z-1],[x,y,z+1]];
  for (const [nx, ny, nz] of neighbors) {
    if (ny === 0) return true; // immovable grass ground always present
    if (nx < 0 || nx > 31 || ny < 0 || ny > 23 || nz < 0 || nz > 31) continue;
    const r = await pool.query(
      'SELECT 1 FROM blocks WHERE x=$1 AND y=$2 AND z=$3 AND block_type != 0 LIMIT 1',
      [nx, ny, nz]
    );
    if (r.rows.length > 0) return true;
  }
  return false;
}

app.post('/api/hint', async (req, res) => {
  const { selected_type_name, selected_type_points, player_pos, combo_tier, session_score, nearby_blocks } = req.body || {};

  if (!LLM_ENABLED) {
    try {
      const { x: cx, y: cy, z: cz, reason } = CANNED_HINT;
      if (await checkHintCell(cx, cy, cz)) return res.json({ x: cx, y: cy, z: cz, reason });
      for (let dx = 0; dx <= 3; dx++) {
        for (let dz = 0; dz <= 3; dz++) {
          for (let dy = 1; dy <= 10; dy++) {
            const nx = Math.min(31, cx + dx), nz = Math.min(31, cz + dz);
            if (await checkHintCell(nx, dy, nz)) return res.json({ x: nx, y: dy, z: nz, reason });
          }
        }
      }
    } catch (_) {}
    return res.status(500).json({ error: 'unavailable' });
  }

  const px = Math.floor(Number(player_pos?.x) || 0);
  const py = Math.floor(Number(player_pos?.y) || 0);
  const pz = Math.floor(Number(player_pos?.z) || 0);
  const nearbyStr = (Array.isArray(nearby_blocks) ? nearby_blocks : []).slice(0, 80)
    .map(b => `(${b.x},${b.y},${b.z}:${b.name})`).join(' ');

  const userMsg = [
    `Player at (${px},${py},${pz})`,
    `Holding: ${selected_type_name || 'block'} (${selected_type_points || 1} pt)`,
    `Combo tier: ${combo_tier || 1}`,
    `Session score: ${session_score || 0}`,
    `Nearby occupied cells (≤5 units): ${nearbyStr || 'none'}`,
    `Bounds: 0≤x≤31, 1≤y≤23, 0≤z≤31. y=0 is immovable ground.`,
    `Reply ONLY as JSON: {"x":<int>,"y":<int>,"z":<int>,"reason":"<one sentence>"}`,
  ].join('\n');

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
        max_tokens: 80,
        system: "You are a placement advisor for block-game, a 3D builder. Suggest ONE interesting cell for the player's next block — extend a structure, stack for height, or cluster for combos. Reply ONLY as JSON: {\"x\":<int>,\"y\":<int>,\"z\":<int>,\"reason\":\"<one sentence>\"}. The cell MUST be empty and 6-face-adjacent to an occupied cell or y=0 ground. No other text.",
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (resp.status === 403) {
      const body = await resp.json().catch(() => ({}));
      if (body.code === 'grant_required') return res.status(403).json({ error: 'grant_required' });
    }
    if (resp.status === 429) return res.status(429).json({ error: 'unavailable' });
    if (!resp.ok) return res.status(500).json({ error: 'unavailable' });

    const llmData = await resp.json();
    const raw = (llmData?.content?.[0]?.text || '').trim();
    if (!raw) return res.status(500).json({ error: 'unavailable' });

    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
      const m = raw.match(/\{[^}]+\}/);
      if (!m) return res.status(500).json({ error: 'unavailable' });
      try { parsed = JSON.parse(m[0]); } catch (_) { return res.status(500).json({ error: 'unavailable' }); }
    }

    const hx = Math.round(Number(parsed.x)), hy = Math.round(Number(parsed.y)), hz = Math.round(Number(parsed.z));
    const reason = String(parsed.reason || '').trim();
    if (!reason || isNaN(hx) || isNaN(hy) || isNaN(hz)) return res.status(500).json({ error: 'unavailable' });
    if (!await checkHintCell(hx, hy, hz)) return res.status(500).json({ error: 'unavailable' });
    return res.json({ x: hx, y: hy, z: hz, reason });
  } catch (err) {
    console.error('hint error', err.message);
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

// ---- Daily Prompt: today's prompt + eligible builders + vote state ----
app.get('/api/prompt/today', async (req, res) => {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const prompt = dailyPrompt(now);

    const yesterday = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1
    ));
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const [yesterdayRes, myVoteRes, buildersRes] = await Promise.all([
      pool.query(
        `SELECT voted_for_username, COUNT(*)::int AS vote_count
         FROM daily_prompt_votes
         WHERE vote_date = $1
         GROUP BY voted_for_user_id, voted_for_username
         ORDER BY vote_count DESC
         LIMIT 1`,
        [yesterdayStr]
      ),
      pool.query(
        `SELECT voted_for_user_id, voted_for_username
         FROM daily_prompt_votes
         WHERE vote_date = $1 AND voter_user_id = $2`,
        [dateStr, req.user.id]
      ),
      pool.query(
        `SELECT dcp.user_id, dcp.username,
                COALESCE(v.vote_count, 0) AS vote_count
         FROM daily_challenge_progress dcp
         LEFT JOIN (
           SELECT voted_for_user_id, COUNT(*)::int AS vote_count
           FROM daily_prompt_votes
           WHERE vote_date = $1
           GROUP BY voted_for_user_id
         ) v ON dcp.user_id = v.voted_for_user_id
         WHERE dcp.challenge_date = $1
           AND dcp.blocks_placed >= 1
           AND dcp.user_id <> $2
         ORDER BY vote_count DESC, dcp.username ASC`,
        [dateStr, SEED_USER_ID]
      ),
    ]);

    const yesterdayWinner = yesterdayRes.rows.length
      ? { username: yesterdayRes.rows[0].voted_for_username, vote_count: yesterdayRes.rows[0].vote_count }
      : null;

    const myVote = myVoteRes.rows.length
      ? { voted_for_user_id: myVoteRes.rows[0].voted_for_user_id, voted_for_username: myVoteRes.rows[0].voted_for_username }
      : null;

    res.json({
      date: dateStr,
      prompt,
      my_vote: myVote,
      eligible_builders: buildersRes.rows.map((r) => ({
        user_id: r.user_id,
        username: r.username,
        vote_count: Number(r.vote_count),
        is_self: r.user_id === req.user.id,
      })),
      yesterday_winner: yesterdayWinner,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Share Score API ----
app.post('/api/share-score', async (req, res) => {
  try {
    const { mode, score_data } = req.body;
    const username = req.user.username;

    if (!mode || !score_data) {
      return res.status(400).json({ error: 'Missing mode or score_data' });
    }

    // Build message template based on mode
    let message = '';
    switch (mode) {
      case 'timeattack':
        message = `${username} cleared ${score_data.blocks_cleared} blocks in Time Attack difficulty ${score_data.difficulty_level}! ⏱️`;
        break;
      case 'time-attack-60':
        message = `${username} cleared ${score_data.blocks_cleared} blocks in 60-second Time Attack mode! ⏱️`;
        break;
      case 'endless':
        message = `${username} placed ${score_data.blocks_placed} blocks and survived ${score_data.moves_survived} moves in Endless mode! 🎮`;
        break;
      case 'daily-challenge':
        message = `${username} completed today's Daily Challenge (placed ${score_data.blocks_placed}/${score_data.target_blocks} blocks)! 🔥`;
        break;
      case 'versus':
        message = `${username} cleared ${score_data.blocks_cleared} blocks in Versus Mode! ⚔️`;
        break;
      default:
        return res.status(400).json({ error: 'Invalid mode' });
    }

    // Return the message for the frontend to use with Twitter intent and/or Usernode feed
    res.json({
      message,
      mode,
      twitter_url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(message)}&url=${encodeURIComponent('https://social-vibecoding.usernodelabs.org/app/block-game')}`
    });
  } catch (err) {
    console.error('share-score error', err.message);
    res.status(500).json({ error: 'Failed to generate share message' });
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

// ---- Daily Prompt: cast or change a vote ----
app.post('/api/prompt/vote', async (req, res) => {
  try {
    const voted_for_user_id = Number(req.body.voted_for_user_id);
    const voted_for_username = (typeof req.body.voted_for_username === 'string'
      ? req.body.voted_for_username : '').trim();

    if (!voted_for_user_id || !voted_for_username) {
      return res.status(400).json({ error: 'voted_for_user_id and voted_for_username are required' });
    }
    if (voted_for_user_id === req.user.id) {
      return res.status(400).json({ error: 'Cannot vote for yourself' });
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);

    const eligRes = await pool.query(
      `SELECT 1 FROM daily_challenge_progress
       WHERE challenge_date = $1 AND user_id = $2 AND blocks_placed >= 1`,
      [dateStr, voted_for_user_id]
    );
    if (!eligRes.rows.length) {
      return res.status(400).json({ error: 'That player has not built anything today' });
    }

    await pool.query(
      `INSERT INTO daily_prompt_votes
         (vote_date, voter_user_id, voter_username, voted_for_user_id, voted_for_username, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (vote_date, voter_user_id) DO UPDATE SET
         voted_for_user_id   = EXCLUDED.voted_for_user_id,
         voted_for_username  = EXCLUDED.voted_for_username,
         created_at          = NOW()`,
      [dateStr, req.user.id, req.user.username, voted_for_user_id, voted_for_username]
    );
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

  const fakeScores = [
    { id: -1, username: 'Staging demo Alice', total_score: 5200, blocks_placed: 520, best_combo: 4, ta: 42 },
    { id: -2, username: 'Staging demo Bob',   total_score: 980,  blocks_placed: 210, best_combo: 3, ta: 31 },
    { id: -3, username: 'Staging demo Carol', total_score: 720,  blocks_placed: 180, best_combo: 2, ta: 15 },
    { id: -4, username: 'Staging demo Dave',  total_score: 440,  blocks_placed:  95, best_combo: 1, ta: 0  },
    { id: -5, username: 'Staging demo Eve',   total_score: 115,  blocks_placed:  30, best_combo: 1, ta: 0  },
  ];
  for (const s of fakeScores) {
    await pool.query(
      `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, best_time_attack_score, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id) DO UPDATE SET best_time_attack_score = GREATEST(leaderboard.best_time_attack_score, EXCLUDED.best_time_attack_score)`,
      [s.id, s.username, s.total_score, s.blocks_placed, s.best_combo, s.ta]
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
    // Alice: badges with varied earned times (leading player)
    { userId: -1, badgeId: 'first_block', daysAgo: 10 },
    { userId: -1, badgeId: 'builder', daysAgo: 9 },
    { userId: -1, badgeId: 'architect', daysAgo: 8 },
    { userId: -1, badgeId: 'high_scorer', daysAgo: 7 },
    { userId: -1, badgeId: 'comboist', daysAgo: 5 },
    { userId: -1, badgeId: 'golden_touch', daysAgo: 4 },
    { userId: -1, badgeId: 'material_artist', daysAgo: 3 },
    { userId: -1, badgeId: 'crystal_placer', daysAgo: 2 },
    { userId: -1, badgeId: 'master_comboist', daysAgo: 2 },
    { userId: -1, badgeId: 'overachiever', daysAgo: 1 },
    { userId: -1, badgeId: 'legendary_builder', daysAgo: 1 },
    { userId: -1, badgeId: 'daily_devotee', daysAgo: 1 },
    // Bob: badges (second player)
    { userId: -2, badgeId: 'first_block', daysAgo: 8 },
    { userId: -2, badgeId: 'builder', daysAgo: 6 },
    { userId: -2, badgeId: 'rainbow_placer', daysAgo: 5 },
    { userId: -2, badgeId: 'comboist', daysAgo: 3 },
    { userId: -2, badgeId: 'daily_regular', daysAgo: 2 },
    { userId: -2, badgeId: 'speed_demon', daysAgo: 1 },
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

  // Daily challenge progress seed: personas at different completion states so
  // both in-progress and complete widget/leaderboard states can be verified.
  // Carol (-3) completed 45 min ago (ranked #1), Bob (-2) just now (#2), Alice in-progress.
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const targetToday = dailyTarget(now);
  await pool.query(
    `INSERT INTO daily_challenge_progress
       (challenge_date, user_id, username, blocks_placed, completed_at, updated_at)
     VALUES
       ($1,  0, 'Staging demo',        5,  NULL, NOW()),
       ($1, -1, 'Staging demo Alice',  38, NULL, NOW()),
       ($1, -2, 'Staging demo Bob',    $2, NOW() - INTERVAL '5 minutes',  NOW()),
       ($1, -3, 'Staging demo Carol',  $2, NOW() - INTERVAL '45 minutes', NOW())
     ON CONFLICT (challenge_date, user_id) DO NOTHING`,
    [todayStr, targetToday]
  );
  // Also seed 5 prior daily completions for alice (-1) to unlock the daily_regular badge display.
  for (let d = 1; d <= 5; d++) {
    const priorDate = new Date(now.getTime() - d * 86400000).toISOString().slice(0, 10);
    const priorTarget = dailyTarget(new Date(now.getTime() - d * 86400000));
    await pool.query(
      `INSERT INTO daily_challenge_progress (challenge_date, user_id, username, blocks_placed, completed_at, updated_at)
       VALUES ($1, -1, 'Staging demo Alice', $2, NOW() - INTERVAL '1 hour', NOW())
       ON CONFLICT (challenge_date, user_id) DO NOTHING`,
      [priorDate, priorTarget]
    );
  }

  // Seed daily_mission_progress for three personas: partial, completed, not started.
  const missionToday = dailyMission(now);
  await pool.query(
    `INSERT INTO daily_mission_progress
       (mission_date, user_id, username, mission_type, progress, target, completed_at, updated_at)
     VALUES
       ($1, -1, 'alice_builder', $2, $3, $4, NULL,                          NOW()),
       ($1, -2, 'reza99',        $2, $4, $4, NOW() - INTERVAL '2 hours',    NOW())
     ON CONFLICT (mission_date, user_id) DO NOTHING`,
    [todayStr, missionToday.type, Math.floor(missionToday.target * 0.6), missionToday.target]
  );

  // Seed mission_streaks for staging personas.
  await pool.query(
    `INSERT INTO mission_streaks (user_id, username, last_completed_date, current_streak, longest_streak)
     VALUES
       (-1, 'alice_builder', CURRENT_DATE - 1, 3,  7),
       (-2, 'reza99',        CURRENT_DATE,     7, 14)
     ON CONFLICT (user_id) DO NOTHING`
  );

  // Seed mission badges so the badges panel shows the new entries.
  const missionBadgeSeed = [
    { userId: -1, badgeId: 'mission_complete' },
    { userId: -1, badgeId: 'mission_streak_3' },
    { userId: -2, badgeId: 'mission_complete' },
    { userId: -2, badgeId: 'mission_streak_3' },
    { userId: -2, badgeId: 'mission_streak_7' },
  ];
  for (const b of missionBadgeSeed) {
    await pool.query(
      `INSERT INTO player_badges (user_id, badge_id, earned_at)
       VALUES ($1, $2, NOW() - INTERVAL '1 day')
       ON CONFLICT DO NOTHING`,
      [b.userId, b.badgeId]
    );
  }

  // Seed monument rows for staging so the leaderboard tab and 3D beacons
  // are visible immediately without waiting for live block thresholds.
  await pool.query(`
    INSERT INTO monuments (sector_x, sector_z, name, block_count, contributor_count, crowned_at, updated_at) VALUES
      (12, 12, 'Stone Monument', 47, 3, NOW() - INTERVAL '2 days', NOW()),
      (20, 20, 'Leaf Monument',  19, 3, NOW() - INTERVAL '1 day',  NOW()),
      ( 0,  0, 'Grass Monument', 32, 4, NOW() - INTERVAL '3 days', NOW())
    ON CONFLICT (sector_x, sector_z) DO NOTHING
  `);

  // BlockBot leaderboard entry — placed mid-table so it's clearly visible.
  await pool.query(
    `INSERT INTO leaderboard (user_id, username, total_score, blocks_placed, best_combo, updated_at)
     VALUES ($1, $2, 720, 160, 3, NOW())
     ON CONFLICT (user_id) DO NOTHING`,
    [AI_USER_ID, AI_USERNAME]
  );

  // BlockBot tournament entry for the current week.
  const botNow = new Date();
  await pool.query(
    `INSERT INTO tournament_scores (week_start, user_id, username, score, blocks_placed, updated_at)
     VALUES ($1, $2, $3, 210, 50, NOW())
     ON CONFLICT (week_start, user_id) DO NOTHING`,
    [weekStart(botNow), AI_USER_ID, AI_USERNAME]
  );

  // BlockBot world blocks — scattered in the open area at x 9–13, z 1–4, y=1
  // (clear of alice/bob/charlie/dave patches at x 1–8, z 1–12).
  const botBlocks = [
    { x: 9,  z: 1, t: 1  }, { x: 10, z: 1, t: 15 }, { x: 11, z: 1, t: 17 },
    { x: 12, z: 1, t: 1  }, { x: 13, z: 1, t: 15 },
    { x: 9,  z: 2, t: 3  }, { x: 10, z: 2, t: 1  }, { x: 11, z: 2, t: 15 },
    { x: 12, z: 2, t: 17 }, { x: 13, z: 2, t: 1  },
    { x: 9,  z: 3, t: 17 }, { x: 10, z: 3, t: 3  }, { x: 11, z: 3, t: 1  },
    { x: 12, z: 3, t: 15 }, { x: 13, z: 3, t: 3  },
    { x: 9,  z: 4, t: 1  }, { x: 10, z: 4, t: 17 }, { x: 11, z: 4, t: 3  },
    { x: 12, z: 4, t: 1  }, { x: 13, z: 4, t: 15 },
  ];
  for (const b of botBlocks) {
    await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, seq, updated_by_user_id, updated_by_username, updated_at)
       VALUES ($1, 1, $2, $3, nextval('block_seq'), $4, $5, NOW())
       ON CONFLICT (x, y, z) DO NOTHING`,
      [b.x, b.z, b.t, AI_USER_ID, AI_USERNAME]
    );
  }

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

  // Seed a nearly-complete y=5 layer containing Bomb blocks for testing the
  // bomb explosion mechanic. 1023 of 1024 cells are filled (4 Bomb + 1019 Stone);
  // one cell is left empty so a tester can place a single block to trigger a clear.
  const { rows: bombRowCount } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM blocks WHERE y = 5 AND block_type <> 0`
  );
  if (Number(bombRowCount[0].count) < 1023) {
    const bombCells = new Set(['8,5,8', '16,5,16', '24,5,8', '8,5,24']);
    const skipCell = '31,5,31'; // leave this cell empty for the tester to fill
    const bombRowBlocks = [];
    for (let bx = 0; bx < 32; bx++) {
      for (let bz = 0; bz < 32; bz++) {
        const cellKey = `${bx},5,${bz}`;
        if (cellKey === skipCell) continue;
        const blockType = bombCells.has(cellKey) ? 27 : 3;
        bombRowBlocks.push(`(${bx}, 5, ${bz}, ${blockType}, ${SEED_USER_ID}, 'Staging demo')`);
      }
    }
    await pool.query(
      `INSERT INTO blocks (x, y, z, block_type, updated_by_user_id, updated_by_username) VALUES
       ${bombRowBlocks.join(',')}
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

// ---- AI opponent loop ----
// Runs entirely server-side after the server starts listening. Two intervals:
//   1. Placement: pick a random empty cell at y 1-3 and place a random block.
//   2. Presence: keep BlockBot visible in the online list (expires after 60s).
function startAiLoop() {
  const PALETTE_IDS = PALETTE.map((p) => p.id);

  async function pingPresence() {
    try {
      await pool.query(
        `INSERT INTO user_presence (user_id, username, last_seen, mode)
         VALUES ($1, $2, NOW(), 'classic')
         ON CONFLICT (user_id) DO UPDATE
           SET username = EXCLUDED.username, last_seen = NOW(), mode = 'classic'`,
        [AI_USER_ID, AI_USERNAME]
      );
    } catch (err) {
      console.error('AI presence ping failed:', err.message);
    }
  }

  async function placeTick() {
    try {
      const { rows: occupied } = await pool.query(
        `SELECT x, y, z FROM blocks WHERE block_type != 0`
      );
      const occupiedSet = new Set(occupied.map((r) => `${r.x},${r.y},${r.z}`));

      let target = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const x = Math.floor(Math.random() * DIMS.w);
        const z = Math.floor(Math.random() * DIMS.d);
        for (let y = 1; y <= 3; y++) {
          if (!occupiedSet.has(`${x},${y},${z}`)) {
            target = { x, y, z };
            break;
          }
        }
        if (target) break;
      }
      if (!target) return; // all attempts collided — skip this tick

      const blockType = PALETTE_IDS[Math.floor(Math.random() * PALETTE_IDS.length)];
      await applyBlock({ userId: AI_USER_ID, username: AI_USERNAME, ...target, blockType });
    } catch (err) {
      console.error('AI placement tick failed:', err.message);
    }
  }

  pingPresence(); // immediate on boot
  setInterval(placeTick, AI_INTERVAL_MS);
  setInterval(pingPresence, 30000);
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
  ];
  for (const s of milestoneSeeds) {
    await pool.query(
      `INSERT INTO player_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [s.user_id, s.badge_id]
    );
  }
}

async function seedCoins() {
  const coinSeeds = [
    { user_id: -1, username: 'Staging demo Alice',   balance: 340, loginOffset: 1 },
    { user_id: -2, username: 'Staging demo Bob',     balance:  80, loginOffset: 0 },
    { user_id: -3, username: 'Staging demo Charlie', balance:   5, loginOffset: null },
    { user_id: -4, username: 'Staging demo Dana',    balance: 200, loginOffset: 0 },
    { user_id: -5, username: 'Staging demo Eli',     balance:  50, loginOffset: null },
    { user_id: -6, username: 'Staging demo Faye',    balance:   0, loginOffset: null },
  ];
  for (const s of coinSeeds) {
    const loginDate = s.loginOffset !== null
      ? `CURRENT_DATE - ${s.loginOffset}`
      : 'NULL';
    await pool.query(
      `INSERT INTO player_coins (user_id, username, balance, last_coin_login_date, updated_at)
       VALUES ($1, $2, $3, ${loginDate}, NOW())
       ON CONFLICT (user_id) DO NOTHING`,
      [s.user_id, s.username, s.balance]
    );
  }

  // Wager history seed — explicit IDs for idempotency
  const wagerSeeds = [
    { id: 1, user_id: -1, username: 'Staging demo Alice', bet: 100, tier: 'expert', target: 110, mult: 5.0, final: 117, outcome: 'won',     payout: 500 },
    { id: 2, user_id: -2, username: 'Staging demo Bob',   bet:  50, tier: 'hard',   target:  80, mult: 3.0, final:  62, outcome: 'lost',    payout:   0 },
    { id: 3, user_id: -4, username: 'Staging demo Dana',  bet:  25, tier: 'medium', target:  50, mult: 2.0, final:  55, outcome: 'won',     payout:  50 },
    { id: 4, user_id: -4, username: 'Staging demo Dana',  bet:  40, tier: 'easy',   target:  20, mult: 1.5, final: null, outcome: 'pending', payout: null },
  ];
  for (const w of wagerSeeds) {
    const resolvedAt = w.outcome !== 'pending' ? `NOW() - INTERVAL '2 days'` : 'NULL';
    await pool.query(
      `INSERT INTO wager_history
         (id, user_id, username, bet_amount, tier, target_blocks, payout_multiplier,
          final_blocks, outcome, payout, created_at, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               NOW() - INTERVAL '2 days', ${resolvedAt})
       ON CONFLICT (id) DO NOTHING`,
      [w.id, w.user_id, w.username, w.bet, w.tier, w.target, w.mult,
       w.final, w.outcome, w.payout]
    );
  }
  // Advance sequence past seed IDs
  await pool.query(
    `SELECT setval('wager_history_id_seq', GREATEST((SELECT MAX(id) FROM wager_history), 4))`
  );
}

async function seedPromptVotes() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterday = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1
  ));
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // Today: alice gets 2 votes (from bob and charlie), bob gets 1 (from alice).
  // Yesterday: alice wins (1 vote from bob) — surfaces as "Yesterday's winner".
  const votes = [
    { vote_date: todayStr,     voter_id: -2, voter_username: 'Staging demo Bob',     voted_for_id: -1, voted_for_username: 'Staging demo Alice'   },
    { vote_date: todayStr,     voter_id: -3, voter_username: 'Staging demo Charlie', voted_for_id: -1, voted_for_username: 'Staging demo Alice'   },
    { vote_date: todayStr,     voter_id: -1, voter_username: 'Staging demo Alice',   voted_for_id: -2, voted_for_username: 'Staging demo Bob'     },
    { vote_date: yesterdayStr, voter_id: -2, voter_username: 'Staging demo Bob',     voted_for_id: -1, voted_for_username: 'Staging demo Alice'   },
  ];
  for (const v of votes) {
    await pool.query(
      `INSERT INTO daily_prompt_votes
         (vote_date, voter_user_id, voter_username, voted_for_user_id, voted_for_username)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vote_date, voter_user_id) DO NOTHING`,
      [v.vote_date, v.voter_id, v.voter_username, v.voted_for_id, v.voted_for_username]
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
  // Coin balances include wager match results:
  // Alice: base 150 - 50 (wager sent) + 50 (won match 1) - 100 (lost match 2) = 50, plus 75 pending = 50
  // Bob: base 250 - 100 (wager sent) + 100 (won match 1) - 50 (lost match 2) = 200, minus 75 (pending) = 200
  const rows = [
    { user_id: -1, coins_earned: 30, balance: 50 },
    { user_id: -2, coins_earned: 50, balance: 200 },
    { user_id: -3, coins_earned: 65, balance: 325 },
    { user_id: -4, coins_earned: 15, balance: 75 },
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
      `INSERT INTO player_coins (user_id, balance) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance`,
      [r.user_id, r.balance]
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
  if (levelNumber >= 3) blockTypes.push(28); // Gold Star wildcard appears from level 3

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
    // Guarantee at least one Gold Star wildcard is visible in the level-3 staging seed.
    if (level === 3) blocks.push({ x: 5, y: 4, z: 5, t: 28 });
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

async function seedWagerMatches() {
  // Seed demo wager match history for staging demo users (Alice: -1, Bob: -2)
  const now = new Date();
  const matches = [
    {
      challenger_id: -1,
      challenger_username: 'Staging demo Alice',
      opponent_id: -2,
      opponent_username: 'Staging demo Bob',
      wager_amount: 50,
      status: 'completed',
      challenger_score: 145,
      opponent_score: 98,
      winner_id: -1,
      created_at: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
      accepted_at: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000 + 10 * 60 * 1000),
      completed_at: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000 + 20 * 60 * 1000),
    },
    {
      challenger_id: -2,
      challenger_username: 'Staging demo Bob',
      opponent_id: -1,
      opponent_username: 'Staging demo Alice',
      wager_amount: 100,
      status: 'completed',
      challenger_score: 120,
      opponent_score: 167,
      winner_id: -1,
      created_at: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000),
      accepted_at: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000 + 5 * 60 * 1000),
      completed_at: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000 + 15 * 60 * 1000),
    },
    {
      challenger_id: -1,
      challenger_username: 'Staging demo Alice',
      opponent_id: -2,
      opponent_username: 'Staging demo Bob',
      wager_amount: 75,
      status: 'pending',
      challenger_score: null,
      opponent_score: null,
      winner_id: null,
      created_at: new Date(now.getTime() - 2 * 60 * 60 * 1000),
      accepted_at: null,
      completed_at: null,
    },
  ];
  for (const m of matches) {
    await pool.query(
      `INSERT INTO wager_matches (challenger_id, challenger_username, opponent_id, opponent_username, wager_amount, status, challenger_score, opponent_score, winner_id, created_at, accepted_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING`,
      [m.challenger_id, m.challenger_username, m.opponent_id, m.opponent_username, m.wager_amount, m.status, m.challenger_score, m.opponent_score, m.winner_id, m.created_at, m.accepted_at, m.completed_at]
    );
  }
}

async function seedVersus() {
  // Seed a finished demo match so the versus game-over overlay can be previewed.
  const finishedRes = await pool.query(
    `INSERT INTO versus_matches (room_code, status, host_user_id, host_username, max_players, duration_secs,
       start_at, end_at, winner_user_id, winner_username, created_at)
     VALUES ('DEMO01', 'finished', 0, 'Staging Versus Alice', 4, 60,
       NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 minute',
       0, 'Staging Versus Alice', NOW() - INTERVAL '3 minutes')
     ON CONFLICT (room_code) DO NOTHING RETURNING id`
  );
  if (finishedRes.rows.length) {
    const finishedId = finishedRes.rows[0].id;
    const players = [
      { uid: -101, uname: 'Staging Versus Alice', score: 87 },
      { uid: -102, uname: 'Staging Versus Bob',   score: 64 },
      { uid: -103, uname: 'Staging Versus Carol',  score: 51 },
      { uid: -104, uname: 'Staging Versus Dan',    score: 12 },
    ];
    for (const p of players) {
      await pool.query(
        `INSERT INTO versus_players (match_id, user_id, username, live_score, final_score, submitted_at)
         VALUES ($1, $2, $3, $4, $4, NOW() - INTERVAL '1 minute')
         ON CONFLICT (match_id, user_id) DO NOTHING`,
        [finishedId, p.uid, p.uname, p.score]
      );
    }
  }
  // Seed a waiting match so the join-by-code flow can be tested (enter WAIT01).
  const waitRes = await pool.query(
    `INSERT INTO versus_matches (room_code, status, host_user_id, host_username, max_players, duration_secs, created_at)
     VALUES ('WAIT01', 'waiting', 0, 'Staging Versus Alice', 4, 60, NOW())
     ON CONFLICT (room_code) DO NOTHING RETURNING id`
  );
  if (waitRes.rows.length) {
    const waitId = waitRes.rows[0].id;
    await pool.query(
      `INSERT INTO versus_players (match_id, user_id, username)
       VALUES ($1, 0, 'Staging Versus Alice')
       ON CONFLICT (match_id, user_id) DO NOTHING`,
      [waitId]
    );
    await pool.query(
      `INSERT INTO versus_players (match_id, user_id, username)
       VALUES ($1, -102, 'Staging Versus Bob')
       ON CONFLICT (match_id, user_id) DO NOTHING`,
      [waitId]
    );
  }
}

// Seed daily energy state for staging demo users showing mid-day energy consumption.
async function seedDailyEnergy() {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const seeds = [
    { userId: -1, ticketsUsed: 2, pointsBurned: 0 },
    { userId: -2, ticketsUsed: 3, pointsBurned: 100 },
    { userId: -3, ticketsUsed: 1, pointsBurned: 0 },
  ];
  for (const s of seeds) {
    await pool.query(
      `INSERT INTO player_daily_energy (user_id, energy_date, tickets_used, points_burned, tokens_burned, updated_at)
       VALUES ($1, $2, $3, $4, 0, NOW())
       ON CONFLICT (user_id, energy_date) DO NOTHING`,
      [s.userId, todayStr, s.ticketsUsed, s.pointsBurned]
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

    // Remove hidden messages on destroyed blocks
    if (type === 'earthquake') {
      await client.query(
        `DELETE FROM block_messages WHERE x BETWEEN $1 AND $2 AND z BETWEEN $3 AND $4`,
        [params.x0, params.x1, params.z0, params.z1]
      );
    } else if (type === 'eruption') {
      await client.query(
        `DELETE FROM block_messages WHERE (x-$1)*(x-$1)+(z-$2)*(z-$2) <= $3`,
        [origin_x, origin_z, params.radius * params.radius]
      );
    } else {
      await client.query(
        `DELETE FROM block_messages WHERE (x-$1)*(x-$1)+(y-$2)*(y-$2)+(z-$3)*(z-$3) <= $4`,
        [origin_x, params.oy, origin_z, params.radius * params.radius]
      );
    }

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

    // Recompute monuments for all sectors whose blocks were destroyed.
    // Runs outside the transaction — uses pool, not client.
    if (delRes.rows.length > 0) {
      const affectedSectors = new Set();
      for (const row of delRes.rows) {
        affectedSectors.add(sectorCoord(row.x) + ',' + sectorCoord(row.z));
      }
      for (const key of affectedSectors) {
        const [sx, sz] = key.split(',').map(Number);
        try { await recomputeMonument(sx, sz); } catch (_) {}
      }
    }

    return { id: Number(disaster.id), type, label: def.label, icon: def.icon, origin_x, origin_z, params, blocks_destroyed, triggered_at: disaster.triggered_at };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('disaster trigger error', err.message);
    return null;
  } finally {
    client.release();
  }
}

async function seedBlockMessages() {
  // Unfound message on the Gold Block (20, 1, 10) — hidden by staging-demo-dave
  await pool.query(
    `INSERT INTO block_messages (x, y, z, author_user_id, author_username, body, hidden_at)
     VALUES (20, 1, 10, -4, 'staging-demo-dave', 'Staging demo hidden treasure: Who will find this gold? 🔍', NOW() - INTERVAL '1 hour')
     ON CONFLICT (x, y, z) DO NOTHING`
  );
  // Already-found message on the Glowstone (21, 1, 10) — found by staging-demo-alice
  await pool.query(
    `INSERT INTO block_messages (x, y, z, author_user_id, author_username, body, hidden_at, found_by_user_id, found_by_username, found_at)
     VALUES (21, 1, 10, -5, 'staging-demo-eve', 'Staging demo found message: This glowstone marks the start. ✨', NOW() - INTERVAL '2 hours', -1, 'staging-demo-alice', NOW() - INTERVAL '30 minutes')
     ON CONFLICT (x, y, z) DO NOTHING`
  );
}

async function start() {
  try {
    console.log('[startup] Initializing database tables...');
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
  await pool.query(`ALTER TABLE leaderboard ADD COLUMN IF NOT EXISTS best_time_attack_score SMALLINT NOT NULL DEFAULT 0`);

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
    CREATE TABLE IF NOT EXISTS speedrun_best_times (
      user_id     INTEGER PRIMARY KEY,
      username    VARCHAR(255) NOT NULL,
      best_ms     BIGINT NOT NULL,
      achieved_at TIMESTAMPTZ NOT NULL,
      session_id  BIGINT
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
      ADD COLUMN IF NOT EXISTS active_pet VARCHAR(20)
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

  // Daily mission progress: one row per (date, user). Stores which mission type
  // was active (for display) and the current progress count toward the target.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_mission_progress (
      mission_date DATE        NOT NULL,
      user_id      INTEGER     NOT NULL,
      username     VARCHAR(255) NOT NULL,
      mission_type VARCHAR(30) NOT NULL,
      progress     INTEGER     NOT NULL DEFAULT 0,
      target       INTEGER     NOT NULL,
      completed_at TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (mission_date, user_id)
    )
  `);

  // Mission completion streaks: one row per user, updated when each daily mission
  // is completed. Separate from login_streaks — measures consecutive mission
  // completions, not logins.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mission_streaks (
      user_id             INTEGER PRIMARY KEY,
      username            VARCHAR(255) NOT NULL,
      last_completed_date DATE        NOT NULL,
      current_streak      INTEGER     NOT NULL DEFAULT 1,
      longest_streak      INTEGER     NOT NULL DEFAULT 1,
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Daily prompt votes: one row per (date, voter). Public — vote counts and
  // usernames for a given day are not sensitive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_prompt_votes (
      vote_date             DATE          NOT NULL,
      voter_user_id         INTEGER       NOT NULL,
      voter_username        VARCHAR(255)  NOT NULL,
      voted_for_user_id     INTEGER       NOT NULL,
      voted_for_username    VARCHAR(255)  NOT NULL,
      created_at            TIMESTAMPTZ   DEFAULT NOW(),
      PRIMARY KEY (vote_date, voter_user_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS daily_prompt_votes_voted_for_idx
    ON daily_prompt_votes (vote_date, voted_for_user_id)
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
      user_id              INTEGER PRIMARY KEY,
      username             VARCHAR(255) NOT NULL DEFAULT '',
      balance              BIGINT NOT NULL DEFAULT 0,
      last_coin_login_date DATE,
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Daily energy system: tracks daily ticket usage and point/token spending.
  // Public table — holds only gameplay resource tracking, no sensitive data.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_daily_energy (
      user_id       INTEGER NOT NULL,
      energy_date   DATE NOT NULL,
      tickets_used  INTEGER NOT NULL DEFAULT 0,
      points_burned BIGINT NOT NULL DEFAULT 0,
      tokens_burned BIGINT NOT NULL DEFAULT 0,
      updated_at    TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, energy_date)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS player_daily_energy_date_idx ON player_daily_energy (energy_date, user_id)`);

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

  // Ensure all expected player_coins columns exist for deployments that had an older schema.
  await pool.query(`ALTER TABLE player_coins ADD COLUMN IF NOT EXISTS username VARCHAR(255) NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE player_coins ADD COLUMN IF NOT EXISTS balance BIGINT NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE player_coins ADD COLUMN IF NOT EXISTS last_coin_login_date DATE`);

  // Wager history: append-only log of every bet placed. Public.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wager_history (
      id                BIGSERIAL PRIMARY KEY,
      user_id           INTEGER      NOT NULL,
      username          VARCHAR(255) NOT NULL,
      bet_amount        INTEGER      NOT NULL,
      tier              VARCHAR(20)  NOT NULL,
      target_blocks     INTEGER      NOT NULL,
      payout_multiplier NUMERIC(4,2) NOT NULL,
      final_blocks      INTEGER,
      outcome           VARCHAR(10)  NOT NULL DEFAULT 'pending',
      payout            INTEGER,
      created_at        TIMESTAMPTZ  DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS wager_history_user_created_idx
    ON wager_history (user_id, created_at DESC)
  `);

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

  // Hidden messages that players can attach to blocks. Marked staging:private
  // so real messages are never copied into staging containers.
  // No FK to blocks intentionally — blocks is public, this is private.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS block_messages (
      x                  SMALLINT     NOT NULL,
      y                  SMALLINT     NOT NULL,
      z                  SMALLINT     NOT NULL,
      author_user_id     INTEGER      NOT NULL,
      author_username    VARCHAR(255) NOT NULL,
      body               VARCHAR(200) NOT NULL,
      hidden_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      found_by_user_id   INTEGER,
      found_by_username  VARCHAR(255),
      found_at           TIMESTAMPTZ,
      PRIMARY KEY (x, y, z)
    )
  `);
  await pool.query(`COMMENT ON TABLE block_messages IS 'staging:private'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monuments (
      id                SERIAL PRIMARY KEY,
      sector_x          SMALLINT NOT NULL,
      sector_z          SMALLINT NOT NULL,
      name              VARCHAR(100) NOT NULL,
      block_count       INTEGER NOT NULL DEFAULT 0,
      contributor_count INTEGER NOT NULL DEFAULT 0,
      crowned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (sector_x, sector_z)
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

  // Wager matches: peer-to-peer competitive matches with coin stakes.
  // Public table — it holds only usernames and game scores, nothing sensitive.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wager_matches (
      id                 BIGSERIAL PRIMARY KEY,
      challenger_id      INTEGER      NOT NULL,
      challenger_username VARCHAR(255) NOT NULL,
      opponent_id        INTEGER      NOT NULL,
      opponent_username  VARCHAR(255) NOT NULL,
      wager_amount       BIGINT       NOT NULL,
      status             VARCHAR(20)  NOT NULL DEFAULT 'pending',
      challenger_score   INTEGER,
      opponent_score     INTEGER,
      winner_id          INTEGER,
      created_at         TIMESTAMPTZ  DEFAULT NOW(),
      accepted_at        TIMESTAMPTZ,
      completed_at       TIMESTAMPTZ,
      expires_at         TIMESTAMPTZ  DEFAULT NOW() + INTERVAL '24 hours'
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS wager_matches_opponent_status_idx ON wager_matches (opponent_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS wager_matches_challenger_status_idx ON wager_matches (challenger_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS wager_matches_completed_at_idx ON wager_matches (completed_at DESC NULLS LAST)`);

  // Fog of War: per-player revealed (x, z) columns in the shared Classic world.
  // Public table — revealed cell coordinates are no more sensitive than leaderboard positions.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_fog_revealed (
      user_id     INTEGER  NOT NULL,
      x           SMALLINT NOT NULL,
      z           SMALLINT NOT NULL,
      revealed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, x, z)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS fog_revealed_user_idx ON player_fog_revealed (user_id)
  `);

  // Versus Mode match tables: both public (usernames + scores, no sensitive data).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS versus_matches (
      id              SERIAL PRIMARY KEY,
      room_code       VARCHAR(8)   NOT NULL UNIQUE,
      status          VARCHAR(20)  NOT NULL DEFAULT 'waiting',
      host_user_id    INTEGER      NOT NULL,
      host_username   VARCHAR(255) NOT NULL,
      max_players     SMALLINT     NOT NULL DEFAULT 4,
      duration_secs   INTEGER      NOT NULL DEFAULT 60,
      start_at        TIMESTAMPTZ,
      end_at          TIMESTAMPTZ,
      winner_user_id  INTEGER,
      winner_username VARCHAR(255),
      created_at      TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS versus_matches_room_code_idx ON versus_matches (room_code)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS versus_matches_status_created_idx ON versus_matches (status, created_at)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS versus_players (
      match_id        INTEGER      NOT NULL REFERENCES versus_matches(id),
      user_id         INTEGER      NOT NULL,
      username        VARCHAR(255) NOT NULL,
      joined_at       TIMESTAMPTZ  DEFAULT NOW(),
      live_score      INTEGER      NOT NULL DEFAULT 0,
      live_score_at   TIMESTAMPTZ,
      final_score     INTEGER,
      submitted_at    TIMESTAMPTZ,
      PRIMARY KEY (match_id, user_id)
    )
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
    try { await seedCoins(); }
    catch (err) { console.error('coins seed failed', err); }
    try { await seedPromptVotes(); }
    catch (err) { console.error('prompt votes seed failed', err); }
    try { await seedBlockMessages(); }
    catch (err) { console.error('block messages seed failed', err); }
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
    try { await seedWagerMatches(); }
    catch (err) { console.error('wager-matches seed failed', err); }
    try { await seedVersus(); }
    catch (err) { console.error('versus seed failed', err); }
    try { await seedDailyEnergy(); }
    catch (err) { console.error('daily-energy seed failed', err); }
    // Staging spectators are now surfaced via the STAGING_DEMO_USERS constant
    // appended in GET /api/presence/online, so no DB seed is needed here.

    // Fog of War: pre-reveal the 5×5 centre patch (overlapping the staging hut)
    // for the sentinel seed user so the minimap shows a meaningful partial reveal.
    try {
      await pool.query(`
        INSERT INTO player_fog_revealed (user_id, x, z)
        SELECT $1, x, z
          FROM generate_series(14, 18) AS x,
               generate_series(14, 18) AS z
        ON CONFLICT (user_id, x, z) DO NOTHING`,
        [SEED_USER_ID]
      );
    } catch (err) { console.error('fog seed failed', err); }
  }

  await ensurePowerUps();
  initMobs();

    console.log('[startup] Database initialization complete.');
    startupComplete = true;
    app.listen(port, () => {
      console.log(`[startup] Listening on :${port}`);
      startAiLoop();
    });
  } catch (err) {
    const msg = err.message || String(err);
    console.error('[startup] FATAL: Database initialization failed:', msg);
    startupError = msg;
    // Keep the app running but report errors when requested
    app.listen(port, () => console.log(`[startup] Listening on :${port} (with startup error)`));
  }
}

start().catch((err) => { console.error(err); process.exit(1); });
