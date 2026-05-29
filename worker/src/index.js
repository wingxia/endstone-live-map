import { Buffer } from "node:buffer";
import { createConnection } from "mysql2/promise";
import { PNG } from "pngjs";
import { fallbackTextureColor, usesMapTint } from "../../shared/blockColors.mjs";

export { fallbackTextureColor, usesMapTint };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Plugin-Token",
};

const CHUNK_BLOCK_COUNT = 256;
const MAX_CHUNK_PALETTE_SIZE = CHUNK_BLOCK_COUNT * 2;
const MAX_CHUNKS_PER_REQUEST = 256;
const MAX_CHUNKS_PER_BATCH = 384;
const MAX_BLOCK_UPDATE_BATCH_UPDATES = 4096;
const MAX_BLOCK_UPDATE_BATCH_CHUNKS = 256;
const REGION_SIZE_CHUNKS = 16;
const BATCH_WRITE_CONCURRENCY = 32;
const MAP_TILE_PREFIX = "map-tiles/v1/";
const MAP_TILE_SIZE = 256;
const EMPTY_PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 10,
  73, 68, 65, 84, 120, 1, 99, 0, 1, 0, 0, 5, 0, 1, 54, 208, 136, 221, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
const MAP_TILE_MIN_ZOOM = -1;
const MAP_TILE_MAX_ZOOM = 3;
const MAP_TILE_BASE_ZOOM = 4;
const MAP_TILE_WRITE_CONCURRENCY = 8;
const MAP_TILE_BACKFILL_WRITE_CONCURRENCY = 1;
const MAP_TILE_BACKFILL_READ_CONCURRENCY = 4;
const MAP_TILE_BACKFILL_WRITE_LIMIT = 1;
const MAP_TILE_BACKFILL_DEFAULT_LIMIT = 25;
const MAP_TILE_BACKFILL_MAX_LIMIT = 100;
const EMPTY_CHUNK_PRUNE_WRITE_LIMIT = 8;
const CHUNK_DIRECT_READ_LIMIT = REGION_SIZE_CHUNKS * REGION_SIZE_CHUNKS;
const MIN_COLUMN_HEIGHT = -64;
const SEA_LEVEL = 63;
const WORLD_META_SAMPLE_LIMIT = 128;
const CLEANUP_CONFIRMATION = "delete-map-data-v1";
const CLEANUP_DEFAULT_LIMIT = 200;
const CLEANUP_MAX_LIMIT = 500;
const CLEANUP_PREFIXES = new Set(["chunks/v1/", "chunk-regions/v1/", MAP_TILE_PREFIX, "meta/v1/", "lands/v1/", "Bedrock_level/", "world/"]);
const TEXTURE_MANIFEST_KEY = "textures/v1/manifest.json";
const TEXTURE_ATLAS_KEY = "textures/v1/atlas.png";
const TEXTURE_REPORT_KEY = "textures/v1/report.json";
const WORLD_META_PREFIX = "meta/v1/";
const CHUNK_REGION_PREFIX = "chunk-regions/v1/";
const LAND_PREFIX = "lands/v1/";

export class LiveRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sessions.add(server);
      server.addEventListener("close", () => this.sessions.delete(server));
      server.addEventListener("error", () => this.sessions.delete(server));
      server.addEventListener("message", (event) => {
        if (url.searchParams.get("role") === "plugin") {
          this.broadcast(String(event.data), server);
        }
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      return json({ ok: true, sessions: this.sessions.size });
    }

    if (request.method === "POST" && url.pathname === "/broadcast") {
      const message = await request.text();
      this.broadcast(message);
      return json({ ok: true, sessions: this.sessions.size });
    }

    return json({ error: "not_found" }, 404);
  }

  broadcast(message, except = null) {
    for (const session of this.sessions) {
      if (session === except) {
        continue;
      }
      try {
        session.send(message);
      } catch {
        this.sessions.delete(session);
      }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      if (url.pathname === "/api/health") {
        return json({ ok: true, service: "endstone-live-map" });
      }

      if (url.pathname === "/api/live") {
        return fetchLiveRoom(request, env);
      }

      if (url.pathname === "/api/plugin/live") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        if (request.headers.get("Upgrade") === "websocket") {
          const wsUrl = new URL(request.url);
          wsUrl.searchParams.set("role", "plugin");
          return fetchLiveRoom(new Request(wsUrl, request), env);
        }
        const body = await request.text();
        await broadcastLive(env, body);
        return json({ ok: true });
      }

      if (url.pathname === "/api/plugin/chunks") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleChunkUpload(request, env, ctx);
      }

      if (url.pathname === "/api/plugin/chunks/batch") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleChunkBatchUpload(request, env, ctx);
      }

      if (url.pathname === "/api/plugin/block-updates") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleBlockUpdatesUpload(request, env, ctx);
      }

      if (url.pathname === "/api/plugin/block-updates/batch") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleBlockUpdatesBatchUpload(request, env, ctx);
      }

      if (url.pathname === "/api/plugin/chunks/prune-empty") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleEmptyChunkPrune(request, env);
      }

      if (url.pathname === "/api/plugin/world-meta") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleWorldMetaUpload(request, env);
      }

      if (url.pathname === "/api/plugin/lands") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleLandUpload(request, env);
      }

      if (url.pathname === "/api/plugin/textures") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleTextureUpload(request, env);
      }

      if (url.pathname === "/api/plugin/map-data/cleanup") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleMapDataCleanup(request, env);
      }

      if (url.pathname === "/api/plugin/map-tiles/backfill") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleMapTileBackfill(request, env);
      }

      if (url.pathname.startsWith("/api/map-tiles/")) {
        return handleMapTileGet(url, env);
      }

      if (url.pathname === "/api/chunks") {
        return handleChunksGet(url, env);
      }

      if (url.pathname === "/api/worlds") {
        return handleWorldsGet(env);
      }

      if (url.pathname === "/api/world-meta") {
        return handleWorldMetaGet(url, env);
      }

      if (url.pathname === "/api/lands") {
        return handleLandsGet(url, env);
      }

      if (url.pathname === "/api/textures/manifest") {
        return handleTextureManifestGet(env);
      }

      if (url.pathname === "/api/textures/report") {
        return handleTextureReportGet(env);
      }

      if (url.pathname === "/textures/atlas.png") {
        return handleTextureAtlasGet(env);
      }

      if (url.pathname === "/api/markers" || url.pathname.startsWith("/api/markers/")) {
        return handleMarkers(request, env, url);
      }

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json({ error: "not_found" }, 404);
    } catch (error) {
      return json({ error: "internal_error", message: error instanceof Error ? error.message : String(error) }, 500);
    }
  },
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
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
  if (bearer !== env.PLUGIN_TOKEN && headerToken !== env.PLUGIN_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

function requireMarkerWriteAuth(request, env) {
  if (!env.MARKER_WRITE_TOKEN) {
    return null;
  }
  const auth = request.headers.get("Authorization") || "";
  if (auth !== `Bearer ${env.MARKER_WRITE_TOKEN}`) {
    return json({ error: "marker_write_unauthorized" }, 401);
  }
  return null;
}

function fetchLiveRoom(request, env) {
  const id = env.LIVE_ROOM.idFromName("global");
  return env.LIVE_ROOM.get(id).fetch(request);
}

async function getLiveStats(env) {
  const id = env.LIVE_ROOM.idFromName("global");
  const response = await env.LIVE_ROOM.get(id).fetch("https://live-room/stats");
  return response.json();
}

async function broadcastLive(env, message) {
  const id = env.LIVE_ROOM.idFromName("global");
  const response = await env.LIVE_ROOM.get(id).fetch("https://live-room/broadcast", { method: "POST", body: message });
  return response.json();
}

function mapBucket(env) {
  return env.MAP_DATA || env.MAP_TILES || null;
}

async function handleChunkUpload(request, env, ctx) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const snapshot = normalizeChunkSnapshot(await request.json());
  const emptySnapshots = rejectedEmptyChunkSnapshots([snapshot]);
  if (emptySnapshots.length > 0) {
    return json({ ok: true, skippedEmpty: 1, rejected: emptySnapshots, updates: 0 });
  }
  const result = await putChunkSnapshot(bucket, snapshot, { env, broadcast: false, diffForViewers: true });
  const tiles = await scheduleMapTilesForChunks(ctx, bucket, [snapshot]);
  await broadcastChunkSnapshot(env, snapshot, result.blockUpdates);
  await scheduleWorldMetaForChunks(ctx, bucket, [snapshot]);
  return json({ ok: true, key: result.key, updates: result.updates, tiles });
}

async function handleChunkBatchUpload(request, env, ctx) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const payload = await request.json();
  const rawChunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  if (rawChunks.length < 1 || rawChunks.length > MAX_CHUNKS_PER_BATCH) {
    return json({ error: "invalid_chunk_batch", max: MAX_CHUNKS_PER_BATCH }, 400);
  }

  const snapshots = rawChunks.map((chunk) => normalizeChunkSnapshot(chunk));
  const broadcast = payload.broadcast === true;
  const storage = payload.storage === "region" || payload.storage === "regions" ? "region" : "chunk";
  const emptySnapshots = rejectedEmptyChunkSnapshots(snapshots);
  const writableSnapshots = snapshots.filter((snapshot) => !isEmptyChunkSnapshot(snapshot));
  if (writableSnapshots.length < 1) {
    return json({ ok: true, storage, chunks: 0, skippedEmpty: emptySnapshots.length, rejected: emptySnapshots, keys: [], updates: 0 });
  }

  if (storage === "region") {
    const results = await putChunkRegionSnapshots(bucket, writableSnapshots);
    const tiles = await scheduleMapTilesForChunks(ctx, bucket, writableSnapshots);
    if (broadcast) {
      await broadcastChunksReady(env, writableSnapshots);
    }
    await scheduleWorldMetaForChunks(ctx, bucket, writableSnapshots);
    return json({
      ok: true,
      storage,
      chunks: writableSnapshots.length,
      skippedEmpty: emptySnapshots.length,
      rejected: emptySnapshots,
      regions: results.length,
      keys: results.map((result) => result.key),
      updates: 0,
      tiles,
    });
  }

  const results = await mapWithConcurrency(writableSnapshots, BATCH_WRITE_CONCURRENCY, (snapshot) => putChunkSnapshot(bucket, snapshot, { env, broadcast: false, diffForViewers: broadcast }));
  const tiles = await scheduleMapTilesForChunks(ctx, bucket, writableSnapshots);
  if (broadcast) {
    await mapWithConcurrency(results, MAP_TILE_WRITE_CONCURRENCY, (result, index) => broadcastChunkSnapshot(env, writableSnapshots[index], result.blockUpdates));
  }
  await scheduleWorldMetaForChunks(ctx, bucket, writableSnapshots);

  return json({
    ok: true,
    storage,
    chunks: results.length,
    skippedEmpty: emptySnapshots.length,
    rejected: emptySnapshots,
    keys: results.map((result) => result.key),
    updates: results.reduce((sum, result) => sum + result.updates, 0),
    tiles,
  });
}

async function handleBlockUpdatesUpload(request, env, ctx) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const payload = normalizeBlockUpdateBatch(await request.json());
  const result = await applyBlockUpdateBatchToStorage(bucket, payload);
  if (result.missingBase) {
    return json({ ok: true, missingBase: true, key: result.key, updates: 0 });
  }
  const tiles = result.applied.length > 0 ? await scheduleMapTilesForChunks(ctx, bucket, [result.chunk]) : [];
  const tileVersion = payload.updatedAt;

  if (result.applied.length > 0) {
    await broadcastBlockUpdates(env, result.chunk, result.applied, tileVersion);
  }

  return json({ ok: true, missingBase: false, key: result.key, updates: result.applied.length, tiles });
}

