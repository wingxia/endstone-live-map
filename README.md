# endstone-live-map

Realtime 2D web map for an Endstone Bedrock server.

The project is a monorepo:

- `plugin/`: C++20 Endstone plugin. It publishes player snapshots, automatically seeds chunks around online players, and keeps changed terrain fresh from block events.
- `worker/`: Cloudflare Worker API, R2 chunk/texture storage, Hyperdrive MySQL marker API, and Durable Object live room.
- `web/`: React/Leaflet frontend served by the Worker static assets binding.

## Current scope

- 2D top-down highest-block chunks, one native zoom layer for v1.
- Player positions update independently from terrain chunks.
- Online players seed nearby chunks as the live-first base map; terrain changes mark dirty chunks and are sampled/uploaded on the same timer.
- Marker UI is currently hidden. The Worker API and NAS MySQL schema are retained dormant for later restoration.
- Chunk snapshots and texture atlas files use the R2 `MAP_DATA` binding.
- Marker storage uses NAS MySQL through Cloudflare Hyperdrive. D1 is not used.

## Required secrets

Do not commit these values.

- Cloudflare Worker secret `PLUGIN_TOKEN`: shared token used by the server plugin.
- Optional Cloudflare Worker secret `MARKER_WRITE_TOKEN`: if set, marker writes require `Authorization: Bearer <token>`.
- GitHub repository variable `CLOUDFLARE_HYPERDRIVE_ID`: Hyperdrive id for the NAS MySQL marker database.
- GitHub secrets for deployment workflow:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`
  - `PLUGIN_TOKEN`

## Checks

Frontend-only checks may run locally on macOS:

```bash
npm ci
npm run test -w web
npm run build -w web
npm run test:e2e -w web
```

C++ and Worker checks are intended to run on GitHub Actions or NAS for this deployment.

## Plugin config

Copy `plugin/config/live_map.json.example` to the plugin data folder as `live_map.json`, then set `plugin_token`.

For the NAS target in this environment, `mc.service` runs Endstone from `/vol1/1000`; the plugin directory is `/vol1/1000/bedrock_server/plugins`, and the data directory is `/vol1/1000/bedrock_server/plugins/live_map`.
The current NAS Bedrock level name is `Bedrock level`, which is also the default frontend world filter.

The production live-first defaults sample chunks every 20 seconds, enqueue an 8-chunk radius around each online player, and upload up to 32 chunks per refresh. This lets player-loaded areas become the visible base map without waiting for an offline full import.

## Texture atlas

Generate the atlas from a server/resource pack on NAS or a local copy of that pack:

```bash
npm run textures:atlas -- --input /path/to/vanilla_resource_pack --input /path/to/server_override_pack --output /tmp/livemap-textures
npx wrangler r2 object put endstone-live-map-tiles/textures/v1/atlas.png --file /tmp/livemap-textures/atlas.png
npx wrangler r2 object put endstone-live-map-tiles/textures/v1/manifest.json --file /tmp/livemap-textures/manifest.json --content-type application/json
npx wrangler r2 object put endstone-live-map-tiles/textures/v1/report.json --file /tmp/livemap-textures/report.json --content-type application/json
```

The generated `atlas.png` and `manifest.json` are deployment artifacts and are not committed.

## Offline map import fallback

The live plugin is the primary production path for current terrain: players load nearby chunks, the plugin uploads those chunks, and later block changes correct them.

Use the offline importer only for repair/backfill, such as rebuilding a known-good wider base map from a stopped-server LevelDB snapshot. Do not run a full block scan inside the live Endstone plugin. For the NAS server:

```bash
PLUGIN_TOKEN=... scripts/nas-full-import.sh
```

The importer reads existing generated chunks only, uploads chunk snapshots in batches to `/api/plugin/chunks/batch`, writes world bounds to `/api/plugin/world-meta`, and stores progress under `/vol1/1000/live-map-import`.

## Map data cleanup

Bad imports can be removed through the authenticated Worker cleanup endpoint. It only accepts map-data prefixes and will reject `textures/v1/`, so the atlas stays in R2:

```bash
curl -fsS -X POST https://map.buhe.li/api/plugin/map-data/cleanup \
  -H "Authorization: Bearer $PLUGIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"prefix":"chunks/v1/","dryRun":true}'
```

Run again with `"dryRun":false` and `"confirm":"delete-map-data-v1"` after checking the matched keys.
