#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 <plugin-shared-object> <plugin-token> [local-server-url]" >&2
  exit 2
fi

PLUGIN_SO="$1"
PLUGIN_TOKEN="$2"
LOCAL_SERVER_URL="${3:-http://127.0.0.1:8000}"
SERVER_ROOT="/vol1/1000"
PLUGIN_DIR="$SERVER_ROOT/bedrock_server/plugins"
DATA_DIR="$SERVER_ROOT/bedrock_server/plugins/live_map"

install -m 755 "$PLUGIN_SO" "$PLUGIN_DIR/endstone_live_map.so"
mkdir -p "$DATA_DIR"
cat > "$DATA_DIR/live_map.json" <<JSON
{
  "local_server_url": "$LOCAL_SERVER_URL",
  "plugin_token": "$PLUGIN_TOKEN",
  "server_id": "vvnas",
  "background_log_file": "live_map.log",
  "baseline_index_file": "chunk_baselines.tsv",
  "land_config_file": "/vol1/1000/bedrock_server/plugins/land/land.json",
  "tile_data_dir": "map-data",
  "dimensions": ["Overworld", "Nether", "TheEnd"],
  "tile_min_zoom": -1,
  "tile_max_zoom": 4,
  "render_worker_threads": 2,
  "scan_radius_chunks": 8,
  "chunk_refresh_seconds": 20,
  "player_push_seconds": 1,
  "max_chunks_per_refresh": 32,
  "player_seed_radius_chunks": 4,
  "player_seed_interval_seconds": 600,
  "max_seed_chunks_per_pulse": 1,
  "seed_pulse_seconds": 1,
  "player_seed_join_delay_seconds": 10,
  "chunk_upload_batch_size": 8,
  "chunk_upload_flush_seconds": 10,
  "chunk_upload_cooldown_seconds": 60,
  "http_timeout_seconds": 30,
  "dirty_block_push_seconds": 60,
  "land_push_seconds": 60,
  "max_dirty_blocks_per_push": 2048,
  "max_dirty_chunks_per_push": 64,
  "max_upload_queue_size": 256,
  "max_pending_chunk_uploads": 4096,
  "r2_enabled": false,
  "r2_endpoint": "",
  "r2_bucket": "",
  "r2_region": "auto",
  "r2_key_prefix": "map-tiles/v2",
  "r2_max_concurrent_uploads": 1,
  "r2_max_uploads_per_minute": 60,
  "r2_retry_count": 3,
  "r2_retry_backoff_ms": 1000,
  "upload_chunks": true,
  "auto_seed_chunks": false,
  "upload_dirty_blocks": true,
  "upload_players": true,
  "upload_lands": true
}
JSON

if [[ "$(id -u)" -ne 0 ]]; then
  echo "installed plugin files; restart mc.service as root to load the plugin" >&2
  exit 0
fi

systemctl restart mc.service