async function handleBlockUpdatesBatchUpload(request, env, ctx) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  let payload;
  try {
    payload = normalizeBlockUpdateBatches(await request.json());
  } catch (error) {
    return json({ error: "invalid_block_update_batch", message: error instanceof Error ? error.message : String(error) }, 400);
  }
  const results = await mapWithConcurrency(payload.batches, BATCH_WRITE_CONCURRENCY, (batch) => applyBlockUpdateBatchToStorage(bucket, batch));
  const appliedResults = results.filter((result) => !result.missingBase && result.applied.length > 0);
  const updatedChunks = appliedResults.map((result) => result.chunk);
  const tiles = updatedChunks.length > 0 ? await scheduleMapTilesForChunks(ctx, bucket, updatedChunks) : [];
  if (updatedChunks.length > 0) {
    await scheduleWorldMetaForChunks(ctx, bucket, updatedChunks);
  }
  await mapWithConcurrency(appliedResults, MAP_TILE_WRITE_CONCURRENCY, (result) => broadcastBlockUpdates(env, result.chunk, result.applied, result.chunk.updatedAt));

  const missingBase = results
    .filter((result) => result.missingBase)
    .map((result) => ({
      world: result.batch.world,
      dimension: result.batch.dimension,
      chunkX: result.batch.chunkX,
      chunkZ: result.batch.chunkZ,
      key: result.key,
    }));
  const applied = appliedResults.reduce((sum, result) => sum + result.applied.length, 0);
  return json({
    ok: true,
    missingBase: missingBase.length > 0,
    missingBaseChunks: missingBase,
    chunks: appliedResults.length,
    updates: applied,
    tiles,
  });
}

async function applyBlockUpdateBatchToStorage(bucket, payload) {
  const key = chunkKey(payload.world, payload.dimension, payload.chunkX, payload.chunkZ);
  const existing = await readR2Json(await bucket.get(key));
  if (!existing) {
    return { batch: payload, key, missingBase: true, applied: [], chunk: null };
  }

  const chunk = normalizeChunkSnapshot(existing);
  const applied = applyBlockUpdatesToChunk(chunk, payload.updates);
  chunk.updatedAt = payload.updatedAt;
  await bucket.put(key, JSON.stringify(chunk), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { world: chunk.world, dimension: chunk.dimension },
  });
  return { batch: payload, key, missingBase: false, applied, chunk };
}

async function broadcastBlockUpdates(env, chunk, updates, tileVersion) {
  await broadcastLive(
    env,
    JSON.stringify({
      type: "block_updates",
      world: chunk.world,
      dimension: chunk.dimension,
      chunkX: chunk.chunkX,
      chunkZ: chunk.chunkZ,
      updates,
      updatedAt: chunk.updatedAt,
      tileVersion,
    }),
  );
}

async function putChunkSnapshot(bucket, snapshot, options) {
  const key = chunkKey(snapshot.world, snapshot.dimension, snapshot.chunkX, snapshot.chunkZ);
  const stats = options.diffForViewers ? await getLiveStats(options.env).catch(() => ({ sessions: 0 })) : { sessions: 0 };
  let updates = [];

  if (stats.sessions > 0) {
    const previous = await readR2Json(await bucket.get(key));
    updates = previous ? diffChunkSnapshots(previous, snapshot) : [];
  }

  await bucket.put(key, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { world: snapshot.world, dimension: snapshot.dimension },
  });

  if (options.broadcast) {
    await broadcastChunkSnapshot(options.env, snapshot, updates);
  }

  return { key, updates: updates.length, blockUpdates: updates };
}

async function broadcastChunkSnapshot(env, snapshot, updates = []) {
  const tileVersion = snapshot.updatedAt;
  await broadcastLive(
    env,
    JSON.stringify({
      type: "chunk_ready",
      world: snapshot.world,
      dimension: snapshot.dimension,
      chunkX: snapshot.chunkX,
      chunkZ: snapshot.chunkZ,
      updatedAt: snapshot.updatedAt,
      tileVersion,
    }),
  );

  if (updates.length > 0) {
    await broadcastLive(
      env,
      JSON.stringify({
        type: "block_updates",
        world: snapshot.world,
        dimension: snapshot.dimension,
        chunkX: snapshot.chunkX,
        chunkZ: snapshot.chunkZ,
        updates,
        updatedAt: snapshot.updatedAt,
        tileVersion,
      }),
    );
  }
}

async function broadcastChunksReady(env, snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const key = `${snapshot.world}\n${snapshot.dimension}`;
    if (!groups.has(key)) {
      groups.set(key, { world: snapshot.world, dimension: snapshot.dimension, chunks: [], updatedAt: 0 });
    }
    const group = groups.get(key);
    const updatedAt = snapshot.updatedAt || 0;
    group.updatedAt = Math.max(group.updatedAt, updatedAt);
    group.chunks.push({ chunkX: snapshot.chunkX, chunkZ: snapshot.chunkZ, updatedAt });
  }

  await mapWithConcurrency([...groups.values()], MAP_TILE_WRITE_CONCURRENCY, (group) =>
    broadcastLive(
      env,
      JSON.stringify({
        type: "chunks_ready",
        world: group.world,
        dimension: group.dimension,
        chunks: group.chunks,
        updatedAt: group.updatedAt,
        tileVersion: group.updatedAt,
      }),
    ),
  );
}

function rejectedEmptyChunkSnapshots(snapshots) {
  return snapshots
    .filter((snapshot) => isEmptyChunkSnapshot(snapshot))
    .map((snapshot) => ({
      key: chunkKey(snapshot.world, snapshot.dimension, snapshot.chunkX, snapshot.chunkZ),
      world: snapshot.world,
      dimension: snapshot.dimension,
      chunkX: snapshot.chunkX,
      chunkZ: snapshot.chunkZ,
    }));
}

function isEmptyChunkSnapshot(snapshot) {
  for (let index = 0; index < CHUNK_BLOCK_COUNT; index += 1) {
    const block = snapshot.palette[snapshot.blocks[index]] || "minecraft:air";
    if (!isAirBlock(block) || snapshot.heights[index] > -64) {
      return false;
    }
    const overlayBlock = snapshot.palette[snapshot.overlayBlocks[index]] || "minecraft:air";
    if (!isAirBlock(overlayBlock) && snapshot.overlayHeights[index] > -64) {
      return false;
    }
  }
  return true;
}

function isAirBlock(block) {
  const id = String(block || "minecraft:air").toLowerCase();
  return id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air" || id === "air" || id === "cave_air" || id === "void_air";
}

async function handleChunksGet(url, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const query = normalizeChunkQuery(url.searchParams);
  const summaryOnly = url.searchParams.get("summary") === "1" || url.searchParams.get("summary") === "true";
  const chunkCount = (query.maxChunkX - query.minChunkX + 1) * (query.maxChunkZ - query.minChunkZ + 1);
  if (chunkCount > MAX_CHUNKS_PER_REQUEST) {
    return json({ error: "too_many_chunks", max: MAX_CHUNKS_PER_REQUEST }, 400);
  }

  const chunks = [];
  const missing = [];
  const chunksByCoord = summaryOnly ? await readChunkSummariesForRange(bucket, query) : await readChunksForRange(bucket, query);

  for (let chunkZ = query.minChunkZ; chunkZ <= query.maxChunkZ; chunkZ += 1) {
    for (let chunkX = query.minChunkX; chunkX <= query.maxChunkX; chunkX += 1) {
      const key = coordKey(chunkX, chunkZ);
      const chunk = chunksByCoord.get(key);
      if (!chunk) {
        missing.push({ chunkX, chunkZ });
      } else {
        chunks.push(chunk);
      }
    }
  }

  chunks.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
  missing.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
  return json({ chunks, missing }, 200, { "Cache-Control": "public, max-age=15" });
}

function chunkSummary(chunk) {
  return {
    world: chunk.world,
    dimension: chunk.dimension,
    chunkX: chunk.chunkX,
    chunkZ: chunk.chunkZ,
    updatedAt: chunk.updatedAt,
    hasNonAir: !isEmptyChunkSnapshot(chunk),
  };
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
    return pngResponse(EMPTY_PNG, { "Cache-Control": "public, max-age=60" });
  }
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata?.(headers);
  headers.set("Content-Type", headers.get("Content-Type") || "image/png");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

function pngResponse(body, extraHeaders = {}) {
  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "image/png",
      ...extraHeaders,
    },
  });
}

async function handleMapTileBackfill(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const payload = normalizeMapTileBackfillPayload(await request.json());
  const tiles = mapTilesForChunkRange(payload);
  const start = payload.cursor ? Math.max(0, Math.min(tiles.length, Number(payload.cursor) || 0)) : 0;
  const effectiveLimit = payload.dryRun ? payload.limit : Math.min(payload.limit, MAP_TILE_BACKFILL_WRITE_LIMIT);
  const selected = tiles.slice(start, start + effectiveLimit);
  const nextCursor = start + selected.length < tiles.length ? String(start + selected.length) : null;
  const rebuildVersion = payload.force ? Date.now() : 0;
  const tileRefs = selected.map((tile) => ({
    zoom: tile.zoom,
    tileX: tile.tileX,
    tileZ: tile.tileZ,
    key: mapTileKey(tile.world, tile.dimension, tile.zoom, tile.tileX, tile.tileZ),
  }));

  const results = payload.dryRun
    ? []
    : await rebuildMapTiles(bucket, selected, {
        force: payload.force,
        rebuildVersion,
        concurrency: MAP_TILE_BACKFILL_WRITE_CONCURRENCY,
        readConcurrency: MAP_TILE_BACKFILL_READ_CONCURRENCY,
      });
  if (!payload.dryRun && rebuildVersion > 0 && results.some((tile) => !tile.skipped)) {
    await touchWorldMetaTileVersion(bucket, payload.world, payload.dimension, rebuildVersion);
  }

  return json({
    ok: true,
    dryRun: payload.dryRun,
    force: payload.force,
    total: tiles.length,
    matched: selected.length,
    written: payload.dryRun ? 0 : results.filter((tile) => !tile.deleted).length,
    cursor: nextCursor,
    tiles: payload.dryRun ? tileRefs : results,
  });
}

async function handleTextureManifestGet(env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const object = await bucket.get(TEXTURE_MANIFEST_KEY);
  if (!object) {
    return json({ error: "texture_manifest_not_found" }, 404);
  }
  return json(await readR2Json(object), 200, { "Cache-Control": "public, max-age=3600" });
}

async function handleTextureReportGet(env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const object = await bucket.get(TEXTURE_REPORT_KEY);
  if (!object) {
    return json({ error: "texture_report_not_found" }, 404);
  }
  return json(await readR2Json(object), 200, { "Cache-Control": "public, max-age=3600" });
}

async function handleTextureAtlasGet(env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const object = await bucket.get(TEXTURE_ATLAS_KEY);
  if (!object) {
    return new Response("texture atlas not found", { status: 404, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata?.(headers);
  headers.set("Content-Type", headers.get("Content-Type") || "image/png");
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(object.body, { headers });
}

async function handleTextureUpload(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const payload = await request.json();
  const atlas = decodeBase64(payload.atlas);
  const manifest = normalizeTextureJson(payload.manifest, "manifest");
  const report = normalizeTextureJson(payload.report || {}, "report");

  await bucket.put(TEXTURE_ATLAS_KEY, atlas, {
    httpMetadata: { contentType: "image/png" },
  });
  await bucket.put(TEXTURE_MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  await bucket.put(TEXTURE_REPORT_KEY, JSON.stringify(report), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });

  return json({ ok: true, keys: [TEXTURE_ATLAS_KEY, TEXTURE_MANIFEST_KEY, TEXTURE_REPORT_KEY] });
}

async function handleWorldMetaUpload(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const meta = normalizeWorldMeta(await request.json());
  const key = worldMetaKey(meta.world, meta.dimension);
  await bucket.put(key, JSON.stringify(meta), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { world: meta.world, dimension: meta.dimension },
  });
  return json({ ok: true, key });
}

async function handleLandUpload(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const payload = normalizeLandPayload(await request.json());
  const groups = new Map();
  for (const claim of payload.claims) {
    const key = `${claim.world}/${claim.dimension}`;
    if (!groups.has(key)) {
      groups.set(key, {
        version: 1,
        world: claim.world,
        dimension: claim.dimension,
        claims: [],
        updatedAt: payload.updatedAt,
      });
    }
    groups.get(key).claims.push(claim);
  }

  const writes = [];
  for (const group of groups.values()) {
    group.claims.sort((a, b) => a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
    const key = landKey(group.world, group.dimension);
    await bucket.put(key, JSON.stringify(group), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { world: group.world, dimension: group.dimension },
    });
    writes.push({ key, world: group.world, dimension: group.dimension, claims: group.claims.length });
    await broadcastLive(env, JSON.stringify({ type: "lands_updated", world: group.world, dimension: group.dimension, updatedAt: group.updatedAt }));
  }

  return json({ ok: true, claims: payload.claims.length, groups: writes });
}

async function updateWorldMetaForChunks(bucket, snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const key = `${snapshot.world}/${snapshot.dimension}`;
    if (!groups.has(key)) {
      groups.set(key, { world: snapshot.world, dimension: snapshot.dimension, chunks: new Map() });
    }
    groups.get(key).chunks.set(coordKey(snapshot.chunkX, snapshot.chunkZ), snapshot);
  }

  await Promise.all(
    [...groups.values()].map(async (group) => {
      const chunks = [...group.chunks.values()];
      if (chunks.length === 0) {
        return;
      }

      const key = worldMetaKey(group.world, group.dimension);
      const existing = normalizeOptionalWorldMeta(await readR2Json(await bucket.get(key)));
      const previousBounds = existing?.bounds || null;
      const bounds = expandWorldBounds(previousBounds, chunks);
      const newChunks = previousBounds ? chunks.filter((chunk) => !chunkWithinBounds(chunk, previousBounds)) : chunks;
      const importedAt = existing?.importedAt ?? Math.min(...chunks.map((chunk) => chunk.updatedAt));
      const updatedAt = Math.max(existing?.updatedAt ?? 0, ...chunks.map((chunk) => chunk.updatedAt), Date.now());
      const topBlocks = mergeTopBlockCounts(existing?.topBlocks || {}, summarizeChunkTopBlocks(previousBounds ? newChunks : chunks));
      const sampleChunks = selectWorldSampleChunks(bounds, [
        ...(existing?.sampleChunks || []),
        ...chunks.map((chunk) => ({ chunkX: chunk.chunkX, chunkZ: chunk.chunkZ })),
      ]);
      const meta = {
        version: existing?.version ?? 1,
        world: group.world,
        dimension: group.dimension,
        status: existing?.status || "live",
        chunkCount: (existing?.chunkCount ?? 0) + (previousBounds ? newChunks.length : chunks.length),
        importedAt,
        updatedAt,
        bounds,
        sampleChunks,
        topBlocks,
      };

      await bucket.put(key, JSON.stringify(meta), {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: { world: meta.world, dimension: meta.dimension },
      });
    }),
  );
}

async function touchWorldMetaTileVersion(bucket, world, dimension, updatedAt) {
  const key = worldMetaKey(world, dimension);
  const existing = normalizeOptionalWorldMeta(await readR2Json(await bucket.get(key)));
  if (!existing) {
    return;
  }
  const next = {
    ...existing,
    updatedAt: Math.max(existing.updatedAt || 0, updatedAt),
  };
  await bucket.put(key, JSON.stringify(next), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { world: next.world, dimension: next.dimension },
  });
}

