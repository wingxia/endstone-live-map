import { useEffect, useRef, useState } from "react";

import { segmentKey, type BlockUpdatesMessage, type ChunkReadyMessage, type Marker, type PlayerState, type WorldMeta } from "../api";
import { blockToChunk, leafletToMinecraft, minecraftToLeaflet } from "./coords";
import { createChunkGridLayer, INITIAL_MAP_ZOOM, type ChunkLayerHandle } from "./chunkLayer";

const MAX_INITIAL_CHUNKS = 96;

interface CoordinateState {
  x: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  localX: number;
  localZ: number;
  height: number;
  block: string;
  locked: boolean;
}

interface MapCanvasProps {
  world: string;
  dimension: string;
  players: PlayerState[];
  markers: Marker[];
  worldMeta: WorldMeta | null;
  chunkReady: ChunkReadyMessage | null;
  blockUpdates: BlockUpdatesMessage | null;
}

export function MapCanvas({ world, dimension, players, markers, worldMeta, chunkReady, blockUpdates }: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    map: import("leaflet").Map;
    layers: import("leaflet").LayerGroup;
    chunkLayer: ChunkLayerHandle;
  } | null>(null);
  const [coordinate, setCoordinate] = useState<CoordinateState>(() => buildCoordinateState(0, 0, null, false));
  const lockedRef = useRef(false);

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

      const updateCoordinate = (event: import("leaflet").LeafletMouseEvent, locked: boolean) => {
        const point = leafletToMinecraft(event.latlng.lat, event.latlng.lng);
        const block = chunkLayer.getBlockInfo(point.x, point.z);
        lockedRef.current = locked;
        setCoordinate(buildCoordinateState(point.x, point.z, block, locked));
      };

      map.on("mousemove", (event) => {
        if (!lockedRef.current) {
          updateCoordinate(event, false);
        }
      });
      map.on("click", (event) => updateCoordinate(event, true));
      map.on("mouseout", () => {
        if (!lockedRef.current) {
          setCoordinate((current) => ({ ...current, block: "移出地图", height: Number.NaN }));
        }
      });
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
    if (!state || !worldMeta || worldMeta.dimension !== dimension || segmentKey(worldMeta.world) !== segmentKey(world)) {
      return;
    }
    const bounds = worldMeta.bounds;
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
  }, [dimension, worldMeta]);

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
        L.circleMarker(minecraftToLeaflet(marker.x, marker.z), {
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
  }, [players, markers]);

  return (
    <>
      <div ref={mapRef} className="map-canvas" data-testid="map-canvas" />
      <div className="coordinate-hud" data-testid="coordinate-hud" aria-label="当前地图坐标">
        <div>
          <span>{coordinate.locked ? "已锁定" : "指针"}</span>
          <strong>
            X {coordinate.x}, Z {coordinate.z}
          </strong>
        </div>
        <div>
          <span>Y</span>
          <strong>{Number.isFinite(coordinate.height) ? coordinate.height : "--"}</strong>
        </div>
        <div>
          <span>区块</span>
          <strong>
            {coordinate.chunkX}, {coordinate.chunkZ}
          </strong>
        </div>
        <div>
          <span>局部</span>
          <strong>
            {coordinate.localX}, {coordinate.localZ}
          </strong>
        </div>
        <div className="coordinate-block">
          <span>方块</span>
          <strong>{coordinate.block}</strong>
        </div>
      </div>
    </>
  );
}

function buildCoordinateState(x: number, z: number, block: ReturnType<ChunkLayerHandle["getBlockInfo"]>, locked: boolean): CoordinateState {
  const position = block || blockToChunk(x, z);
  return {
    x,
    z,
    chunkX: position.chunkX,
    chunkZ: position.chunkZ,
    localX: position.localX,
    localZ: position.localZ,
    height: block?.height ?? Number.NaN,
    block: block?.block || "未加载",
    locked,
  };
}

function clampChunk(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
