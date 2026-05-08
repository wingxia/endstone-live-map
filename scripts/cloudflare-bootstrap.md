# Cloudflare Bootstrap

Run these commands after `npx wrangler login` or with `CLOUDFLARE_API_TOKEN` set.

```bash
cd /Users/winxia/codex/endstone-live-map/worker

npx wrangler r2 bucket create endstone-live-map-tiles
npx wrangler d1 create endstone_live_map
```

Copy the returned D1 `database_id` into the GitHub repository variable:

```bash
gh variable set CLOUDFLARE_D1_DATABASE_ID --repo wingxia/endstone-live-map --body '<database_id>'
```

Set GitHub deployment secrets:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo wingxia/endstone-live-map --body '<cloudflare_api_token>'
gh secret set CLOUDFLARE_ACCOUNT_ID --repo wingxia/endstone-live-map --body '<cloudflare_account_id>'
```

Set Worker runtime secrets after the first deploy, or before redeploying:

```bash
npx wrangler secret put PLUGIN_TOKEN
npx wrangler secret put MARKER_WRITE_TOKEN
```

Then trigger the manual deploy workflow:

```bash
gh workflow run deploy-worker.yml --repo wingxia/endstone-live-map --ref main
```
