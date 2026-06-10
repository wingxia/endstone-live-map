import { describe, expect, it } from "vitest";

import { chunkUrl, landsUrl, mapImageTileUrl, segmentKey, textureAtlasUrl, type BlockUpdate, type ChunkSnapshot, type WorldMeta } from "../src/api";
import { blockColumnIndex, blockToChunk, leafletToMinecraft, minecraftToLeaflet } from "../src/ui/coords";
import {
  blockFacingEdgeForState,
  chunkFetchRanges,
  chunkRangeForTile,
  fallbackTextureColor,
  isImageTileZoom,
  lowZoomTileCoverage,
  slabHalfForState,
  tileIntersectsChunkBounds,
  usesMapTint,
  usesTransparentTextureUnderlay,
} from "../src/ui/chunkLayer";
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

  it("builds low zoom map image tile urls", () => {
    expect(mapImageTileUrl("Bedrock level", "Overworld", 3, -1, 2)).toBe("/api/map-tiles/Bedrock_level/Overworld/z3/-1/2.png");
    expect(mapImageTileUrl("Bedrock level", "Overworld", -1, 0, -1)).toBe("/api/map-tiles/Bedrock_level/Overworld/z-1/0/-1.png");
    expect(mapImageTileUrl("Bedrock level", "Overworld", 0, 0, 0, 123)).toBe("/api/map-tiles/Bedrock_level/Overworld/z0/0/0.png?_=123");
  });

  it("uses manifest atlas paths and deterministic fallback colors", () => {
    expect(textureAtlasUrl({ version: 1, tileSize: 16, atlas: "/textures/atlas.png", blocks: {} })).toBe("/textures/atlas.png");
    expect(fallbackTextureColor("minecraft:water")).toBe("#2563b8");
    expect(usesMapTint("minecraft:water")).toBe(true);
    expect(fallbackTextureColor("minecraft:grass_block")).toBe("#5f9f3f");
    expect(usesMapTint("minecraft:grass_block")).toBe(true);
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
    expect(isMapDecorationBlock("minecraft:unpowered_repeater")).toBe(true);
    expect(isMapDecorationBlock("minecraft:powered_comparator")).toBe(true);
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
    expect(lowZoomTileCoverage({ x: -1, y: 0, z: 0 })).toEqual({
      minChunkX: -16,
      maxChunkX: -1,
      minChunkZ: 0,
      maxChunkZ: 15,
    });
    expect(lowZoomTileCoverage({ x: 0, y: -1, z: -1 })).toEqual({
      minChunkX: 0,
      maxChunkX: 31,
      minChunkZ: -32,
      maxChunkZ: -1,
    });
    expect(isImageTileZoom(-1)).toBe(true);
    expect(lowZoomTileCoverage({ x: 0, y: 0, z: 3 })).toEqual({
      minChunkX: 0,
      maxChunkX: 1,
      minChunkZ: 0,
      maxChunkZ: 1,
    });
    expect(isImageTileZoom(0)).toBe(true);
    expect(isImageTileZoom(3)).toBe(true);
    expect(isImageTileZoom(4)).toBe(false);
    expect(
      tileIntersectsChunkBounds(
        { x: -1, y: 0, z: 0 },
        { minChunkX: -8, maxChunkX: 8, minChunkZ: -8, maxChunkZ: 8 },
      ),
    ).toBe(true);
    expect(
      tileIntersectsChunkBounds(
        { x: -3, y: -4, z: 0 },
        { minChunkX: -37, maxChunkX: 0, minChunkZ: -51, maxChunkZ: 0 },
      ),
    ).toBe(true);
    expect(
      tileIntersectsChunkBounds(
        { x: 4, y: 4, z: 0 },
        { minChunkX: -37, maxChunkX: 0, minChunkZ: -51, maxChunkZ: 0 },
      ),
    ).toBe(false);
  });

  it("coalesces low-zoom chunk fetches without exceeding the worker limit", () => {
    const chunks = Array.from({ length: 16 * 16 }, (_, index) => ({
      chunkX: index % 16,
      chunkZ: Math.floor(index / 16),
    }));

    expect(chunkFetchRanges(chunks)).toEqual([{ minChunkX: 0, maxChunkX: 15, minChunkZ: 0, maxChunkZ: 15 }]);
  });

  it("splits coalesced chunk fetches at the worker range limit", () => {
    const chunks = Array.from({ length: 16 * 17 }, (_, index) => ({
      chunkX: index % 16,
      chunkZ: Math.floor(index / 16),
    }));

    expect(chunkFetchRanges(chunks)).toEqual([
      { minChunkX: 0, maxChunkX: 15, minChunkZ: 0, maxChunkZ: 15 },
      { minChunkX: 0, maxChunkX: 15, minChunkZ: 16, maxChunkZ: 16 },
    ]);
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

  it("maps Bedrock partial-block direction states to map edges", () => {
    expect(blockFacingEdgeForState({ direction: 0 })).toBe("south");
    expect(blockFacingEdgeForState({ direction: 1 })).toBe("west");
    expect(blockFacingEdgeForState({ direction: 2 })).toBe("north");
    expect(blockFacingEdgeForState({ direction: 3 })).toBe("east");
    expect(blockFacingEdgeForState({ direction: 0 }, "minecraft:oak_trapdoor")).toBe("west");
    expect(blockFacingEdgeForState({ direction: 1 }, "minecraft:oak_trapdoor")).toBe("east");
    expect(blockFacingEdgeForState({ direction: 2 }, "minecraft:oak_trapdoor")).toBe("north");
    expect(blockFacingEdgeForState({ direction: 3 }, "minecraft:oak_trapdoor")).toBe("south");
    expect(blockFacingEdgeForState({ weirdo_direction: 0 }, "minecraft:oak_stairs")).toBe("east");
    expect(blockFacingEdgeForState({ weirdo_direction: 1 }, "minecraft:oak_stairs")).toBe("west");
    expect(blockFacingEdgeForState({ weirdo_direction: 2 }, "minecraft:oak_stairs")).toBe("south");
    expect(blockFacingEdgeForState({ weirdo_direction: 3 }, "minecraft:oak_stairs")).toBe("north");
    expect(blockFacingEdgeForState({ facing_direction: 2 })).toBe("north");
    expect(blockFacingEdgeForState({ facing_direction: 3 })).toBe("south");
    expect(blockFacingEdgeForState({ facing_direction: 4 })).toBe("west");
    expect(blockFacingEdgeForState({ facing_direction: 5 })).toBe("east");
    expect(blockFacingEdgeForState({ facing: "north" })).toBe("north");
    expect(blockFacingEdgeForState({ facing: "3" })).toBe("east");
  });

  it("maps slab and trapdoor vertical-half states for fallback rendering", () => {
    expect(slabHalfForState({ top_slot_bit: true }, "minecraft:oak_slab")).toBe("top");
    expect(slabHalfForState({ upside_down_bit: true }, "minecraft:oak_slab")).toBe("top");
    expect(slabHalfForState({ "minecraft:vertical_half": "bottom" }, "minecraft:oak_slab")).toBe("bottom");
    expect(slabHalfForState({ stone_slab_type: "double" }, "minecraft:stone_slab")).toBe("double");
    expect(slabHalfForState({}, "minecraft:double_stone_slab")).toBe("double");
  });
});
