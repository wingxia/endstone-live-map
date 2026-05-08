import { describe, expect, it } from "vitest";

import worker, {
  chunkKey,
  diffChunkSnapshots,
  normalizeChunkSnapshot,
  normalizeMarkerPayload,
  normalizeTilePayload,
  tileKey,
} from "../src/index.js";

class MockR2Object {
  constructor(body, contentType) {
    this.body = body;
    this.contentType = contentType;
  }

  writeHttpMetadata(headers) {
    headers.set("Content-Type", this.contentType);
  }

  async text() {
    if (typeof this.body === "string") {
      return this.body;
    }
    return new TextDecoder().decode(this.body);
  }

  async json() {
    return JSON.parse(await this.text());
  }
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options = {}) {
    this.objects.set(key, new MockR2Object(body, options.httpMetadata?.contentType || "application/octet-stream"));
  }

  async get(key) {
    return this.objects.get(key) || null;
  }
}

class MockMarkerDb {
  constructor() {
    this.markers = new Map();
  }

  async execute(sql, values = []) {
    if (sql.startsWith("SELECT")) {
      return [[...this.markers.values()].sort((a, b) => b.updatedAt - a.updatedAt)];
    }
    if (sql.startsWith("INSERT INTO markers")) {
      const [id, world, dimension, x, y, z, title, description, createdBy, createdAt, updatedAt] = values;
      this.markers.set(id, { id, world, dimension, x, y, z, title, description, createdBy, createdAt, updatedAt });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("UPDATE markers")) {
      const [world, dimension, x, y, z, title, description, createdBy, updatedAt, id] = values;
      const existing = this.markers.get(id) || { id, createdAt: updatedAt };
      this.markers.set(id, { ...existing, world, dimension, x, y, z, title, description, createdBy, updatedAt });
      return [{ affectedRows: 1 }];
    }
    if (sql.startsWith("DELETE FROM markers")) {
      this.markers.delete(values[0]);
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}

class MockLiveRoomBinding {
  constructor() {
    this.messages = [];
    this.sessions = 0;
  }

  idFromName(name) {
    return name;
  }

  get() {
    return {
      fetch: async (url, init = {}) => {
        if (String(url).endsWith("/stats")) {
          return Response.json({ ok: true, sessions: this.sessions });
        }
        this.messages.push(init.body || "");
        return Response.json({ ok: true, sessions: this.sessions });
      },
    };
  }
}

function createEnv() {
  const live = new MockLiveRoomBinding();
  return {
    PLUGIN_TOKEN: "secret",
    MAP_DATA: new MockR2Bucket(),
    MARKER_DB: new MockMarkerDb(),
    LIVE_ROOM: live,
    live,
  };
}

function createChunk(overrides = {}) {
  return {
    world: "world",
    dimension: "Overworld",
    chunkX: 0,
    chunkZ: 0,
    palette: ["minecraft:grass_block", "minecraft:water"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    updatedAt: 10,
    ...overrides,
  };
}

describe("worker helpers", () => {
  it("normalizes chunk payloads and keys", () => {
    const chunk = normalizeChunkSnapshot(createChunk({ world: "my world", chunkX: -1 }));
    expect(chunk).toMatchObject({ world: "my_world", chunkX: -1, blocks: expect.any(Array) });
    expect(chunkKey("world", "Overworld", -1, 2)).toBe("chunks/v1/world/Overworld/-1/2.json");
  });

  it("detects block updates between chunk snapshots", () => {
    const previous = createChunk();
    const next = createChunk({ blocks: [...previous.blocks], heights: [...previous.heights] });
    next.blocks[17] = 1;
    next.heights[17] = 63;
    expect(diffChunkSnapshots(previous, next)).toEqual([{ localX: 1, localZ: 1, block: "minecraft:water", height: 63 }]);
  });

  it("normalizes legacy tile payloads and keys", () => {
    expect(normalizeTilePayload({ world: "my world", dimension: "Overworld", z: 0, x: -1, y: 2, contentType: "image/bmp" })).toMatchObject({
      world: "my_world",
      x: -1,
    });
    expect(tileKey("world", "Overworld", 0, -1, 2, "bmp")).toBe("world/Overworld/0/-1/2.bmp");
  });

  it("validates marker payloads", () => {
    expect(normalizeMarkerPayload({ title: "Home", x: 1, z: 2 })).toMatchObject({
      title: "Home",
      dimension: "Overworld",
      y: 64,
    });
    expect(() => normalizeMarkerPayload({ title: "", x: 1, z: 2 })).toThrow(/title/);
  });
});

describe("worker routes", () => {
  it("accepts authenticated chunk uploads, stores R2 snapshots, and serves chunk ranges", async () => {
    const env = createEnv();
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(createChunk()),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(true);
    expect(env.live.messages.at(-1)).toContain("chunk_ready");

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=0&maxChunkX=0&minChunkZ=0&maxChunkZ=0"),
      env,
      {},
    );
    const body = await chunks.json();
    expect(body.chunks).toHaveLength(1);
    expect(body.missing).toHaveLength(0);
  });

  it("broadcasts block updates when viewers are connected", async () => {
    const env = createEnv();
    env.live.sessions = 1;
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });
    const next = createChunk({ blocks: Array.from({ length: 256 }, () => 0), heights: Array.from({ length: 256 }, () => 64), updatedAt: 11 });
    next.blocks[0] = 1;

    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(next),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);
    expect(env.live.messages.some((message) => String(message).includes("block_updates"))).toBe(true);
  });

