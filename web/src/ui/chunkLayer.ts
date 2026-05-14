import type { Coords, DoneCallback, GridLayer } from "leaflet";

import {
  fetchChunks,
  fetchTextureManifest,
  segmentKey,
  textureAtlasUrl,
  type BlockUpdatesMessage,
  type ChunkReadyMessage,
  type ChunkSnapshot,
  type TextureAtlasEntry,
  type TextureManifest,
} from "../api";
import { blockColumnIndex, blockToChunk } from "./coords";
import { isLikelyTransparentTextureBlock, isMapDecorationBlock, isPlantBlock } from "./mapBlocks";

const BLOCKS_PER_CHUNK = 16;
const TILE_SIZE = 256;
const MIN_ZOOM = 0;
const MAX_ZOOM = 4;
const TILE_KEEP_BUFFER = 2;

export const INITIAL_MAP_ZOOM = 4;

interface AtlasResource {
  manifest: TextureManifest;
  image: HTMLImageElement | null;
}

interface TileDrawContext {
  world: string;
  dimension: string;
  active: boolean;
  dataVersion: number;
}

interface LeafletTileRecord {
  el: HTMLElement;
  coords: Coords;
  current?: boolean;
}

interface GridLayerInternals {
  _tiles?: Record<string, LeafletTileRecord>;
  _update?: () => void;
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
    private dataVersion = 0;
    private atlasPromise: Promise<AtlasResource> | null = null;

    setActive(active: boolean) {
      if (this.active === active) {
        return;
      }
      this.active = active;
      if (!active) {
        this.chunkCache.clear();
      }
      this.dataVersion += 1;
      this.redraw();
    }

    setWorldDimension(nextWorld: string, nextDimension: string) {
      if (this.worldName === nextWorld && this.dimensionName === nextDimension) {
        return;
      }
      this.worldName = nextWorld;
      this.dimensionName = nextDimension;
      this.chunkCache.clear();
      this.dataVersion += 1;
      this.redraw();
    }

    refreshChunk(message: ChunkReadyMessage) {
      if (!sameWorldDimension(message.world, message.dimension, this.worldName, this.dimensionName)) {
        return;
      }
      this.chunkCache.delete(cacheKey(message.world, message.dimension, message.chunkX, message.chunkZ));
      this.dataVersion += 1;
      this.refreshVisibleTiles({ chunkX: message.chunkX, chunkZ: message.chunkZ });
    }

    applyBlockUpdates(message: BlockUpdatesMessage) {
      if (!sameWorldDimension(message.world, message.dimension, this.worldName, this.dimensionName)) {
        return;
      }
      this.dataVersion += 1;
      const key = cacheKey(message.world, message.dimension, message.chunkX, message.chunkZ);
      const chunk = this.chunkCache.get(key);
      if (!chunk) {
        this.refreshVisibleTiles({ chunkX: message.chunkX, chunkZ: message.chunkZ });
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
        if (update.overlayBlock !== undefined || chunk.overlayBlocks !== undefined || chunk.overlayHeights !== undefined) {
          const overlayBlock = update.overlayBlock || "minecraft:air";
          const overlayHeight = update.overlayHeight ?? -64;
          let overlayPaletteIndex = chunk.palette.indexOf(overlayBlock);
          if (overlayPaletteIndex === -1) {
            overlayPaletteIndex = chunk.palette.push(overlayBlock) - 1;
          }
          chunk.overlayBlocks = fixedChunkArray(chunk.overlayBlocks, airPaletteIndex(chunk));
          chunk.overlayHeights = fixedChunkArray(chunk.overlayHeights, -64);
          chunk.overlayBlocks[index] = overlayPaletteIndex;
          chunk.overlayHeights[index] = overlayHeight;
        }
      }
      this.refreshVisibleTiles({ chunkX: message.chunkX, chunkZ: message.chunkZ });
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
      const context = this.currentDrawContext();
      void this.drawTile(canvas, coords, context)
        .catch(() => drawEmptyTile(canvas, "#17202a"))
        .finally(() => done(undefined, canvas));
      return canvas;
    }

