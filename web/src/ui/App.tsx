import { Flame, LandPlot, LocateFixed, Orbit, RadioTower, TreePine } from "lucide-react";
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

export function App() {
  const live = useLivePlayers();
  const [worlds, setWorlds] = useState<WorldMeta[]>([]);
  const [lands, setLands] = useState<LandClaim[]>([]);
  const [selectedDimension, setSelectedDimension] = useState(DEFAULT_DIMENSION);
  const [error, setError] = useState("");
  const [landError, setLandError] = useState("");
  const [focusTarget, setFocusTarget] = useState<MapFocusTarget | null>(null);
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
  const publicLands = useMemo(() => lands.filter((land) => land.publicTeleport === true), [lands]);

  return (
    <main className="app-shell">
      <section className="map-surface" aria-label="服务器地图">
        <MapCanvas
          world={selectedWorld}
          dimension={selectedDimension}
          players={selectedPlayers}
          lands={publicLands}
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

      <aside className="side-panel" aria-label="地图信息面板">
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
                onClick={() => setSelectedDimension(id)}
              >
                <Icon size={15} aria-hidden="true" strokeWidth={1.8} />
                {label}
              </button>
            ))}
          </div>
        </header>

        {error ? <p className="error-banner">{error}</p> : null}

        <section aria-labelledby="players-title">
          <h2 id="players-title">
            <LocateFixed size={17} aria-hidden="true" />
            在线玩家
          </h2>
          <PlayerList
            players={selectedPlayers}
            onSelectPlayer={(player) => setFocusTarget({ x: player.x, z: player.z, nonce: Date.now() })}
          />
        </section>

        <section aria-labelledby="lands-title">
          <h2 id="lands-title">
            <LandPlot size={17} aria-hidden="true" />
            领地标注
          </h2>
          {landError ? <p className="error-banner">{landError}</p> : null}
          <LandList
            lands={publicLands}
            onSelectLand={(land) => setFocusTarget({ x: land.teleport.x, z: land.teleport.z, nonce: Date.now() })}
          />
        </section>
      </aside>
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
