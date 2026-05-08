import { describe, expect, it } from "vitest";

import worker, { normalizeMarkerPayload, normalizeTilePayload, tileKey } from "../src/index.js";

class MockR2Object {
  constructor(body, contentType) {
    this.body = body;
    this.contentType = contentType;
  }

  writeHttpMetadata(headers) {
    headers.set("Content-Type", this.contentType);
  }
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, body, options) {
    this.objects.set(key, new MockR2Object(body, options.httpMetadata.contentType));
  }

  async get(key) {
    return this.objects.get(key) || null;
  }
}

class MockD1 {
  constructor() {
    this.markers = new Map();
    this.tiles = new Map();
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }
}

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  async all() {
    return { results: [...this.db.markers.values()].sort((a, b) => b.updatedAt - a.updatedAt) };
  }

  async first() {
    if (this.sql.startsWith("SELECT content_type")) {
      return this.db.tiles.get(this.values[0]) || null;
    }
    return null;
  }

  async run() {
    if (this.sql.startsWith("INSERT INTO markers")) {
      const [id, world, dimension, x, y, z, title, description, createdBy, createdAt, updatedAt] = this.values;
      this.db.markers.set(id, { id, world, dimension, x, y, z, title, description, createdBy, createdAt, updatedAt });
    } else if (this.sql.startsWith("INSERT INTO tiles")) {
      const [key, contentType, bodyBase64, world, dimension, updatedAt] = this.values;
      this.db.tiles.set(key, { contentType, bodyBase64, world, dimension, updatedAt });
    } else if (this.sql.startsWith("UPDATE")) {
      const [world, dimension, x, y, z, title, description, createdBy, updatedAt, id] = this.values;
      const existing = this.db.markers.get(id) || { id, createdAt: updatedAt };
      this.db.markers.set(id, { ...existing, world, dimension, x, y, z, title, description, createdBy, updatedAt });
    } else if (this.sql.startsWith("DELETE")) {
      this.db.markers.delete(this.values[0]);
    }
    return { success: true };
  }
}

class MockLiveRoomBinding {
  constructor() {
    this.messages = [];
  }

  idFromName(name) {
    return name;
  }

  get() {
    return {
      fetch: async (_url, init = {}) => {
        this.messages.push(init.body || "");
        return new Response(JSON.stringify({ ok: true }));
      },
    };
  }
}

function createEnv() {
  const live = new MockLiveRoomBinding();
  return {
    PLUGIN_TOKEN: "secret",
    MAP_TILES: new MockR2Bucket(),
    DB: new MockD1(),
    LIVE_ROOM: live,
    live,
  };
}

describe("worker helpers", () => {
  it("normalizes tile payloads and keys", () => {
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
  it("accepts authenticated tile uploads and serves stored tiles", async () => {
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
    expect(env.live.messages.at(-1)).toContain("tile_ready");

    const tile = await worker.fetch(new Request("https://map.buhe.li/tiles/world/Overworld/0/0/0.bmp"), env, {});
    expect(tile.status).toBe(200);
    expect(tile.headers.get("Content-Type")).toBe("image/bmp");
  });

  it("falls back to D1 tile storage when R2 is not bound", async () => {
    const env = createEnv();
    delete env.MAP_TILES;
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
    expect(env.DB.tiles.size).toBe(1);

    const tile = await worker.fetch(new Request("https://map.buhe.li/tiles/world/Overworld/0/0/0.bmp"), env, {});
    expect(tile.status).toBe(200);
    expect(tile.headers.get("Content-Type")).toBe("image/bmp");
  });

  it("rejects unauthenticated plugin writes", async () => {
    const env = createEnv();
    const response = await worker.fetch(new Request("https://map.buhe.li/api/plugin/live", { method: "POST", body: "{}" }), env, {});
    expect(response.status).toBe(401);
  });

  it("creates, lists, updates, and deletes markers", async () => {
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
    expect(env.DB.markers.size).toBe(0);
  });
});
