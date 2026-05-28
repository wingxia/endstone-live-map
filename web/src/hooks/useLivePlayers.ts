import { useEffect, useMemo, useState } from "react";

import { liveUrl, type BlockUpdatesMessage, type ChunkReadyMessage, type ChunksReadyMessage, type LandsUpdatedMessage, type LiveMessage, type PlayerState } from "../api";

interface UseLivePlayersResult {
  players: PlayerState[];
  chunkReady: ChunkReadyMessage | null;
  chunksReady: ChunksReadyMessage | null;
  blockUpdates: BlockUpdatesMessage | null;
  landsUpdated: LandsUpdatedMessage | null;
  connected: boolean;
}

export function useLivePlayers(): UseLivePlayersResult {
  const [playersById, setPlayersById] = useState<Map<string, PlayerState>>(new Map());
  const [chunkReady, setChunkReady] = useState<ChunkReadyMessage | null>(null);
  const [chunksReady, setChunksReady] = useState<ChunksReadyMessage | null>(null);
  const [blockUpdates, setBlockUpdates] = useState<BlockUpdatesMessage | null>(null);
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
        if (message.type === "chunks_ready" && Array.isArray(message.chunks)) {
          setChunksReady(message as ChunksReadyMessage);
        }
        if (message.type === "block_updates" && Array.isArray(message.updates)) {
          setBlockUpdates(message as BlockUpdatesMessage);
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
  return { players, chunkReady, chunksReady, blockUpdates, landsUpdated, connected };
}
