import { createConnection } from "mysql2/promise";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Plugin-Token",
};

const TILE_CONTENT_TYPES = new Map([
  ["image/bmp", "bmp"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

const CHUNK_BLOCK_COUNT = 256;
const MAX_CHUNKS_PER_REQUEST = 256;
const TEXTURE_MANIFEST_KEY = "textures/v1/manifest.json";
const TEXTURE_ATLAS_KEY = "textures/v1/atlas.png";

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
        return handleChunkUpload(request, env);
      }

      if (url.pathname === "/api/plugin/tiles") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleTileUpload(request, env);
      }

      if (url.pathname === "/api/chunks") {
        return handleChunksGet(url, env);
      }

      if (url.pathname === "/api/textures/manifest") {
        return handleTextureManifestGet(env);
      }

      if (url.pathname === "/textures/atlas.png") {
        return handleTextureAtlasGet(env);
      }

      if (url.pathname.startsWith("/tiles/")) {
        return handleTileGet(url, env);
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

async function handleChunkUpload(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const snapshot = normalizeChunkSnapshot(await request.json());
  const key = chunkKey(snapshot.world, snapshot.dimension, snapshot.chunkX, snapshot.chunkZ);
  const stats = await getLiveStats(env).catch(() => ({ sessions: 0 }));
  let updates = [];

  if (stats.sessions > 0) {
    const previous = await readR2Json(await bucket.get(key));
    updates = previous ? diffChunkSnapshots(previous, snapshot) : [];
  }

  await bucket.put(key, JSON.stringify(snapshot), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: { world: snapshot.world, dimension: snapshot.dimension },
  });

  await broadcastLive(
    env,
    JSON.stringify({
      type: "chunk_ready",
      world: snapshot.world,
      dimension: snapshot.dimension,
      chunkX: snapshot.chunkX,
      chunkZ: snapshot.chunkZ,
      updatedAt: snapshot.updatedAt,
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
      }),
    );
  }

  return json({ ok: true, key, updates: updates.length });
}

