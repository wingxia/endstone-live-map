#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { PNG } from "pngjs";

const TILE_SIZE = 256;
const REGION_SIZE_CHUNKS = 16;
const MAP_TILE_MIN_ZOOM = -1;
const MAP_TILE_BASE_ZOOM = 4;
const MAP_TILE_MAX_ZOOM = MAP_TILE_BASE_ZOOM;
const MIN_COLUMN_HEIGHT = -64;

class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}: ${JSON.stringify(body)}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const args = parseArgs(process.argv.slice(2));

try {
  const summary =
    args.mode === "rebuild"
      ? await rebuildMapTilesAndAudit(args)
      : args.mode === "repair"
        ? await repairUntilClean(args)
        : await auditMapTiles(args);
  console.log(JSON.stringify(summary, null, 2));
  if ((args.failOnMismatch || args.mode === "repair" || args.mode === "rebuild") && summary.mismatchCount > 0) {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(argv) {
  const options = {
    mode: "audit",
    workerUrl: process.env.WORKER_URL || "https://map.buhe.li",
    token: process.env.PLUGIN_TOKEN || "",
    concurrency: 6,
    chunkConcurrency: 0,
    tileConcurrency: 0,
    maxIterations: 3,
    repairLimit: Number.POSITIVE_INFINITY,
    requestTimeoutMs: 45000,
    requestRetries: 3,
    cleanupLimit: 500,
    world: "",
    dimension: "",
    deleteExisting: false,
    failOnMismatch: false,
    sampleOnly: false,
  };

  const values = [...argv];
  if (values[0] && !values[0].startsWith("-")) {
    options.mode = values.shift();
  }
  if (!["audit", "repair", "rebuild"].includes(options.mode)) {
    throw new Error("Usage: node scripts/audit-map-tiles.mjs [audit|repair|rebuild] [--worker-url <url>] [--token <token>] [--world <world>] [--dimension <dimension>]");
  }

  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === "--worker-url") {
      options.workerUrl = requiredValue(values, ++index, flag);
    } else if (flag === "--token") {
      options.token = requiredValue(values, ++index, flag);
    } else if (flag === "--world") {
      options.world = requiredValue(values, ++index, flag);
    } else if (flag === "--dimension") {
      options.dimension = requiredValue(values, ++index, flag);
    } else if (flag === "--concurrency") {
      options.concurrency = Math.max(1, numberValue(values, ++index, flag));
    } else if (flag === "--chunk-concurrency") {
      options.chunkConcurrency = Math.max(1, numberValue(values, ++index, flag));
    } else if (flag === "--tile-concurrency") {
      options.tileConcurrency = Math.max(1, numberValue(values, ++index, flag));
    } else if (flag === "--max-iterations") {
      options.maxIterations = Math.max(1, numberValue(values, ++index, flag));
    } else if (flag === "--repair-limit") {
      options.repairLimit = Math.max(1, numberValue(values, ++index, flag));
    } else if (flag === "--request-timeout-ms") {
      options.requestTimeoutMs = Math.max(1000, numberValue(values, ++index, flag));
    } else if (flag === "--request-retries") {
      options.requestRetries = Math.max(0, numberValue(values, ++index, flag));
    } else if (flag === "--cleanup-limit") {
      options.cleanupLimit = Math.max(1, numberValue(values, ++index, flag));
    } else if (flag === "--delete-existing") {
      options.deleteExisting = true;
    } else if (flag === "--fail-on-mismatch") {
      options.failOnMismatch = true;
    } else if (flag === "--sample-only") {
      options.sampleOnly = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }

  options.workerUrl = options.workerUrl.replace(/\/+$/, "");
  options.chunkConcurrency = options.chunkConcurrency || options.concurrency;
  options.tileConcurrency = options.tileConcurrency || options.concurrency;
  if (options.deleteExisting && options.sampleOnly) {
    throw new Error("--delete-existing cannot be combined with --sample-only");
  }
  return options;
}

function requiredValue(values, index, flag) {
  const value = values[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function numberValue(values, index, flag) {
  const value = Number(requiredValue(values, index, flag));
  if (!Number.isFinite(value)) {
    throw new Error(`${flag} requires a number`);
  }
  return Math.trunc(value);
}

async function auditMapTiles(options) {
  const startedAt = new Date().toISOString();
  const worlds = await fetchJson(`${options.workerUrl}/api/worlds`, {}, options);
  const metas = (worlds.worlds || []).filter((meta) => {
    if (options.world && meta.world !== options.world) {
      return false;
    }
    if (options.dimension && meta.dimension !== options.dimension) {
      return false;
    }
    return meta.bounds && meta.chunkCount > 0;
  });

  const worldSummaries = [];
  const issues = [];
  for (const meta of metas) {
    const worldSummary = await auditWorld(options, meta);
    worldSummaries.push(withoutIssues(worldSummary));
    issues.push(...worldSummary.issues);
  }

  issues.sort((a, b) => a.world.localeCompare(b.world) || a.dimension.localeCompare(b.dimension) || a.zoom - b.zoom || a.tileZ - b.tileZ || a.tileX - b.tileX);
  return {
    ok: issues.length === 0,
    mode: "audit",
    workerUrl: options.workerUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    worlds: worldSummaries,
    mismatchCount: issues.length,
    issues,
  };
}

async function auditWorld(options, meta) {
  const tileRefs = new Map();
  const ranges = chunkScanRanges(meta.bounds, meta.sampleChunks || [], options.sampleOnly);
  const stats = {
    world: meta.world,
    dimension: meta.dimension,
    bounds: meta.bounds,
    chunkCount: meta.chunkCount,
    scannedRanges: ranges.length,
    rangeRequests: 0,
    splitRanges: 0,
    chunksRead: 0,
    nonAirChunks: 0,
    uniqueTiles: 0,
  };
  let completed = 0;

  console.error(`Scanning ${meta.world}/${meta.dimension}: ${ranges.length} chunk ranges`);
  await mapWithConcurrency(ranges, options.chunkConcurrency, async (range) => {
    const chunks = await fetchChunksForAuditRange(options, meta, range, stats);
    stats.chunksRead += chunks.length;
    for (const chunk of chunks) {
      if (!chunkHasNonAirPixels(chunk)) {
        continue;
      }
      stats.nonAirChunks += 1;
      for (const zoom of zoomRange()) {
        const tile = mapTileForChunk(chunk.world || meta.world, chunk.dimension || meta.dimension, chunk.chunkX, chunk.chunkZ, zoom);
        const key = mapTileRefKey(tile);
        if (!tileRefs.has(key)) {
          tileRefs.set(key, { ...tile, sourceChunks: 0 });
        }
        tileRefs.get(key).sourceChunks += 1;
      }
    }
    completed += 1;
    if (completed % 25 === 0 || completed === ranges.length) {
      console.error(`Scanned ${meta.world}/${meta.dimension}: ${completed}/${ranges.length}`);
    }
  });

  const tiles = [...tileRefs.values()].sort((a, b) => a.zoom - b.zoom || a.tileZ - b.tileZ || a.tileX - b.tileX);
  stats.uniqueTiles = tiles.length;
  console.error(`Checking ${meta.world}/${meta.dimension}: ${tiles.length} image tiles`);
  const checkedTiles = await mapWithConcurrency(tiles, options.tileConcurrency, (tile) => inspectMapTile(options, tile));
  const issues = checkedTiles.filter((tile) => tile.issue);
  return { ...stats, issues };
}

async function fetchChunksForAuditRange(options, meta, range, stats) {
  try {
    stats.rangeRequests += 1;
    const response = await fetchJson(chunkUrl(options.workerUrl, meta.world, meta.dimension, range), {}, options);
    return Array.isArray(response.chunks) ? response.chunks : [];
  } catch (error) {
    if (!shouldSplitChunkRange(error, range)) {
      throw error;
    }
    stats.splitRanges += 1;
    console.error(`Splitting ${meta.world}/${meta.dimension} ${formatChunkRange(range)} after ${error instanceof Error ? error.message : String(error)}`);
    const chunks = [];
    for (const part of splitChunkRange(range)) {
      chunks.push(...(await fetchChunksForAuditRange(options, meta, part, stats)));
    }
    return chunks;
  }
}

function withoutIssues(worldSummary) {
  const { issues, ...rest } = worldSummary;
  return { ...rest, mismatchCount: issues.length };
}

async function repairUntilClean(options) {
  if (!options.token) {
    throw new Error("repair mode requires --token or PLUGIN_TOKEN");
  }

  const iterations = [];
  let summary = await auditMapTiles(options);
  for (let iteration = 1; iteration <= options.maxIterations && summary.mismatchCount > 0; iteration += 1) {
    const issues = summary.issues.slice(0, options.repairLimit);
    console.error(`Repair iteration ${iteration}: rebuilding ${issues.length}/${summary.mismatchCount} flagged tiles`);
    const repairs = [];
    for (const issue of issues) {
      repairs.push(await repairMapTile(options, issue));
    }
    iterations.push({ iteration, beforeMismatchCount: summary.mismatchCount, repaired: repairs.length, repairs });
    summary = await auditMapTiles(options);
  }

  return {
    ...summary,
    mode: "repair",
    ok: summary.mismatchCount === 0,
    iterations,
  };
}

async function rebuildMapTilesAndAudit(options) {
  if (!options.token) {
    throw new Error("rebuild mode requires --token or PLUGIN_TOKEN");
  }

  const startedAt = new Date().toISOString();
  const worlds = await fetchJson(`${options.workerUrl}/api/worlds`, {}, options);
  const metas = (worlds.worlds || []).filter((meta) => {
    if (options.world && meta.world !== options.world) {
      return false;
    }
    if (options.dimension && meta.dimension !== options.dimension) {
      return false;
    }
    return meta.bounds && meta.chunkCount > 0;
  });
  if (metas.length < 1) {
    throw new Error("no matching worlds with map bounds found");
  }

  const cleanup = options.deleteExisting ? await deleteMapTileObjects(options) : null;
  const rebuilds = [];
  for (const meta of metas) {
    const ranges = chunkScanRanges(meta.bounds, meta.sampleChunks || [], options.sampleOnly);
    console.error(`Rebuilding ${meta.world}/${meta.dimension}: ${ranges.length} chunk ranges`);
    const byZoom = {};
    for (let zoom = MAP_TILE_BASE_ZOOM; zoom >= MAP_TILE_MIN_ZOOM; zoom -= 1) {
      byZoom[`z${zoom}`] = { calls: 0, matched: 0, written: 0, deleted: 0 };
      for (const range of ranges) {
        const result = await backfillAllMapTilesForRange(options, meta, range, zoom);
        byZoom[`z${zoom}`].calls += result.calls;
        byZoom[`z${zoom}`].matched += result.matched;
        byZoom[`z${zoom}`].written += result.written;
        byZoom[`z${zoom}`].deleted += result.deleted;
      }
      console.error(`Rebuilt ${meta.world}/${meta.dimension} z${zoom}: ${JSON.stringify(byZoom[`z${zoom}`])}`);
    }
    rebuilds.push({ world: meta.world, dimension: meta.dimension, ranges: ranges.length, byZoom });
  }

  const audit = await auditMapTiles(options);
  return {
    ...audit,
    mode: "rebuild",
    startedAt,
    cleanup,
    rebuilds,
  };
}

async function repairMapTile(options, issue) {
  const range = chunkRangeForMapTile(issue);
  if (issue.zoom < MAP_TILE_BASE_ZOOM) {
    await repairBaseTilesForRange(options, issue, range);
  }
  const body = await backfillOneMapTilePage(options, issue, range, issue.zoom, { limit: 1 });
  return {
    tile: mapTileRefKey(issue),
    written: body.written || 0,
    deleted: Boolean(body.tiles?.[0]?.deleted),
  };
}

async function repairBaseTilesForRange(options, issue, range) {
  for (let zoom = MAP_TILE_BASE_ZOOM; zoom > issue.zoom; zoom -= 1) {
    await backfillAllMapTilesForRange(options, issue, range, zoom);
  }
}

async function backfillAllMapTilesForRange(options, meta, range, zoom) {
  const stats = { calls: 0, matched: 0, written: 0, deleted: 0 };
  let cursor = "";
  do {
    const body = await backfillOneMapTilePage(options, meta, range, zoom, { cursor, limit: 100 });
    stats.calls += 1;
    stats.matched += body.matched || 0;
    stats.written += body.written || 0;
    stats.deleted += (body.tiles || []).filter((tile) => tile.deleted).length;
    cursor = body.cursor || "";
  } while (cursor);
  return stats;
}

async function backfillOneMapTilePage(options, meta, range, zoom, { cursor = "", limit = 100 } = {}) {
  const response = await fetchWithRetry(`${options.workerUrl}/api/plugin/map-tiles/backfill`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      world: meta.world,
      dimension: meta.dimension,
      zoom,
      minChunkX: range.minChunkX,
      maxChunkX: range.maxChunkX,
      minChunkZ: range.minChunkZ,
      maxChunkZ: range.maxChunkZ,
      cursor,
      dryRun: false,
      force: true,
      limit,
    }),
  }, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`backfill failed for ${meta.world}/${meta.dimension}/z${zoom} ${formatChunkRange(range)} cursor ${cursor || "0"}: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function deleteMapTileObjects(options) {
  const stats = { prefix: "map-tiles/v1/", calls: 0, matched: 0, deleted: 0 };
  let cursor = "";
  do {
    const response = await fetchWithRetry(`${options.workerUrl}/api/plugin/map-data/cleanup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix: stats.prefix,
        cursor,
        limit: options.cleanupLimit,
        dryRun: false,
        confirm: "delete-map-data-v1",
      }),
    }, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`map tile cleanup failed at cursor ${cursor || "0"}: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
    stats.calls += 1;
    stats.matched += body.matched || 0;
    stats.deleted += body.deleted || 0;
    cursor = body.cursor || "";
  } while (cursor);
  return stats;
}

async function inspectMapTile(options, tile) {
  const response = await fetchWithRetry(mapTileUrl(options.workerUrl, tile), { cache: "no-store" }, options);
  const bytes = Buffer.from(await response.arrayBuffer());
  const result = {
    ...tile,
    status: response.status,
    bytes: bytes.length,
    width: 0,
    height: 0,
    nonTransparentPixels: 0,
  };
  if (!response.ok) {
    return { ...result, issue: "http_error" };
  }
  try {
    const png = PNG.sync.read(bytes);
    result.width = png.width;
    result.height = png.height;
    for (let index = 3; index < png.data.length; index += 4) {
      if (png.data[index] > 0) {
        result.nonTransparentPixels += 1;
      }
    }
  } catch (error) {
    return { ...result, issue: "invalid_png", error: error instanceof Error ? error.message : String(error) };
  }
  if (result.width < TILE_SIZE || result.height < TILE_SIZE) {
    return { ...result, issue: "placeholder_png" };
  }
  if (result.nonTransparentPixels < 1) {
    return { ...result, issue: "transparent_png" };
  }
  return result;
}

function chunkScanRanges(bounds, sampleChunks, sampleOnly) {
  if (sampleOnly) {
    const seen = new Set();
    return sampleChunks
      .filter((chunk) => typeof chunk.chunkX === "number" && typeof chunk.chunkZ === "number")
      .map((chunk) => ({ minChunkX: chunk.chunkX, maxChunkX: chunk.chunkX, minChunkZ: chunk.chunkZ, maxChunkZ: chunk.chunkZ }))
      .filter((range) => {
        const key = `${range.minChunkX},${range.minChunkZ}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      });
  }

  const ranges = [];
  for (let minChunkZ = bounds.minChunkZ; minChunkZ <= bounds.maxChunkZ; minChunkZ += REGION_SIZE_CHUNKS) {
    for (let minChunkX = bounds.minChunkX; minChunkX <= bounds.maxChunkX; minChunkX += REGION_SIZE_CHUNKS) {
      ranges.push({
        minChunkX,
        maxChunkX: Math.min(bounds.maxChunkX, minChunkX + REGION_SIZE_CHUNKS - 1),
        minChunkZ,
        maxChunkZ: Math.min(bounds.maxChunkZ, minChunkZ + REGION_SIZE_CHUNKS - 1),
      });
    }
  }
  return ranges;
}

