import { playerAvatarUrl, type PlayerState } from "../api";

interface PlayerListProps {
  players: PlayerState[];
  onSelectPlayer?: (player: PlayerState) => void;
}

export function PlayerList({ players, onSelectPlayer }: PlayerListProps) {
  if (players.length === 0) {
    return <p className="empty-state">当前维度没有在线玩家</p>;
  }

  return (
    <ul className="item-list">
      {players.map((player) => (
        <li key={player.id}>
          <button type="button" className="item-action" onClick={() => onSelectPlayer?.(player)}>
            <span className="avatar" aria-hidden="true">
              {playerAvatarUrl(player) ? (
                <>
                  <img
                    src={playerAvatarUrl(player)}
                    alt=""
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                      const fallback = event.currentTarget.nextElementSibling as HTMLElement | null;
                      if (fallback) fallback.hidden = false;
                    }}
                  />
                  <span hidden>{player.name.slice(0, 1).toUpperCase()}</span>
                </>
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
      ))}
    </ul>
  );
}
