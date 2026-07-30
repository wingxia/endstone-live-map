#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  LIVE_MAP_SERVER_ROOT=/absolute/path/to/endstone/server \
  LIVE_MAP_PLUGIN_TOKEN='long-random-token' \
  ./scripts/nas-install.sh /path/to/endstone_live_map.so

Optional environment:
  LIVE_MAP_LOCAL_SERVER_URL   Node origin (default: http://127.0.0.1:8000)
  LIVE_MAP_SERVER_ID          Safe server id (default: hostname)
  LIVE_MAP_LAND_CONFIG_FILE   Land JSON path (default: <server>/plugins/land/land.json)
  LIVE_MAP_UPLOAD_LANDS       true/false (default: true only when the land file exists)

The script never restarts the game or Node service. It refuses to replace the
plugin while this server's bedrock_server process is running.
USAGE
}

if [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

umask 077

PLUGIN_SOURCE="$1"
SERVER_ROOT_INPUT="${LIVE_MAP_SERVER_ROOT:-}"
PLUGIN_TOKEN="${LIVE_MAP_PLUGIN_TOKEN:-}"
LOCAL_SERVER_URL="${LIVE_MAP_LOCAL_SERVER_URL:-http://127.0.0.1:8000}"
SERVER_ID="${LIVE_MAP_SERVER_ID:-$(hostname -s)}"

if [[ -z "$SERVER_ROOT_INPUT" || "$SERVER_ROOT_INPUT" != /* ]]; then
  echo "LIVE_MAP_SERVER_ROOT must be an explicit absolute path." >&2
  exit 2
fi
if [[ ! -d "$SERVER_ROOT_INPUT" ]]; then
  echo "Endstone server root does not exist: $SERVER_ROOT_INPUT" >&2
  exit 2
fi
if [[ ! -f "$PLUGIN_SOURCE" ]]; then
  echo "Plugin shared object does not exist: $PLUGIN_SOURCE" >&2
  exit 2
fi
if command -v file >/dev/null 2>&1 && ! file -b -- "$PLUGIN_SOURCE" | grep -Eq 'ELF .* shared object'; then
  echo "Plugin input is not a Linux ELF shared object: $PLUGIN_SOURCE" >&2
  exit 2
fi
if [[ ! "$PLUGIN_TOKEN" =~ ^[A-Za-z0-9._~+/=-]{16,512}$ ]]; then
  echo "LIVE_MAP_PLUGIN_TOKEN must be 16-512 safe token characters." >&2
  exit 2
fi
if [[ ! "$LOCAL_SERVER_URL" =~ ^https?://[^[:space:]\"\\]+$ ]]; then
  echo "LIVE_MAP_LOCAL_SERVER_URL must be an http(s) URL without whitespace, quotes, or backslashes." >&2
  exit 2
fi
if [[ ! "$SERVER_ID" =~ ^[A-Za-z0-9._-]{1,80}$ ]]; then
  echo "LIVE_MAP_SERVER_ID must contain only letters, numbers, dot, underscore, or dash." >&2
  exit 2
fi

SERVER_ROOT="$(realpath "$SERVER_ROOT_INPUT")"
if [[ "$SERVER_ROOT" == "/" ]]; then
  echo "Refusing to use the filesystem root as LIVE_MAP_SERVER_ROOT." >&2
  exit 2
fi

PLUGIN_DIR="$SERVER_ROOT/plugins"
DATA_DIR="$PLUGIN_DIR/live_map"
PLUGIN_TARGET="$PLUGIN_DIR/endstone_live_map.so"
CONFIG_TARGET="$DATA_DIR/live_map.json"
BACKUP_DIR="$PLUGIN_DIR/.live-map-backups"
LAND_CONFIG_FILE="${LIVE_MAP_LAND_CONFIG_FILE:-$PLUGIN_DIR/land/land.json}"

case "$LAND_CONFIG_FILE" in
  *'"'*|*'\'*|*$'\n'*|*$'\r'*)
    echo "LIVE_MAP_LAND_CONFIG_FILE contains unsupported JSON characters." >&2
    exit 2
    ;;
esac

if [[ -n "${LIVE_MAP_UPLOAD_LANDS:-}" ]]; then
  case "$LIVE_MAP_UPLOAD_LANDS" in
    true|false) UPLOAD_LANDS="$LIVE_MAP_UPLOAD_LANDS" ;;
    *)
      echo "LIVE_MAP_UPLOAD_LANDS must be true or false." >&2
      exit 2
      ;;
  esac
elif [[ -f "$LAND_CONFIG_FILE" ]]; then
  UPLOAD_LANDS=true
else
  UPLOAD_LANDS=false
fi

if pgrep -f -- "$SERVER_ROOT/bedrock_server" >/dev/null 2>&1; then
  echo "Refusing to replace the plugin while $SERVER_ROOT/bedrock_server is running." >&2
  echo "Stop this Endstone instance, run the installer again, then start it explicitly." >&2
  exit 1
fi

install -d -m 0755 "$PLUGIN_DIR"
install -d -m 0700 "$DATA_DIR"
install -d -m 0700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path=""
if [[ -f "$PLUGIN_TARGET" ]]; then
  backup_path="$BACKUP_DIR/endstone_live_map.so.$timestamp.$$"
  cp -p -- "$PLUGIN_TARGET" "$backup_path"
fi

temporary_plugin="$PLUGIN_DIR/.endstone_live_map.so.$timestamp.$$.tmp"
temporary_config=""
cleanup() {
  rm -f -- "$temporary_plugin"
  if [[ -n "$temporary_config" ]]; then
    rm -f -- "$temporary_config"
  fi
}
trap cleanup EXIT

install -m 0755 "$PLUGIN_SOURCE" "$temporary_plugin"
mv -f -- "$temporary_plugin" "$PLUGIN_TARGET"

if [[ ! -f "$CONFIG_TARGET" ]]; then
  temporary_config="$DATA_DIR/.live_map.json.$timestamp.$$.tmp"
  cat >"$temporary_config" <<JSON
{
  "local_server_url": "$LOCAL_SERVER_URL",
  "plugin_token": "$PLUGIN_TOKEN",
  "server_id": "$SERVER_ID",
  "background_log_file": "live_map.log",
  "baseline_index_file": "chunk_baselines.tsv",
  "land_config_file": "$LAND_CONFIG_FILE",
  "tile_data_dir": "map-data",
  "dimensions": ["Overworld", "Nether", "TheEnd"],
  "tile_min_zoom": -8,
  "tile_max_zoom": 4,
  "render_worker_threads": 1,
  "scan_radius_chunks": 8,
  "chunk_refresh_seconds": 20,
  "player_push_seconds": 1,
  "max_chunks_per_refresh": 32,
  "player_seed_radius_chunks": 4,
  "player_seed_interval_seconds": 60,
  "max_seed_chunks_per_pulse": 4,
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
  "upload_lands": $UPLOAD_LANDS
}
JSON
  chmod 0600 "$temporary_config"
  mv -f -- "$temporary_config" "$CONFIG_TARGET"
  echo "Created configuration: $CONFIG_TARGET"
else
  chmod 0600 "$CONFIG_TARGET"
  echo "Preserved existing configuration: $CONFIG_TARGET"
fi

echo "Installed plugin: $PLUGIN_TARGET"
if [[ -n "$backup_path" ]]; then
  echo "Backup: $backup_path"
fi
echo "No service was restarted. Start the Node service first, then start this Endstone instance."
