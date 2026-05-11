import type { Coords, DoneCallback, GridLayer } from "leaflet";

import {
  fetchChunks,
  fetchTextureManifest,
  textureAtlasUrl,
  type BlockUpdatesMessage,
  type ChunkReadyMessage,
  type ChunkSnapshot,
  type TextureAtlasEntry,
  type TextureManifest,
} from "../api";
import { blockColumnIndex, blockToChunk } from "./coords";

const BLOCKS_PER_CHUNK = 16;
const TILE_SIZE = 256;
const MIN_ZOOM = 0;
const MAX_ZOOM = 4;

export const INITIAL_MAP_ZOOM = 4;

interface AtlasResource {
  manifest: TextureManifest;
  image: HTMLImageElement | null;
}

export interface ChunkLayerHandle extends GridLayer {
  setActive: (active: boolean) => void;
  setWorldDimension: (world: string, dimension: string) => void;
  refreshChunk: (message: ChunkReadyMessage) => void;
  applyBlockUpdates: (message: BlockUpdatesMessage) => void;
  getBlockInfo: (x: number, z: number) => BlockInfo | null;
}

export interface BlockInfo {
  block: string;
  height: number;
  chunkX: number;
  chunkZ: number;
  localX: number;
  localZ: number;
}

export function createChunkGridLayer(L: typeof import("leaflet"), world: string, dimension: string): ChunkLayerHandle {
  class ChunkGridLayer extends L.GridLayer implements ChunkLayerHandle {
    private worldName = world;
    private dimensionName = dimension;
    private active = false;
    private readonly chunkCache = new Map<string, ChunkSnapshot>();
    private atlasPromise: Promise<AtlasResource> | null = null;

    setActive(active: boolean) {
      if (this.active === active) {
        return;
      }
      this.active = active;
      if (!active) {
        this.chunkCache.clear();
      }
      this.redraw();
    }

    setWorldDimension(nextWorld: string, nextDimension: string) {
      if (this.worldName === nextWorld && this.dimensionName === nextDimension) {
        return;
      }
      this.worldName = nextWorld;
      this.dimensionName = nextDimension;
      this.chunkCache.clear();
      this.redraw();
    }

    refreshChunk(message: ChunkReadyMessage) {
      if (message.world !== this.worldName || message.dimension !== this.dimensionName) {
        return;
      }
      this.chunkCache.delete(cacheKey(message.world, message.dimension, message.chunkX, message.chunkZ));
      this.redraw();
    }

    applyBlockUpdates(message: BlockUpdatesMessage) {
      if (message.world !== this.worldName || message.dimension !== this.dimensionName) {
        return;
      }
      const key = cacheKey(message.world, message.dimension, message.chunkX, message.chunkZ);
      const chunk = this.chunkCache.get(key);
      if (!chunk) {
        this.redraw();
        return;
      }
      for (const update of message.updates) {
        if (update.localX < 0 || update.localX >= 16 || update.localZ < 0 || update.localZ >= 16) {
          continue;
        }
        let paletteIndex = chunk.palette.indexOf(update.block);
        if (paletteIndex === -1) {
          paletteIndex = chunk.palette.push(update.block) - 1;
        }
        const index = blockColumnIndex(update.localX, update.localZ);
        chunk.blocks[index] = paletteIndex;
        chunk.heights[index] = update.height;
      }
      this.redraw();
    }

    getBlockInfo(x: number, z: number): BlockInfo | null {
      const position = blockToChunk(x, z);
      const chunk = this.chunkCache.get(cacheKey(this.worldName, this.dimensionName, position.chunkX, position.chunkZ));
      if (!chunk) {
        return {
          ...position,
          block: "未加载",
          height: Number.NaN,
        };
      }
      const index = blockColumnIndex(position.localX, position.localZ);
      return {
        ...position,
        block: chunk.palette[chunk.blocks[index]] || "minecraft:air",
        height: chunk.heights[index],
      };
    }

    createTile(coords: Coords, done: DoneCallback): HTMLElement {
      const canvas = document.createElement("canvas");
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      canvas.className = "chunk-tile";
      void this.drawTile(canvas, coords)
        .catch(() => drawEmptyTile(canvas, "#17202a"))
        .finally(() => done(undefined, canvas));
      return canvas;
    }

    private async drawTile(canvas: HTMLCanvasElement, coords: Coords) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.imageSmoothingEnabled = false;
      drawEmptyTile(canvas, "#17202a");
      if (!this.active) {
        return;
      }

      const tileRange = chunkRangeForTile(coords);
      const response = await fetchChunks({
        world: this.worldName,
        dimension: this.dimensionName,
        minChunkX: tileRange.minChunkX,
        maxChunkX: tileRange.maxChunkX,
        minChunkZ: tileRange.minChunkZ,
        maxChunkZ: tileRange.maxChunkZ,
      });
      for (const chunk of response.chunks) {
        this.chunkCache.set(cacheKey(chunk.world, chunk.dimension, chunk.chunkX, chunk.chunkZ), chunk);
      }

      const atlas = await this.loadAtlas();
      for (const chunk of response.chunks) {
        drawChunk(ctx, chunk, tileRange, atlas);
      }
      drawGrid(ctx, tileRange);
    }

    private loadAtlas() {
      if (!this.atlasPromise) {
        this.atlasPromise = loadAtlasResource();
      }
      return this.atlasPromise;
    }
  }

  return new ChunkGridLayer({
    tileSize: TILE_SIZE,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    noWrap: false,
    className: "chunk-grid-layer",
  }) as ChunkLayerHandle;
}

