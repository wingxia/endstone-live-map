import { Plus } from "lucide-react";
import { useState } from "react";

import type { MarkerDraft } from "../api";

interface MarkerFormProps {
  world: string;
  dimension: string;
  onCreate: (marker: MarkerDraft) => Promise<void>;
}

export function MarkerForm({ world, dimension, onCreate }: MarkerFormProps) {
  const [title, setTitle] = useState("");
  const [coords, setCoords] = useState({ x: "0", y: "64", z: "0" });
  const [description, setDescription] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onCreate({
        world,
        dimension,
        x: Number(coords.x),
        y: Number(coords.y),
        z: Number(coords.z),
        title,
        description,
        createdBy,
      });
      setTitle("");
      setDescription("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="marker-form" onSubmit={submit}>
      <label>
        标题
        <input value={title} maxLength={80} required onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="coord-grid">
        {(["x", "y", "z"] as const).map((axis) => (
          <label key={axis}>
            {axis.toUpperCase()}
            <input
              value={coords[axis]}
              inputMode="numeric"
              onChange={(event) => setCoords((current) => ({ ...current, [axis]: event.target.value }))}
            />
          </label>
        ))}
      </div>
      <div className="marker-form-row">
        <label>
          创建者
          <input value={createdBy} maxLength={80} onChange={(event) => setCreatedBy(event.target.value)} />
        </label>
      </div>
      <label>
        说明
        <textarea value={description} rows={2} onChange={(event) => setDescription(event.target.value)} />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button type="submit" disabled={busy}>
        <Plus size={16} aria-hidden="true" />
        {busy ? "保存中" : "添加标注"}
      </button>
    </form>
  );
}
