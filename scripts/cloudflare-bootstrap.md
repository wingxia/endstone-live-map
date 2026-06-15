# Cloudflare Bootstrap

Cloudflare is optional in the MipMap-style refactor. The required frontend/API runs on the server-local Node service. Use Cloudflare only when you want public edge reads for mirrored R2 tiles.

## R2 Bucket

Run after `npx wrangler login` or with `CLOUDFLARE_API_TOKEN` set:

```bash
cd /Users/winxia/codex/endstone-live-map/worker
npx wrangler r2 bucket create endstone-live-map-tiles
```

The plugin writes only finished PNG tiles:

```text
map-tiles/v2/<world>/<dimension>/z<zoom>/<tileX>/<tileZ>.png
```

Keep plugin R2 secrets out of `live_map.json`:

```bash
export LIVE_MAP_R2_ACCESS_KEY_ID=...
export LIVE_MAP_R2_SECRET_ACCESS_KEY=...
```

## Worker

The Worker now provides only:

- `GET /api/health`
- `GET /api/map-tiles/<world>/<dimension>/z<zoom>/<tileX>/<tileZ>.png`
- `POST /api/plugin/map-data/cleanup`

Set GitHub deployment secrets if using the existing workflow:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo wingxia/endstone-live-map --body '<cloudflare_api_token>'
gh secret set CLOUDFLARE_ACCOUNT_ID --repo wingxia/endstone-live-map --body '<cloudflare_account_id>'
gh secret set PLUGIN_TOKEN --repo wingxia/endstone-live-map --body '<cleanup_token>'
```

Then deploy:

```bash
npm run deploy -w worker
```

## Cleanup

Dry-run old map-data cleanup:

```bash
LIVE_MAP_R2_ACCESS_KEY_ID=... LIVE_MAP_R2_SECRET_ACCESS_KEY=... \
npm run cleanup:r2 -- \
  --endpoint https://<account-id>.r2.cloudflarestorage.com \
  --bucket endstone-live-map-tiles
```

Destructive cleanup requires explicit confirmation:

```bash
LIVE_MAP_R2_ACCESS_KEY_ID=... LIVE_MAP_R2_SECRET_ACCESS_KEY=... \
npm run cleanup:r2 -- \
  --endpoint https://<account-id>.r2.cloudflarestorage.com \
  --bucket endstone-live-map-tiles \
  --confirm delete-map-data-v2
```