interface TileChunkRange {
  minBlockX: number;
  maxBlockX: number;
  minBlockZ: number;
  maxBlockZ: number;
  minChunkX: number;
  maxChunkX: number;
  minChunkZ: number;
  maxChunkZ: number;
  scale: number;
}

export function chunkRangeForTile(coords: Pick<Coords, "x" | "y" | "z">): TileChunkRange {
  const scale = 2 ** coords.z;
  const minLeafletX = (coords.x * TILE_SIZE) / scale;
  const maxLeafletX = ((coords.x + 1) * TILE_SIZE) / scale;
  const minLeafletY = (coords.y * TILE_SIZE) / scale;
  const maxLeafletY = ((coords.y + 1) * TILE_SIZE) / scale;
  const minBlockX = Math.floor(minLeafletX);
  const maxBlockX = Math.ceil(maxLeafletX) - 1;
  const minBlockZ = Math.floor(-maxLeafletY) + 1;
  const maxBlockZ = normalizeZero(Math.floor(-minLeafletY));

  return {
    minBlockX,
    maxBlockX,
    minBlockZ,
    maxBlockZ,
    minChunkX: floorDiv(minBlockX, BLOCKS_PER_CHUNK),
    maxChunkX: floorDiv(maxBlockX, BLOCKS_PER_CHUNK),
    minChunkZ: floorDiv(minBlockZ, BLOCKS_PER_CHUNK),
    maxChunkZ: floorDiv(maxBlockZ, BLOCKS_PER_CHUNK),
    scale,
  };
}

function drawChunk(ctx: CanvasRenderingContext2D, chunk: ChunkSnapshot, range: TileChunkRange, atlas: AtlasResource) {
  for (let localZ = 0; localZ < BLOCKS_PER_CHUNK; localZ += 1) {
    for (let localX = 0; localX < BLOCKS_PER_CHUNK; localX += 1) {
      const worldX = chunk.chunkX * BLOCKS_PER_CHUNK + localX;
      const worldZ = chunk.chunkZ * BLOCKS_PER_CHUNK + localZ;
      if (worldX < range.minBlockX || worldX > range.maxBlockX || worldZ < range.minBlockZ || worldZ > range.maxBlockZ) {
        continue;
      }
      const index = blockColumnIndex(localX, localZ);
      const blockId = chunk.palette[chunk.blocks[index]] || "minecraft:air";
      drawBlock(ctx, atlas, blockId, (worldX - range.minBlockX) * range.scale, (range.maxBlockZ - worldZ) * range.scale, range.scale);
    }
  }
}