async function handleWorldsGet(env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const objects = await listR2Objects(bucket, WORLD_META_PREFIX);
  const worlds = [];
  await Promise.all(
    objects
      .filter((object) => object.key.endsWith(".json"))
      .map(async (object) => {
        const value = await readR2Json(await bucket.get(object.key));
        if (value) {
          worlds.push(await withWorldSampleChunks(bucket, value));
        }
      }),
  );
  worlds.sort((a, b) => String(a.world).localeCompare(String(b.world)) || String(a.dimension).localeCompare(String(b.dimension)));
  return json({ worlds }, 200, { "Cache-Control": "public, max-age=30" });
}

async function handleWorldMetaGet(url, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const world = cleanSegment(url.searchParams.get("world") || "world");
  const dimension = cleanSegment(url.searchParams.get("dimension") || "Overworld");
  const object = await bucket.get(worldMetaKey(world, dimension));
  if (!object) {
    return json({ error: "world_meta_not_found" }, 404);
  }
  const meta = await readR2Json(object);
  return json(await withWorldSampleChunks(bucket, meta), 200, { "Cache-Control": "public, max-age=30" });
}

async function withWorldSampleChunks(bucket, meta) {
  const normalized = normalizeOptionalWorldMeta(meta);
  if (!normalized) {
    return meta;
  }
  if (normalized.sampleChunks.length > 0) {
    return normalized;
  }
  return {
    ...normalized,
    sampleChunks: await listWorldSampleChunks(bucket, normalized),
  };
}

async function listWorldSampleChunks(bucket, meta) {
  const chunks = new Map();
  const addChunk = (chunkX, chunkZ) => {
    const x = Number(chunkX);
    const z = Number(chunkZ);
    if (!Number.isFinite(x) || !Number.isFinite(z) || !chunkWithinBounds({ chunkX: x, chunkZ: z }, meta.bounds)) {
      return;
    }
    chunks.set(coordKey(x, z), { chunkX: x, chunkZ: z });
  };

  const regionObjects = await listR2Objects(bucket, `${CHUNK_REGION_PREFIX}${cleanSegment(meta.world)}/${cleanSegment(meta.dimension)}/`);
  for (const object of regionObjects) {
    if (chunks.size >= WORLD_META_SAMPLE_LIMIT) {
      break;
    }
    const region = await readR2Json(await bucket.get(object.key));
    for (const chunk of Array.isArray(region?.chunks) ? region.chunks : []) {
      addChunk(chunk.chunkX, chunk.chunkZ);
      if (chunks.size >= WORLD_META_SAMPLE_LIMIT) {
        break;
      }
    }
  }

  if (chunks.size < WORLD_META_SAMPLE_LIMIT) {
    const chunkObjects = await listR2Objects(bucket, `chunks/v1/${cleanSegment(meta.world)}/${cleanSegment(meta.dimension)}/`);
    for (const object of chunkObjects) {
      const parsed = parseChunkKey(object.key);
      if (parsed) {
        addChunk(parsed.chunkX, parsed.chunkZ);
      }
      if (chunks.size >= WORLD_META_SAMPLE_LIMIT) {
        break;
      }
    }
  }

  return [...chunks.values()].sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
}

async function handleLandsGet(url, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const world = cleanSegment(url.searchParams.get("world") || "world");
  const dimension = cleanSegment(url.searchParams.get("dimension") || "Overworld");
  const object = await bucket.get(landKey(world, dimension));
  if (!object) {
    return json({ version: 1, world, dimension, claims: [], updatedAt: 0 }, 200, { "Cache-Control": "public, max-age=15" });
  }
  return json(await readR2Json(object), 200, { "Cache-Control": "public, max-age=15" });
}

