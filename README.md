# endstone-live-map

Realtime 2D web map for an Endstone Bedrock server.

The project is a monorepo:

- `plugin/`: C++20 Endstone plugin. It publishes player snapshots, automatically seeds chunks around online players, and keeps changed terrain fresh from block events.
- `worker/`: Cloudflare Worker API, R2 chunk/texture storage, Hyperdrive MySQL marker API, and Durable Object live room.
- `web/`: React/Leaflet frontend served by the Worker static assets binding.

## Current scope

- 2D top-down highest-block chunks, one native zoom layer for v1.
- Player positions update independently from terrain chunks.
- Online players seed a radius-4 chunk area as the live-first base map; terrain changes update only affected top-map block columns.
- Land claims are read-only annotations from the server land plugin JSON and are uploaded as map overlays.
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

The plugin accepts the current `chunk_*` keys and the legacy `tile_*` names used by older NAS configs. New configs should use `upload_chunks`, `player_seed_radius_chunks`, `player_seed_interval_seconds`, `max_seed_chunks_per_pulse`, `seed_pulse_seconds`, `player_seed_join_delay_seconds`, `chunk_upload_batch_size`, `chunk_upload_flush_seconds`, `upload_dirty_blocks`, `dirty_block_push_seconds`, `upload_lands`, `land_config_file`, `land_push_seconds`, `max_dirty_blocks_per_push`, `max_upload_queue_size`, `background_log_file`, and `baseline_index_file`.

Production defaults seed `player_seed_radius_chunks=4` around each online player, refresh the same player chunk center every `player_seed_interval_seconds=600`, and rate-limit base chunk sampling with `max_seed_chunks_per_pulse=1` every `seed_pulse_seconds=1`. New joins wait `player_seed_join_delay_seconds=10` before terrain sampling so the player login path can settle; player positions can still upload during that delay. If the player moves into a different chunk after the delay, that new radius-4 area is queued immediately rather than waiting for the 10-minute refresh.

Plugin HTTP uploads use an internal worker thread and bounded queue (`max_upload_queue_size=256`) instead of Endstone async scheduler tasks. The worker thread only performs curl requests and never touches Endstone world/player/block APIs. Base chunk uploads are buffered and sent to `/api/plugin/chunks/batch`; production defaults allow up to `chunk_upload_batch_size=32` chunks per request and flush at least every `chunk_upload_flush_seconds=10`. After a batch upload succeeds, the plugin writes a confirmed chunk fingerprint to `baseline_index_file` (`chunk_baselines.tsv` by default), so unchanged player-radius refreshes are sampled for top-cache safety but skipped for HTTP upload even after a plugin restart.

Dirty block events are column-based: the plugin waits one tick, merges repeated changes for the same `(x,z)` column, and samples/uploads only when the changed block can affect the top-down map surface. Successful dirty block uploads update the local confirmed baseline; if the plugin only has a persisted fingerprint but not a live chunk snapshot, it queues one base resample after the dirty update so the next skip decision has a fresh exact fingerprint. Full chunk uploads are still available through `/livemap render-near` and `/livemap render-chunk` for manual repair.

Normal live-map activity is appended to `background_log_file` (`live_map.log` by default). The Endstone console is reserved for errors such as failed HTTP uploads, failed sampling, or failed baseline persistence.

Land claim overlays are read from `land_config_file` (`/vol1/1000/bedrock_server/plugins/land/land.json` on the NAS target) every `land_push_seconds` seconds when `upload_lands=true`. The live map plugin only reads that file; it does not write back to the land plugin.

If a server build still crashes while sampling terrain, treat `upload_chunks=false` only as emergency isolation. The required fix is to replace or narrow the sampling backend until player-radius seeding and top-column dirty updates are stable.

### NAS plugin safety checks

Only one active shared object with plugin name `live_map` should be present under `/vol1/1000/bedrock_server/plugins`. If Endstone logs `Ambiguous plugin name 'live_map'`, keep the canonical `endstone_live_map.so` and rename older duplicates such as `endstone_endstone_live_map.so` to a disabled backup name before restarting `mc.service`.

`mc.service` may still run Endstone inside `screen`, but screen must not be the only log sink. Keep systemd restart behavior intact and use a reversible override that enables `screen -L -Logfile /vol1/1000/bedrock_server/logs/mc-screen.log` plus appended stdout/stderr logs such as `/vol1/1000/bedrock_server/logs/mc-service.log`. If Endstone crashes, the screen session may disappear; the persistent logs should retain the last console output.

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
