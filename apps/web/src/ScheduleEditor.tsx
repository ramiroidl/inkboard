import { useState } from "react";

import type {
  QuietHours,
  ScheduleRule,
  ScheduleRuleInput,
  ScheduleState,
  ScreenSummary,
} from "@inkboard/contracts";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  return body?.message ?? body?.error ?? `Save failed (${response.status})`;
}

export function ScheduleEditor({
  screens,
  schedules,
  scheduleState,
  timeZone,
  onSaved,
}: {
  screens: ScreenSummary[];
  schedules: ScheduleRule[];
  scheduleState: ScheduleState;
  timeZone: string;
  onSaved: () => void;
}) {
  const [rules, setRules] = useState<ScheduleRuleInput[]>(schedules);
  const [message, setMessage] = useState<string | null>(null);

  const update = (index: number, changes: Partial<ScheduleRuleInput>) =>
    setRules((current) =>
      current.map((rule, position) => (position === index ? { ...rule, ...changes } : rule)),
    );

  const move = (index: number, offset: -1 | 1) =>
    setRules((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) {
        return current;
      }
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  const toggleDay = (index: number, day: number) => {
    const rule = rules[index]!;
    update(index, {
      days: rule.days.includes(day)
        ? rule.days.filter((value) => value !== day)
        : [...rule.days, day].sort((left, right) => left - right),
    });
  };

  const save = async () => {
    const response = await fetch("api/v1/admin/schedules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rules }),
    });
    if (!response.ok) {
      setMessage(await readError(response));
      return;
    }
    const body = (await response.json()) as { rules: ScheduleRule[] };
    setRules(body.rules);
    setMessage(
      body.rules.length === 0
        ? "No schedules."
        : `Saved ${body.rules.length} schedule${body.rules.length === 1 ? "" : "s"}.`,
    );
    onSaved();
  };

  return (
    <div className="rotation-editor">
      <ol className="schedule-list">
        {rules.map((rule, index) => (
          <li key={rule.id ?? `new-${index}`}>
            <div className="schedule-row">
              <select
                aria-label="Screen"
                value={rule.screenId}
                onChange={(event) => update(index, { screenId: event.target.value })}
              >
                {screens.map((screen) => (
                  <option key={screen.id} value={screen.id}>
                    {screen.name}
                  </option>
                ))}
              </select>
              <input
                type="time"
                aria-label="Start"
                value={rule.start}
                onChange={(event) => update(index, { start: event.target.value })}
              />
              <span className="hint">to</span>
              <input
                type="time"
                aria-label="End"
                value={rule.end}
                onChange={(event) => update(index, { end: event.target.value })}
              />
              <div className="widget-actions">
                <button
                  type="button"
                  aria-label="Higher priority"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Lower priority"
                  disabled={index === rules.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label="Remove schedule"
                  onClick={() => setRules(rules.filter((_, position) => position !== index))}
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="day-toggles" role="group" aria-label="Days">
              {DAY_LABELS.map((label, day) => (
                <label key={label} className={rule.days.includes(day) ? "selected" : ""}>
                  <input
                    type="checkbox"
                    checked={rule.days.includes(day)}
                    onChange={() => toggleDay(index, day)}
                  />
                  {label}
                </label>
              ))}
              {rule.id !== undefined && rule.id === scheduleState.activeRuleId ? (
                <span className="badge active">Active now</span>
              ) : null}
            </div>
          </li>
        ))}
        {rules.length === 0 ? <li className="hint">No time-based schedules.</li> : null}
      </ol>
      <div className="editor-buttons">
        <button
          type="button"
          disabled={screens.length === 0}
          onClick={() =>
            setRules([
              ...rules,
              { screenId: screens[0]!.id, days: [1, 2, 3, 4, 5], start: "07:00", end: "09:00" },
            ])
          }
        >
          Add schedule
        </button>
        <button type="button" className="primary" onClick={() => void save()}>
          Save schedules
        </button>
      </div>
      <p className="hint">
        Times use {timeZone}. A window whose end is earlier than its start runs overnight. When
        windows overlap, the higher one in the list wins. The previous screen returns when a window
        ends.
      </p>
      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}

export function QuietHoursEditor({
  quietHours,
  active,
  onSaved,
}: {
  quietHours: QuietHours;
  active: boolean;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(quietHours);
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    const response = await fetch("api/v1/admin/quiet-hours", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) {
      setMessage(await readError(response));
      return;
    }
    setDraft((await response.json()) as QuietHours);
    setMessage("Quiet hours saved.");
    onSaved();
  };

  return (
    <div className="rotation-editor">
      <div className="schedule-row">
        <label className="inline-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          Enabled
        </label>
        <input
          type="time"
          aria-label="Quiet hours start"
          value={draft.start}
          onChange={(event) => setDraft({ ...draft, start: event.target.value })}
        />
        <span className="hint">to</span>
        <input
          type="time"
          aria-label="Quiet hours end"
          value={draft.end}
          onChange={(event) => setDraft({ ...draft, end: event.target.value })}
        />
        <button type="button" className="primary" onClick={() => void save()}>
          Save quiet hours
        </button>
        {active ? <span className="badge active">Quiet now</span> : null}
      </div>
      {message ? <p className="hint">{message}</p> : null}
    </div>
  );
}