async function handleMapDataCleanup(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const payload = await request.json();
  let cleanup;
  try {
    cleanup = normalizeCleanupPayload(payload);
  } catch (error) {
    return json({ error: "cleanup_prefix_not_allowed", message: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (!cleanup.dryRun && cleanup.confirm !== CLEANUP_CONFIRMATION) {
    return json({ error: "cleanup_confirmation_required", confirm: CLEANUP_CONFIRMATION }, 400);
  }

  const page = await bucket.list({ prefix: cleanup.prefix, cursor: cleanup.cursor || undefined, limit: cleanup.limit });
  const keys = (page.objects || []).map((object) => object.key).filter((key) => key.startsWith(cleanup.prefix) && !key.startsWith("textures/v1/"));
  if (!cleanup.dryRun) {
    await mapWithConcurrency(keys, 25, (key) => bucket.delete(key));
  }

  return json({
    ok: true,
    dryRun: cleanup.dryRun,
    prefix: cleanup.prefix,
    deleted: cleanup.dryRun ? 0 : keys.length,
    matched: keys.length,
    keys,
    truncated: page.truncated === true,
    cursor: page.truncated ? page.cursor : null,
  });
}

async function handleEmptyChunkPrune(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }
  const payload = normalizeEmptyChunkPrunePayload(await request.json());
  const chunks = await findEmptyChunksForRange(bucket, payload);
  const selected = chunks.slice(0, payload.limit);
  const tiles = uniqueMapTilesForChunks(selected);
  if (!payload.dryRun) {
    await deleteEmptyChunkObjects(bucket, selected);
    await pruneEmptyChunksFromRegions(bucket, selected);
    await rebuildMapTiles(bucket, tiles, {
      force: true,
      concurrency: MAP_TILE_BACKFILL_WRITE_CONCURRENCY,
      readConcurrency: MAP_TILE_BACKFILL_READ_CONCURRENCY,
    });
  }
  return json({
    ok: true,
    dryRun: payload.dryRun,
    matched: selected.length,
    remaining: Math.max(0, chunks.length - selected.length),
    deleted: payload.dryRun ? 0 : selected.length,
    tiles: tiles.length,
    chunks: selected.map(({ world, dimension, chunkX, chunkZ }) => ({ world, dimension, chunkX, chunkZ })),
  });
}

async function handleMarkers(request, env, url) {
  const id = url.pathname.startsWith("/api/markers/") ? decodeURIComponent(url.pathname.slice("/api/markers/".length)) : "";

  if (request.method === "GET" && !id) {
    const markers = await listMarkers(env);
    return json({ markers });
  }

  if (request.method === "POST" && !id) {
    const auth = requireMarkerWriteAuth(request, env);
    if (auth) {
      return auth;
    }
    const marker = normalizeMarkerPayload(await request.json());
    marker.id = crypto.randomUUID();
    marker.createdAt = Date.now();
    marker.updatedAt = marker.createdAt;
    await insertMarker(env, marker);
    await broadcastLive(env, JSON.stringify({ type: "marker_created", marker }));
    return json({ marker }, 201);
  }

  if ((request.method === "PUT" || request.method === "PATCH") && id) {
    const auth = requireMarkerWriteAuth(request, env);
    if (auth) {
      return auth;
    }
    const marker = normalizeMarkerPayload(await request.json());
    marker.id = id;
    marker.updatedAt = Date.now();
    await updateMarker(env, marker);
    await broadcastLive(env, JSON.stringify({ type: "marker_updated", marker }));
    return json({ marker });
  }

  if (request.method === "DELETE" && id) {
    const auth = requireMarkerWriteAuth(request, env);
    if (auth) {
      return auth;
    }
    await deleteMarker(env, id);
    await broadcastLive(env, JSON.stringify({ type: "marker_deleted", id }));
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

async function withMarkerConnection(env, fn) {
  if (env.MARKER_DB) {
    return fn(env.MARKER_DB);
  }
  if (!env.HYPERDRIVE) {
    throw new Error("hyperdrive_not_configured");
  }

  const connection = await createConnection({
    host: env.HYPERDRIVE.host,
    user: env.HYPERDRIVE.user,
    password: env.HYPERDRIVE.password,
    database: env.HYPERDRIVE.database,
    port: env.HYPERDRIVE.port,
    disableEval: true,
  });
  try {
    return await fn(connection);
  } finally {
    await connection.end();
  }
}

async function listMarkers(env) {
  return withMarkerConnection(env, async (connection) => {
    const [rows] = await connection.query(
      "SELECT id, world, dimension, x, y, z, title, description, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM markers ORDER BY updated_at DESC LIMIT 500",
    );
    return rows;
  });
}

async function insertMarker(env, marker) {
  await withMarkerConnection(env, (connection) =>
    connection.query(
      "INSERT INTO markers (id, world, dimension, x, y, z, title, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        marker.id,
        marker.world,
        marker.dimension,
        marker.x,
        marker.y,
        marker.z,
        marker.title,
        marker.description,
        marker.createdBy,
        marker.createdAt,
        marker.updatedAt,
      ],
    ),
  );
}

async function updateMarker(env, marker) {
  await withMarkerConnection(env, (connection) =>
    connection.query(
      "UPDATE markers SET world = ?, dimension = ?, x = ?, y = ?, z = ?, title = ?, description = ?, created_by = ?, updated_at = ? WHERE id = ?",
      [marker.world, marker.dimension, marker.x, marker.y, marker.z, marker.title, marker.description, marker.createdBy, marker.updatedAt, marker.id],
    ),
  );
}

async function deleteMarker(env, id) {
  await withMarkerConnection(env, (connection) => connection.query("DELETE FROM markers WHERE id = ?", [id]));
}

export function normalizeChunkSnapshot(payload) {
  const palette = Array.isArray(payload.palette) ? payload.palette.map((value) => cleanBlockId(value)) : [];
  if (!palette.includes("minecraft:air")) {
    palette.push("minecraft:air");
  }
  if (palette.length < 1 || palette.length > MAX_CHUNK_PALETTE_SIZE) {
    throw new Error(`palette must contain 1-${MAX_CHUNK_PALETTE_SIZE} block ids`);
  }
  const blocks = normalizeFixedNumberArray(payload.blocks, "blocks", CHUNK_BLOCK_COUNT).map((value) => {
    if (value < 0 || value >= palette.length) {
      throw new Error("block palette index out of range");
    }
    return value;
  });
  const heights = normalizeFixedNumberArray(payload.heights, "heights", CHUNK_BLOCK_COUNT);
  const blockStates = normalizeOptionalStateArray(payload.blockStates, "blockStates", CHUNK_BLOCK_COUNT);
  const overlayBlocks = normalizeOptionalPaletteArray(payload.overlayBlocks, "overlayBlocks", CHUNK_BLOCK_COUNT, palette);
  const overlayHeights = Array.isArray(payload.overlayHeights)
    ? normalizeFixedNumberArray(payload.overlayHeights, "overlayHeights", CHUNK_BLOCK_COUNT)
    : Array.from({ length: CHUNK_BLOCK_COUNT }, () => -64);
  const overlayStates = normalizeOptionalStateArray(payload.overlayStates, "overlayStates", CHUNK_BLOCK_COUNT);

  return {
    world: cleanSegment(payload.world || "world"),
    dimension: cleanSegment(payload.dimension || "Overworld"),
    chunkX: numberOrThrow(payload.chunkX, "chunkX"),
    chunkZ: numberOrThrow(payload.chunkZ, "chunkZ"),
    palette,
    blocks,
    heights,
    blockStates,
    overlayBlocks,
    overlayHeights,
    overlayStates,
    updatedAt: numberOrThrow(payload.updatedAt ?? Date.now(), "updatedAt"),
  };
}

export function normalizeChunkBatchPayload(payload) {
  const chunks = Array.isArray(payload.chunks) ? payload.chunks.map((chunk) => normalizeChunkSnapshot(chunk)) : [];
  if (chunks.length < 1 || chunks.length > MAX_CHUNKS_PER_BATCH) {
    throw new Error(`chunks must contain 1-${MAX_CHUNKS_PER_BATCH} entries`);
  }
  const storage = payload.storage === "region" || payload.storage === "regions" ? "region" : "chunk";
  return { chunks, broadcast: payload.broadcast === true, storage };
}

export function normalizeBlockUpdateBatch(payload) {
  const updates = Array.isArray(payload.updates) ? payload.updates.map((update) => normalizeBlockUpdate(update)) : [];
  if (updates.length < 1 || updates.length > CHUNK_BLOCK_COUNT) {
    throw new Error("updates must contain 1-256 entries");
  }
  return {
    world: cleanSegment(payload.world || "world"),
    dimension: cleanSegment(payload.dimension || "Overworld"),
    chunkX: numberOrThrow(payload.chunkX, "chunkX"),
    chunkZ: numberOrThrow(payload.chunkZ, "chunkZ"),
    updates,
    updatedAt: numberOrThrow(payload.updatedAt ?? Date.now(), "updatedAt"),
  };
}

export function normalizeBlockUpdateBatches(payload) {
  const batches = Array.isArray(payload.batches) ? payload.batches.map((batch) => normalizeBlockUpdateBatch(batch)) : [];
  if (batches.length < 1 || batches.length > MAX_BLOCK_UPDATE_BATCH_CHUNKS) {
    throw new Error(`batches must contain 1-${MAX_BLOCK_UPDATE_BATCH_CHUNKS} entries`);
  }
  const totalUpdates = batches.reduce((sum, batch) => sum + batch.updates.length, 0);
  if (totalUpdates > MAX_BLOCK_UPDATE_BATCH_UPDATES) {
    throw new Error(`updates must contain 1-${MAX_BLOCK_UPDATE_BATCH_UPDATES} total entries`);
  }
  const seen = new Set();
  for (const batch of batches) {
    const key = `${batch.world}\0${batch.dimension}\0${batch.chunkX}\0${batch.chunkZ}`;
    if (seen.has(key)) {
      throw new Error("duplicate chunk update batch");
    }
    seen.add(key);
  }
  return { batches, totalUpdates };
}

function normalizeBlockUpdate(update) {
  const localX = numberOrThrow(update.localX, "updates.localX");
  const localZ = numberOrThrow(update.localZ, "updates.localZ");
  if (localX < 0 || localX >= 16 || localZ < 0 || localZ >= 16) {
    throw new Error("block update local coordinates out of range");
  }
  return {
    localX,
    localZ,
    block: cleanBlockId(update.block || "minecraft:air"),
    height: numberOrThrow(update.height, "updates.height"),
    state: normalizeBlockStateMap(update.state || update.blockState || {}, "updates.state"),
    overlayBlock: cleanBlockId(update.overlayBlock || "minecraft:air"),
    overlayHeight: numberOrThrow(update.overlayHeight ?? -64, "updates.overlayHeight"),
    overlayState: normalizeBlockStateMap(update.overlayState || {}, "updates.overlayState"),
  };
}

export function normalizeWorldMeta(payload) {
  const world = cleanSegment(payload.world || "world");
  const dimension = cleanSegment(payload.dimension || "Overworld");
  const bounds = payload.bounds || {};
  const normalized = {
    version: numberOrThrow(payload.version ?? 1, "version"),
    world,
    dimension,
    status: cleanSegment(payload.status || "complete"),
    chunkCount: numberOrThrow(payload.chunkCount ?? payload.chunks ?? 0, "chunkCount"),
    importedAt: numberOrThrow(payload.importedAt ?? Date.now(), "importedAt"),
    updatedAt: numberOrThrow(payload.updatedAt ?? payload.importedAt ?? Date.now(), "updatedAt"),
    bounds: {
      minChunkX: numberOrThrow(bounds.minChunkX, "bounds.minChunkX"),
      maxChunkX: numberOrThrow(bounds.maxChunkX, "bounds.maxChunkX"),
      minChunkZ: numberOrThrow(bounds.minChunkZ, "bounds.minChunkZ"),
      maxChunkZ: numberOrThrow(bounds.maxChunkZ, "bounds.maxChunkZ"),
      minBlockX: numberOrThrow(bounds.minBlockX ?? bounds.minChunkX * 16, "bounds.minBlockX"),
      maxBlockX: numberOrThrow(bounds.maxBlockX ?? bounds.maxChunkX * 16 + 15, "bounds.maxBlockX"),
      minBlockZ: numberOrThrow(bounds.minBlockZ ?? bounds.minChunkZ * 16, "bounds.minBlockZ"),
      maxBlockZ: numberOrThrow(bounds.maxBlockZ ?? bounds.maxChunkZ * 16 + 15, "bounds.maxBlockZ"),
    },
    sampleChunks: normalizeSampleChunks(payload.sampleChunks || []),
    topBlocks: normalizeTopBlocks(payload.topBlocks || {}),
  };
  if (normalized.bounds.maxChunkX < normalized.bounds.minChunkX || normalized.bounds.maxChunkZ < normalized.bounds.minChunkZ) {
    throw new Error("invalid world bounds");
  }
  return normalized;
}

function normalizeOptionalWorldMeta(value) {
  if (!value) {
    return null;
  }
  try {
    return normalizeWorldMeta(value);
  } catch {
    return null;
  }
}

function normalizeOptionalChunkSnapshot(value) {
  if (!value) {
    return null;
  }
  try {
    return normalizeChunkSnapshot(value);
  } catch {
    return null;
  }
}

function normalizeSampleChunks(chunks) {
  if (!Array.isArray(chunks)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const chunk of chunks) {
    if (normalized.length >= WORLD_META_SAMPLE_LIMIT) {
      break;
    }
    const chunkX = Number(chunk?.chunkX);
    const chunkZ = Number(chunk?.chunkZ);
    if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) {
      continue;
    }
    const key = coordKey(chunkX, chunkZ);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ chunkX, chunkZ });
  }
  return normalized;
}

function selectWorldSampleChunks(bounds, chunks) {
  return normalizeSampleChunks(chunks)
    .filter((chunk) => chunkWithinBounds(chunk, bounds))
    .slice(0, WORLD_META_SAMPLE_LIMIT);
}

export function normalizeChunkQuery(params) {
  const minChunkX = numberOrThrow(params.get("minChunkX"), "minChunkX");
  const maxChunkX = numberOrThrow(params.get("maxChunkX"), "maxChunkX");
  const minChunkZ = numberOrThrow(params.get("minChunkZ"), "minChunkZ");
  const maxChunkZ = numberOrThrow(params.get("maxChunkZ"), "maxChunkZ");
  if (maxChunkX < minChunkX || maxChunkZ < minChunkZ) {
    throw new Error("invalid chunk range");
  }
  return {
    world: cleanSegment(params.get("world") || "world"),
    dimension: cleanSegment(params.get("dimension") || "Overworld"),
    minChunkX,
    maxChunkX,
    minChunkZ,
    maxChunkZ,
  };
}

export function normalizeCleanupPayload(payload) {
  const prefix = String(payload.prefix || "");
  if (!CLEANUP_PREFIXES.has(prefix) || prefix.startsWith("textures/v1/")) {
    throw new Error("cleanup prefix is not allowed");
  }
  const limit = Math.min(CLEANUP_MAX_LIMIT, Math.max(1, numberOrThrow(payload.limit ?? CLEANUP_DEFAULT_LIMIT, "limit")));
  return {
    prefix,
    limit,
    cursor: typeof payload.cursor === "string" && payload.cursor.length > 0 ? payload.cursor : "",
    dryRun: payload.dryRun !== false,
    confirm: String(payload.confirm || ""),
  };
}

export function normalizeMapTileBackfillPayload(payload) {
  const minChunkX = numberOrThrow(payload.minChunkX, "minChunkX");
  const maxChunkX = numberOrThrow(payload.maxChunkX, "maxChunkX");
  const minChunkZ = numberOrThrow(payload.minChunkZ, "minChunkZ");
  const maxChunkZ = numberOrThrow(payload.maxChunkZ, "maxChunkZ");
  if (maxChunkX < minChunkX || maxChunkZ < minChunkZ) {
    throw new Error("invalid chunk range");
  }
  const zooms =
    payload.zoom === undefined || payload.zoom === null
      ? range(MAP_TILE_MIN_ZOOM, MAP_TILE_MAX_ZOOM)
      : [normalizeMapTileZoom(payload.zoom)];
  const limit = Math.min(MAP_TILE_BACKFILL_MAX_LIMIT, Math.max(1, numberOrThrow(payload.limit ?? MAP_TILE_BACKFILL_DEFAULT_LIMIT, "limit")));
  return {
    world: cleanSegment(payload.world || "world"),
    dimension: cleanSegment(payload.dimension || "Overworld"),
    zooms,
    minChunkX,
    maxChunkX,
    minChunkZ,
    maxChunkZ,
    limit,
    cursor: typeof payload.cursor === "string" && payload.cursor.length > 0 ? payload.cursor : "",
    dryRun: payload.dryRun !== false,
    force: payload.force === true,
  };
}

export function normalizeEmptyChunkPrunePayload(payload) {
  const minChunkX = numberOrThrow(payload.minChunkX, "minChunkX");
  const maxChunkX = numberOrThrow(payload.maxChunkX, "maxChunkX");
  const minChunkZ = numberOrThrow(payload.minChunkZ, "minChunkZ");
  const maxChunkZ = numberOrThrow(payload.maxChunkZ, "maxChunkZ");
  if (maxChunkX < minChunkX || maxChunkZ < minChunkZ) {
    throw new Error("invalid chunk range");
  }
  return {
    world: cleanSegment(payload.world || "world"),
    dimension: cleanSegment(payload.dimension || "Overworld"),
    minChunkX,
    maxChunkX,
    minChunkZ,
    maxChunkZ,
    limit: Math.min(EMPTY_CHUNK_PRUNE_WRITE_LIMIT, Math.max(1, numberOrThrow(payload.limit ?? EMPTY_CHUNK_PRUNE_WRITE_LIMIT, "limit"))),
    dryRun: payload.dryRun !== false,
  };
}

export function normalizeMarkerPayload(payload) {
  const title = String(payload.title || "").trim();
  if (title.length < 1 || title.length > 80) {
    throw new Error("marker title must be 1-80 characters");
  }
  return {
    world: cleanSegment(payload.world || "world"),
    dimension: cleanSegment(payload.dimension || "Overworld"),
    x: numberOrThrow(payload.x, "x"),
    y: numberOrThrow(payload.y ?? 64, "y"),
    z: numberOrThrow(payload.z, "z"),
    title,
    description: String(payload.description || "").slice(0, 2000),
    createdBy: String(payload.createdBy || "").slice(0, 80),
  };
}

export function normalizeLandPayload(payload) {
  const claims = Array.isArray(payload.claims) ? payload.claims.map((claim, index) => normalizeLandClaim(claim, index)) : [];
  return {
    claims,
    updatedAt: claims.reduce((max, claim) => Math.max(max, claim.updatedAt), numberOrThrow(payload.updatedAt ?? Date.now(), "updatedAt")),
  };
}