function chunkUrl(workerUrl, world, dimension, range) {
  const params = new URLSearchParams({
    world,
    dimension,
    minChunkX: String(range.minChunkX),
    maxChunkX: String(range.maxChunkX),
    minChunkZ: String(range.minChunkZ),
    maxChunkZ: String(range.maxChunkZ),
    summary: "1",
  });
  return `${workerUrl}/api/chunks?${params.toString()}`;
}

function formatChunkRange(range) {
  return `${range.minChunkX}..${range.maxChunkX},${range.minChunkZ}..${range.maxChunkZ}`;
}

function shouldSplitChunkRange(error, range) {
  if (chunkRangeArea(range) <= 1) {
    return false;
  }
  if (error instanceof HttpError) {
    return error.status === 429 || error.status >= 500;
  }
  return isRetriableError(error);
}

function splitChunkRange(range) {
  const midX = Math.floor((range.minChunkX + range.maxChunkX) / 2);
  const midZ = Math.floor((range.minChunkZ + range.maxChunkZ) / 2);
  const xParts = range.minChunkX < range.maxChunkX
    ? [
        [range.minChunkX, midX],
        [midX + 1, range.maxChunkX],
      ]
    : [[range.minChunkX, range.maxChunkX]];
  const zParts = range.minChunkZ < range.maxChunkZ
    ? [
        [range.minChunkZ, midZ],
        [midZ + 1, range.maxChunkZ],
      ]
    : [[range.minChunkZ, range.maxChunkZ]];
  const parts = [];
  for (const [minChunkX, maxChunkX] of xParts) {
    for (const [minChunkZ, maxChunkZ] of zParts) {
      parts.push({ minChunkX, maxChunkX, minChunkZ, maxChunkZ });
    }
  }
  return parts;
}

