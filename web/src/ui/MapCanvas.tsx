import * as L from "leaflet";
import { House } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { playerAvatarUrl, segmentKey, type LandClaim, type PlayerState, type TilesReadyMessage, type WorldMeta } from "../api";
import { blockToChunk, leafletToMinecraft, minecraftToLeaflet } from "./coords";
import { createChunkGridLayer, INITIAL_MAP_ZOOM, MIN_MAP_ZOOM, type ChunkLayerHandle } from "./chunkLayer";

const LIVE_PLAYER_PADDING_BLOCKS = 96;
const MAP_BOUNDS_PADDING_BLOCKS = 16;

interface CoordinateState {
  x: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  localX: number;
  localZ: number;
  height: number;
  locked: boolean;
}

interface PlayerMarkerRecord {
  marker: L.Marker;
  visualSignature: string;
  tooltipSignature: string;
}

interface MapCanvasProps {
  world: string;
  dimension: string;
  players: PlayerState[];
  trackedPlayerIds: ReadonlySet<string>;
  lands: LandClaim[];
  birthplace: { x: number; z: number } | null;
  worldMeta: WorldMeta | null;
  tilesReady: TilesReadyMessage | null;
  focusTarget: { x: number; z: number; nonce: number } | null;
}

export function MapCanvas({ world, dimension, players, trackedPlayerIds, lands, birthplace, worldMeta, tilesReady, focusTarget }: MapCanvasProps) {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<{
    map: L.Map;
    layers: L.LayerGroup;
    landLayers: L.LayerGroup;
    chunkLayer: ChunkLayerHandle;
    playerMarkers: Map<string, PlayerMarkerRecord>;
  } | null>(null);
  const [coordinate, setCoordinate] = useState<CoordinateState>(() => buildCoordinateState(0, 0, null, false));
  const [mapReady, setMapReady] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const lockedRef = useRef(false);
  const autoFitKeyRef = useRef("");
  const trackingViewRef = useRef({ key: "", maxZoom: INITIAL_MAP_ZOOM });
  const homeViewsRef = useRef(new Map<string, { center: [number, number]; zoom: number }>());
  const navigationBoundsRef = useRef<{ key: string; bounds: WorldMeta["bounds"] | null }>({
    key: "",
    bounds: null,
  });
  const mapSelectionRef = useRef({ world, dimension });
  mapSelectionRef.current = { world, dimension };

  useEffect(() => {
    let cancelled = false;
    let readyFrame = 0;
    let coordinateFrame = 0;
    let mountedMap: L.Map | null = null;
    let pendingHover: L.LeafletMouseEvent | null = null;
    let dragging = false;

    function mount() {
      if (cancelled || !mapRef.current || stateRef.current) {
        return;
      }

      const map = L.map(mapRef.current, {
        crs: L.CRS.Simple,
        zoomControl: false,
        attributionControl: false,
        minZoom: MIN_MAP_ZOOM,
        maxZoom: INITIAL_MAP_ZOOM,
        maxBoundsViscosity: 1,
      }).setView([0, 0], INITIAL_MAP_ZOOM);
      if (navigator.webdriver) {
        (window as unknown as { __endstoneLiveMapLeaflet?: L.Map }).__endstoneLiveMapLeaflet = map;
      }
      L.control.zoom({ position: "bottomright" }).addTo(map);
      const selection = mapSelectionRef.current;
      const chunkLayer = createChunkGridLayer(L, selection.world, selection.dimension).addTo(map);

      const landLayers = L.layerGroup().addTo(map);
      const layers = L.layerGroup().addTo(map);
      const playerMarkers = new Map<string, PlayerMarkerRecord>();
      stateRef.current = { map, layers, landLayers, chunkLayer, playerMarkers };
      mountedMap = map;
      readyFrame = window.requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }
        map.invalidateSize({ animate: false });
        setMapReady(true);
      });

      const updateCoordinate = (event: L.LeafletMouseEvent, locked: boolean) => {
        const point = leafletToMinecraft(event.latlng.lat, event.latlng.lng);
        const block = chunkLayer.getBlockInfo(point.x, point.z);
        lockedRef.current = locked;
        setCoordinate(buildCoordinateState(point.x, point.z, block, locked));
      };

      const cancelHoverCoordinate = () => {
        pendingHover = null;
        if (coordinateFrame) {
          window.cancelAnimationFrame(coordinateFrame);
          coordinateFrame = 0;
        }
      };
      const flushHoverCoordinate = () => {
        coordinateFrame = 0;
        const event = pendingHover;
        pendingHover = null;
        if (event && !dragging && !lockedRef.current) {
          updateCoordinate(event, false);
        }
      };
      map.on("mousemove", (event) => {
        if (dragging || lockedRef.current) {
          return;
        }
        pendingHover = event;
        if (!coordinateFrame) {
          coordinateFrame = window.requestAnimationFrame(flushHoverCoordinate);
        }
      });
      map.on("dragstart", () => {
        dragging = true;
        cancelHoverCoordinate();
      });
      map.on("dragend", () => {
        dragging = false;
      });
      map.on("click", (event) => {
        cancelHoverCoordinate();
        updateCoordinate(event, true);
      });
      map.on("mouseout", () => {
        cancelHoverCoordinate();
        if (!lockedRef.current) {
          setCoordinate((current) => ({ ...current, height: Number.NaN }));
        }
      });
    }

    mount();
    return () => {
      cancelled = true;
      if (readyFrame) {
        window.cancelAnimationFrame(readyFrame);
      }
      if (coordinateFrame) {
        window.cancelAnimationFrame(coordinateFrame);
      }
      if (mountedMap) {
        mountedMap.remove();
        if (stateRef.current?.map === mountedMap) {
          stateRef.current = null;
        }
        if (
          navigator.webdriver &&
          (window as unknown as { __endstoneLiveMapLeaflet?: L.Map }).__endstoneLiveMapLeaflet === mountedMap
        ) {
          delete (window as unknown as { __endstoneLiveMapLeaflet?: L.Map }).__endstoneLiveMapLeaflet;
        }
      }
    };
  }, []);

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
    const selectionKey = mapViewKey(world, dimension);
    const candidateNavigationBounds = mergeMapBounds(
      mergeMapBounds(meta?.bounds || null, playerBounds),
      birthplace ? boundsForPoint(birthplace) : null,
    );
    const previousNavigation = navigationBoundsRef.current;
    const navigationBounds =
      previousNavigation.key === selectionKey
        ? mergeMapBounds(previousNavigation.bounds, candidateNavigationBounds)
        : candidateNavigationBounds;
    const autoFitKey = autoFitKeyFor(world, dimension, meta, playerBounds, birthplace);
    const navigationBoundsChanged =
      previousNavigation.key !== selectionKey ||
      !sameMapBounds(previousNavigation.bounds, navigationBounds);
    if (navigationBoundsChanged) {
      state.map.setMaxBounds(null as unknown as L.LatLngBoundsExpression);
    }
    const applyNavigationBounds = () => {
      if (!navigationBoundsChanged) {
        return;
      }
      state.map.setMaxBounds(
        navigationBounds
          ? leafletMaxBoundsFor(navigationBounds)
          : (null as unknown as L.LatLngBoundsExpression),
      );
      navigationBoundsRef.current = { key: selectionKey, bounds: navigationBounds };
    };
    if (!meta) {
      state.chunkLayer.setActive(false);
      if (autoFitKeyRef.current !== autoFitKey) {
        if (birthplace) {
          state.map.setView(minecraftToLeaflet(birthplace.x, birthplace.z), INITIAL_MAP_ZOOM, { animate: false });
        } else if (playerBounds) {
          state.map.fitBounds(
            [
              minecraftToLeaflet(playerBounds.minBlockX, playerBounds.maxBlockZ),
              minecraftToLeaflet(playerBounds.maxBlockX, playerBounds.minBlockZ),
            ],
            { animate: false, padding: [24, 24], maxZoom: INITIAL_MAP_ZOOM },
          );
        } else {
          state.map.setView([0, 0], INITIAL_MAP_ZOOM, { animate: false });
        }
        saveHomeView(homeViewsRef.current, world, dimension, state.map);
        autoFitKeyRef.current = autoFitKey;
      }
      applyNavigationBounds();
      return;
    }
    state.chunkLayer.setKnownBounds(meta.bounds, meta.updatedAt);
    if (autoFitKeyRef.current !== autoFitKey) {
      if (birthplace) {
        state.map.setView(minecraftToLeaflet(birthplace.x, birthplace.z), INITIAL_MAP_ZOOM, { animate: false });
      } else if (playerBounds) {
        state.map.fitBounds(
          [
            minecraftToLeaflet(playerBounds.minBlockX, playerBounds.maxBlockZ),
            minecraftToLeaflet(playerBounds.maxBlockX, playerBounds.minBlockZ),
          ],
          { animate: false, padding: [24, 24], maxZoom: INITIAL_MAP_ZOOM },
        );
      } else {
        const initialCenter = initialCenterForMeta(meta);
        state.map.setView(minecraftToLeaflet(initialCenter.x, initialCenter.z), INITIAL_MAP_ZOOM, { animate: false });
      }
      saveHomeView(homeViewsRef.current, world, dimension, state.map);
      autoFitKeyRef.current = autoFitKey;
    }
    applyNavigationBounds();
    state.chunkLayer.setActive(true);
  }, [birthplace, dimension, mapReady, players, world, worldMeta]);

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
    const state = stateRef.current;
    if (!state || !mapReady) {
      return;
    }

    const trackedPlayers = players.filter((player) => trackedPlayerIds.has(String(player.id)));
    if (trackedPlayers.length === 0) {
      trackingViewRef.current = { key: "", maxZoom: INITIAL_MAP_ZOOM };
      return;
    }

    const trackingKey = `${mapViewKey(world, dimension)}/${trackedPlayers
      .map((player) => String(player.id))
      .sort()
      .join(",")}`;
    const selectionChanged = trackingViewRef.current.key !== trackingKey;
    if (selectionChanged) {
      trackingViewRef.current = {
        key: trackingKey,
        maxZoom: trackingViewRef.current.key ? trackingViewRef.current.maxZoom : state.map.getZoom(),
      };
    }

    if (trackedPlayers.length === 1) {
      const player = trackedPlayers[0];
      state.map.setView(minecraftToLeaflet(player.x, player.z), selectionChanged ? trackingViewRef.current.maxZoom : state.map.getZoom(), {
        animate: false,
      });
      return;
    }

    state.map.fitBounds(
      L.latLngBounds(trackedPlayers.map((player) => minecraftToLeaflet(player.x, player.z))),
      {
        animate: false,
        padding: [64, 64],
        maxZoom: trackingViewRef.current.maxZoom,
      },
    );
  }, [dimension, focusTarget, mapReady, players, trackedPlayerIds, world]);

  useEffect(() => {
    let cancelled = false;

    function refreshLandOverlay() {
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
    function refreshOverlay() {
      const state = stateRef.current;
      if (!state || !mapReady) {
        return;
      }

      const onlinePlayerIds = new Set<string>();
      for (const player of players) {
        const playerId = String(player.id);
        const tracked = trackedPlayerIds.has(playerId);
        const nextPosition = minecraftToLeaflet(player.x, player.z);
        const visualSignature = playerMarkerVisualSignature(player, tracked);
        const tooltip = playerMarkerTooltip(player);
        onlinePlayerIds.add(playerId);

        const existing = state.playerMarkers.get(playerId);
        if (!existing) {
          const marker = L.marker(nextPosition, {
            icon: playerMarkerIcon(player, tracked),
            keyboard: false,
          })
            .bindTooltip(tooltip, { permanent: false })
            .addTo(state.layers);
          state.playerMarkers.set(playerId, { marker, visualSignature, tooltipSignature: tooltip });
          continue;
        }

        const currentPosition = existing.marker.getLatLng();
        if (currentPosition.lat !== nextPosition[0] || currentPosition.lng !== nextPosition[1]) {
          existing.marker.setLatLng(nextPosition);
        }
        if (existing.visualSignature !== visualSignature) {
          existing.marker.setIcon(playerMarkerIcon(player, tracked));
          existing.visualSignature = visualSignature;
        }
        if (existing.tooltipSignature !== tooltip) {
          existing.marker.setTooltipContent(tooltip);
          existing.tooltipSignature = tooltip;
        }
      }

      for (const [playerId, record] of state.playerMarkers) {
        if (onlinePlayerIds.has(playerId)) {
          continue;
        }
        state.layers.removeLayer(record.marker);
        state.playerMarkers.delete(playerId);
      }
    }

    refreshOverlay();
  }, [mapReady, players, trackedPlayerIds]);

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

  const handleResetView = () => {
    const homeView = homeViewsRef.current.get(mapViewKey(world, dimension));
    if (!homeView || !stateRef.current) {
      return;
    }
    stateRef.current.map.setView(homeView.center, homeView.zoom, { animate: true });
  };
  const homeControlLabel = birthplace ? "定位到出生地" : "返回初始视角";

  return (
    <>
      <div ref={mapRef} className="map-canvas" data-testid="map-canvas" />
      <button
        type="button"
        className="map-home-control leaflet-bar"
        aria-label={homeControlLabel}
        title={homeControlLabel}
        data-testid="map-home-control"
        disabled={!mapReady}
        onClick={handleResetView}
      >
        <House size={17} aria-hidden="true" />
      </button>
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
        </button>
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
      </div>
    </>
  );
}

