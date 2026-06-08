import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import worker, {
  chunkRangeForMapTile,
  chunkRegionKey,
  chunkKey,
  diffChunkSnapshots,
  mapTileKey,
  mapTilesForChunk,
  normalizeBlockUpdateBatch,
  normalizeBlockUpdateBatches,
  normalizeCleanupPayload,
  normalizeChunkRegionMigrationPayload,
  normalizeEmptyChunkPrunePayload,
  normalizeChunkBatchPayload,
  normalizeChunkSnapshot,
  fallbackTextureColor,
  usesMapTint,
  normalizeLandPayload,
  normalizeMapTileBackfillPayload,
  normalizeMarkerPayload,
  normalizeWorldMeta,
  landKey,
  worldMetaKey,
} from "../src/index.js";

class MockR2Object {
  constructor(body, contentType, customMetadata = {}) {
    this.body = body;
    this.contentType = contentType;
    this.customMetadata = customMetadata;
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

  async arrayBuffer() {
    if (typeof this.body === "string") {
      return new TextEncoder().encode(this.body).buffer;
    }
    const buffer = Buffer.from(this.body);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
    this.getCalls = [];
    this.listCalls = [];
    this.putCalls = [];
  }

  async put(key, body, options = {}) {
    this.putCalls.push(key);
    this.objects.set(key, new MockR2Object(body, options.httpMetadata?.contentType || "application/octet-stream", options.customMetadata || {}));
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async get(key) {
    this.getCalls.push(key);
    return this.objects.get(key) || null;
  }

  async list(options = {}) {
    const prefix = options.prefix || "";
    this.listCalls.push(prefix);
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : keys.length;
    const selected = keys.slice(0, limit);
    return {
      objects: selected.map((key) => ({ key })),
      truncated: keys.length > selected.length,
      cursor: keys.length > selected.length ? String(selected.length) : undefined,
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

const DEFAULT_TEXTURE_COLORS = {
  "minecraft:grass_block": [95, 159, 63],
  "minecraft:water": [37, 99, 184],
  "minecraft:stone": [133, 139, 140],
  "minecraft:spruce_stairs": [111, 76, 45],
  "minecraft:oak_leaves": [63, 127, 56],
  "minecraft:oak_trapdoor": [159, 116, 66],
  "minecraft:poppy": [184, 58, 48],
  "minecraft:obsidian": [18, 15, 31],
  "minecraft:oak_planks": [159, 116, 66],
  "minecraft:diamond_block": [111, 200, 198],
};

function createEnv(options = {}) {
  const live = new MockLiveRoomBinding();
  const env = {
    PLUGIN_TOKEN: "secret",
    MAP_DATA: new MockR2Bucket(),
    MARKER_DB: new MockMarkerDb(),
    LIVE_ROOM: live,
    live,
  };
  if (options.textures !== false) {
    seedTextureAtlas(env, options.textureColors || DEFAULT_TEXTURE_COLORS, { manifestColors: options.manifestColors });
  }
  return env;
}

function createExecutionContext() {
  const waits = [];
  return {
    waitUntil(promise) {
      waits.push(Promise.resolve(promise));
    },
    async flush() {
      while (waits.length > 0) {
        await waits.shift();
      }
    },
    get pending() {
      return waits.length;
    },
  };
}

async function drainMapTiles(env, payload = {}) {
  const response = await worker.fetch(
    new Request("https://map.buhe.li/api/plugin/map-tiles/drain", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 100, ...payload }),
    }),
    env,
    {},
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function backfillMapTiles(env, payload) {
  const response = await worker.fetch(
    new Request("https://map.buhe.li/api/plugin/map-tiles/backfill", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: false, force: true, ...payload }),
    }),
    env,
    {},
  );
  expect(response.status).toBe(200);
  return response.json();
}

function seedTextureAtlas(env, colorsByBlock, options = {}) {
  const entries = Object.entries(colorsByBlock);
  const tileSize = 4;
  const columns = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  const rows = Math.max(1, Math.ceil(entries.length / columns));
  const atlas = new PNG({ width: columns * tileSize, height: rows * tileSize, colorType: 6 });
  atlas.data.fill(0);
  const manifest = { version: 1, tileSize, atlas: "/textures/atlas.png", blocks: {} };

  entries.forEach(([blockId, color], index) => {
    const x = (index % columns) * tileSize;
    const y = Math.floor(index / columns) * tileSize;
    manifest.blocks[blockId] = options.manifestColors === false ? { x, y, w: tileSize, h: tileSize } : { x, y, w: tileSize, h: tileSize, color };
    for (let pixelY = y; pixelY < y + tileSize; pixelY += 1) {
      for (let pixelX = x; pixelX < x + tileSize; pixelX += 1) {
        const offset = (pixelY * atlas.width + pixelX) * 4;
        atlas.data[offset] = color[0];
        atlas.data[offset + 1] = color[1];
        atlas.data[offset + 2] = color[2];
        atlas.data[offset + 3] = color[3] ?? 255;
      }
    }
  });

  env.MAP_DATA.objects.set("textures/v1/manifest.json", new MockR2Object(JSON.stringify(manifest), "application/json; charset=utf-8"));
  env.MAP_DATA.objects.set("textures/v1/atlas.png", new MockR2Object(PNG.sync.write(atlas, { colorType: 6, inputColorType: 6 }), "image/png"));
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

function createEmptyChunk(overrides = {}) {
  return createChunk({
    palette: ["minecraft:air"],
    blocks: Array.from({ length: 256 }, () => 0),
    heights: Array.from({ length: 256 }, () => -64),
    overlayBlocks: Array.from({ length: 256 }, () => 0),
    overlayHeights: Array.from({ length: 256 }, () => -64),
    ...overrides,
  });
}

function readPng(bytes) {
  return PNG.sync.read(Buffer.from(bytes));
}

function pngPixel(png, x, y) {
  const offset = (y * png.width + x) * 4;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2], png.data[offset + 3]];
}

