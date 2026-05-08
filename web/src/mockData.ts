import type { ChunkSnapshot, Marker, PlayerState } from "./api";

export const mockPlayers: PlayerState[] = [
  {
    id: "mock-wing",
    name: "Wing",
    world: "world",
    dimension: "Overworld",
    x: 18,
    y: 72,
    z: -22,
    yaw: 120,
    pitch: 0,
    updatedAt: Date.now(),
  },
  {
    id: "mock-alex",
    name: "Alex",
    world: "world",
    dimension: "Overworld",
    x: -64,
    y: 68,
    z: 48,
    yaw: 260,
    pitch: 0,
    updatedAt: Date.now(),
  },
  {
    id: "mock-nether",
    name: "Builder",
    world: "world",
    dimension: "Nether",
    x: 112,
    y: 42,
    z: -80,
    yaw: 40,
    pitch: 0,
    updatedAt: Date.now(),
  },
];

export const mockMarkers: Marker[] = [
  {
    id: "spawn",
    world: "world",
    dimension: "Overworld",
    x: 0,
    y: 64,
    z: 0,
    title: "主城出生点",
    description: "公告牌、传送入口和公共仓库。",
    createdBy: "Wing",
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 3600000,
  },
  {
    id: "iron-farm",
    world: "world",
    dimension: "Overworld",
    x: -128,
    y: 68,
    z: 96,
    title: "铁厂",
    description: "不要移动村民和床。",
    createdBy: "Admin",
    createdAt: Date.now() - 7200000,
    updatedAt: Date.now() - 7200000,
  },
  {
    id: "nether-hub",
    world: "world",
    dimension: "Nether",
    x: 16,
    y: 58,
    z: -16,
    title: "下界交通站",
    description: "四向冰道入口。",
    createdBy: "Wing",
    createdAt: Date.now() - 6200000,
    updatedAt: Date.now() - 6200000,
  },
];

export const mockChunks: ChunkSnapshot[] = createMockChunks();

function createMockChunks(): ChunkSnapshot[] {
  const chunks: ChunkSnapshot[] = [];
  for (let chunkZ = -8; chunkZ <= 8; chunkZ += 1) {
    for (let chunkX = -8; chunkX <= 8; chunkX += 1) {
      const palette = ["minecraft:grass_block", "minecraft:water", "minecraft:sand", "minecraft:stone", "minecraft:spruce_log"];
      const blocks: number[] = [];
      const heights: number[] = [];
      for (let localZ = 0; localZ < 16; localZ += 1) {
        for (let localX = 0; localX < 16; localX += 1) {
          const x = chunkX * 16 + localX;
          const z = chunkZ * 16 + localZ;
          const ridge = Math.sin(x / 18) + Math.cos(z / 21);
          const river = Math.abs(Math.sin((x + z) / 30)) < 0.08;
          const block = river ? 1 : ridge > 1.25 ? 3 : Math.abs(x) < 7 && Math.abs(z) < 7 ? 2 : (x + z) % 19 === 0 ? 4 : 0;
          blocks.push(block);
          heights.push(block === 1 ? 62 : Math.round(66 + ridge * 5));
        }
      }
      chunks.push({ world: "world", dimension: "Overworld", chunkX, chunkZ, palette, blocks, heights, updatedAt: Date.now() });
    }
  }
  return chunks;
}
