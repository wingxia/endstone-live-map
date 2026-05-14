import { describe, expect, it } from "vitest";

import worker, {
  chunkRegionKey,
  chunkKey,
  diffChunkSnapshots,
  normalizeBlockUpdateBatch,
  normalizeCleanupPayload,
  normalizeChunkBatchPayload,
  normalizeChunkSnapshot,
  normalizeLandPayload,
  normalizeMarkerPayload,
  normalizeWorldMeta,
  landKey,
  worldMetaKey,
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

  async delete(key) {
    this.objects.delete(key);
  }

  async get(key) {
    return this.objects.get(key) || null;
  }

  async list(options = {}) {
    const prefix = options.prefix || "";
    return {
      objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      truncated: false,
    };
  }
}

class MockMarkerDb {
  constructor() {
    this.markers = new Map();
  }

  async execute() {
    throw new Error("MockMarkerDb.execute should not be used; Hyperdrive MySQL requires query()");
  }

  async query(sql, values = []) {
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
    palette: ["minecraft:grass_block", "minecraft:water", "minecraft:air"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => 64),
    overlayBlocks: Array.from({ length: 256 }, () => 2),
    overlayHeights: Array.from({ length: 256 }, () => -64),
    blockStates: Array.from({ length: 256 }, () => ({})),
    overlayStates: Array.from({ length: 256 }, () => ({})),
    updatedAt: 10,
    ...overrides,
  };
}

