export interface PlayerState {
  id: string;
  name: string;
  world: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  updatedAt: number;
}

export interface ChunkSnapshot {
  world: string;
  dimension: string;
  chunkX: number;
  chunkZ: number;
  palette: string[];
  blocks: number[];
  heights: number[];
  overlayBlocks?: number[];
  overlayHeights?: number[];
  updatedAt: number;
}

export interface ChunkQuery {
  world: string;
  dimension: string;
  minChunkX: number;
  maxChunkX: number;
  minChunkZ: number;
  maxChunkZ: number;
}

export interface ChunkFetchOptions {
  cacheBust?: string | number;
  cache?: RequestCache;
}

export interface ChunkResponse {
  chunks: ChunkSnapshot[];
  missing: Array<{ chunkX: number; chunkZ: number }>;
}

export interface TextureAtlasEntry {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextureManifest {
  version: number;
  tileSize: number;
  atlas: string;
  blocks: Record<string, TextureAtlasEntry>;
}

export interface WorldMeta {
  version: number;
  world: string;
  dimension: string;
  status: string;
  chunkCount: number;
  importedAt: number;
  updatedAt: number;
  bounds: {
    minChunkX: number;
    maxChunkX: number;
    minChunkZ: number;
    maxChunkZ: number;
    minBlockX: number;
    maxBlockX: number;
    minBlockZ: number;
    maxBlockZ: number;
  };
  topBlocks: Record<string, number>;
}

export interface BlockUpdate {
  localX: number;
  localZ: number;
  block: string;
  height: number;
  overlayBlock?: string;
  overlayHeight?: number;
}

export interface ChunkReadyMessage {
  type: "chunk_ready";
  world: string;
  dimension: string;
  chunkX: number;
  chunkZ: number;
  updatedAt: number;
}

export interface BlockUpdatesMessage {
  type: "block_updates";
  world: string;
  dimension: string;
  chunkX: number;
  chunkZ: number;
  updates: BlockUpdate[];
  updatedAt: number;
}

export interface LiveMessage {
  type: "player_snapshot" | "chunk_ready" | "block_updates" | "heartbeat";
  players?: PlayerState[];
  world?: string;
  dimension?: string;
  chunkX?: number;
  chunkZ?: number;
  updates?: BlockUpdate[];
  updatedAt?: number;
}

export function chunkUrl(query: ChunkQuery, options: ChunkFetchOptions = {}): string {
  const params = new URLSearchParams({
    world: query.world,
    dimension: query.dimension,
    minChunkX: String(query.minChunkX),
    maxChunkX: String(query.maxChunkX),
    minChunkZ: String(query.minChunkZ),
    maxChunkZ: String(query.maxChunkZ),
  });
  if (options.cacheBust !== undefined) {
    params.set("_", String(options.cacheBust));
  }
  return `/api/chunks?${params.toString()}`;
}

export async function fetchChunks(query: ChunkQuery, options: ChunkFetchOptions = {}): Promise<ChunkResponse> {
  try {
    const response = await fetch(chunkUrl(query, options), { cache: options.cache });
    if (!response.ok) {
      throw new Error(`Failed to load chunks: ${response.status}`);
    }
    return (await response.json()) as ChunkResponse;
  } catch (error) {
    if (import.meta.env.DEV) {
      const { mockChunks } = await import("./mockData");
      return {
        chunks: mockChunks.filter(
          (chunk) =>
            chunk.world === query.world &&
            chunk.dimension === query.dimension &&
            chunk.chunkX >= query.minChunkX &&
            chunk.chunkX <= query.maxChunkX &&
            chunk.chunkZ >= query.minChunkZ &&
            chunk.chunkZ <= query.maxChunkZ,
        ),
        missing: [],
      };
    }
    throw error;
  }
}

export async function fetchTextureManifest(): Promise<TextureManifest> {
  const response = await fetch("/api/textures/manifest");
  if (!response.ok) {
    throw new Error(`Failed to load texture manifest: ${response.status}`);
  }
  return (await response.json()) as TextureManifest;
}

export function textureAtlasUrl(manifest: TextureManifest): string {
  return manifest.atlas || "/textures/atlas.png";
}

export function segmentKey(value: string): string {
  return String(value).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 80);
}

export async function listWorlds(): Promise<WorldMeta[]> {
  try {
    const response = await fetch("/api/worlds");
    if (!response.ok) {
      throw new Error(`Failed to load worlds: ${response.status}`);
    }
    const data = (await response.json()) as { worlds: WorldMeta[] };
    return data.worlds;
  } catch (error) {
    if (import.meta.env.DEV) {
      const { mockWorlds } = await import("./mockData");
      return mockWorlds;
    }
    throw error;
  }
}

export function liveUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/live`;
}
