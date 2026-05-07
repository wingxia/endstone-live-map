CREATE TABLE IF NOT EXISTS markers (
  id TEXT PRIMARY KEY,
  world TEXT NOT NULL,
  dimension TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS markers_dimension_idx ON markers (world, dimension, updated_at DESC);
