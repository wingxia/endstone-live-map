import { useEffect, useMemo, useState } from "react";

import { liveUrl, type LandsUpdatedMessage, type LiveMessage, type PlayerState, type TilesReadyMessage } from "../api";

const PLAYER_SNAPSHOT_STALE_AFTER_MS = 15_000;

interface UseLivePlayersResult {
  players: PlayerState[];
  tilesReady: TilesReadyMessage | null;
  landsUpdated: LandsUpdatedMessage | null;
  connected: boolean;
}

export function useLivePlayers(): UseLivePlayersResult {
  const [playersById, setPlayersById] = useState<Map<string, PlayerState>>(new Map());
  const [tilesReady, setTilesReady] = useState<TilesReadyMessage | null>(null);
  const [landsUpdated, setLandsUpdated] = useState<LandsUpdatedMessage | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let closed = false;
    let retryTimer = 0;
    let staleTimer = 0;
    let lastPlayerSnapshotAt = 0;
    let socket: WebSocket | null = null;

    const replacePlayers = (players: PlayerState[]) => {
      lastPlayerSnapshotAt = Date.now();
      setPlayersById(new Map(players.map((player) => [player.id, player])));
    };

    const connect = () => {
      if (import.meta.env.DEV) {
        import("../mockData").then(({ mockPlayers }) => {
          setPlayersById(new Map(mockPlayers.map((player) => [player.id, { ...player, updatedAt: Date.now() }])));
          setConnected(true);
        });
        return;
      }

      fetch("/api/players")
        .then((response) => (response.ok ? response.json() : { players: [] }))
        .then((data: { players?: PlayerState[] }) => {
          if (!closed && Array.isArray(data.players)) {
            replacePlayers(data.players);
          }
        })
        .catch(() => {
          // The WebSocket below is the authoritative live path; this initial fetch is best-effort.
        });

      socket = new WebSocket(liveUrl());
      socket.addEventListener("open", () => setConnected(true));
      socket.addEventListener("close", () => {
        setConnected(false);
        if (!closed) {
          retryTimer = window.setTimeout(connect, 2000);
        }
      });
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as LiveMessage;
        if (message.type === "player_snapshot" && message.players) {
          replacePlayers(message.players);
        }
        if (message.type === "tiles_ready" && Array.isArray(message.chunks)) {
          setTilesReady(message as TilesReadyMessage);
        }
        if (message.type === "lands_updated" && message.world && message.dimension) {
          setLandsUpdated(message as LandsUpdatedMessage);
        }
      });
    };

    staleTimer = window.setInterval(() => {
      if (lastPlayerSnapshotAt > 0 && Date.now() - lastPlayerSnapshotAt >= PLAYER_SNAPSHOT_STALE_AFTER_MS) {
        lastPlayerSnapshotAt = 0;
        setPlayersById(new Map());
      }
    }, 1000);
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(staleTimer);
      socket?.close();
    };
  }, []);

  const players = useMemo(() => [...playersById.values()].sort((a, b) => a.name.localeCompare(b.name)), [playersById]);
  return { players, tilesReady, landsUpdated, connected };
}