function normalizeLandClaim(payload, index) {
  const world = cleanSegment(payload.world || "Bedrock level");
  const dimension = cleanSegment(payload.dimension || "Overworld");
  const minX = numberOrThrow(payload.minX, `claims[${index}].minX`);
  const maxX = numberOrThrow(payload.maxX, `claims[${index}].maxX`);
  const minY = numberOrThrow(payload.minY, `claims[${index}].minY`);
  const maxY = numberOrThrow(payload.maxY, `claims[${index}].maxY`);
  const minZ = numberOrThrow(payload.minZ, `claims[${index}].minZ`);
  const maxZ = numberOrThrow(payload.maxZ, `claims[${index}].maxZ`);
  if (maxX < minX || maxY < minY || maxZ < minZ) {
    throw new Error(`claims[${index}] has invalid bounds`);
  }
  const teleport = payload.teleport || {};
  return {
    id: cleanText(payload.id || `${payload.owner || ""}:${payload.name || ""}:${dimension}`, 160),
    owner: cleanText(payload.owner, 80),
    name: cleanText(payload.name, 120),
    world,
    dimension,
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    teleport: {
      x: numberOrThrow(teleport.x, `claims[${index}].teleport.x`),
      y: numberOrThrow(teleport.y, `claims[${index}].teleport.y`),
      z: numberOrThrow(teleport.z, `claims[${index}].teleport.z`),
    },
    members: normalizeStringArray(payload.members, `claims[${index}].members`, 80),
    parent: cleanText(payload.parent || "", 120, false),
    children: normalizeStringArray(payload.children, `claims[${index}].children`, 120),
    nested: payload.nested === true || Boolean(payload.parent),
    publicTeleport: payload.publicTeleport === true,
    updatedAt: numberOrThrow(payload.updatedAt ?? Date.now(), `claims[${index}].updatedAt`),
  };
}

export function chunkKey(world, dimension, chunkX, chunkZ) {
  return `chunks/v1/${cleanSegment(world)}/${cleanSegment(dimension)}/${numberOrThrow(chunkX, "chunkX")}/${numberOrThrow(chunkZ, "chunkZ")}.json`;
}

export function chunkRegionKey(world, dimension, regionX, regionZ) {
  return `${CHUNK_REGION_PREFIX}${cleanSegment(world)}/${cleanSegment(dimension)}/${numberOrThrow(regionX, "regionX")}/${numberOrThrow(regionZ, "regionZ")}.json`;
}

export function worldMetaKey(world, dimension) {
  return `${WORLD_META_PREFIX}${cleanSegment(world)}/${cleanSegment(dimension)}.json`;
}

export function landKey(world, dimension) {
  return `${LAND_PREFIX}${cleanSegment(world)}/${cleanSegment(dimension)}.json`;
}

export function mapTileKey(world, dimension, zoom, tileX, tileZ) {
  return `${MAP_TILE_PREFIX}${cleanSegment(world)}/${cleanSegment(dimension)}/z${normalizeMapTileZoom(zoom)}/${numberOrThrow(tileX, "tileX")}/${numberOrThrow(tileZ, "tileZ")}.png`;
}

function chunkPrefix(world, dimension, chunkX) {
  return `chunks/v1/${cleanSegment(world)}/${cleanSegment(dimension)}/${numberOrThrow(chunkX, "chunkX")}/`;
}

async function putChunkRegionSnapshots(bucket, snapshots) {
  const groups = new Map();
  for (const snapshot of snapshots) {
    const regionX = floorDiv(snapshot.chunkX, REGION_SIZE_CHUNKS);
    const regionZ = floorDiv(snapshot.chunkZ, REGION_SIZE_CHUNKS);
    const key = chunkRegionKey(snapshot.world, snapshot.dimension, regionX, regionZ);
    if (!groups.has(key)) {
      groups.set(key, { key, world: snapshot.world, dimension: snapshot.dimension, regionX, regionZ, chunks: [] });
    }
    groups.get(key).chunks.push(snapshot);
  }

  return mapWithConcurrency([...groups.values()], BATCH_WRITE_CONCURRENCY, async (group) => {
    const existing = await readR2Json(await bucket.get(group.key));
    const chunks = new Map();
    for (const chunk of Array.isArray(existing?.chunks) ? existing.chunks : []) {
      chunks.set(coordKey(chunk.chunkX, chunk.chunkZ), chunk);
    }
    for (const chunk of group.chunks) {
      chunks.set(coordKey(chunk.chunkX, chunk.chunkZ), chunk);
    }

    const region = {
      version: 1,
      world: group.world,
      dimension: group.dimension,
      regionSize: REGION_SIZE_CHUNKS,
      regionX: group.regionX,
      regionZ: group.regionZ,
      updatedAt: Math.max(...[...chunks.values()].map((chunk) => chunk.updatedAt || 0)),
      chunks: [...chunks.values()].sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX),
    };
    await bucket.put(group.key, JSON.stringify(region), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { world: group.world, dimension: group.dimension },
    });
    return { key: group.key, chunks: region.chunks.length };
  });
}

async function readChunkRegions(bucket, query, chunksByCoord) {
  const minRegionX = floorDiv(query.minChunkX, REGION_SIZE_CHUNKS);
  const maxRegionX = floorDiv(query.maxChunkX, REGION_SIZE_CHUNKS);
  const minRegionZ = floorDiv(query.minChunkZ, REGION_SIZE_CHUNKS);
  const maxRegionZ = floorDiv(query.maxChunkZ, REGION_SIZE_CHUNKS);
  const keys = [];
  for (const regionX of range(minRegionX, maxRegionX)) {
    for (const regionZ of range(minRegionZ, maxRegionZ)) {
      keys.push(chunkRegionKey(query.world, query.dimension, regionX, regionZ));
    }
  }

  await Promise.all(
    keys.map(async (key) => {
      const region = await readR2Json(await bucket.get(key));
      for (const chunk of Array.isArray(region?.chunks) ? region.chunks : []) {
        const normalized = normalizeOptionalChunkSnapshot(chunk);
        if (!normalized || normalized.chunkX < query.minChunkX || normalized.chunkX > query.maxChunkX || normalized.chunkZ < query.minChunkZ || normalized.chunkZ > query.maxChunkZ) {
          continue;
        }
        chunksByCoord.set(coordKey(normalized.chunkX, normalized.chunkZ), normalized);
      }
    }),
  );
}

async function readChunkSummariesForRange(bucket, query) {
  const chunkCount = chunkCountForRange(query);
  if (chunkCount < CHUNK_DIRECT_READ_LIMIT) {
    const chunksByCoord = await readChunksForRange(bucket, query);
    return new Map([...chunksByCoord.entries()].map(([key, chunk]) => [key, chunkSummary(chunk)]));
  }

  const chunksByCoord = new Map();
  await readChunkRegionSummaries(bucket, query, chunksByCoord);

  const directKeys = await listChunkKeysForRange(bucket, query);
  for (const key of directKeys) {
    const parsed = parseChunkKey(key);
    if (!parsed || chunksByCoord.has(coordKey(parsed.chunkX, parsed.chunkZ))) {
      continue;
    }
    chunksByCoord.set(coordKey(parsed.chunkX, parsed.chunkZ), {
      world: parsed.world,
      dimension: parsed.dimension,
      chunkX: parsed.chunkX,
      chunkZ: parsed.chunkZ,
      hasNonAir: true,
    });
  }

  return chunksByCoord;
}

async function readChunkRegionSummaries(bucket, query, chunksByCoord) {
  const minRegionX = floorDiv(query.minChunkX, REGION_SIZE_CHUNKS);
  const maxRegionX = floorDiv(query.maxChunkX, REGION_SIZE_CHUNKS);
  const minRegionZ = floorDiv(query.minChunkZ, REGION_SIZE_CHUNKS);
  const maxRegionZ = floorDiv(query.maxChunkZ, REGION_SIZE_CHUNKS);
  const keys = [];
  for (const regionX of range(minRegionX, maxRegionX)) {
    for (const regionZ of range(minRegionZ, maxRegionZ)) {
      keys.push(chunkRegionKey(query.world, query.dimension, regionX, regionZ));
    }
  }

  await Promise.all(
    keys.map(async (key) => {
      const region = await readR2Json(await bucket.get(key));
      for (const chunk of Array.isArray(region?.chunks) ? region.chunks : []) {
        const chunkX = Number(chunk?.chunkX);
        const chunkZ = Number(chunk?.chunkZ);
        if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ) || chunkX < query.minChunkX || chunkX > query.maxChunkX || chunkZ < query.minChunkZ || chunkZ > query.maxChunkZ) {
          continue;
        }
        chunksByCoord.set(coordKey(chunkX, chunkZ), {
          world: cleanSegment(chunk.world || query.world),
          dimension: cleanSegment(chunk.dimension || query.dimension),
          chunkX,
          chunkZ,
          updatedAt: Number.isFinite(Number(chunk.updatedAt)) ? Number(chunk.updatedAt) : undefined,
          hasNonAir: true,
        });
      }
    }),
  );
}

async function readChunksForRange(bucket, query, options = {}) {
  const chunksByCoord = new Map();
  const chunkCount = chunkCountForRange(query);

  if (chunkCount >= CHUNK_DIRECT_READ_LIMIT) {
    await readChunkRegions(bucket, query, chunksByCoord);
  }

  const missingKeys = [];
  for (let chunkZ = query.minChunkZ; chunkZ <= query.maxChunkZ; chunkZ += 1) {
    for (let chunkX = query.minChunkX; chunkX <= query.maxChunkX; chunkX += 1) {
      if (!chunksByCoord.has(coordKey(chunkX, chunkZ))) {
        missingKeys.push(chunkKey(query.world, query.dimension, chunkX, chunkZ));
      }
    }
  }

  const readKeys = chunkCount < CHUNK_DIRECT_READ_LIMIT ? missingKeys : await listChunkKeysForRange(bucket, query);
  await mapWithConcurrency(readKeys, options.readConcurrency || BATCH_WRITE_CONCURRENCY, async (key) => {
    const chunk = normalizeOptionalChunkSnapshot(await readR2Json(await bucket.get(key)));
    if (chunk) {
      chunksByCoord.set(coordKey(chunk.chunkX, chunk.chunkZ), chunk);
    }
  });

  if (chunkCount < CHUNK_DIRECT_READ_LIMIT) {
    await readChunkRegions(bucket, query, chunksByCoord);
  }

  return chunksByCoord;
}

async function findEmptyChunksForRange(bucket, query) {
  const chunksByCoord = await readChunksForRange(bucket, query, { readConcurrency: MAP_TILE_BACKFILL_READ_CONCURRENCY });
  return [...chunksByCoord.values()]
    .filter((chunk) => isEmptyChunkSnapshot(chunk))
    .sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
}

async function deleteEmptyChunkObjects(bucket, chunks) {
  await mapWithConcurrency(chunks, MAP_TILE_BACKFILL_READ_CONCURRENCY, (chunk) => bucket.delete(chunkKey(chunk.world, chunk.dimension, chunk.chunkX, chunk.chunkZ)));
}

async function pruneEmptyChunksFromRegions(bucket, chunks) {
  const groups = new Map();
  for (const chunk of chunks) {
    const regionX = floorDiv(chunk.chunkX, REGION_SIZE_CHUNKS);
    const regionZ = floorDiv(chunk.chunkZ, REGION_SIZE_CHUNKS);
    const key = chunkRegionKey(chunk.world, chunk.dimension, regionX, regionZ);
    if (!groups.has(key)) {
      groups.set(key, { key, remove: new Set() });
    }
    groups.get(key).remove.add(coordKey(chunk.chunkX, chunk.chunkZ));
  }

  await mapWithConcurrency([...groups.values()], MAP_TILE_BACKFILL_READ_CONCURRENCY, async (group) => {
    const region = await readR2Json(await bucket.get(group.key));
    if (!region || !Array.isArray(region.chunks)) {
      return;
    }
    const kept = [];
    for (const chunk of region.chunks) {
      const normalized = normalizeOptionalChunkSnapshot(chunk);
      if (!normalized || group.remove.has(coordKey(normalized.chunkX, normalized.chunkZ))) {
        continue;
      }
      kept.push(normalized);
    }
    if (kept.length === 0) {
      await bucket.delete(group.key);
      return;
    }
    const nextRegion = {
      ...region,
      updatedAt: Math.max(...kept.map((chunk) => chunk.updatedAt || 0)),
      chunks: kept.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX),
    };
    await bucket.put(group.key, JSON.stringify(nextRegion), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: { world: nextRegion.world, dimension: nextRegion.dimension },
    });
  });
}

