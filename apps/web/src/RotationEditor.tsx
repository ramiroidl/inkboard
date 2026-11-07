import { useState } from "react";

import type { RotationSettings, ScreenSummary } from "@inkboard/contracts";

export function RotationEditor({
  screens,
  rotation,
  onSaved,
}: {
  screens: ScreenSummary[];
  rotation: RotationSettings;
  onSaved: (rotation: RotationSettings) => void;
}) {
  const [screenIds, setScreenIds] = useState(rotation.screenIds);
  const [intervalMinutes, setIntervalMinutes] = useState(rotation.intervalMinutes);
  const [message, setMessage] = useState<string | null>(null);

  const included = screenIds
    .map((id) => screens.find((screen) => screen.id === id))
    .filter((screen): screen is ScreenSummary => screen !== undefined);
  const excluded = screens.filter((screen) => !screenIds.includes(screen.id));

  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= screenIds.length) {
      return;
    }
    const next = [...screenIds];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setScreenIds(next);
  };

  const save = async () => {
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
      setMessage("Choose an interval from 5 to 1,440 minutes.");
      return;
    }
    const response = await fetch("api/v1/admin/rotation", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screenIds, intervalMinutes }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      setMessage(body?.message ?? body?.error ?? `Save failed (${response.status})`);
      return;
    }
    const saved = (await response.json()) as RotationSettings;
    setScreenIds(saved.screenIds);
    setMessage(
      saved.screenIds.length === 0
        ? "Rotation is off."
        : `Rotating ${saved.screenIds.length} screen${saved.screenIds.length === 1 ? "" : "s"}.`,
    );
    onSaved(saved);
  };

  return (
    <div className="rotation-editor">
      <ol className="rotation-list">
        {included.map((screen, index) => (
          <li key={screen.id}>
            <span>{screen.name}</span>
            <div className="widget-actions">
              <button
                type="button"
                aria-label={`Move ${screen.name} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${screen.name} down`}
                disabled={index === included.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove ${screen.name} from rotation`}
                onClick={() => setScreenIds(screenIds.filter((id) => id !== screen.id))}
              >
                ✕
              </button>
            </div>
          </li>
        ))}
        {included.length === 0 ? <li className="hint">No screens rotate automatically.</li> : null}
      </ol>

      <div className="rotation-controls">
        <label className="field">
          <span>Add to rotation</span>
          <select
            value=""
            disabled={excluded.length === 0}
            onChange={(event) => setScreenIds([...screenIds, event.target.value])}
          >
            <option value="" disabled>
              {excluded.length === 0 ? "All screens added" : "Choose a screen…"}
            </option>
            {excluded.map((screen) => (
              <option key={screen.id} value={screen.id}>
                {screen.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Change every (minutes)</span>
          <input
            type="number"
            min={5}
            max={1440}
            step={1}
            value={Number.isFinite(intervalMinutes) ? intervalMinutes : ""}
            onChange={(event) => setIntervalMinutes(event.target.valueAsNumber)}
          />
          <small className="hint">5 to 1,440 minutes</small>
        </label>
        <button type="button" className="primary" onClick={() => void save()}>
          Save rotation
        </button>
      </div>
      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}
