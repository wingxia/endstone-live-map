import { UserRound } from "lucide-react";

import type { PlayerState } from "../api";

interface PlayerListProps {
  players: PlayerState[];
}

export function PlayerList({ players }: PlayerListProps) {
  if (players.length === 0) {
    return <p className="empty-state">当前维度没有在线玩家</p>;
  }

  return (
    <ul className="item-list">
      {players.map((player) => (
        <li key={player.id}>
          <span className="avatar" aria-hidden="true">
            {player.name.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{player.name}</strong>
            <small>
              {Math.round(player.x)}, {Math.round(player.y)}, {Math.round(player.z)}
            </small>
          </span>
          <UserRound className="trailing-icon" size={16} aria-hidden="true" />
        </li>
      ))}
    </ul>
  );
}
