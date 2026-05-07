import { useEffect, useRef } from "react";

import { tileUrl, type Marker, type PlayerState } from "../api";

interface MapCanvasProps {
  world: string;
  dimension: string;
  players: PlayerState[];
  markers: Marker[];
}

export function MapCanvas({ world, dimension, players, markers }: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{ map: import("leaflet").Map; layers: import("leaflet").LayerGroup } | null>(null);

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
        minZoom: -2,
        maxZoom: 2,
      }).setView([0, 0], 0);

      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer(tileUrl(world, dimension), {
        tileSize: 256,
        minZoom: 0,
        maxZoom: 0,
        noWrap: true,
        className: "world-tile",
        errorTileUrl:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='256' height='256'%3E%3Crect width='256' height='256' fill='%231f2933'/%3E%3Cpath d='M0 0H256V256' stroke='%23313d49'/%3E%3C/svg%3E",
      }).addTo(map);

      const layers = L.layerGroup().addTo(map);
      stateRef.current = { map, layers };
    }

    mount();
    return () => {
      cancelled = true;
    };
  }, [dimension, world]);

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
        L.marker([marker.z, marker.x], { title: marker.title })
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