describe("worker helpers", () => {
  it("normalizes chunk payloads and keys", () => {
    const chunk = normalizeChunkSnapshot(createChunk({ world: "my world", chunkX: -1 }));
    expect(chunk).toMatchObject({ world: "my_world", chunkX: -1, blocks: expect.any(Array), blockStates: expect.any(Array), overlayBlocks: expect.any(Array) });
    expect(normalizeChunkSnapshot(createChunk({ overlayBlocks: undefined, overlayHeights: undefined })).overlayHeights[0]).toBe(-64);
    expect(normalizeChunkSnapshot(createChunk({ blockStates: undefined, overlayStates: undefined })).blockStates[0]).toEqual({});
    expect(chunkKey("world", "Overworld", -1, 2)).toBe("chunks/v1/world/Overworld/-1/2.json");
    expect(normalizeChunkBatchPayload({ chunks: [createChunk()], broadcast: true })).toMatchObject({ broadcast: true, chunks: [expect.any(Object)] });
    expect(normalizeChunkBatchPayload({ chunks: [createChunk()], storage: "region" })).toMatchObject({ storage: "region" });
    expect(chunkRegionKey("world", "Overworld", -1, 2)).toBe("chunk-regions/v1/world/Overworld/-1/2.json");
    expect(() => normalizeChunkBatchPayload({ chunks: [] })).toThrow(/chunks/);
    expect(
      normalizeBlockUpdateBatch({
        world: "world",
        dimension: "Overworld",
        chunkX: 0,
        chunkZ: 0,
        updates: [
          {
            localX: 1,
            localZ: 2,
            block: "minecraft:stone",
            height: 70,
            state: { bite_counter: 2 },
            overlayBlock: "minecraft:poppy",
            overlayHeight: 71,
            overlayState: { facing_direction: 1 },
          },
        ],
      }),
    ).toMatchObject({
      updates: [
        {
          localX: 1,
          localZ: 2,
          block: "minecraft:stone",
          height: 70,
          state: { bite_counter: 2 },
          overlayBlock: "minecraft:poppy",
          overlayHeight: 71,
          overlayState: { facing_direction: 1 },
        },
      ],
    });
  });

  it("detects block updates between chunk snapshots", () => {
    const previous = createChunk();
    const next = createChunk({ blocks: [...previous.blocks], heights: [...previous.heights] });
    next.blocks[17] = 1;
    next.heights[17] = 63;
    expect(diffChunkSnapshots(previous, next)).toEqual([
      { localX: 1, localZ: 1, block: "minecraft:water", height: 63, state: {}, overlayBlock: "minecraft:air", overlayHeight: -64, overlayState: {} },
    ]);
  });

  it("detects state-only updates between chunk snapshots", () => {
    const previous = createChunk({ palette: ["minecraft:cake", "minecraft:air"], blocks: Array.from({ length: 256 }, () => 0) });
    const next = createChunk({
      ...previous,
      blocks: [...previous.blocks],
      heights: [...previous.heights],
      blockStates: previous.blockStates.map((state) => ({ ...state })),
      overlayBlocks: [...previous.overlayBlocks],
      overlayHeights: [...previous.overlayHeights],
      overlayStates: previous.overlayStates.map((state) => ({ ...state })),
    });
    next.blockStates[17] = { bite_counter: 3 };
    expect(diffChunkSnapshots(previous, next)).toEqual([
      {
        localX: 1,
        localZ: 1,
        block: "minecraft:cake",
        height: 64,
        state: { bite_counter: 3 },
        overlayBlock: "minecraft:air",
        overlayHeight: -64,
        overlayState: {},
      },
    ]);
  });

  it("detects overlay-only updates between chunk snapshots", () => {
    const previous = createChunk();
    const next = createChunk({
      blocks: [...previous.blocks],
      heights: [...previous.heights],
      overlayBlocks: [...previous.overlayBlocks],
      overlayHeights: [...previous.overlayHeights],
      palette: [...previous.palette, "minecraft:poppy"],
    });
    next.overlayBlocks[17] = 3;
    next.overlayHeights[17] = 65;
    next.overlayStates[17] = { facing_direction: 1 };
    expect(diffChunkSnapshots(previous, next)).toEqual([
      {
        localX: 1,
        localZ: 1,
        block: "minecraft:grass_block",
        height: 64,
        state: {},
        overlayBlock: "minecraft:poppy",
        overlayHeight: 65,
        overlayState: { facing_direction: 1 },
      },
    ]);
  });

  it("normalizes map data cleanup payloads", () => {
    expect(normalizeCleanupPayload({ prefix: "chunks/v1/", limit: 999, dryRun: false, confirm: "delete-map-data-v1" })).toMatchObject({
      prefix: "chunks/v1/",
      limit: 500,
      dryRun: false,
    });
    expect(() => normalizeCleanupPayload({ prefix: "textures/v1/" })).toThrow(/cleanup prefix/);
  });

  it("validates marker payloads", () => {
    expect(normalizeMarkerPayload({ title: "Home", x: 1, z: 2 })).toMatchObject({
      title: "Home",
      dimension: "Overworld",
      y: 64,
    });
    expect(() => normalizeMarkerPayload({ title: "", x: 1, z: 2 })).toThrow(/title/);
  });

  it("normalizes world meta payloads and keys", () => {
    const meta = normalizeWorldMeta({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkCount: 2,
      bounds: { minChunkX: -1, maxChunkX: 1, minChunkZ: -2, maxChunkZ: 2 },
      topBlocks: { "minecraft:grass block": 5 },
    });
    expect(meta).toMatchObject({
      world: "Bedrock_level",
      bounds: { minBlockX: -16, maxBlockX: 31, minBlockZ: -32, maxBlockZ: 47 },
      topBlocks: { "minecraft:grass_block": 5 },
    });
    expect(worldMetaKey("Bedrock level", "Overworld")).toBe("meta/v1/Bedrock_level/Overworld.json");
  });

  it("normalizes land payloads and keys", () => {
    const payload = normalizeLandPayload({
      claims: [
        {
          owner: "GieZi8670",
          name: "主城区",
          world: "Bedrock level",
          dimension: "Overworld",
          minX: -375,
          maxX: -227,
          minY: 70,
          maxY: 300,
          minZ: -580,
          maxZ: -473,
          teleport: { x: -352, y: 70, z: -479 },
          publicTeleport: true,
          members: ["wingxia"],
          children: ["猪人塔"],
          updatedAt: 123,
        },
      ],
    });
    expect(payload.claims[0]).toMatchObject({
      owner: "GieZi8670",
      name: "主城区",
      world: "Bedrock_level",
      dimension: "Overworld",
      minZ: -580,
      maxZ: -473,
      teleport: { x: -352, y: 70, z: -479 },
      nested: false,
      publicTeleport: true,
    });
    const privatePayload = normalizeLandPayload({
      claims: [
        {
          owner: "GieZi8670",
          name: "未公开",
          world: "Bedrock level",
          dimension: "Overworld",
          minX: 0,
          maxX: 1,
          minY: 60,
          maxY: 70,
          minZ: 0,
          maxZ: 1,
          teleport: { x: 0, y: 64, z: 0 },
          updatedAt: 124,
        },
      ],
    });
    expect(privatePayload.claims[0]).toMatchObject({ publicTeleport: false });
    expect(landKey("Bedrock level", "Overworld")).toBe("lands/v1/Bedrock_level/Overworld.json");
    expect(() => normalizeLandPayload({ claims: [{ owner: "x", name: "bad", minX: 1, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0, teleport: { x: 0, y: 0, z: 0 } }] })).toThrow(/bounds/);
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

  it("serves sparse chunk ranges without reading every missing chunk", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunks/v1/world/Overworld/1/0.json", JSON.stringify(createChunk({ chunkX: 1 })), {
      httpMetadata: { contentType: "application/json" },
    });

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=0&maxChunkX=15&minChunkZ=0&maxChunkZ=15"),
      env,
      {},
    );
    const body = await chunks.json();
    expect(body.chunks).toHaveLength(2);
    expect(body.missing).toHaveLength(254);
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

  it("applies authenticated dirty block updates to existing chunk snapshots", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });

    const update = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/block-updates", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          world: "world",
          dimension: "Overworld",
          chunkX: 0,
          chunkZ: 0,
          updates: [
            {
              localX: 2,
              localZ: 3,
              block: "minecraft:oak_trapdoor",
              height: 71,
              state: { direction: 1, open_bit: true },
              overlayBlock: "minecraft:poppy",
              overlayHeight: 72,
              overlayState: { facing_direction: 1 },
            },
          ],
          updatedAt: 20,
        }),
      }),
      env,
      {},
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ ok: true, missingBase: false, updates: 1 });
    expect(env.live.messages.at(-1)).toContain("block_updates");
    const stored = await env.MAP_DATA.objects.get("chunks/v1/world/Overworld/0/0.json").json();
    const index = 3 * 16 + 2;
    expect(stored.palette[stored.blocks[index]]).toBe("minecraft:oak_trapdoor");
    expect(stored.heights[index]).toBe(71);
    expect(stored.blockStates[index]).toEqual({ direction: 1, open_bit: true });
    expect(stored.palette[stored.overlayBlocks[index]]).toBe("minecraft:poppy");
    expect(stored.overlayHeights[index]).toBe(72);
    expect(stored.overlayStates[index]).toEqual({ facing_direction: 1 });
  });

  it("reports missing base chunks for dirty block updates", async () => {
    const env = createEnv();
    const update = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/block-updates", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          world: "world",
          dimension: "Overworld",
          chunkX: 0,
          chunkZ: 0,
          updates: [{ localX: 2, localZ: 3, block: "minecraft:stone", height: 71 }],
          updatedAt: 20,
        }),
      }),
      env,
      {},
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ ok: true, missingBase: true, updates: 0 });
    expect(env.live.messages).toHaveLength(0);
  });

  it("accepts authenticated chunk batch uploads without broadcasting by default", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ chunks: [createChunk(), createChunk({ chunkX: 1 })] }),
      }),
      env,
      {},
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, chunks: 2 });
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(true);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/1/0.json")).toBe(true);
    const meta = await env.MAP_DATA.objects.get("meta/v1/world/Overworld.json").json();
    expect(meta).toMatchObject({
      world: "world",
      dimension: "Overworld",
      status: "live",
      chunkCount: 2,
      bounds: { minChunkX: 0, maxChunkX: 1, minChunkZ: 0, maxChunkZ: 0, minBlockX: 0, maxBlockX: 31 },
      topBlocks: { "minecraft:grass_block": 512 },
    });
    expect(env.live.messages).toHaveLength(0);
  });

  it("rejects oversized chunk batch uploads", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ chunks: Array.from({ length: 385 }, () => createChunk()) }),
      }),
      env,
      {},
    );
    expect(response.status).toBe(400);
  });

  it("accepts region chunk batch uploads and serves them through chunk ranges", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: "region",
          chunks: [createChunk({ chunkX: -1, chunkZ: -1 }), createChunk({ chunkX: 0, chunkZ: 0 }), createChunk({ chunkX: 15, chunkZ: 15 })],
        }),
      }),
      env,
      {},
    );
    const uploadBody = await response.json();
    expect(response.status).toBe(200);
    expect(uploadBody).toMatchObject({ storage: "region", chunks: 3 });
    expect(env.MAP_DATA.objects.has("chunk-regions/v1/world/Overworld/-1/-1.json")).toBe(true);
    expect(env.MAP_DATA.objects.has("chunk-regions/v1/world/Overworld/0/0.json")).toBe(true);
    const meta = await env.MAP_DATA.objects.get("meta/v1/world/Overworld.json").json();
    expect(meta).toMatchObject({
      chunkCount: 3,
      bounds: { minChunkX: -1, maxChunkX: 15, minChunkZ: -1, maxChunkZ: 15 },
    });

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=-1&maxChunkX=0&minChunkZ=-1&maxChunkZ=0"),
      env,
      {},
    );
    const body = await chunks.json();
    expect(body.chunks).toHaveLength(2);
    expect(body.missing).toHaveLength(2);
  });

  it("extends existing world metadata when live chunk uploads expand bounds", async () => {
    const env = createEnv();
    await env.MAP_DATA.put(
      "meta/v1/world/Overworld.json",
      JSON.stringify(
        normalizeWorldMeta({
          world: "world",
          dimension: "Overworld",
          status: "live",
          chunkCount: 1,
          bounds: { minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0 },
          topBlocks: { "minecraft:grass_block": 256 },
          importedAt: 10,
          updatedAt: 10,
        }),
      ),
      { httpMetadata: { contentType: "application/json" } },
    );

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(createChunk({ chunkX: -1, chunkZ: 2, updatedAt: 20 })),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    const meta = await env.MAP_DATA.objects.get("meta/v1/world/Overworld.json").json();
    expect(meta).toMatchObject({
      chunkCount: 2,
      importedAt: 10,
      bounds: { minChunkX: -1, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 2, minBlockX: -16, maxBlockX: 15, minBlockZ: 0, maxBlockZ: 47 },
      topBlocks: { "minecraft:grass_block": 512 },
    });
    expect(meta.updatedAt).toBeGreaterThanOrEqual(20);
  });

  it("does not double count world metadata when a live chunk is reuploaded inside existing bounds", async () => {
    const env = createEnv();
    await env.MAP_DATA.put(
      "meta/v1/world/Overworld.json",
      JSON.stringify(
        normalizeWorldMeta({
          world: "world",
          dimension: "Overworld",
          status: "live",
          chunkCount: 1,
          bounds: { minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0 },
          topBlocks: { "minecraft:grass_block": 256 },
          importedAt: 10,
          updatedAt: 10,
        }),
      ),
      { httpMetadata: { contentType: "application/json" } },
    );

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(createChunk({ chunkX: 0, chunkZ: 0, updatedAt: 20 })),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    const meta = await env.MAP_DATA.objects.get("meta/v1/world/Overworld.json").json();
    expect(meta).toMatchObject({
      chunkCount: 1,
      topBlocks: { "minecraft:grass_block": 256 },
    });
  });

  it("stores and serves imported world metadata", async () => {
    const env = createEnv();
    const metaPayload = {
      version: 1,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "complete",
      chunkCount: 2,
      bounds: { minChunkX: -1, maxChunkX: 1, minChunkZ: -2, maxChunkZ: 2 },
      topBlocks: { "minecraft:grass_block": 10 },
      importedAt: 123,
      updatedAt: 123,
    };
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/world-meta", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(metaPayload),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);
    expect(env.MAP_DATA.objects.has("meta/v1/Bedrock_level/Overworld.json")).toBe(true);

    const meta = await worker.fetch(new Request("https://map.buhe.li/api/world-meta?world=Bedrock%20level&dimension=Overworld"), env, {});
    expect(await meta.json()).toMatchObject({ world: "Bedrock_level", chunkCount: 2 });

    const worlds = await worker.fetch(new Request("https://map.buhe.li/api/worlds"), env, {});
    expect((await worlds.json()).worlds).toHaveLength(1);
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

  it("serves texture generation reports from R2", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("textures/v1/report.json", JSON.stringify({ entries: 100, missing: [] }), {
      httpMetadata: { contentType: "application/json" },
    });

    const response = await worker.fetch(new Request("https://map.buhe.li/api/textures/report"), env, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entries: 100 });
  });

  it("lets authenticated import jobs upload texture atlas artifacts through the Worker", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/textures", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          atlas: btoa("png"),
          manifest: { version: 1, blocks: { "minecraft:stone": { x: 0, y: 0, w: 16, h: 16 } } },
          report: { entries: 1 },
        }),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    expect(env.MAP_DATA.objects.has("textures/v1/atlas.png")).toBe(true);
    expect(await env.MAP_DATA.objects.get("textures/v1/manifest.json").json()).toMatchObject({ version: 1 });
    expect(await env.MAP_DATA.objects.get("textures/v1/report.json").json()).toMatchObject({ entries: 1 });
  });

  it("cleans bad imported map data without touching texture artifacts", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", "{}");
    await env.MAP_DATA.put("chunk-regions/v1/world/Overworld/0/0.json", "{}");
    await env.MAP_DATA.put("textures/v1/manifest.json", "{}");

    const dryRun = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/map-data/cleanup", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "chunks/v1/", dryRun: true }),
      }),
      env,
      {},
    );
    expect(await dryRun.json()).toMatchObject({ dryRun: true, matched: 1, deleted: 0 });
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(true);

    const remove = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/map-data/cleanup", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "chunks/v1/", dryRun: false, confirm: "delete-map-data-v1" }),
      }),
      env,
      {},
    );
    expect(await remove.json()).toMatchObject({ dryRun: false, matched: 1, deleted: 1 });
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(false);
    expect(env.MAP_DATA.objects.has("chunk-regions/v1/world/Overworld/0/0.json")).toBe(true);
    expect(env.MAP_DATA.objects.has("textures/v1/manifest.json")).toBe(true);
  });

  it("rejects cleanup attempts for texture artifacts with a clear error", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("textures/v1/manifest.json", "{}");

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/map-data/cleanup", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "textures/v1/", dryRun: true }),
      }),
      env,
      {},
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "cleanup_prefix_not_allowed" });
    expect(env.MAP_DATA.objects.has("textures/v1/manifest.json")).toBe(true);
  });

  it("stores authenticated land uploads by dimension and broadcasts updates", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/lands", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          claims: [
            {
              id: "GieZi8670:主城区:Overworld",
              owner: "GieZi8670",
              name: "主城区",
              world: "Bedrock level",
              dimension: "Overworld",
              minX: -375,
              maxX: -227,
              minY: 70,
              maxY: 300,
              minZ: -580,
              maxZ: -473,
              teleport: { x: -352, y: 70, z: -479 },
              publicTeleport: true,
              members: ["wingxia"],
              parent: "",
              children: ["猪人塔"],
              nested: false,
              updatedAt: 123,
            },
            {
              id: "GieZi8670:末地:TheEnd",
              owner: "GieZi8670",
              name: "末地",
              world: "Bedrock level",
              dimension: "TheEnd",
              minX: 100,
              maxX: 100,
              minY: 50,
              maxY: 50,
              minZ: 0,
              maxZ: 0,
              teleport: { x: 100, y: 50, z: 0 },
              members: [],
              parent: "",
              children: [],
              nested: false,
              updatedAt: 123,
            },
          ],
        }),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    const uploadBody = await response.json();
    expect(uploadBody).toMatchObject({ ok: true, claims: 2 });
    expect(uploadBody.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ world: "Bedrock_level", dimension: "Overworld", claims: 1 }),
        expect.objectContaining({ world: "Bedrock_level", dimension: "TheEnd", claims: 1 }),
      ]),
    );
    expect(env.MAP_DATA.objects.has("lands/v1/Bedrock_level/Overworld.json")).toBe(true);
    expect(env.MAP_DATA.objects.has("lands/v1/Bedrock_level/TheEnd.json")).toBe(true);
    expect(env.live.messages.filter((message) => String(message).includes("lands_updated"))).toHaveLength(2);

    const lands = await worker.fetch(new Request("https://map.buhe.li/api/lands?world=Bedrock%20level&dimension=Overworld"), env, {});
    expect(lands.status).toBe(200);
    expect(await lands.json()).toMatchObject({ world: "Bedrock_level", dimension: "Overworld", claims: [{ name: "主城区", publicTeleport: true }] });

    const empty = await worker.fetch(new Request("https://map.buhe.li/api/lands?world=Bedrock%20level&dimension=Nether"), env, {});
    expect(await empty.json()).toMatchObject({ world: "Bedrock_level", dimension: "Nether", claims: [] });
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
