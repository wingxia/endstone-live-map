CREATE DATABASE IF NOT EXISTS endstone_live_map
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE endstone_live_map;

CREATE TABLE IF NOT EXISTS markers (
  id VARCHAR(36) PRIMARY KEY,
  world VARCHAR(80) NOT NULL,
  dimension VARCHAR(80) NOT NULL,
  x DOUBLE NOT NULL,
  y DOUBLE NOT NULL,
  z DOUBLE NOT NULL,
  title VARCHAR(80) NOT NULL,
  description TEXT NOT NULL,
  created_by VARCHAR(80) NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  INDEX markers_dimension_idx (world, dimension, updated_at DESC)
);
