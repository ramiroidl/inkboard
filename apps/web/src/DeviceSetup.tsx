import { useState } from "react";

import type { AppRuntimeStatus } from "@inkboard/contracts";

/**
 * Inside the Home Assistant App, shows what the display firmware needs: the controller URL
 * on the device port and the device token.
 */
export function DeviceSetup({ app }: { app: AppRuntimeStatus }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const host = window.location.hostname;
  const controllerUrl = app.devicePort === null ? null : `http://${host}:${app.devicePort}`;

  const copy = async () => {
    if (app.deviceApiToken === null) {
      return;
    }
    await navigator.clipboard.writeText(app.deviceApiToken);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="status-card device-card">
      <div>
        <strong>Display setup</strong>
      </div>
      <p className="empty-message">
        Running as a Home Assistant App. Put these values in the display firmware&apos;s{" "}
        <code>secrets.yaml</code>. The admin page is only reachable through Home Assistant; the
        display uses the separate device port.
      </p>
      <dl className="setup-list">
        <div>
          <dt>inkboard_controller_url</dt>
          <dd>
            <code>{controllerUrl ?? "Device port is disabled"}</code>
          </dd>
        </div>
        <div>
          <dt>inkboard_device_api_token</dt>
          <dd className="token-row">
            <code>
              {app.deviceApiToken === null
                ? "Not available"
                : revealed
                  ? app.deviceApiToken
                  : "•".repeat(24)}
            </code>
            {app.deviceApiToken !== null ? (
              <>
                <button type="button" onClick={() => setRevealed(!revealed)}>
                  {revealed ? "Hide" : "Show"}
                </button>
                <button type="button" onClick={() => void copy()}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </>
            ) : null}
          </dd>
        </div>
      </dl>
      <p className="hint">
        Use your Home Assistant host&apos;s LAN address if the URL above shows a name the display
        cannot resolve. If the port was changed in the App&apos;s Network settings, use that port.
      </p>
    </section>
  );
}
