import type { Coords, DoneCallback, GridLayer } from "leaflet";

import { fallbackTextureColor, usesMapTint } from "../../../shared/blockColors.mjs";
import { mapImageTileUrl, type TilesReadyMessage } from "../api";
import { blockToChunk } from "./coords";

const BLOCKS_PER_CHUNK = 16;
const TILE_SIZE = 256;
const MAX_ZOOM = 4;
const TILE_KEEP_BUFFER = 1;
const TILE_UPDATE_INTERVAL_MS = 150;

export const MIN_MAP_ZOOM = -8;
export const INITIAL_MAP_ZOOM = 4;

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
}

export interface ChunkLayerHandle extends GridLayer {
  setActive: (active: boolean) => void;
  setKnownBounds: (bounds: ChunkLayerBounds | null, tileVersion?: string | number) => void;
  setWorldDimension: (world: string, dimension: string) => void;
  refreshTiles: (message: TilesReadyMessage) => void;
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

export interface ChunkFetchRange {
  minChunkX: number;
  maxChunkX: number;
  minChunkZ: number;
  maxChunkZ: number;
}

interface TileChunkRange extends ChunkFetchRange {
  minBlockX: number;
  maxBlockX: number;
  minBlockZ: number;
  maxBlockZ: number;
  scale: number;
}

export function createChunkGridLayer(L: typeof import("leaflet"), world: string, dimension: string, options: ChunkLayerOptions = {}): ChunkLayerHandle {
  class ChunkGridLayer extends L.GridLayer implements ChunkLayerHandle {
    private worldName = world;
    private dimensionName = dimension;
    private knownBounds = options.bounds || null;
    private active = false;
    private baseImageTileVersion: string | number | undefined;
    private imageTileVersions = new Map<string, string | number>();

    setActive(active: boolean) {
      if (this.active === active) {
        return;
      }
      this.active = active;
      this.redraw();
    }

    setKnownBounds(bounds: ChunkLayerBounds | null, tileVersion?: string | number) {
      const boundsChanged = !sameBounds(this.knownBounds, bounds);
      this.knownBounds = bounds;
      const versionInitialized = tileVersion !== undefined && this.baseImageTileVersion === undefined;
      if (versionInitialized) {
        this.baseImageTileVersion = tileVersion;
      }
      if (boundsChanged) {
        this.redraw();
      } else if (versionInitialized) {
        this.redrawVisibleImageTiles();
      }
    }

    setWorldDimension(nextWorld: string, nextDimension: string) {
      if (this.worldName === nextWorld && this.dimensionName === nextDimension) {
        return;
      }
      this.worldName = nextWorld;
      this.dimensionName = nextDimension;
      this.active = false;
      this.knownBounds = null;
      this.baseImageTileVersion = undefined;
      this.imageTileVersions.clear();
      this.redraw();
    }

    refreshTiles(message: TilesReadyMessage) {
      const chunks = message.chunks.filter((chunk) => sameWorldDimension(chunk.world, chunk.dimension, this.worldName, this.dimensionName));
      const tiles = (message.tiles || []).filter((tile) => sameWorldDimension(tile.world, tile.dimension, this.worldName, this.dimensionName));
      if (chunks.length === 0 && tiles.length === 0) {
        return;
      }
      const changedKeys = new Set<string>();
      if (tiles.length > 0) {
        for (const tile of tiles) {
          const key = imageTileKey({ x: tile.tileX, y: tile.tileZ, z: tile.zoom });
          this.imageTileVersions.set(key, tile.updatedAt || message.updatedAt || Date.now());
          changedKeys.add(key);
        }
      } else {
        const legacyVersion = message.updatedAt || Date.now();
        for (const chunk of chunks) {
          for (const key of imageTileKeysForChunk(chunk)) {
            this.imageTileVersions.set(key, legacyVersion);
            changedKeys.add(key);
          }
        }
      }
      this.refreshVisibleTilesForUpdates(changedKeys);
    }

    getBlockInfo(x: number, z: number): BlockInfo | null {
      const position = blockToChunk(x, z);
      return {
        ...position,
        block: this.active ? "已渲染瓦片" : "未加载",
        height: Number.NaN,
      };
    }

    createTile(coords: Coords, done: DoneCallback): HTMLElement {
      if (
        !this.active ||
        this.baseImageTileVersion === undefined ||
        !tileIntersectsChunkBounds(coords, this.knownBounds)
      ) {
        return this.createBlankTile(done);
      }
      const image = document.createElement("img");
      image.width = TILE_SIZE;
      image.height = TILE_SIZE;
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.className = "chunk-tile chunk-image-tile";
      image.src = this.imageTileSrc(coords);
      image.onload = () => {
        if (image.naturalWidth < 2 || image.naturalHeight < 2) {
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

    private createBlankTile(done: DoneCallback): HTMLElement {
      const tile = document.createElement("div");
      tile.className = "chunk-tile chunk-image-tile chunk-image-tile-missing";
      tile.style.width = `${TILE_SIZE}px`;
      tile.style.height = `${TILE_SIZE}px`;
      window.setTimeout(() => done(undefined, tile), 0);
      return tile;
    }

    private imageTileSrc(coords: Coords) {
      const version = this.imageTileVersions.get(imageTileKey(coords)) ?? this.baseImageTileVersion;
      return mapImageTileUrl(this.worldName, this.dimensionName, coords.z, coords.x, coords.y, version);
    }

    private refreshVisibleTilesForUpdates(changedKeys: Set<string>) {
      const internals = this as unknown as GridLayerInternals;
      for (const tile of Object.values(internals._tiles || {})) {
        if (!changedKeys.has(imageTileKey(tile.coords))) {
          continue;
        }
        if (tile.el instanceof HTMLImageElement) {
          tile.el.classList.remove("chunk-image-tile-missing");
          tile.el.src = this.imageTileSrc(tile.coords);
        }
      }
    }

    private redrawVisibleImageTiles() {
      const internals = this as unknown as GridLayerInternals;
      for (const record of Object.values(internals._tiles || {})) {
        if (!(record.el instanceof HTMLImageElement)) {
          continue;
        }
        record.el.classList.remove("chunk-image-tile-missing");
        record.el.src = this.imageTileSrc(record.coords);
      }
    }
  }

  return new ChunkGridLayer({
    tileSize: TILE_SIZE,
    minZoom: MIN_MAP_ZOOM,
    maxZoom: MAX_ZOOM,
    noWrap: false,
    updateWhenIdle: false,
    updateInterval: TILE_UPDATE_INTERVAL_MS,
    updateWhenZooming: true,
    keepBuffer: TILE_KEEP_BUFFER,
    className: "chunk-grid-layer",
  }) as ChunkLayerHandle;
}

export function imageTileKey(coords: Pick<Coords, "x" | "y" | "z">) {
  return `${coords.z}/${coords.x}/${coords.y}`;
}

export function imageTileKeysForChunk(chunk: { chunkX: number; chunkZ: number }) {
  const keys: string[] = [];
  for (let zoom = MIN_MAP_ZOOM; zoom <= MAX_ZOOM; zoom += 1) {
    const chunksPerTile = 2 ** (MAX_ZOOM - zoom);
    keys.push(
      imageTileKey({
        x: Math.floor(chunk.chunkX / chunksPerTile),
        y: Math.floor(chunk.chunkZ / chunksPerTile),
        z: zoom,
      }),
    );
  }
  return keys;
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
  const maxBlockZ = Math.ceil(maxLeafletY) - 1;

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

export function lowZoomTileCoverage(coords: Pick<Coords, "x" | "y" | "z">): ChunkFetchRange {
  const range = chunkRangeForTile(coords);
  return {
    minChunkX: range.minChunkX,
    maxChunkX: range.maxChunkX,
    minChunkZ: range.minChunkZ,
    maxChunkZ: range.maxChunkZ,
  };
}

export function isImageTileZoom(zoom: number) {
  return zoom >= MIN_MAP_ZOOM && zoom <= MAX_ZOOM;
}

export function tileIntersectsChunkBounds(coords: Pick<Coords, "x" | "y" | "z">, bounds: ChunkLayerBounds | null) {
  if (!bounds) {
    return true;
  }
  const range = lowZoomTileCoverage(coords);
  return !(range.maxChunkX < bounds.minChunkX || range.minChunkX > bounds.maxChunkX || range.maxChunkZ < bounds.minChunkZ || range.minChunkZ > bounds.maxChunkZ);
}

export function chunkFetchRanges(chunks: Array<{ chunkX: number; chunkZ: number }>): ChunkFetchRange[] {
  return chunks.map((chunk) => ({ minChunkX: chunk.chunkX, maxChunkX: chunk.chunkX, minChunkZ: chunk.chunkZ, maxChunkZ: chunk.chunkZ }));
}

export function usesTransparentTextureUnderlay(blockId: string) {
  const id = blockId.toLowerCase();
  return id.includes("glass") || id.includes("ice") || id.includes("leaves") || id.includes("grate");
}

export function slabHalfForState(state: Record<string, unknown>) {
  return String(state["minecraft:vertical_half"] || state.vertical_half || state.slab_type || "bottom");
}

export function blockFacingEdgeForState(state: Record<string, unknown>) {
  const raw = state.direction ?? state.facing_direction ?? state.cardinal_direction ?? state.facing ?? "north";
  if (typeof raw === "number") {
    return ["south", "west", "north", "east"][Math.abs(raw) % 4] || "north";
  }
  const text = String(raw).toLowerCase();
  return text.includes("east") ? "east" : text.includes("west") ? "west" : text.includes("south") ? "south" : "north";
}

function sameWorldDimension(leftWorld: string | undefined, leftDimension: string | undefined, rightWorld: string, rightDimension: string) {
  return segmentKey(leftWorld || "") === segmentKey(rightWorld) && segmentKey(leftDimension || "") === segmentKey(rightDimension);
}

function sameBounds(left: ChunkLayerBounds | null, right: ChunkLayerBounds | null) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.minChunkX === right.minChunkX && left.maxChunkX === right.maxChunkX && left.minChunkZ === right.minChunkZ && left.maxChunkZ === right.maxChunkZ;
}

function segmentKey(value: string): string {
  return String(value).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

function floorDiv(value: number, divisor: number) {
  return Math.floor(value / divisor);
}

export { fallbackTextureColor, usesMapTint };
