import type { Coords, DoneCallback, GridLayer } from "leaflet";

import {
  fetchChunks,
  fetchTextureManifest,
  segmentKey,
  textureAtlasUrl,
  type BlockStateMap,
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

interface TileDrawOptions {
  preserveExisting?: boolean;
  cacheBust?: string | number;
}

interface ChunkLayerOptions {
  bounds?: ChunkLayerBounds | null;
}

interface ChunkLayerBounds {
  minChunkX: number;
  maxChunkX: number;
  minChunkZ: number;
  maxChunkZ: number;
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
  setKnownBounds: (bounds: ChunkLayerBounds | null) => void;
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

export function createChunkGridLayer(L: typeof import("leaflet"), world: string, dimension: string, options: ChunkLayerOptions = {}): ChunkLayerHandle {
  class ChunkGridLayer extends L.GridLayer implements ChunkLayerHandle {
    private worldName = world;
    private dimensionName = dimension;
    private knownBounds = options.bounds || null;
    private active = false;
    private readonly chunkCache = new Map<string, ChunkSnapshot>();
    private readonly missingChunkCache = new Set<string>();
    private readonly pendingChunkRequests = new Map<string, Promise<void>>();
    private dataVersion = 0;
    private atlasPromise: Promise<AtlasResource> | null = null;

    setActive(active: boolean) {
      if (this.active === active) {
        return;
      }
      this.active = active;
      this.dataVersion += 1;
      this.redraw();
    }

    setKnownBounds(bounds: ChunkLayerBounds | null) {
      this.knownBounds = bounds;
    }

    setWorldDimension(nextWorld: string, nextDimension: string) {
      if (this.worldName === nextWorld && this.dimensionName === nextDimension) {
        return;
      }
      this.worldName = nextWorld;
      this.dimensionName = nextDimension;
      this.chunkCache.clear();
      this.missingChunkCache.clear();
      this.pendingChunkRequests.clear();
      this.dataVersion += 1;
      this.redraw();
    }

    refreshChunk(message: ChunkReadyMessage) {
      if (!sameWorldDimension(message.world, message.dimension, this.worldName, this.dimensionName)) {
        return;
      }
      const key = cacheKey(message.world, message.dimension, message.chunkX, message.chunkZ);
      this.chunkCache.delete(key);
      this.missingChunkCache.delete(key);
      this.dataVersion += 1;
      this.refreshVisibleTiles({ chunkX: message.chunkX, chunkZ: message.chunkZ }, { cacheBust: message.updatedAt || this.dataVersion });
    }

    applyBlockUpdates(message: BlockUpdatesMessage) {
      if (!sameWorldDimension(message.world, message.dimension, this.worldName, this.dimensionName)) {
        return;
      }
      this.dataVersion += 1;
      const key = cacheKey(message.world, message.dimension, message.chunkX, message.chunkZ);
      this.missingChunkCache.delete(key);
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
        chunk.blockStates = fixedStateArray(chunk.blockStates);
        chunk.blockStates[index] = update.state || {};
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
          chunk.overlayStates = fixedStateArray(chunk.overlayStates);
          chunk.overlayStates[index] = update.overlayState || {};
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
      drawEmptyTile(canvas, "#17202a");
      window.setTimeout(() => done(undefined, canvas), 0);
      void this.drawTile(canvas, coords, context).catch(() => drawEmptyTile(canvas, "#17202a"));
      return canvas;
    }

    private async drawTile(
      canvas: HTMLCanvasElement,
      coords: Coords,
      context: TileDrawContext,
      options: TileDrawOptions = {},
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
      const chunksReady = this.ensureTileChunksCached(context, tileRange, options.cacheBust);
      if (cachedChunks.length > 0) {
        drawTileChunks(ctx, cachedChunks, tileRange, fallbackAtlas());
        void this.redrawTileWithAtlas(canvas, coords, context);
      }
      if (!chunksReady) {
        return;
      }

      await chunksReady;
      if (!this.isCurrentTileContext(context)) {
        return;
      }

      const freshChunks = chunksFromCache(this.chunkCache, context.world, context.dimension, tileRange);
      if (freshChunks.length > 0) {
        drawTileChunks(ctx, freshChunks, tileRange, fallbackAtlas());
        void this.redrawTileWithAtlas(canvas, coords, context);
      }
    }

    private ensureTileChunksCached(context: TileDrawContext, tileRange: TileChunkRange, cacheBust?: string | number) {
      const pendingRequests = new Set<Promise<void>>();
      const uncachedChunks: Array<{ chunkX: number; chunkZ: number }> = [];
      for (let chunkZ = tileRange.minChunkZ; chunkZ <= tileRange.maxChunkZ; chunkZ += 1) {
        for (let chunkX = tileRange.minChunkX; chunkX <= tileRange.maxChunkX; chunkX += 1) {
          if (this.isOutsideKnownBounds(chunkX, chunkZ)) {
            continue;
          }
          const key = cacheKey(context.world, context.dimension, chunkX, chunkZ);
          if (this.chunkCache.has(key) || this.missingChunkCache.has(key)) {
            continue;
          }
          const pending = this.pendingChunkRequests.get(key);
          if (pending) {
            pendingRequests.add(pending);
            continue;
          }
          uncachedChunks.push({ chunkX, chunkZ });
        }
      }
      if (pendingRequests.size === 0 && uncachedChunks.length === 0) {
        return null;
      }
      const fetchRequests = chunkFetchRanges(uncachedChunks).map((range) =>
        this.fetchChunkRange(context, range, {
          cacheBust,
          onSettled: () => this.redrawVisibleTilesForRange(context, range),
        }),
      );
      return Promise.all([...pendingRequests, ...fetchRequests]).then(() => undefined);
    }

    private fetchChunkRange(
      context: TileDrawContext,
      range: ChunkFetchRange,
      options: { cacheBust?: string | number; onSettled?: () => void } = {},
    ) {
      const keys = chunkKeysForRange(context.world, context.dimension, range);
      let request: Promise<void>;
      request = fetchChunks(
        {
          world: context.world,
          dimension: context.dimension,
          minChunkX: range.minChunkX,
          maxChunkX: range.maxChunkX,
          minChunkZ: range.minChunkZ,
          maxChunkZ: range.maxChunkZ,
        },
        options.cacheBust === undefined ? {} : { cache: "no-store", cacheBust: options.cacheBust },
      )
        .then((response) => {
          for (const chunk of response.chunks) {
            const key = cacheKey(chunk.world, chunk.dimension, chunk.chunkX, chunk.chunkZ);
            this.chunkCache.set(key, chunk);
            this.missingChunkCache.delete(key);
          }
          for (const missing of response.missing) {
            this.missingChunkCache.add(cacheKey(context.world, context.dimension, missing.chunkX, missing.chunkZ));
          }
        })
        .finally(() => {
          for (const key of keys) {
            if (this.pendingChunkRequests.get(key) === request) {
              this.pendingChunkRequests.delete(key);
            }
          }
          options.onSettled?.();
        });
      for (const key of keys) {
        this.pendingChunkRequests.set(key, request);
      }
      return request;
    }

    private async redrawTileWithAtlas(canvas: HTMLCanvasElement, coords: Coords, context: TileDrawContext) {
      const atlas = await this.loadAtlas();
      if (!atlas.image || !this.isCurrentTileContext(context)) {
        return;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        return;
      }
      const tileRange = chunkRangeForTile(coords);
      const chunks = chunksFromCache(this.chunkCache, context.world, context.dimension, tileRange);
      if (chunks.length === 0) {
        return;
      }
      drawTileChunks(ctx, chunks, tileRange, atlas);
    }

    private redrawVisibleTilesForRange(context: TileDrawContext, range: ChunkFetchRange) {
      if (!this.isCurrentTileContext(context)) {
        return;
      }
      const internals = this as unknown as GridLayerInternals;
      for (const tile of Object.values(internals._tiles || {})) {
        if (!tile.current || !(tile.el instanceof HTMLCanvasElement) || !tileIntersectsChunkRange(tile.coords, range)) {
          continue;
        }
        void this.drawTile(tile.el, tile.coords, this.currentDrawContext(), { preserveExisting: true }).catch(() => undefined);
      }
    }

    private refreshVisibleTiles(changedChunk: { chunkX: number; chunkZ: number }, options: Pick<TileDrawOptions, "cacheBust"> = {}) {
      const internals = this as unknown as GridLayerInternals;
      let refreshed = false;
      for (const tile of Object.values(internals._tiles || {})) {
        if (!tile.current || !(tile.el instanceof HTMLCanvasElement) || !tileIntersectsChunk(tile.coords, changedChunk)) {
          continue;
        }
        refreshed = true;
        void this.drawTile(tile.el, tile.coords, this.currentDrawContext(), { preserveExisting: true, cacheBust: options.cacheBust }).catch(() => undefined);
      }
      if (!refreshed) {
        internals._update?.call(this);
      }
    }

    private isOutsideKnownBounds(chunkX: number, chunkZ: number) {
      return Boolean(
        this.knownBounds &&
          (chunkX < this.knownBounds.minChunkX || chunkX > this.knownBounds.maxChunkX || chunkZ < this.knownBounds.minChunkZ || chunkZ > this.knownBounds.maxChunkZ),
      );
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

interface ChunkFetchRange {
  minChunkX: number;
  maxChunkX: number;
  minChunkZ: number;
  maxChunkZ: number;
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
      const blockState = blockStateAt(chunk, index);
      const x = (worldX - range.minBlockX) * range.scale;
      const y = (worldZ - range.minBlockZ) * range.scale;
      drawBlock(ctx, atlas, blockId, blockState, x, y, range.scale, "base");
      const overlayBlockId = overlayBlockAt(chunk, index);
      if (overlayBlockId && overlayBlockId !== "minecraft:air") {
        drawBlock(ctx, atlas, overlayBlockId, overlayStateAt(chunk, index), x, y, range.scale, "overlay");
      }
    }
  }
}

function drawTileChunks(ctx: CanvasRenderingContext2D, chunks: ChunkSnapshot[], range: TileChunkRange, atlas: AtlasResource) {
  drawEmptyTile(ctx.canvas, "#17202a");
  for (const chunk of chunks) {
    drawChunk(ctx, chunk, range, atlas);
  }
  drawGrid(ctx, range);
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

function chunkFetchRanges(chunks: Array<{ chunkX: number; chunkZ: number }>): ChunkFetchRange[] {
  const byZ = new Map<number, number[]>();
  for (const chunk of chunks) {
    const row = byZ.get(chunk.chunkZ) || [];
    row.push(chunk.chunkX);
    byZ.set(chunk.chunkZ, row);
  }
  const ranges: ChunkFetchRange[] = [];
  for (const [chunkZ, chunkXs] of byZ) {
    chunkXs.sort((a, b) => a - b);
    let start = chunkXs[0];
    let end = start;
    for (let index = 1; index < chunkXs.length; index += 1) {
      const chunkX = chunkXs[index];
      if (chunkX === end + 1) {
        end = chunkX;
        continue;
      }
      ranges.push({ minChunkX: start, maxChunkX: end, minChunkZ: chunkZ, maxChunkZ: chunkZ });
      start = chunkX;
      end = chunkX;
    }
    ranges.push({ minChunkX: start, maxChunkX: end, minChunkZ: chunkZ, maxChunkZ: chunkZ });
  }
  return ranges;
}

function chunkKeysForRange(world: string, dimension: string, range: ChunkFetchRange) {
  const keys: string[] = [];
  for (let chunkZ = range.minChunkZ; chunkZ <= range.maxChunkZ; chunkZ += 1) {
    for (let chunkX = range.minChunkX; chunkX <= range.maxChunkX; chunkX += 1) {
      keys.push(cacheKey(world, dimension, chunkX, chunkZ));
    }
  }
  return keys;
}

function tileIntersectsChunk(coords: Pick<Coords, "x" | "y" | "z">, chunk: { chunkX: number; chunkZ: number }) {
  const range = chunkRangeForTile(coords);
  return chunk.chunkX >= range.minChunkX && chunk.chunkX <= range.maxChunkX && chunk.chunkZ >= range.minChunkZ && chunk.chunkZ <= range.maxChunkZ;
}

function tileIntersectsChunkRange(coords: Pick<Coords, "x" | "y" | "z">, chunkRange: ChunkFetchRange) {
  const tileRange = chunkRangeForTile(coords);
  return (
    tileRange.minChunkX <= chunkRange.maxChunkX &&
    tileRange.maxChunkX >= chunkRange.minChunkX &&
    tileRange.minChunkZ <= chunkRange.maxChunkZ &&
    tileRange.maxChunkZ >= chunkRange.minChunkZ
  );
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  atlas: AtlasResource,
  blockId: string,
  state: BlockStateMap,
  x: number,
  y: number,
  size: number,
  layer: "base" | "overlay" = "base",
) {
  if (drawStatefulPartialBlock(ctx, atlas, blockId, state, x, y, size, layer)) {
    return;
  }
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
    if (usesTransparentTextureUnderlay(blockId)) {
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

function drawStatefulPartialBlock(
  ctx: CanvasRenderingContext2D,
  atlas: AtlasResource,
  blockId: string,
  state: BlockStateMap,
  x: number,
  y: number,
  size: number,
  layer: "base" | "overlay",
) {
  const id = blockId.toLowerCase();
  if (id === "minecraft:cake" || id.endsWith(":cake") || id === "cake") {
    drawCakeBlock(ctx, blockId, state, x, y, size, layer);
    return true;
  }
  if (id === "minecraft:end_rod" || id.endsWith(":end_rod") || id === "end_rod") {
    drawEndRodBlock(ctx, blockId, state, x, y, size, layer);
    return true;
  }
  if (id.includes("trapdoor")) {
    drawTrapdoorBlock(ctx, atlas, blockId, state, x, y, size, layer);
    return true;
  }
  return false;
}

function drawCakeBlock(ctx: CanvasRenderingContext2D, blockId: string, state: BlockStateMap, x: number, y: number, size: number, layer: "base" | "overlay") {
  if (layer === "base") {
    ctx.fillStyle = fallbackTextureColor(blockId);
    ctx.fillRect(x, y, size, size);
  }
  const inset = Math.max(1, Math.floor(size * 0.12));
  const width = Math.max(1, size - inset * 2);
  const height = Math.max(1, size - inset * 2);
  const bite = Math.max(0, Math.min(6, stateNumber(state, "bite_counter", stateNumber(state, "bites", 0))));
  const biteWidth = bite > 0 ? Math.max(1, Math.round((width * bite) / 7)) : 0;
  const bodyWidth = Math.max(1, width - biteWidth);
  ctx.fillStyle = "#f4e7d7";
  ctx.fillRect(x + inset, y + inset, bodyWidth, height);
  ctx.fillStyle = "#c84b58";
  const spot = Math.max(1, Math.floor(size * 0.12));
  if (bodyWidth > spot * 2) {
    ctx.fillRect(x + inset + Math.floor(bodyWidth * 0.25), y + inset + Math.floor(height * 0.22), spot, spot);
    ctx.fillRect(x + inset + Math.floor(bodyWidth * 0.62), y + inset + Math.floor(height * 0.5), spot, spot);
  }
}

function drawEndRodBlock(ctx: CanvasRenderingContext2D, blockId: string, state: BlockStateMap, x: number, y: number, size: number, layer: "base" | "overlay") {
  if (layer === "base") {
    ctx.fillStyle = fallbackTextureColor(blockId);
    ctx.fillRect(x, y, size, size);
  }
  const vertical = isVerticalFacing(stateValue(state, "facing_direction", stateValue(state, "facing", "up")));
  const rodLength = Math.max(2, Math.floor(size * 0.78));
  const rodWidth = Math.max(1, Math.floor(size * 0.18));
  const cap = Math.max(1, Math.floor(size * 0.28));
  ctx.fillStyle = "#e9e3c4";
  if (vertical) {
    const rodX = x + Math.floor((size - rodWidth) / 2);
    const rodY = y + Math.floor((size - rodLength) / 2);
    ctx.fillRect(rodX, rodY, rodWidth, rodLength);
    ctx.fillStyle = "#fff7d8";
    ctx.fillRect(x + Math.floor((size - cap) / 2), y + Math.floor((size - cap) / 2), cap, cap);
  } else {
    const rodX = x + Math.floor((size - rodLength) / 2);
    const rodY = y + Math.floor((size - rodWidth) / 2);
    ctx.fillRect(rodX, rodY, rodLength, rodWidth);
    ctx.fillStyle = "#fff7d8";
    ctx.fillRect(x + Math.floor((size - cap) / 2), y + Math.floor((size - cap) / 2), cap, cap);
  }
}

function drawTrapdoorBlock(
  ctx: CanvasRenderingContext2D,
  atlas: AtlasResource,
  blockId: string,
  state: BlockStateMap,
  x: number,
  y: number,
  size: number,
  layer: "base" | "overlay",
) {
  if (layer === "base") {
    ctx.fillStyle = fallbackTextureColor(blockId);
    ctx.fillRect(x, y, size, size);
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  const open = stateBool(state, "open_bit", stateBool(state, "open", false));
  const half = String(stateValue(state, "upside_down_bit", stateValue(state, "half", "bottom"))).toLowerCase();
  const facing = stateValue(state, "direction", stateValue(state, "facing_direction", stateValue(state, "facing", "south")));
  if (!open) {
    const inset = Math.max(0, Math.floor(size * 0.08));
    const thickness = half === "top" || half === "true" || half === "1" ? Math.max(1, Math.floor(size * 0.72)) : Math.max(1, Math.floor(size * 0.82));
    if (entry && atlas.image) {
      drawAtlasEntry(ctx, atlas.image, entry, x + inset, y + inset, Math.max(1, size - inset * 2));
    } else {
      ctx.fillStyle = fallbackTextureColor(blockId);
      ctx.fillRect(x + inset, y + inset, Math.max(1, size - inset * 2), thickness);
    }
    return;
  }

  const edge = facingEdge(facing);
  const thickness = Math.max(1, Math.floor(size * 0.2));
  ctx.fillStyle = fallbackTextureColor(blockId);
  if (edge === "north") {
    ctx.fillRect(x, y, size, thickness);
  } else if (edge === "south") {
    ctx.fillRect(x, y + size - thickness, size, thickness);
  } else if (edge === "west") {
    ctx.fillRect(x, y, thickness, size);
  } else {
    ctx.fillRect(x + size - thickness, y, thickness, size);
  }
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

function blockStateAt(chunk: ChunkSnapshot, index: number): BlockStateMap {
  return chunk.blockStates?.[index] || {};
}

function overlayStateAt(chunk: ChunkSnapshot, index: number): BlockStateMap {
  return chunk.overlayStates?.[index] || {};
}

function fixedChunkArray(values: number[] | undefined, fallback: number) {
  if (values && values.length === 256) {
    return values;
  }
  return Array.from({ length: 256 }, () => fallback);
}

function fixedStateArray(values: BlockStateMap[] | undefined) {
  if (values && values.length === 256) {
    return values;
  }
  return Array.from({ length: 256 }, () => ({}));
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
    id.includes("cake") ||
    id.includes("candle") ||
    id.includes("end_rod") ||
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
    id.includes("end_rod") ||
    id.includes("head") ||
    id.includes("lantern") ||
    id.includes("skull")
  );
}

function stateValue(state: BlockStateMap, key: string, fallback: unknown) {
  return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : fallback;
}

function stateNumber(state: BlockStateMap, key: string, fallback: number) {
  const value = stateValue(state, key, fallback);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stateBool(state: BlockStateMap, key: string, fallback: boolean) {
  const value = stateValue(state, key, fallback);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const text = String(value).toLowerCase();
  if (text === "true" || text === "1") {
    return true;
  }
  if (text === "false" || text === "0") {
    return false;
  }
  return fallback;
}

function isVerticalFacing(value: unknown) {
  const text = String(value).toLowerCase();
  return text === "0" || text === "1" || text === "up" || text === "down";
}

function facingEdge(value: unknown): "north" | "south" | "east" | "west" {
  const text = String(value).toLowerCase();
  if (text === "2" || text === "north") {
    return "north";
  }
  if (text === "3" || text === "east") {
    return "east";
  }
  if (text === "1" || text === "west") {
    return "west";
  }
  return "south";
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

function fallbackAtlas(): AtlasResource {
  return {
    manifest: { version: 1, tileSize: 16, atlas: "", blocks: {} },
    image: null,
  };
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

export function usesTransparentTextureUnderlay(blockId: string) {
  const id = blockId.toLowerCase();
  return (
    isLikelyTransparentTextureBlock(id) ||
    id.includes("glass") ||
    id.includes("bubble_column") ||
    id.includes("copper_grate") ||
    id.includes("grate") ||
    id.includes("slime") ||
    id.includes("honey_block")
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
