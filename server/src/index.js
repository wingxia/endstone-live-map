import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, "plugin-data", "live_map");
const DEFAULT_PLAYER_STALE_AFTER_MS = 15_000;
const WORLD_INDEX_SCAN_CONCURRENCY = 32;
const WORLD_INDEX_VERSION = 1;
const WORLD_INDEX_FILE_NAME = "world-index-v1.json";
const WORLD_INDEX_SAMPLE_LIMIT = 32;
const DEFAULT_TILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TILE_CACHE_MAX_ENTRIES = 4_096;
const DEFAULT_TILE_CACHE_FRESH_MS = 1_000;
const DEFAULT_MISSING_TILE_CACHE_MS = 750;
const DEFAULT_STATIC_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_STATIC_CACHE_MAX_ENTRIES = 128;
const DEFAULT_MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_WEBSOCKET_MAX_BUFFERED_BYTES = 1024 * 1024;
const MIN_STATIC_COMPRESSION_BYTES = 1_024;
const WEB_BOOTSTRAP_PLACEHOLDER = "__ENDSTONE_LIVE_MAP_BOOTSTRAP__";
const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
let atomicWriteSequence = 0;
const EMPTY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==",
  "base64",
);

export function createLiveMapServer(options = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.LIVE_MAP_DATA_DIR || DEFAULT_DATA_DIR);
  const pluginToken = options.pluginToken ?? process.env.LIVE_MAP_PLUGIN_TOKEN ?? "";
  const webDir = path.resolve(options.webDir || WEB_DIST_DIR);
  const state = {
    players: [],
    playersReceivedAt: 0,
    playerStaleAfterMs: Math.max(
      1_000,
      numberOr(options.playerStaleAfterMs ?? process.env.LIVE_MAP_PLAYER_STALE_AFTER_MS, DEFAULT_PLAYER_STALE_AFTER_MS),
    ),
    sockets: new Set(),
    dataDir,
    pluginToken,
    webDir,
    worldIndex: null,
    worldIndexPromise: null,
    worldIndexUpdatePromise: Promise.resolve(),
    tileCache: new Map(),
    tileCacheBytes: 0,
    tileCacheMaxBytes: nonNegativeIntegerOr(
      options.tileCacheMaxBytes ?? process.env.LIVE_MAP_TILE_CACHE_MAX_BYTES,
      DEFAULT_TILE_CACHE_MAX_BYTES,
    ),
    tileCacheMaxEntries: nonNegativeIntegerOr(
      options.tileCacheMaxEntries ?? process.env.LIVE_MAP_TILE_CACHE_MAX_ENTRIES,
      DEFAULT_TILE_CACHE_MAX_ENTRIES,
    ),
    tileCacheFreshMs: nonNegativeIntegerOr(
      options.tileCacheFreshMs ?? process.env.LIVE_MAP_TILE_CACHE_FRESH_MS,
      DEFAULT_TILE_CACHE_FRESH_MS,
    ),
    missingTileCache: new Map(),
    missingTileCacheMs: nonNegativeIntegerOr(
      options.missingTileCacheMs ?? process.env.LIVE_MAP_MISSING_TILE_CACHE_MS,
      DEFAULT_MISSING_TILE_CACHE_MS,
    ),
    tileLoads: new Map(),
    staticCache: new Map(),
    staticCacheBytes: 0,
    staticCacheMaxBytes: nonNegativeIntegerOr(
      options.staticCacheMaxBytes ?? process.env.LIVE_MAP_STATIC_CACHE_MAX_BYTES,
      DEFAULT_STATIC_CACHE_MAX_BYTES,
    ),
    staticCacheMaxEntries: nonNegativeIntegerOr(
      options.staticCacheMaxEntries ?? process.env.LIVE_MAP_STATIC_CACHE_MAX_ENTRIES,
      DEFAULT_STATIC_CACHE_MAX_ENTRIES,
    ),
    maxJsonBodyBytes: nonNegativeIntegerOr(
      options.maxJsonBodyBytes ?? process.env.LIVE_MAP_MAX_JSON_BODY_BYTES,
      DEFAULT_MAX_JSON_BODY_BYTES,
    ),
    webSocketMaxBufferedBytes: nonNegativeIntegerOr(
      options.webSocketMaxBufferedBytes ?? process.env.LIVE_MAP_WEBSOCKET_MAX_BUFFERED_BYTES,
      DEFAULT_WEBSOCKET_MAX_BUFFERED_BYTES,
    ),
  };

  const server = http.createServer((request, response) => {
    void handleRequest(state, request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      json(response, statusCode, {
        error: typeof error?.errorCode === "string" ? error.errorCode : "internal_error",
        message: error instanceof Error ? error.message : String(error),
      }, statusCode === 413 ? { Connection: "close" } : {});
    });
  });

  // cloudflared keeps a pool of persistent origin connections. Node's short
  // default keep-alive window can close an idle socket just as the tunnel
  // reuses it, surfacing as a transient origin EOF and a public 502. Keep the
  // origin connection alive beyond the proxy idle window and leave enough
  // time for the next request headers to arrive.
  server.keepAliveTimeout = 95_000;
  server.headersTimeout = 100_000;
  server.requestTimeout = 60_000;

  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url || "/", "http://localhost").pathname !== "/api/live") {
      socket.destroy();
      return;
    }
    acceptWebSocket(state, request, socket, head);
  });

  return { server, state };
}