function mapViewKey(world: string, dimension: string) {
  return `${segmentKey(world)}/${segmentKey(dimension)}`;
}

function saveHomeView(
  homeViews: Map<string, { center: [number, number]; zoom: number }>,
  world: string,
  dimension: string,
  map: L.Map,
) {
  const center = map.getCenter();
  homeViews.set(mapViewKey(world, dimension), { center: [center.lat, center.lng], zoom: map.getZoom() });
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
    locked,
  };
}

export function coordinateCopyText(coordinate: { x: number; height: number; z: number }): string {
  const y = Number.isFinite(coordinate.height) ? coordinate.height : "~";
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

function autoFitKeyFor(
  world: string,
  dimension: string,
  meta: WorldMeta | null,
  playerBounds: ReturnType<typeof boundsForPlayers> | null,
  birthplace: { x: number; z: number } | null,
) {
  const prefix = `${segmentKey(world)}/${segmentKey(dimension)}`;
  const birthplaceKey = birthplace ? `/birthplace/${birthplace.x}/${birthplace.z}` : "";
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
    ].join("/") + birthplaceKey;
  }
  if (playerBounds) {
    return `${prefix}/live${birthplaceKey}`;
  }
  return `${prefix}/empty${birthplaceKey}`;
}

function boundsForPoint(point: { x: number; z: number }): WorldMeta["bounds"] {
  const minBlockX = Math.floor(point.x - LIVE_PLAYER_PADDING_BLOCKS);
  const maxBlockX = Math.ceil(point.x + LIVE_PLAYER_PADDING_BLOCKS);
  const minBlockZ = Math.floor(point.z - LIVE_PLAYER_PADDING_BLOCKS);
  const maxBlockZ = Math.ceil(point.z + LIVE_PLAYER_PADDING_BLOCKS);
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

function sameMapBounds(left: WorldMeta["bounds"] | null, right: WorldMeta["bounds"] | null) {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.minChunkX === right.minChunkX &&
    left.maxChunkX === right.maxChunkX &&
    left.minChunkZ === right.minChunkZ &&
    left.maxChunkZ === right.maxChunkZ &&
    left.minBlockX === right.minBlockX &&
    left.maxBlockX === right.maxBlockX &&
    left.minBlockZ === right.minBlockZ &&
    left.maxBlockZ === right.maxBlockZ
  );
}

export function leafletMaxBoundsFor(bounds: WorldMeta["bounds"]): L.LatLngBoundsExpression {
  return [
    minecraftToLeaflet(bounds.minBlockX - MAP_BOUNDS_PADDING_BLOCKS, bounds.maxBlockZ + MAP_BOUNDS_PADDING_BLOCKS),
    minecraftToLeaflet(bounds.maxBlockX + MAP_BOUNDS_PADDING_BLOCKS, bounds.minBlockZ - MAP_BOUNDS_PADDING_BLOCKS),
  ];
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

function playerMarkerIcon(player: PlayerState, tracked: boolean) {
  return L.divIcon({
    className: tracked ? "player-marker player-marker-tracked" : "player-marker",
    html: playerMarkerHtml(player),
    iconSize: [36, 48],
    iconAnchor: [18, 42],
  });
}

function playerMarkerVisualSignature(player: PlayerState, tracked: boolean) {
  return `${player.name}\u0000${playerAvatarUrl(player)}\u0000${tracked}`;
}

function playerMarkerTooltip(player: PlayerState) {
  return `${escapeHtml(player.name)} (${Math.round(player.x)}, ${Math.round(player.y)}, ${Math.round(player.z)})`;
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
