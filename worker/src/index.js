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

      if (url.pathname === "/api/plugin/tiles") {
        const auth = requirePluginAuth(request, env);
        if (auth) {
          return auth;
        }
        return handleTileUpload(request, env);
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

async function broadcastLive(env, message) {
  const id = env.LIVE_ROOM.idFromName("global");
  const stub = env.LIVE_ROOM.get(id);
  await stub.fetch("https://live-room/broadcast", { method: "POST", body: message });
}

async function handleTileUpload(request, env) {
  const payload = await request.json();
  const tile = normalizeTilePayload(payload);
  const bytes = decodeBase64(payload.data);
  const extension = TILE_CONTENT_TYPES.get(tile.contentType);
  const key = tileKey(tile.world, tile.dimension, tile.z, tile.x, tile.y, extension);

  await env.MAP_TILES.put(key, bytes, {
    httpMetadata: { contentType: tile.contentType },
    customMetadata: { world: tile.world, dimension: tile.dimension },
  });

  await broadcastLive(env, JSON.stringify({ type: "tile_ready", ...tile, extension }));
  return json({ ok: true, key });
}

async function handleTileGet(url, env) {
  const parsed = parseTilePath(url.pathname);
  if (!parsed) {
    return json({ error: "bad_tile_path" }, 400);
  }
  const object = await env.MAP_TILES.get(parsed.key);
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
    const rows = await env.DB.prepare(
      "SELECT id, world, dimension, x, y, z, title, description, created_by AS createdBy, created_at AS createdAt, updated_at AS updatedAt FROM markers ORDER BY updated_at DESC LIMIT 500",
    ).all();
    return json({ markers: rows.results || [] });
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
    await env.DB.prepare(
      "UPDATE markers SET world = ?, dimension = ?, x = ?, y = ?, z = ?, title = ?, description = ?, created_by = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        marker.world,
        marker.dimension,
        marker.x,
        marker.y,
        marker.z,
        marker.title,
        marker.description,
        marker.createdBy,
        marker.updatedAt,
        marker.id,
      )
      .run();
    await broadcastLive(env, JSON.stringify({ type: "marker_updated", marker }));
    return json({ marker });
  }

  if (request.method === "DELETE" && id) {
    const auth = requireMarkerWriteAuth(request, env);
    if (auth) {
      return auth;
    }
    await env.DB.prepare("DELETE FROM markers WHERE id = ?").bind(id).run();
    await broadcastLive(env, JSON.stringify({ type: "marker_deleted", id }));
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

async function insertMarker(env, marker) {
  await env.DB.prepare(
    "INSERT INTO markers (id, world, dimension, x, y, z, title, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
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
    )
    .run();
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

export function tileKey(world, dimension, z, x, y, extension) {
  return `${cleanSegment(world)}/${cleanSegment(dimension)}/${numberOrThrow(z, "z")}/${numberOrThrow(x, "x")}/${numberOrThrow(y, "y")}.${extension}`;
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
