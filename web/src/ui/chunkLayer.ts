import type { Coords, DoneCallback, GridLayer } from "leaflet";

import { fallbackTextureColor, usesMapTint as usesSharedMapTint } from "../../../shared/blockColors.mjs";
import {
  fetchChunks,
  fetchTextureManifest,
  mapImageTileUrl,
  segmentKey,
  textureAtlasUrl,
  type BlockStateMap,
  type BlockUpdatesMessage,
  type ChunkReadyMessage,
  type ChunksReadyMessage,
  type ChunkSnapshot,
  type TextureAtlasEntry,
  type TextureManifest,
} from "../api";
import { blockColumnIndex, blockToChunk } from "./coords";
import { isLikelyTransparentTextureBlock, isMapDecorationBlock, isPlantBlock } from "./mapBlocks";

export { fallbackTextureColor };

const BLOCKS_PER_CHUNK = 16;
const TILE_SIZE = 256;
export const MIN_MAP_ZOOM = -1;
const MAX_ZOOM = 4;
const IMAGE_TILE_MAX_ZOOM = 3;
const TILE_KEEP_BUFFER = 2;
const MAX_CHUNKS_PER_FETCH = 256;
const SEA_LEVEL = 63;
const MIN_COLUMN_HEIGHT = -64;

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
  setKnownBounds: (bounds: ChunkLayerBounds | null, tileVersion?: string | number) => void;
  setWorldDimension: (world: string, dimension: string) => void;
  refreshChunk: (message: ChunkReadyMessage) => void;
  refreshChunks: (message: ChunksReadyMessage) => void;
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
    private pendingRedrawRanges: ChunkFetchRange[] = [];
    private pendingRedrawFrame = 0;
    private dataVersion = 0;
    private imageTileVersion: string | number = 0;
    private atlasPromise: Promise<AtlasResource> | null = null;

    setActive(active: boolean) {
      if (this.active === active) {
        return;
      }
      this.active = active;
      this.dataVersion += 1;
      this.redraw();
    }

    setKnownBounds(bounds: ChunkLayerBounds | null, tileVersion?: string | number) {
      this.knownBounds = bounds;
      if (tileVersion !== undefined && this.imageTileVersion !== tileVersion) {
        this.imageTileVersion = tileVersion;
        this.redrawVisibleImageTiles();
      }
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
      this.imageTileVersion = this.dataVersion;
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
      this.imageTileVersion = message.tileVersion || message.updatedAt || this.dataVersion;
      this.refreshVisibleTiles({ chunkX: message.chunkX, chunkZ: message.chunkZ }, { cacheBust: message.updatedAt || this.dataVersion });
    }

    refreshChunks(message: ChunksReadyMessage) {
      if (!sameWorldDimension(message.world, message.dimension, this.worldName, this.dimensionName)) {
        return;
      }
      const chunks = message.chunks.filter((chunk) => typeof chunk.chunkX === "number" && typeof chunk.chunkZ === "number");
      if (chunks.length < 1) {
        return;
      }
      for (const chunk of chunks) {
        const key = cacheKey(message.world, message.dimension, chunk.chunkX, chunk.chunkZ);
        this.chunkCache.delete(key);
        this.missingChunkCache.delete(key);
      }
      this.dataVersion += 1;
      this.imageTileVersion = message.tileVersion || message.updatedAt || this.dataVersion;
      this.refreshVisibleTilesForChunks(chunks, { cacheBust: message.updatedAt || this.dataVersion });
    }

    applyBlockUpdates(message: BlockUpdatesMessage) {
      if (!sameWorldDimension(message.world, message.dimension, this.worldName, this.dimensionName)) {
        return;
      }
      this.dataVersion += 1;
      this.imageTileVersion = message.tileVersion || message.updatedAt || this.dataVersion;
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
      if (isImageTileZoom(coords.z)) {
        if (!tileIntersectsChunkBounds(coords, this.knownBounds)) {
          return this.createBlankImageTile(done);
        }
        return this.createImageTile(coords, done);
      }
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

    private createImageTile(coords: Coords, done: DoneCallback): HTMLElement {
      const image = document.createElement("img");
      image.width = TILE_SIZE;
      image.height = TILE_SIZE;
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.className = "chunk-tile chunk-image-tile";
      image.src = this.imageTileSrc(coords);
      image.onload = () => {
        if (image.naturalWidth < TILE_SIZE || image.naturalHeight < TILE_SIZE) {
          image.classList.add("chunk-image-tile-missing");
        }
        done(undefined, image);
      };
      image.onerror = () => {
        image.classList.add("chunk-image-tile-missing");
        done(undefined, image);
      };
      return image;
    }

    private createBlankImageTile(done: DoneCallback): HTMLElement {
      const tile = document.createElement("div");
      tile.className = "chunk-tile chunk-image-tile chunk-image-tile-missing";
      tile.style.width = `${TILE_SIZE}px`;
      tile.style.height = `${TILE_SIZE}px`;
      window.setTimeout(() => done(undefined, tile), 0);
      return tile;
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
          onSettled: () => this.queueVisibleTileRedrawForRange(context, range),
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

    private queueVisibleTileRedrawForRange(context: TileDrawContext, range: ChunkFetchRange) {
      if (!this.isCurrentTileContext(context)) {
        return;
      }
      this.pendingRedrawRanges.push(range);
      if (this.pendingRedrawFrame) {
        return;
      }
      this.pendingRedrawFrame = window.requestAnimationFrame(() => {
        this.pendingRedrawFrame = 0;
        const ranges = this.pendingRedrawRanges;
        this.pendingRedrawRanges = [];
        this.redrawVisibleTilesForRanges(context, ranges);
      });
    }

    private redrawVisibleTilesForRanges(context: TileDrawContext, ranges: ChunkFetchRange[]) {
      if (!this.isCurrentTileContext(context) || ranges.length === 0) {
        return;
      }
      const internals = this as unknown as GridLayerInternals;
      for (const tile of Object.values(internals._tiles || {})) {
        if (!tile.current || !ranges.some((range) => tileIntersectsChunkRange(tile.coords, range))) {
          continue;
        }
        if (tile.el instanceof HTMLImageElement) {
          this.refreshImageTile(tile.el, tile.coords);
        } else if (tile.el instanceof HTMLCanvasElement) {
          void this.drawTile(tile.el, tile.coords, this.currentDrawContext(), { preserveExisting: true }).catch(() => undefined);
        }
      }
    }

    private refreshVisibleTiles(changedChunk: { chunkX: number; chunkZ: number }, options: Pick<TileDrawOptions, "cacheBust"> = {}) {
      this.refreshVisibleTilesForChunks([changedChunk], options);
    }

    private refreshVisibleTilesForChunks(changedChunks: { chunkX: number; chunkZ: number }[], options: Pick<TileDrawOptions, "cacheBust"> = {}) {
      const internals = this as unknown as GridLayerInternals;
      let refreshed = false;
      for (const tile of Object.values(internals._tiles || {})) {
        if (!tile.current || !changedChunks.some((chunk) => tileIntersectsChunk(tile.coords, chunk))) {
          continue;
        }
        refreshed = true;
        if (tile.el instanceof HTMLImageElement) {
          this.refreshImageTile(tile.el, tile.coords);
        } else if (tile.el instanceof HTMLCanvasElement) {
          void this.drawTile(tile.el, tile.coords, this.currentDrawContext(), { preserveExisting: true, cacheBust: options.cacheBust }).catch(() => undefined);
        }
      }
      if (!refreshed) {
        internals._update?.call(this);
      }
    }

    private refreshImageTile(image: HTMLImageElement, coords: Coords) {
      image.classList.remove("chunk-image-tile-missing");
      image.src = this.imageTileSrc(coords);
    }

    private redrawVisibleImageTiles() {
      const internals = this as unknown as GridLayerInternals;
      for (const record of Object.values(internals._tiles || {})) {
        if (!record.current || !isImageTileZoom(record.coords.z) || !(record.el instanceof HTMLImageElement)) {
          continue;
        }
        this.refreshImageTile(record.el, record.coords);
      }
    }

    private imageTileSrc(coords: Coords) {
      return mapImageTileUrl(this.worldName, this.dimensionName, coords.z, coords.x, coords.y, this.imageTileVersion);
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
    minZoom: MIN_MAP_ZOOM,
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

export interface ChunkFetchRange {
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

export function isImageTileZoom(zoom: number) {
  return zoom >= MIN_MAP_ZOOM && zoom <= IMAGE_TILE_MAX_ZOOM;
}

export function lowZoomTileCoverage(coords: Pick<Coords, "x" | "y" | "z">): ChunkFetchRange {
  const range = chunkRangeForTile(coords);
  return {
    minChunkX: range.minChunkX,
    maxChunkX: range.maxChunkX,
    minChunkZ: range.minChunkZ,
    maxChunkZ: range.maxChunkZ,
  };
}

export function tileIntersectsChunkBounds(coords: Pick<Coords, "x" | "y" | "z">, bounds: ChunkLayerBounds | null) {
  if (!bounds) {
    return true;
  }
  const range = lowZoomTileCoverage(coords);
  return !(range.maxChunkX < bounds.minChunkX || range.minChunkX > bounds.maxChunkX || range.maxChunkZ < bounds.minChunkZ || range.minChunkZ > bounds.maxChunkZ);
}

function drawChunk(ctx: CanvasRenderingContext2D, chunk: ChunkSnapshot, range: TileChunkRange, atlas: AtlasResource, chunksByCoord: Map<string, ChunkSnapshot>) {
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
      applyColumnShade(ctx, chunk.heights[index] ?? MIN_COLUMN_HEIGHT, worldX, worldZ, chunksByCoord, x, y, range.scale);
    }
  }
}

function drawTileChunks(ctx: CanvasRenderingContext2D, chunks: ChunkSnapshot[], range: TileChunkRange, atlas: AtlasResource) {
  drawEmptyTile(ctx.canvas, "#17202a");
  const chunksByCoord = new Map(chunks.map((chunk) => [coordKey(chunk.chunkX, chunk.chunkZ), chunk]));
  for (const chunk of chunks) {
    drawChunk(ctx, chunk, range, atlas, chunksByCoord);
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

function coordKey(chunkX: number, chunkZ: number) {
  return `${chunkX},${chunkZ}`;
}

function applyColumnShade(ctx: CanvasRenderingContext2D, height: number, worldX: number, worldZ: number, chunksByCoord: Map<string, ChunkSnapshot>, x: number, y: number, size: number) {
  let darkAlpha = 0;
  let lightAlpha = 0;
  let blueAlpha = 0;
  if (height < SEA_LEVEL) {
    const depth = clamp((SEA_LEVEL - height) / 48, 0, 1);
    darkAlpha += 0.08 + depth * 0.16;
    blueAlpha += 0.06 + depth * 0.12;
  } else if (height <= 100) {
    darkAlpha += 0.035 - clamp((height - SEA_LEVEL) / 37, 0, 1) * 0.02;
  } else if (height <= 150) {
    lightAlpha += 0.025 + ((height - 100) / 50) * 0.035;
  } else {
    lightAlpha += 0.07 + Math.min(0.04, (height - 150) / 600);
  }

  const north = getColumnHeight(chunksByCoord, worldX, worldZ - 1, height);
  const west = getColumnHeight(chunksByCoord, worldX - 1, worldZ, height);
  const northwest = getColumnHeight(chunksByCoord, worldX - 1, worldZ - 1, height);
  const east = getColumnHeight(chunksByCoord, worldX + 1, worldZ, height);
  const south = getColumnHeight(chunksByCoord, worldX, worldZ + 1, height);
  const shadeDrop = Math.max(0, height - north, height - west, height - northwest);
  const lightLift = Math.max(0, height - east, height - south);
  darkAlpha += Math.min(0.16, shadeDrop * 0.014);
  lightAlpha += Math.min(0.055, lightLift * 0.008);

  if (darkAlpha > 0) {
    ctx.fillStyle = `rgba(0, 0, 0, ${clamp(darkAlpha, 0, 0.24)})`;
    ctx.fillRect(x, y, size, size);
  }
  if (blueAlpha > 0) {
    ctx.fillStyle = `rgba(36, 92, 148, ${clamp(blueAlpha, 0, 0.18)})`;
    ctx.fillRect(x, y, size, size);
  }
  if (lightAlpha > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${clamp(lightAlpha, 0, 0.11)})`;
    ctx.fillRect(x, y, size, size);
  }
}

function getColumnHeight(chunksByCoord: Map<string, ChunkSnapshot>, worldX: number, worldZ: number, fallbackHeight: number) {
  const chunkX = floorDiv(worldX, BLOCKS_PER_CHUNK);
  const chunkZ = floorDiv(worldZ, BLOCKS_PER_CHUNK);
  const chunk = chunksByCoord.get(coordKey(chunkX, chunkZ));
  if (!chunk) {
    return fallbackHeight;
  }
  const localX = mod(worldX, BLOCKS_PER_CHUNK);
  const localZ = mod(worldZ, BLOCKS_PER_CHUNK);
  return chunk.heights[blockColumnIndex(localX, localZ)] ?? fallbackHeight;
}

export function chunkFetchRanges(chunks: Array<{ chunkX: number; chunkZ: number }>): ChunkFetchRange[] {
  const byZ = new Map<number, number[]>();
  for (const chunk of chunks) {
    const row = byZ.get(chunk.chunkZ) || [];
    row.push(chunk.chunkX);
    byZ.set(chunk.chunkZ, row);
  }
  const rowRanges: ChunkFetchRange[] = [];
  for (const [chunkZ, chunkXs] of [...byZ.entries()].sort((a, b) => a[0] - b[0])) {
    chunkXs.sort((a, b) => a - b);
    let start = chunkXs[0];
    let end = start;
    for (let index = 1; index < chunkXs.length; index += 1) {
      const chunkX = chunkXs[index];
      if (chunkX === end + 1) {
        end = chunkX;
        continue;
      }
      rowRanges.push({ minChunkX: start, maxChunkX: end, minChunkZ: chunkZ, maxChunkZ: chunkZ });
      start = chunkX;
      end = chunkX;
    }
    rowRanges.push({ minChunkX: start, maxChunkX: end, minChunkZ: chunkZ, maxChunkZ: chunkZ });
  }

  const ranges: ChunkFetchRange[] = [];
  for (const rowRange of rowRanges) {
    const previous = ranges.at(-1);
    if (
      previous &&
      previous.minChunkX === rowRange.minChunkX &&
      previous.maxChunkX === rowRange.maxChunkX &&
      previous.maxChunkZ + 1 === rowRange.minChunkZ &&
      chunkCountForRange({
        minChunkX: previous.minChunkX,
        maxChunkX: previous.maxChunkX,
        minChunkZ: previous.minChunkZ,
        maxChunkZ: rowRange.maxChunkZ,
      }) <= MAX_CHUNKS_PER_FETCH
    ) {
      previous.maxChunkZ = rowRange.maxChunkZ;
      continue;
    }
    ranges.push({ ...rowRange });
  }
  return ranges;
}

function chunkCountForRange(range: ChunkFetchRange) {
  return (range.maxChunkX - range.minChunkX + 1) * (range.maxChunkZ - range.minChunkZ + 1);
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
    ctx.fillStyle = fallbackTextureColor(blockId, state);
    ctx.fillRect(x, y, size, size);
    return;
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  if (atlas.image && entry) {
    if (usesTransparentTextureUnderlay(blockId)) {
      ctx.fillStyle = fallbackTextureColor(blockId, state);
      ctx.fillRect(x, y, size, size);
    }
    drawAtlasEntry(ctx, atlas.image, entry, x, y, size);
    return;
  }
  ctx.fillStyle = fallbackTextureColor(blockId, state);
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
  if (isSlabBlockId(id)) {
    drawSlabBlock(ctx, atlas, blockId, state, x, y, size, layer);
    return true;
  }
  if (isStairBlockId(id)) {
    drawStairBlock(ctx, atlas, blockId, state, x, y, size, layer);
    return true;
  }
  return false;
}

function drawCakeBlock(ctx: CanvasRenderingContext2D, blockId: string, state: BlockStateMap, x: number, y: number, size: number, layer: "base" | "overlay") {
  if (layer === "base") {
    ctx.fillStyle = fallbackTextureColor(blockId, state);
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
    ctx.fillStyle = fallbackTextureColor(blockId, state);
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
    ctx.fillStyle = fallbackTextureColor(blockId, state);
    ctx.fillRect(x, y, size, size);
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  const open = stateBool(state, "open_bit", stateBool(state, "open", false));
  const half = blockVerticalHalfForState(state);
  if (!open) {
    const inset = Math.max(0, Math.floor(size * 0.08));
    const thickness = Math.max(1, Math.floor(size * 0.72));
    const drawY = half === "top" ? y + Math.max(0, size - thickness - inset) : y + inset;
    if (entry && atlas.image) {
      drawAtlasEntry(ctx, atlas.image, entry, x + inset, y + inset, Math.max(1, size - inset * 2));
    } else {
      ctx.fillStyle = fallbackTextureColor(blockId, state);
      ctx.fillRect(x + inset, drawY, Math.max(1, size - inset * 2), thickness);
    }
    return;
  }

  const edge = blockFacingEdgeForState(state, blockId);
  const thickness = Math.max(1, Math.floor(size * 0.2));
  ctx.fillStyle = fallbackTextureColor(blockId, state);
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

function drawSlabBlock(
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
    ctx.fillStyle = fallbackTextureColor(blockId, state);
    ctx.fillRect(x, y, size, size);
  }
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  const half = slabHalfForState(state, blockId);
  const color = fallbackTextureColor(blockId, state);
  const inset = Math.max(0, Math.floor(size * 0.08));
  const height = half === "double" ? Math.max(1, size - inset * 2) : Math.max(1, Math.ceil((size - inset * 2) / 2));
  const drawY = half === "top" ? y + size - inset - height : y + inset;
  if (entry && atlas.image && half === "double") {
    drawAtlasEntry(ctx, atlas.image, entry, x + inset, y + inset, Math.max(1, size - inset * 2));
    return;
  }
  ctx.fillStyle = layer === "overlay" ? adjustHexBrightness(color, 1.08) : color;
  ctx.fillRect(x + inset, drawY, Math.max(1, size - inset * 2), height);
}

function drawStairBlock(
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
    ctx.fillStyle = fallbackTextureColor(blockId, state);
    ctx.fillRect(x, y, size, size);
  }
  const color = fallbackTextureColor(blockId, state);
  const half = blockVerticalHalfForState(state);
  const facing = blockFacingEdgeForState(state, blockId);
  const entry = atlas.manifest.blocks[blockId] || atlas.manifest.blocks[stripNamespace(blockId)] || null;
  if (entry && atlas.image) {
    const inset = Math.max(0, Math.floor(size * 0.08));
    drawAtlasEntry(ctx, atlas.image, entry, x + inset, y + inset, Math.max(1, size - inset * 2));
  }
  ctx.fillStyle = layer === "overlay" ? adjustHexBrightness(color, 1.1) : adjustHexBrightness(color, half === "top" ? 1.08 : 0.94);
  fillStairShape(ctx, x, y, size, facing);
}

function fillStairShape(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, facing: "north" | "south" | "east" | "west") {
  const inset = Math.max(0, Math.floor(size * 0.06));
  const span = Math.max(1, size - inset * 2);
  const half = Math.max(1, Math.ceil(span / 2));
  const x0 = x + inset;
  const y0 = y + inset;
  const xMid = x0 + Math.floor(span / 2);
  const yMid = y0 + Math.floor(span / 2);

  if (facing === "north") {
    ctx.fillRect(x0, y0, span, half);
    ctx.fillRect(x0, yMid, half, Math.max(1, span - half));
    return;
  }
  if (facing === "south") {
    ctx.fillRect(x0, yMid, span, Math.max(1, span - half));
    ctx.fillRect(xMid, y0, Math.max(1, span - half), half);
    return;
  }
  if (facing === "west") {
    ctx.fillRect(x0, y0, half, span);
    ctx.fillRect(xMid, y0, Math.max(1, span - half), half);
    return;
  }
  ctx.fillRect(xMid, y0, Math.max(1, span - half), span);
  ctx.fillRect(x0, yMid, half, Math.max(1, span - half));
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

function isSlabBlockId(id: string) {
  return id.includes("slab") && !id.includes("double_slab") && !id.includes("double_stone_slab");
}

function isStairBlockId(id: string) {
  return id.includes("stairs");
}

function isVerticalFacing(value: unknown) {
  const text = String(value).toLowerCase();
  return text === "0" || text === "1" || text === "up" || text === "down";
}

export function blockFacingEdgeForState(state: BlockStateMap, blockId = ""): "north" | "south" | "east" | "west" {
  const direction = stateNumberValue(state, ["direction", "minecraft:direction"]);
  if (direction !== null) {
    if (blockId.toLowerCase().includes("trapdoor")) {
      return trapdoorDirectionToEdge(direction);
    }
    return directionToEdge(direction);
  }

  const facingDirection = stateNumberValue(state, ["facing_direction", "minecraft:facing_direction"]);
  if (facingDirection !== null) {
    return facingDirectionToEdge(facingDirection);
  }

  const weirdoDirection = stateNumberValue(state, ["weirdo_direction", "minecraft:weirdo_direction"]);
  if (weirdoDirection !== null) {
    return weirdoDirectionToEdge(weirdoDirection);
  }

  const numericFacing = stateNumberValue(state, ["facing", "minecraft:facing"]);
  if (numericFacing !== null) {
    return directionToEdge(numericFacing);
  }

  const namedFacing = stateToken(state, [
    "facing",
    "minecraft:facing",
    "direction",
    "minecraft:direction",
    "facing_direction",
    "minecraft:facing_direction",
    "cardinal_direction",
    "minecraft:cardinal_direction",
  ]);
  if (namedFacing) {
    return namedFacingToEdge(namedFacing);
  }

  return "south";
}

export function slabHalfForState(state: BlockStateMap, blockId = ""): "top" | "bottom" | "double" {
  const id = blockId.toLowerCase();
  if (id.includes("double_slab") || id.includes("double_stone_slab")) {
    return "double";
  }
  const slabType = stateToken(state, [
    "stone_slab_type",
    "minecraft:stone_slab_type",
    "stone_slab_type_2",
    "minecraft:stone_slab_type_2",
    "stone_slab_type_3",
    "minecraft:stone_slab_type_3",
    "stone_slab_type_4",
    "minecraft:stone_slab_type_4",
    "slab_type",
    "minecraft:slab_type",
  ]);
  if (slabType === "double") {
    return "double";
  }
  return blockVerticalHalfForState(state);
}

function blockVerticalHalfForState(state: BlockStateMap): "top" | "bottom" {
  const verticalHalf = stateToken(state, ["minecraft:vertical_half", "vertical_half", "half", "minecraft:half"]);
  if (verticalHalf === "top" || verticalHalf === "upper" || verticalHalf === "up") {
    return "top";
  }
  if (verticalHalf === "bottom" || verticalHalf === "lower" || verticalHalf === "down") {
    return "bottom";
  }
  if (stateBool(state, "top_slot_bit", false) || stateBool(state, "upside_down_bit", false)) {
    return "top";
  }
  if (stateBool(state, "bottom_slot_bit", false)) {
    return "bottom";
  }
  return "bottom";
}

function stateToken(state: BlockStateMap, keys: string[]) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) {
      continue;
    }
    return stripNamespace(String(state[key]).toLowerCase());
  }
  return "";
}

function stateNumberValue(state: BlockStateMap, keys: string[]) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) {
      continue;
    }
    const numeric = Number(state[key]);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return null;
}

function namedFacingToEdge(value: string): "north" | "south" | "east" | "west" {
  if (value === "north") {
    return "north";
  }
  if (value === "east") {
    return "east";
  }
  if (value === "west") {
    return "west";
  }
  return "south";
}

function directionToEdge(value: number): "north" | "south" | "east" | "west" {
  const normalized = mod(value, 4);
  if (normalized === 1) {
    return "west";
  }
  if (normalized === 2) {
    return "north";
  }
  if (normalized === 3) {
    return "east";
  }
  return "south";
}

function trapdoorDirectionToEdge(value: number): "north" | "south" | "east" | "west" {
  const normalized = mod(value, 4);
  if (normalized === 0) {
    return "west";
  }
  if (normalized === 1) {
    return "east";
  }
  if (normalized === 2) {
    return "north";
  }
  return "south";
}

function weirdoDirectionToEdge(value: number): "north" | "south" | "east" | "west" {
  const normalized = mod(value, 4);
  if (normalized === 0) {
    return "east";
  }
  if (normalized === 1) {
    return "west";
  }
  if (normalized === 2) {
    return "south";
  }
  return "north";
}

function facingDirectionToEdge(value: number): "north" | "south" | "east" | "west" {
  if (value === 2) {
    return "north";
  }
  if (value === 3) {
    return "south";
  }
  if (value === 4) {
    return "west";
  }
  if (value === 5) {
    return "east";
  }
  return "south";
}

function adjustHexBrightness(hex: string, factor: number) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    return hex;
  }
  const value = match[1];
  const red = Math.max(0, Math.min(255, Math.round(Number.parseInt(value.slice(0, 2), 16) * factor)));
  const green = Math.max(0, Math.min(255, Math.round(Number.parseInt(value.slice(2, 4), 16) * factor)));
  const blue = Math.max(0, Math.min(255, Math.round(Number.parseInt(value.slice(4, 6), 16) * factor)));
  return `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
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

function mod(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeZero(value: number) {
  return Object.is(value, -0) ? 0 : value;
}

function stripNamespace(blockId: string) {
  return blockId.includes(":") ? blockId.slice(blockId.indexOf(":") + 1) : blockId;
}

export function usesMapTint(blockId: string) {
  return usesSharedMapTint(blockId);
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
