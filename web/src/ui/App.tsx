import { LandPlot, Layers, LocateFixed, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchLands, listWorlds, segmentKey, type LandClaim, type WorldMeta } from "../api";
import { useLivePlayers } from "../hooks/useLivePlayers";
import { LandList } from "./LandList";
import { MapCanvas } from "./MapCanvas";
import { PlayerList } from "./PlayerList";

const DEFAULT_WORLD = "Bedrock level";
const DEFAULT_DIMENSION = "Overworld";

export function App() {
  const live = useLivePlayers();
  const [worlds, setWorlds] = useState<WorldMeta[]>([]);
  const [lands, setLands] = useState<LandClaim[]>([]);
  const [selectedDimension, setSelectedDimension] = useState(DEFAULT_DIMENSION);
  const [error, setError] = useState("");
  const [landError, setLandError] = useState("");

  useEffect(() => {
    listWorlds()
      .then(setWorlds)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cacheBust =
      live.landsUpdated &&
      live.landsUpdated.dimension === selectedDimension &&
      segmentKey(live.landsUpdated.world) === segmentKey(DEFAULT_WORLD)
        ? live.landsUpdated.updatedAt
        : undefined;

    fetchLands(DEFAULT_WORLD, selectedDimension, cacheBust)
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
  }, [live.landsUpdated, selectedDimension]);

  const selectedWorldMeta = worlds.find((world) => world.dimension === selectedDimension && segmentKey(world.world) === segmentKey(DEFAULT_WORLD)) || null;
  const selectedPlayers = live.players.filter((player) => player.dimension === selectedDimension);

  return (
    <main className="app-shell">
      <section className="map-surface" aria-label="服务器地图">
        <MapCanvas
          world={DEFAULT_WORLD}
          dimension={selectedDimension}
          players={selectedPlayers}
          lands={lands}
          worldMeta={selectedWorldMeta}
          chunkReady={live.chunkReady}
          blockUpdates={live.blockUpdates}
        />
        <div className="map-hud" aria-label="地图状态">
          <span>{selectedDimension}</span>
          <strong>{selectedWorldMeta ? selectedWorldMeta.chunkCount.toLocaleString() : "0"}</strong>
          <span>区块</span>
          <strong>{selectedPlayers.length}</strong>
          <span>在线</span>
          <strong>{lands.length}</strong>
          <span>领地</span>
        </div>
      </section>

      <aside className="side-panel" aria-label="地图信息面板">
        <header className="panel-header">
          <div>
            <h1>Endstone Live Map</h1>
            <p className={live.connected ? "status status-online" : "status"}>
              <RadioTower size={15} aria-hidden="true" />
              {live.connected ? "实时连接" : "等待连接"}
            </p>
          </div>
          <div className="dimension-tabs" role="tablist" aria-label="维度">
            {["Overworld", "Nether", "TheEnd"].map((dimension) => (
              <button
                key={dimension}
                type="button"
                role="tab"
                aria-selected={selectedDimension === dimension}
                className={selectedDimension === dimension ? "active" : ""}
                onClick={() => setSelectedDimension(dimension)}
              >
                <Layers size={15} aria-hidden="true" />
                {dimension}
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
          <PlayerList players={selectedPlayers} />
        </section>

        <section aria-labelledby="lands-title">
          <h2 id="lands-title">
            <LandPlot size={17} aria-hidden="true" />
            领地标注
          </h2>
          {landError ? <p className="error-banner">{landError}</p> : null}
          <LandList lands={lands} />
        </section>
      </aside>
    </main>
  );
}
