import { useEffect, useMemo, useState } from "react";

import { liveUrl, type LandsUpdatedMessage, type LiveMessage, type PlayerState, type TilesReadyMessage } from "../api";

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
    let socket: WebSocket | null = null;

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
            setPlayersById(new Map(data.players.map((player) => [player.id, player])));
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
          setPlayersById(new Map(message.players.map((player) => [player.id, player])));
        }
        if (message.type === "tiles_ready" && Array.isArray(message.chunks)) {
          setTilesReady(message as TilesReadyMessage);
        }
        if (message.type === "lands_updated" && message.world && message.dimension) {
          setLandsUpdated(message as LandsUpdatedMessage);
        }
      });
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  const players = useMemo(() => [...playersById.values()].sort((a, b) => a.name.localeCompare(b.name)), [playersById]);
  return { players, tilesReady, landsUpdated, connected };
}
