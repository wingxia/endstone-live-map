#!/usr/bin/env bash
set -euo pipefail

SERVER_ROOT="${SERVER_ROOT:-/vol1/1000}"
WORLD_NAME="${WORLD_NAME:-Bedrock level}"
IMPORT_ROOT="${IMPORT_ROOT:-/vol1/1000/live-map-import}"
WORKER_URL="${WORKER_URL:-https://map.buhe.li}"
BDS_SAMPLES_VERSION="${BDS_SAMPLES_VERSION:-v1.26.20.4}"
BDS_SAMPLES_URL="${BDS_SAMPLES_URL:-https://github.com/Mojang/bedrock-samples/releases/download/${BDS_SAMPLES_VERSION}/bedrock-samples-${BDS_SAMPLES_VERSION}-min.zip}"
R2_BUCKET="${R2_BUCKET:-endstone-live-map-tiles}"
ROOT_SYSTEMCTL="${ROOT_SYSTEMCTL:-systemctl}"
NODE_IMAGE="${NODE_IMAGE:-docker.buhe.li/library/node:24-bookworm}"

if [[ -z "${PLUGIN_TOKEN:-}" ]]; then
  echo "PLUGIN_TOKEN is required" >&2
  exit 2
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required for R2 uploads" >&2
  exit 2
fi

mkdir -p "$IMPORT_ROOT"/{snapshots,work,textures}
timestamp="$(date +%Y%m%d-%H%M%S)"
snapshot_dir="$IMPORT_ROOT/snapshots/$timestamp"
level_src="$SERVER_ROOT/bedrock_server/worlds/$WORLD_NAME"

echo "Stopping mc.service for a consistent LevelDB snapshot..."
$ROOT_SYSTEMCTL stop mc.service
mkdir -p "$snapshot_dir"
rsync -a --delete "$level_src/" "$snapshot_dir/$WORLD_NAME/"
$ROOT_SYSTEMCTL start mc.service
systemctl is-active --quiet mc.service
echo "Snapshot created at $snapshot_dir/$WORLD_NAME"

repo_dir="$IMPORT_ROOT/repo"
if [[ ! -d "$repo_dir/.git" ]]; then
  git clone https://github.com/wingxia/endstone-live-map.git "$repo_dir"
else
  git -C "$repo_dir" pull --ff-only
fi

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

docker run --rm \
  -v "$repo_dir:/repo" \
  -v "$samples_dir:/samples:ro" \
  -v "$SERVER_ROOT/bedrock_server/resource_packs:/resource_packs:ro" \
  -v "$IMPORT_ROOT/textures:/out" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && npm run textures:atlas -- --input '$vanilla_pack' --input /resource_packs/chemistry --output /out"

docker run --rm \
  -e CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
  -e CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}" \
  -v "$repo_dir:/repo" \
  -v "$IMPORT_ROOT/textures:/out:ro" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && npx wrangler r2 object put '$R2_BUCKET/textures/v1/atlas.png' --file /out/atlas.png --content-type image/png && npx wrangler r2 object put '$R2_BUCKET/textures/v1/manifest.json' --file /out/manifest.json --content-type application/json && npx wrangler r2 object put '$R2_BUCKET/textures/v1/report.json' --file /out/report.json --content-type application/json"

echo "Running dry-run import..."
docker run --rm \
  -v "$repo_dir:/repo" \
  -v "$snapshot_dir/$WORLD_NAME/db:/worlddb:ro" \
  -v "$IMPORT_ROOT:/import" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && node tools/importer/import-bedrock-world.mjs --db /worlddb --world '$WORLD_NAME' --worker-url '$WORKER_URL' --dry-run --resume-file /import/progress-dry-run.json"

echo "Running full import..."
docker run --rm \
  -e PLUGIN_TOKEN="$PLUGIN_TOKEN" \
  -v "$repo_dir:/repo" \
  -v "$snapshot_dir/$WORLD_NAME/db:/worlddb:ro" \
  -v "$IMPORT_ROOT:/import" \
  -w /repo \
  "$NODE_IMAGE" \
  bash -lc "npm ci && node tools/importer/import-bedrock-world.mjs --db /worlddb --world '$WORLD_NAME' --worker-url '$WORKER_URL' --batch-size 64 --rps 1 --resume-file /import/progress.json"

curl -fsS "$WORKER_URL/api/worlds" | jq .
echo "Full import finished."
