import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (platform, account_id)
);

CREATE TABLE IF NOT EXISTS posts (
  connection_id TEXT NOT NULL REFERENCES connections (id),
  post_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  first_fetched_at TEXT NOT NULL,
  last_fetched_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, post_id)
);

-- A chave (conexão, post, captured_at) é a idempotência: o mesmo snapshot entra uma vez,
-- venha repetido na mesma resposta ou de novo em outra janela.
CREATE TABLE IF NOT EXISTS metric_snapshots (
  connection_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  views INTEGER NOT NULL,
  likes INTEGER NOT NULL,
  comments INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, post_id, captured_at),
  FOREIGN KEY (connection_id, post_id) REFERENCES posts (connection_id, post_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections (id),
  window_since TEXT NOT NULL,
  window_until TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'rate_limited')),
  attempts INTEGER NOT NULL DEFAULT 0,
  waited_ms INTEGER NOT NULL DEFAULT 0,
  snapshots_received INTEGER NOT NULL DEFAULT 0,
  snapshots_new INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  retry_after_ms INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
`;

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}
