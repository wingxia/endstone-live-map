# endstone-live-map

Realtime 2D web map for an Endstone Bedrock server.

The project is a monorepo:

- `plugin/`: C++20 Endstone plugin. It samples the highest visible block for map tiles, tracks dirty tiles from block events, and publishes player snapshots.
- `worker/`: Cloudflare Worker API, R2 tile storage, D1 marker API, and Durable Object live room.
- `web/`: React/Leaflet frontend served by the Worker static assets binding.

## Current scope

- 2D top-down tiles, one native zoom layer for v1.
- Player positions update independently from terrain tiles.
- Terrain changes mark dirty tiles and are re-rendered on a timer.
- Markers support title, description, coordinates, dimension, creator, and timestamps.

## Required secrets

Do not commit these values.

- Cloudflare Worker secret `PLUGIN_TOKEN`: shared token used by the server plugin.
- Optional Cloudflare Worker secret `MARKER_WRITE_TOKEN`: if set, marker writes require `Authorization: Bearer <token>`.
- GitHub secrets for deployment workflow:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`

## Local checks

```bash
npm ci
npm test
npm run build
cmake -S plugin -B plugin/build-core -DLIVE_MAP_WITH_ENDSTONE=OFF
cmake --build plugin/build-core
ctest --test-dir plugin/build-core --output-on-failure
```

## Plugin config

Copy `plugin/config/live_map.json.example` to the plugin data folder as `live_map.json`, then set `plugin_token`.

For the NAS target in this environment, `mc.service` runs Endstone from `/vol1/1000`; the plugin directory is `/vol1/1000/bedrock_server/plugins`.
