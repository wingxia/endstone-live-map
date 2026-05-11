export const CHUNK_SIZE = 16;
export const CHUNK_BLOCK_COUNT = CHUNK_SIZE * CHUNK_SIZE;
export const DEFAULT_WORLD = "Bedrock level";

const DIMENSION_LABELS = new Map([
  ["overworld", "Overworld"],
  ["nether", "Nether"],
  ["the_end", "TheEnd"],
  [0, "Overworld"],
  [1, "Nether"],
  [2, "TheEnd"],
]);

export function normalizeDimension(value) {
  return DIMENSION_LABELS.get(value) || String(value);
}

export function offsetToSubchunkIndex(localX, localY, localZ) {
  return ((localX & 0xf) << 8) | (localY & 0xf) | ((localZ & 0xf) << 4);
}

export function blockNameFromPaletteEntry(entry) {
  return entry?.value?.name?.value || entry?.name?.value || entry?.name || "minecraft:air";
}

export function blockNameAt(layer, localX, localY, localZ) {
  const offset = offsetToSubchunkIndex(localX, localY, localZ);
  const paletteIndex = layer?.block_indices?.value?.value?.[offset] ?? 0;
  const paletteEntry = layer?.palette?.value?.[String(paletteIndex)];
  return blockNameFromPaletteEntry(paletteEntry);
}

export function buildChunkSnapshot({ world = DEFAULT_WORLD, dimension, chunkX, chunkZ, subchunks, updatedAt = Date.now(), includeLiquids = true }) {
  const ordered = [...subchunks].sort((a, b) => b.y - a.y);
  const palette = [];
  const paletteIndexes = new Map();
  const blocks = Array.from({ length: CHUNK_BLOCK_COUNT }, () => 0);
  const heights = Array.from({ length: CHUNK_BLOCK_COUNT }, () => -64);

  const paletteIndex = (blockId) => {
    const id = normalizeBlockId(blockId);
    if (paletteIndexes.has(id)) {
      return paletteIndexes.get(id);
    }
    const index = palette.length;
    palette.push(id);
    paletteIndexes.set(id, index);
    return index;
  };
  paletteIndex("minecraft:air");

  for (let localZ = 0; localZ < CHUNK_SIZE; localZ += 1) {
    for (let localX = 0; localX < CHUNK_SIZE; localX += 1) {
      const columnIndex = localZ * CHUNK_SIZE + localX;
      for (const subchunk of ordered) {
        const layer = subchunk.layers[0];
        if (!layer) {
          continue;
        }
        for (let localY = CHUNK_SIZE - 1; localY >= 0; localY -= 1) {
          const block = blockNameAt(layer, localX, localY, localZ);
          if (!isVisibleTopBlock(block, includeLiquids)) {
            continue;
          }
          blocks[columnIndex] = paletteIndex(block);
          heights[columnIndex] = subchunk.y * CHUNK_SIZE + localY;
          localY = -1;
          break;
        }
        if (heights[columnIndex] !== -64) {
          break;
        }
      }
    }
  }

  return {
    world,
    dimension: normalizeDimension(dimension),
    chunkX,
    chunkZ,
    palette,
    blocks,
    heights,
    updatedAt,
  };
}

export function summarizeSnapshots(snapshots, { world = DEFAULT_WORLD, dimension, importedAt = Date.now(), status = "complete" } = {}) {
  let minChunkX = Infinity;
  let maxChunkX = -Infinity;
  let minChunkZ = Infinity;
  let maxChunkZ = -Infinity;
  const topBlocks = {};

  for (const snapshot of snapshots) {
    minChunkX = Math.min(minChunkX, snapshot.chunkX);
    maxChunkX = Math.max(maxChunkX, snapshot.chunkX);
    minChunkZ = Math.min(minChunkZ, snapshot.chunkZ);
    maxChunkZ = Math.max(maxChunkZ, snapshot.chunkZ);
    for (const paletteIndex of snapshot.blocks) {
      const block = snapshot.palette[paletteIndex] || "minecraft:air";
      topBlocks[block] = (topBlocks[block] || 0) + 1;
    }
  }

  const hasChunks = snapshots.length > 0;
  return {
    version: 1,
    world,
    dimension: normalizeDimension(dimension),
    status,
    chunkCount: snapshots.length,
    importedAt,
    updatedAt: importedAt,
    bounds: {
      minChunkX: hasChunks ? minChunkX : 0,
      maxChunkX: hasChunks ? maxChunkX : 0,
      minChunkZ: hasChunks ? minChunkZ : 0,
      maxChunkZ: hasChunks ? maxChunkZ : 0,
      minBlockX: hasChunks ? minChunkX * CHUNK_SIZE : 0,
      maxBlockX: hasChunks ? maxChunkX * CHUNK_SIZE + CHUNK_SIZE - 1 : 0,
      minBlockZ: hasChunks ? minChunkZ * CHUNK_SIZE : 0,
      maxBlockZ: hasChunks ? maxChunkZ * CHUNK_SIZE + CHUNK_SIZE - 1 : 0,
    },
    topBlocks,
  };
}

export function mergeWorldMeta(a, b) {
  if (!a || a.chunkCount === 0) {
    return b;
  }
  if (!b || b.chunkCount === 0) {
    return a;
  }
  const topBlocks = { ...a.topBlocks };
  for (const [block, count] of Object.entries(b.topBlocks)) {
    topBlocks[block] = (topBlocks[block] || 0) + count;
  }
  return {
    ...a,
    status: b.status || a.status,
    chunkCount: a.chunkCount + b.chunkCount,
    importedAt: Math.max(a.importedAt, b.importedAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    bounds: {
      minChunkX: Math.min(a.bounds.minChunkX, b.bounds.minChunkX),
      maxChunkX: Math.max(a.bounds.maxChunkX, b.bounds.maxChunkX),
      minChunkZ: Math.min(a.bounds.minChunkZ, b.bounds.minChunkZ),
      maxChunkZ: Math.max(a.bounds.maxChunkZ, b.bounds.maxChunkZ),
      minBlockX: Math.min(a.bounds.minBlockX, b.bounds.minBlockX),
      maxBlockX: Math.max(a.bounds.maxBlockX, b.bounds.maxBlockX),
      minBlockZ: Math.min(a.bounds.minBlockZ, b.bounds.minBlockZ),
      maxBlockZ: Math.max(a.bounds.maxBlockZ, b.bounds.maxBlockZ),
    },
    topBlocks,
  };
}

export function chunkKey(snapshot) {
  return `${snapshot.world}/${snapshot.dimension}/${snapshot.chunkX}/${snapshot.chunkZ}`;
}

function isVisibleTopBlock(blockId, includeLiquids) {
  const id = normalizeBlockId(blockId);
  if (id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air") {
    return false;
  }
  if (!includeLiquids && (id === "minecraft:water" || id === "minecraft:flowing_water" || id === "minecraft:lava" || id === "minecraft:flowing_lava")) {
    return false;
  }
  return true;
}

function normalizeBlockId(value) {
  const id = String(value || "minecraft:air");
  return id.includes(":") ? id : `minecraft:${id}`;
}