function chunkRangeArea(range) {
  return (range.maxChunkX - range.minChunkX + 1) * (range.maxChunkZ - range.minChunkZ + 1);
}

function mapTileUrl(workerUrl, tile) {
  return `${workerUrl}/api/map-tiles/${encodeURIComponent(tile.world)}/${encodeURIComponent(tile.dimension)}/z${tile.zoom}/${tile.tileX}/${tile.tileZ}.png?_=${Date.now()}`;
}

function mapTileForChunk(world, dimension, chunkX, chunkZ, zoom) {
  const chunksPerTile = chunksPerMapTile(zoom);
  return {
    world,
    dimension,
    zoom,
    tileX: floorDiv(chunkX, chunksPerTile),
    tileZ: floorDiv(chunkZ, chunksPerTile),
  };
}

function chunkRangeForMapTile(tile) {
  const chunksPerTile = chunksPerMapTile(tile.zoom);
  const minChunkX = tile.tileX * chunksPerTile;
  const minChunkZ = tile.tileZ * chunksPerTile;
  return {
    minChunkX,
    maxChunkX: minChunkX + chunksPerTile - 1,
    minChunkZ,
    maxChunkZ: minChunkZ + chunksPerTile - 1,
  };
}

function chunksPerMapTile(zoom) {
  return 2 ** (MAP_TILE_BASE_ZOOM - zoom);
}

