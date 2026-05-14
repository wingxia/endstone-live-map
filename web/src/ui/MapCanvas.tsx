import { useEffect, useRef, useState } from "react";

import { segmentKey, type BlockUpdatesMessage, type ChunkReadyMessage, type LandClaim, type PlayerState, type WorldMeta } from "../api";
import { blockToChunk, leafletToMinecraft, minecraftToLeaflet } from "./coords";
import { createChunkGridLayer, INITIAL_MAP_ZOOM, type ChunkLayerHandle } from "./chunkLayer";

const LIVE_PLAYER_PADDING_BLOCKS = 96;

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
  lands: LandClaim[];
  worldMeta: WorldMeta | null;
  chunkReady: ChunkReadyMessage | null;
  blockUpdates: BlockUpdatesMessage | null;
  focusTarget: { x: number; z: number; nonce: number } | null;
}

export function MapCanvas({ world, dimension, players, lands, worldMeta, chunkReady, blockUpdates, focusTarget }: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    map: import("leaflet").Map;
    layers: import("leaflet").LayerGroup;
    landLayers: import("leaflet").LayerGroup;
    chunkLayer: ChunkLayerHandle;
  } | null>(null);
  const [coordinate, setCoordinate] = useState<CoordinateState>(() => buildCoordinateState(0, 0, null, false));
  const [mapReady, setMapReady] = useState(false);
  const lockedRef = useRef(false);
  const autoFitKeyRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    let readyFrame = 0;

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

      const landLayers = L.layerGroup().addTo(map);
      const layers = L.layerGroup().addTo(map);
      stateRef.current = { map, layers, landLayers, chunkLayer };
      readyFrame = window.requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }
        map.invalidateSize({ animate: false });
        setMapReady(true);
      });

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
      if (readyFrame) {
        window.cancelAnimationFrame(readyFrame);
      }
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
    const playerBounds = players.length > 0 ? boundsForPlayers(players) : null;
    const meta = isWorldMetaForMap(worldMeta, world, dimension) ? worldMeta : null;
    const autoFitKey = autoFitKeyFor(world, dimension, meta, playerBounds);
    if (!meta && !playerBounds) {
      state.chunkLayer.setActive(false);
      if (autoFitKeyRef.current !== autoFitKey) {
        state.map.setView([0, 0], INITIAL_MAP_ZOOM, { animate: false });
        autoFitKeyRef.current = autoFitKey;
      }
      return;
    }
    state.chunkLayer.setActive(true);
    if (autoFitKeyRef.current === autoFitKey) {
      return;
    }
    if (playerBounds) {
      state.map.fitBounds(
        [
          minecraftToLeaflet(playerBounds.minX, playerBounds.maxZ),
          minecraftToLeaflet(playerBounds.maxX, playerBounds.minZ),
        ],
        { animate: false, padding: [24, 24], maxZoom: INITIAL_MAP_ZOOM },
      );
      autoFitKeyRef.current = autoFitKey;
      return;
    }
    const initialCenter = meta ? initialCenterForBounds(meta.bounds) : { x: 0, z: 0 };
    state.map.setView(minecraftToLeaflet(initialCenter.x, initialCenter.z), INITIAL_MAP_ZOOM, { animate: false });
    autoFitKeyRef.current = autoFitKey;
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
    const state = stateRef.current;
    if (!state || !mapReady || !focusTarget) {
      return;
    }
    state.map.setView(minecraftToLeaflet(focusTarget.x, focusTarget.z), state.map.getZoom(), { animate: true });
  }, [focusTarget, mapReady]);

  useEffect(() => {
    let cancelled = false;

    async function refreshLandOverlay() {
      const L = await import("leaflet");
      const state = stateRef.current;
      if (cancelled || !state || !mapReady) {
        return;
      }
      state.landLayers.clearLayers();

      for (const land of lands) {
        const tooltip = landTooltip(land);
        if (land.minX === land.maxX && land.minZ === land.maxZ) {
          L.circleMarker(minecraftToLeaflet(land.minX, land.minZ), {
            radius: 5,
            color: "#f8fafc",
            weight: 2,
            fillColor: land.nested ? "#f59e0b" : "#38bdf8",
            fillOpacity: 0.88,
            pane: "markerPane",
          })
            .bindTooltip(tooltip)
            .addTo(state.landLayers);
        } else {
          L.rectangle([minecraftToLeaflet(land.minX, land.maxZ), minecraftToLeaflet(land.maxX, land.minZ)], {
            color: land.nested ? "#f59e0b" : "#38bdf8",
            weight: land.nested ? 1 : 2,
            opacity: 0.9,
            fillColor: land.nested ? "#f59e0b" : "#0ea5e9",
            fillOpacity: land.nested ? 0.08 : 0.1,
          })
            .bindTooltip(tooltip)
            .addTo(state.landLayers);
        }

        L.circleMarker(minecraftToLeaflet(land.teleport.x, land.teleport.z), {
          radius: 4,
          color: "#111827",
          weight: 2,
          fillColor: "#facc15",
          fillOpacity: 0.95,
          pane: "markerPane",
        })
          .bindTooltip(`${escapeHtml(land.name)} 传送点 (${land.teleport.x}, ${land.teleport.y}, ${land.teleport.z})`)
          .addTo(state.landLayers);
      }
    }

    refreshLandOverlay();
    return () => {
      cancelled = true;
    };
  }, [lands, mapReady]);

  useEffect(() => {
    let cancelled = false;

    async function refreshOverlay() {
      const L = await import("leaflet");
      const state = stateRef.current;
      if (cancelled || !state || !mapReady) {
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
  }, [mapReady, players]);

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

function buildCoordinateState(
  x: number,
  z: number,
  block: ReturnType<ChunkLayerHandle["getBlockInfo"]>,
  locked: boolean,
): CoordinateState {
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

function isWorldMetaForMap(worldMeta: WorldMeta | null, world: string, dimension: string): worldMeta is WorldMeta {
  return Boolean(worldMeta && worldMeta.dimension === dimension && segmentKey(worldMeta.world) === segmentKey(world));
}

function initialCenterForBounds(bounds: WorldMeta["bounds"]) {
  return {
    x: clampNumber(0, bounds.minBlockX, bounds.maxBlockX),
    z: clampNumber(0, bounds.minBlockZ, bounds.maxBlockZ),
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function autoFitKeyFor(world: string, dimension: string, meta: WorldMeta | null, playerBounds: ReturnType<typeof boundsForPlayers> | null) {
  const prefix = `${segmentKey(world)}/${segmentKey(dimension)}`;
  if (meta) {
    const bounds = meta.bounds;
    return [
      prefix,
      "meta",
      bounds.minChunkX,
      bounds.maxChunkX,
      bounds.minChunkZ,
      bounds.maxChunkZ,
      bounds.minBlockX,
      bounds.maxBlockX,
      bounds.minBlockZ,
      bounds.maxBlockZ,
    ].join("/");
  }
  if (playerBounds) {
    return `${prefix}/live`;
  }
  return `${prefix}/empty`;
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

function landTooltip(land: LandClaim) {
  const size = land.minX === land.maxX && land.minZ === land.maxZ ? "点位" : `${land.minX}, ${land.minZ} 到 ${land.maxX}, ${land.maxZ}`;
  const parent = land.parent ? `<br/>父领地 ${escapeHtml(land.parent)}` : "";
  return `${escapeHtml(land.name)}<br/>所属 ${escapeHtml(land.owner)}<br/>范围 ${size}<br/>TP ${land.teleport.x}, ${land.teleport.y}, ${land.teleport.z}<br/>成员 ${land.members.length}${parent}`;
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
