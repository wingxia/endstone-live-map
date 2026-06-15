export interface PlayerState {
  id: string;
  name: string;
  xuid?: string;
  world: string;
  dimension: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  avatarHash?: string;
  avatarUrl?: string;
  updatedAt: number;
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
  sampleChunks?: Array<{
    chunkX: number;
    chunkZ: number;
  }>;
  topBlocks: Record<string, number>;
}

export interface LandClaim {
  id: string;
  owner: string;
  name: string;
  world: string;
  dimension: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  teleport: {
    x: number;
    y: number;
    z: number;
  };
  members: string[];
  parent: string;
  children: string[];
  nested: boolean;
  publicTeleport: boolean;
  updatedAt: number;
}

export interface LandResponse {
  version: number;
  world: string;
  dimension: string;
  claims: LandClaim[];
  updatedAt: number;
}

export type BlockStateValue = boolean | number | string;
export type BlockStateMap = Record<string, BlockStateValue>;

export interface ReadyChunk {
  world?: string;
  dimension?: string;
  chunkX: number;
  chunkZ: number;
  updatedAt?: number;
}

export interface ReadyTile {
  world: string;
  dimension: string;
  zoom: number;
  tileX: number;
  tileZ: number;
  updatedAt: number;
  hasPixels: boolean;
}

export interface LandsUpdatedMessage {
  type: "lands_updated";
  world: string;
  dimension: string;
  updatedAt: number;
}

export interface TilesReadyMessage {
  type: "tiles_ready";
  chunks: Array<ReadyChunk & { world: string; dimension: string }>;
  tiles?: ReadyTile[];
  updatedAt: number;
}

export interface LiveMessage {
  type: "player_snapshot" | "tiles_ready" | "lands_updated" | "heartbeat";
  players?: PlayerState[];
  world?: string;
  dimension?: string;
  chunks?: ReadyChunk[];
  tiles?: ReadyTile[];
  updatedAt?: number;
}

export function mapImageTileUrl(world: string, dimension: string, zoom: number, tileX: number, tileZ: number, cacheBust?: string | number): string {
  const params = new URLSearchParams();
  if (cacheBust !== undefined) {
    params.set("_", String(cacheBust));
  }
  const suffix = params.toString();
  return `/api/map-tiles/${segmentKey(world)}/${segmentKey(dimension)}/z${zoom}/${tileX}/${tileZ}.png${suffix ? `?${suffix}` : ""}`;
}

export function playerAvatarUrl(player: Pick<PlayerState, "id" | "avatarHash" | "avatarUrl">): string {
  if (player.avatarUrl) {
    return player.avatarUrl;
  }
  if (!player.avatarHash) {
    return "";
  }
  const params = new URLSearchParams({ _: String(player.avatarHash) });
  return `/api/players/${encodeURIComponent(player.id)}/avatar.png?${params.toString()}`;
}

export function landsUrl(world: string, dimension: string, cacheBust?: string | number): string {
  const params = new URLSearchParams({ world, dimension });
  if (cacheBust !== undefined) {
    params.set("_", String(cacheBust));
  }
  return `/api/lands?${params.toString()}`;
}

export async function fetchLands(world: string, dimension: string, cacheBust?: string | number): Promise<LandResponse> {
  try {
    const response = await fetch(landsUrl(world, dimension, cacheBust), { cache: cacheBust === undefined ? "default" : "no-store" });
    if (!response.ok) {
      throw new Error(`Failed to load lands: ${response.status}`);
    }
    return (await response.json()) as LandResponse;
  } catch (error) {
    if (import.meta.env.DEV) {
      const { mockLands } = await import("./mockData");
      return {
        version: 1,
        world,
        dimension,
        claims: mockLands.filter((claim) => segmentKey(claim.world) === segmentKey(world) && claim.dimension === dimension),
        updatedAt: Date.now(),
      };
    }
    throw error;
  }
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