function drawBlock(ctx: CanvasRenderingContext2D, atlas: AtlasResource, blockId: string, x: number, y: number, size: number) {
  if (usesMapTint(blockId)) {
    ctx.fillStyle = fallbackTextureColor(blockId);
    ctx.fillRect(x, y, size, size);
    return;
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  if (atlas.image && entry) {
    drawAtlasEntry(ctx, atlas.image, entry, x, y, size);
    return;
  }
  ctx.fillStyle = fallbackTextureColor(blockId);
  ctx.fillRect(x, y, size, size);
}

function drawAtlasEntry(ctx: CanvasRenderingContext2D, image: HTMLImageElement, entry: TextureAtlasEntry, x: number, y: number, size: number) {
  ctx.drawImage(image, entry.x, entry.y, entry.w, entry.h, x, y, size, size);
}

function drawEmptyTile(canvas: HTMLCanvasElement, color: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawGrid(ctx: CanvasRenderingContext2D, range: TileChunkRange) {
  if (range.scale >= 8) {
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    for (let blockX = range.minBlockX; blockX <= range.maxBlockX; blockX += 1) {
      const x = (blockX - range.minBlockX) * range.scale + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, TILE_SIZE);
      ctx.stroke();
    }
    for (let blockZ = range.minBlockZ; blockZ <= range.maxBlockZ; blockZ += 1) {
      const y = (range.maxBlockZ - blockZ) * range.scale + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(TILE_SIZE, y);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = "rgba(255,255,255,0.11)";
  ctx.lineWidth = 1;
  for (let chunkX = range.minChunkX; chunkX <= range.maxChunkX + 1; chunkX += 1) {
    const x = (chunkX * BLOCKS_PER_CHUNK - range.minBlockX) * range.scale + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TILE_SIZE);
    ctx.stroke();
  }
  for (let chunkZ = range.minChunkZ; chunkZ <= range.maxChunkZ + 1; chunkZ += 1) {
    const y = (range.maxBlockZ - chunkZ * BLOCKS_PER_CHUNK + 1) * range.scale + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TILE_SIZE, y);
    ctx.stroke();
  }
}

async function loadAtlasResource(): Promise<AtlasResource> {
  try {
    const manifest = await fetchTextureManifest();
    const image = await loadImage(textureAtlasUrl(manifest));
    return { manifest, image };
  } catch {
    return {
      manifest: { version: 1, tileSize: 16, atlas: "", blocks: {} },
      image: null,
    };
  }
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${src}`));
    image.src = src;
  });
}

function cacheKey(world: string, dimension: string, chunkX: number, chunkZ: number) {
  return `${world}/${dimension}/${chunkX}/${chunkZ}`;
}

function floorDiv(value: number, divisor: number) {
  return Math.floor(value / divisor);
}

function normalizeZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function stripNamespace(blockId: string) {
  return blockId.includes(":") ? blockId.slice(blockId.indexOf(":") + 1) : blockId;
}

export function usesMapTint(blockId: string) {
  const id = blockId.toLowerCase();
  return id.includes("water") || id.includes("bubble_column");
}

export function fallbackTextureColor(blockId: string) {
  const id = blockId.toLowerCase();
  if (id.includes("water") || id.includes("bubble_column")) {
    return "#2563b8";
  }
  if (id.includes("sand")) {
    return "#d7c47a";
  }
  if (id.includes("grass") || id.includes("leaves") || id.includes("moss")) {
    return "#4f8f3a";
  }
  if (id.includes("dirt") || id.includes("mud")) {
    return "#7a5236";
  }
  if (id.includes("log") || id.includes("wood") || id.includes("planks")) {
    return "#8a6138";
  }
  if (id.includes("snow")) {
    return "#dce9ec";
  }
  if (id.includes("lava")) {
    return "#e46b2a";
  }
  if (id.includes("air")) {
    return "#111820";
  }
  return "#737f86";
}
