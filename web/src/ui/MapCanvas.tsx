import { useEffect, useRef } from "react";

import type { BlockUpdatesMessage, ChunkReadyMessage, Marker, PlayerState } from "../api";
import { createChunkGridLayer, INITIAL_MAP_ZOOM, type ChunkLayerHandle } from "./chunkLayer";

interface MapCanvasProps {
  world: string;
  dimension: string;
  players: PlayerState[];
  markers: Marker[];
  chunkReady: ChunkReadyMessage | null;
  blockUpdates: BlockUpdatesMessage | null;
}

export function MapCanvas({ world, dimension, players, markers, chunkReady, blockUpdates }: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    map: import("leaflet").Map;
    layers: import("leaflet").LayerGroup;
    chunkLayer: ChunkLayerHandle;
  } | null>(null);

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

      for (const marker of markers) {
        L.circleMarker([marker.z, marker.x], {
          radius: 9,
          color: "#101820",
          weight: 2,
          fillColor: "#60a5fa",
          fillOpacity: 0.95,
        })
          .bindPopup(`<strong>${escapeHtml(marker.title)}</strong><br>${escapeHtml(marker.description)}`)
          .addTo(state.layers);
      }

      for (const player of players) {
        L.circleMarker([player.z, player.x], {
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
  }, [players, markers]);

  return <div ref={mapRef} className="map-canvas" data-testid="map-canvas" />;
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
