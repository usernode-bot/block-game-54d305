const { DIMS, SEED_USER_ID, DISASTER_DEFS, DISASTER_USER_ID, DISASTER_USERNAME, DISASTER_MIN_SECS, DISASTER_MAX_SECS } = require('./modules/constants');

function dailyTarget(dateObj) {
  const y = dateObj.getUTCFullYear();
  const m = dateObj.getUTCMonth() + 1;
  const d = dateObj.getUTCDate();
  return 20 + ((y * 31 + m * 7 + d) % 81);
}

function weekStart(dateObj) {
  const day = dateObj.getUTCDay();
  const offset = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(
    dateObj.getUTCFullYear(), dateObj.getUTCMonth(), dateObj.getUTCDate() - offset
  ));
  return monday.toISOString().slice(0, 10);
}

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
    for (let dz = -1; dz <= 1; dz++) {
      set(tx + dx, 4, tz + dz, 5, REZA);
    }
  }
  set(tx, 5, tz, 5, REZA);
  set(16, 1, 13, 6);
  set(16, 1, 12, 6);
  set(20, 1, 10, 14);
  set(21, 1, 10, 15);
  set(22, 1, 10, 16);
  set(23, 1, 10, 17);
  set(24, 1, 10, 18);
  set(20, 1, 11, 13);
  set(10, 1, 22, 18);
  set(10, 2, 22, 18);
  set(10, 3, 22, 18);
  set(11, 2, 22, 18);
  set( 9, 2, 22, 18);
  return cells;
}

async function seedStaging(pool) {
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

  const typeUsageSeed = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 18].map((bt) => ({ userId: -1, blockType: bt })),
    ...[1, 2, 3, 4, 5, 17].map((bt) => ({ userId: -2, blockType: bt })),
    ...[1, 2, 3].map((bt) => ({ userId: -3, blockType: bt })),
    ...[1, 2, 3, 4, 14].map((bt) => ({ userId: -4, blockType: bt })),
  ];
  for (const u of typeUsageSeed) {
    await pool.query(
      `INSERT INTO player_type_usage (user_id, block_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [u.userId, u.blockType]
    );
  }

  const badgeSeed = [
    { userId: -1, badgeId: 'first_block', daysAgo: 10 },
    { userId: -1, badgeId: 'builder', daysAgo: 9 },
    { userId: -1, badgeId: 'architect', daysAgo: 8 },
    { userId: -1, badgeId: 'high_scorer', daysAgo: 7 },
    { userId: -1, badgeId: 'comboist', daysAgo: 5 },
    { userId: -1, badgeId: 'golden_touch', daysAgo: 4 },
    { userId: -1, badgeId: 'material_artist', daysAgo: 3 },
    { userId: -1, badgeId: 'crystal_placer', daysAgo: 2 },
    { userId: -2, badgeId: 'first_block', daysAgo: 8 },
    { userId: -2, badgeId: 'builder', daysAgo: 6 },
    { userId: -2, badgeId: 'rainbow_placer', daysAgo: 5 },
    { userId: -2, badgeId: 'comboist', daysAgo: 3 },
    { userId: -3, badgeId: 'first_block', daysAgo: 3 },
    { userId: -3, badgeId: 'rainbow_placer', daysAgo: 2 },
    { userId: -3, badgeId: 'builder', daysAgo: 1 },
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

  await pool.query(
    `INSERT INTO player_tutorial_completed (user_id, completed_at)
     VALUES (-1, NOW() - INTERVAL '5 days'), (-2, NOW() - INTERVAL '2 days')
     ON CONFLICT DO NOTHING`
  );

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

async function seedLeaderboard(pool) {
  const patches = [
    { userId: -1, username: 'Staging demo Alice',   type: 1,  cells: makeRect(1, 1, 8, 5) },
    { userId: -2, username: 'Staging demo Bob',     type: 2,  cells: makeRect(1, 6, 5, 5) },
    { userId: -3, username: 'Staging demo Charlie', type: 7,  cells: makeRect(6, 1, 3, 5) },
    { userId: -4, username: 'Staging demo Dana',    type: 9,  cells: makeRect(6, 6, 3, 3) },
    { userId: -5, username: 'Staging demo Eli',     type: 10, cells: makeRect(1, 11, 5, 1) },
    { userId: -6, username: 'Staging demo Faye',    type: 11, cells: makeRect(1, 12, 2, 1) },
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

async function seedChat(pool) {
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
  await pool.query(
    `SELECT setval('chat_messages_id_seq', GREATEST((SELECT MAX(id) FROM chat_messages), 3))`
  );
}

async function seedTournament(pool) {
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

async function seedTaScores(pool) {
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

async function seedTa60Scores(pool) {
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

async function seedEndlessScores(pool) {
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

async function seedStreaks(pool) {
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

async function seedLoginRewards(pool) {
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

async function seedDailyChallenge(pool) {
  const today = new Date().toISOString().slice(0, 10);
  const target = dailyTarget(new Date());

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

async function initializeStagingData(pool, IS_STAGING) {
  if (IS_STAGING) {
    try { await seedStaging(pool); }
    catch (err) { console.error('staging blocks seed failed', err); }
    try { await seedChat(pool); }
    catch (err) { console.error('staging chat seed failed', err); }
    try { await seedLeaderboard(pool); }
    catch (err) { console.error('leaderboard seed failed', err); }
    try { await seedTournament(pool); }
    catch (err) { console.error('tournament seed failed', err); }
    try { await seedTaScores(pool); }
    catch (err) { console.error('ta-scores seed failed', err); }
    try { await seedTa60Scores(pool); }
    catch (err) { console.error('ta-60-scores seed failed', err); }
    try { await seedEndlessScores(pool); }
    catch (err) { console.error('endless-scores seed failed', err); }
    try { await seedStreaks(pool); }
    catch (err) { console.error('streak seed failed', err); }
    try { await seedLoginRewards(pool); }
    catch (err) { console.error('login-rewards seed failed', err); }
    try { await seedDailyChallenge(pool); }
    catch (err) { console.error('daily-challenge seed failed', err); }
  }
}

module.exports = { initializeStagingData };
