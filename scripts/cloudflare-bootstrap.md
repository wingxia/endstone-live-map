# Cloudflare Bootstrap

Run these commands after `npx wrangler login` or with `CLOUDFLARE_API_TOKEN` set.

```bash
cd /Users/winxia/codex/endstone-live-map/worker

npx wrangler d1 create endstone_live_map
```

R2 is the tile backend. Keep tile refresh settings conservative so the first version stays inside Cloudflare's free allowance:

```bash
npx wrangler r2 bucket create endstone-live-map-tiles
```

Without the `MAP_TILES` binding, the Worker stores tiles in D1 as a fallback.

Copy the returned D1 `database_id` into the GitHub repository variable:

```bash
gh variable set CLOUDFLARE_D1_DATABASE_ID --repo wingxia/endstone-live-map --body '<database_id>'
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