function uniqueMapTilesForChunks(chunks) {
  const seen = new Set();
  const tiles = [];
  for (const chunk of chunks) {
    for (const tile of mapTilesForChunk(chunk.world, chunk.dimension, chunk.chunkX, chunk.chunkZ)) {
      const key = mapTileKey(tile.world, tile.dimension, tile.zoom, tile.tileX, tile.tileZ);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      tiles.push(tile);
    }
  }
  return tiles;
}

async function scheduleMapTilesForChunks(ctx, bucket, chunks) {
  const tiles = uniqueMapTilesForChunks(chunks);
  if (tiles.length < 1) {
    return [];
  }
  const rebuild = rebuildMapTiles(bucket, tiles);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(rebuild);
  } else {
    await rebuild;
  }
  return tiles;
}

async function scheduleWorldMetaForChunks(ctx, bucket, chunks) {
  const update = updateWorldMetaForChunks(bucket, chunks);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(update);
  } else {
    await update;
  }
}

function chunkCountForRange(query) {
  return (query.maxChunkX - query.minChunkX + 1) * (query.maxChunkZ - query.minChunkZ + 1);
}

async function listChunkKeysForRange(bucket, query) {
  const objectLists = await Promise.all(
    range(query.minChunkX, query.maxChunkX).map((chunkX) => listR2Objects(bucket, chunkPrefix(query.world, query.dimension, chunkX))),
  );
  const keys = [];
  for (const objects of objectLists) {
    for (const object of objects) {
      const parsed = parseChunkKey(object.key);
      if (!parsed || parsed.chunkX < query.minChunkX || parsed.chunkX > query.maxChunkX || parsed.chunkZ < query.minChunkZ || parsed.chunkZ > query.maxChunkZ) {
        continue;
      }
      keys.push(object.key);
    }
  }
  return keys;
}

async function rebuildMapTilesForChunks(bucket, chunks) {
  const tiles = uniqueMapTilesForChunks(chunks);
  if (tiles.length < 1) {
    return [];
  }
  return rebuildMapTiles(bucket, tiles);
}

async function rebuildMapTiles(bucket, tiles, options = {}) {
  const textureColors = options.textureColors || (await loadTextureColorIndex(bucket));
  return mapWithConcurrency(tiles, options.concurrency || MAP_TILE_WRITE_CONCURRENCY, (tile) => rebuildMapTile(bucket, tile, { ...options, textureColors }));
}

async function rebuildMapTile(bucket, tile, options = {}) {
  const range = chunkRangeForMapTile(tile);
  const chunksByCoord = await readChunksForRange(bucket, { world: tile.world, dimension: tile.dimension, ...range }, { readConcurrency: options.readConcurrency });
  const textureColors = options.textureColors || (await loadTextureColorIndex(bucket));
  const { png, hasPixels, tileVersion: sourceVersion, missingColors, missingColorReason } = renderMapTilePng(tile, chunksByCoord, textureColors);
  const nextTileVersion = Math.max(sourceVersion, options.rebuildVersion || 0);
  const key = mapTileKey(tile.world, tile.dimension, tile.zoom, tile.tileX, tile.tileZ);
  if (!options.force) {
    const existingSourceVersion = await mapTileObjectSourceVersion(bucket, key);
    if (existingSourceVersion > sourceVersion) {
      return { ...tile, key, skipped: true, deleted: false, tileVersion: nextTileVersion, sourceVersion, existingSourceVersion, chunks: chunksByCoord.size };
    }
  }
  if (missingColors.length > 0) {
    await bucket.delete(key);
    return { ...tile, key, deleted: true, tileVersion: nextTileVersion, sourceVersion, missingColors, missingColorReason, chunks: chunksByCoord.size };
  }
  if (!hasPixels) {
    await bucket.delete(key);
    return { ...tile, key, deleted: true, tileVersion: nextTileVersion, sourceVersion, chunks: chunksByCoord.size };
  }
  const buffer = PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
  await bucket.put(key, buffer, {
    httpMetadata: { contentType: "image/png" },
    customMetadata: { world: tile.world, dimension: tile.dimension, zoom: String(tile.zoom), tileVersion: String(nextTileVersion), sourceVersion: String(sourceVersion) },
  });
  return { ...tile, key, deleted: false, tileVersion: nextTileVersion, sourceVersion, chunks: chunksByCoord.size };
}

function renderMapTilePng(tile, chunksByCoord, textureColors) {
  const png = new PNG({ width: MAP_TILE_SIZE, height: MAP_TILE_SIZE, colorType: 6 });
  png.data.fill(0);

  const tileRange = chunkRangeForMapTile(tile);
  const blockScale = 2 ** tile.zoom;
  if (blockScale < 1) {
    return renderSubPixelMapTilePng(png, tileRange, blockScale, chunksByCoord, textureColors);
  }
  let hasPixels = false;
  let tileVersion = 0;
  const missingColors = new Set();
  for (const chunk of chunksByCoord.values()) {
    tileVersion = Math.max(tileVersion, chunk.updatedAt || 0);
    for (let localZ = 0; localZ < 16; localZ += 1) {
      for (let localX = 0; localX < 16; localX += 1) {
        const worldX = chunk.chunkX * 16 + localX;
        const worldZ = chunk.chunkZ * 16 + localZ;
        if (worldX < tileRange.minBlockX || worldX > tileRange.maxBlockX || worldZ < tileRange.minBlockZ || worldZ > tileRange.maxBlockZ) {
          continue;
        }
        const index = localZ * 16 + localX;
        const height = chunk.heights[index] ?? MIN_COLUMN_HEIGHT;
        const blockId = chunk.palette[chunk.blocks[index]] || "minecraft:air";
        const blockState = chunk.blockStates[index] || {};
        const overlayHeight = chunk.overlayHeights[index] ?? MIN_COLUMN_HEIGHT;
        const overlayBlockId = overlayHeight > MIN_COLUMN_HEIGHT ? chunk.palette[chunk.overlayBlocks[index]] || "minecraft:air" : "minecraft:air";
        const overlayState = chunk.overlayStates[index] || {};
        if (isAirBlock(blockId) && (isAirBlock(overlayBlockId) || overlayHeight <= MIN_COLUMN_HEIGHT)) {
          continue;
        }
        const color = mapTileColumnColor(blockId, blockState, overlayBlockId, overlayState, Math.max(height, overlayHeight), worldX, worldZ, chunksByCoord, textureColors, missingColors);
        if (!color) {
          continue;
        }
        const pixelX = (worldX - tileRange.minBlockX) * blockScale;
        const pixelY = (worldZ - tileRange.minBlockZ) * blockScale;
        fillPngRect(png, pixelX, pixelY, blockScale, blockScale, color);
        hasPixels = true;
      }
    }
  }
  if (hasPixels) {
    fillTransparentMapTileHoles(png, transparentFillPixelLimit(blockScale));
  }
  return {
    png,
    hasPixels,
    tileVersion,
    missingColors: [...missingColors].sort(),
    missingColorReason: missingColors.size > 0 ? textureColors.reason || "texture_color_missing" : "",
  };
}

function renderSubPixelMapTilePng(png, tileRange, blockScale, chunksByCoord, textureColors) {
  const blocksPerPixel = Math.round(1 / blockScale);
  let hasPixels = false;
  let tileVersion = 0;
  const missingColors = new Set();

  for (const chunk of chunksByCoord.values()) {
    tileVersion = Math.max(tileVersion, chunk.updatedAt || 0);
  }

  for (let pixelY = 0; pixelY < MAP_TILE_SIZE; pixelY += 1) {
    for (let pixelX = 0; pixelX < MAP_TILE_SIZE; pixelX += 1) {
      const color = aggregateMapTilePixelColor(
        tileRange.minBlockX + pixelX * blocksPerPixel,
        tileRange.minBlockZ + pixelY * blocksPerPixel,
        blocksPerPixel,
        chunksByCoord,
        textureColors,
        missingColors,
      );
      if (!color) {
        continue;
      }
      const offset = (pixelY * MAP_TILE_SIZE + pixelX) * 4;
      png.data[offset] = color[0];
      png.data[offset + 1] = color[1];
      png.data[offset + 2] = color[2];
      png.data[offset + 3] = color[3];
      hasPixels = true;
    }
  }

  if (hasPixels) {
    fillTransparentMapTileHoles(png, transparentFillPixelLimit(blockScale));
  }
  return {
    png,
    hasPixels,
    tileVersion,
    missingColors: [...missingColors].sort(),
    missingColorReason: missingColors.size > 0 ? textureColors.reason || "texture_color_missing" : "",
  };
}

function aggregateMapTilePixelColor(startWorldX, startWorldZ, blocksPerPixel, chunksByCoord, textureColors, missingColors) {
  const colors = [];
  for (let offsetZ = 0; offsetZ < blocksPerPixel; offsetZ += 1) {
    for (let offsetX = 0; offsetX < blocksPerPixel; offsetX += 1) {
      const worldX = startWorldX + offsetX;
      const worldZ = startWorldZ + offsetZ;
      const chunk = chunksByCoord.get(coordKey(floorDiv(worldX, 16), floorDiv(worldZ, 16)));
      if (!chunk) {
        continue;
      }
      const localX = mod(worldX, 16);
      const localZ = mod(worldZ, 16);
      const index = localZ * 16 + localX;
      const height = chunk.heights[index] ?? MIN_COLUMN_HEIGHT;
      const blockId = chunk.palette[chunk.blocks[index]] || "minecraft:air";
      const blockState = chunk.blockStates[index] || {};
      const overlayHeight = chunk.overlayHeights[index] ?? MIN_COLUMN_HEIGHT;
      const overlayBlockId = overlayHeight > MIN_COLUMN_HEIGHT ? chunk.palette[chunk.overlayBlocks[index]] || "minecraft:air" : "minecraft:air";
      const overlayState = chunk.overlayStates[index] || {};
      if (isAirBlock(blockId) && (isAirBlock(overlayBlockId) || overlayHeight <= MIN_COLUMN_HEIGHT)) {
        continue;
      }
      const color = mapTileColumnColor(blockId, blockState, overlayBlockId, overlayState, Math.max(height, overlayHeight), worldX, worldZ, chunksByCoord, textureColors, missingColors);
      if (color) {
        colors.push(color);
      }
    }
  }
  return averageRgbaColors(colors);
}

function averageRgbaColors(colors) {
  if (colors.length < 1) {
    return null;
  }
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  for (const color of colors) {
    red += color[0];
    green += color[1];
    blue += color[2];
    alpha += color[3];
  }
  return [clampByte(red / colors.length), clampByte(green / colors.length), clampByte(blue / colors.length), clampByte(alpha / colors.length)];
}

async function mapTileObjectSourceVersion(bucket, key) {
  const existing = await bucket.get(key);
  const version = Number(existing?.customMetadata?.sourceVersion || 0);
  return Number.isFinite(version) ? version : 0;
}

async function loadTextureColorIndex(bucket) {
  const manifestObject = await bucket.get(TEXTURE_MANIFEST_KEY);
  if (!manifestObject) {
    return { ok: false, reason: "texture_manifest_missing", colors: new Map() };
  }
  const atlasObject = await bucket.get(TEXTURE_ATLAS_KEY);
  if (!atlasObject) {
    return { ok: false, reason: "texture_atlas_missing", colors: new Map() };
  }

  try {
    const manifest = await readR2Json(manifestObject);
    const entries = manifest?.blocks;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return { ok: false, reason: "texture_manifest_invalid", colors: new Map() };
    }

    const colors = new Map();
    for (const [blockId, entry] of Object.entries(entries)) {
      const color = manifestEntryColor(entry);
      if (color) {
        setTextureColor(colors, blockId, color);
      }
    }
    if (colors.size > 0) {
      return { ok: true, reason: "", colors };
    }

    const atlasBytes = Buffer.from(await atlasObject.arrayBuffer());
    const atlas = PNG.sync.read(atlasBytes);
    for (const [blockId, entry] of Object.entries(entries)) {
      const color = averageAtlasEntryColor(atlas, entry);
      if (color) {
        setTextureColor(colors, blockId, color);
      }
    }

    if (colors.size < 1) {
      return { ok: false, reason: "texture_colors_empty", colors };
    }
    return { ok: true, reason: "", colors };
  } catch (error) {
    return { ok: false, reason: "texture_atlas_invalid", colors: new Map(), message: error instanceof Error ? error.message : String(error) };
  }
}

