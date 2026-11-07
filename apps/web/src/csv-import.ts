import type { WidgetSettingSchema } from "@inkboard/contracts";
import Papa from "papaparse";

export const MAX_CSV_BYTES = 128 * 1024;

export function decodeCsv(buffer: ArrayBuffer): string {
  if (buffer.byteLength > MAX_CSV_BYTES) {
    throw new Error("CSV files must be 128 KiB or smaller");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("The file is not valid UTF-8. Export it as CSV UTF-8 and try again.");
  }
}

export function parseCsv(text: string, schema: WidgetSettingSchema): Record<string, string>[] {
  if (new TextEncoder().encode(text).byteLength > MAX_CSV_BYTES) {
    throw new Error("CSV files must be 128 KiB or smaller");
  }
  const properties = schema.items?.properties;
  if (
    schema.items?.type !== "object" ||
    properties === undefined ||
    Object.values(properties).some((field) => field.type !== "string")
  ) {
    throw new Error("This widget does not define a supported CSV record schema");
  }
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), {
    delimiter: ",",
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length > 0) {
    const error = parsed.errors[0]!;
    throw new Error(
      `CSV ${error.row === undefined ? "" : `row ${error.row + 1}: `}${error.message}`,
    );
  }
  const [rawHeaders, ...data] = parsed.data;
  if (rawHeaders === undefined || data.length === 0) {
    throw new Error("CSV must contain a header and at least one word");
  }
  const headers = rawHeaders.map((header) => header.trim());
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV column names must not be duplicated");
  }
  const unknown = headers.filter((header) => !Object.hasOwn(properties, header));
  if (unknown.length > 0) {
    throw new Error(`Unknown CSV columns: ${unknown.join(", ")}`);
  }
  const required = schema.items.required ?? [];
  const missing = required.filter((name) => !headers.includes(name));
  if (missing.length > 0) {
    throw new Error(`Missing required CSV columns: ${missing.join(", ")}`);
  }
  if (schema.maxItems !== undefined && data.length > schema.maxItems) {
    throw new Error(
      `CSV contains ${data.length} rows; this widget allows at most ${schema.maxItems}`,
    );
  }
  const rows = data.map((values, index) => {
    const rowNumber = index + 2;
    if (values.length !== headers.length) {
      throw new Error(
        `CSV row ${rowNumber}: expected ${headers.length} columns, found ${values.length}`,
      );
    }
    const row: Record<string, string> = {};
    for (const [column, name] of headers.entries()) {
      const value = values[column]!.trim();
      const field = properties[name]!;
      if (value === "" && !required.includes(name)) {
        continue;
      }
      if (value.length < (field.minLength ?? (required.includes(name) ? 1 : 0))) {
        throw new Error(`CSV row ${rowNumber}: ${name} must not be empty`);
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        throw new Error(`CSV row ${rowNumber}: ${name} exceeds ${field.maxLength} characters`);
      }
      if (field.pattern !== undefined && !new RegExp(field.pattern).test(value)) {
        throw new Error(`CSV row ${rowNumber}: ${name} has an invalid value`);
      }
      row[name] = value;
    }
    return row;
  });
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const key = JSON.stringify(row);
    if (seen.has(key)) {
      throw new Error(`CSV row ${index + 2}: duplicate record`);
    }
    seen.add(key);
  }
  return rows;
}
