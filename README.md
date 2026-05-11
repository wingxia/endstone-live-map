# endstone-live-map

Realtime 2D web map for an Endstone Bedrock server.

The project is a monorepo:

- `plugin/`: C++20 Endstone plugin. It samples highest visible blocks into 16x16 chunk snapshots, tracks dirty chunks from block events, and publishes player snapshots.
- `worker/`: Cloudflare Worker API, R2 chunk/texture storage, Hyperdrive MySQL marker API, and Durable Object live room.
- `web/`: React/Leaflet frontend served by the Worker static assets binding.

## Current scope

- 2D top-down highest-block chunks, one native zoom layer for v1.
- Player positions update independently from terrain chunks.
- Terrain changes mark dirty chunks and are sampled/uploaded on a timer.
- Markers support title, description, coordinates, dimension, creator, and timestamps.
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

## Texture atlas

Generate the atlas from a server/resource pack on NAS or a local copy of that pack:

```bash
npm run textures:atlas -- --input /path/to/resource_pack --output /tmp/livemap-textures
npx wrangler r2 object put endstone-live-map-tiles/textures/v1/atlas.png --file /tmp/livemap-textures/atlas.png
npx wrangler r2 object put endstone-live-map-tiles/textures/v1/manifest.json --file /tmp/livemap-textures/manifest.json --content-type application/json
```

The generated `atlas.png` and `manifest.json` are deployment artifacts and are not committed.
