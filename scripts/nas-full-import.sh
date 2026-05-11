#!/usr/bin/env bash
set -euo pipefail

SERVER_ROOT="${SERVER_ROOT:-/vol1/1000}"
WORLD_NAME="${WORLD_NAME:-Bedrock level}"
IMPORT_ROOT="${IMPORT_ROOT:-/vol1/1000/live-map-import}"
WORKER_URL="${WORKER_URL:-https://map.buhe.li}"
BDS_SAMPLES_VERSION="${BDS_SAMPLES_VERSION:-v1.26.20.4}"
BDS_SAMPLES_URL="${BDS_SAMPLES_URL:-https://gh.buhe.li/Mojang/bedrock-samples/releases/download/${BDS_SAMPLES_VERSION}/bedrock-samples-${BDS_SAMPLES_VERSION}-min.zip}"
REPO_URL="${REPO_URL:-https://gh.buhe.li/wingxia/endstone-live-map.git}"
ROOT_SYSTEMCTL="${ROOT_SYSTEMCTL:-systemctl}"
NODE_IMAGE="${NODE_IMAGE:-docker.buhe.li/library/node:24-bookworm}"

if [[ -z "${PLUGIN_TOKEN:-}" ]]; then
  echo "PLUGIN_TOKEN is required" >&2
  exit 2
fi

mkdir -p "$IMPORT_ROOT"/{snapshots,work,textures}
timestamp="$(date +%Y%m%d-%H%M%S)"
snapshot_dir="${SNAPSHOT_DIR:-$IMPORT_ROOT/snapshots/$timestamp}"
level_src="$SERVER_ROOT/bedrock_server/worlds/$WORLD_NAME"
service_stopped=0

start_mc_service() {
  if [[ "$service_stopped" == "1" ]]; then
    echo "Starting mc.service..."
    $ROOT_SYSTEMCTL start mc.service || true
    service_stopped=0
  fi
}

trap start_mc_service EXIT

if [[ -n "${SNAPSHOT_DIR:-}" ]]; then
  if [[ ! -d "$snapshot_dir/$WORLD_NAME/db" ]]; then
    echo "SNAPSHOT_DIR does not contain $WORLD_NAME/db: $snapshot_dir" >&2
    exit 1
  fi
  echo "Using existing snapshot at $snapshot_dir/$WORLD_NAME"
else
  echo "Stopping mc.service for a consistent LevelDB snapshot..."
  $ROOT_SYSTEMCTL stop mc.service
  service_stopped=1
  mkdir -p "$snapshot_dir"
  rsync -a --delete "$level_src/" "$snapshot_dir/$WORLD_NAME/"
  start_mc_service
  systemctl is-active --quiet mc.service
  echo "Snapshot created at $snapshot_dir/$WORLD_NAME"
fi

repo_dir="$IMPORT_ROOT/repo"
if [[ ! -d "$repo_dir/.git" ]]; then
  git clone "$REPO_URL" "$repo_dir"
else
  git -C "$repo_dir" remote set-url origin "$REPO_URL"
  git -C "$repo_dir" pull --ff-only
fi
git -C "$repo_dir" reset --hard origin/main

samples_zip="$IMPORT_ROOT/work/bedrock-samples-${BDS_SAMPLES_VERSION}-min.zip"
samples_dir="$IMPORT_ROOT/work/bedrock-samples-${BDS_SAMPLES_VERSION}"
if [[ ! -f "$samples_zip" ]]; then
  curl -fL --retry 5 --retry-delay 5 -o "$samples_zip" "$BDS_SAMPLES_URL"
fi
rm -rf "$samples_dir"
mkdir -p "$samples_dir"
unzip -q "$samples_zip" -d "$samples_dir"

vanilla_pack="$(find "$samples_dir" -type f -path '*/textures/terrain_texture.json' -print -quit | sed 's#/textures/terrain_texture.json##')"
if [[ -z "$vanilla_pack" ]]; then
  echo "Could not find terrain_texture.json in $samples_zip" >&2
  exit 1
fi
vanilla_pack_container="/samples/${vanilla_pack#"$samples_dir"/}"

docker run --rm \
  -v "$repo_dir:/repo" \
  -v "$samples_dir:/samples:ro" \
  -v "$SERVER_ROOT/bedrock_server/resource_packs:/resource_packs:ro" \
  -v "$IMPORT_ROOT/textures:/out" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && npm run textures:atlas -- --input '$vanilla_pack_container' --input /resource_packs/chemistry --output /out"

docker run --rm \
  -e PLUGIN_TOKEN="$PLUGIN_TOKEN" \
  -v "$repo_dir:/repo" \
  -v "$IMPORT_ROOT/textures:/out:ro" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && npm run textures:upload -- --input /out --worker-url '$WORKER_URL'"

echo "Running dry-run import..."
docker run --rm \
  -v "$repo_dir:/repo" \
  -v "$snapshot_dir/$WORLD_NAME/db:/worlddb" \
  -v "$IMPORT_ROOT:/import" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && node tools/importer/import-bedrock-world.mjs --db /worlddb --world '$WORLD_NAME' --worker-url '$WORKER_URL' --dry-run --resume-file /import/progress-dry-run.json"

echo "Running full import..."
docker run --rm \
  -e PLUGIN_TOKEN="$PLUGIN_TOKEN" \
  -v "$repo_dir:/repo" \
  -v "$snapshot_dir/$WORLD_NAME/db:/worlddb" \
  -v "$IMPORT_ROOT:/import" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && node tools/importer/import-bedrock-world.mjs --db /worlddb --world '$WORLD_NAME' --worker-url '$WORKER_URL' --batch-size 64 --rps 1 --resume-file /import/progress.json"

curl -fsS "$WORKER_URL/api/worlds" | jq .
echo "Full import finished."