    private async drawTile(
      canvas: HTMLCanvasElement,
      coords: Coords,
      context: TileDrawContext,
      options: { preserveExisting?: boolean } = {},
    ) {
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      ctx.imageSmoothingEnabled = false;
      if (!options.preserveExisting) {
        drawEmptyTile(canvas, "#17202a");
      }
      if (!context.active || !this.isCurrentTileContext(context)) {
        return;
      }

      const tileRange = chunkRangeForTile(coords);
      const cachedChunks = chunksFromCache(this.chunkCache, context.world, context.dimension, tileRange);
      const atlasPromise = this.loadAtlas();
      if (cachedChunks.length > 0) {
        const atlas = await atlasPromise;
        if (!this.isCurrentTileContext(context)) {
          return;
        }
        drawEmptyTile(canvas, "#17202a");
        for (const chunk of cachedChunks) {
          drawChunk(ctx, chunk, tileRange, atlas);
        }
        drawGrid(ctx, tileRange);
      }

      const response = await fetchChunks(
        {
          world: context.world,
          dimension: context.dimension,
          minChunkX: tileRange.minChunkX,
          maxChunkX: tileRange.maxChunkX,
          minChunkZ: tileRange.minChunkZ,
          maxChunkZ: tileRange.maxChunkZ,
        },
        { cache: "no-store", cacheBust: `${context.dataVersion}-${coords.z}-${coords.x}-${coords.y}` },
      );
      if (!this.isCurrentTileContext(context)) {
        return;
      }
      for (const chunk of response.chunks) {
        this.chunkCache.set(cacheKey(chunk.world, chunk.dimension, chunk.chunkX, chunk.chunkZ), chunk);
      }

      const atlas = await atlasPromise;
      if (!this.isCurrentTileContext(context)) {
        return;
      }
      drawEmptyTile(canvas, "#17202a");
      for (const chunk of response.chunks) {
        drawChunk(ctx, chunk, tileRange, atlas);
      }
      drawGrid(ctx, tileRange);
    }

    private refreshVisibleTiles(changedChunk: { chunkX: number; chunkZ: number }) {
      const internals = this as unknown as GridLayerInternals;
      let refreshed = false;
      for (const tile of Object.values(internals._tiles || {})) {
        if (!tile.current || !(tile.el instanceof HTMLCanvasElement) || !tileIntersectsChunk(tile.coords, changedChunk)) {
          continue;
        }
        refreshed = true;
        void this.drawTile(tile.el, tile.coords, this.currentDrawContext(), { preserveExisting: true }).catch(() => undefined);
      }
      if (!refreshed) {
        internals._update?.call(this);
      }
    }

    private currentDrawContext(): TileDrawContext {
      return {
        world: this.worldName,
        dimension: this.dimensionName,
        active: this.active,
        dataVersion: this.dataVersion,
      };
    }

    private isCurrentTileContext(context: TileDrawContext) {
      return (
        context.active &&
        this.active &&
        context.dataVersion === this.dataVersion &&
        this.worldName === context.world &&
        this.dimensionName === context.dimension
      );
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
    updateWhenZooming: false,
    keepBuffer: TILE_KEEP_BUFFER,
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
  const minBlockZ = Math.floor(minLeafletY);
  const maxBlockZ = normalizeZero(Math.ceil(maxLeafletY) - 1);

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
      const x = (worldX - range.minBlockX) * range.scale;
      const y = (worldZ - range.minBlockZ) * range.scale;
      drawBlock(ctx, atlas, blockId, x, y, range.scale, "base");
      const overlayBlockId = overlayBlockAt(chunk, index);
      if (overlayBlockId && overlayBlockId !== "minecraft:air") {
        drawBlock(ctx, atlas, overlayBlockId, x, y, range.scale, "overlay");
      }
    }
  }
}

function chunksFromCache(cache: Map<string, ChunkSnapshot>, world: string, dimension: string, range: TileChunkRange) {
  const chunks: ChunkSnapshot[] = [];
  for (let chunkZ = range.minChunkZ; chunkZ <= range.maxChunkZ; chunkZ += 1) {
    for (let chunkX = range.minChunkX; chunkX <= range.maxChunkX; chunkX += 1) {
      const chunk = cache.get(cacheKey(world, dimension, chunkX, chunkZ));
      if (chunk) {
        chunks.push(chunk);
      }
    }
  }
  return chunks;
}

function tileIntersectsChunk(coords: Pick<Coords, "x" | "y" | "z">, chunk: { chunkX: number; chunkZ: number }) {
  const range = chunkRangeForTile(coords);
  return chunk.chunkX >= range.minChunkX && chunk.chunkX <= range.maxChunkX && chunk.chunkZ >= range.minChunkZ && chunk.chunkZ <= range.maxChunkZ;
}

