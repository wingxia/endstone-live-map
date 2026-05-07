import { MapPin } from "lucide-react";

import type { Marker } from "../api";

interface MarkerListProps {
  markers: Marker[];
}

export function MarkerList({ markers }: MarkerListProps) {
  if (markers.length === 0) {
    return <p className="empty-state">暂无标注</p>;
  }

  return (
    <ul className="item-list">
      {markers.map((marker) => (
        <li key={marker.id}>
          <span className="item-icon">
            <MapPin size={16} aria-hidden="true" />
          </span>
          <span>
            <strong>{marker.title}</strong>
            <small>
              {Math.round(marker.x)}, {Math.round(marker.y)}, {Math.round(marker.z)}
            </small>
            {marker.description ? <em>{marker.description}</em> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
