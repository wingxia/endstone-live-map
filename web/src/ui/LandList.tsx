import { LandPlot, Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { LandClaim } from "../api";

interface LandListProps {
  lands: LandClaim[];
  onSelectLand?: (land: LandClaim) => void;
}

export function LandList({ lands, onSelectLand }: LandListProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredLands = useMemo(() => {
    if (!normalizedQuery) {
      return lands;
    }
    return lands.filter((land) => [land.name, land.owner].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)));
  }, [lands, normalizedQuery]);

  if (lands.length === 0) {
    return <p className="empty-state">当前维度没有公开传送领地</p>;
  }

  return (
    <div className="land-list-panel">
      <label className="land-search">
        <Search size={15} aria-hidden="true" />
        <span className="visually-hidden">搜索领地</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索领地或主人" />
      </label>
      {filteredLands.length === 0 ? (
        <p className="empty-state">没有匹配的公开传送领地</p>
      ) : (
        <ul className="item-list land-list">
          {filteredLands.map((land) => (
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
      )}
    </div>
  );
}
