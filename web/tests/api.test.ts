import { describe, expect, it } from "vitest";

import { chunkUrl, segmentKey, textureAtlasUrl, type WorldMeta } from "../src/api";
import { blockColumnIndex, blockToChunk, leafletToMinecraft, minecraftToLeaflet } from "../src/ui/coords";
import { chunkRangeForTile, fallbackTextureColor, usesMapTint } from "../src/ui/chunkLayer";

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
    expect(usesMapTint("minecraft:water")).toBe(true);
    expect(usesMapTint("minecraft:stone")).toBe(false);
    expect(segmentKey("Bedrock level")).toBe("Bedrock_level");
  });

  it("models imported world bounds for map fitting", () => {
    const meta: WorldMeta = {
      version: 1,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "complete",
      chunkCount: 2,
      importedAt: 1,
      updatedAt: 1,
      bounds: {
        minChunkX: -1,
        maxChunkX: 1,
        minChunkZ: -2,
        maxChunkZ: 2,
        minBlockX: -16,
        maxBlockX: 31,
        minBlockZ: -32,
        maxBlockZ: 47,
      },
      topBlocks: { "minecraft:grass_block": 20 },
    };
    expect(meta.bounds.maxBlockX - meta.bounds.minBlockX + 1).toBe(48);
  });

  it("converts Leaflet tile coordinates into zoom-aware chunk ranges", () => {
    expect(chunkRangeForTile({ x: 0, y: 0, z: 4 })).toMatchObject({
      minBlockX: 0,
      maxBlockX: 15,
      minBlockZ: -15,
      maxBlockZ: 0,
      minChunkX: 0,
      maxChunkX: 0,
      minChunkZ: -1,
      maxChunkZ: 0,
      scale: 16,
    });
    expect(chunkRangeForTile({ x: -1, y: -1, z: 4 })).toMatchObject({
      minBlockX: -16,
      maxBlockX: -1,
      minBlockZ: 1,
      maxBlockZ: 16,
      minChunkX: -1,
      maxChunkX: -1,
      minChunkZ: 0,
      maxChunkZ: 1,
    });
    expect(chunkRangeForTile({ x: 0, y: 0, z: 0 })).toMatchObject({
      minChunkX: 0,
      maxChunkX: 15,
      minChunkZ: -16,
      maxChunkZ: 0,
      scale: 1,
    });
  });

  it("converts Minecraft coordinates to the Leaflet CRS without flipping X", () => {
    expect(minecraftToLeaflet(12, -34)).toEqual([34, 12]);
    expect(leafletToMinecraft(34.8, 12.2)).toEqual({ x: 12, z: -35 });
  });

  it("maps block coordinates to chunk and local coordinates", () => {
    expect(blockToChunk(0, 0)).toEqual({ chunkX: 0, chunkZ: 0, localX: 0, localZ: 0 });
    expect(blockToChunk(-1, -17)).toEqual({ chunkX: -1, chunkZ: -2, localX: 15, localZ: 15 });
    expect(blockColumnIndex(15, 2)).toBe(47);
  });
});
