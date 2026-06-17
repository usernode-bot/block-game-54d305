async function initializeSchema(pool) {
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
    CREATE TABLE IF NOT EXISTS ta_scores (
      user_id         INTEGER PRIMARY KEY,
      username        VARCHAR(255) NOT NULL,
      best_cleared    INTEGER NOT NULL DEFAULT 0,
      best_difficulty SMALLINT NOT NULL DEFAULT 1,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ta_60_scores (
      user_id         INTEGER PRIMARY KEY,
      username        VARCHAR(255) NOT NULL,
      best_cleared    INTEGER NOT NULL DEFAULT 0,
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS endless_scores (
      user_id              INTEGER PRIMARY KEY,
      username             VARCHAR(255) NOT NULL,
      best_placed          INTEGER NOT NULL DEFAULT 0,
      best_moves_survived  INTEGER NOT NULL DEFAULT 0,
      updated_at           TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_type_usage (
      user_id    INTEGER NOT NULL,
      block_type SMALLINT NOT NULL,
      PRIMARY KEY (user_id, block_type)
    )
  `);

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
  await pool.query(`
    CREATE INDEX IF NOT EXISTS daily_challenge_progress_date_placed_idx
    ON daily_challenge_progress (challenge_date, blocks_placed DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_challenge_streaks (
      user_id INTEGER PRIMARY KEY,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      last_completed_date DATE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_coins (
      user_id        INTEGER PRIMARY KEY,
      coins_balance  BIGINT NOT NULL DEFAULT 0,
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_tutorial_completed (
      user_id INTEGER PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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
}

module.exports = { initializeSchema };
