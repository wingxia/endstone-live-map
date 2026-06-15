import { describe, expect, it } from "vitest";

import worker, { mapTileKey, normalizeCleanupPayload, parseMapTilePath } from "../src/index.js";

class MockR2Object {
  constructor(body, contentType = "image/png") {
    this.body = body;
    this.contentType = contentType;
  }

  writeHttpMetadata(headers) {
    headers.set("Content-Type", this.contentType);
  }

  async arrayBuffer() {
    const buffer = Buffer.from(this.body);
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
}

class MockR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async get(key) {
    return this.objects.get(key) || null;
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list(options = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix || "")).sort();
    return { objects: keys.slice(0, options.limit || keys.length).map((key) => ({ key })), truncated: false };
  }
}

function env() {
  return { PLUGIN_TOKEN: "secret", MAP_DATA: new MockR2Bucket() };
}

describe("edge worker", () => {
  it("builds v2 map tile keys", () => {
    expect(mapTileKey("Bedrock level", "Overworld", 4, -1, 2)).toBe("map-tiles/v2/Bedrock_level/Overworld/z4/-1/2.png");
    expect(parseMapTilePath("/api/map-tiles/Bedrock_level/Overworld/z-1/0/-2.png")).toEqual({
      world: "Bedrock_level",
      dimension: "Overworld",
      zoom: -1,
      tileX: 0,
      tileZ: -2,
    });
  });

  it("serves existing R2 tiles and transparent placeholders for missing tiles", async () => {
    const testEnv = env();
    const key = mapTileKey("Bedrock level", "Overworld", 4, 0, 0);
    testEnv.MAP_DATA.objects.set(key, new MockR2Object(Buffer.from([1, 2, 3])));

    const existing = await worker.fetch(new Request("https://map.example/api/map-tiles/Bedrock_level/Overworld/z4/0/0.png"), testEnv);
    expect(existing.status).toBe(200);
    expect(new Uint8Array(await existing.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const missing = await worker.fetch(new Request("https://map.example/api/map-tiles/Bedrock_level/Overworld/z4/9/9.png"), testEnv);
    expect(missing.status).toBe(200);
    expect(missing.headers.get("Content-Type")).toBe("image/png");
  });

  it("keeps cleanup scoped and protects lands", async () => {
    expect(() => normalizeCleanupPayload({ prefix: "lands/v1/" })).toThrow();
    expect(() => normalizeCleanupPayload({ prefix: "map-tiles/v2/" })).toThrow();
    expect(normalizeCleanupPayload({ prefix: "map-tiles/v1/" })).toMatchObject({ dryRun: true, prefix: "map-tiles/v1/" });
  });

  it("requires confirmation before destructive cleanup", async () => {
    const testEnv = env();
    const response = await worker.fetch(
      new Request("https://map.example/api/plugin/map-data/cleanup", {
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: "map-tiles/v1/", dryRun: false }),
      }),
      testEnv,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "cleanup_confirmation_required", confirm: "delete-map-data-v2" });
  });
});
