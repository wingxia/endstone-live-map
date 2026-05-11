import { describe, expect, it } from "vitest";

import { buildChunkSnapshot, mergeWorldMeta, offsetToSubchunkIndex, summarizeSnapshots } from "../chunkSnapshot.js";

function layerWithBlocks(entries) {
  const block_indices = Array.from({ length: 4096 }, () => 0);
  const palette = {
    0: block("minecraft:air"),
    1: block("minecraft:stone"),
    2: block("minecraft:grass_block"),
    3: block("minecraft:water"),
  };
  for (const entry of entries) {
    block_indices[offsetToSubchunkIndex(entry.x, entry.y, entry.z)] = entry.paletteIndex;
  }
  return {
    block_indices: { value: { value: block_indices } },
    palette: { value: palette },
  };
}

function block(name) {
  return { value: { name: { value: name } } };
}

describe("chunk snapshot importer helpers", () => {
  it("uses Bedrock subchunk x/y/z index ordering", () => {
    expect(offsetToSubchunkIndex(1, 2, 3)).toBe(0x132);
  });

  it("selects the highest non-air top block per x/z column", () => {
    const snapshot = buildChunkSnapshot({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: -1,
      chunkZ: 2,
      subchunks: [
        { y: -4, layers: [layerWithBlocks([{ x: 1, y: 15, z: 1, paletteIndex: 1 }])] },
        { y: 0, layers: [layerWithBlocks([{ x: 1, y: 2, z: 1, paletteIndex: 2 }])] },
        { y: 1, layers: [layerWithBlocks([{ x: 2, y: 1, z: 2, paletteIndex: 3 }])] },
      ],
      updatedAt: 100,
    });

    expect(snapshot).toMatchObject({ world: "Bedrock level", dimension: "Overworld", chunkX: -1, chunkZ: 2 });
    expect(snapshot.palette).toContain("minecraft:grass_block");
    expect(snapshot.palette).toContain("minecraft:water");
    expect(snapshot.heights[1 * 16 + 1]).toBe(2);
    expect(snapshot.palette[snapshot.blocks[1 * 16 + 1]]).toBe("minecraft:grass_block");
    expect(snapshot.heights[2 * 16 + 2]).toBe(17);
    expect(snapshot.palette[snapshot.blocks[2 * 16 + 2]]).toBe("minecraft:water");
  });

  it("summarizes and merges world metadata", () => {
    const a = {
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: -1,
      chunkZ: 0,
      palette: ["minecraft:air", "minecraft:stone"],
      blocks: Array.from({ length: 256 }, () => 1),
      heights: Array.from({ length: 256 }, () => 64),
      updatedAt: 1,
    };
    const b = { ...a, chunkX: 2, chunkZ: 3 };
    const left = summarizeSnapshots([a], { world: "Bedrock level", dimension: "Overworld", importedAt: 1 });
    const right = summarizeSnapshots([b], { world: "Bedrock level", dimension: "Overworld", importedAt: 2 });
    expect(mergeWorldMeta(left, right)).toMatchObject({
      chunkCount: 2,
      bounds: { minChunkX: -1, maxChunkX: 2, minChunkZ: 0, maxChunkZ: 3 },
      topBlocks: { "minecraft:stone": 512 },
    });
  });
});