function zoomRange() {
  const zooms = [];
  for (let zoom = MAP_TILE_MIN_ZOOM; zoom <= MAP_TILE_MAX_ZOOM; zoom += 1) {
    zooms.push(zoom);
  }
  return zooms;
}

function mapTileRefKey(tile) {
  return `${tile.world}/${tile.dimension}/z${tile.zoom}/${tile.tileX}/${tile.tileZ}`;
}

function chunkHasNonAirPixels(chunk) {
  if (typeof chunk.hasNonAir === "boolean") {
    return chunk.hasNonAir;
  }
  for (let index = 0; index < 256; index += 1) {
    const block = chunk.palette?.[chunk.blocks?.[index]] || "minecraft:air";
    if (!isAirBlock(block)) {
      return true;
    }
    const overlayHeight = chunk.overlayHeights?.[index] ?? MIN_COLUMN_HEIGHT;
    const overlayBlock = overlayHeight > MIN_COLUMN_HEIGHT ? chunk.palette?.[chunk.overlayBlocks?.[index]] || "minecraft:air" : "minecraft:air";
    if (!isAirBlock(overlayBlock)) {
      return true;
    }
  }
  return false;
}

function isAirBlock(block) {
  const id = String(block || "minecraft:air").toLowerCase();
  return id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air" || id === "air" || id === "cave_air" || id === "void_air";
}

async function fetchJson(url, fetchOptions = {}, options) {
  const response = await fetchWithRetry(url, fetchOptions, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new HttpError(response.status, url, body);
  }
  return body;
}

async function fetchWithRetry(url, fetchOptions, options) {
  const attempts = (options.requestRetries || 0) + 1;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      });
      if (!isRetriableStatus(response.status) || attempt === attempts) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status} for ${url}`);
      await response.arrayBuffer().catch(() => null);
    } catch (error) {
      lastError = error;
      if (!isRetriableError(error) || attempt === attempts) {
        throw error;
      }
    }
    const delayMs = Math.min(5000, 250 * 2 ** (attempt - 1));
    console.error(`Retrying ${url} after ${lastError instanceof Error ? lastError.message : String(lastError)} (${attempt}/${attempts - 1})`);
    await sleep(delayMs);
  }
  throw lastError || new Error(`failed to fetch ${url}`);
}

function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

function isRetriableError(error) {
  const name = error instanceof Error ? error.name : "";
  return name === "TimeoutError" || name === "AbortError" || name === "TypeError";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function floorDiv(value, divisor) {
  return Math.floor(value / divisor);
}
