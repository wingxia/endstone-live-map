import { describe, expect, it } from "vitest";

import { landsUrl, mapImageTileUrl, playerAvatarUrl, segmentKey, type WorldMeta } from "../src/api";
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
  it("builds land and image tile urls for the local server", () => {
    expect(landsUrl("Bedrock level", "Overworld", 123)).toBe("/api/lands?world=Bedrock+level&dimension=Overworld&_=123");
    expect(mapImageTileUrl("Bedrock level", "Overworld", 4, -1, 2)).toBe("/api/map-tiles/Bedrock_level/Overworld/z4/-1/2.png");
    expect(mapImageTileUrl("Bedrock level", "Overworld", -1, 0, -1)).toBe("/api/map-tiles/Bedrock_level/Overworld/z-1/0/-1.png");
    expect(mapImageTileUrl("Bedrock level", "Overworld", 0, 0, 0, 123)).toBe("/api/map-tiles/Bedrock_level/Overworld/z0/0/0.png?_=123");
    expect(playerAvatarUrl({ id: "uuid/one", avatarHash: "abc123" })).toBe("/api/players/uuid%2Fone/avatar.png?_=abc123");
    expect(playerAvatarUrl({ id: "uuid/one", avatarHash: "abc123", avatarUrl: "/custom/avatar.png" })).toBe("/custom/avatar.png");
    expect(segmentKey("Bedrock level")).toBe("Bedrock_level");
  });

  it("keeps fallback map color helpers deterministic for plugin-rendered tiles", () => {
    expect(fallbackTextureColor("minecraft:water")).toBe("#2563b8");
    expect(usesMapTint("minecraft:water")).toBe(true);
    expect(fallbackTextureColor("minecraft:grass_block")).toBe("#5f9f3f");
    expect(usesMapTint("minecraft:grass_block")).toBe(true);
    expect(fallbackTextureColor("minecraft:spruce_stairs")).toBe("#6f4c2d");
    expect(fallbackTextureColor("minecraft:oak_slab")).toBe("#9f7442");
    expect(fallbackTextureColor("minecraft:waxed_oxidized_cut_copper_slab")).toBe("#5b9a8f");
    expect(fallbackTextureColor("minecraft:wooden_slab", { "minecraft:wood_type": "spruce" })).toBe("#6f4c2d");
    expect(usesMapTint("minecraft:oak_leaves")).toBe(false);
    expect(usesTransparentTextureUnderlay("minecraft:acacia_leaves")).toBe(true);
    expect(usesTransparentTextureUnderlay("minecraft:glass")).toBe(true);
    expect(usesTransparentTextureUnderlay("minecraft:stone")).toBe(false);
    expect(isPlantBlock("minecraft:poppy")).toBe(true);
    expect(isPlantBlock("minecraft:grass_block")).toBe(false);
    expect(isMapDecorationBlock("minecraft:oak_trapdoor")).toBe(true);
    expect(isMapDecorationBlock("minecraft:powered_comparator")).toBe(true);
    expect(isMapDecorationBlock("minecraft:stone")).toBe(false);
  });

  it("models imported world bounds for map fitting", () => {
    const meta: WorldMeta = {
      version: 2,
      world: "Bedrock level",
      dimension: "Overworld",
      status: "live",
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
      topBlocks: {},
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
    expect(isImageTileZoom(4)).toBe(true);
    expect(
      tileIntersectsChunkBounds(
        { x: -1, y: 0, z: 0 },
        { minChunkX: -8, maxChunkX: 8, minChunkZ: -8, maxChunkZ: 8 },
      ),
    ).toBe(true);
    expect(
      tileIntersectsChunkBounds(
        { x: 4, y: 4, z: 0 },
        { minChunkX: -37, maxChunkX: 0, minChunkZ: -51, maxChunkZ: 0 },
      ),
    ).toBe(false);
  });

  it("refreshes exact chunk tiles without coalescing old Worker chunk fetches", () => {
    const chunks = [
      { chunkX: -1, chunkZ: 2 },
      { chunkX: 0, chunkZ: 2 },
    ];
    expect(chunkFetchRanges(chunks)).toEqual([
      { minChunkX: -1, maxChunkX: -1, minChunkZ: 2, maxChunkZ: 2 },
      { minChunkX: 0, maxChunkX: 0, minChunkZ: 2, maxChunkZ: 2 },
    ]);
  });

  it("keeps block and map coordinate helpers stable", () => {
    expect(blockToChunk(-1, -17)).toEqual({ chunkX: -1, chunkZ: -2, localX: 15, localZ: 15 });
    expect(blockToChunk(16, 0)).toEqual({ chunkX: 1, chunkZ: 0, localX: 0, localZ: 0 });
    expect(blockColumnIndex(0, 0)).toBe(0);
    expect(blockColumnIndex(15, 15)).toBe(255);

    const [lat, lng] = minecraftToLeaflet(-32, 48);
    expect(leafletToMinecraft(lat, lng)).toEqual({ x: -32, z: 48 });
    expect(slabHalfForState({ "minecraft:vertical_half": "top" })).toBe("top");
    expect(blockFacingEdgeForState({ facing_direction: 1 })).toBe("west");
    expect(blockFacingEdgeForState({ cardinal_direction: "east" })).toBe("east");
  });
});
