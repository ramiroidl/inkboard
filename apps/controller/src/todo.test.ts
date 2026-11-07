import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MicrosoftTodoStatus, TodoTask } from "@inkboard/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { describeTask, formatDueDate, todoSvg } from "./artifacts/todo-renderer.js";
import { loadConfig } from "./config.js";
import { MicrosoftGraphTodoClient, sortTasks } from "./integrations/microsoft-graph-todo.js";

const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const GRAPH = "https://graph.microsoft.com/v1.0";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function idToken(username: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ preferred_username: username })}.`;
}

/** A fake Microsoft identity platform and Graph To Do API. */
function microsoft() {
  const state = {
    pendingPolls: 1,
    consumersOnly: false,
    tokenVersion: 0,
    revoked: false,
    graphDown: false,
    rejectNextGraphCall: false,
    refreshCalls: 0,
    tasks: {
      "list-tasks": [
        {
          id: "t1",
          title: "Pay rent",
          status: "notStarted",
          importance: "high",
          dueDateTime: { dateTime: "2026-11-06T00:00:00.0000000", timeZone: "UTC" },
          recurrence: { pattern: { type: "monthly" } },
          createdDateTime: "2026-10-01T00:00:00Z",
        },
        { id: "t2", title: "Done already", status: "completed" },
        {
          id: "t3",
          title: "Buy milk",
          status: "notStarted",
          importance: "normal",
          createdDateTime: "2026-10-02T00:00:00Z",
        },
      ],
      "list-groceries": [
        {
          id: "g1",
          title: "Eggs",
          status: "notStarted",
          importance: "normal",
          dueDateTime: { dateTime: "2026-11-05T00:00:00.0000000", timeZone: "UTC" },
        },
      ],
    } as Record<string, Record<string, unknown>[]>,
  };
  const tokenResponse = () => {
    state.tokenVersion += 1;
    return Response.json({
      token_type: "Bearer",
      access_token: `access-secret-${state.tokenVersion}`,
      refresh_token: `refresh-secret-${state.tokenVersion}`,
      expires_in: 3600,
      id_token: idToken("user@example.com"),
    });
  };
  const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.hostname === "login.microsoftonline.com") {
      const form = new URLSearchParams(init?.body as string);
      expect(form.get("client_id")).toBe(CLIENT_ID);
      if (url.pathname.endsWith("/devicecode")) {
        if (state.consumersOnly && !url.pathname.startsWith("/consumers/")) {
          return Response.json(
            {
              error: "invalid_request",
              error_description:
                "AADSTS9002346: Application is configured for use by Microsoft Account users only. Please use the /consumers endpoint to serve this request.",
            },
            { status: 400 },
          );
        }
        expect(form.get("scope")).toContain("Tasks.Read");
        return Response.json({
          device_code: "device-code-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 5,
        });
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshCalls += 1;
        if (state.revoked) {
          return Response.json(
            { error: "invalid_grant", error_description: "AADSTS70000: revoked\r\nTrace" },
            { status: 400 },
          );
        }
        expect(form.get("refresh_token")).toBe(`refresh-secret-${state.tokenVersion}`);
        return tokenResponse();
      }
      if (state.pendingPolls > 0) {
        state.pendingPolls -= 1;
        return Response.json({ error: "authorization_pending" }, { status: 400 });
      }
      return tokenResponse();
    }
    if (url.hostname === "graph.microsoft.com") {
      const authorization = new Headers(init?.headers).get("authorization");
      if (state.rejectNextGraphCall) {
        state.rejectNextGraphCall = false;
        return new Response("", { status: 401 });
      }
      if (authorization !== ["Bearer", `access-secret-${state.tokenVersion}`].join(" ")) {
        return new Response("", { status: 401 });
      }
      if (state.graphDown) {
        return new Response("unavailable", { status: 503 });
      }
      if (url.pathname === "/v1.0/me/todo/lists") {
        return Response.json({
          value: [
            { id: "list-tasks", displayName: "Tasks", wellknownListName: "defaultList" },
            { id: "list-groceries", displayName: "Groceries", wellknownListName: "none" },
          ],
        });
      }
      const match = /^\/v1\.0\/me\/todo\/lists\/([^/]+)\/tasks$/.exec(url.pathname);
      if (match !== null) {
        return Response.json({ value: state.tasks[decodeURIComponent(match[1]!)] ?? [] });
      }
    }
    throw new Error(`Unexpected request ${url.href}`);
  });
  return { fetchImplementation, state };
}

async function newDataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "inkboard-todo-"));
  directories.push(directory);
  return directory;
}

async function createApp(
  dataDirectory: string,
  fetchImplementation: typeof fetch,
  clock: { now: Date },
  environment: Record<string, string> = {},
) {
  const config = loadConfig({
    NODE_ENV: "test",
    INKBOARD_DATA_DIR: dataDirectory,
    INKBOARD_DEVICE_API_TOKEN: "test-device-token-with-at-least-32-characters",
    INKBOARD_LOG_LEVEL: "silent",
    INKBOARD_TIME_ZONE: "America/Chicago",
    ...environment,
  });
  const app = await buildApp(config, { fetchImplementation, now: () => clock.now });
  return { app, authorization: ["Bearer", config.deviceApiToken].join(" ") };
}

type App = Awaited<ReturnType<typeof createApp>>["app"];

async function status(app: App): Promise<MicrosoftTodoStatus> {
  const response = await app.inject({ method: "GET", url: "/api/v1/admin/microsoft-todo" });
  expect(response.statusCode).toBe(200);
  return response.json<MicrosoftTodoStatus>();
}

async function screenIds(app: App): Promise<string[]> {
  const response = await app.inject({ method: "GET", url: "/api/v1/admin/screens" });
  return response.json<{ screens: { id: string }[] }>().screens.map((screen) => screen.id);
}

async function readDataFiles(directory: string): Promise<string> {
  const names = (await readdir(directory)).filter((name) => name.includes("sqlite"));
  return (await Promise.all(names.map((name) => readFile(join(directory, name))))).join("\n");
}

async function signIn(app: App, clock: { now: Date }) {
  const started = await app.inject({ method: "POST", url: "/api/v1/admin/microsoft-todo/sign-in" });
  expect(started.statusCode).toBe(200);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    clock.now = new Date(clock.now.getTime() + 5_000);
    const current = await status(app);
    if (current.state !== "pending") {
      return current;
    }
  }
  throw new Error("Sign-in did not complete");
}

async function checkIn(app: App, authorization: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/device/check-in",
    headers: { authorization },
    payload: {
      deviceId: "inkboard-og",
      firmwareVersion: "0.4.0",
      model: "seeed-ee04-800x480-mono",
      width: 800,
      height: 480,
      wakeReason: "cold_boot",
      buttonEvent: "none",
      displayResult: "displayed",
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ screenId: string }>().screenId;
}

describe("Microsoft To Do", () => {
  it("signs in with a device code, stores tokens encrypted, and adds a To Do screen", async () => {
    const dataDirectory = await newDataDirectory();
    const ms = microsoft();
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    const created = await createApp(dataDirectory, ms.fetchImplementation, clock);
    let app = created.app;
    const authorization = created.authorization;

    expect(await status(app)).toMatchObject({ state: "not_configured", clientId: null });
    expect(await screenIds(app)).toEqual(["orientation"]);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/admin/microsoft-todo/sign-in" }))
        .statusCode,
    ).toBe(400);

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/microsoft-todo/settings",
      payload: { clientId: "not-a-guid", tenant: "common" },
    });
    expect(invalid.statusCode).toBe(400);
    const configured = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/microsoft-todo/settings",
      payload: { clientId: CLIENT_ID.toUpperCase(), tenant: "consumers" },
    });
    expect(configured.json()).toMatchObject({
      state: "signed_out",
      clientId: CLIENT_ID,
      tenant: "consumers",
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/v1/admin/microsoft-todo/sign-in",
    });
    expect(started.json()).toMatchObject({
      state: "pending",
      signIn: { userCode: "ABCD-EFGH", verificationUri: "https://microsoft.com/devicelogin" },
    });
    expect(started.body).not.toContain("device-code-secret");
    // Polling waits for the interval Microsoft asked for.
    expect((await status(app)).state).toBe("pending");
    expect(ms.fetchImplementation).toHaveBeenCalledTimes(1);
    clock.now = new Date(clock.now.getTime() + 5_000);
    expect((await status(app)).state).toBe("pending");
    clock.now = new Date(clock.now.getTime() + 5_000);
    const signedIn = await status(app);
    expect(signedIn).toMatchObject({
      state: "signed_in",
      account: "user@example.com",
      signIn: null,
      selectedListIds: ["list-tasks"],
      lists: [{ id: "list-tasks", name: "Tasks", taskCount: 2, lastError: null }],
      taskCount: 2,
      lastError: null,
    });
    expect(JSON.stringify(signedIn)).not.toMatch(/secret/);
    expect(await screenIds(app)).toEqual(["todo", "orientation"]);

    const lists = await app.inject({ method: "GET", url: "/api/v1/admin/microsoft-todo/lists" });
    expect(lists.json()).toEqual({
      available: [
        { id: "list-groceries", name: "Groceries" },
        { id: "list-tasks", name: "Tasks" },
      ],
      selected: ["list-tasks"],
      error: null,
    });
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/admin/microsoft-todo/lists",
      payload: { listIds: ["list-tasks", "list-groceries"] },
    });
    expect(selected.json()).toMatchObject({
      taskCount: 3,
      selectedListIds: ["list-tasks", "list-groceries"],
    });

    const files = await readDataFiles(dataDirectory);
    expect(files).not.toContain("access-secret");
    expect(files).not.toContain("refresh-secret");
    expect(files).toContain("Pay rent");

    // The To Do screen rotates with other screens and serves a rendered image.
    expect(await checkIn(app, authorization)).toBe("todo");
    await app.inject({
      method: "PUT",
      url: "/api/v1/admin/rotation",
      payload: { screenIds: ["todo", "orientation"], intervalMinutes: 5 },
    });
    const image = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp?device=inkboard-og",
      headers: { authorization },
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["x-screen-id"]).toBe("todo");
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    const next = await app.inject({
      method: "GET",
      url: "/api/v1/device/image.bmp?device=inkboard-og",
      headers: { authorization },
    });
    expect(next.headers["x-screen-id"]).toBe("orientation");

    // The widget reads the same tasks.
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: { name: "Tasks", widgets: [{ type: "todo", maxItems: 2 }] },
    });
    expect(preview.statusCode).toBe(200);

    // Sign-in survives a restart.
    await app.close();
    ({ app } = await createApp(dataDirectory, ms.fetchImplementation, clock));
    expect(await status(app)).toMatchObject({
      state: "signed_in",
      account: "user@example.com",
      taskCount: 3,
    });
    expect(await screenIds(app)).toEqual(["todo", "orientation"]);

    const signedOut = await app.inject({
      method: "POST",
      url: "/api/v1/admin/microsoft-todo/sign-out",
    });
    expect(signedOut.json()).toMatchObject({ state: "signed_out", account: null, taskCount: 0 });
    expect(await screenIds(app)).toEqual(["orientation"]);
    await app.close();
    expect(await readDataFiles(dataDirectory)).not.toContain("Pay rent");
  });

  it("refreshes tokens, keeps tasks through outages, and asks to sign in when revoked", async () => {
    const dataDirectory = await newDataDirectory();
    const ms = microsoft();
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    const { app } = await createApp(dataDirectory, ms.fetchImplementation, clock, {
      INKBOARD_MICROSOFT_CLIENT_ID: CLIENT_ID,
      INKBOARD_TODO_REFRESH_SECONDS: "300",
    });
    expect((await status(app)).state).toBe("signed_out");
    expect((await signIn(app, clock)).taskCount).toBe(2);

    // Graph rejects a token once: the controller refreshes and retries.
    ms.state.rejectNextGraphCall = true;
    ms.state.tasks["list-tasks"]!.push({ id: "t4", title: "Call mom", status: "notStarted" });
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    expect(await status(app)).toMatchObject({ taskCount: 2 });
    await app.inject({ method: "GET", url: "/api/v1/admin/screens/todo/preview.bmp" });
    // Refreshes run when the screen or tasks are requested.
    const tasks = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: { name: "Tasks", widgets: [{ type: "todo", maxItems: 5 }] },
    });
    expect(tasks.statusCode).toBe(200);
    expect(ms.state.refreshCalls).toBe(1);
    expect(await status(app)).toMatchObject({ state: "signed_in", taskCount: 3, lastError: null });

    // An expired access token is refreshed before use.
    clock.now = new Date(clock.now.getTime() + 61 * 60_000);
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: { name: "Tasks", widgets: [{ type: "todo", maxItems: 5 }] },
    });
    expect(ms.state.refreshCalls).toBe(2);

    // Graph outage keeps the last tasks.
    ms.state.graphDown = true;
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: { name: "Tasks", widgets: [{ type: "todo", maxItems: 5 }] },
    });
    const outage = await status(app);
    expect(outage).toMatchObject({ state: "signed_in", taskCount: 3 });
    expect(outage.lastError).toContain("503");

    // A revoked refresh token needs a new sign-in; the cached screen stays available.
    ms.state.graphDown = false;
    ms.state.revoked = true;
    clock.now = new Date(clock.now.getTime() + 61 * 60_000);
    await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: { name: "Tasks", widgets: [{ type: "todo", maxItems: 5 }] },
    });
    const revoked = await status(app);
    expect(revoked).toMatchObject({ state: "reauth_required", taskCount: 3 });
    expect(revoked.lastError).toContain("Sign in again");
    expect(revoked.lastError).not.toContain("Trace");
    expect(await screenIds(app)).toEqual(["todo", "orientation"]);

    ms.state.revoked = false;
    ms.state.pendingPolls = 0;
    expect(await signIn(app, clock)).toMatchObject({ state: "signed_in", lastError: null });
    await app.close();
  });
});

describe("Microsoft To Do helpers", () => {
  it("lets a widget show lists other than the admin selection", async () => {
    const dataDirectory = await newDataDirectory();
    const ms = microsoft();
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    const { app } = await createApp(dataDirectory, ms.fetchImplementation, clock, {
      INKBOARD_MICROSOFT_CLIENT_ID: CLIENT_ID,
    });
    expect(await signIn(app, clock)).toMatchObject({ selectedListIds: ["list-tasks"] });
    const groceryRequests = () =>
      ms.fetchImplementation.mock.calls.filter(([input]) =>
        (input instanceof Request ? input.url : String(input as string)).includes(
          "/lists/list-groceries/tasks",
        ),
      ).length;
    expect(groceryRequests()).toBe(0);

    const preview = async () =>
      app.inject({
        method: "POST",
        url: "/api/v1/admin/screens/preview.bmp",
        payload: {
          name: "Groceries",
          widgets: [
            {
              type: "todo",
              maxItems: 5,
              lists: ["list-groceries"],
              hideDueDates: true,
              showListNames: "never",
            },
          ],
        },
      });
    expect((await preview()).statusCode).toBe(200);
    expect(groceryRequests()).toBe(1);
    // Cached for the refresh interval, and not added to the admin selection.
    await preview();
    expect(groceryRequests()).toBe(1);
    expect((await status(app)).selectedListIds).toEqual(["list-tasks"]);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/admin/screens/preview.bmp",
      payload: {
        name: "Bad",
        widgets: [{ type: "todo", maxItems: 5, showListNames: "sometimes" }],
      },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
  it("switches to the consumers endpoint for apps limited to personal accounts", async () => {
    const dataDirectory = await newDataDirectory();
    const ms = microsoft();
    ms.state.consumersOnly = true;
    ms.state.pendingPolls = 0;
    const clock = { now: new Date("2026-11-06T12:00:00Z") };
    const { app } = await createApp(dataDirectory, ms.fetchImplementation, clock, {
      INKBOARD_MICROSOFT_CLIENT_ID: CLIENT_ID,
    });
    expect((await status(app)).tenant).toBe("common");
    expect(await signIn(app, clock)).toMatchObject({
      state: "signed_in",
      tenant: "consumers",
      lastError: null,
    });
    // Token requests use the same endpoint.
    expect(
      ms.fetchImplementation.mock.calls.filter(([input]) =>
        (input instanceof Request ? input.url : String(input as string)).includes(
          "/consumers/oauth2/v2.0/token",
        ),
      ).length,
    ).toBe(1);
    await app.close();
  });

  const task = (overrides: Partial<TodoTask>): TodoTask => ({
    id: "id",
    title: "Task",
    listId: "list",
    listName: "Tasks",
    dueDate: null,
    importance: "normal",
    recurring: false,
    createdAt: null,
    ...overrides,
  });

  it("orders by due date, then importance, then creation time", () => {
    const ordered = sortTasks([
      task({ id: "a", title: "No date" }),
      task({ id: "b", title: "Later", dueDate: "2026-11-09" }),
      task({ id: "c", title: "Important", dueDate: "2026-11-09", importance: "high" }),
      task({ id: "d", title: "Soon", dueDate: "2026-11-01" }),
      task({ id: "e", title: "Older no date", createdAt: "2026-01-01" }),
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["d", "c", "b", "a", "e"]);
  });

  it("labels due dates relative to the local day", () => {
    // 2026-11-07 00:30 UTC is still Nov 6 in Chicago.
    const now = new Date("2026-11-07T00:30:00Z");
    const zone = "America/Chicago";
    expect(formatDueDate("2026-11-05", zone, now)).toEqual({ label: "OVERDUE", urgent: true });
    expect(formatDueDate("2026-11-06", zone, now)).toEqual({ label: "TODAY", urgent: true });
    expect(formatDueDate("2026-11-07", zone, now).label).toBe("TOMORROW");
    expect(formatDueDate("2026-11-13", zone, now).label).toBe("FRI, NOV 13");
    expect(formatDueDate(null, zone, now).label).toBe("");
    expect(
      describeTask(task({ importance: "high", recurring: true, dueDate: "2026-11-06" }), {
        timeZone: zone,
        now,
        showList: true,
      }),
    ).toEqual({ title: "! Task", detail: "TODAY · TASKS · ↻", urgent: true });
  });

  it("renders an empty state and a count of hidden tasks", () => {
    const options = {
      listNames: ["Tasks"],
      timeZone: "UTC",
      now: new Date("2026-11-06T12:00:00Z"),
    };
    expect(todoSvg([], options)).toContain("ALL DONE");
    const many = Array.from({ length: 9 }, (_, index) =>
      task({ id: `t${index}`, title: `Task ${index}` }),
    );
    expect(todoSvg(many, options)).toContain("+2 MORE");
  });

  it("follows Graph paging and skips completed tasks", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("skiptoken")) {
        return Response.json({ value: [{ id: "2", title: "Second", status: "inProgress" }] });
      }
      return Response.json({
        value: [
          { id: "1", title: " First ", status: "notStarted" },
          { id: "x", title: "Done", status: "completed" },
        ],
        "@odata.nextLink": `${GRAPH}/me/todo/lists/l/tasks?$skiptoken=abc`,
      });
    });
    const tasks = await new MicrosoftGraphTodoClient(fetchImplementation).listTasks("token", {
      id: "l",
      name: "Tasks",
    });
    expect(tasks.map((t) => t.title)).toEqual(["First", "Second"]);

    const hostile = vi.fn<typeof fetch>(async () =>
      Response.json({ value: [], "@odata.nextLink": "https://attacker.example/steal" }),
    );
    await expect(
      new MicrosoftGraphTodoClient(hostile).listTasks("token", { id: "l", name: "Tasks" }),
    ).rejects.toThrow("unexpected next page");
  });
});
