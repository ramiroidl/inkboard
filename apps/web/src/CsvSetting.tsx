import { useRef, useState } from "react";
import type { WidgetSettingSchema } from "@inkboard/contracts";

import { decodeCsv, MAX_CSV_BYTES, parseCsv } from "./csv-import.js";

function isRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((field) => typeof field === "string")
  );
}

export function CsvSetting({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: WidgetSettingSchema;
  value: unknown;
  onChange: (value: Record<string, string>[]) => void;
}) {
  const [pending, setPending] = useState<Record<string, string>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const current = Array.isArray(value) ? value.filter(isRecord) : [];
  const shown = pending ?? current;
  const columns = schema.items?.required ?? Object.keys(schema.items?.properties ?? {});

  const choose = async (file: File) => {
    const id = ++request.current;
    setError(null);
    setPending(null);
    setReading(true);
    try {
      if (file.size > MAX_CSV_BYTES) {
        throw new Error("CSV files must be 128 KiB or smaller");
      }
      const rows = parseCsv(decodeCsv(await file.arrayBuffer()), schema);
      if (id === request.current) {
        setPending(rows);
      }
    } catch (reason: unknown) {
      if (id === request.current) {
        setError(reason instanceof Error ? reason.message : "Unable to read the CSV file");
      }
    } finally {
      if (id === request.current) {
        setReading(false);
      }
    }
  };
  return (
    <fieldset className="field csv-setting">
      <legend>{schema.title ?? name}</legend>
      <label className="field">
        <span>Choose CSV file</span>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) {
              void choose(file);
            }
          }}
        />
      </label>
      <small className="hint">
        UTF-8, comma-separated. Required columns: {columns.join(", ")}. Optional columns:{" "}
        {Object.keys(schema.items?.properties ?? {})
          .filter((column) => !columns.includes(column))
          .join(", ") || "none"}
        .
      </small>
      {reading ? <p className="hint">Reading CSV…</p> : null}
      {error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <>
          <p className="hint">
            {pending ? "Import preview" : "Current list"}: {shown.length} words. Showing the first{" "}
            {Math.min(5, shown.length)}.
          </p>
          <div className="csv-preview">
            <table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.slice(0, 5).map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column}>{row[column]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="hint">No uploaded words yet.</p>
      )}
      <div className="editor-buttons">
        {pending !== null ? (
          <>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onChange(pending);
                setPending(null);
                if (input.current) input.current.value = "";
              }}
            >
              Import {pending.length} words
            </button>
            <button
              type="button"
              onClick={() => {
                setPending(null);
                if (input.current) input.current.value = "";
              }}
            >
              Discard import
            </button>
          </>
        ) : null}
        {current.length > 0 ? (
          <button
            type="button"
            disabled={reading}
            onClick={() => {
              ++request.current;
              onChange([]);
              setPending(null);
              setError(null);
              if (input.current) input.current.value = "";
            }}
          >
            Clear uploaded words
          </button>
        ) : null}
      </div>
      {schema.description ? <small className="hint">{schema.description}</small> : null}
      <small className="hint">
        Import replaces this instance&apos;s list. Save the screen to keep the change.
      </small>
    </fieldset>
  );
}
