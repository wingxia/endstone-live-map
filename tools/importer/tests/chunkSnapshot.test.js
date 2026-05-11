import { describe, expect, it } from "vitest";

import { buildChunkSnapshot, mergeWorldMeta, normalizeDimension, offsetToSubchunkIndex, summarizeSnapshots } from "../chunkSnapshot.js";
import { readSubchunkGroups } from "../import-bedrock-world.mjs";

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
