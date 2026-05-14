import { LandPlot } from "lucide-react";

import type { LandClaim } from "../api";

interface LandListProps {
  lands: LandClaim[];
  onSelectLand?: (land: LandClaim) => void;
}

export function LandList({ lands, onSelectLand }: LandListProps) {
  if (lands.length === 0) {
    return <p className="empty-state">当前维度没有公开传送领地</p>;
  }

  return (
    <ul className="item-list land-list">
      {lands.map((land) => (
        <li key={land.id}>
          <button type="button" className="item-action" onClick={() => onSelectLand?.(land)}>
            <span className="avatar land-avatar" aria-hidden="true">
              {land.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <strong>{land.name}</strong>
              <small>
                {land.owner} · {land.minX}, {land.minZ} 到 {land.maxX}, {land.maxZ}
              </small>
              <em>
                TP {land.teleport.x}, {land.teleport.y}, {land.teleport.z}
              </em>
            </span>
            <LandPlot className="trailing-icon" size={16} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}
