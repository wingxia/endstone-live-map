import {
  Flame,
  LandPlot,
  LocateFixed,
  Map as MapIcon,
  Orbit,
  RadioTower,
  TreePine,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fetchLands, listWorlds, segmentKey, type LandClaim, type WorldMeta } from "../api";
import { useLivePlayers } from "../hooks/useLivePlayers";
import { LandList } from "./LandList";
import { MapCanvas } from "./MapCanvas";
import { PlayerList } from "./PlayerList";

const DEFAULT_WORLD = "Bedrock level";
const DEFAULT_DIMENSION = "Overworld";
const WORLD_REFRESH_DEBOUNCE_MS = 400;
const DIMENSIONS = [
  { id: "Overworld", label: "主世界", Icon: TreePine },
  { id: "Nether", label: "下界", Icon: Flame },
  { id: "TheEnd", label: "末地", Icon: Orbit },
] as const;

interface MapFocusTarget {
  x: number;
  z: number;
  nonce: number;
}

type MobilePanel = "dimensions" | "players" | "lands";

export function App() {
  const live = useLivePlayers();
  const [worlds, setWorlds] = useState<WorldMeta[]>([]);
  const [lands, setLands] = useState<LandClaim[]>([]);
  const [selectedDimension, setSelectedDimension] = useState(DEFAULT_DIMENSION);
  const [error, setError] = useState("");
  const [landError, setLandError] = useState("");
  const [focusTarget, setFocusTarget] = useState<MapFocusTarget | null>(null);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel | null>(null);
  const selectedWorldMeta = useMemo(
    () => selectWorldMeta(worlds, selectedDimension, DEFAULT_WORLD),
    [selectedDimension, worlds],
  );
  const selectedWorld = selectedWorldMeta?.world ?? DEFAULT_WORLD;

  useEffect(() => {
    listWorlds()
      .then((nextWorlds) => {
        setWorlds(nextWorlds);
        setError("");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!live.tilesReady) {
      return;
    }
    if (Array.isArray(live.tilesReady.worlds)) {
      setWorlds(live.tilesReady.worlds);
      setError("");
      return;
    }
    let cancelled = false;
    const refreshTimer = window.setTimeout(() => {
      listWorlds()
        .then((nextWorlds) => {
          if (!cancelled) {
            setWorlds(nextWorlds);
            setError("");
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
    }, WORLD_REFRESH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
    };
  }, [live.tilesReady]);

  useEffect(() => {
    let cancelled = false;
    const cacheBust =
      live.landsUpdated &&
      live.landsUpdated.dimension === selectedDimension &&
      segmentKey(live.landsUpdated.world) === segmentKey(selectedWorld)
        ? live.landsUpdated.updatedAt
        : undefined;

    fetchLands(selectedWorld, selectedDimension, cacheBust)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setLands(response.claims);
        setLandError("");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLands([]);
          setLandError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [live.landsUpdated, selectedDimension, selectedWorld]);

  const selectedPlayers = live.players.filter(
    (player) =>
      player.dimension === selectedDimension && segmentKey(player.world) === segmentKey(selectedWorld),
  );
  const selectedDimensionLabel = DIMENSIONS.find(({ id }) => id === selectedDimension)?.label ?? selectedDimension;
  const selectedLands = useMemo(
    () =>
      lands.filter(
        (land) =>
          land.dimension === selectedDimension && segmentKey(land.world) === segmentKey(selectedWorld),
      ),
    [lands, selectedDimension, selectedWorld],
  );
  const birthplace = useMemo(() => selectBirthplace(selectedLands), [selectedLands]);
  const publicLands = useMemo(
    () => selectedLands.filter((land) => land.publicTeleport === true),
    [selectedLands],
  );
  const SelectedDimensionIcon = DIMENSIONS.find(({ id }) => id === selectedDimension)?.Icon ?? TreePine;
  const mobilePanelTitle =
    mobilePanel === "dimensions" ? "切换维度" : mobilePanel === "players" ? "在线玩家" : mobilePanel === "lands" ? "公开领地" : "";
  const mobilePanelMeta =
    mobilePanel === "dimensions"
      ? selectedDimensionLabel
      : mobilePanel === "players"
        ? `${selectedPlayers.length} 人在线`
        : mobilePanel === "lands"
          ? `${publicLands.length} 个可传送`
          : "";

  const selectDimension = (dimension: string) => {
    setSelectedDimension(dimension);
    setMobilePanel(null);
  };
  const focusMap = (x: number, z: number) => {
    setFocusTarget({ x, z, nonce: Date.now() });
    setMobilePanel(null);
  };
  const toggleMobilePanel = (panel: MobilePanel) => {
    setMobilePanel((current) => (current === panel ? null : panel));
  };

  return (
    <main className="app-shell">
      <section className="map-surface" aria-label="服务器地图">
        <MapCanvas
          world={selectedWorld}
          dimension={selectedDimension}
          players={selectedPlayers}
          lands={publicLands}
          birthplace={birthplace}
          worldMeta={selectedWorldMeta}
          tilesReady={live.tilesReady}
          focusTarget={focusTarget}
        />
        <div className="map-hud" aria-label="地图状态">
          <div className="map-hud-item map-hud-dimension">
            <span>维度</span>
            <strong>{selectedDimensionLabel}</strong>
          </div>
          <div className="map-hud-item">
            <span>区块</span>
            <strong>{selectedWorldMeta ? selectedWorldMeta.chunkCount.toLocaleString() : "0"}</strong>
          </div>
          <div className="map-hud-item">
            <span>在线</span>
            <strong>{selectedPlayers.length}</strong>
          </div>
          <div className="map-hud-item">
            <span>领地</span>
            <strong>{publicLands.length}</strong>
          </div>
        </div>
      </section>

      <aside
        id="map-info-panel"
        className={mobilePanel ? "side-panel mobile-panel-open" : "side-panel"}
        data-mobile-panel={mobilePanel ?? "closed"}
        data-testid="mobile-panel"
        aria-label="地图信息面板"
      >
        <div className="mobile-panel-heading">
          <div>
            <strong>{mobilePanelTitle}</strong>
            <span>{mobilePanelMeta}</span>
          </div>
          <button type="button" aria-label="关闭信息面板" title="关闭" onClick={() => setMobilePanel(null)}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <header className="panel-header">
          <div className="panel-title-row">
            <div>
              <h1>Endstone Live Map</h1>
              <p className={live.connected ? "status status-online" : "status"}>
                <RadioTower size={15} aria-hidden="true" />
                {live.connected ? "实时连接" : "等待连接"}
              </p>
            </div>
          </div>
          <div className="dimension-tabs" role="tablist" aria-label="维度">
            {DIMENSIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selectedDimension === id}
                aria-label={`${label}（${id}）`}
                className={selectedDimension === id ? "active" : ""}
                onClick={() => selectDimension(id)}
              >
                <Icon size={15} aria-hidden="true" strokeWidth={1.8} />
                {label}
              </button>
            ))}
          </div>
        </header>

        {error ? <p className="error-banner world-error-banner">{error}</p> : null}

        <section className="players-panel" aria-labelledby="players-title">
          <h2 id="players-title">
            <LocateFixed size={17} aria-hidden="true" />
            在线玩家
          </h2>
          <PlayerList
            players={selectedPlayers}
            onSelectPlayer={(player) => focusMap(player.x, player.z)}
          />
        </section>

        <section className="lands-panel" aria-labelledby="lands-title">
          <h2 id="lands-title">
            <LandPlot size={17} aria-hidden="true" />
            领地标注
          </h2>
          {landError ? <p className="error-banner">{landError}</p> : null}
          <LandList
            lands={publicLands}
            onSelectLand={(land) => focusMap(land.teleport.x, land.teleport.z)}
          />
        </section>
      </aside>

      <nav className="mobile-navigation" aria-label="移动端地图导航" data-testid="mobile-navigation">
        <button
          type="button"
          className={mobilePanel === null ? "active" : ""}
          aria-current={mobilePanel === null ? "page" : undefined}
          aria-label="查看地图"
          onClick={() => setMobilePanel(null)}
        >
          <MapIcon size={20} aria-hidden="true" />
          <span>地图</span>
        </button>
        <button
          type="button"
          className={mobilePanel === "dimensions" ? "active" : ""}
          aria-controls="map-info-panel"
          aria-expanded={mobilePanel === "dimensions"}
          aria-label={`切换维度，当前${selectedDimensionLabel}`}
          onClick={() => toggleMobilePanel("dimensions")}
        >
          <SelectedDimensionIcon size={20} aria-hidden="true" />
          <span>{selectedDimensionLabel}</span>
        </button>
        <button
          type="button"
          className={mobilePanel === "players" ? "active" : ""}
          aria-controls="map-info-panel"
          aria-expanded={mobilePanel === "players"}
          aria-label={`在线玩家，${selectedPlayers.length} 人`}
          onClick={() => toggleMobilePanel("players")}
        >
          <Users size={20} aria-hidden="true" />
          <span>玩家</span>
          <small aria-hidden="true">{selectedPlayers.length}</small>
        </button>
        <button
          type="button"
          className={mobilePanel === "lands" ? "active" : ""}
          aria-controls="map-info-panel"
          aria-expanded={mobilePanel === "lands"}
          aria-label={`公开领地，${publicLands.length} 个`}
          onClick={() => toggleMobilePanel("lands")}
        >
          <LandPlot size={20} aria-hidden="true" />
          <span>领地</span>
          <small aria-hidden="true">{publicLands.length}</small>
        </button>
      </nav>
    </main>
  );
}

export function selectWorldMeta(
  worlds: WorldMeta[],
  dimension: string,
  preferredWorld: string,
): WorldMeta | null {
  const candidates = worlds.filter((world) => world.dimension === dimension);
  return (
    candidates.find((world) => segmentKey(world.world) === segmentKey(preferredWorld)) ??
    candidates.reduce<WorldMeta | null>(
      (latest, world) => (!latest || world.updatedAt > latest.updatedAt ? world : latest),
      null,
    )
  );
}

const BIRTHPLACE_LABELS = new Set([
  "spawn",
  "worldspawn",
  "birthplace",
  "出生地",
  "出生点",
  "世界出生地",
  "世界出生点",
  "重生点",
]);
const BIRTHPLACE_FALLBACK_LABELS = new Set(["主城", "主城区"]);

export function selectBirthplace(lands: LandClaim[]): { x: number; z: number } | null {
  let selected: LandClaim | null = null;
  let selectedPriority = Number.POSITIVE_INFINITY;

  for (const land of lands) {
    if (!Number.isFinite(land.teleport.x) || !Number.isFinite(land.teleport.z)) {
      continue;
    }
    const priority = birthplacePriority(land);
    if (priority < selectedPriority) {
      selected = land;
      selectedPriority = priority;
    }
  }

  return selected ? { x: selected.teleport.x, z: selected.teleport.z } : null;
}

function birthplacePriority(land: LandClaim) {
  const name = normalizeLocationLabel(land.name);
  const idParts = land.id.split(":").map(normalizeLocationLabel);
  if (BIRTHPLACE_LABELS.has(name)) {
    return 0;
  }
  if (idParts.some((part) => BIRTHPLACE_LABELS.has(part))) {
    return 1;
  }
  if (name.includes("出生") || name.includes("spawn") || name.includes("birthplace")) {
    return 2;
  }
  if (BIRTHPLACE_FALLBACK_LABELS.has(name)) {
    return 3;
  }
  if (idParts.some((part) => BIRTHPLACE_FALLBACK_LABELS.has(part))) {
    return 4;
  }
  return Number.POSITIVE_INFINITY;
}

function normalizeLocationLabel(value: string) {
  return String(value).trim().toLocaleLowerCase().replace(/[\s_.\-/]+/g, "");
}
