# Cloudflare Bootstrap

Run these commands after `npx wrangler login` or with `CLOUDFLARE_API_TOKEN` set.

```bash
cd /Users/winxia/codex/endstone-live-map/worker
npx wrangler r2 bucket create endstone-live-map-tiles
```

R2 stores chunk snapshots and the generated texture atlas:

```text
chunks/v1/{world}/{dimension}/{chunkX}/{chunkZ}.json
textures/v1/atlas.png
textures/v1/manifest.json
```

Create a Hyperdrive config that points at the NAS MySQL TCP hostname exposed through Cloudflare Tunnel:

```bash
npx wrangler hyperdrive create endstone-live-map-mysql \
  --connection-string="mysql://<user>:<password>@mysql-map.buhe.li:3306/endstone_live_map"
```

Copy the returned Hyperdrive id into the GitHub repository variable:

```bash
gh variable set CLOUDFLARE_HYPERDRIVE_ID --repo wingxia/endstone-live-map --body '<hyperdrive_id>'
```

Set GitHub deployment secrets:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo wingxia/endstone-live-map --body '<cloudflare_api_token>'
gh secret set CLOUDFLARE_ACCOUNT_ID --repo wingxia/endstone-live-map --body '<cloudflare_account_id>'
gh secret set PLUGIN_TOKEN --repo wingxia/endstone-live-map --body '<shared_plugin_token>'
```

Optionally set a marker write token:

```bash
gh secret set MARKER_WRITE_TOKEN --repo wingxia/endstone-live-map --body '<optional_marker_write_token>'
```

Then trigger the manual deploy workflow:

```bash
gh workflow run deploy-worker.yml --repo wingxia/endstone-live-map --ref main
```
