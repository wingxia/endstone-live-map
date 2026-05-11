import { Layers, LocateFixed, MapPin, RadioTower } from "lucide-react";
import { useEffect, useState } from "react";

import { createMarker, listMarkers, listWorlds, segmentKey, type Marker, type MarkerDraft, type WorldMeta } from "../api";
import { useLivePlayers } from "../hooks/useLivePlayers";
import { MapCanvas } from "./MapCanvas";
import { MarkerForm } from "./MarkerForm";
import { MarkerList } from "./MarkerList";
import { PlayerList } from "./PlayerList";

const DEFAULT_WORLD = "Bedrock level";
const DEFAULT_DIMENSION = "Overworld";

export function App() {
  const live = useLivePlayers();
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [worlds, setWorlds] = useState<WorldMeta[]>([]);
  const [selectedDimension, setSelectedDimension] = useState(DEFAULT_DIMENSION);
  const [error, setError] = useState("");

  useEffect(() => {
    listMarkers()
      .then(setMarkers)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    listWorlds()
      .then(setWorlds)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (live.upsertedMarker) {
      setMarkers((current) => [live.upsertedMarker!, ...current.filter((marker) => marker.id !== live.upsertedMarker!.id)]);
    }
  }, [live.upsertedMarker]);

  useEffect(() => {
    if (live.deletedMarkerId) {
      setMarkers((current) => current.filter((marker) => marker.id !== live.deletedMarkerId));
    }
  }, [live.deletedMarkerId]);

  const handleCreateMarker = async (draft: MarkerDraft) => {
    const marker = await createMarker(draft);
    setMarkers((current) => [marker, ...current.filter((item) => item.id !== marker.id)]);
  };

  const selectedWorldMeta = worlds.find((world) => world.dimension === selectedDimension && segmentKey(world.world) === segmentKey(DEFAULT_WORLD)) || null;

  return (
    <main className="app-shell">
      <section className="map-surface" aria-label="服务器地图">
        <MapCanvas
          world={DEFAULT_WORLD}
          dimension={selectedDimension}
          players={live.players.filter((player) => player.dimension === selectedDimension)}
          markers={markers.filter((marker) => marker.dimension === selectedDimension)}
          worldMeta={selectedWorldMeta}
          chunkReady={live.chunkReady}
          blockUpdates={live.blockUpdates}
        />
        <div className="map-hud" aria-label="地图状态">
          <span>{selectedDimension}</span>
          <strong>{selectedWorldMeta ? selectedWorldMeta.chunkCount.toLocaleString() : "0"}</strong>
          <span>区块</span>
          <strong>{live.players.filter((player) => player.dimension === selectedDimension).length}</strong>
          <span>在线</span>
          <strong>{markers.filter((marker) => marker.dimension === selectedDimension).length}</strong>
          <span>标注</span>
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
          <PlayerList players={live.players.filter((player) => player.dimension === selectedDimension)} />
        </section>

        <section aria-labelledby="markers-title">
          <h2 id="markers-title">
            <MapPin size={17} aria-hidden="true" />
            地图标注
          </h2>
          <MarkerForm world={DEFAULT_WORLD} dimension={selectedDimension} onCreate={handleCreateMarker} />
          <MarkerList markers={markers.filter((marker) => marker.dimension === selectedDimension)} />
        </section>
      </aside>
    </main>
  );
}