  it("serves texture manifest and atlas from R2", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("textures/v1/manifest.json", JSON.stringify({ version: 1, tileSize: 16, blocks: {} }), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("textures/v1/atlas.png", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    const manifest = await worker.fetch(new Request("https://map.buhe.li/api/textures/manifest"), env, {});
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ version: 1 });

    const atlas = await worker.fetch(new Request("https://map.buhe.li/textures/atlas.png"), env, {});
    expect(atlas.status).toBe(200);
    expect(atlas.headers.get("Content-Type")).toBe("image/png");
  });

  it("keeps legacy tile reads R2-only without D1", async () => {
    const env = createEnv();
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/tiles", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          world: "world",
          dimension: "Overworld",
          z: 0,
          x: 0,
          y: 0,
          contentType: "image/bmp",
          data: "Qk0=",
        }),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);
    expect(env.DB).toBeUndefined();

    const tile = await worker.fetch(new Request("https://map.buhe.li/tiles/world/Overworld/0/0/0.bmp"), env, {});
    expect(tile.status).toBe(200);
    expect(tile.headers.get("Content-Type")).toBe("image/bmp");
  });

  it("rejects unauthenticated plugin writes", async () => {
    const env = createEnv();
    const response = await worker.fetch(new Request("https://map.buhe.li/api/plugin/live", { method: "POST", body: "{}" }), env, {});
    expect(response.status).toBe(401);
  });

  it("creates, lists, updates, and deletes markers through the MySQL adapter", async () => {
    const env = createEnv();
    const create = await worker.fetch(
      new Request("https://map.buhe.li/api/markers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Spawn", description: "Main base", x: 0, y: 64, z: 0, createdBy: "Wing" }),
      }),
      env,
      {},
    );
    expect(create.status).toBe(201);
    const created = await create.json();
    expect(created.marker.id).toBeTruthy();

    const list = await worker.fetch(new Request("https://map.buhe.li/api/markers"), env, {});
    expect((await list.json()).markers).toHaveLength(1);

    const update = await worker.fetch(
      new Request(`https://map.buhe.li/api/markers/${created.marker.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Spawn Hub", x: 1, y: 64, z: 2 }),
      }),
      env,
      {},
    );
    expect(update.status).toBe(200);

    const remove = await worker.fetch(new Request(`https://map.buhe.li/api/markers/${created.marker.id}`, { method: "DELETE" }), env, {});
    expect(remove.status).toBe(200);
    expect(env.MARKER_DB.markers.size).toBe(0);
  });
});