async function handleChunksGet(url, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const query = normalizeChunkQuery(url.searchParams);
  const chunkCount = (query.maxChunkX - query.minChunkX + 1) * (query.maxChunkZ - query.minChunkZ + 1);
  if (chunkCount > MAX_CHUNKS_PER_REQUEST) {
    return json({ error: "too_many_chunks", max: MAX_CHUNKS_PER_REQUEST }, 400);
  }

  const chunks = [];
  const missing = [];
  const reads = [];
  for (let chunkZ = query.minChunkZ; chunkZ <= query.maxChunkZ; chunkZ += 1) {
    for (let chunkX = query.minChunkX; chunkX <= query.maxChunkX; chunkX += 1) {
      reads.push(
        (async () => {
          const key = chunkKey(query.world, query.dimension, chunkX, chunkZ);
          const object = await bucket.get(key);
          if (!object) {
            missing.push({ chunkX, chunkZ });
            return;
          }
          chunks.push(await readR2Json(object));
        })(),
      );
    }
  }
  await Promise.all(reads);
  chunks.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
  missing.sort((a, b) => a.chunkZ - b.chunkZ || a.chunkX - b.chunkX);
  return json({ chunks, missing }, 200, { "Cache-Control": "public, max-age=15" });
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

async function handleTileUpload(request, env) {
  const bucket = mapBucket(env);
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const payload = await request.json();
  const tile = normalizeTilePayload(payload);
  const bytes = decodeBase64(payload.data);
  const extension = TILE_CONTENT_TYPES.get(tile.contentType);
  const key = tileKey(tile.world, tile.dimension, tile.z, tile.x, tile.y, extension);

  await bucket.put(key, bytes, {
    httpMetadata: { contentType: tile.contentType },
    customMetadata: { world: tile.world, dimension: tile.dimension },
  });

  await broadcastLive(env, JSON.stringify({ type: "tile_ready", ...tile, extension }));
  return json({ ok: true, key });
}

async function handleTileGet(url, env) {
  const bucket = mapBucket(env);
  const parsed = parseTilePath(url.pathname);
  if (!parsed) {
    return json({ error: "bad_tile_path" }, 400);
  }
  if (!bucket) {
    return json({ error: "r2_not_configured" }, 503);
  }

  const object = await bucket.get(parsed.key);
  if (!object) {
    return new Response("tile not found", { status: 404, headers: CORS_HEADERS });
  }
  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata?.(headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", contentTypeForExtension(parsed.extension));
  }
  headers.set("Cache-Control", "public, max-age=60");
  return new Response(object.body, { headers });
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
  if (palette.length < 1 || palette.length > CHUNK_BLOCK_COUNT) {
    throw new Error("palette must contain 1-256 block ids");
  }
  const blocks = normalizeFixedNumberArray(payload.blocks, "blocks", CHUNK_BLOCK_COUNT).map((value) => {
    if (value < 0 || value >= palette.length) {
      throw new Error("block palette index out of range");
    }
    return value;
  });
  const heights = normalizeFixedNumberArray(payload.heights, "heights", CHUNK_BLOCK_COUNT);

  return {
    world: cleanSegment(payload.world || "world"),
    dimension: cleanSegment(payload.dimension || "Overworld"),
    chunkX: numberOrThrow(payload.chunkX, "chunkX"),
    chunkZ: numberOrThrow(payload.chunkZ, "chunkZ"),
    palette,
    blocks,
    heights,
    updatedAt: numberOrThrow(payload.updatedAt ?? Date.now(), "updatedAt"),
  };
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

export function normalizeTilePayload(payload) {
  const contentType = String(payload.contentType || "");
  if (!TILE_CONTENT_TYPES.has(contentType)) {
    throw new Error("unsupported tile content type");
  }
  return {
    world: cleanSegment(payload.world || "world"),
    dimension: cleanSegment(payload.dimension || "Overworld"),
    z: numberOrThrow(payload.z, "z"),
    x: numberOrThrow(payload.x, "x"),
    y: numberOrThrow(payload.y, "y"),
    contentType,
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

export function chunkKey(world, dimension, chunkX, chunkZ) {
  return `chunks/v1/${cleanSegment(world)}/${cleanSegment(dimension)}/${numberOrThrow(chunkX, "chunkX")}/${numberOrThrow(chunkZ, "chunkZ")}.json`;
}

export function tileKey(world, dimension, z, x, y, extension) {
  return `${cleanSegment(world)}/${cleanSegment(dimension)}/${numberOrThrow(z, "z")}/${numberOrThrow(x, "x")}/${numberOrThrow(y, "y")}.${extension}`;
}

export function diffChunkSnapshots(previous, next) {
  if (!previous || !Array.isArray(previous.blocks) || !Array.isArray(previous.heights)) {
    return [];
  }
  const updates = [];
  for (let index = 0; index < CHUNK_BLOCK_COUNT; index += 1) {
    if (previous.blocks[index] === next.blocks[index] && previous.heights[index] === next.heights[index]) {
      continue;
    }
    updates.push({
      localX: index % 16,
      localZ: Math.floor(index / 16),
      block: next.palette[next.blocks[index]] || "minecraft:air",
      height: next.heights[index],
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

function parseTilePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 6 || parts[0] !== "tiles") {
    return null;
  }
  const [fileY, extension] = parts[5].split(".");
  if (!fileY || !extension) {
    return null;
  }
  return {
    key: tileKey(parts[1], parts[2], parts[3], parts[4], fileY, extension),
    extension,
  };
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

function numberOrThrow(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${field} must be a finite number`);
  }
  return Math.trunc(number);
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("missing base64 tile data");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function contentTypeForExtension(extension) {
  if (extension === "bmp") {
    return "image/bmp";
  }
  if (extension === "png") {
    return "image/png";
  }
  if (extension === "webp") {
    return "image/webp";
  }
  return "application/octet-stream";
}
