const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Plugin-Token",
};

const EMPTY_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10,
  73, 68, 65, 84, 120, 1, 99, 0, 1, 0, 0, 5, 0, 1, 54, 208, 136, 221, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

const CLEANUP_CONFIRMATION = "delete-map-data-v2";
const CLEANUP_DEFAULT_LIMIT = 200;
const CLEANUP_MAX_LIMIT = 500;
const MAP_TILE_PREFIX = "map-tiles/v2/";
const CLEANUP_PREFIXES = new Set([
  "map-tiles/v1/",
  "chunks/v1/",
  "chunk-regions/v1/",
  "block-updates/v1/",
  "map-tile-dirty/v1/",
  "map-tile-backfill-jobs/v1/",
  "map-tile-backfill-queue/v1/",
  "map-tile-backfill-errors/v1/",
  "textures/v1/",
  "meta/v1/",
]);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "endstone-live-map-edge" });
    }
    if (url.pathname.startsWith("/api/map-tiles/")) {
      return handleMapTileGet(url, env);
    }
    if (url.pathname === "/api/plugin/map-data/cleanup") {
      const auth = requirePluginAuth(request, env);
      if (auth) {
        return auth;
      }
      return handleMapDataCleanup(request, env);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return json({ error: "not_found" }, 404);
  },
};

function mapBucket(env) {
  return env.MAP_DATA || env.MAP_TILES || null;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function requirePluginAuth(request, env) {
  if (!env.PLUGIN_TOKEN) {
    return json({ error: "plugin_token_not_configured" }, 503);
  }
  const auth = request.headers.get("Authorization") || "";
  const headerToken = request.headers.get("X-Plugin-Token") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return bearer === env.PLUGIN_TOKEN || headerToken === env.PLUGIN_TOKEN ? null : json({ error: "unauthorized" }, 401);
}

async function handleMapTileGet(url, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const tile = parseMapTilePath(url.pathname);
  if (!tile) {
    return json({ error: "invalid_map_tile_path" }, 404);
  }
  const object = await bucket.get(mapTileKey(tile.world, tile.dimension, tile.zoom, tile.tileX, tile.tileZ));
  if (!object) {
    return pngResponse(EMPTY_PNG, { "Cache-Control": "no-store" });
  }
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata?.(headers);
  headers.set("Content-Type", headers.get("Content-Type") || "image/png");
  headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return new Response(await object.arrayBuffer(), { headers });
}

async function handleMapDataCleanup(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  let cleanup;
  try {
    cleanup = normalizeCleanupPayload(await request.json());
  } catch (error) {
    return json({ error: "cleanup_prefix_not_allowed", message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!cleanup.dryRun && cleanup.confirm !== CLEANUP_CONFIRMATION) {
    return json({ error: "cleanup_confirmation_required", confirm: CLEANUP_CONFIRMATION }, 400);
  }

  const keys = cleanup.keys.length > 0 ? cleanup.keys : await listCleanupKeys(bucket, cleanup);
  if (!cleanup.dryRun) {
    await Promise.all(keys.map((key) => bucket.delete(key)));
  }
  return json({
    ok: true,
    dryRun: cleanup.dryRun,
    prefix: cleanup.prefix,
    deleted: cleanup.dryRun ? 0 : keys.length,
    matched: keys.length,
    keys,
    truncated: false,
    cursor: null,
  });
}

async function listCleanupKeys(bucket, cleanup) {
  const page = await bucket.list({ prefix: cleanup.prefix, cursor: cleanup.cursor || undefined, limit: cleanup.limit });
  return (page.objects || [])
    .map((object) => object.key)
    .filter((key) => key.startsWith(cleanup.prefix) && !key.startsWith("lands/v1/"));
}

function pngResponse(body, headers = {}) {
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "image/png",
      ...headers,
    },
  });
}

export function normalizeCleanupPayload(payload = {}) {
  const dryRun = payload.dryRun !== false;
  const limit = Math.min(CLEANUP_MAX_LIMIT, Math.max(1, Number(payload.limit || CLEANUP_DEFAULT_LIMIT)));
  const prefix = String(payload.prefix || "");
  const keys = Array.isArray(payload.keys) ? payload.keys.map((key) => normalizeCleanupKey(key)) : [];
  if (keys.length > CLEANUP_MAX_LIMIT) {
    throw new Error(`cleanup keys must be at most ${CLEANUP_MAX_LIMIT}`);
  }
  if (keys.length === 0 && !CLEANUP_PREFIXES.has(prefix)) {
    throw new Error("cleanup prefix is not allowed");
  }
  return {
    dryRun,
    confirm: String(payload.confirm || ""),
    prefix,
    cursor: typeof payload.cursor === "string" ? payload.cursor : "",
    limit,
    keys,
  };
}

function normalizeCleanupKey(value) {
  const key = String(value || "");
  if (![...CLEANUP_PREFIXES].some((prefix) => key.startsWith(prefix)) || key.startsWith("lands/v1/")) {
    throw new Error("cleanup key is not allowed");
  }
  return key;
}

export function mapTileKey(world, dimension, zoom, tileX, tileZ) {
  return `${MAP_TILE_PREFIX}${cleanSegment(world)}/${cleanSegment(dimension)}/z${Number(zoom)}/${Number(tileX)}/${Number(tileZ)}.png`;
}

export function parseMapTilePath(pathname) {
  const match = /^\/api\/map-tiles\/([^/]+)\/([^/]+)\/z(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/.exec(pathname);
  if (!match) {
    return null;
  }
  return {
    world: cleanSegment(match[1]),
    dimension: cleanSegment(match[2]),
    zoom: Number(match[3]),
    tileX: Number(match[4]),
    tileZ: Number(match[5]),
  };
}

export function cleanSegment(value) {
  return String(value || "default").replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
}
