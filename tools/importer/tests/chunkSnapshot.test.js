import { describe, expect, it } from "vitest";

import { buildChunkSnapshot, chunkColumnIndex, mergeWorldMeta, normalizeDimension, offsetToSubchunkIndex, summarizeSnapshots } from "../chunkSnapshot.js";
import { readSubchunkGroups } from "../import-bedrock-world.mjs";

function layerWithBlocks(entries) {
  const block_indices = Array.from({ length: 4096 }, () => 0);
  const palette = {
    0: block("minecraft:air"),
    1: block("minecraft:stone"),
    2: block("minecraft:grass_block"),
    3: block("minecraft:water"),
    4: block("minecraft:poppy"),
    5: block("minecraft:glass_pane"),
    6: block("minecraft:glass"),
    7: block("minecraft:grass_path"),
    8: block("minecraft:lantern"),
    9: block("minecraft:tube_coral_fan"),
    10: block("minecraft:tube_coral_block"),
    11: block("minecraft:bush"),
    12: block("minecraft:leaf_litter"),
    13: block("minecraft:horn_coral"),
    14: block("minecraft:sea_pickle"),
    15: block("minecraft:cherry_leaves"),
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

  it("matches mcbe-leveldb Bedrock subchunk index helpers for every local block", async () => {
    const { offsetToChunkBlockIndex } = await import("mcbe-leveldb");
    for (let localX = 0; localX < 16; localX += 1) {
      for (let localY = 0; localY < 16; localY += 1) {
        for (let localZ = 0; localZ < 16; localZ += 1) {
          expect(offsetToSubchunkIndex(localX, localY, localZ)).toBe(offsetToChunkBlockIndex({ x: localX, y: localY, z: localZ }));
        }
      }
    }
  });

  it("stores chunk snapshot columns as localZ * 16 + localX", () => {
    const entries = [
      { x: 0, y: 1, z: 0, paletteIndex: 1 },
      { x: 15, y: 2, z: 0, paletteIndex: 2 },
      { x: 0, y: 3, z: 15, paletteIndex: 3 },
    ];
    const snapshot = buildChunkSnapshot({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      subchunks: [{ y: 0, layers: [layerWithBlocks(entries)] }],
      updatedAt: 100,
    });

    expect(snapshot.palette[snapshot.blocks[chunkColumnIndex(0, 0)]]).toBe("minecraft:stone");
    expect(snapshot.palette[snapshot.blocks[chunkColumnIndex(15, 0)]]).toBe("minecraft:grass_block");
    expect(snapshot.palette[snapshot.blocks[chunkColumnIndex(0, 15)]]).toBe("minecraft:water");
    expect(snapshot.heights[chunkColumnIndex(0, 15)]).toBe(3);
  });

  it("treats missing Bedrock dimension fields as Overworld", () => {
    expect(normalizeDimension(undefined)).toBe("Overworld");
    expect(normalizeDimension("")).toBe("Overworld");
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

  it("skips plant and cutout decoration blocks when choosing the map surface", () => {
    const snapshot = buildChunkSnapshot({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      subchunks: [
        {
          y: 0,
          layers: [
            layerWithBlocks([
              { x: 1, y: 4, z: 1, paletteIndex: 4 },
              { x: 1, y: 3, z: 1, paletteIndex: 2 },
              { x: 2, y: 5, z: 2, paletteIndex: 5 },
              { x: 2, y: 2, z: 2, paletteIndex: 1 },
              { x: 3, y: 6, z: 3, paletteIndex: 6 },
              { x: 3, y: 1, z: 3, paletteIndex: 1 },
              { x: 4, y: 6, z: 4, paletteIndex: 7 },
              { x: 4, y: 1, z: 4, paletteIndex: 1 },
            ]),
          ],
        },
      ],
      updatedAt: 100,
    });

    expect(snapshot.palette[snapshot.blocks[1 * 16 + 1]]).toBe("minecraft:grass_block");
    expect(snapshot.heights[1 * 16 + 1]).toBe(3);
    expect(snapshot.palette[snapshot.overlayBlocks[1 * 16 + 1]]).toBe("minecraft:poppy");
    expect(snapshot.overlayHeights[1 * 16 + 1]).toBe(4);
    expect(snapshot.palette[snapshot.blocks[2 * 16 + 2]]).toBe("minecraft:stone");
    expect(snapshot.heights[2 * 16 + 2]).toBe(2);
    expect(snapshot.palette[snapshot.overlayBlocks[2 * 16 + 2]]).toBe("minecraft:glass_pane");
    expect(snapshot.overlayHeights[2 * 16 + 2]).toBe(5);
    expect(snapshot.palette[snapshot.blocks[3 * 16 + 3]]).toBe("minecraft:glass");
    expect(snapshot.heights[3 * 16 + 3]).toBe(6);
    expect(snapshot.palette[snapshot.overlayBlocks[3 * 16 + 3]]).toBe("minecraft:air");
    expect(snapshot.overlayHeights[3 * 16 + 3]).toBe(-64);
    expect(snapshot.palette[snapshot.blocks[4 * 16 + 4]]).toBe("minecraft:grass_path");
    expect(snapshot.heights[4 * 16 + 4]).toBe(6);
  });

  it("keeps small and flat decoration blocks as overlays above the supporting surface", () => {
    const snapshot = buildChunkSnapshot({
      world: "Bedrock level",
      dimension: "Overworld",
      chunkX: 0,
      chunkZ: 0,
      subchunks: [
        {
          y: 0,
          layers: [
            layerWithBlocks([
              { x: 1, y: 5, z: 1, paletteIndex: 8 },
              { x: 1, y: 4, z: 1, paletteIndex: 2 },
              { x: 2, y: 6, z: 2, paletteIndex: 9 },
              { x: 2, y: 3, z: 2, paletteIndex: 1 },
              { x: 3, y: 7, z: 3, paletteIndex: 10 },
              { x: 3, y: 2, z: 3, paletteIndex: 1 },
              { x: 4, y: 8, z: 4, paletteIndex: 11 },
              { x: 4, y: 4, z: 4, paletteIndex: 2 },
              { x: 5, y: 9, z: 5, paletteIndex: 12 },
              { x: 5, y: 4, z: 5, paletteIndex: 1 },
              { x: 6, y: 10, z: 6, paletteIndex: 13 },
              { x: 6, y: 4, z: 6, paletteIndex: 1 },
              { x: 7, y: 11, z: 7, paletteIndex: 14 },
              { x: 7, y: 4, z: 7, paletteIndex: 2 },
              { x: 8, y: 12, z: 8, paletteIndex: 15 },
              { x: 8, y: 4, z: 8, paletteIndex: 2 },
            ]),
          ],
        },
      ],
      updatedAt: 100,
    });

    expect(snapshot.palette[snapshot.blocks[1 * 16 + 1]]).toBe("minecraft:grass_block");
    expect(snapshot.heights[1 * 16 + 1]).toBe(4);
    expect(snapshot.palette[snapshot.overlayBlocks[1 * 16 + 1]]).toBe("minecraft:lantern");
    expect(snapshot.overlayHeights[1 * 16 + 1]).toBe(5);
    expect(snapshot.palette[snapshot.blocks[2 * 16 + 2]]).toBe("minecraft:stone");
    expect(snapshot.heights[2 * 16 + 2]).toBe(3);
    expect(snapshot.palette[snapshot.overlayBlocks[2 * 16 + 2]]).toBe("minecraft:tube_coral_fan");
    expect(snapshot.overlayHeights[2 * 16 + 2]).toBe(6);
    expect(snapshot.palette[snapshot.blocks[3 * 16 + 3]]).toBe("minecraft:tube_coral_block");
    expect(snapshot.heights[3 * 16 + 3]).toBe(7);
    expect(snapshot.palette[snapshot.overlayBlocks[3 * 16 + 3]]).toBe("minecraft:air");
    expect(snapshot.palette[snapshot.blocks[4 * 16 + 4]]).toBe("minecraft:grass_block");
    expect(snapshot.heights[4 * 16 + 4]).toBe(4);
    expect(snapshot.palette[snapshot.overlayBlocks[4 * 16 + 4]]).toBe("minecraft:bush");
    expect(snapshot.overlayHeights[4 * 16 + 4]).toBe(8);
    expect(snapshot.palette[snapshot.blocks[5 * 16 + 5]]).toBe("minecraft:stone");
    expect(snapshot.heights[5 * 16 + 5]).toBe(4);
    expect(snapshot.palette[snapshot.overlayBlocks[5 * 16 + 5]]).toBe("minecraft:leaf_litter");
    expect(snapshot.overlayHeights[5 * 16 + 5]).toBe(9);
    expect(snapshot.palette[snapshot.blocks[6 * 16 + 6]]).toBe("minecraft:stone");
    expect(snapshot.heights[6 * 16 + 6]).toBe(4);
    expect(snapshot.palette[snapshot.overlayBlocks[6 * 16 + 6]]).toBe("minecraft:horn_coral");
    expect(snapshot.overlayHeights[6 * 16 + 6]).toBe(10);
    expect(snapshot.palette[snapshot.blocks[7 * 16 + 7]]).toBe("minecraft:grass_block");
    expect(snapshot.heights[7 * 16 + 7]).toBe(4);
    expect(snapshot.palette[snapshot.overlayBlocks[7 * 16 + 7]]).toBe("minecraft:sea_pickle");
    expect(snapshot.overlayHeights[7 * 16 + 7]).toBe(11);
    expect(snapshot.palette[snapshot.blocks[8 * 16 + 8]]).toBe("minecraft:cherry_leaves");
    expect(snapshot.heights[8 * 16 + 8]).toBe(12);
    expect(snapshot.palette[snapshot.overlayBlocks[8 * 16 + 8]]).toBe("minecraft:air");
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

  it("accepts LevelDB iterator entries in key/value or value/key order", async () => {
    const key = Buffer.from("subchunk-key");
    const value = Buffer.from("subchunk-value");
    const parsed = {
      value: {
        subChunkIndex: { value: 0 },
        layers: { value: { value: [layerWithBlocks([{ x: 0, y: 0, z: 0, paletteIndex: 1 }])] } },
      },
    };
    const levelUtils = {
      getContentTypeFromDBKey: (rawKey) => (rawKey === key ? "SubChunkPrefix" : "Other"),
      getChunkKeyIndices: () => ({ x: -2, z: 3, dimension: 0, subChunkIndex: 0 }),
      entryContentTypeToFormatMap: {
        SubChunkPrefix: { parse: async (rawValue) => (rawValue === value ? parsed : null) },
      },
    };

    for (const pair of [
      [key, value],
      [value, key],
    ]) {
      const db = {
        getIterator: () => {
          let used = false;
          return {
            next: async () => {
              if (used) {
                return undefined;
              }
              used = true;
              return pair;
            },
            end: async () => {},
          };
        },
      };
      const groups = await readSubchunkGroups(db, levelUtils);
      expect(groups.get("Overworld/-2/3")).toMatchObject({ chunkX: -2, chunkZ: 3, dimension: "Overworld" });
    }
  });

  it("filters LevelDB iterator groups by chunk bounds before parsing", async () => {
    const entries = [
      { key: Buffer.from("subchunk-a"), x: -2, z: 3 },
      { key: Buffer.from("subchunk-b"), x: 5, z: 3 },
      { key: Buffer.from("subchunk-c"), x: 6, z: 4 },
    ];
    const value = Buffer.from("subchunk-value");
    let parseCount = 0;
    const levelUtils = {
      getContentTypeFromDBKey: (rawKey) => (entries.some((entry) => entry.key === rawKey) ? "SubChunkPrefix" : "Other"),
      getChunkKeyIndices: (rawKey) => {
        const entry = entries.find((item) => item.key === rawKey);
        return { x: entry.x, z: entry.z, dimension: 0, subChunkIndex: 0 };
      },
      entryContentTypeToFormatMap: {
        SubChunkPrefix: {
          parse: async () => {
            parseCount += 1;
            return {
              value: {
                subChunkIndex: { value: 0 },
                layers: { value: { value: [layerWithBlocks([{ x: 0, y: 0, z: 0, paletteIndex: 1 }])] } },
              },
            };
          },
        },
      },
    };
    const db = {
      getIterator: () => {
        let index = 0;
        return {
          next: async () => {
            const entry = entries[index];
            index += 1;
            return entry ? [entry.key, value] : undefined;
          },
          end: async () => {},
        };
      },
    };

    const groups = await readSubchunkGroups(db, levelUtils, { minChunkX: 0, maxChunkX: 5, minChunkZ: 3, maxChunkZ: 3 });
    expect([...groups.keys()]).toEqual(["Overworld/5/3"]);
    expect(parseCount).toBe(1);
  });
});