async function backfillMapTile(env, payload) {
  return worker.fetch(
    new Request("https://map.buhe.li/api/plugin/map-tiles/backfill", {
      method: "POST",
      headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    env,
    {},
  );
}

async function backfillAllMapTiles(env, payload) {
  let cursor = "";
  let response;
  do {
    response = await backfillMapTile(env, { ...payload, cursor });
    const body = await response.clone().json();
    cursor = body.cursor || "";
  } while (cursor);
  return response;
}

async function backfillMapTileSourceChain(env, payload) {
  for (let zoom = 4; zoom > payload.zoom; zoom -= 1) {
    await backfillAllMapTiles(env, { ...payload, zoom, dryRun: false, force: true, limit: 100 });
  }
  return backfillMapTile(env, payload);
}

function brightness(pixel) {
  return pixel[0] + pixel[1] + pixel[2];
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
    expect(mapTileKey("Bedrock level", "Overworld", -1, 0, -1)).toBe("map-tiles/v1/Bedrock_level/Overworld/z-1/0/-1.png");
    expect(mapTileKey("Bedrock level", "Overworld", 3, -1, 2)).toBe("map-tiles/v1/Bedrock_level/Overworld/z3/-1/2.png");
    expect(mapTilesForChunk("world", "Overworld", -1, -17)).toEqual([
      { world: "world", dimension: "Overworld", zoom: -1, tileX: -1, tileZ: -1 },
      { world: "world", dimension: "Overworld", zoom: 0, tileX: -1, tileZ: -2 },
      { world: "world", dimension: "Overworld", zoom: 1, tileX: -1, tileZ: -3 },
      { world: "world", dimension: "Overworld", zoom: 2, tileX: -1, tileZ: -5 },
      { world: "world", dimension: "Overworld", zoom: 3, tileX: -1, tileZ: -9 },
      { world: "world", dimension: "Overworld", zoom: 4, tileX: -1, tileZ: -17 },
    ]);
    expect(chunkRangeForMapTile({ zoom: 0, tileX: -1, tileZ: 0 })).toMatchObject({
      minChunkX: -16,
      maxChunkX: -1,
      minChunkZ: 0,
      maxChunkZ: 15,
      minBlockX: -256,
      maxBlockX: -1,
    });
    expect(chunkRangeForMapTile({ zoom: -1, tileX: 0, tileZ: -1 })).toMatchObject({
      minChunkX: 0,
      maxChunkX: 31,
      minChunkZ: -32,
      maxChunkZ: -1,
      minBlockX: 0,
      maxBlockX: 511,
    });
    expect(normalizeMapTileBackfillPayload({ minChunkX: -1, maxChunkX: 16, minChunkZ: 0, maxChunkZ: 0, limit: 999 })).toMatchObject({
      zooms: [-1, 0, 1, 2, 3, 4],
      limit: 100,
      dryRun: true,
    });
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
    const normalized = normalizeBlockUpdateBatch({
      world: "world",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      updates: [{ localX: 0, localZ: 0, block: "minecraft:stone", height: 64 }],
    });
    expect(normalizeBlockUpdateBatches({ batches: [normalized, { ...normalized, chunkX: 1 }] }).totalUpdates).toBe(2);
    expect(() => normalizeBlockUpdateBatches({ batches: [normalized, normalized] })).toThrow(/duplicate/);
    expect(() =>
      normalizeBlockUpdateBatches({
        batches: [
          {
            ...normalized,
            updates: Array.from({ length: 257 }, (_, index) => ({
              localX: index % 16,
              localZ: Math.floor(index / 16) % 16,
              block: "minecraft:stone",
              height: 64,
            })),
          },
        ],
      }),
    ).toThrow(/1-256/);
    expect(() =>
      normalizeBlockUpdateBatches({
        batches: Array.from({ length: 17 }, (_, chunkX) => ({
          ...normalized,
          chunkX,
          updates: Array.from({ length: 256 }, (_, index) => ({
            localX: index % 16,
            localZ: Math.floor(index / 16),
            block: "minecraft:stone",
            height: 64,
          })),
        })),
      }),
    ).toThrow(/1-4096/);
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

  it("normalizes chunk region migration payloads", () => {
    expect(normalizeChunkRegionMigrationPayload({ world: "Bedrock level", dimension: "Overworld", limit: 99, dryRun: false, deleteRegions: true })).toMatchObject({
      prefix: "chunk-regions/v1/Bedrock_level/Overworld/",
      limit: 10,
      dryRun: false,
      deleteRegions: true,
    });
  });

  it("normalizes empty chunk prune payloads", () => {
    expect(normalizeEmptyChunkPrunePayload({ world: "Bedrock level", minChunkX: -45, maxChunkX: -40, minChunkZ: -43, maxChunkZ: -40, limit: 999, dryRun: false })).toMatchObject({
      world: "Bedrock_level",
      minChunkX: -45,
      maxChunkX: -40,
      limit: 8,
      dryRun: false,
    });
    expect(() => normalizeEmptyChunkPrunePayload({ minChunkX: 1, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0 })).toThrow(/invalid chunk range/);
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

  it("colors stair and slab block ids by material instead of matching air inside stairs", () => {
    expect(fallbackTextureColor("minecraft:air")).toBe("#111820");
    expect(usesMapTint("minecraft:grass_block")).toBe(true);
    expect(usesMapTint("minecraft:water")).toBe(true);
    expect(usesMapTint("minecraft:stone")).toBe(false);
    expect(fallbackTextureColor("minecraft:spruce_stairs")).toBe("#6f4c2d");
    expect(fallbackTextureColor("minecraft:spruce_stairs")).not.toBe(fallbackTextureColor("minecraft:air"));
    expect(fallbackTextureColor("minecraft:oak_slab")).toBe("#9f7442");
    expect(fallbackTextureColor("minecraft:stone_brick_stairs")).toBe("#7d8587");
    expect(fallbackTextureColor("minecraft:smooth_quartz_slab")).toBe("#d8d1bf");
    expect(fallbackTextureColor("minecraft:end_bricks")).toBe("#d7cf92");
    expect(fallbackTextureColor("minecraft:end_stone")).toBe("#d8cf8a");
    expect(fallbackTextureColor("minecraft:podzol")).toBe("#6f4a2e");
    expect(fallbackTextureColor("minecraft:farmland")).toBe("#6f4b31");
    expect(fallbackTextureColor("minecraft:melon_block")).toBe("#8fbf3d");
    expect(fallbackTextureColor("minecraft:waxed_cut_copper_slab")).toBe("#b86f45");
    expect(fallbackTextureColor("minecraft:waxed_oxidized_cut_copper_slab")).toBe("#5b9a8f");
    expect(fallbackTextureColor("minecraft:wooden_slab", { "minecraft:wood_type": "spruce" })).toBe("#6f4c2d");
    expect(fallbackTextureColor("minecraft:stone_slab", { "minecraft:stone_slab_type": "quartz" })).toBe("#d8d1bf");
    expect(fallbackTextureColor("minecraft:torch")).toBe("#d49a42");
    expect(fallbackTextureColor("minecraft:bamboo")).toBe("#7fa847");
    expect(fallbackTextureColor("minecraft:wheat")).toBe("#c8aa42");
    expect(fallbackTextureColor("minecraft:kelp")).toBe("#4f8f35");
    expect(fallbackTextureColor("minecraft:white_carpet")).toBe("#d8d8d0");
    expect(fallbackTextureColor("minecraft:lantern")).toBe("#d8b35a");
    expect(fallbackTextureColor("minecraft:obsidian")).toBe("#46375f");
    expect(fallbackTextureColor("minecraft:scaffolding")).toBe("#8a6138");
    expect(fallbackTextureColor("minecraft:wall_sign")).toBe("#8a6138");
    expect(fallbackTextureColor("minecraft:glow_lichen")).toBe("#78a88a");
    expect(fallbackTextureColor("minecraft:oxidized_lightning_rod")).toBe("#5b9a8f");
    expect(fallbackTextureColor("minecraft:light_gray_concrete")).toBe("#a7abae");
    expect(fallbackTextureColor("minecraft:light_gray_terracotta")).toBe("#876f66");
    expect(fallbackTextureColor("minecraft:light_blue_concrete")).toBe("#4f9bc7");
    expect(fallbackTextureColor("minecraft:prismarine_slab")).toBe("#5f9f96");
    expect(fallbackTextureColor("minecraft:bamboo_mosaic")).toBe("#c8aa55");
    expect(fallbackTextureColor("minecraft:gold_block")).toBe("#d9b64a");
    expect(fallbackTextureColor("minecraft:iron_block")).toBe("#c6c4b8");
    expect(fallbackTextureColor("minecraft:amethyst_block")).toBe("#9b78c8");
    expect(fallbackTextureColor("minecraft:glowstone")).toBe("#d8a84a");
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
  it("acknowledges live chunk uploads without rebuilding map tiles on the upload path", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(createChunk()),
      }),
      env,
      ctx,
    );

    expect(upload.status).toBe(200);
    expect(await upload.json()).toMatchObject({ ok: true, tiles: expect.arrayContaining([expect.objectContaining({ zoom: 3 })]) });
    expect(ctx.pending).toBe(3);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(true);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(false);

    await ctx.flush();

    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(false);
    expect([...env.MAP_DATA.objects.keys()].some((key) => key.startsWith("map-tile-dirty/v1/"))).toBe(true);
    expect(env.MAP_DATA.objects.has("meta/v1/world/Overworld.json")).toBe(true);
  });

  it("accepts authenticated chunk uploads, stores R2 snapshots, and serves chunk ranges", async () => {
    const env = createEnv();
    const heights = Array.from({ length: 256 }, (_, index) => 64 + Math.floor(index / 16) * 6);
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(createChunk({ heights })),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);
    const uploadBody = await upload.json();
    expect(uploadBody.tiles).toHaveLength(6);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z-1/0/0.png")).toBe(false);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(true);
    await drainMapTiles(env);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z-1/0/0.png")).toBe(true);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z0/0/0.png")).toBe(true);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z1/0/0.png")).toBe(true);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z2/0/0.png")).toBe(true);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(true);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z4/0/0.png")).toBe(true);
    expect(env.live.messages.at(-1)).toContain("chunk_ready");
    expect(env.live.messages.at(-1)).toContain("tileVersion");

    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    expect(tile.status).toBe(200);
    expect(tile.headers.get("Content-Type")).toBe("image/png");
    expect(tile.headers.get("Cache-Control")).toContain("immutable");
    const png = readPng(await tile.arrayBuffer());
    expect(png.width).toBe(256);
    expect(png.height).toBe(256);
    expect(pngPixel(png, 4, 4)[3]).toBe(255);
    expect(brightness(pngPixel(png, 4, 124))).toBeGreaterThan(brightness(pngPixel(png, 4, 4)));
    expect(env.MAP_DATA.objects.get("map-tiles/v1/world/Overworld/z3/0/0.png").customMetadata.tileVersion).toBe("10");

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=0&maxChunkX=0&minChunkZ=0&maxChunkZ=0"),
      env,
      {},
    );
    const body = await chunks.json();
    expect(body.chunks).toHaveLength(1);
    expect(body.missing).toHaveLength(0);
  });

  it("renders z-1 map tiles by aggregating 2x2 block columns into one pixel", async () => {
    const env = createEnv();
    const blocks = Array.from({ length: 256 }, (_, index) => {
      const localX = index % 16;
      const localZ = Math.floor(index / 16);
      return localX < 2 && localZ < 2 ? 1 : 0;
    });
    await env.MAP_DATA.put("chunk-regions/v1/world/Overworld/0/0.json", JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: [createChunk({ palette: ["minecraft:grass_block", "minecraft:water"], blocks })] }), {
      httpMetadata: { contentType: "application/json" },
    });

    const backfill = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: -1, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });
    expect(await backfill.json()).toMatchObject({ ok: true, written: 1 });

    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z-1/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());

    expect(tile.status).toBe(200);
    expect(png.width).toBe(256);
    expect(png.height).toBe(256);
    expect(pngPixel(png, 0, 0)[3]).toBe(255);
    expect(pngPixel(png, 0, 0)[2]).toBeGreaterThan(pngPixel(png, 8, 8)[2]);
  });

  it("renders the same source chunk at every image zoom", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: "region",
          chunks: [createChunk({ chunkX: 3, chunkZ: 2, updatedAt: 42 })],
        }),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    await drainMapTiles(env);
    for (const zoom of [-1, 0, 1, 2, 3]) {
      const tileRef = mapTilesForChunk("world", "Overworld", 3, 2).find((tile) => tile.zoom === zoom);
      expect(tileRef).toBeTruthy();
      const key = mapTileKey("world", "Overworld", zoom, tileRef.tileX, tileRef.tileZ);
      expect(env.MAP_DATA.objects.has(key)).toBe(true);
      const png = readPng(await env.MAP_DATA.objects.get(key).arrayBuffer());
      const range = chunkRangeForMapTile(tileRef);
      const blockScale = 2 ** zoom;
      const sampleWorldX = 3 * 16;
      const sampleWorldZ = 2 * 16;
      const sampleX = Math.floor((sampleWorldX - range.minBlockX) * blockScale);
      const sampleY = Math.floor((sampleWorldZ - range.minBlockZ) * blockScale);
      expect(pngPixel(png, sampleX, sampleY)[3]).toBe(255);
    }
  });

  it("renders stair map tiles with material colors instead of dark air fallback", async () => {
    const env = createEnv();
    const stairIndex = 1;
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette: ["minecraft:grass_block", "minecraft:spruce_stairs", "minecraft:air"],
            blocks: Array.from({ length: 256 }, (_, index) => (index === stairIndex ? 1 : 0)),
            heights: Array.from({ length: 256 }, () => 128),
          }),
        ),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);

    await drainMapTiles(env);
    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());
    const pixel = pngPixel(png, 12, 4);
    expect(pixel[3]).toBe(255);
    expect(pixel[0] + pixel[1] + pixel[2]).toBeGreaterThan(120);
    expect(pixel[0]).toBeGreaterThan(pixel[2]);
  });

  it("renders low zoom map tiles from atlas average colors, including obsidian", async () => {
    const env = createEnv({
      manifestColors: false,
      textureColors: {
        "minecraft:grass_block": [95, 159, 63],
        "minecraft:obsidian": [18, 15, 31],
      },
    });
    const blocks = Array.from({ length: 256 }, () => 0);
    blocks[0] = 1;
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette: ["minecraft:grass_block", "minecraft:obsidian", "minecraft:air"],
            blocks,
            heights: Array.from({ length: 256 }, () => 100),
          }),
        ),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);

    await drainMapTiles(env);
    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());
    const pixel = pngPixel(png, 4, 4);
    expect(pixel[3]).toBe(255);
    expect(pixel[0]).toBeLessThan(30);
    expect(pixel[1]).toBeLessThan(30);
    expect(pixel[2]).toBeLessThan(45);
  });

  it("renders map-tinted low zoom blocks from tint colors instead of grayscale atlas colors", async () => {
    const env = createEnv({
      textureColors: {
        "minecraft:grass_block": [152, 152, 152],
        "minecraft:water": [152, 152, 152],
      },
    });
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette: ["minecraft:grass_block", "minecraft:water", "minecraft:air"],
            heights: Array.from({ length: 256 }, () => 100),
          }),
        ),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);

    await drainMapTiles(env);
    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());
    const grass = pngPixel(png, 4, 4);
    expect(grass[3]).toBe(255);
    expect(grass[1]).toBeGreaterThan(grass[0] + 30);
    expect(grass[1]).toBeGreaterThan(grass[2] + 30);
    expect(Math.abs(grass[0] - grass[1])).toBeGreaterThan(20);
  });

  it("uses atlas colors for common block families instead of fallback colors", async () => {
    const env = createEnv({
      manifestColors: false,
      textureColors: {
        "minecraft:stone": [11, 22, 33],
        "minecraft:oak_planks": [120, 70, 30],
        "minecraft:obsidian": [18, 15, 31],
        "minecraft:diamond_block": [20, 180, 190],
        "minecraft:oak_leaves": [30, 120, 40],
      },
    });
    const palette = ["minecraft:stone", "minecraft:oak_planks", "minecraft:obsidian", "minecraft:diamond_block", "minecraft:oak_leaves", "minecraft:air"];
    const blocks = Array.from({ length: 256 }, () => 0);
    for (let index = 0; index < palette.length - 1; index += 1) {
      blocks[index] = index;
    }

    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette,
            blocks,
            heights: Array.from({ length: 256 }, () => 100),
          }),
        ),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);

    await drainMapTiles(env);
    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());
    expect(pngPixel(png, 4, 4)[2]).toBeGreaterThan(pngPixel(png, 4, 4)[0]);
    expect(pngPixel(png, 12, 4)[0]).toBeGreaterThan(pngPixel(png, 12, 4)[2]);
    expect(pngPixel(png, 20, 4)[0]).toBeLessThan(30);
    expect(pngPixel(png, 28, 4)[1]).toBeGreaterThan(150);
    expect(pngPixel(png, 36, 4)[1]).toBeGreaterThan(pngPixel(png, 36, 4)[0]);
  });

  it("uses manifest colors when runtime atlas decoding is unavailable", async () => {
    const env = createEnv({
      textureColors: {
        "minecraft:grass_block": [95, 159, 63],
        "minecraft:obsidian": [18, 15, 31],
      },
    });
    await env.MAP_DATA.put("textures/v1/atlas.png", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });
    const blocks = Array.from({ length: 256 }, () => 0);
    blocks[0] = 1;
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette: ["minecraft:grass_block", "minecraft:obsidian", "minecraft:air"],
            blocks,
            heights: Array.from({ length: 256 }, () => 100),
          }),
        ),
      }),
      env,
      {},
    );

    expect(upload.status).toBe(200);
    await drainMapTiles(env);
    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());
    expect(pngPixel(png, 4, 4)[0]).toBeLessThan(30);
  });

  it("derives low zoom image tiles from rebuilt z4 fallback-color sources", async () => {
    const env = createEnv({ textures: false });
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });

    expect(await response.json()).toMatchObject({ ok: true, tiles: [expect.objectContaining({ deleted: false })] });
    const png = readPng(await env.MAP_DATA.objects.get(key).arrayBuffer());
    expect(pngPixel(png, 4, 4)[3]).toBe(255);
  });

  it("does not derive low zoom image tiles before the z4 source exists", async () => {
    const env = createEnv();
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });

    const response = await backfillMapTile(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });

    expect(await response.json()).toMatchObject({ ok: true, tiles: [expect.objectContaining({ deleted: true, sourceTiles: 0, missingSourceTiles: 4 })] });
    expect(env.MAP_DATA.objects.has(key)).toBe(false);
  });

  it("derives low zoom image tiles from z4 sources with default fallback colors", async () => {
    const env = createEnv({ textureColors: { "minecraft:grass_block": [95, 159, 63] } });
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    const blocks = Array.from({ length: 256 }, () => 0);
    blocks[0] = 1;
    await env.MAP_DATA.put(
      "chunks/v1/world/Overworld/0/0.json",
      JSON.stringify(createChunk({ palette: ["minecraft:grass_block", "minecraft:not_in_atlas", "minecraft:air"], blocks })),
      { httpMetadata: { contentType: "application/json" } },
    );
    await env.MAP_DATA.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });

    expect(await response.json()).toMatchObject({ ok: true, tiles: [expect.objectContaining({ deleted: false })] });
    const png = readPng(await env.MAP_DATA.objects.get(key).arrayBuffer());
    const fallback = pngPixel(png, 4, 4);
    expect(fallback[3]).toBe(255);
    expect(Math.abs(fallback[0] - fallback[1])).toBeLessThan(20);
    expect(Math.abs(fallback[1] - fallback[2])).toBeLessThan(20);
  });

  it("does not delete newer low zoom tiles during stale rebuilds with missing colors", async () => {
    const env = createEnv({ textureColors: { "minecraft:grass_block": [95, 159, 63] } });
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    const blocks = Array.from({ length: 256 }, () => 0);
    blocks[0] = 1;
    await env.MAP_DATA.put(
      "chunks/v1/world/Overworld/0/0.json",
      JSON.stringify(createChunk({ palette: ["minecraft:grass_block", "minecraft:not_in_atlas", "minecraft:air"], blocks, updatedAt: 10 })),
      { httpMetadata: { contentType: "application/json" } },
    );
    await env.MAP_DATA.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { tileVersion: "99", sourceVersion: "99" },
    });

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false });

    expect(await response.json()).toMatchObject({ ok: true, tiles: [expect.objectContaining({ skipped: true, sourceVersion: 10, existingSourceVersion: 99 })] });
    expect(Buffer.from(await env.MAP_DATA.objects.get(key).arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it("keeps valid low zoom pixels when neighboring source blocks lack atlas colors", async () => {
    const env = createEnv({
      textureColors: {
        "minecraft:grass_block": [95, 159, 63],
      },
    });
    const blocks = Array.from({ length: 256 }, () => 0);
    blocks[0] = 1;
    await env.MAP_DATA.put(
      "chunk-regions/v1/world/Overworld/0/0.json",
      JSON.stringify({
        version: 1,
        world: "world",
        dimension: "Overworld",
        regionSize: 16,
        regionX: 0,
        regionZ: 0,
        chunks: [
          createChunk({ chunkX: 0, chunkZ: 0, updatedAt: 10 }),
          createChunk({ chunkX: 1, chunkZ: 0, palette: ["minecraft:grass_block", "minecraft:not_in_atlas", "minecraft:air"], blocks, updatedAt: 20 }),
        ],
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    await backfillMapTiles(env, { world: "world", dimension: "Overworld", zoom: 4, minChunkX: 0, maxChunkX: 1, minChunkZ: 0, maxChunkZ: 0 });
    await backfillMapTiles(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 1, minChunkZ: 0, maxChunkZ: 0 });
    const body = await backfillMapTiles(env, { world: "world", dimension: "Overworld", zoom: 2, minChunkX: 0, maxChunkX: 1, minChunkZ: 0, maxChunkZ: 0 });

    expect(body).toMatchObject({
      ok: true,
      tiles: [expect.objectContaining({ deleted: false })],
    });
    const key = "map-tiles/v1/world/Overworld/z2/0/0.png";
    expect(env.MAP_DATA.objects.has(key)).toBe(true);
    const png = readPng(await env.MAP_DATA.objects.get(key).arrayBuffer());
    expect(pngPixel(png, 0, 0)[3]).toBe(255);
  });

  it("uses deterministic fallback colors for known blocks missing from the atlas", async () => {
    const env = createEnv({ textureColors: { "minecraft:grass_block": [95, 159, 63] } });
    const blocks = Array.from({ length: 256 }, () => 0);
    blocks[0] = 1;
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette: ["minecraft:grass_block", "minecraft:oak_leaves", "minecraft:air"],
            blocks,
            heights: Array.from({ length: 256 }, () => 100),
          }),
        ),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);

    await drainMapTiles(env);
    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());
    const pixel = pngPixel(png, 4, 4);
    expect(pixel[3]).toBe(255);
    expect(pixel[1]).toBeGreaterThan(pixel[0]);
    expect(pixel[1]).toBeGreaterThan(pixel[2]);
  });

  it("keeps air-only columns transparent in low zoom image tiles", async () => {
    const env = createEnv();
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette: ["minecraft:air"],
            blocks: Array.from({ length: 256 }, () => 0),
            heights: Array.from({ length: 256 }, () => 128),
            overlayBlocks: Array.from({ length: 256 }, () => 0),
            overlayHeights: Array.from({ length: 256 }, () => -64),
          }),
        ),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(false);
  });

  it("fills enclosed transparent holes in low zoom image tiles from neighboring colors", async () => {
    const env = createEnv();
    const chunks = [];
    for (let chunkZ = 0; chunkZ < 4; chunkZ += 1) {
      for (let chunkX = 0; chunkX < 4; chunkX += 1) {
        if (chunkX === 1 && chunkZ === 1) {
          continue;
        }
        chunks.push(createChunk({ chunkX, chunkZ, updatedAt: 20 + chunkX + chunkZ }));
      }
    }

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ chunks }),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    await drainMapTiles(env);
    const z2Tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z2/0/0.png"), env, {});
    const z2Png = readPng(await z2Tile.arrayBuffer());
    expect(pngPixel(z2Png, 96, 96)[3]).toBe(255);

    const z3Tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const z3Png = readPng(await z3Tile.arrayBuffer());
    expect(pngPixel(z3Png, 192, 192)[3]).toBe(0);
  });

  it("prunes historical all-air chunks from direct and region storage", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createEmptyChunk({ chunkX: 0, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put(
      "chunk-regions/v1/world/Overworld/0/0.json",
      JSON.stringify({
        version: 1,
        world: "world",
        dimension: "Overworld",
        regionSize: 16,
        regionX: 0,
        regionZ: 0,
        chunks: [createEmptyChunk({ chunkX: 0, chunkZ: 0 }), createChunk({ chunkX: 1, chunkZ: 0 })],
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 1, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/prune-empty", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ world: "world", dimension: "Overworld", minChunkX: 0, maxChunkX: 1, minChunkZ: 0, maxChunkZ: 0, dryRun: false }),
      }),
      env,
      {},
    );

    expect(await response.json()).toMatchObject({ ok: true, dryRun: false, matched: 1, deleted: 1, tiles: 6 });
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(false);
    const region = await env.MAP_DATA.objects.get("chunk-regions/v1/world/Overworld/0/0.json").json();
    expect(region.chunks).toHaveLength(1);
    expect(region.chunks[0].chunkX).toBe(1);
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(true);
  });

  it("colors overlay-only low zoom columns from the overlay block", async () => {
    const env = createEnv();
    const upload = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(
          createChunk({
            palette: ["minecraft:air", "minecraft:oak_leaves"],
            blocks: Array.from({ length: 256 }, () => 0),
            heights: Array.from({ length: 256 }, () => 128),
            overlayBlocks: Array.from({ length: 256 }, (_, index) => (index === 0 ? 1 : 0)),
            overlayHeights: Array.from({ length: 256 }, (_, index) => (index === 0 ? 129 : -64)),
          }),
        ),
      }),
      env,
      {},
    );
    expect(upload.status).toBe(200);

    await drainMapTiles(env);
    const tile = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await tile.arrayBuffer());
    const pixel = pngPixel(png, 4, 4);
    expect(pixel[3]).toBe(255);
    expect(pixel[1]).toBeGreaterThan(pixel[0]);
    expect(pixel[1]).toBeGreaterThan(pixel[2]);
  });

  it("reads region chunks first for full map-tile-sized ranges", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunks/v1/world/Overworld/1/0.json", JSON.stringify(createChunk({ chunkX: 1 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunk-regions/v1/world/Overworld/0/0.json", JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: [createChunk({ chunkX: 2 })] }), {
      httpMetadata: { contentType: "application/json" },
    });

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=0&maxChunkX=15&minChunkZ=0&maxChunkZ=15"),
      env,
      {},
    );
    const body = await chunks.json();
    expect(body.chunks).toHaveLength(3);
    expect(body.missing).toHaveLength(253);
    expect(env.MAP_DATA.listCalls.filter((prefix) => prefix.startsWith("chunks/v1/world/Overworld/"))).toHaveLength(16);
    expect(env.MAP_DATA.getCalls[0]).toBe("chunk-regions/v1/world/Overworld/0/0.json");
    expect(env.MAP_DATA.getCalls.filter((key) => key.startsWith("chunks/v1/world/Overworld/")).sort()).toEqual([
      "chunks/v1/world/Overworld/0/0.json",
      "chunks/v1/world/Overworld/1/0.json",
    ]);
  });

  it("reads direct chunk keys before targeted region fallback for small ranges", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ chunkX: 0, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunk-regions/v1/world/Overworld/0/0.json", JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: [createChunk({ chunkX: 1, chunkZ: 1 })] }), {
      httpMetadata: { contentType: "application/json" },
    });

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=0&maxChunkX=1&minChunkZ=0&maxChunkZ=1"),
      env,
      {},
    );

    const body = await chunks.json();
    expect(body.chunks).toHaveLength(2);
    expect(body.missing).toHaveLength(2);
    expect(env.MAP_DATA.getCalls.slice(0, 4)).toEqual([
      "chunks/v1/world/Overworld/0/0.json",
      "chunks/v1/world/Overworld/1/0.json",
      "chunks/v1/world/Overworld/0/1.json",
      "chunks/v1/world/Overworld/1/1.json",
    ]);
    expect(env.MAP_DATA.getCalls.filter((key) => key === "chunk-regions/v1/world/Overworld/0/0.json")).toHaveLength(1);
  });

  it("filters region chunks before normalizing small range fallbacks", async () => {
    const env = createEnv();
    const regionChunks = Array.from({ length: 256 }, (_, index) => ({
      chunkX: index % 16,
      chunkZ: Math.floor(index / 16),
      blocks: "invalid",
    }));
    regionChunks[13 * 16 + 12] = createChunk({ chunkX: 12, chunkZ: 13, updatedAt: 42 });
    await env.MAP_DATA.put(
      "chunk-regions/v1/world/Overworld/0/0.json",
      JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: regionChunks }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const response = await backfillMapTile(env, { world: "world", dimension: "Overworld", zoom: 4, minChunkX: 12, maxChunkX: 12, minChunkZ: 13, maxChunkZ: 13, dryRun: false, force: true });
    const body = await response.json();
    const key = "map-tiles/v1/world/Overworld/z4/12/13.png";

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, written: 1, tiles: [expect.objectContaining({ chunks: 1, sourceVersion: 42 })] });
    expect(PNG.sync.read(Buffer.from(await env.MAP_DATA.objects.get(key).arrayBuffer())).width).toBe(256);
  });

  it("returns compact chunk summaries when requested", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ chunkX: 0, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunks/v1/world/Overworld/1/0.json", JSON.stringify(createEmptyChunk({ chunkX: 1, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=0&maxChunkX=1&minChunkZ=0&maxChunkZ=0&summary=1"),
      env,
      {},
    );

    const body = await chunks.json();
    expect(body.chunks).toEqual([
      expect.objectContaining({ chunkX: 0, chunkZ: 0, hasNonAir: true }),
      expect.objectContaining({ chunkX: 1, chunkZ: 0, hasNonAir: false }),
    ]);
    expect(body.chunks[0]).not.toHaveProperty("blocks");
    expect(body.chunks[0]).not.toHaveProperty("palette");
  });

  it("returns compact chunk summaries for full ranges without direct body reads", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunks/v1/world/Overworld/1/0.json", JSON.stringify(createChunk({ chunkX: 1 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunk-regions/v1/world/Overworld/0/0.json", JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: [createChunk({ chunkX: 2 })] }), {
      httpMetadata: { contentType: "application/json" },
    });

    const chunks = await worker.fetch(
      new Request("https://map.buhe.li/api/chunks?world=world&dimension=Overworld&minChunkX=0&maxChunkX=15&minChunkZ=0&maxChunkZ=15&summary=1"),
      env,
      {},
    );

    const body = await chunks.json();
    expect(body.chunks).toEqual([
      expect.objectContaining({ chunkX: 0, chunkZ: 0, hasNonAir: true }),
      expect.objectContaining({ chunkX: 1, chunkZ: 0, hasNonAir: true }),
      expect.objectContaining({ chunkX: 2, chunkZ: 0, hasNonAir: true }),
    ]);
    expect(env.MAP_DATA.getCalls.filter((key) => key.startsWith("chunks/v1/world/Overworld/"))).toHaveLength(0);
    expect(env.MAP_DATA.listCalls.filter((prefix) => prefix.startsWith("chunks/v1/world/Overworld/"))).toHaveLength(16);
    expect(body.chunks[0]).not.toHaveProperty("blocks");
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

  it("skips all-air chunk uploads before they can become map data", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(createEmptyChunk({ updatedAt: 20 })),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, skippedEmpty: 1, rejected: [{ chunkX: 0, chunkZ: 0 }], updates: 0 });
    const stored = await env.MAP_DATA.objects.get("chunks/v1/world/Overworld/0/0.json").json();
    expect(stored.palette).toContain("minecraft:grass_block");
  });

  it("skips all-air chunk uploads even when no previous terrain exists", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify(createEmptyChunk()),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, skippedEmpty: 1, rejected: [{ chunkX: 0, chunkZ: 0 }], updates: 0 });
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(false);
  });

  it("applies authenticated dirty block updates to existing chunk snapshots", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk()), {
      httpMetadata: { contentType: "application/json" },
    });
    await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false });
    const before = Buffer.from(await env.MAP_DATA.objects.get("map-tiles/v1/world/Overworld/z3/0/0.png").arrayBuffer());

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
    expect(await update.json()).toMatchObject({ ok: true, missingBase: false, updates: 1, tiles: expect.arrayContaining([expect.objectContaining({ zoom: 3 })]) });
    expect(env.live.messages.at(-1)).toContain("block_updates");
    expect(env.live.messages.at(-1)).toContain("tileVersion");
    const stored = await env.MAP_DATA.objects.get("chunks/v1/world/Overworld/0/0.json").json();
    const index = 3 * 16 + 2;
    expect(stored.palette[stored.blocks[index]]).toBe("minecraft:oak_trapdoor");
    expect(stored.heights[index]).toBe(71);
    expect(stored.blockStates[index]).toEqual({ direction: 1, open_bit: true });
    expect(stored.palette[stored.overlayBlocks[index]]).toBe("minecraft:poppy");
    expect(stored.overlayHeights[index]).toBe(72);
    expect(stored.overlayStates[index]).toEqual({ facing_direction: 1 });
    expect([...env.MAP_DATA.objects.keys()].some((key) => key.startsWith("map-tile-dirty/v1/"))).toBe(true);
    await drainMapTiles(env);
    const after = Buffer.from(await env.MAP_DATA.objects.get("map-tiles/v1/world/Overworld/z3/0/0.png").arrayBuffer());
    expect(Buffer.compare(before, after)).not.toBe(0);
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

  it("applies dirty block update batches and writes shared map tiles once", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ chunkX: 0, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("chunks/v1/world/Overworld/1/0.json", JSON.stringify(createChunk({ chunkX: 1, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });
    env.MAP_DATA.putCalls = [];

    const update = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/block-updates/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          batches: [
            {
              world: "world",
              dimension: "Overworld",
              chunkX: 0,
              chunkZ: 0,
              updates: [{ localX: 1, localZ: 1, block: "minecraft:stone", height: 70 }],
              updatedAt: 30,
            },
            {
              world: "world",
              dimension: "Overworld",
              chunkX: 1,
              chunkZ: 0,
              updates: [{ localX: 2, localZ: 2, block: "minecraft:oak_planks", height: 72 }],
              updatedAt: 31,
            },
          ],
        }),
      }),
      env,
      {},
    );

    const body = await update.json();
    expect(update.status).toBe(200);
    expect(body).toMatchObject({ ok: true, missingBase: false, chunks: 2, updates: 2 });
    expect(env.live.messages.filter((message) => String(message).includes("block_updates"))).toHaveLength(2);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "chunks/v1/world/Overworld/0/0.json")).toHaveLength(1);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "chunks/v1/world/Overworld/1/0.json")).toHaveLength(1);
    expect(env.MAP_DATA.putCalls.filter((key) => key.startsWith("map-tile-dirty/v1/"))).toHaveLength(7);
    expect(env.MAP_DATA.putCalls.filter((key) => key.startsWith("map-tiles/v1/"))).toHaveLength(0);
    env.MAP_DATA.putCalls = [];
    await drainMapTiles(env);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "map-tiles/v1/world/Overworld/z4/0/0.png")).toHaveLength(1);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "map-tiles/v1/world/Overworld/z4/1/0.png")).toHaveLength(1);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "map-tiles/v1/world/Overworld/z0/0/0.png")).toHaveLength(1);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "map-tiles/v1/world/Overworld/z1/0/0.png")).toHaveLength(1);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "map-tiles/v1/world/Overworld/z2/0/0.png")).toHaveLength(1);
    expect(env.MAP_DATA.putCalls.filter((key) => key === "map-tiles/v1/world/Overworld/z3/0/0.png")).toHaveLength(1);
  });

  it("reports missing base chunks in dirty block update batches without failing good chunks", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ chunkX: 0, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });

    const update = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/block-updates/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          batches: [
            {
              world: "world",
              dimension: "Overworld",
              chunkX: 0,
              chunkZ: 0,
              updates: [{ localX: 1, localZ: 1, block: "minecraft:stone", height: 70 }],
              updatedAt: 30,
            },
            {
              world: "world",
              dimension: "Overworld",
              chunkX: 2,
              chunkZ: 0,
              updates: [{ localX: 2, localZ: 2, block: "minecraft:oak_planks", height: 72 }],
              updatedAt: 31,
            },
          ],
        }),
      }),
      env,
      {},
    );

    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({
      ok: true,
      missingBase: true,
      chunks: 1,
      updates: 1,
      missingBaseChunks: [expect.objectContaining({ chunkX: 2, chunkZ: 0 })],
    });
  });

  it("rejects oversized dirty block update batches", async () => {
    const env = createEnv();
    const update = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/block-updates/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          batches: Array.from({ length: 17 }, (_, chunkX) => ({
            world: "world",
            dimension: "Overworld",
            chunkX,
            chunkZ: 0,
            updates: Array.from({ length: 256 }, (_, index) => ({
              localX: index % 16,
              localZ: Math.floor(index / 16),
              block: "minecraft:stone",
              height: 70,
            })),
            updatedAt: 30,
          })),
        }),
      }),
      env,
      {},
    );

    expect(update.status).toBe(400);
    expect(await update.json()).toMatchObject({ error: "invalid_block_update_batch" });
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
      sampleChunks: [
        { chunkX: 0, chunkZ: 0 },
        { chunkX: 1, chunkZ: 0 },
      ],
    });
    expect(env.live.messages).toHaveLength(0);
  });

  it("skips all-air chunk batch entries before they can become map data", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunks/v1/world/Overworld/1/0.json", JSON.stringify(createChunk({ chunkX: 1 })), {
      httpMetadata: { contentType: "application/json" },
    });

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ chunks: [createEmptyChunk({ chunkX: 1, updatedAt: 20 })] }),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, chunks: 0, skippedEmpty: 1, rejected: [{ chunkX: 1, chunkZ: 0 }], keys: [], updates: 0 });
    const stored = await env.MAP_DATA.objects.get("chunks/v1/world/Overworld/1/0.json").json();
    expect(stored.palette).toContain("minecraft:grass_block");
  });

  it("stores good chunk batch entries while skipping all-air entries", async () => {
    const env = createEnv();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ chunks: [createChunk({ chunkX: 2 }), createEmptyChunk({ chunkX: 3 })] }),
      }),
      env,
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, chunks: 1, skippedEmpty: 1, rejected: [{ chunkX: 3, chunkZ: 0 }] });
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/2/0.json")).toBe(true);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/3/0.json")).toBe(false);
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

  it("stores region-requested chunk batches as direct chunks and serves them through chunk ranges", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
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
      ctx,
    );
    const uploadBody = await response.json();
    expect(response.status).toBe(200);
    expect(uploadBody).toMatchObject({ storage: "chunk", requestedStorage: "region", chunks: 3 });
    expect(env.MAP_DATA.objects.has("chunk-regions/v1/world/Overworld/-1/-1.json")).toBe(false);
    expect(env.MAP_DATA.objects.has("chunk-regions/v1/world/Overworld/0/0.json")).toBe(false);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/-1/-1.json")).toBe(true);
    await ctx.flush();
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

  it("does not read or rewrite large legacy region objects while accepting region-requested uploads", async () => {
    const env = createEnv();
    const legacyRegionKey = "chunk-regions/v1/world/Overworld/0/0.json";
    await env.MAP_DATA.put(
      legacyRegionKey,
      JSON.stringify({
        version: 1,
        world: "world",
        dimension: "Overworld",
        regionSize: 16,
        regionX: 0,
        regionZ: 0,
        chunks: Array.from({ length: 256 }, (_, index) => createChunk({ chunkX: index % 16, chunkZ: Math.floor(index / 16), updatedAt: index + 1 })),
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    env.MAP_DATA.getCalls = [];
    env.MAP_DATA.putCalls = [];

    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ storage: "region", chunks: [createChunk({ chunkX: 0, chunkZ: 0, updatedAt: 999 })] }),
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ storage: "chunk", requestedStorage: "region", chunks: 1 });
    expect(env.MAP_DATA.getCalls).not.toContain(legacyRegionKey);
    expect(env.MAP_DATA.putCalls).not.toContain(legacyRegionKey);
    const direct = await env.MAP_DATA.objects.get("chunks/v1/world/Overworld/0/0.json").json();
    expect(direct.updatedAt).toBe(999);
  });

  it("migrates legacy region chunks into direct chunk objects and deletes old regions", async () => {
    const env = createEnv();
    const legacyRegionKey = "chunk-regions/v1/world/Overworld/0/0.json";
    await env.MAP_DATA.put(
      legacyRegionKey,
      JSON.stringify({
        version: 1,
        world: "world",
        dimension: "Overworld",
        chunks: [createChunk({ chunkX: 0, chunkZ: 0, updatedAt: 11 }), createEmptyChunk({ chunkX: 1, chunkZ: 0, updatedAt: 12 })],
      }),
      { httpMetadata: { contentType: "application/json" } },
    );

    const dryRun = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/migrate-regions", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ world: "world", dimension: "Overworld", dryRun: true, limit: 1 }),
      }),
      env,
      {},
    );

    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toMatchObject({ ok: true, dryRun: true, matched: 1, migrated: 1, skippedEmpty: 1, deletedRegions: 0 });
    expect(env.MAP_DATA.objects.has(legacyRegionKey)).toBe(true);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(false);

    const real = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/migrate-regions", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ world: "world", dimension: "Overworld", dryRun: false, deleteRegions: true, confirm: "migrate-chunk-regions-v1", limit: 1 }),
      }),
      env,
      {},
    );

    expect(real.status).toBe(200);
    expect(await real.json()).toMatchObject({ ok: true, dryRun: false, matched: 1, migrated: 1, skippedEmpty: 1, deletedRegions: 1 });
    expect(env.MAP_DATA.objects.has(legacyRegionKey)).toBe(false);
    const direct = await env.MAP_DATA.objects.get("chunks/v1/world/Overworld/0/0.json").json();
    expect(direct.updatedAt).toBe(11);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/1/0.json")).toBe(false);
  });

  it("generates low zoom image tiles for negative-coordinate region chunk batches", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: "region",
          chunks: [createChunk({ chunkX: -1, chunkZ: -1 })],
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ storage: "chunk", requestedStorage: "region", chunks: 1 });
    await ctx.flush();
    expect(env.MAP_DATA.objects.has(mapTileKey("world", "Overworld", 3, -1, -1))).toBe(false);
    await drainMapTiles(env);
    for (const zoom of [-1, 0, 1, 2, 3]) {
      const key = mapTileKey("world", "Overworld", zoom, -1, -1);
      expect(env.MAP_DATA.objects.has(key)).toBe(true);
      const png = readPng(await env.MAP_DATA.objects.get(key).arrayBuffer());
      expect(pngPixel(png, 252, 252)[3]).toBe(255);
    }
  });

  it("broadcasts one chunks_ready message for region chunk batch uploads", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: "region",
          broadcast: true,
          chunks: [createChunk({ chunkX: 0, updatedAt: 10 }), createChunk({ chunkX: 1, updatedAt: 20 }), createEmptyChunk({ chunkX: 2, updatedAt: 30 })],
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ storage: "chunk", requestedStorage: "region", chunks: 2, skippedEmpty: 1, updates: 0 });
    expect(env.MAP_DATA.objects.has("chunk-regions/v1/world/Overworld/0/0.json")).toBe(false);
    expect(env.MAP_DATA.objects.has("chunks/v1/world/Overworld/0/0.json")).toBe(true);
    await ctx.flush();
    expect(env.live.messages).toHaveLength(1);
    expect(JSON.parse(env.live.messages[0])).toMatchObject({
      type: "chunks_ready",
      world: "world",
      dimension: "Overworld",
      updatedAt: 20,
      tileVersion: 20,
      chunks: [
        { chunkX: 0, chunkZ: 0, updatedAt: 10 },
        { chunkX: 1, chunkZ: 0, updatedAt: 20 },
      ],
    });
  });

  it("queues dirty map tiles without rebuilding them on the upload path", async () => {
    const env = createEnv();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/chunks/batch", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({
          storage: "region",
          chunks: Array.from({ length: 20 }, (_, index) => createChunk({ chunkX: index * 16 })),
        }),
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect([...env.MAP_DATA.objects.keys()].some((key) => key.startsWith("map-tile-dirty/v1/"))).toBe(true);

    await ctx.flush();

    const queuedAfterUploadTasks = [...env.MAP_DATA.objects.keys()].filter((key) => key.startsWith("map-tile-dirty/v1/"));
    expect(queuedAfterUploadTasks.length).toBeGreaterThan(0);
    expect([...env.MAP_DATA.objects.keys()].filter((key) => key.startsWith("map-tiles/v1/"))).toHaveLength(0);

    const drain = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/map-tiles/drain", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100 }),
      }),
      env,
      {},
    );

    expect(drain.status).toBe(200);
    expect(await drain.json()).toMatchObject({ ok: true });
    const secondDrain = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/map-tiles/drain", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100 }),
      }),
      env,
      {},
    );

    expect(secondDrain.status).toBe(200);
    expect(await secondDrain.json()).toMatchObject({ ok: true });
    expect([...env.MAP_DATA.objects.keys()].filter((key) => key.startsWith("map-tile-dirty/v1/"))).toHaveLength(0);
    expect([...env.MAP_DATA.objects.keys()].filter((key) => key.startsWith("map-tiles/v1/")).length).toBeGreaterThan(0);
  });

  it("backfills low zoom image tiles in batches and supports dry runs", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("chunk-regions/v1/world/Overworld/0/0.json", JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: [createChunk()] }), {
      httpMetadata: { contentType: "application/json" },
    });

    const dryRun = await worker.fetch(
      new Request("https://map.buhe.li/api/plugin/map-tiles/backfill", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 4, minChunkZ: 0, maxChunkZ: 0, limit: 1, dryRun: true }),
      }),
      env,
      {},
    );
    expect(await dryRun.json()).toMatchObject({ ok: true, dryRun: true, total: 3, matched: 1, written: 0, cursor: "1" });
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(false);

    const real = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });
    expect(await real.json()).toMatchObject({ ok: true, dryRun: false, force: true, total: 1, matched: 1, written: 1, cursor: null });
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(true);
  });

  it("serializes forced backfill writes to keep large tile rebuilds under Worker limits", async () => {
    const env = createEnv();
    for (const chunkX of [0, 16]) {
      await env.MAP_DATA.put(`chunk-regions/v1/world/Overworld/${chunkX / 16}/0.json`, JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: [createChunk({ chunkX })] }), {
        httpMetadata: { contentType: "application/json" },
      });
    }
    const originalGet = env.MAP_DATA.get.bind(env.MAP_DATA);
    let activeReads = 0;
    let maxActiveReads = 0;
    env.MAP_DATA.get = async (key) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await Promise.resolve();
      const result = await originalGet(key);
      activeReads -= 1;
      return result;
    };

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: -1, minChunkX: 0, maxChunkX: 63, minChunkZ: 0, maxChunkZ: 0, limit: 2, dryRun: false, force: true });

    expect(await response.json()).toMatchObject({ ok: true, total: 2, matched: 1, written: 1, cursor: "1" });
    expect(maxActiveReads).toBeLessThanOrEqual(4);
  });

  it("serves transparent PNGs for missing low zoom image tiles", async () => {
    const env = createEnv();
    const response = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z3/0/0.png"), env, {});
    const png = readPng(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toContain("max-age=60");
    expect(png.width).toBe(1);
    expect(png.height).toBe(1);
    expect(pngPixel(png, 0, 0)[3]).toBe(0);
  });

  it("deletes unreadable image tile objects instead of crashing tile requests", async () => {
    const env = createEnv();
    const key = "map-tiles/v1/world/Overworld/z4/0/0.png";
    const pngObject = new PNG({ width: 1, height: 1, colorType: 6 });
    await env.MAP_DATA.put(key, PNG.sync.write(pngObject, { colorType: 6, inputColorType: 6 }), {
      httpMetadata: { contentType: "image/png" },
    });
    env.MAP_DATA.objects.get(key).arrayBuffer = async () => {
      throw new Error("r2_body_error");
    };

    const response = await worker.fetch(new Request("https://map.buhe.li/api/map-tiles/world/Overworld/z4/0/0.png"), env, {});
    const png = readPng(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(png.width).toBe(1);
    expect(png.height).toBe(1);
    expect(env.MAP_DATA.objects.has(key)).toBe(false);
  });

  it("rewrites legacy low zoom tiles when source metadata is missing", async () => {
    const env = createEnv();
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ updatedAt: 10 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { tileVersion: "99" },
    });

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false });
    const body = await response.json();

    expect(body).toMatchObject({ ok: true, tiles: [expect.objectContaining({ deleted: false, sourceVersion: 10, tileVersion: 10 })] });
    expect(body.tiles[0]).not.toHaveProperty("skipped");
    expect(PNG.sync.read(Buffer.from(await env.MAP_DATA.objects.get(key).arrayBuffer())).width).toBe(256);
    expect(env.MAP_DATA.objects.get(key).customMetadata).toMatchObject({ tileVersion: "10", sourceVersion: "10" });
  });

  it("keeps successful backfill results when world metadata touch fails", async () => {
    const env = createEnv();
    const key = "map-tiles/v1/world/Overworld/z4/0/0.png";
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ updatedAt: 10 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put("meta/v1/world/Overworld.json", "{", {
      httpMetadata: { contentType: "application/json" },
    });

    const response = await backfillMapTile(env, { world: "world", dimension: "Overworld", zoom: 4, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, written: 1, worldMetaTouched: false });
    expect(body.worldMetaError).toContain("JSON");
    expect(env.MAP_DATA.objects.has(key)).toBe(true);
  });

  it("returns structured failures for map tile backfill rebuild errors", async () => {
    const env = createEnv();
    const originalGet = env.MAP_DATA.get.bind(env.MAP_DATA);
    env.MAP_DATA.get = async (key) => {
      if (key === "chunks/v1/world/Overworld/0/0.json") {
        throw new Error("r2_get_failed");
      }
      return originalGet(key);
    };

    const response = await backfillMapTile(env, { world: "world", dimension: "Overworld", zoom: 4, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: "map_tile_backfill_failed",
      message: "r2_get_failed",
      tiles: [expect.objectContaining({ key: "map-tiles/v1/world/Overworld/z4/0/0.png" })],
    });
  });

  it("skips stale low zoom rebuilds when existing source metadata is newer", async () => {
    const env = createEnv();
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ updatedAt: 10 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { tileVersion: "99", sourceVersion: "99" },
    });

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false });

    expect(await response.json()).toMatchObject({ ok: true, tiles: [expect.objectContaining({ skipped: true, sourceVersion: 10, existingSourceVersion: 99 })] });
    expect(Buffer.from(await env.MAP_DATA.objects.get(key).arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
  });

  it("uses force backfill to rewrite newer low zoom image tiles", async () => {
    const env = createEnv();
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    await env.MAP_DATA.put("chunk-regions/v1/world/Overworld/0/0.json", JSON.stringify({ version: 1, world: "world", dimension: "Overworld", chunks: [createChunk({ updatedAt: 10 })] }), {
      httpMetadata: { contentType: "application/json" },
    });
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
    await env.MAP_DATA.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { tileVersion: "99", sourceVersion: "99" },
    });

    const forced = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });
    const forcedBody = await forced.json();
    expect(forcedBody).toMatchObject({ ok: true, force: true, tiles: [expect.objectContaining({ deleted: false })] });
    expect(forcedBody.tiles[0]).not.toHaveProperty("skipped");
    expect(PNG.sync.read(Buffer.from(await env.MAP_DATA.objects.get(key).arrayBuffer())).width).toBe(256);
    expect(Number(env.MAP_DATA.objects.get(key).customMetadata.tileVersion)).toBeGreaterThan(99);
    expect(env.MAP_DATA.objects.get(key).customMetadata.sourceVersion).toBe("10");
    const meta = await env.MAP_DATA.objects.get("meta/v1/world/Overworld.json").json();
    expect(meta.updatedAt).toBe(Number(env.MAP_DATA.objects.get(key).customMetadata.tileVersion));
  });

  it("does not read existing image tiles during force backfill", async () => {
    const env = createEnv();
    const key = "map-tiles/v1/world/Overworld/z3/0/0.png";
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ updatedAt: 10 })), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.MAP_DATA.put(key, new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
      customMetadata: { tileVersion: "99" },
    });
    env.MAP_DATA.getCalls = [];

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false, force: true });

    expect(await response.json()).toMatchObject({ ok: true, force: true, written: 1 });
    expect(env.MAP_DATA.getCalls).not.toContain(key);
  });

  it("deletes empty low zoom image tiles during rebuild", async () => {
    const env = createEnv();
    await env.MAP_DATA.put("map-tiles/v1/world/Overworld/z3/0/0.png", new Uint8Array([1, 2, 3]), {
      httpMetadata: { contentType: "image/png" },
    });

    const response = await backfillMapTileSourceChain(env, { world: "world", dimension: "Overworld", zoom: 3, minChunkX: 0, maxChunkX: 0, minChunkZ: 0, maxChunkZ: 0, dryRun: false });

    expect(await response.json()).toMatchObject({ ok: true, tiles: [expect.objectContaining({ deleted: true })] });
    expect(env.MAP_DATA.objects.has("map-tiles/v1/world/Overworld/z3/0/0.png")).toBe(false);
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

  it("adds real chunk samples to world metadata for sparse imports", async () => {
    const env = createEnv();
    await env.MAP_DATA.put(
      "meta/v1/world/Overworld.json",
      JSON.stringify(
        normalizeWorldMeta({
          world: "world",
          dimension: "Overworld",
          status: "live",
          chunkCount: 3,
          bounds: { minChunkX: -42, maxChunkX: 0, minChunkZ: -38, maxChunkZ: 0 },
          topBlocks: { "minecraft:grass_block": 256 },
          importedAt: 10,
          updatedAt: 10,
        }),
      ),
      { httpMetadata: { contentType: "application/json" } },
    );
    await env.MAP_DATA.put(
      chunkRegionKey("world", "Overworld", -2, -2),
      JSON.stringify({
        version: 1,
        world: "world",
        dimension: "Overworld",
        regionSize: 16,
        regionX: -2,
        regionZ: -2,
        chunks: [createChunk({ chunkX: -23, chunkZ: -21 })],
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    await env.MAP_DATA.put("chunks/v1/world/Overworld/0/0.json", JSON.stringify(createChunk({ chunkX: 0, chunkZ: 0 })), {
      httpMetadata: { contentType: "application/json" },
    });

    const worlds = await worker.fetch(new Request("https://map.buhe.li/api/worlds"), env, {});
    expect(await worlds.json()).toMatchObject({
      worlds: [
        {
          world: "world",
          sampleChunks: expect.arrayContaining([
            { chunkX: -23, chunkZ: -21 },
            { chunkX: 0, chunkZ: 0 },
          ]),
        },
      ],
    });
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
