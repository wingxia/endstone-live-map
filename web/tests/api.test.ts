import { describe, expect, it } from "vitest";

import { chunkUrl, textureAtlasUrl } from "../src/api";
import { chunkRangeForTile, fallbackTextureColor } from "../src/ui/chunkLayer";

describe("api helpers", () => {
  it("builds chunk query urls for the selected viewport", () => {
    expect(
      chunkUrl({
        world: "world",
        dimension: "Overworld",
        minChunkX: -1,
        maxChunkX: 1,
        minChunkZ: 0,
        maxChunkZ: 2,
      }),
    ).toBe("/api/chunks?world=world&dimension=Overworld&minChunkX=-1&maxChunkX=1&minChunkZ=0&maxChunkZ=2");
  });

  it("uses manifest atlas paths and deterministic fallback colors", () => {
    expect(textureAtlasUrl({ version: 1, tileSize: 16, atlas: "/textures/atlas.png", blocks: {} })).toBe("/textures/atlas.png");
    expect(fallbackTextureColor("minecraft:water")).toBe("#2563b8");
  });

  it("converts Leaflet tile coordinates into zoom-aware chunk ranges", () => {
    expect(chunkRangeForTile({ x: 0, y: 0, z: 4 })).toMatchObject({
      minBlockX: 0,
      maxBlockX: 15,
      minBlockZ: 0,
      maxBlockZ: 15,
      minChunkX: 0,
      maxChunkX: 0,
      minChunkZ: 0,
      maxChunkZ: 0,
      scale: 16,
    });
    expect(chunkRangeForTile({ x: -1, y: -1, z: 4 })).toMatchObject({
      minBlockX: -16,
      maxBlockX: -1,
      minBlockZ: -16,
      maxBlockZ: -1,
      minChunkX: -1,
      maxChunkX: -1,
      minChunkZ: -1,
      maxChunkZ: -1,
    });
    expect(chunkRangeForTile({ x: 0, y: 0, z: 0 })).toMatchObject({
      minChunkX: 0,
      maxChunkX: 15,
      minChunkZ: 0,
      maxChunkZ: 15,
      scale: 1,
    });
  });
});
