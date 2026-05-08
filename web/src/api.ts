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

export interface Marker {
  id: string;
  world: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  title: string;
  description: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export type MarkerDraft = Omit<Marker, "id" | "createdAt" | "updatedAt">;

export interface ChunkSnapshot {
  world: string;
  dimension: string;
  chunkX: number;
  chunkZ: number;
  palette: string[];
  blocks: number[];
  heights: number[];
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

export interface BlockUpdate {
  localX: number;
  localZ: number;
  block: string;
  height: number;
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
  type:
    | "player_snapshot"
    | "tile_ready"
    | "chunk_ready"
    | "block_updates"
    | "marker_created"
    | "marker_updated"
    | "marker_deleted"
    | "heartbeat";
  players?: PlayerState[];
  marker?: Marker;
  id?: string;
  world?: string;
  dimension?: string;
  chunkX?: number;
  chunkZ?: number;
  updates?: BlockUpdate[];
  updatedAt?: number;
}

export function chunkUrl(query: ChunkQuery): string {
  const params = new URLSearchParams({
    world: query.world,
    dimension: query.dimension,
    minChunkX: String(query.minChunkX),
    maxChunkX: String(query.maxChunkX),
    minChunkZ: String(query.minChunkZ),
    maxChunkZ: String(query.maxChunkZ),
  });
  return `/api/chunks?${params.toString()}`;
}

export async function fetchChunks(query: ChunkQuery): Promise<ChunkResponse> {
  try {
    const response = await fetch(chunkUrl(query));
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

export async function listMarkers(): Promise<Marker[]> {
  try {
    const response = await fetch("/api/markers");
    if (!response.ok) {
      throw new Error(`Failed to load markers: ${response.status}`);
    }
    const data = (await response.json()) as { markers: Marker[] };
    return data.markers;
  } catch (error) {
    if (import.meta.env.DEV) {
      const { mockMarkers } = await import("./mockData");
      return mockMarkers;
    }
    throw error;
  }
}

export async function createMarker(marker: MarkerDraft): Promise<Marker> {
  const response = await fetch("/api/markers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(marker),
  });
  if (!response.ok) {
    throw new Error(`Failed to create marker: ${response.status}`);
  }
  const data = (await response.json()) as { marker: Marker };
  return data.marker;
}

export function liveUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/live`;
}
