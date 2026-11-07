import {
  defineWidget,
  describeTask,
  estimateTextWidth,
  fitToWidth,
  svgText,
  TodoListIdsSchema,
  Type,
  type TodoTask,
} from "../sdk.js";

const ROW_HEIGHT = 40;

/** Tasks that fit in the available height, keeping a row for the "+N MORE" line. */
function fit(
  data: { tasks: TodoTask[]; hidden: number },
  availableHeight: number | undefined,
): { shown: TodoTask[]; hidden: number } {
  const rows = Math.floor((availableHeight ?? Number.POSITIVE_INFINITY) / ROW_HEIGHT);
  if (data.tasks.length + (data.hidden > 0 ? 1 : 0) <= rows) {
    return { shown: data.tasks, hidden: data.hidden };
  }
  const shown = data.tasks.slice(0, Math.max(1, rows - 1));
  return { shown, hidden: data.hidden + data.tasks.length - shown.length };
}

export default defineWidget({
  type: "todo",
  name: "To Do list",
  description: "Open tasks from Microsoft To Do lists",
  configSchema: Type.Object({
    maxItems: Type.Integer({ minimum: 1, maximum: 10, title: "Tasks" }),
    lists: Type.Optional(
      TodoListIdsSchema({
        title: "Lists",
        description: "Leave all unticked to use the lists chosen in the Microsoft To Do card.",
      }),
    ),
    hideDueDates: Type.Optional(Type.Boolean({ title: "Hide due dates" })),
    showListNames: Type.Optional(
      Type.Union(
        [
          Type.Literal("auto", { title: "When showing several lists" }),
          Type.Literal("always", { title: "Always" }),
          Type.Literal("never", { title: "Never" }),
        ],
        { title: "Show list names" },
      ),
    ),
  }),
  defaultConfig: { maxItems: 5, lists: [], hideDueDates: false, showListNames: "auto" },
  load: async (config, { todo }) => {
    if (!todo.configured) {
      return null;
    }
    const tasks = await todo.getTasks(config.lists);
    const showListNames = config.showListNames ?? "auto";
    return {
      tasks: tasks.slice(0, config.maxItems),
      hidden: Math.max(0, tasks.length - config.maxItems),
      showList:
        showListNames === "always" ||
        (showListNames === "auto" && new Set(tasks.map((task) => task.listId)).size > 1),
    };
  },
  height: (_config, data, _width, { availableHeight }) => {
    if (data === null || data.tasks.length === 0) {
      return ROW_HEIGHT;
    }
    const { shown, hidden } = fit(data, availableHeight);
    return (shown.length + (hidden > 0 ? 1 : 0)) * ROW_HEIGHT;
  },
  render: (config, data, box, { timeZone, now, availableHeight }) => {
    if (data === null || data.tasks.length === 0) {
      const message = data === null ? "Microsoft To Do not connected" : "All done";
      return `<line x1="0" y1="0" x2="${box.width}" y2="0" stroke="black" stroke-width="1"/>${svgText(12, 28, message, 20)}`;
    }
    const { shown, hidden } = fit(data, availableHeight);
    const rows = shown.map((task, index) => {
      const y = index * ROW_HEIGHT;
      const row = describeTask(task, {
        timeZone,
        now,
        showList: data.showList,
        showDue: config.hideDueDates !== true,
      });
      const detailWidth = row.detail === "" ? 0 : estimateTextWidth(row.detail, 14, true) + 16;
      return `
        <line x1="0" y1="${y}" x2="${box.width}" y2="${y}" stroke="black" stroke-width="1"/>
        <rect x="12" y="${y + 11}" width="18" height="18" fill="none" stroke="black" stroke-width="2"/>
        ${svgText(44, y + 27, fitToWidth(row.title, box.width - 56 - detailWidth, 20, true), 20, { bold: true })}
        ${row.detail === "" ? "" : svgText(box.width - 8, y + 26, row.detail, 14, { bold: row.urgent, anchor: "end" })}
      `;
    });
    if (hidden > 0) {
      const y = shown.length * ROW_HEIGHT;
      rows.push(svgText(44, y + 26, `+${hidden} MORE`, 14, { bold: true }));
    }
    return rows.join("");
  },
});
