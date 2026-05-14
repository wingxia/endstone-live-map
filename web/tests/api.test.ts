import { describe, expect, it } from "vitest";

import { chunkUrl, landsUrl, segmentKey, textureAtlasUrl, type BlockUpdate, type ChunkSnapshot, type WorldMeta } from "../src/api";
import { blockColumnIndex, blockToChunk, leafletToMinecraft, minecraftToLeaflet } from "../src/ui/coords";
import { chunkRangeForTile, fallbackTextureColor, usesMapTint, usesTransparentTextureUnderlay } from "../src/ui/chunkLayer";
import { isMapDecorationBlock, isPlantBlock } from "../src/ui/mapBlocks";

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

  it("builds land query urls for the selected dimension", () => {
    expect(landsUrl("Bedrock level", "Overworld", 123)).toBe("/api/lands?world=Bedrock+level&dimension=Overworld&_=123");
  });

  it("uses manifest atlas paths and deterministic fallback colors", () => {
    expect(textureAtlasUrl({ version: 1, tileSize: 16, atlas: "/textures/atlas.png", blocks: {} })).toBe("/textures/atlas.png");
    expect(fallbackTextureColor("minecraft:water")).toBe("#2563b8");
    expect(usesMapTint("minecraft:water")).toBe(true);
    expect(fallbackTextureColor("minecraft:grass_block")).toBe("#5f9f3f");
    expect(usesMapTint("minecraft:grass_block")).toBe(true);
    expect(usesMapTint("minecraft:oak_leaves")).toBe(false);
    expect(usesMapTint("minecraft:cherry_leaves")).toBe(false);
    expect(usesMapTint("minecraft:acacia_leaves")).toBe(false);
    expect(usesTransparentTextureUnderlay("minecraft:acacia_leaves")).toBe(true);
    expect(usesTransparentTextureUnderlay("minecraft:oak_leaves")).toBe(true);
    expect(usesTransparentTextureUnderlay("minecraft:glass")).toBe(true);
    expect(usesTransparentTextureUnderlay("minecraft:ice")).toBe(true);
    expect(usesTransparentTextureUnderlay("minecraft:copper_grate")).toBe(true);
    expect(usesTransparentTextureUnderlay("minecraft:stone")).toBe(false);
    expect(usesMapTint("minecraft:stone")).toBe(false);
    expect(isPlantBlock("minecraft:poppy")).toBe(true);
    expect(isPlantBlock("minecraft:bush")).toBe(true);
    expect(isPlantBlock("minecraft:grass_block")).toBe(false);
    expect(isPlantBlock("minecraft:grass_path")).toBe(false);
    expect(isPlantBlock("minecraft:dirt_with_roots")).toBe(false);
    expect(isMapDecorationBlock("minecraft:glass_pane")).toBe(true);
    expect(isMapDecorationBlock("minecraft:oak_trapdoor")).toBe(true);
    expect(isMapDecorationBlock("minecraft:cake")).toBe(true);
    expect(isMapDecorationBlock("minecraft:end_rod")).toBe(true);
    expect(isMapDecorationBlock("minecraft:lantern")).toBe(true);
    expect(isMapDecorationBlock("minecraft:soul_lantern")).toBe(true);
    expect(isMapDecorationBlock("minecraft:sea_lantern")).toBe(false);
    expect(isMapDecorationBlock("minecraft:jack_o_lantern")).toBe(false);
    expect(isMapDecorationBlock("minecraft:tube_coral")).toBe(true);
    expect(isMapDecorationBlock("minecraft:tube_coral_fan")).toBe(true);
    expect(isMapDecorationBlock("minecraft:tube_coral_block")).toBe(false);
    expect(isMapDecorationBlock("minecraft:dead_tube_coral_block")).toBe(false);
    expect(isMapDecorationBlock("minecraft:horn_coral")).toBe(true);
    expect(isMapDecorationBlock("minecraft:sea_pickle")).toBe(true);
    expect(isMapDecorationBlock("minecraft:bush")).toBe(true);
    expect(isMapDecorationBlock("minecraft:leaf_litter")).toBe(true);
    expect(isMapDecorationBlock("minecraft:cherry_leaves")).toBe(false);
    expect(isMapDecorationBlock("minecraft:acacia_leaves")).toBe(false);
    expect(isMapDecorationBlock("minecraft:stone")).toBe(false);
    expect(isMapDecorationBlock("minecraft:glass")).toBe(false);
    expect(segmentKey("Bedrock level")).toBe("Bedrock_level");
  });

  it("accepts optional block state fields on chunks and updates", () => {
    const chunk: ChunkSnapshot = {
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      palette: ["minecraft:cake", "minecraft:air"],
      blocks: Array.from({ length: 256 }, () => 0),
      heights: Array.from({ length: 256 }, () => 64),
      blockStates: Array.from({ length: 256 }, () => ({})),
      overlayBlocks: Array.from({ length: 256 }, () => 1),
      overlayHeights: Array.from({ length: 256 }, () => -64),
      overlayStates: Array.from({ length: 256 }, () => ({})),
      updatedAt: 1,
    };
    chunk.blockStates![0] = { bite_counter: 3 };
    expect(chunk.blockStates![0]).toEqual({ bite_counter: 3 });

    const update: BlockUpdate = {
      localX: 0,
      localZ: 0,
      block: "minecraft:oak_trapdoor",
      height: 64,
      state: { direction: 1, open_bit: true },
      overlayBlock: "minecraft:end_rod",
      overlayHeight: 65,
      overlayState: { facing_direction: 0 },
    };
    expect(update.state?.open_bit).toBe(true);
    expect(update.overlayState?.facing_direction).toBe(0);
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
    expect(chunkRangeForTile({ x: -21, y: -34, z: 4 })).toMatchObject({
      minBlockX: -336,
      maxBlockX: -321,
      minBlockZ: -544,
      maxBlockZ: -529,
      minChunkX: -21,
      maxChunkX: -21,
      minChunkZ: -34,
      maxChunkZ: -34,
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
