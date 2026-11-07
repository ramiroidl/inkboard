import { useEffect, useState } from "react";

import type { AdminCalendarsResponse, CalendarStatus } from "@inkboard/contracts";

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  return body?.message ?? body?.error ?? `Save failed (${response.status})`;
}

/** Shows calendar health and lets the user choose which Home Assistant calendars to merge. */
export function CalendarSettings({
  status,
  onSaved,
}: {
  status: CalendarStatus;
  onSaved: (status: CalendarStatus) => void;
}) {
  const [calendars, setCalendars] = useState<AdminCalendarsResponse | null>(null);
  const [selected, setSelected] = useState<string[]>(status.entityIds);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!status.homeAssistantConfigured) {
      return;
    }
    const controller = new AbortController();
    void fetch("api/v1/admin/calendars", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Controller returned ${response.status}`);
        }
        setCalendars((await response.json()) as AdminCalendarsResponse);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setMessage(reason instanceof Error ? reason.message : "Unable to list calendars");
        }
      });
    return () => controller.abort();
  }, [status.homeAssistantConfigured]);

  if (!status.homeAssistantConfigured) {
    return (
      <p className="empty-message">
        Set INKBOARD_HOME_ASSISTANT_URL and INKBOARD_HOME_ASSISTANT_TOKEN to show Home Assistant
        calendars.
      </p>
    );
  }

  // Keep selected calendars listed even when Home Assistant cannot be reached.
  const options = [
    ...(calendars?.available ?? []),
    ...status.calendars
      .filter(
        (calendar) => !calendars?.available.some((item) => item.entityId === calendar.entityId),
      )
      .map((calendar) => ({ entityId: calendar.entityId, name: calendar.name })),
  ];
  const sourceStatus = new Map(status.calendars.map((calendar) => [calendar.entityId, calendar]));
  const changed =
    selected.length !== status.entityIds.length ||
    selected.some((entityId) => !status.entityIds.includes(entityId));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch("api/v1/admin/calendars", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityIds: selected }),
      });
      if (!response.ok) {
        throw new Error(await readError(response));
      }
      const next = (await response.json()) as CalendarStatus;
      setSelected(next.entityIds);
      setMessage(
        next.entityIds.length === 0
          ? "No calendars selected."
          : `Showing ${next.eventCount} event${next.eventCount === 1 ? "" : "s"} from ${next.entityIds.length} calendar${next.entityIds.length === 1 ? "" : "s"}.`,
      );
      onSaved(next);
    } catch (reason: unknown) {
      setMessage(reason instanceof Error ? reason.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rotation-editor">
      {status.configured ? (
        <dl>
          <div>
            <dt>Upcoming events</dt>
            <dd>{status.eventCount}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{status.timeZone}</dd>
          </div>
          <div>
            <dt>Look ahead</dt>
            <dd>{status.lookAheadDays} days</dd>
          </div>
        </dl>
      ) : null}

      {calendars?.discoveryError ? (
        <p className="error-message">
          Could not list calendars from Home Assistant: {calendars.discoveryError}
        </p>
      ) : null}
      {calendars === null && message === null ? <p className="hint">Loading calendars…</p> : null}

      <ul className="calendar-list">
        {options.map((calendar) => {
          const source = sourceStatus.get(calendar.entityId);
          return (
            <li key={calendar.entityId}>
              <label className="inline-field">
                <input
                  type="checkbox"
                  checked={selected.includes(calendar.entityId)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, calendar.entityId]
                        : selected.filter((entityId) => entityId !== calendar.entityId),
                    )
                  }
                />
                <span className="calendar-name">{calendar.name}</span>
              </label>
              <span className="hint">
                {calendar.entityId}
                {source !== undefined
                  ? source.lastError !== null
                    ? ` · ${source.lastError}`
                    : ` · ${source.eventCount} event${source.eventCount === 1 ? "" : "s"}`
                  : ""}
              </span>
            </li>
          );
        })}
        {calendars !== null && options.length === 0 ? (
          <li className="hint">Home Assistant has no calendars.</li>
        ) : null}
      </ul>

      <div className="editor-buttons">
        <button
          type="button"
          className="primary"
          disabled={saving || !changed}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save calendars"}
        </button>
      </div>
      <p className="hint">
        Selected calendars are merged into the Calendar screen and the Calendar agenda widget. Each
        calendar keeps its last events if Home Assistant is unavailable.
      </p>
      {message ? <p className="hint">{message}</p> : null}
      {status.lastError ? <p className="error-message">{status.lastError}</p> : null}
    </div>
  );
}
