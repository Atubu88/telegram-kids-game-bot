PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  weekly_stars INTEGER NOT NULL DEFAULT 30,
  lifetime_progress INTEGER NOT NULL DEFAULT 0,
  shop_locked INTEGER NOT NULL DEFAULT 0,
  recovery_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS point_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('add', 'remove', 'purchase', 'weekly_reset', 'recovery_on', 'recovery_off', 'goal_reset')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shop_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  shop_item_id INTEGER NOT NULL,
  price_paid INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_item_id) REFERENCES shop_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS weekly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  week_key TEXT NOT NULL,
  ending_stars INTEGER NOT NULL,
  lifetime_progress INTEGER NOT NULL,
  recovery_mode INTEGER NOT NULL,
  shop_locked INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
  UNIQUE(player_id, week_key)
);

CREATE TABLE IF NOT EXISTS bot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS parent_sessions (
  chat_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  payload_json TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_point_events_player_created_at ON point_events(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_purchases_player_created_at ON purchases(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_weekly_snapshots_player_created_at ON weekly_snapshots(player_id, created_at DESC);

INSERT OR IGNORE INTO players (id, code, name, weekly_stars, lifetime_progress, shop_locked, recovery_mode)
VALUES
  (1, 'player1', '👦 Игрок 1', 30, 0, 0, 0),
  (2, 'player2', '👦 Игрок 2', 30, 0, 0, 0);

INSERT INTO shop_items (id, name, emoji, price, active)
VALUES
  (1, 'Телефон · 1 час', '📱', 10, 1),
  (2, 'Сладости на 20 крон', '🍬', 80, 1),
  (3, '50 крон', '💵', 150, 1),
  (4, 'Напиток · 0.5 л', '🥤', 40, 1),
  (5, 'Булочка', '🍩', 40, 1),
  (6, 'Телевизор · 1 час', '📺', 10, 1)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  emoji = excluded.emoji,
  price = excluded.price,
  active = excluded.active;

INSERT OR IGNORE INTO bot_state (key, value)
VALUES ('last_weekly_reset_key', '');