function manifestEntryColor(entry) {
  const value = entry?.color || entry?.averageColor;
  if (typeof value === "string") {
    return hexToRgba(value);
  }
  if (Array.isArray(value) && value.length >= 3) {
    const color = [clampByte(Number(value[0])), clampByte(Number(value[1])), clampByte(Number(value[2])), clampByte(Number(value[3] ?? 255))];
    return color.every(Number.isFinite) ? color : null;
  }
  return null;
}

function averageAtlasEntryColor(atlas, entry) {
  const x = Number(entry?.x);
  const y = Number(entry?.y);
  const width = Number(entry?.w);
  const height = Number(entry?.h);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  const startX = Math.max(0, Math.floor(x));
  const startY = Math.max(0, Math.floor(y));
  const endX = Math.min(atlas.width, Math.ceil(x + width));
  const endY = Math.min(atlas.height, Math.ceil(y + height));
  let red = 0;
  let green = 0;
  let blue = 0;
  let alpha = 0;
  for (let pixelY = startY; pixelY < endY; pixelY += 1) {
    for (let pixelX = startX; pixelX < endX; pixelX += 1) {
      const offset = (pixelY * atlas.width + pixelX) * 4;
      const pixelAlpha = atlas.data[offset + 3];
      if (pixelAlpha < 8) {
        continue;
      }
      red += atlas.data[offset] * pixelAlpha;
      green += atlas.data[offset + 1] * pixelAlpha;
      blue += atlas.data[offset + 2] * pixelAlpha;
      alpha += pixelAlpha;
    }
  }
  if (alpha < 1) {
    return null;
  }
  return [clampByte(red / alpha), clampByte(green / alpha), clampByte(blue / alpha), 255];
}

function setTextureColor(colors, blockId, color) {
  for (const key of blockColorKeys(blockId)) {
    colors.set(key, color);
  }
}

function blockColorKeys(blockId) {
  const id = normalizeTextureBlockId(blockId);
  const name = stripBlockNamespace(id);
  return [...new Set([id, name])];
}

function textureColorForBlock(textureColors, blockId, blockState) {
  if (textureColors.ok) {
    if (usesMapTint(blockId)) {
      const tint = fallbackColorForMissingAtlasEntry(blockId, blockState);
      if (tint) {
        return tint;
      }
    }
    for (const candidate of textureColorCandidates(blockId, blockState)) {
      const color = textureColors.colors.get(candidate);
      if (color) {
        return color;
      }
    }
  }
  return fallbackColorForMissingAtlasEntry(blockId, blockState);
}

function fallbackColorForMissingAtlasEntry(blockId, blockState) {
  const fallback = fallbackTextureColor(blockId, blockState);
  if (!fallback) {
    return null;
  }
  return hexToRgba(fallback);
}

function textureColorCandidates(blockId, blockState) {
  const id = normalizeTextureBlockId(blockId);
  const name = stripBlockNamespace(id);
  const candidates = [id, name];
  if (name === "flowing_water") {
    candidates.push("minecraft:water", "water");
  }
  if (name === "flowing_lava") {
    candidates.push("minecraft:lava", "lava");
  }

  for (const material of stateTextureMaterials(name, blockState)) {
    candidates.push(`minecraft:${material}`, material);
  }

  if (name.endsWith("_block")) {
    candidates.push(`minecraft:${name.slice(0, -"_block".length)}`, name.slice(0, -"_block".length));
  }
  return [...new Set(candidates)];
}

function stateTextureMaterials(name, state) {
  const materials = [];
  const woodType = stateTokenValue(state, ["wood_type", "minecraft:wood_type"]);
  if (woodType && (name.includes("wooden_slab") || name.includes("wooden_double_slab"))) {
    materials.push(`${woodType}_slab`, `${woodType}_planks`);
  }

  const stoneType = stateTokenValue(state, [
    "stone_slab_type",
    "minecraft:stone_slab_type",
    "stone_slab_type_2",
    "minecraft:stone_slab_type_2",
    "stone_slab_type_3",
    "minecraft:stone_slab_type_3",
    "stone_slab_type_4",
    "minecraft:stone_slab_type_4",
  ]);
  if (stoneType && name.includes("slab")) {
    materials.push(`${stoneType}_slab`, stoneType);
    if (stoneType === "wood") {
      materials.push("oak_slab", "oak_planks");
    }
    if (stoneType === "smooth_stone") {
      materials.push("stone_slab", "smooth_stone");
    }
  }
  return materials;
}

function stateTokenValue(state, keys) {
  if (!state || typeof state !== "object") {
    return "";
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(state, key)) {
      return stripBlockNamespace(String(state[key]).toLowerCase());
    }
  }
  return "";
}

function normalizeTextureBlockId(value) {
  const id = String(value || "minecraft:air").toLowerCase();
  return id.includes(":") ? id : `minecraft:${id}`;
}

function stripBlockNamespace(id) {
  const parts = String(id || "").split(":");
  return parts[parts.length - 1] || "air";
}

function mapTileColumnColor(blockId, blockState, overlayBlockId, overlayState, height, worldX, worldZ, chunksByCoord, textureColors, missingColors) {
  const hasBase = !isAirBlock(blockId);
  const baseColor = hasBase ? textureColorForBlock(textureColors, blockId, blockState) : null;
  const hasOverlay = !isAirBlock(overlayBlockId);
  const overlayColor = hasOverlay ? textureColorForBlock(textureColors, overlayBlockId, overlayState) : null;
  if (hasBase && !baseColor) {
    missingColors.add(blockId);
  }
  if (hasOverlay && !overlayColor) {
    missingColors.add(overlayBlockId);
  }
  if ((hasBase && !baseColor) || (hasOverlay && !overlayColor)) {
    return null;
  }

  let color = hasBase ? baseColor : overlayColor;
  if (!isAirBlock(overlayBlockId)) {
    color = hasBase ? mixColors(color, overlayColor, 0.28) : color;
  }
  color = applyHeightShade(color, height);

  const north = getMapColumnHeight(chunksByCoord, worldX, worldZ - 1, height);
  const west = getMapColumnHeight(chunksByCoord, worldX - 1, worldZ, height);
  const northwest = getMapColumnHeight(chunksByCoord, worldX - 1, worldZ - 1, height);
  const east = getMapColumnHeight(chunksByCoord, worldX + 1, worldZ, height);
  const south = getMapColumnHeight(chunksByCoord, worldX, worldZ + 1, height);
  const shadeDrop = Math.max(0, height - north, height - west, height - northwest);
  const lightLift = Math.max(0, height - east, height - south);
  const ambientFactor = clamp(1 - Math.min(0.2, shadeDrop * 0.018) + Math.min(0.08, lightLift * 0.01), 0.68, 1.18);
  return adjustBrightness(color, ambientFactor);
}

function applyHeightShade(color, height) {
  if (height < SEA_LEVEL) {
    const depth = clamp((SEA_LEVEL - height) / 48, 0, 1);
    return mixColors(adjustBrightness(color, 0.78 - depth * 0.22), [36, 92, 148, 255], 0.18 + depth * 0.24);
  }
  if (height <= 100) {
    return adjustBrightness(color, 0.93 + ((height - SEA_LEVEL) / 37) * 0.05);
  }
  if (height <= 150) {
    return adjustBrightness(color, 1.02 + ((height - 100) / 50) * 0.08);
  }
  return adjustBrightness(color, 1.12 + Math.min(0.14, (height - 150) / 600));
}

function getMapColumnHeight(chunksByCoord, worldX, worldZ, fallbackHeight) {
  const chunkX = floorDiv(worldX, 16);
  const chunkZ = floorDiv(worldZ, 16);
  const chunk = chunksByCoord.get(coordKey(chunkX, chunkZ));
  if (!chunk) {
    return fallbackHeight;
  }
  const localX = mod(worldX, 16);
  const localZ = mod(worldZ, 16);
  return chunk.heights[localZ * 16 + localX] ?? fallbackHeight;
}

function fillPngRect(png, x, y, width, height, color) {
  const startX = Math.max(0, Math.floor(x));
  const startY = Math.max(0, Math.floor(y));
  const endX = Math.min(MAP_TILE_SIZE, Math.ceil(x + width));
  const endY = Math.min(MAP_TILE_SIZE, Math.ceil(y + height));
  for (let pixelY = startY; pixelY < endY; pixelY += 1) {
    for (let pixelX = startX; pixelX < endX; pixelX += 1) {
      const offset = (pixelY * MAP_TILE_SIZE + pixelX) * 4;
      png.data[offset] = color[0];
      png.data[offset + 1] = color[1];
      png.data[offset + 2] = color[2];
      png.data[offset + 3] = color[3];
    }
  }
}

function transparentFillPixelLimit(blockScale) {
  const chunkPixelWidth = 16 * blockScale;
  return Math.min(8192, Math.max(4096, chunkPixelWidth * chunkPixelWidth * 4));
}

function fillTransparentMapTileHoles(png, pixelLimit) {
  const pixelCount = MAP_TILE_SIZE * MAP_TILE_SIZE;
  const visited = new Uint8Array(pixelCount);
  const queue = [];
  const component = [];

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || png.data[start * 4 + 3] !== 0) {
      continue;
    }

    queue.length = 0;
    component.length = 0;
    queue.push(start);
    visited[start] = 1;
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;
    let boundary = 0;
    let touchesEdge = false;

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      component.push(index);
      const x = index % MAP_TILE_SIZE;
      const y = Math.floor(index / MAP_TILE_SIZE);
      if (x === 0 || y === 0 || x === MAP_TILE_SIZE - 1 || y === MAP_TILE_SIZE - 1) {
        touchesEdge = true;
      }

      for (const neighbor of transparentFillNeighbors(index, x, y)) {
        const offset = neighbor * 4;
        if (png.data[offset + 3] === 0) {
          if (!visited[neighbor]) {
            visited[neighbor] = 1;
            queue.push(neighbor);
          }
          continue;
        }
        red += png.data[offset];
        green += png.data[offset + 1];
        blue += png.data[offset + 2];
        alpha += png.data[offset + 3];
        boundary += 1;
      }
    }

    if (touchesEdge || component.length > pixelLimit || boundary < 1) {
      continue;
    }

    const color = [
      Math.round(red / boundary),
      Math.round(green / boundary),
      Math.round(blue / boundary),
      Math.round(alpha / boundary),
    ];
    for (const index of component) {
      const offset = index * 4;
      png.data[offset] = color[0];
      png.data[offset + 1] = color[1];
      png.data[offset + 2] = color[2];
      png.data[offset + 3] = color[3];
    }
  }
}

function transparentFillNeighbors(index, x, y) {
  const neighbors = [];
  if (x > 0) {
    neighbors.push(index - 1);
  }
  if (x < MAP_TILE_SIZE - 1) {
    neighbors.push(index + 1);
  }
  if (y > 0) {
    neighbors.push(index - MAP_TILE_SIZE);
  }
  if (y < MAP_TILE_SIZE - 1) {
    neighbors.push(index + MAP_TILE_SIZE);
  }
  return neighbors;
}

export function mapTilesForChunk(world, dimension, chunkX, chunkZ) {
  return range(MAP_TILE_MIN_ZOOM, MAP_TILE_MAX_ZOOM).map((zoom) => {
    const chunksPerTile = chunksPerMapTile(zoom);
    return {
      world: cleanSegment(world),
      dimension: cleanSegment(dimension),
      zoom,
      tileX: floorDiv(numberOrThrow(chunkX, "chunkX"), chunksPerTile),
      tileZ: floorDiv(numberOrThrow(chunkZ, "chunkZ"), chunksPerTile),
    };
  });
}

function mapTilesForChunkRange(payload) {
  const tiles = [];
  for (const zoom of payload.zooms) {
    const chunksPerTile = chunksPerMapTile(zoom);
    const minTileX = floorDiv(payload.minChunkX, chunksPerTile);
    const maxTileX = floorDiv(payload.maxChunkX, chunksPerTile);
    const minTileZ = floorDiv(payload.minChunkZ, chunksPerTile);
    const maxTileZ = floorDiv(payload.maxChunkZ, chunksPerTile);
    for (const tileZ of range(minTileZ, maxTileZ)) {
      for (const tileX of range(minTileX, maxTileX)) {
        tiles.push({ world: payload.world, dimension: payload.dimension, zoom, tileX, tileZ });
      }
    }
  }
  return tiles.sort((a, b) => a.zoom - b.zoom || a.tileZ - b.tileZ || a.tileX - b.tileX);
}

