CREATE TABLE IF NOT EXISTS tiles (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  body_base64 TEXT NOT NULL,
  world TEXT NOT NULL,
  dimension TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tiles_dimension_idx ON tiles (world, dimension, updated_at DESC);
