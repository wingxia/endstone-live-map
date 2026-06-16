import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const WEB_DIST_DIR = path.join(ROOT_DIR, "web", "dist");
const DEFAULT_DATA_DIR = path.join(ROOT_DIR, "plugin-data", "live_map");
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
    sockets: new Set(),
    dataDir,
    pluginToken,
    webDir,
  };

  const server = http.createServer((request, response) => {
    void handleRequest(state, request, response).catch((error) => {
      json(response, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
    });
  });

  server.on("upgrade", (request, socket) => {
    if (new URL(request.url || "/", "http://localhost").pathname !== "/api/live") {
      socket.destroy();
      return;
    }
    acceptWebSocket(state, request, socket);
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
    json(response, 200, { ok: true, service: "endstone-live-map-local-server", dataDir: state.dataDir });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    json(response, 200, { tileSize: 256, minZoom: -1, maxZoom: 4, defaultWorld: "Bedrock level", dimensions: ["Overworld", "Nether", "TheEnd"] });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/worlds") {
    json(response, 200, { worlds: await readWorlds(state.dataDir) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/players") {
    json(response, 200, { players: state.players });
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
  if (request.method === "GET" && url.pathname.startsWith("/api/map-tiles/")) {
    await serveTile(state, request, url.pathname, response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/plugin/live") {
    if (!authorized(state, request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request);
    state.players = await normalizePlayers(state.dataDir, Array.isArray(body.players) ? body.players : []);
    broadcast(state, JSON.stringify({ type: "player_snapshot", players: state.players }));
    json(response, 200, { ok: true, players: state.players.length });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/plugin/lands") {
    if (!authorized(state, request)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const body = await readJsonBody(request);
    const claims = Array.isArray(body.claims) ? body.claims : [];
    const written = await writeLandClaims(state.dataDir, claims);
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
    const body = await readJsonBody(request);
    await updateWorldsFromTiles(state.dataDir, body);
    broadcast(state, JSON.stringify(body));
    json(response, 200, { ok: true, chunks: Array.isArray(body.chunks) ? body.chunks.length : 0, sockets: state.sockets.size });
    return;
  }

  await serveStatic(state.webDir, url.pathname, response);
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

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  await fs.writeFile(`${file}.sha256`, `${avatarHash}\n`);
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

async function readWorlds(dataDir) {
  const state = await readState(dataDir);
  return Object.values(state.worlds || {}).map((world) => ({
    version: 2,
    world: world.world,
    dimension: world.dimension,
    status: "live",
    chunkCount: Object.keys(world.chunks || {}).length,
    importedAt: world.importedAt || world.updatedAt || 0,
    updatedAt: world.updatedAt || 0,
    bounds: world.bounds || null,
    topBlocks: {},
  }));
}

async function readState(dataDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dataDir, "state.json"), "utf8"));
  } catch {
    return { version: 2, worlds: {} };
  }
}

async function writeState(dataDir, state) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

async function updateWorldsFromTiles(dataDir, payload) {
  const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
  if (chunks.length === 0) {
    return;
  }
  const state = await readState(dataDir);
  state.version = 2;
  state.worlds ||= {};
  const now = Number(payload.updatedAt || Date.now());
  for (const chunk of chunks) {
    const worldName = String(chunk.world || "Bedrock level");
    const dimensionName = String(chunk.dimension || "Overworld");
    const chunkX = Number(chunk.chunkX);
    const chunkZ = Number(chunk.chunkZ);
    if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) {
      continue;
    }
    const key = `${cleanSegment(worldName)}/${cleanSegment(dimensionName)}`;
    const entry = (state.worlds[key] ||= {
      world: worldName,
      dimension: dimensionName,
      importedAt: now,
      updatedAt: now,
      bounds: null,
      chunks: {},
    });
    entry.updatedAt = Math.max(Number(entry.updatedAt || 0), Number(chunk.updatedAt || now));
    entry.chunks[`${chunkX},${chunkZ}`] = Number(chunk.updatedAt || now);
    const chunkBounds = {
      minChunkX: chunkX,
      maxChunkX: chunkX,
      minChunkZ: chunkZ,
      maxChunkZ: chunkZ,
      minBlockX: chunkX * 16,
      maxBlockX: chunkX * 16 + 15,
      minBlockZ: chunkZ * 16,
      maxBlockZ: chunkZ * 16 + 15,
    };
    entry.bounds = expandBounds(entry.bounds, chunkBounds);
  }
  await writeState(dataDir, state);
}

function expandBounds(current, next) {
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

async function writeLandClaims(dataDir, claims) {
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
  const written = [];
  for (const group of groups.values()) {
    const updatedAt = Math.max(Date.now(), ...group.claims.map((claim) => Number(claim.updatedAt || 0)));
    const file = landFile(dataDir, cleanSegment(group.world), cleanSegment(group.dimension));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ version: 1, world: group.world, dimension: group.dimension, claims: group.claims, updatedAt }, null, 2)}\n`);
    written.push({ world: group.world, dimension: group.dimension, updatedAt });
  }
  return written;
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

async function serveTile(state, request, pathname, response) {
  const match = /^\/api\/map-tiles\/([^/]+)\/([^/]+)\/z(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/.exec(pathname);
  if (!match) {
    json(response, 404, { error: "invalid_tile_path" });
    return;
  }
  const [, world, dimension, zoom, tileX, tileZ] = match;
  const file = path.join(state.dataDir, "tiles", cleanSegment(world), cleanSegment(dimension), `z${Number(zoom)}`, String(Number(tileX)), `${Number(tileZ)}.png`);
  if (!existsSync(file)) {
    response.writeHead(200, corsHeaders({ "Content-Type": "image/png", "Cache-Control": "no-store" }));
    response.end(EMPTY_PNG);
    return;
  }
  const stats = await fs.stat(file);
  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  const lastModified = stats.mtime.toUTCString();
  const headers = corsHeaders({
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=0, must-revalidate",
    ETag: etag,
    "Last-Modified": lastModified,
  });
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const modifiedSince = Date.parse(String(request.headers["if-modified-since"] || ""));
  if (Number.isFinite(modifiedSince) && modifiedSince >= Math.floor(stats.mtimeMs / 1000) * 1000) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  createReadStream(file).pipe(response);
}

async function serveStatic(webDir, pathname, response) {
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
  response.writeHead(200, corsHeaders({ "Content-Type": contentType(file) }));
  createReadStream(file).pipe(response);
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function acceptWebSocket(state, request, socket) {
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
  state.sockets.add(socket);
  socket.on("close", () => state.sockets.delete(socket));
  socket.on("error", () => state.sockets.delete(socket));
}

function broadcast(state, message) {
  for (const socket of state.sockets) {
    try {
      socket.write(webSocketTextFrame(message));
    } catch {
      state.sockets.delete(socket);
    }
  }
}

function webSocketTextFrame(message) {
  const payload = Buffer.from(message);
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length <= 65535) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.LIVE_MAP_HOST || "127.0.0.1";
  const port = Number(process.env.LIVE_MAP_PORT || 8000);
  const { server } = createLiveMapServer();
  server.listen(port, host, () => {
    console.log(`endstone-live-map local server listening on http://${host}:${port}`);
  });
}
