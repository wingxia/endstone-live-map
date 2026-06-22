import { Clipboard, ClipboardCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { playerAvatarUrl, segmentKey, type LandClaim, type PlayerState, type TilesReadyMessage, type WorldMeta } from "../api";
import { blockToChunk, leafletToMinecraft, minecraftToLeaflet } from "./coords";
import { createChunkGridLayer, INITIAL_MAP_ZOOM, MIN_MAP_ZOOM, type ChunkLayerHandle } from "./chunkLayer";

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
  tilesReady: TilesReadyMessage | null;
  focusTarget: { x: number; z: number; nonce: number } | null;
}

export function MapCanvas({ world, dimension, players, lands, worldMeta, tilesReady, focusTarget }: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    map: import("leaflet").Map;
    layers: import("leaflet").LayerGroup;
    landLayers: import("leaflet").LayerGroup;
    chunkLayer: ChunkLayerHandle;
  } | null>(null);
  const [coordinate, setCoordinate] = useState<CoordinateState>(() => buildCoordinateState(0, 0, null, false));
  const [mapReady, setMapReady] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
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
        minZoom: MIN_MAP_ZOOM,
        maxZoom: INITIAL_MAP_ZOOM,
      }).setView([0, 0], INITIAL_MAP_ZOOM);
      if (navigator.webdriver) {
        (window as unknown as { __endstoneLiveMapLeaflet?: import("leaflet").Map }).__endstoneLiveMapLeaflet = map;
      }
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
    const knownBounds = mergeMapBounds(meta?.bounds || null, playerBounds);
    const autoFitKey = autoFitKeyFor(world, dimension, meta, playerBounds);
    state.chunkLayer.setKnownBounds(knownBounds, meta?.updatedAt);
    if (!meta && !playerBounds) {
      state.chunkLayer.setActive(false);
      if (autoFitKeyRef.current !== autoFitKey) {
        state.map.setView([0, 0], INITIAL_MAP_ZOOM, { animate: false });
        autoFitKeyRef.current = autoFitKey;
      }
      return;
    }
    if (autoFitKeyRef.current !== autoFitKey) {
      if (playerBounds) {
        state.map.fitBounds(
          [
            minecraftToLeaflet(playerBounds.minBlockX, playerBounds.maxBlockZ),
            minecraftToLeaflet(playerBounds.maxBlockX, playerBounds.minBlockZ),
          ],
          { animate: false, padding: [24, 24], maxZoom: INITIAL_MAP_ZOOM },
        );
      } else {
        const initialCenter = meta ? initialCenterForMeta(meta) : { x: 0, z: 0 };
        state.map.setView(minecraftToLeaflet(initialCenter.x, initialCenter.z), INITIAL_MAP_ZOOM, { animate: false });
      }
      autoFitKeyRef.current = autoFitKey;
    }
    state.chunkLayer.setActive(true);
  }, [dimension, mapReady, players, world, worldMeta]);

  useEffect(() => {
    if (tilesReady) {
      stateRef.current?.chunkLayer.refreshTiles(tilesReady);
    }
  }, [tilesReady]);

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
        L.marker(minecraftToLeaflet(player.x, player.z), {
          icon: L.divIcon({
            className: "player-marker",
            html: playerMarkerHtml(player),
            iconSize: [36, 48],
            iconAnchor: [18, 42],
          }),
          keyboard: false,
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

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const resetTimer = window.setTimeout(() => setCopyState("idle"), 1400);
    return () => window.clearTimeout(resetTimer);
  }, [copyState]);

  const copyText = coordinateCopyText(coordinate);
  const copyLabel = copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制坐标";

  const handleCopyCoordinate = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <>
      <div ref={mapRef} className="map-canvas" data-testid="map-canvas" />
      <div className="coordinate-hud" data-testid="coordinate-hud" aria-label="当前地图坐标">
        <button
          type="button"
          className="coordinate-copy coordinate-primary"
          aria-label={`${copyLabel}: ${copyText}`}
          data-testid="coordinate-copy"
          onClick={handleCopyCoordinate}
        >
          <span>{coordinate.locked ? "已锁定" : "指针"}</span>
          <strong>
            X {coordinate.x}, Z {coordinate.z}
          </strong>
          <em>
            {copyState === "copied" ? <ClipboardCheck size={14} aria-hidden="true" /> : <Clipboard size={14} aria-hidden="true" />}
            {copyLabel}
          </em>
        </button>
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

export function coordinateCopyText(coordinate: { x: number; height: number; z: number }): string {
  const y = Number.isFinite(coordinate.height) ? coordinate.height : 0;
  return `${coordinate.x}, ${y}, ${coordinate.z}`;
}

