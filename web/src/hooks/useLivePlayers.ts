import { useEffect, useMemo, useState } from "react";

import { liveUrl, type BlockUpdatesMessage, type ChunkReadyMessage, type LiveMessage, type Marker, type PlayerState } from "../api";

interface UseLivePlayersResult {
  players: PlayerState[];
  upsertedMarker: Marker | null;
  deletedMarkerId: string | null;
  chunkReady: ChunkReadyMessage | null;
  blockUpdates: BlockUpdatesMessage | null;
  connected: boolean;
}

export function useLivePlayers(): UseLivePlayersResult {
  const [playersById, setPlayersById] = useState<Map<string, PlayerState>>(new Map());
  const [upsertedMarker, setUpsertedMarker] = useState<Marker | null>(null);
  const [deletedMarkerId, setDeletedMarkerId] = useState<string | null>(null);
  const [chunkReady, setChunkReady] = useState<ChunkReadyMessage | null>(null);
  const [blockUpdates, setBlockUpdates] = useState<BlockUpdatesMessage | null>(null);
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
        if (message.type === "chunk_ready" && typeof message.chunkX === "number" && typeof message.chunkZ === "number") {
          setChunkReady(message as ChunkReadyMessage);
        }
        if (message.type === "block_updates" && Array.isArray(message.updates)) {
          setBlockUpdates(message as BlockUpdatesMessage);
        }
        if ((message.type === "marker_created" || message.type === "marker_updated") && message.marker) {
          setUpsertedMarker(message.marker);
        }
        if (message.type === "marker_deleted" && message.id) {
          setDeletedMarkerId(message.id);
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
  return { players, upsertedMarker, deletedMarkerId, chunkReady, blockUpdates, connected };
}
