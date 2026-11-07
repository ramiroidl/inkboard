import type { TodoTask } from "@inkboard/contracts";

import { escapeXml, estimateTextWidth, fitToWidth, localDateKey } from "./calendar-renderer.js";

const WIDTH = 800;
const HEIGHT = 480;
const MAX_VISIBLE_TASKS = 7;
const ROWS_TOP = 74;
const ROW_HEIGHT = 48;
const FONT = "DejaVu Sans, sans-serif";

function addDays(key: string, days: number): string {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Due label relative to today in the configured time zone. */
export function formatDueDate(
  dueDate: string | null,
  timeZone: string,
  now: Date,
): { label: string; urgent: boolean } {
  if (dueDate === null) {
    return { label: "", urgent: false };
  }
  const today = localDateKey(now, timeZone);
  if (dueDate < today) {
    return { label: "OVERDUE", urgent: true };
  }
  if (dueDate === today) {
    return { label: "TODAY", urgent: true };
  }
  if (dueDate === addDays(today, 1)) {
    return { label: "TOMORROW", urgent: false };
  }
  return {
    label: new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
    })
      .format(new Date(`${dueDate}T00:00:00Z`))
      .toUpperCase(),
    urgent: false,
  };
}

/** Title with an importance marker and the right-hand details for one task row. */
export function describeTask(
  task: TodoTask,
  options: { timeZone: string; now: Date; showList: boolean; showDue?: boolean },
): { title: string; detail: string; urgent: boolean } {
  const due = formatDueDate(task.dueDate, options.timeZone, options.now);
  const detail = [
    options.showDue === false ? "" : due.label,
    options.showList ? task.listName.toUpperCase() : "",
    task.recurring ? "↻" : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
  return {
    title: task.importance === "high" ? `! ${task.title}` : task.title,
    detail,
    urgent: options.showDue !== false && due.urgent,
  };
}

function text(
  x: number,
  y: number,
  content: string,
  size: number,
  options: { bold?: boolean; anchor?: "start" | "end" } = {},
): string {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${
    options.bold === true ? ' font-weight="700"' : ""
  }${options.anchor === "end" ? ' text-anchor="end"' : ""}>${escapeXml(content)}</text>`;
}

export function todoSvg(
  tasks: TodoTask[],
  options: { listNames: string[]; timeZone: string; now: Date },
): string {
  const showList = new Set(tasks.map((task) => task.listId)).size > 1;
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(options.now);

  const rows =
    tasks.length === 0
      ? `
        <rect x="34" y="96" width="732" height="336" fill="none" stroke="black" stroke-width="2"/>
        ${text(400, 252, "ALL DONE", 34, { bold: true }).replace("<text ", '<text text-anchor="middle" ')}
        ${text(400, 298, "No open tasks in the selected lists.", 21).replace("<text ", '<text text-anchor="middle" ')}
      `
      : tasks
          .slice(0, MAX_VISIBLE_TASKS)
          .map((task, index) => {
            const y = ROWS_TOP + index * ROW_HEIGHT;
            const { title, detail, urgent } = describeTask(task, { ...options, showList });
            const detailWidth = detail === "" ? 0 : estimateTextWidth(detail, 15, urgent) + 16;
            return `
              ${index === 0 ? "" : `<line x1="34" y1="${y}" x2="766" y2="${y}" stroke="black" stroke-width="1"/>`}
              <rect x="36" y="${y + 14}" width="20" height="20" fill="none" stroke="black" stroke-width="2"/>
              ${text(70, y + 32, fitToWidth(title, 766 - 70 - detailWidth, 22, true), 22, { bold: true })}
              ${detail === "" ? "" : text(766, y + 31, detail, 15, { bold: urgent, anchor: "end" })}
            `;
          })
          .join("");

  const hidden = Math.max(0, tasks.length - MAX_VISIBLE_TASKS);
  return `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${WIDTH}" height="${HEIGHT}" fill="white"/>
      <rect x="1" y="1" width="798" height="478" fill="none" stroke="black" stroke-width="2"/>
      ${text(34, 54, "To Do", 38, { bold: true })}
      ${text(766, 54, today, 24, { anchor: "end" })}
      <line x1="34" y1="70" x2="766" y2="70" stroke="black" stroke-width="4"/>
      ${rows}
      <line x1="34" y1="452" x2="766" y2="452" stroke="black" stroke-width="2"/>
      ${text(34, 472, fitToWidth(options.listNames.join(" + ").toUpperCase(), 500, 14), 14)}
      ${text(766, 472, hidden === 0 ? `${tasks.length} OPEN TASK${tasks.length === 1 ? "" : "S"}` : `+${hidden} MORE`, 14, { anchor: "end" })}
    </svg>
  `;
}