function isWorldMetaForMap(worldMeta: WorldMeta | null, world: string, dimension: string): worldMeta is WorldMeta {
  return Boolean(worldMeta && worldMeta.dimension === dimension && segmentKey(worldMeta.world) === segmentKey(world));
}

function initialCenterForBounds(bounds: WorldMeta["bounds"]) {
  return {
    x: Math.floor((bounds.minBlockX + bounds.maxBlockX) / 2),
    z: Math.floor((bounds.minBlockZ + bounds.maxBlockZ) / 2),
  };
}

function initialCenterForMeta(meta: WorldMeta) {
  const boundsCenter = initialCenterForBounds(meta.bounds);
  const sampleChunk = nearestSampleChunk(meta.sampleChunks || [], boundsCenter);
  if (!sampleChunk) {
    return boundsCenter;
  }
  return {
    x: sampleChunk.chunkX * 16 + 8,
    z: sampleChunk.chunkZ * 16 + 8,
  };
}

function nearestSampleChunk(chunks: Array<{ chunkX: number; chunkZ: number }>, target: { x: number; z: number }) {
  let best: { chunkX: number; chunkZ: number } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const chunk of chunks) {
    const centerX = chunk.chunkX * 16 + 8;
    const centerZ = chunk.chunkZ * 16 + 8;
    const distance = (centerX - target.x) ** 2 + (centerZ - target.z) ** 2;
    if (distance < bestDistance) {
      best = chunk;
      bestDistance = distance;
    }
  }
  return best;
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

function boundsForPlayers(players: PlayerState[]): WorldMeta["bounds"] {
  const xs = players.map((player) => player.x);
  const zs = players.map((player) => player.z);
  const minBlockX = Math.floor(Math.min(...xs) - LIVE_PLAYER_PADDING_BLOCKS);
  const maxBlockX = Math.ceil(Math.max(...xs) + LIVE_PLAYER_PADDING_BLOCKS);
  const minBlockZ = Math.floor(Math.min(...zs) - LIVE_PLAYER_PADDING_BLOCKS);
  const maxBlockZ = Math.ceil(Math.max(...zs) + LIVE_PLAYER_PADDING_BLOCKS);
  const minChunk = blockToChunk(minBlockX, minBlockZ);
  const maxChunk = blockToChunk(maxBlockX, maxBlockZ);
  return {
    minChunkX: minChunk.chunkX,
    maxChunkX: maxChunk.chunkX,
    minChunkZ: minChunk.chunkZ,
    maxChunkZ: maxChunk.chunkZ,
    minBlockX,
    maxBlockX,
    minBlockZ,
    maxBlockZ,
  };
}

export function mergeMapBounds(left: WorldMeta["bounds"] | null, right: WorldMeta["bounds"] | null): WorldMeta["bounds"] | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    minChunkX: Math.min(left.minChunkX, right.minChunkX),
    maxChunkX: Math.max(left.maxChunkX, right.maxChunkX),
    minChunkZ: Math.min(left.minChunkZ, right.minChunkZ),
    maxChunkZ: Math.max(left.maxChunkZ, right.maxChunkZ),
    minBlockX: Math.min(left.minBlockX, right.minBlockX),
    maxBlockX: Math.max(left.maxBlockX, right.maxBlockX),
    minBlockZ: Math.min(left.minBlockZ, right.minBlockZ),
    maxBlockZ: Math.max(left.maxBlockZ, right.maxBlockZ),
  };
}

function landTooltip(land: LandClaim) {
  const size = land.minX === land.maxX && land.minZ === land.maxZ ? "点位" : `${land.minX}, ${land.minZ} 到 ${land.maxX}, ${land.maxZ}`;
  const parent = land.parent ? `<br/>父领地 ${escapeHtml(land.parent)}` : "";
  return `${escapeHtml(land.name)}<br/>所属 ${escapeHtml(land.owner)}<br/>范围 ${size}<br/>TP ${land.teleport.x}, ${land.teleport.y}, ${land.teleport.z}<br/>成员 ${land.members.length}${parent}`;
}

function playerMarkerHtml(player: PlayerState) {
  const avatar = playerAvatarUrl(player);
  const initial = escapeHtml((player.name || "?").slice(0, 1).toUpperCase());
  const name = escapeHtml(player.name || "Player");
  const avatarHtml = avatar
    ? `<img class="player-marker-avatar" src="${escapeAttribute(avatar)}" alt="" loading="lazy" />`
    : `<span class="player-marker-fallback">${initial}</span>`;
  return `<span class="player-marker-frame">${avatarHtml}</span><span class="player-marker-name">${name}</span>`;
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

function escapeAttribute(value: string) {
  return escapeHtml(value);
}
