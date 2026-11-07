import { useState } from "react";

import type { InkboardBackupImportResult } from "@inkboard/contracts";

/** Downloads screens and settings as a file, and imports such a file. */
export function BackupSettings({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const importFile = async (file: File) => {
    setBusy(true);
    setMessage(null);
    setWarnings([]);
    try {
      let backup: unknown;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        throw new Error("This file is not an Inkboard backup");
      }
      const response = await fetch("api/v1/admin/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(backup),
      });
      const body = (await response.json().catch(() => null)) as
        (InkboardBackupImportResult & { error?: string; message?: string }) | null;
      if (!response.ok || body === null) {
        throw new Error(
          response.status === 400 && body?.message?.startsWith("body")
            ? "This file is not an Inkboard backup"
            : (body?.error ?? body?.message ?? `Import failed (${response.status})`),
        );
      }
      setMessage(
        `Imported ${body.screensCreated} new screen${body.screensCreated === 1 ? "" : "s"}` +
          (body.screensReused > 0 ? ` and kept ${body.screensReused} existing` : "") +
          ", with the rotation, schedules, quiet hours, and calendar and To Do selections.",
      );
      setWarnings(body.warnings);
      onImported();
    } catch (reason: unknown) {
      setMessage(reason instanceof Error ? reason.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rotation-editor">
      <p className="hint">
        Export your custom screens, rotation, schedules, quiet hours, and calendar and To Do
        selections to a file, and import it on another Inkboard, such as when moving to the Home
        Assistant App. Sign-ins and tokens are not included; sign in to Microsoft To Do again before
        importing to keep the To Do screen in the rotation.
      </p>
      <div className="editor-buttons">
        <a className="button" href="api/v1/admin/backup" download>
          Export
        </a>
        <label className={`button primary${busy ? " disabled" : ""}`}>
          {busy ? "Importing…" : "Import…"}
          <input
            type="file"
            accept="application/json,.json"
            hidden
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) {
                void importFile(file);
              }
            }}
          />
        </label>
      </div>
      {message ? <p className="hint">{message}</p> : null}
      {warnings.length > 0 ? (
        <ul className="error-message">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
