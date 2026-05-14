import type { ChunkSnapshot, LandClaim, PlayerState, WorldMeta } from "./api";

const MOCK_WORLD = "Bedrock level";

export const mockPlayers: PlayerState[] = [
  {
    id: "mock-wing",
    name: "Wing",
    world: MOCK_WORLD,
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
    world: MOCK_WORLD,
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
    world: MOCK_WORLD,
    dimension: "Nether",
    x: 112,
    y: 42,
    z: -80,
    yaw: 40,
    pitch: 0,
    updatedAt: Date.now(),
  },
];

export const mockLands: LandClaim[] = [
  {
    id: "GieZi8670:主城区:Overworld",
    owner: "GieZi8670",
    name: "主城区",
    world: "Bedrock level",
    dimension: "Overworld",
    minX: -375,
    maxX: -227,
    minY: 70,
    maxY: 300,
    minZ: -580,
    maxZ: -473,
    teleport: { x: -352, y: 70, z: -479 },
    members: ["GieZi8670", "wingxia", "SimoneGoes2322"],
    parent: "",
    children: ["猪人塔", "交易所/刷铁机"],
    nested: false,
    updatedAt: Date.now(),
  },
  {
    id: "GieZi8670:白色青蛙:Overworld",
    owner: "GieZi8670",
    name: "白色青蛙",
    world: "Bedrock level",
    dimension: "Overworld",
    minX: -665,
    maxX: -665,
    minY: 63,
    maxY: 63,
    minZ: -6357,
    maxZ: -6357,
    teleport: { x: -665, y: 63, z: -6357 },
    members: [],
    parent: "",
    children: [],
    nested: false,
    updatedAt: Date.now(),
  },
];

export const mockChunks: ChunkSnapshot[] = createMockChunks();

export const mockWorlds: WorldMeta[] = [
  {
    version: 1,
    world: MOCK_WORLD,
    dimension: "Overworld",
    status: "complete",
    chunkCount: 289,
    importedAt: Date.now(),
    updatedAt: Date.now(),
    bounds: {
      minChunkX: -8,
      maxChunkX: 8,
      minChunkZ: -8,
      maxChunkZ: 8,
      minBlockX: -128,
      maxBlockX: 143,
      minBlockZ: -128,
      maxBlockZ: 143,
    },
    topBlocks: { "minecraft:grass_block": 52000, "minecraft:water": 11000 },
  },
];

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
      chunks.push({ world: MOCK_WORLD, dimension: "Overworld", chunkX, chunkZ, palette, blocks, heights, updatedAt: Date.now() });
    }
  }
  return chunks;
}