export function chunkRangeForMapTile(tile) {
  const zoom = normalizeMapTileZoom(tile.zoom);
  const chunksPerTile = chunksPerMapTile(zoom);
  const minChunkX = numberOrThrow(tile.tileX, "tileX") * chunksPerTile;
  const minChunkZ = numberOrThrow(tile.tileZ, "tileZ") * chunksPerTile;
  const maxChunkX = minChunkX + chunksPerTile - 1;
  const maxChunkZ = minChunkZ + chunksPerTile - 1;
  return {
    minChunkX,
    maxChunkX,
    minChunkZ,
    maxChunkZ,
    minBlockX: minChunkX * 16,
    maxBlockX: maxChunkX * 16 + 15,
    minBlockZ: minChunkZ * 16,
    maxBlockZ: maxChunkZ * 16 + 15,
  };
}

function chunksPerMapTile(zoom) {
  return 2 ** (MAP_TILE_BASE_ZOOM - normalizeMapTileZoom(zoom));
}

function normalizeMapTileZoom(zoom) {
  const value = numberOrThrow(zoom, "zoom");
  if (value < MAP_TILE_MIN_ZOOM || value > MAP_TILE_MAX_ZOOM) {
    throw new Error(`zoom must be ${MAP_TILE_MIN_ZOOM}-${MAP_TILE_MAX_ZOOM}`);
  }
  return value;
}

async function listR2Objects(bucket, prefix) {
  if (typeof bucket.list !== "function") {
    return [];
  }

  const objects = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix, cursor });
    objects.push(...(page.objects || []));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

function parseChunkKey(key) {
  const match = /^chunks\/v1\/([^/]+)\/([^/]+)\/(-?\d+)\/(-?\d+)\.json$/.exec(key);
  if (!match) {
    return null;
  }
  return {
    world: match[1],
    dimension: match[2],
    chunkX: Number(match[3]),
    chunkZ: Number(match[4]),
  };
}

function parseMapTilePath(pathname) {
  const match = /^\/api\/map-tiles\/([^/]+)\/([^/]+)\/z(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/.exec(pathname);
  if (!match) {
    return null;
  }
  return {
    world: cleanSegment(decodeURIComponent(match[1])),
    dimension: cleanSegment(decodeURIComponent(match[2])),
    zoom: normalizeMapTileZoom(match[3]),
    tileX: numberOrThrow(match[4], "tileX"),
    tileZ: numberOrThrow(match[5], "tileZ"),
  };
}

function range(min, max) {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

function coordKey(chunkX, chunkZ) {
  return `${chunkX}/${chunkZ}`;
}

function floorDiv(value, divisor) {
  return Math.floor(value / divisor);
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function applyBlockUpdatesToChunk(chunk, updates) {
  const applied = [];
  for (const update of updates) {
    const paletteIndex = paletteIndexFor(chunk, update.block);
    const overlayPaletteIndex = paletteIndexFor(chunk, update.overlayBlock);
    const index = update.localZ * 16 + update.localX;
    if (
      chunk.blocks[index] === paletteIndex &&
      chunk.heights[index] === update.height &&
      sameBlockStateMap(chunk.blockStates[index], update.state) &&
      chunk.overlayBlocks[index] === overlayPaletteIndex &&
      chunk.overlayHeights[index] === update.overlayHeight &&
      sameBlockStateMap(chunk.overlayStates[index], update.overlayState)
    ) {
      continue;
    }
    chunk.blocks[index] = paletteIndex;
    chunk.heights[index] = update.height;
    chunk.blockStates[index] = update.state;
    chunk.overlayBlocks[index] = overlayPaletteIndex;
    chunk.overlayHeights[index] = update.overlayHeight;
    chunk.overlayStates[index] = update.overlayState;
    applied.push(update);
  }
  return applied;
}

function paletteIndexFor(chunk, block) {
  let paletteIndex = chunk.palette.indexOf(block);
  if (paletteIndex === -1) {
    if (chunk.palette.length >= MAX_CHUNK_PALETTE_SIZE) {
      throw new Error("chunk palette is full");
    }
    paletteIndex = chunk.palette.push(block) - 1;
  }
  return paletteIndex;
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function diffChunkSnapshots(previous, next) {
  if (!previous || !Array.isArray(previous.blocks) || !Array.isArray(previous.heights)) {
    return [];
  }
  const updates = [];
  const previousOverlayBlocks = Array.isArray(previous.overlayBlocks) ? previous.overlayBlocks : [];
  const previousOverlayHeights = Array.isArray(previous.overlayHeights) ? previous.overlayHeights : [];
  const previousBlockStates = Array.isArray(previous.blockStates) ? previous.blockStates : [];
  const previousOverlayStates = Array.isArray(previous.overlayStates) ? previous.overlayStates : [];
  const nextOverlayBlocks = Array.isArray(next.overlayBlocks) ? next.overlayBlocks : [];
  const nextOverlayHeights = Array.isArray(next.overlayHeights) ? next.overlayHeights : [];
  const nextBlockStates = Array.isArray(next.blockStates) ? next.blockStates : [];
  const nextOverlayStates = Array.isArray(next.overlayStates) ? next.overlayStates : [];
  for (let index = 0; index < CHUNK_BLOCK_COUNT; index += 1) {
    const previousBlock = previous.palette[previous.blocks[index]] || "minecraft:air";
    const nextBlock = next.palette[next.blocks[index]] || "minecraft:air";
    const previousState = previousBlockStates[index] || {};
    const nextState = nextBlockStates[index] || {};
    const previousOverlayHeight = previousOverlayHeights[index] ?? -64;
    const nextOverlayHeight = nextOverlayHeights[index] ?? -64;
    const previousOverlayBlock = previousOverlayHeight > -64 ? previous.palette[previousOverlayBlocks[index]] || "minecraft:air" : "minecraft:air";
    const nextOverlayBlock = nextOverlayHeight > -64 ? next.palette[nextOverlayBlocks[index]] || "minecraft:air" : "minecraft:air";
    const previousOverlayState = previousOverlayHeight > -64 ? previousOverlayStates[index] || {} : {};
    const nextOverlayState = nextOverlayHeight > -64 ? nextOverlayStates[index] || {} : {};
    if (
      previousBlock === nextBlock &&
      previous.heights[index] === next.heights[index] &&
      sameBlockStateMap(previousState, nextState) &&
      previousOverlayBlock === nextOverlayBlock &&
      previousOverlayHeight === nextOverlayHeight &&
      sameBlockStateMap(previousOverlayState, nextOverlayState)
    ) {
      continue;
    }
    updates.push({
      localX: index % 16,
      localZ: Math.floor(index / 16),
      block: nextBlock,
      height: next.heights[index],
      state: nextState,
      overlayBlock: nextOverlayBlock,
      overlayHeight: nextOverlayHeight,
      overlayState: nextOverlayState,
    });
  }
  return updates;
}

async function readR2Json(object) {
  if (!object) {
    return null;
  }
  if (typeof object.json === "function") {
    return object.json();
  }
  if (typeof object.text === "function") {
    return JSON.parse(await object.text());
  }
  return new Response(object.body).json();
}

function normalizeFixedNumberArray(value, field, length) {
  if (!Array.isArray(value) || value.length !== length) {
    throw new Error(`${field} must contain ${length} entries`);
  }
  return value.map((item, index) => numberOrThrow(item, `${field}[${index}]`));
}

function normalizeOptionalPaletteArray(value, field, length, palette) {
  if (!Array.isArray(value)) {
    const airIndex = Math.max(0, palette.indexOf("minecraft:air"));
    return Array.from({ length }, () => airIndex);
  }
  return normalizeFixedNumberArray(value, field, length).map((item) => {
    if (item < 0 || item >= palette.length) {
      throw new Error(`${field} palette index out of range`);
    }
    return item;
  });
}

function normalizeOptionalStateArray(value, field, length) {
  if (!Array.isArray(value)) {
    return Array.from({ length }, () => ({}));
  }
  if (value.length !== length) {
    throw new Error(`${field} must contain ${length} entries`);
  }
  return value.map((item, index) => normalizeBlockStateMap(item || {}, `${field}[${index}]`));
}

function normalizeBlockStateMap(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const result = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const stateKey = String(key || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
    if (!stateKey) {
      throw new Error(`${field} has an invalid key`);
    }
    if (typeof rawValue === "boolean") {
      result[stateKey] = rawValue;
    } else if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
      result[stateKey] = Math.trunc(rawValue);
    } else if (typeof rawValue === "string") {
      result[stateKey] = rawValue.slice(0, 120);
    } else {
      throw new Error(`${field}.${stateKey} must be a boolean, number, or string`);
    }
  }
  return result;
}

function sameBlockStateMap(left, right) {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right || {}, key) && left[key] === right[key]);
}

function cleanSegment(value) {
  const cleaned = String(value).replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new Error("invalid path segment");
  }
  return cleaned.slice(0, 80);
}

function cleanBlockId(value) {
  const cleaned = String(value || "").trim().replace(/[^A-Za-z0-9_.:-]/g, "_");
  if (!cleaned || cleaned.length > 120) {
    throw new Error("invalid block id");
  }
  return cleaned;
}

function cleanText(value, maxLength, required = true) {
  const text = String(value || "").trim();
  if (required && text.length === 0) {
    throw new Error("text value is required");
  }
  return text.slice(0, maxLength);
}

function normalizeStringArray(value, field, maxLength) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => cleanText(item, maxLength, false)).filter((item, index) => {
    if (item.length > 0) {
      return true;
    }
    if (value[index] !== "" && value[index] != null) {
      throw new Error(`${field}[${index}] must be a string`);
    }
    return false;
  });
}

function normalizeTopBlocks(value) {
  const result = {};
  for (const [key, count] of Object.entries(value)) {
    result[cleanBlockId(key)] = numberOrThrow(count, `topBlocks.${key}`);
  }
  return result;
}

function expandWorldBounds(previousBounds, chunks) {
  const chunkXs = chunks.map((chunk) => chunk.chunkX);
  const chunkZs = chunks.map((chunk) => chunk.chunkZ);
  const minChunkX = Math.min(previousBounds?.minChunkX ?? Infinity, ...chunkXs);
  const maxChunkX = Math.max(previousBounds?.maxChunkX ?? -Infinity, ...chunkXs);
  const minChunkZ = Math.min(previousBounds?.minChunkZ ?? Infinity, ...chunkZs);
  const maxChunkZ = Math.max(previousBounds?.maxChunkZ ?? -Infinity, ...chunkZs);
  return {
    minChunkX,
    maxChunkX,
    minChunkZ,
    maxChunkZ,
    minBlockX: minChunkX * 16,
    maxBlockX: maxChunkX * 16 + 15,
    minBlockZ: minChunkZ * 16,
    maxBlockZ: maxChunkZ * 16 + 15,
  };
}

function chunkWithinBounds(chunk, bounds) {
  return chunk.chunkX >= bounds.minChunkX && chunk.chunkX <= bounds.maxChunkX && chunk.chunkZ >= bounds.minChunkZ && chunk.chunkZ <= bounds.maxChunkZ;
}

function summarizeChunkTopBlocks(chunks) {
  const counts = {};
  for (const chunk of chunks) {
    for (const paletteIndex of chunk.blocks) {
      const block = chunk.palette[paletteIndex] || "minecraft:air";
      counts[block] = (counts[block] || 0) + 1;
    }
  }
  return counts;
}

function mergeTopBlockCounts(previous, next) {
  const merged = { ...previous };
  for (const [block, count] of Object.entries(next)) {
    merged[block] = (merged[block] || 0) + count;
  }
  return merged;
}

function normalizeTextureJson(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function numberOrThrow(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${field} must be a finite number`);
  }
  return Math.trunc(number);
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("missing base64 data");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function hexToRgba(hex) {
  const value = String(hex || "#000000").replace("#", "");
  const normalized = value.length === 3 ? value.split("").map((char) => `${char}${char}`).join("") : value.padEnd(6, "0").slice(0, 6);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    255,
  ];
}

function mixColors(left, right, amount) {
  const weight = clamp(amount, 0, 1);
  return [
    clampByte(left[0] * (1 - weight) + right[0] * weight),
    clampByte(left[1] * (1 - weight) + right[1] * weight),
    clampByte(left[2] * (1 - weight) + right[2] * weight),
    clampByte(left[3] * (1 - weight) + right[3] * weight),
  ];
}

function adjustBrightness(color, factor) {
  return [clampByte(color[0] * factor), clampByte(color[1] * factor), clampByte(color[2] * factor), color[3]];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
