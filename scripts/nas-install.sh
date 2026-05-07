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
DATA_DIR="$SERVER_ROOT/bedrock_server/plugins/endstone_live_map"

install -m 755 "$PLUGIN_SO" "$PLUGIN_DIR/endstone_live_map.so"
mkdir -p "$DATA_DIR"
cat > "$DATA_DIR/live_map.json" <<JSON
{
  "worker_url": "https://map.buhe.li",
  "plugin_token": "$PLUGIN_TOKEN",
  "server_id": "vvnas",
  "dimensions": ["Overworld", "Nether", "TheEnd"],
  "scan_radius_chunks": 8,
  "tile_refresh_seconds": 60,
  "player_push_seconds": 1,
  "max_tiles_per_refresh": 1,
  "upload_tiles": true,
  "upload_players": true
}
JSON

systemctl --user status mc.service >/dev/null 2>&1 || true
sudo systemctl restart mc.service
