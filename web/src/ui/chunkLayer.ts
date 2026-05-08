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

const BLOCKS_PER_CHUNK = 16;
const CHUNKS_PER_TILE = 16;
const TILE_SIZE = BLOCKS_PER_CHUNK * CHUNKS_PER_TILE;

interface AtlasResource {
  manifest: TextureManifest;
  image: HTMLImageElement | null;
}

export interface ChunkLayerHandle extends GridLayer {
  setWorldDimension: (world: string, dimension: string) => void;
  refreshChunk: (message: ChunkReadyMessage) => void;
  applyBlockUpdates: (message: BlockUpdatesMessage) => void;
}

export function createChunkGridLayer(L: typeof import("leaflet"), world: string, dimension: string): ChunkLayerHandle {
  class ChunkGridLayer extends L.GridLayer implements ChunkLayerHandle {
    private worldName = world;
    private dimensionName = dimension;
    private readonly chunkCache = new Map<string, ChunkSnapshot>();
    private atlasPromise: Promise<AtlasResource> | null = null;

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
        const index = update.localZ * 16 + update.localX;
        chunk.blocks[index] = paletteIndex;
        chunk.heights[index] = update.height;
      }
      this.redraw();
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

      const minChunkX = coords.x * CHUNKS_PER_TILE;
      const minChunkZ = coords.y * CHUNKS_PER_TILE;
      const response = await fetchChunks({
        world: this.worldName,
        dimension: this.dimensionName,
        minChunkX,
        maxChunkX: minChunkX + CHUNKS_PER_TILE - 1,
        minChunkZ,
        maxChunkZ: minChunkZ + CHUNKS_PER_TILE - 1,
      });
      for (const chunk of response.chunks) {
        this.chunkCache.set(cacheKey(chunk.world, chunk.dimension, chunk.chunkX, chunk.chunkZ), chunk);
      }

      const atlas = await this.loadAtlas();
      for (const chunk of response.chunks) {
        drawChunk(ctx, chunk, minChunkX, minChunkZ, atlas);
      }
      drawGrid(ctx);
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
    minZoom: 0,
    maxZoom: 0,
    noWrap: false,
    className: "chunk-grid-layer",
  }) as ChunkLayerHandle;
}

function drawChunk(ctx: CanvasRenderingContext2D, chunk: ChunkSnapshot, minChunkX: number, minChunkZ: number, atlas: AtlasResource) {
  const baseX = (chunk.chunkX - minChunkX) * BLOCKS_PER_CHUNK;
  const baseY = (chunk.chunkZ - minChunkZ) * BLOCKS_PER_CHUNK;
  for (let localZ = 0; localZ < BLOCKS_PER_CHUNK; localZ += 1) {
    for (let localX = 0; localX < BLOCKS_PER_CHUNK; localX += 1) {
      const index = localZ * BLOCKS_PER_CHUNK + localX;
      const blockId = chunk.palette[chunk.blocks[index]] || "minecraft:air";
      drawBlock(ctx, atlas, blockId, baseX + localX, baseY + localZ);
    }
  }
}

function drawBlock(ctx: CanvasRenderingContext2D, atlas: AtlasResource, blockId: string, x: number, y: number) {
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  if (atlas.image && entry) {
    drawAtlasEntry(ctx, atlas.image, entry, x, y);
    return;
  }
  ctx.fillStyle = fallbackTextureColor(blockId);
  ctx.fillRect(x, y, 1, 1);
}

function drawAtlasEntry(ctx: CanvasRenderingContext2D, image: HTMLImageElement, entry: TextureAtlasEntry, x: number, y: number) {
  ctx.drawImage(image, entry.x, entry.y, entry.w, entry.h, x, y, 1, 1);
}

function drawEmptyTile(canvas: HTMLCanvasElement, color: string) {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawGrid(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = "rgba(255,255,255,0.055)";
  ctx.lineWidth = 1;
  for (let value = 0; value <= TILE_SIZE; value += BLOCKS_PER_CHUNK) {
    ctx.beginPath();
    ctx.moveTo(value + 0.5, 0);
    ctx.lineTo(value + 0.5, TILE_SIZE);
    ctx.moveTo(0, value + 0.5);
    ctx.lineTo(TILE_SIZE, value + 0.5);
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

function stripNamespace(blockId: string) {
  return blockId.includes(":") ? blockId.slice(blockId.indexOf(":") + 1) : blockId;
}

export function fallbackTextureColor(blockId: string) {
  const id = blockId.toLowerCase();
  if (id.includes("water")) {
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
