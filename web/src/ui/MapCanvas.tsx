import { useEffect, useRef, useState } from "react";

import { segmentKey, type BlockUpdatesMessage, type ChunkReadyMessage, type PlayerState, type WorldMeta } from "../api";
import { minecraftToLeaflet } from "./coords";
import { createChunkGridLayer, INITIAL_MAP_ZOOM, type ChunkLayerHandle } from "./chunkLayer";

const MAX_INITIAL_CHUNKS = 96;
const LIVE_PLAYER_PADDING_BLOCKS = 96;

interface MapCanvasProps {
  world: string;
  dimension: string;
  players: PlayerState[];
  worldMeta: WorldMeta | null;
  chunkReady: ChunkReadyMessage | null;
  blockUpdates: BlockUpdatesMessage | null;
}

export function MapCanvas({ world, dimension, players, worldMeta, chunkReady, blockUpdates }: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    map: import("leaflet").Map;
    layers: import("leaflet").LayerGroup;
    chunkLayer: ChunkLayerHandle;
  } | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function mount() {
      const L = await import("leaflet");
      if (cancelled || !mapRef.current || stateRef.current) {
        return;
      }

      const map = L.map(mapRef.current, {
        crs: L.CRS.Simple,
        zoomControl: false,
        attributionControl: false,
        minZoom: 0,
        maxZoom: INITIAL_MAP_ZOOM,
      }).setView([0, 0], INITIAL_MAP_ZOOM);

      L.control.zoom({ position: "bottomright" }).addTo(map);
      const chunkLayer = createChunkGridLayer(L, world, dimension).addTo(map);

      const layers = L.layerGroup().addTo(map);
      stateRef.current = { map, layers, chunkLayer };
      setMapReady(true);
    }

    mount();
    return () => {
      cancelled = true;
    };
  }, [dimension, world]);

  useEffect(() => {
    stateRef.current?.chunkLayer.setWorldDimension(world, dimension);
  }, [dimension, world]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state || !mapReady) {
      return;
    }
    const meta = isWorldMetaForMap(worldMeta, world, dimension) ? worldMeta : null;
    const playerBounds = players.length > 0 ? boundsForPlayers(players) : null;
    if (!meta && !playerBounds) {
      state.chunkLayer.setActive(false);
      state.map.setView([0, 0], INITIAL_MAP_ZOOM, { animate: false });
      return;
    }
    state.chunkLayer.setActive(true);
    if (!meta && playerBounds) {
      state.map.fitBounds(
        [
          minecraftToLeaflet(playerBounds.minX, playerBounds.maxZ),
          minecraftToLeaflet(playerBounds.maxX, playerBounds.minZ),
        ],
        { animate: false, padding: [24, 24], maxZoom: INITIAL_MAP_ZOOM },
      );
      return;
    }
    if (!meta) {
      return;
    }
    const bounds = meta.bounds;
    const widthChunks = bounds.maxChunkX - bounds.minChunkX + 1;
    const heightChunks = bounds.maxChunkZ - bounds.minChunkZ + 1;
    if (widthChunks > MAX_INITIAL_CHUNKS || heightChunks > MAX_INITIAL_CHUNKS) {
      const centerChunkX = clampChunk(0, bounds.minChunkX, bounds.maxChunkX);
      const centerChunkZ = clampChunk(0, bounds.minChunkZ, bounds.maxChunkZ);
      const half = Math.floor(MAX_INITIAL_CHUNKS / 2);
      const minChunkX = clampChunk(centerChunkX - half, bounds.minChunkX, bounds.maxChunkX);
      const maxChunkX = clampChunk(centerChunkX + half, bounds.minChunkX, bounds.maxChunkX);
      const minChunkZ = clampChunk(centerChunkZ - half, bounds.minChunkZ, bounds.maxChunkZ);
      const maxChunkZ = clampChunk(centerChunkZ + half, bounds.minChunkZ, bounds.maxChunkZ);
      state.map.fitBounds(
        [
          minecraftToLeaflet(minChunkX * 16, maxChunkZ * 16 + 15),
          minecraftToLeaflet(maxChunkX * 16 + 15, minChunkZ * 16),
        ],
        { animate: false, padding: [24, 24] },
      );
      return;
    }
    state.map.fitBounds(
      [
        minecraftToLeaflet(bounds.minBlockX, bounds.maxBlockZ),
        minecraftToLeaflet(bounds.maxBlockX, bounds.minBlockZ),
      ],
      { animate: false, padding: [24, 24] },
    );
  }, [dimension, mapReady, players, world, worldMeta]);

  useEffect(() => {
    if (chunkReady) {
      stateRef.current?.chunkLayer.refreshChunk(chunkReady);
    }
  }, [chunkReady]);

  useEffect(() => {
    if (blockUpdates) {
      stateRef.current?.chunkLayer.applyBlockUpdates(blockUpdates);
    }
  }, [blockUpdates]);

  useEffect(() => {
    let cancelled = false;

    async function refreshOverlay() {
      const L = await import("leaflet");
      const state = stateRef.current;
      if (cancelled || !state) {
        return;
      }
      state.layers.clearLayers();

      for (const player of players) {
        L.circleMarker(minecraftToLeaflet(player.x, player.z), {
          radius: 7,
          color: "#111827",
          weight: 2,
          fillColor: "#46d9a5",
          fillOpacity: 0.95,
        })
          .bindTooltip(`${escapeHtml(player.name)} (${Math.round(player.x)}, ${Math.round(player.y)}, ${Math.round(player.z)})`, {
            permanent: false,
          })
          .addTo(state.layers);
      }
    }

    refreshOverlay();
    return () => {
      cancelled = true;
    };
  }, [players]);

  return (
    <>
      <div ref={mapRef} className="map-canvas" data-testid="map-canvas" />
    </>
  );
}

function isWorldMetaForMap(worldMeta: WorldMeta | null, world: string, dimension: string): worldMeta is WorldMeta {
  return Boolean(worldMeta && worldMeta.dimension === dimension && segmentKey(worldMeta.world) === segmentKey(world));
}

function clampChunk(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function boundsForPlayers(players: PlayerState[]) {
  const xs = players.map((player) => player.x);
  const zs = players.map((player) => player.z);
  return {
    minX: Math.floor(Math.min(...xs) - LIVE_PLAYER_PADDING_BLOCKS),
    maxX: Math.ceil(Math.max(...xs) + LIVE_PLAYER_PADDING_BLOCKS),
    minZ: Math.floor(Math.min(...zs) - LIVE_PLAYER_PADDING_BLOCKS),
    maxZ: Math.ceil(Math.max(...zs) + LIVE_PLAYER_PADDING_BLOCKS),
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}
