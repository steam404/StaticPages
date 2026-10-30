-- 多端同步：D1 表结构
-- 执行：wrangler d1 execute yakult-sync --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_ts ON login_attempts (ip, ts);

-- 玩什么 页面的留言气泡
CREATE TABLE IF NOT EXISTS bubbles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL,
  ip TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bubbles_created ON bubbles (created_at);
