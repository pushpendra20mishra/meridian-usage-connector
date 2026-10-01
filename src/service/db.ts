import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

// better-sqlite3 hands back unknown rows, these two helpers are where they get typed
export const all = <T>(db: Db, sql: string, args: unknown[] = []) => db.prepare(sql).all(...args) as T[];
export const one = <T>(db: Db, sql: string, args: unknown[] = []) => db.prepare(sql).get(...args) as T | undefined;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_fact (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('claude', 'gemini')),
  day TEXT NOT NULL,                 -- UTC date, YYYY-MM-DD
  week TEXT NOT NULL,                -- ISO week of \`day\`, e.g. 2026-W36
  user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  product TEXT NOT NULL,             -- claude: chat|claude_code|cowork; gemini: agent label
  model TEXT NOT NULL,
  source_ref TEXT NOT NULL,          -- claude: rbac_group_id; gemini: gcp project id
  requests INTEGER,                  -- NULL for gemini (billing export has no request count)
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  cost_nano_usd INTEGER NOT NULL,
  UNIQUE (platform, day, user_id, product, model, source_ref)
);
CREATE INDEX IF NOT EXISTS ix_fact_group_day ON usage_fact (group_id, day);
CREATE INDEX IF NOT EXISTS ix_fact_user ON usage_fact (user_id);

CREATE TABLE IF NOT EXISTS ingest_issue (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS capability (
  group_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT,                   -- NULL until a human changes the seeded default
  updated_by TEXT,
  PRIMARY KEY (group_id, capability)
);

-- Per-user layer on top of the per-group switches. Only platform admins write these.
CREATE TABLE IF NOT EXISTS user_capability (
  user_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (user_id, capability)
);

CREATE TABLE IF NOT EXISTS user_suspension (
  user_id TEXT PRIMARY KEY,
  reason TEXT,
  suspended_at TEXT NOT NULL,
  suspended_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('capability_set', 'override_set', 'override_cleared', 'suspended', 'restored')),
  group_id TEXT NOT NULL,
  user_id TEXT,
  capability TEXT,
  detail TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL
);
`;

// one sync connection is fine here, wal so reads dont block
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}