export async function handleRequest(state, request, response) {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders());
    response.end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    json(response, 200, {
      ok: true,
      service: "endstone-live-map-local-server",
      dataDir: state.dataDir,
      worldIndexReady: state.worldIndex !== null,
      caches: {
        tiles: {
          entries: state.tileCache.size,
          bytes: state.tileCacheBytes,
          maxBytes: state.tileCacheMaxBytes,
        },
        static: {
          entries: state.staticCache.size,
          bytes: state.staticCacheBytes,
          maxBytes: state.staticCacheMaxBytes,
        },
      },
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    json(response, 200, {
      tileSize: 256,
      minZoom: -8,
      nativeMinZoom: -8,
      maxZoom: 4,
      defaultWorld: "Bedrock level",
      dimensions: ["Overworld", "Nether", "TheEnd"],
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/worlds") {
    json(response, 200, { worlds: await readWorlds(state) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/players") {
    json(response, 200, { players: currentPlayers(state) });
    return;
  }
  if (request.method === "GET" && /^\/api\/players\/[^/]+\/avatar\.png$/.test(url.pathname)) {
    await servePlayerAvatar(state, url.pathname, response);
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/lands") {
    const world = cleanSegment(url.searchParams.get("world") || "Bedrock level");
    const dimension = cleanSegment(url.searchParams.get("dimension") || "Overworld");
    json(response, 200, await readLandFile(state.dataDir, world, dimension));
    return;
  }
  if (request.method === "GET" && (url.pathname.startsWith("/api/map-tiles/") || url.pathname.startsWith("/api/local-map-tiles/"))) {
    await serveTile(state, request, url, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/plugin/live") {
    if (!authorized(state, request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request, state.maxJsonBodyBytes);
    state.players = await normalizePlayers(state.dataDir, Array.isArray(body.players) ? body.players : []);
    state.playersReceivedAt = Date.now();
    broadcast(state, JSON.stringify({ type: "player_snapshot", players: state.players }));
    json(response, 200, { ok: true, players: state.players.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/plugin/lands") {
    if (!authorized(state, request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request, state.maxJsonBodyBytes);
    const claims = Array.isArray(body.claims) ? body.claims : [];
    const written = await writeLandClaims(state.dataDir, claims, {
      world: body.world,
      dimensions: body.dimensions,
    });
    for (const item of written) {
      broadcast(state, JSON.stringify({ type: "lands_updated", world: item.world, dimension: item.dimension, updatedAt: item.updatedAt }));
    }
    json(response, 200, { ok: true, claims: claims.length, worlds: written.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/plugin/tiles") {
    if (!authorized(state, request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request, state.maxJsonBodyBytes);
    await updateWorldsFromTiles(state, body);
    broadcast(state, JSON.stringify({ ...body, worlds: await readWorlds(state) }));
    json(response, 200, { ok: true, chunks: Array.isArray(body.chunks) ? body.chunks.length : 0, sockets: state.sockets.size });
    return;
  }

  await serveStatic(state, request, url.pathname, response);
}

function currentPlayers(state, now = Date.now()) {
  if (
    state.players.length > 0 &&
    state.playersReceivedAt > 0 &&
    now - state.playersReceivedAt >= state.playerStaleAfterMs
  ) {
    state.players = [];
  }
  return state.players;
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Plugin-Token",
    ...extra,
  };
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, corsHeaders({ "Content-Type": "application/json; charset=utf-8", ...headers }));
  response.end(JSON.stringify(body));
}

async function readJsonBody(request, maxBytes) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw requestError(413, "payload_too_large", `JSON request body exceeds ${maxBytes} bytes`);
  }
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    totalBytes += bytes.length;
    if (totalBytes > maxBytes) {
      throw requestError(413, "payload_too_large", `JSON request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(bytes);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw requestError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function requestError(statusCode, errorCode, message) {
  return Object.assign(new Error(message), { statusCode, errorCode });
}

function authorized(state, request) {
  if (!state.pluginToken) {
    return true;
  }
  const auth = request.headers.authorization || "";
  const header = request.headers["x-plugin-token"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return bearer === state.pluginToken || header === state.pluginToken;
}

export function cleanSegment(value) {
  return String(value || "default").replace(/[^A-Za-z0-9_.-]/g, "_") || "default";
}

export function playerAvatarUrl(player) {
  if (!player || !player.avatarHash) {
    return "";
  }
  const params = new URLSearchParams({ _: String(player.avatarHash) });
  return `/api/players/${encodeURIComponent(String(player.id))}/avatar.png?${params.toString()}`;
}

async function normalizePlayers(dataDir, players) {
  const normalized = [];
  for (const rawPlayer of players) {
    if (!rawPlayer || typeof rawPlayer !== "object") {
      continue;
    }
    const player = {
      id: String(rawPlayer.id || rawPlayer.name || "player"),
      name: String(rawPlayer.name || rawPlayer.id || "Player"),
      xuid: String(rawPlayer.xuid || ""),
      world: String(rawPlayer.world || "Bedrock level"),
      dimension: String(rawPlayer.dimension || "Overworld"),
      x: numberOr(rawPlayer.x, 0),
      y: numberOr(rawPlayer.y, 0),
      z: numberOr(rawPlayer.z, 0),
      yaw: numberOr(rawPlayer.yaw, 0),
      pitch: numberOr(rawPlayer.pitch, 0),
      updatedAt: numberOr(rawPlayer.updatedAt, Date.now()),
    };
    const avatarHash = validHash(rawPlayer.avatarHash) ? String(rawPlayer.avatarHash).toLowerCase() : "";
    if (avatarHash) {
      player.avatarHash = avatarHash;
      player.avatarUrl = playerAvatarUrl(player);
      await maybeWriteAvatar(dataDir, player.id, avatarHash, rawPlayer.avatarPngBase64);
    }
    normalized.push(player);
  }
  return normalized;
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nonNegativeIntegerOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function validHash(value) {
  return /^[a-fA-F0-9]{16,128}$/.test(String(value || ""));
}

async function maybeWriteAvatar(dataDir, playerId, avatarHash, avatarPngBase64) {
  if (!avatarPngBase64 || typeof avatarPngBase64 !== "string") {
    return;
  }
  const bytes = Buffer.from(avatarPngBase64, "base64");
  if (!isPng(bytes) || bytes.length > 128 * 1024) {
    return;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== avatarHash) {
    return;
  }
  const file = avatarFile(dataDir, playerId);
  try {
    if ((await fs.readFile(`${file}.sha256`, "utf8")).trim() === avatarHash) {
      await fs.access(file);
      return;
    }
  } catch {
    // Missing or incomplete avatar state is repaired atomically below.
  }
  await writeFileAtomic(file, bytes);
  await writeFileAtomic(`${file}.sha256`, `${avatarHash}\n`);
}

function isPng(bytes) {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
}

async function servePlayerAvatar(state, pathname, response) {
  const match = /^\/api\/players\/([^/]+)\/avatar\.png$/.exec(pathname);
  if (!match) {
    json(response, 404, { error: "invalid_avatar_path" });
    return;
  }
  const playerId = decodeURIComponent(match[1]);
  const file = avatarFile(state.dataDir, playerId);
  if (!existsSync(file)) {
    response.writeHead(200, corsHeaders({ "Content-Type": "image/png", "Cache-Control": "public, max-age=30" }));
    response.end(EMPTY_PNG);
    return;
  }
  response.writeHead(200, corsHeaders({ "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" }));
  createReadStream(file).pipe(response);
}

function avatarFile(dataDir, playerId) {
  return path.join(dataDir, "avatars", `${cleanSegment(playerId)}.png`);
}

async function readWorlds(serverState) {
  const index = await ensureWorldIndex(serverState);
  return [...index.values()]
    .filter((entry) => entry.chunkCount > 0 && entry.bounds)
    .map((entry) => ({
      version: 2,
      world: entry.world,
      dimension: entry.dimension,
      status: "live",
      chunkCount: entry.chunkCount,
      importedAt: entry.importedAt || entry.updatedAt || 0,
      updatedAt: entry.updatedAt || 0,
      bounds: entry.bounds || null,
      sampleChunks: sampleChunksFor(entry),
      topBlocks: {},
    }))
    .sort(compareWorldMeta);
}

async function ensureWorldIndex(serverState) {
  if (serverState.worldIndex) {
    return serverState.worldIndex;
  }
  if (!serverState.worldIndexPromise) {
    serverState.worldIndexPromise = loadOrBuildWorldIndex(serverState.dataDir)
      .then((index) => {
        serverState.worldIndex = index;
        return index;
      });
  }
  try {
    return await serverState.worldIndexPromise;
  } finally {
    serverState.worldIndexPromise = null;
  }
}

async function loadOrBuildWorldIndex(dataDir) {
  const persistedIndex = await readWorldIndex(dataDir);
  if (persistedIndex) {
    return persistedIndex;
  }
  const migratedIndex = await buildWorldIndexFromLegacyData(dataDir);
  await writeWorldIndexAtomic(dataDir, migratedIndex);
  return migratedIndex;
}

async function buildWorldIndexFromLegacyData(dataDir) {
  const persisted = await readState(dataDir);
  const persistedWorlds = Object.values(persisted.worlds || {});
  const canonicalWorldNames = new Map(
    persistedWorlds.map((entry) => [cleanSegment(entry.world), String(entry.world)]),
  );
  const persistedByKey = new Map(
    persistedWorlds.map((entry) => [`${cleanSegment(entry.world)}/${cleanSegment(entry.dimension)}`, entry]),
  );
  const index = new Map();
  const tilesRoot = path.join(dataDir, "tiles");

  let worldDirectories = [];
  try {
    worldDirectories = (await fs.readdir(tilesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  for (const worldDirectory of worldDirectories) {
    const worldSegment = cleanSegment(worldDirectory.name);
    const worldName = canonicalWorldNames.get(worldSegment) || worldDirectory.name;
    const worldPath = path.join(tilesRoot, worldDirectory.name);
    const dimensionDirectories = (await fs.readdir(worldPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    for (const dimensionDirectory of dimensionDirectories) {
      const dimensionName = dimensionDirectory.name;
      const key = `${worldSegment}/${cleanSegment(dimensionName)}`;
      const persistedEntry = persistedByKey.get(key);
      const entry = getOrCreateWorldIndexEntry(index, persistedEntry?.world || worldName, persistedEntry?.dimension || dimensionName, persistedEntry);
      await addBaseTileChunks(entry, path.join(worldPath, dimensionDirectory.name, "z4"));
    }
  }

  for (const persistedEntry of persistedWorlds) {
    const entry = getOrCreateWorldIndexEntry(index, persistedEntry.world, persistedEntry.dimension, persistedEntry);
    for (const coordinate of Object.keys(persistedEntry.chunks || {})) {
      const [chunkX, chunkZ] = coordinate.split(",").map(Number);
      if (Number.isInteger(chunkX) && Number.isInteger(chunkZ)) {
        addWorldIndexChunk(entry, chunkX, chunkZ, persistedEntry.chunks[coordinate]);
      }
    }
  }
  return index;
}

function getOrCreateWorldIndexEntry(index, worldName, dimensionName, persistedEntry = null) {
  const key = `${cleanSegment(worldName)}/${cleanSegment(dimensionName)}`;
  let entry = index.get(key);
  if (!entry) {
    entry = {
      world: String(worldName),
      dimension: String(dimensionName),
      importedAt: numberOr(persistedEntry?.importedAt || persistedEntry?.updatedAt, 0),
      updatedAt: numberOr(persistedEntry?.updatedAt, 0),
      bounds: normalizeBounds(persistedEntry?.bounds),
      chunkRows: new Map(),
      chunkCount: 0,
      sampleCacheKey: "",
      sampleChunks: [],
    };
    index.set(key, entry);
  } else if (persistedEntry) {
    entry.world = String(persistedEntry.world || entry.world);
    entry.dimension = String(persistedEntry.dimension || entry.dimension);
    entry.importedAt = numberOr(persistedEntry.importedAt || entry.importedAt, 0);
    entry.updatedAt = Math.max(entry.updatedAt, numberOr(persistedEntry.updatedAt, 0));
    entry.bounds = expandBounds(entry.bounds, normalizeBounds(persistedEntry.bounds));
  } else if (entry.world === cleanSegment(entry.world) && String(worldName) !== cleanSegment(worldName)) {
    entry.world = String(worldName);
  }
  return entry;
}

async function addBaseTileChunks(entry, zoomPath) {
  let xDirectories = [];
  try {
    xDirectories = (await fs.readdir(zoomPath, { withFileTypes: true })).filter((item) => item.isDirectory());
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const validDirectories = xDirectories
    .map((directory) => ({ directory, chunkX: Number(directory.name) }))
    .filter(({ chunkX }) => Number.isInteger(chunkX));
  for (let offset = 0; offset < validDirectories.length; offset += WORLD_INDEX_SCAN_CONCURRENCY) {
    const batch = validDirectories.slice(offset, offset + WORLD_INDEX_SCAN_CONCURRENCY);
    const listings = await Promise.all(
      batch.map(async ({ directory, chunkX }) => ({
        chunkX,
        files: await fs.readdir(path.join(zoomPath, directory.name), { withFileTypes: true }),
      })),
    );
    for (const { chunkX, files } of listings) {
      for (const file of files) {
        if (!file.isFile() || path.extname(file.name) !== ".png") {
          continue;
        }
        const chunkZ = Number(path.basename(file.name, ".png"));
        if (Number.isInteger(chunkZ)) {
          addWorldIndexChunk(entry, chunkX, chunkZ, 0);
        }
      }
    }
  }
}

function addWorldIndexChunk(entry, chunkX, chunkZ, updatedAt) {
  entry.updatedAt = Math.max(entry.updatedAt, numberOr(updatedAt, 0));
  let intervals = entry.chunkRows.get(chunkX);
  if (!intervals) {
    intervals = [];
    entry.chunkRows.set(chunkX, intervals);
  }

  let insertionIndex = 0;
  while (insertionIndex < intervals.length && intervals[insertionIndex][1] < chunkZ - 1) {
    insertionIndex += 1;
  }
  if (
    insertionIndex < intervals.length &&
    intervals[insertionIndex][0] <= chunkZ &&
    intervals[insertionIndex][1] >= chunkZ
  ) {
    return false;
  }

  if (insertionIndex === intervals.length || intervals[insertionIndex][0] > chunkZ + 1) {
    intervals.splice(insertionIndex, 0, [chunkZ, chunkZ]);
  } else {
    intervals[insertionIndex][0] = Math.min(intervals[insertionIndex][0], chunkZ);
    intervals[insertionIndex][1] = Math.max(intervals[insertionIndex][1], chunkZ);
    while (
      insertionIndex + 1 < intervals.length &&
      intervals[insertionIndex + 1][0] <= intervals[insertionIndex][1] + 1
    ) {
      intervals[insertionIndex][1] = Math.max(intervals[insertionIndex][1], intervals[insertionIndex + 1][1]);
      intervals.splice(insertionIndex + 1, 1);
    }
  }

  entry.chunkCount += 1;
  entry.bounds = expandBounds(entry.bounds, boundsForChunkRange(chunkX, chunkZ, chunkZ));
  entry.sampleCacheKey = "";
  return true;
}

function sampleChunksFor(entry) {
  if (!entry.bounds || entry.chunkCount === 0) {
    return [];
  }
  const cacheKey = sampleCacheKeyFor(entry);
  if (entry.sampleCacheKey === cacheKey) {
    return entry.sampleChunks;
  }

  const centerX = (entry.bounds.minChunkX + entry.bounds.maxChunkX) / 2;
  const centerZ = (entry.bounds.minChunkZ + entry.bounds.maxChunkZ) / 2;
  const candidates = [];
  for (const [chunkX, intervals] of entry.chunkRows) {
    for (const [startChunkZ, endChunkZ] of intervals) {
      const anchor = Math.max(startChunkZ, Math.min(endChunkZ, Math.round(centerZ)));
      for (let offset = 0; offset < WORLD_INDEX_SAMPLE_LIMIT; offset += 1) {
        considerSampleCandidate(candidates, chunkX, anchor - offset, startChunkZ, endChunkZ, centerX, centerZ);
        if (offset > 0) {
          considerSampleCandidate(candidates, chunkX, anchor + offset, startChunkZ, endChunkZ, centerX, centerZ);
        }
      }
    }
  }
  entry.sampleChunks = candidates
    .sort(compareSampleCandidate)
    .map(({ chunkX, chunkZ }) => ({ chunkX, chunkZ }));
  entry.sampleCacheKey = cacheKey;
  return entry.sampleChunks;
}

function sampleCacheKeyFor(entry) {
  return [
    entry.chunkCount,
    entry.bounds?.minChunkX,
    entry.bounds?.maxChunkX,
    entry.bounds?.minChunkZ,
    entry.bounds?.maxChunkZ,
  ].join(":");
}

function considerSampleCandidate(candidates, chunkX, chunkZ, startChunkZ, endChunkZ, centerX, centerZ) {
  if (chunkZ < startChunkZ || chunkZ > endChunkZ) {
    return;
  }
  const candidate = {
    chunkX,
    chunkZ,
    distance: (chunkX - centerX) ** 2 + (chunkZ - centerZ) ** 2,
  };
  if (candidates.length < WORLD_INDEX_SAMPLE_LIMIT) {
    candidates.push(candidate);
    return;
  }
  let worstIndex = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (compareSampleCandidate(candidates[index], candidates[worstIndex]) > 0) {
      worstIndex = index;
    }
  }
  if (compareSampleCandidate(candidate, candidates[worstIndex]) < 0) {
    candidates[worstIndex] = candidate;
  }
}

function compareSampleCandidate(left, right) {
  return left.distance - right.distance ||
    left.chunkX - right.chunkX ||
    left.chunkZ - right.chunkZ;
}

function compareWorldMeta(left, right) {
  const dimensionOrder = new Map([["Overworld", 0], ["Nether", 1], ["TheEnd", 2]]);
  return String(left.world).localeCompare(String(right.world)) ||
    (dimensionOrder.get(left.dimension) ?? 99) - (dimensionOrder.get(right.dimension) ?? 99) ||
    String(left.dimension).localeCompare(String(right.dimension));
}

async function readWorldIndex(dataDir) {
  let persisted;
  try {
    persisted = JSON.parse(await fs.readFile(path.join(dataDir, WORLD_INDEX_FILE_NAME), "utf8"));
  } catch {
    return null;
  }
  if (persisted?.version !== WORLD_INDEX_VERSION || !Array.isArray(persisted.worlds)) {
    return null;
  }

  const index = new Map();
  for (const persistedEntry of persisted.worlds) {
    if (
      !persistedEntry ||
      typeof persistedEntry.world !== "string" ||
      typeof persistedEntry.dimension !== "string" ||
      !Array.isArray(persistedEntry.chunkRows)
    ) {
      return null;
    }
    const entry = getOrCreateWorldIndexEntry(
      index,
      persistedEntry.world,
      persistedEntry.dimension,
      persistedEntry,
    );
    const seenChunkX = new Set();
    let derivedBounds = null;
    for (const row of persistedEntry.chunkRows) {
      if (!Array.isArray(row) || row.length < 3 || row.length % 2 !== 1) {
        return null;
      }
      const chunkX = Number(row[0]);
      if (!Number.isInteger(chunkX) || seenChunkX.has(chunkX)) {
        return null;
      }
      seenChunkX.add(chunkX);
      const intervals = [];
      let previousEnd = Number.NEGATIVE_INFINITY;
      for (let offset = 1; offset < row.length; offset += 2) {
        const startChunkZ = Number(row[offset]);
        const endChunkZ = Number(row[offset + 1]);
        if (
          !Number.isInteger(startChunkZ) ||
          !Number.isInteger(endChunkZ) ||
          startChunkZ > endChunkZ ||
          startChunkZ <= previousEnd + 1
        ) {
          return null;
        }
        const rangeSize = endChunkZ - startChunkZ + 1;
        if (!Number.isSafeInteger(entry.chunkCount + rangeSize)) {
          return null;
        }
        intervals.push([startChunkZ, endChunkZ]);
        entry.chunkCount += rangeSize;
        previousEnd = endChunkZ;
        derivedBounds = expandBounds(derivedBounds, boundsForChunkRange(chunkX, startChunkZ, endChunkZ));
      }
      entry.chunkRows.set(chunkX, intervals);
    }
    if (Number(persistedEntry.chunkCount) !== entry.chunkCount) {
      return null;
    }
    entry.bounds = expandBounds(entry.bounds, derivedBounds);

    const persistedSamples = Array.isArray(persistedEntry.sampleChunks)
      ? persistedEntry.sampleChunks
        .map((sample) => ({ chunkX: Number(sample?.chunkX), chunkZ: Number(sample?.chunkZ) }))
        .filter((sample) => Number.isInteger(sample.chunkX) && Number.isInteger(sample.chunkZ))
      : [];
    const expectedSampleCount = Math.min(WORLD_INDEX_SAMPLE_LIMIT, entry.chunkCount);
    if (
      persistedSamples.length === expectedSampleCount &&
      persistedSamples.every((sample) => worldIndexHasChunk(entry, sample.chunkX, sample.chunkZ))
    ) {
      entry.sampleChunks = persistedSamples;
      entry.sampleCacheKey = sampleCacheKeyFor(entry);
    }
  }
  return index;
}

async function writeWorldIndexAtomic(dataDir, index) {
  const destination = path.join(dataDir, WORLD_INDEX_FILE_NAME);
  await writeFileAtomic(destination, `${JSON.stringify(serializeWorldIndex(index))}\n`);
}

async function writeFileAtomic(destination, contents) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.${atomicWriteSequence += 1}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx");
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function serializeWorldIndex(index) {
  const worlds = [...index.values()]
    .sort(compareWorldMeta)
    .map((entry) => ({
      world: entry.world,
      dimension: entry.dimension,
      importedAt: entry.importedAt || entry.updatedAt || 0,
      updatedAt: entry.updatedAt || 0,
      bounds: entry.bounds,
      chunkCount: entry.chunkCount,
      sampleChunks: sampleChunksFor(entry),
      chunkRows: [...entry.chunkRows]
        .sort(([leftChunkX], [rightChunkX]) => leftChunkX - rightChunkX)
        .map(([chunkX, intervals]) => [
          chunkX,
          ...intervals.flatMap(([startChunkZ, endChunkZ]) => [startChunkZ, endChunkZ]),
        ]),
    }));
  return { version: WORLD_INDEX_VERSION, worlds };
}

function worldIndexHasChunk(entry, chunkX, chunkZ) {
  const intervals = entry.chunkRows.get(chunkX);
  if (!intervals) {
    return false;
  }
  for (const [startChunkZ, endChunkZ] of intervals) {
    if (chunkZ < startChunkZ) {
      return false;
    }
    if (chunkZ <= endChunkZ) {
      return true;
    }
  }
  return false;
}

function boundsForChunkRange(chunkX, startChunkZ, endChunkZ) {
  return {
    minChunkX: chunkX,
    maxChunkX: chunkX,
    minChunkZ: startChunkZ,
    maxChunkZ: endChunkZ,
    minBlockX: chunkX * 16,
    maxBlockX: chunkX * 16 + 15,
    minBlockZ: startChunkZ * 16,
    maxBlockZ: endChunkZ * 16 + 15,
  };
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== "object") {
    return null;
  }
  const normalized = {};
  for (const key of [
    "minChunkX",
    "maxChunkX",
    "minChunkZ",
    "maxChunkZ",
    "minBlockX",
    "maxBlockX",
    "minBlockZ",
    "maxBlockZ",
  ]) {
    const value = Number(bounds[key]);
    if (!Number.isFinite(value)) {
      return null;
    }
    normalized[key] = value;
  }
  return normalized;
}

async function readState(dataDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
  } catch {
    return { version: 2, worlds: {} };
  }
}

function enqueueWorldIndexUpdate(serverState, update) {
  const pending = serverState.worldIndexUpdatePromise.then(update, update);
  serverState.worldIndexUpdatePromise = pending.catch(() => {});
  return pending;
}

async function updateWorldsFromTiles(serverState, payload) {
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  if (chunks.length === 0) {
    return;
  }
  await enqueueWorldIndexUpdate(serverState, async () => {
    const worldIndex = await ensureWorldIndex(serverState);
    const payloadUpdatedAt = Number(payload.updatedAt);
    const now = Number.isFinite(payloadUpdatedAt) ? payloadUpdatedAt : Date.now();
    let changed = false;
    for (const chunk of chunks) {
      const worldName = String(chunk.world || "Bedrock level");
      const dimensionName = String(chunk.dimension || "Overworld");
      const chunkX = Number(chunk.chunkX);
      const chunkZ = Number(chunk.chunkZ);
      if (!Number.isInteger(chunkX) || !Number.isInteger(chunkZ)) {
        continue;
      }
      const key = `${cleanSegment(worldName)}/${cleanSegment(dimensionName)}`;
      const chunkUpdatedAtValue = Number(chunk.updatedAt);
      const chunkUpdatedAt = Number.isFinite(chunkUpdatedAtValue) ? chunkUpdatedAtValue : now;
      let entry = worldIndex.get(key);
      if (!entry) {
        entry = getOrCreateWorldIndexEntry(worldIndex, worldName, dimensionName, {
          world: worldName,
          dimension: dimensionName,
          importedAt: now,
          updatedAt: chunkUpdatedAt,
          bounds: null,
        });
        changed = true;
      }
      const previousUpdatedAt = entry.updatedAt;
      const added = addWorldIndexChunk(entry, chunkX, chunkZ, chunkUpdatedAt);
      changed ||= added || entry.updatedAt !== previousUpdatedAt;
    }
    if (changed) {
      await writeWorldIndexAtomic(serverState.dataDir, worldIndex);
    }
  });
}

function expandBounds(current, next) {
  if (!next) {
    return current;
  }
  if (!current) {
    return next;
  }
  return {
    minChunkX: Math.min(current.minChunkX, next.minChunkX),
    maxChunkX: Math.max(current.maxChunkX, next.maxChunkX),
    minChunkZ: Math.min(current.minChunkZ, next.minChunkZ),
    maxChunkZ: Math.max(current.maxChunkZ, next.maxChunkZ),
    minBlockX: Math.min(current.minBlockX, next.minBlockX),
    maxBlockX: Math.max(current.maxBlockX, next.maxBlockX),
    minBlockZ: Math.min(current.minBlockZ, next.minBlockZ),
    maxBlockZ: Math.max(current.maxBlockZ, next.maxBlockZ),
  };
}

async function writeLandClaims(dataDir, claims, scope = {}) {
  const groups = new Map();
  for (const claim of claims) {
    const world = String(claim.world || "Bedrock level");
    const dimension = String(claim.dimension || "Overworld");
    const key = `${cleanSegment(world)}/${cleanSegment(dimension)}`;
    if (!groups.has(key)) {
      groups.set(key, { world, dimension, claims: [] });
    }
    groups.get(key).claims.push(claim);
  }
  const scopeWorld = typeof scope.world === "string" && scope.world ? scope.world : "";
  const scopeDimensions = Array.isArray(scope.dimensions) ? scope.dimensions : [];
  if (scopeWorld) {
    for (const rawDimension of scopeDimensions) {
      const dimension = String(rawDimension || "");
      if (!dimension) {
        continue;
      }
      const key = `${cleanSegment(scopeWorld)}/${cleanSegment(dimension)}`;
      if (!groups.has(key)) {
        groups.set(key, { world: scopeWorld, dimension, claims: [] });
      }
    }
  }
  const written = [];
  for (const group of groups.values()) {
    const file = landFile(dataDir, cleanSegment(group.world), cleanSegment(group.dimension));
    const existing = await readLandFile(dataDir, cleanSegment(group.world), cleanSegment(group.dimension));
    if (landClaimsSignature(existing.claims) === landClaimsSignature(group.claims)) {
      continue;
    }
    const updatedAt = Math.max(
      Date.now(),
      numberOr(existing.updatedAt, 0) + 1,
      ...group.claims.map((claim) => Number(claim.updatedAt || 0)),
    );
    await writeFileAtomic(
      file,
      `${JSON.stringify({ version: 1, world: group.world, dimension: group.dimension, claims: group.claims, updatedAt }, null, 2)}\n`,
    );
    written.push({ world: group.world, dimension: group.dimension, updatedAt });
  }
  return written;
}

function landClaimsSignature(claims) {
  return JSON.stringify(Array.isArray(claims) ? claims : [], (key, value) => key === "updatedAt" ? undefined : value);
}

async function readLandFile(dataDir, world, dimension) {
  try {
    return JSON.parse(await fs.readFile(landFile(dataDir, world, dimension), "utf8"));
  } catch {
    return { version: 1, world, dimension, claims: [], updatedAt: 0 };
  }
}

function landFile(dataDir, world, dimension) {
  return path.join(dataDir, "lands", world, `${dimension}.json`);
}

async function serveTile(state, request, url, response) {
  const match = /^\/api\/(?:local-)?map-tiles\/([^/]+)\/([^/]+)\/z(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/.exec(url.pathname);
  if (!match) {
    json(response, 404, { error: "invalid_tile_path" });
    return;
  }
  const [, world, dimension, zoom, tileX, tileZ] = match;
  const file = path.join(state.dataDir, "tiles", cleanSegment(world), cleanSegment(dimension), `z${Number(zoom)}`, String(Number(tileX)), `${Number(tileZ)}.png`);
  const version = url.searchParams.has("_") ? url.searchParams.get("_") ?? "" : null;
  const immutableCacheControl = "public, max-age=31536000, immutable";
  const cloudflareMutableCacheControl = "public, max-age=60, stale-while-revalidate=86400, stale-if-error=86400";
  const tile = await loadTile(state, file, version);
  if (!tile) {
    response.writeHead(200, corsHeaders({
      "Content-Type": "image/png",
      "Content-Length": EMPTY_PNG.length,
      "Cache-Control": version !== null ? immutableCacheControl : "no-store",
      "Cloudflare-CDN-Cache-Control": version !== null ? immutableCacheControl : "no-store",
    }));
    response.end(EMPTY_PNG);
    return;
  }
  const headers = corsHeaders({
    "Content-Type": "image/png",
    "Content-Length": tile.bytes.length,
    "Cache-Control": version !== null ? immutableCacheControl : "public, no-cache",
    "Cloudflare-CDN-Cache-Control": version !== null ? immutableCacheControl : cloudflareMutableCacheControl,
    ETag: tile.etag,
    "Last-Modified": tile.lastModified,
  });
  if (request.headers["if-none-match"] === tile.etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const modifiedSince = Date.parse(String(request.headers["if-modified-since"] || ""));
  if (Number.isFinite(modifiedSince) && modifiedSince >= Math.floor(tile.mtimeMs / 1000) * 1000) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  response.end(tile.bytes);
}

async function loadTile(state, file, version) {
  const cacheKey = `${file}\0${version === null ? "mutable" : `version:${version}`}`;
  const now = Date.now();
  const cached = state.tileCache.get(cacheKey);
  if (cached && (version !== null || now - cached.checkedAt <= state.tileCacheFreshMs)) {
    touchTileCacheEntry(state, cacheKey, cached);
    return cached;
  }

  const missingUntil = state.missingTileCache.get(file);
  if (missingUntil && missingUntil > now) {
    touchMissingTileEntry(state, file, missingUntil);
    return null;
  }
  if (missingUntil) {
    state.missingTileCache.delete(file);
  }

  const pending = state.tileLoads.get(cacheKey);
  if (pending) {
    return pending;
  }

  const load = (async () => {
    if (cached && version === null) {
      const stats = await statTileFile(file);
      if (!stats) {
        removeTileCacheEntry(state, cacheKey);
        rememberMissingTile(state, file);
        return null;
      }
      if (stats.size === cached.bytes.length && stats.mtimeMs === cached.mtimeMs) {
        cached.checkedAt = Date.now();
        touchTileCacheEntry(state, cacheKey, cached);
        return cached;
      }
    }

    const loaded = await readTileFile(file);
    if (!loaded) {
      removeTileCacheEntry(state, cacheKey);
      rememberMissingTile(state, file);
      return null;
    }
    state.missingTileCache.delete(file);
    cacheTileEntry(state, cacheKey, loaded);
    return loaded;
  })();
  state.tileLoads.set(cacheKey, load);
  try {
    return await load;
  } finally {
    if (state.tileLoads.get(cacheKey) === load) {
      state.tileLoads.delete(cacheKey);
    }
  }
}

async function statTileFile(file) {
  try {
    const stats = await fs.stat(file);
    return stats.isFile() ? stats : null;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readTileFile(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return null;
    }
    const bytes = await handle.readFile();
    return {
      bytes,
      checkedAt: Date.now(),
      mtimeMs: stats.mtimeMs,
      etag: `"${bytes.length.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
      lastModified: stats.mtime.toUTCString(),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function cacheTileEntry(state, cacheKey, entry) {
  removeTileCacheEntry(state, cacheKey);
  if (
    state.tileCacheMaxBytes === 0 ||
    state.tileCacheMaxEntries === 0 ||
    entry.bytes.length > state.tileCacheMaxBytes
  ) {
    return;
  }
  while (
    state.tileCache.size >= state.tileCacheMaxEntries ||
    state.tileCacheBytes + entry.bytes.length > state.tileCacheMaxBytes
  ) {
    const oldestKey = state.tileCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    removeTileCacheEntry(state, oldestKey);
  }
  state.tileCache.set(cacheKey, entry);
  state.tileCacheBytes += entry.bytes.length;
}

function touchTileCacheEntry(state, cacheKey, entry) {
  if (!state.tileCache.has(cacheKey)) {
    return;
  }
  state.tileCache.delete(cacheKey);
  state.tileCache.set(cacheKey, entry);
}

function removeTileCacheEntry(state, cacheKey) {
  const existing = state.tileCache.get(cacheKey);
  if (!existing) {
    return;
  }
  state.tileCache.delete(cacheKey);
  state.tileCacheBytes = Math.max(0, state.tileCacheBytes - existing.bytes.length);
}

function rememberMissingTile(state, file) {
  if (state.missingTileCacheMs === 0 || state.tileCacheMaxEntries === 0) {
    return;
  }
  touchMissingTileEntry(state, file, Date.now() + state.missingTileCacheMs);
  while (state.missingTileCache.size > state.tileCacheMaxEntries) {
    const oldestKey = state.missingTileCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    state.missingTileCache.delete(oldestKey);
  }
}

function touchMissingTileEntry(state, file, expiresAt) {
  state.missingTileCache.delete(file);
  state.missingTileCache.set(file, expiresAt);
}

async function serveStatic(state, request, pathname, response) {
  const webDir = state.webDir;
  const requested = pathname === "/" ? "/index.html" : pathname;
  const normalized = path.normalize(decodeURIComponent(requested)).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  let file = path.join(webDir, normalized);
  if (!file.startsWith(webDir)) {
    json(response, 403, { error: "forbidden" });
    return;
  }
  if (!existsSync(file)) {
    file = path.join(webDir, "index.html");
  }
  if (!existsSync(file)) {
    json(response, 404, { error: "web_dist_not_found", webDir });
    return;
  }
  const stats = await fs.stat(file);
  const type = contentType(file);
  const cacheEntry = await loadStaticCacheEntry(state, file, stats);
  const isIndex = path.basename(file) === "index.html";
  const responseEntry = isIndex
    ? withWorldBootstrap(cacheEntry, await readWorlds(state))
    : cacheEntry;
  const preferredEncoding = isCompressibleContentType(type)
    ? preferredContentEncoding(request.headers["accept-encoding"])
    : null;
  const representation = await staticRepresentation(state, file, responseEntry, preferredEncoding);
  const etag = isIndex
    ? `"${createHash("sha256").update(representation.bytes).digest("base64url").slice(0, 24)}-${representation.encoding || "identity"}"`
    : `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}-${representation.encoding || "identity"}"`;
  const headers = corsHeaders({
    "Content-Type": type,
    "Content-Length": representation.bytes.length,
    "Cache-Control": isIndex
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    ETag: etag,
    "Last-Modified": stats.mtime.toUTCString(),
    ...(isCompressibleContentType(type) ? { Vary: "Accept-Encoding" } : {}),
    ...(representation.encoding ? { "Content-Encoding": representation.encoding } : {}),
  });
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  response.end(representation.bytes);
}

function withWorldBootstrap(entry, worlds) {
  const source = entry.bytes.toString("utf8");
  if (!source.includes(WEB_BOOTSTRAP_PLACEHOLDER)) {
    return entry;
  }
  const bootstrap = JSON.stringify({ worlds })
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const bytes = Buffer.from(source.replace(WEB_BOOTSTRAP_PLACEHOLDER, bootstrap));
  return {
    bytes,
    size: bytes.length,
    mtimeMs: entry.mtimeMs,
    encoded: new Map(),
    encodingPromises: new Map(),
  };
}

async function loadStaticCacheEntry(state, file, stats) {
  const cached = state.staticCache.get(file);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
    state.staticCache.delete(file);
    state.staticCache.set(file, cached);
    return cached;
  }
  if (cached) {
    removeStaticCacheEntry(state, file);
  }

  const entry = {
    bytes: await fs.readFile(file),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    encoded: new Map(),
    encodingPromises: new Map(),
  };
  if (
    state.staticCacheMaxBytes > 0 &&
    state.staticCacheMaxEntries > 0 &&
    entry.bytes.length <= state.staticCacheMaxBytes
  ) {
    trimStaticCache(state, entry.bytes.length, 1);
    state.staticCache.set(file, entry);
    state.staticCacheBytes += entry.bytes.length;
  }
  return entry;
}

async function staticRepresentation(state, file, entry, encoding) {
  if (!encoding || entry.bytes.length < MIN_STATIC_COMPRESSION_BYTES) {
    return { bytes: entry.bytes, encoding: null };
  }
  const encoded = entry.encoded.get(encoding);
  if (encoded) {
    return { bytes: encoded, encoding };
  }

  let pending = entry.encodingPromises.get(encoding);
  if (!pending) {
    pending = (encoding === "br"
      ? brotliCompressAsync(entry.bytes, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 6,
        },
      })
      : gzipAsync(entry.bytes, { level: 6 }))
      .then((bytes) => Buffer.from(bytes));
    entry.encodingPromises.set(encoding, pending);
  }
  try {
    const bytes = await pending;
    if (bytes.length >= entry.bytes.length) {
      return { bytes: entry.bytes, encoding: null };
    }
    if (!entry.encoded.has(encoding)) {
      entry.encoded.set(encoding, bytes);
      if (state.staticCache.get(file) === entry) {
        state.staticCacheBytes += bytes.length;
        trimStaticCache(state, 0, 0);
      }
    }
    return { bytes, encoding };
  } catch {
    return { bytes: entry.bytes, encoding: null };
  } finally {
    entry.encodingPromises.delete(encoding);
  }
}

function trimStaticCache(state, additionalBytes, additionalEntries) {
  while (
    state.staticCache.size + additionalEntries > state.staticCacheMaxEntries ||
    state.staticCacheBytes + additionalBytes > state.staticCacheMaxBytes
  ) {
    const oldestKey = state.staticCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    removeStaticCacheEntry(state, oldestKey);
  }
}

function removeStaticCacheEntry(state, file) {
  const entry = state.staticCache.get(file);
  if (!entry) {
    return;
  }
  state.staticCache.delete(file);
  state.staticCacheBytes = Math.max(
    0,
    state.staticCacheBytes -
      entry.bytes.length -
      [...entry.encoded.values()].reduce((total, bytes) => total + bytes.length, 0),
  );
}

function preferredContentEncoding(header) {
  const value = String(header || "");
  if (!value) {
    return null;
  }
  const qualities = new Map();
  let wildcardQuality = 0;
  for (const item of value.split(",")) {
    const [rawName, ...parameters] = item.trim().toLowerCase().split(";");
    const qualityParameter = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    const parsedQuality = qualityParameter ? Number(qualityParameter.slice(2)) : 1;
    const quality = Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0;
    if (rawName === "*") {
      wildcardQuality = quality;
    } else if (rawName) {
      qualities.set(rawName, quality);
    }
  }
  const brotliQuality = qualities.get("br") ?? wildcardQuality;
  const gzipQuality = qualities.get("gzip") ?? wildcardQuality;
  if (brotliQuality <= 0 && gzipQuality <= 0) {
    return null;
  }
  return brotliQuality >= gzipQuality ? "br" : "gzip";
}

function isCompressibleContentType(type) {
  return type.startsWith("text/") ||
    type === "application/javascript" ||
    type === "application/json" ||
    type === "image/svg+xml";
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function acceptWebSocket(state, request, socket, head = Buffer.alloc(0)) {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);
  state.sockets.add(socket);
  let bufferedInput = Buffer.alloc(0);
  let closing = false;
  const forgetSocket = () => state.sockets.delete(socket);
  const closeWithCode = (code) => {
    if (closing) {
      return;
    }
    closing = true;
    forgetSocket();
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    if (socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }
    socket.end(webSocketFrame(0x8, payload));
  };
  const handleData = (chunk) => {
    if (closing || chunk.length === 0) {
      return;
    }
    if (bufferedInput.length + chunk.length > state.webSocketMaxBufferedBytes) {
      closeWithCode(1009);
      return;
    }
    bufferedInput = bufferedInput.length === 0 ? chunk : Buffer.concat([bufferedInput, chunk]);

    while (bufferedInput.length >= 2 && !closing) {
      const first = bufferedInput[0];
      const second = bufferedInput[1];
      const finalFrame = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if ((first & 0x70) !== 0 || !masked) {
        closeWithCode(1002);
        return;
      }

      let payloadLength = second & 0x7f;
      let headerLength = 2;
      if (payloadLength === 126) {
        if (bufferedInput.length < 4) {
          return;
        }
        payloadLength = bufferedInput.readUInt16BE(2);
        headerLength = 4;
      } else if (payloadLength === 127) {
        if (bufferedInput.length < 10) {
          return;
        }
        const largePayloadLength = bufferedInput.readBigUInt64BE(2);
        if (largePayloadLength > BigInt(state.webSocketMaxBufferedBytes)) {
          closeWithCode(1009);
          return;
        }
        payloadLength = Number(largePayloadLength);
        headerLength = 10;
      }

      const isControlFrame = opcode >= 0x8;
      if ((isControlFrame && (!finalFrame || payloadLength > 125)) ||
          payloadLength > state.webSocketMaxBufferedBytes) {
        closeWithCode(isControlFrame ? 1002 : 1009);
        return;
      }

      const frameLength = headerLength + 4 + payloadLength;
      if (bufferedInput.length < frameLength) {
        return;
      }
      const mask = bufferedInput.subarray(headerLength, headerLength + 4);
      const encodedPayload = bufferedInput.subarray(headerLength + 4, frameLength);
      const payload = Buffer.allocUnsafe(payloadLength);
      for (let index = 0; index < payloadLength; index += 1) {
        payload[index] = encodedPayload[index] ^ mask[index % 4];
      }
      bufferedInput = bufferedInput.subarray(frameLength);

      if (opcode === 0x8) {
        if (payloadLength === 1) {
          closeWithCode(1002);
          return;
        }
        closing = true;
        forgetSocket();
        socket.end(webSocketFrame(0x8, payload));
        return;
      }
      if (opcode === 0x9) {
        if (socket.writableLength + payload.length + 2 > state.webSocketMaxBufferedBytes) {
          closeWithCode(1009);
          return;
        }
        socket.write(webSocketFrame(0xA, payload));
        continue;
      }
      if (opcode === 0xA || opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        continue;
      }
      closeWithCode(1002);
      return;
    }
  };
  socket.on("data", handleData);
  socket.on("end", forgetSocket);
  socket.on("close", forgetSocket);
  socket.on("error", forgetSocket);
  if (head.length > 0) {
    handleData(head);
  }
}

function broadcast(state, message) {
  const frame = webSocketTextFrame(message);
  for (const socket of state.sockets) {
    if (
      socket.destroyed ||
      !socket.writable ||
      socket.writableLength + frame.length > state.webSocketMaxBufferedBytes
    ) {
      state.sockets.delete(socket);
      socket.destroy();
      continue;
    }
    try {
      socket.write(frame);
    } catch {
      state.sockets.delete(socket);
      socket.destroy();
    }
  }
}

function webSocketTextFrame(message) {
  return webSocketFrame(0x1, Buffer.from(message));
}

function webSocketFrame(opcode, payload) {
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  }
  if (payload.length <= 65535) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.LIVE_MAP_HOST || "127.0.0.1";
  const port = Number(process.env.LIVE_MAP_PORT || 8000);
  const { server, state } = createLiveMapServer();
  if (!state.pluginToken && process.env.LIVE_MAP_ALLOW_INSECURE_PLUGIN_WRITES !== "true") {
    console.error("LIVE_MAP_PLUGIN_TOKEN is required (or explicitly set LIVE_MAP_ALLOW_INSECURE_PLUGIN_WRITES=true for local development)");
    process.exitCode = 1;
  } else {
    server.listen(port, host, () => {
      console.log(`endstone-live-map local server listening on http://${host}:${port}`);
      void ensureWorldIndex(state).catch((error) => {
        console.error(`failed to prewarm live map world index: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
  }
}
