import type { TodoImportance, TodoListSummary, TodoTask } from "@inkboard/contracts";

type FetchImplementation = typeof fetch;

const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_PAGES = 10;

/** Graph rejected the access token; refreshing it may help. */
export class GraphUnauthorizedError extends Error {}

function normalizeImportance(value: unknown): TodoImportance {
  return value === "high" || value === "low" ? value : "normal";
}

/**
 * Microsoft To Do stores a due date as midnight with a time zone; the calendar date is the
 * part users chose, so only the `YYYY-MM-DD` prefix is kept.
 */
function normalizeDueDate(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const dateTime = (value as Record<string, unknown>).dateTime;
  return typeof dateTime === "string" && /^\d{4}-\d{2}-\d{2}/.test(dateTime)
    ? dateTime.slice(0, 10)
    : null;
}

export class MicrosoftGraphTodoClient {
  public constructor(private readonly fetchImplementation: FetchImplementation = fetch) {}

  public async listLists(accessToken: string): Promise<TodoListSummary[]> {
    const items = await this.getAll(`${GRAPH}/me/todo/lists`, accessToken);
    return items
      .flatMap((item): TodoListSummary[] =>
        typeof item.id === "string"
          ? [
              {
                id: item.id,
                name:
                  typeof item.displayName === "string" && item.displayName.trim() !== ""
                    ? item.displayName.trim()
                    : "Tasks",
              },
            ]
          : [],
      )
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /** The default list (named "Tasks" in To Do), used as the initial selection. */
  public async defaultListId(accessToken: string): Promise<string | null> {
    const items = await this.getAll(`${GRAPH}/me/todo/lists`, accessToken);
    const list = items.find((item) => item.wellknownListName === "defaultList");
    return typeof list?.id === "string" ? list.id : null;
  }

  /** Incomplete tasks of one list. */
  public async listTasks(accessToken: string, list: TodoListSummary): Promise<TodoTask[]> {
    // Filtering on the server keeps long histories of completed tasks from pushing open
    // tasks past the page limit.
    const filter = encodeURIComponent("status ne 'completed'");
    const items = await this.getAll(
      `${GRAPH}/me/todo/lists/${encodeURIComponent(list.id)}/tasks?$filter=${filter}&$top=100`,
      accessToken,
    );
    return items.flatMap((item): TodoTask[] => {
      if (typeof item.id !== "string" || item.status === "completed") {
        return [];
      }
      const title = typeof item.title === "string" ? item.title.trim() : "";
      return [
        {
          id: item.id,
          title: title === "" ? "Untitled task" : title,
          listId: list.id,
          listName: list.name,
          dueDate: normalizeDueDate(item.dueDateTime),
          importance: normalizeImportance(item.importance),
          recurring: typeof item.recurrence === "object" && item.recurrence !== null,
          createdAt: typeof item.createdDateTime === "string" ? item.createdDateTime : null,
        },
      ];
    });
  }

  private async getAll(url: string, accessToken: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let next: string | null = url;
    for (let page = 0; next !== null && page < MAX_PAGES; page += 1) {
      if (!next.startsWith(`${GRAPH}/`)) {
        throw new Error("Microsoft Graph returned an unexpected next page");
      }
      const response: Response = await this.fetchImplementation(next, {
        headers: { accept: "application/json", authorization: ["Bearer", accessToken].join(" ") },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) {
        throw new GraphUnauthorizedError("Microsoft Graph rejected the access token");
      }
      if (!response.ok) {
        throw new Error(`Microsoft Graph returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      if (!Array.isArray(body.value)) {
        throw new Error("Microsoft Graph returned an invalid response");
      }
      items.push(...(body.value as Record<string, unknown>[]));
      next = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : null;
    }
    return items;
  }
}

/**
 * Stable order for display: tasks with due dates first by date, then importance, then
 * creation time, then title.
 */
export function sortTasks(tasks: TodoTask[]): TodoTask[] {
  const importanceRank: Record<TodoImportance, number> = { high: 0, normal: 1, low: 2 };
  return [...tasks].sort(
    (left, right) =>
      (left.dueDate ?? "9999-99-99").localeCompare(right.dueDate ?? "9999-99-99") ||
      importanceRank[left.importance] - importanceRank[right.importance] ||
      (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id),
  );
}
