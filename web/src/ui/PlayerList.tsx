import { playerAvatarUrl, type PlayerState } from "../api";

interface PlayerListProps {
  players: PlayerState[];
  trackedPlayerIds?: ReadonlySet<string>;
  onSelectPlayer?: (player: PlayerState) => void;
}

export function PlayerList({ players, trackedPlayerIds = new Set(), onSelectPlayer }: PlayerListProps) {
  if (players.length === 0) {
    return <p className="empty-state">当前维度没有在线玩家</p>;
  }

  return (
    <ul className="item-list">
      {players.map((player) => {
        const tracked = trackedPlayerIds.has(String(player.id));
        return (
          <li key={player.id}>
            <button
              type="button"
              className={tracked ? "item-action player-item-action is-tracked" : "item-action player-item-action"}
              aria-label={`${tracked ? "取消追踪" : "追踪"}玩家 ${player.name}`}
              aria-pressed={tracked}
              onClick={() => onSelectPlayer?.(player)}
            >
              <span className="avatar" aria-hidden="true">
                {playerAvatarUrl(player) ? (
                  <img src={playerAvatarUrl(player)} alt="" loading="lazy" />
                ) : (
                  player.name.slice(0, 1).toUpperCase()
                )}
              </span>
              <span>
                <strong>{player.name}</strong>
                <small>
                  {Math.round(player.x)}, {Math.round(player.y)}, {Math.round(player.z)}
                </small>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
