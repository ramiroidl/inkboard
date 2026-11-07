import { useCallback, useEffect, useState } from "react";

import type {
  AdminDevicesResponse,
  AdminScreensResponse,
  AdminStatusResponse,
  AdminWidgetsResponse,
  CustomScreen,
  RotationSettings,
  ScreenId,
  WidgetDescriptor,
} from "@inkboard/contracts";

import { CalendarSettings } from "./CalendarSettings.js";
import { DeviceSetup } from "./DeviceSetup.js";
import { BackupSettings } from "./BackupSettings.js";
import { MicrosoftTodoSettings } from "./MicrosoftTodoSettings.js";
import { RotationEditor } from "./RotationEditor.js";
import { QuietHoursEditor, ScheduleEditor } from "./ScheduleEditor.js";
import { ScreenEditor } from "./ScreenEditor.js";

type EditorState = { mode: "closed" } | { mode: "new" } | { mode: "edit"; screen: CustomScreen };

export function App() {
  const [status, setStatus] = useState<AdminStatusResponse | null>(null);
  const [devices, setDevices] = useState<AdminDevicesResponse["devices"]>([]);
  const [screens, setScreens] = useState<AdminScreensResponse["screens"]>([]);
  const [rotation, setRotation] = useState<RotationSettings | null>(null);
  const [testPatternHidden, setTestPatternHidden] = useState(false);
  const [importCount, setImportCount] = useState(0);
  const [schedule, setSchedule] = useState<Pick<
    AdminScreensResponse,
    "schedules" | "quietHours" | "scheduleState" | "timeZone"
  > | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [widgetTypes, setWidgetTypes] = useState<WidgetDescriptor[]>([]);
  const [previewVersion, setPreviewVersion] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  const reloadScreens = useCallback(async () => {
    const response = await fetch("api/v1/admin/screens");
    if (!response.ok) {
      throw new Error(`Controller returned ${response.status}`);
    }
    const body = (await response.json()) as AdminScreensResponse;
    setScreens(body.screens);
    setRotation(body.rotation);
    setTestPatternHidden(body.testPatternHidden);
    setSchedule({
      schedules: body.schedules,
      quietHours: body.quietHours,
      scheduleState: body.scheduleState,
      timeZone: body.timeZone,
    });
    setPreviewVersion(Date.now());
  }, []);

  const reloadScreensQuietly = useCallback(() => {
    void reloadScreens().catch(() => undefined);
  }, [reloadScreens]);

  const setTestPatternVisible = async (visible: boolean) => {
    const response = await fetch("api/v1/admin/test-pattern", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hidden: !visible }),
    });
    if (!response.ok) {
      setError(`Unable to update the test pattern (${response.status})`);
      return;
    }
    await reloadScreens();
  };

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("api/v1/admin/status", { signal: controller.signal }),
      fetch("api/v1/admin/devices", { signal: controller.signal }),
      fetch("api/v1/admin/widgets", { signal: controller.signal }),
    ])
      .then(async ([statusResponse, devicesResponse, widgetsResponse]) => {
        if (!statusResponse.ok || !devicesResponse.ok || !widgetsResponse.ok) {
          throw new Error(
            `Controller returned ${statusResponse.status}/${devicesResponse.status}/${widgetsResponse.status}`,
          );
        }
        const [nextStatus, nextDevices, nextWidgets] = await Promise.all([
          statusResponse.json() as Promise<AdminStatusResponse>,
          devicesResponse.json() as Promise<AdminDevicesResponse>,
          widgetsResponse.json() as Promise<AdminWidgetsResponse>,
        ]);
        setStatus(nextStatus);
        setDevices(nextDevices.devices);
        setWidgetTypes(nextWidgets.widgets);
        await reloadScreens();
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Controller unavailable");
        }
      });
    return () => controller.abort();
  }, [reloadScreens]);

  const editScreen = async (screenId: ScreenId) => {
    const response = await fetch(`api/v1/admin/screens/${encodeURIComponent(screenId)}`);
    if (!response.ok) {
      setError(`Unable to load screen (${response.status})`);
      return;
    }
    setEditor({ mode: "edit", screen: (await response.json()) as CustomScreen });
  };

  const deleteScreen = async (screenId: ScreenId, name: string) => {
    if (
      !window.confirm(`Delete "${name}"? Devices showing it will return to the default screen.`)
    ) {
      return;
    }
    const response = await fetch(`api/v1/admin/screens/${encodeURIComponent(screenId)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      setError(`Unable to delete screen (${response.status})`);
      return;
    }
    await reloadScreens();
  };

  const setInvertColors = async (deviceId: string, invertColors: boolean) => {
    const response = await fetch(`api/v1/admin/devices/${encodeURIComponent(deviceId)}/display`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invertColors }),
    });
    if (!response.ok) {
      setError(`Unable to update the display (${response.status})`);
      return;
    }
    setError(null);
    setDevices((current) =>
      current.map((device) => (device.id === deviceId ? { ...device, invertColors } : device)),
    );
  };

  const selectScreen = async (deviceId: string, screenId: ScreenId) => {
    const response = await fetch(`api/v1/admin/devices/${encodeURIComponent(deviceId)}/screen`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ screenId }),
    });
    if (!response.ok) {
      setError(`Unable to select screen (${response.status})`);
      return;
    }
    setError(null);
    setDevices((current) =>
      current.map((device) =>
        device.id === deviceId ? { ...device, currentScreenId: screenId } : device,
      ),
    );
  };

  const isStale = (lastSeenAt: string) =>
    Date.now() - new Date(lastSeenAt).getTime() > 30 * 60 * 1000;

  return (
    <main>
      <header>
        <p className="eyebrow">Local e-paper control</p>
        <h1>Inkboard</h1>
        <p className="lede">Design, schedule, and deliver calm information screens.</p>
      </header>

      <section className="status-card" aria-live="polite">
        <div>
          <span className={`status-dot ${error ? "error" : status ? "ready" : ""}`} />
          <strong>
            {error ? "Controller unavailable" : status ? "Controller ready" : "Connecting"}
          </strong>
        </div>
        {status ? (
          <dl>
            <div>
              <dt>Display</dt>
              <dd>
                {status.displayProfile.width}×{status.displayProfile.height}
              </dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>{status.displayProfile.bitsPerPixel}-bit monochrome</dd>
            </div>
            <div>
              <dt>BMP size</dt>
              <dd>{status.displayProfile.expectedBmpBytes.toLocaleString()} bytes</dd>
            </div>
          </dl>
        ) : null}
        {error ? <p className="error-message">{error}</p> : null}
      </section>

      {status?.app.mode === "home_assistant" ? <DeviceSetup app={status.app} /> : null}

      <section className="status-card device-card">
        <div>
          <strong>
            {devices.length === 0
              ? "No device check-ins yet"
              : `${devices.length} display device${devices.length === 1 ? "" : "s"}`}
          </strong>
        </div>
        {devices.length > 0 ? (
          <div className="device-list">
            {devices.map((device) => (
              <article className="device" key={device.id}>
                <h2>
                  {device.id}
                  {isStale(device.lastSeenAt) ? <span className="stale">Stale</span> : null}
                </h2>
                <dl>
                  <div>
                    <dt>Last seen</dt>
                    <dd>{new Date(device.lastSeenAt).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Firmware</dt>
                    <dd>{device.firmwareVersion}</dd>
                  </div>
                  <div>
                    <dt>Battery</dt>
                    <dd>
                      {device.lastBatteryVoltage === null
                        ? "Unknown"
                        : `${device.lastBatteryVoltage.toFixed(2)} V`}
                    </dd>
                  </div>
                  <div>
                    <dt>Wi-Fi</dt>
                    <dd>
                      {device.lastWifiRssi === null
                        ? "Unknown"
                        : `${Math.round(device.lastWifiRssi)} dBm`}
                    </dd>
                  </div>
                  <div>
                    <dt>Wake reason</dt>
                    <dd>{device.lastWakeReason.replaceAll("_", " ")}</dd>
                  </div>
                  <div>
                    <dt>Last action</dt>
                    <dd>
                      {device.lastButtonEvent.replaceAll("_", " ")} /{" "}
                      {device.lastDisplayResult.replaceAll("_", " ")}
                    </dd>
                  </div>
                </dl>
                <label className="screen-select">
                  <span>Current screen</span>
                  <select
                    value={device.currentScreenId}
                    onChange={(event) => void selectScreen(device.id, event.target.value)}
                  >
                    {screens.map((screen) => (
                      <option key={screen.id} value={screen.id}>
                        {screen.name}
                      </option>
                    ))}
                  </select>
                  <small>Applied on the device&apos;s next refresh or button press.</small>
                </label>
                <label className="inline-field">
                  <input
                    type="checkbox"
                    checked={device.invertColors}
                    onChange={(event) => void setInvertColors(device.id, event.target.checked)}
                  />
                  Invert colors
                </label>
                <small className="hint">
                  Turn on if this display shows a black background where the previews are white.
                  Applied on its next refresh.
                </small>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-message">
            The display will appear here after its first authenticated check-in.
          </p>
        )}
      </section>

      <section className="status-card device-card">
        <div className="section-header">
          <strong>Screens</strong>
          {editor.mode === "closed" ? (
            <button type="button" className="primary" onClick={() => setEditor({ mode: "new" })}>
              New screen
            </button>
          ) : null}
        </div>
        <p className="empty-message">
          KEY1 shows the previous screen and KEY3 shows the next one; KEY2 refreshes.
        </p>
        {editor.mode !== "closed" ? (
          <ScreenEditor
            key={editor.mode === "edit" ? editor.screen.id : "new"}
            screen={editor.mode === "edit" ? editor.screen : null}
            widgetTypes={widgetTypes}
            onCancel={() => setEditor({ mode: "closed" })}
            onSaved={() => {
              setEditor({ mode: "closed" });
              void reloadScreens();
            }}
          />
        ) : null}
        <div className="screen-grid">
          {screens.map((screen) => (
            <figure key={screen.id}>
              <img
                src={`api/v1/admin/screens/${encodeURIComponent(screen.id)}/preview.bmp?v=${previewVersion}`}
                alt={`${screen.name} preview`}
                width={400}
                height={240}
              />
              <figcaption>
                <strong>{screen.name}</strong>
                <span>{screen.description}</span>
                {screen.kind === "custom" ? (
                  <span className="screen-actions">
                    <button type="button" onClick={() => void editScreen(screen.id)}>
                      Edit
                    </button>
                    <button type="button" onClick={() => void deleteScreen(screen.id, screen.name)}>
                      Delete
                    </button>
                  </span>
                ) : (
                  <span className="badge">Built-in</span>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
        <label className="inline-field test-pattern-toggle">
          <input
            type="checkbox"
            checked={!testPatternHidden}
            onChange={(event) => void setTestPatternVisible(event.target.checked)}
          />
          Show the test pattern screen
        </label>
      </section>

      <section className="status-card device-card">
        <div>
          <strong>Automatic rotation</strong>
        </div>
        <p className="empty-message">
          Each display moves to the next screen in this list after the interval. Pressing KEY1 or
          KEY3 keeps the chosen screen for a full interval. The display checks back when the next
          change is due, or every 15 minutes at most.
        </p>
        {rotation !== null ? (
          <RotationEditor
            key={`${rotation.intervalMinutes}:${rotation.screenIds.join(",")}:${screens.length}`}
            screens={screens}
            rotation={rotation}
            onSaved={setRotation}
          />
        ) : null}
      </section>

      <section className="status-card device-card">
        <div>
          <strong>Schedules</strong>
        </div>
        <p className="empty-message">
          Show a screen at set times, such as an agenda on weekday mornings. Schedules take priority
          over rotation; a KEY1 or KEY3 press still holds its screen for one interval.
        </p>
        {schedule !== null ? (
          <ScheduleEditor
            key={schedule.schedules.map((rule) => rule.id).join(",") + screens.length}
            screens={screens}
            schedules={schedule.schedules}
            scheduleState={schedule.scheduleState}
            timeZone={schedule.timeZone}
            onSaved={() => void reloadScreens()}
          />
        ) : null}
      </section>

      <section className="status-card device-card">
        <div>
          <strong>Quiet hours</strong>
        </div>
        <p className="empty-message">
          The display keeps its current image and, when maintenance mode is off, sleeps until quiet
          hours end. Pressing a key still updates it.
        </p>
        {schedule !== null ? (
          <QuietHoursEditor
            key={JSON.stringify(schedule.quietHours)}
            quietHours={schedule.quietHours}
            active={schedule.scheduleState.quietHoursActive}
            onSaved={() => void reloadScreens()}
          />
        ) : null}
      </section>

      <section className="status-card device-card" aria-live="polite">
        <div>
          <span
            className={`status-dot ${
              status?.calendar.state === "ready"
                ? "ready"
                : status?.calendar.state === "degraded"
                  ? "error"
                  : ""
            }`}
          />
          <strong>
            {status?.calendar.state === "ready"
              ? "Home Assistant calendars ready"
              : status?.calendar.state === "degraded"
                ? "Home Assistant calendars degraded"
                : status?.calendar.homeAssistantConfigured
                  ? "Choose Home Assistant calendars"
                  : "Home Assistant not configured"}
          </strong>
        </div>
        {status !== null ? (
          <CalendarSettings
            key={importCount}
            status={status.calendar}
            onSaved={(calendar) => {
              setStatus({ ...status, calendar });
              void reloadScreens();
            }}
          />
        ) : null}
      </section>

      <section className="status-card device-card" aria-live="polite">
        <MicrosoftTodoSettings key={importCount} onChanged={reloadScreensQuietly} />
      </section>

      <section className="status-card device-card">
        <div>
          <strong>Backup</strong>
        </div>
        <BackupSettings
          onImported={() => {
            reloadScreensQuietly();
            void fetch("api/v1/admin/status")
              .then(async (response) => {
                if (response.ok) {
                  setStatus((await response.json()) as AdminStatusResponse);
                }
              })
              .catch(() => undefined)
              .finally(() => setImportCount((count) => count + 1));
          }}
        />
      </section>
    </main>
  );
}