function drawBlock(ctx: CanvasRenderingContext2D, atlas: AtlasResource, blockId: string, x: number, y: number, size: number, layer: "base" | "overlay" = "base") {
  if (isPlantBlock(blockId)) {
    drawPlantMarker(ctx, atlas, blockId, x, y, size, layer);
    return;
  }
  if (isMapDecorationBlock(blockId)) {
    drawDecorationBlock(ctx, atlas, blockId, x, y, size, layer);
    return;
  }
  if (usesMapTint(blockId)) {
    ctx.fillStyle = fallbackTextureColor(blockId);
    ctx.fillRect(x, y, size, size);
    return;
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  if (atlas.image && entry) {
    if (isLikelyTransparentTextureBlock(blockId)) {
      ctx.fillStyle = fallbackTextureColor(blockId);
      ctx.fillRect(x, y, size, size);
    }
    drawAtlasEntry(ctx, atlas.image, entry, x, y, size);
    return;
  }
  ctx.fillStyle = fallbackTextureColor(blockId);
  ctx.fillRect(x, y, size, size);
}

function drawAtlasEntry(ctx: CanvasRenderingContext2D, image: HTMLImageElement, entry: TextureAtlasEntry, x: number, y: number, size: number) {
  ctx.drawImage(image, entry.x, entry.y, entry.w, entry.h, x, y, size, size);
}

function drawPlantMarker(ctx: CanvasRenderingContext2D, atlas: AtlasResource, blockId: string, x: number, y: number, size: number, layer: "base" | "overlay") {
  if (layer === "base") {
    ctx.fillStyle = "#5f9f3f";
    ctx.fillRect(x, y, size, size);
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  if (atlas.image && entry && size >= 4) {
    const inset = layer === "overlay" ? Math.max(1, Math.floor(size * 0.26)) : Math.max(1, Math.floor(size * 0.22));
    drawAtlasEntry(ctx, atlas.image, entry, x + inset, y + inset, Math.max(1, size - inset * 2));
    return;
  }
  ctx.fillStyle = fallbackTextureColor(blockId);
  const marker = Math.max(1, Math.floor(size * (layer === "overlay" ? 0.35 : 0.45)));
  ctx.fillRect(x + Math.floor((size - marker) / 2), y + Math.floor((size - marker) / 2), marker, marker);
}

function drawDecorationBlock(ctx: CanvasRenderingContext2D, atlas: AtlasResource, blockId: string, x: number, y: number, size: number, layer: "base" | "overlay") {
  if (layer === "base") {
    ctx.fillStyle = fallbackTextureColor(blockId);
    ctx.fillRect(x, y, size, size);
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  if (atlas.image && entry) {
    const inset = layer === "overlay" ? decorationInset(blockId, size) : baseDecorationInset(blockId, size);
    drawAtlasEntry(ctx, atlas.image, entry, x + inset, y + inset, Math.max(1, size - inset * 2));
    return;
  }
  drawDecorationGlyph(ctx, blockId, x, y, size, layer);
}

function overlayBlockAt(chunk: ChunkSnapshot, index: number) {
  const overlayBlocks = chunk.overlayBlocks;
  if (!overlayBlocks || !chunk.overlayHeights || chunk.overlayHeights[index] <= -64) {
    return "";
  }
  return chunk.palette[overlayBlocks[index]] || "minecraft:air";
}

function fixedChunkArray(values: number[] | undefined, fallback: number) {
  if (values && values.length === 256) {
    return values;
  }
  return Array.from({ length: 256 }, () => fallback);
}

function airPaletteIndex(chunk: ChunkSnapshot) {
  const index = chunk.palette.indexOf("minecraft:air");
  if (index >= 0) {
    return index;
  }
  return chunk.palette.push("minecraft:air") - 1;
}

function baseDecorationInset(blockId: string, size: number) {
  const id = blockId.toLowerCase();
  if (isFlatDecorationBlock(id)) {
    return 0;
  }
  if (isSmallDecorationBlock(id)) {
    return decorationInset(blockId, size);
  }
  return 0;
}

function decorationInset(blockId: string, size: number) {
  const id = blockId.toLowerCase();
  if (isFlatDecorationBlock(id)) {
    return 0;
  }
  if (isTinyDecorationBlock(id)) {
    return Math.max(1, Math.floor(size * 0.36));
  }
  if (isSmallDecorationBlock(id)) {
    return Math.max(1, Math.floor(size * 0.3));
  }
  if (id.includes("pane") || id.includes("bars") || id.includes("fence") || id.includes("rail") || id.includes("chain")) {
    return Math.max(1, Math.floor(size * 0.28));
  }
  if (id.includes("torch") || id.includes("button") || id.includes("lever") || id.includes("candle")) {
    return Math.max(1, Math.floor(size * 0.34));
  }
  return Math.max(1, Math.floor(size * 0.18));
}

function isTinyDecorationBlock(id: string) {
  return (
    id.includes("button") ||
    id.includes("candle") ||
    id.includes("flower_pot") ||
    id.includes("sea_pickle") ||
    id.includes("torch") ||
    id.includes("tripwire_hook") ||
    id.includes("turtle_egg")
  );
}

function isFlatDecorationBlock(id: string) {
  return id.includes("leaf_litter") || id.includes("carpet") || id.includes("snow_layer");
}

function isSmallDecorationBlock(id: string) {
  return (
    isTinyDecorationBlock(id) ||
    id.includes("amethyst_cluster") ||
    id.includes("bell") ||
    id.includes("brewing_stand") ||
    id.includes("conduit") ||
    id.includes("coral") ||
    id.includes("head") ||
    id.includes("lantern") ||
    id.includes("skull")
  );
}

function drawDecorationGlyph(ctx: CanvasRenderingContext2D, blockId: string, x: number, y: number, size: number, layer: "base" | "overlay") {
  const inset = layer === "overlay" ? decorationInset(blockId, size) : baseDecorationInset(blockId, size);
  if (layer === "overlay" && isFlatDecorationBlock(blockId.toLowerCase())) {
    const band = Math.max(1, Math.floor(size * 0.18));
    ctx.fillStyle = fallbackTextureColor(blockId);
    ctx.fillRect(x, y, size, band);
    ctx.fillRect(x, y + Math.max(0, size - band), size, band);
    ctx.fillRect(x, y, band, size);
    ctx.fillRect(x + Math.max(0, size - band), y, band, size);
    return;
  }
  ctx.fillStyle = fallbackTextureColor(blockId);
  ctx.fillRect(x + inset, y + inset, Math.max(1, size - inset * 2), Math.max(1, size - inset * 2));
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
      const y = (blockZ - range.minBlockZ) * range.scale + 0.5;
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
    const y = (chunkZ * BLOCKS_PER_CHUNK - range.minBlockZ) * range.scale + 0.5;
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
  return `${segmentKey(world)}/${segmentKey(dimension)}/${chunkX}/${chunkZ}`;
}

function sameWorldDimension(leftWorld: string, leftDimension: string, rightWorld: string, rightDimension: string) {
  return segmentKey(leftWorld) === segmentKey(rightWorld) && segmentKey(leftDimension) === segmentKey(rightDimension);
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
  return (
    id.includes("water") ||
    id.includes("bubble_column") ||
    id.includes("grass_block") ||
    id.includes("short_grass") ||
    id.includes("tall_grass") ||
    id.includes("fern") ||
    id.includes("vine")
  );
}

export function fallbackTextureColor(blockId: string) {
  const id = blockId.toLowerCase();
  if (id.includes("water") || id.includes("bubble_column")) {
    return "#2563b8";
  }
  if (id.includes("cherry_leaves")) {
    return "#f2a5c9";
  }
  if (id.includes("azalea_leaves")) {
    return "#5f9f4a";
  }
  if (id.includes("grass_block")) {
    return "#5f9f3f";
  }
  if (id.includes("short_grass") || id.includes("tall_grass") || id.includes("fern") || id.includes("vine")) {
    return "#4f8f35";
  }
  if (id.includes("flower") || id.includes("poppy") || id.includes("dandelion") || id.includes("tulip") || id.includes("orchid") || id.includes("allium")) {
    return "#d9d16b";
  }
  if (id.includes("leaves")) {
    return "#3f7f38";
  }
  if (id.includes("glass") || id.includes("pane") || id.includes("ice")) {
    return "#9fc7d1";
  }
  if (id.includes("fence") || id.includes("trapdoor") || id.includes("door") || id.includes("rail") || id.includes("bars") || id.includes("chain")) {
    return "#8b8174";
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
