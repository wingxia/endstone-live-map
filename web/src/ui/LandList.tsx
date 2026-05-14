import { LandPlot } from "lucide-react";

import type { LandClaim } from "../api";

interface LandListProps {
  lands: LandClaim[];
}

export function LandList({ lands }: LandListProps) {
  if (lands.length === 0) {
    return <p className="empty-state">当前维度没有领地标注</p>;
  }

  return (
    <ul className="item-list land-list">
      {lands.slice(0, 12).map((land) => (
        <li key={land.id}>
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
        </li>
      ))}
      {lands.length > 12 ? (
        <li className="list-more">
          <span />
          <span>
            <strong>还有 {lands.length - 12} 个领地</strong>
            <small>地图中已全部标注</small>
          </span>
          <span />
        </li>
      ) : null}
    </ul>
  );
}
