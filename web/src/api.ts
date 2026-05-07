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

export interface LiveMessage {
  type: "player_snapshot" | "tile_ready" | "marker_created" | "marker_updated" | "marker_deleted" | "heartbeat";
  players?: PlayerState[];
  marker?: Marker;
  id?: string;
}

export function tileUrl(world: string, dimension: string): string {
  return `/tiles/${encodeURIComponent(world)}/${encodeURIComponent(dimension)}/{z}/{x}/{y}.bmp`;
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
