#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <plugin-shared-object> <plugin-token>" >&2
  exit 2
fi

PLUGIN_SO="$1"
PLUGIN_TOKEN="$2"
SERVER_ROOT="/vol1/1000"
PLUGIN_DIR="$SERVER_ROOT/bedrock_server/plugins"
DATA_DIR="$SERVER_ROOT/bedrock_server/plugins/live_map"

install -m 755 "$PLUGIN_SO" "$PLUGIN_DIR/endstone_live_map.so"
mkdir -p "$DATA_DIR"
cat > "$DATA_DIR/live_map.json" <<JSON
{
  "worker_url": "https://map.buhe.li",
  "plugin_token": "$PLUGIN_TOKEN",
  "server_id": "vvnas",
  "dimensions": ["Overworld", "Nether", "TheEnd"],
  "scan_radius_chunks": 8,
  "chunk_refresh_seconds": 20,
  "player_push_seconds": 1,
  "max_chunks_per_refresh": 32,
  "player_seed_radius_chunks": 4,
  "player_seed_interval_seconds": 600,
  "max_seed_chunks_per_pulse": 1,
  "seed_pulse_seconds": 1,
  "player_seed_join_delay_seconds": 10,
  "dirty_block_push_seconds": 1,
  "max_dirty_blocks_per_push": 64,
  "max_upload_queue_size": 256,
  "upload_chunks": true,
  "auto_seed_chunks": false,
  "upload_dirty_blocks": true,
  "upload_players": true
}
JSON

if [[ "$(id -u)" -ne 0 ]]; then
  echo "installed plugin files; restart mc.service as root to load the plugin" >&2
  exit 0
fi

systemctl restart mc.service
