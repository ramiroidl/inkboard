import { useCallback, useEffect, useState } from "react";

import type { AdminTodoListsResponse, MicrosoftTodoStatus } from "@inkboard/contracts";

const BASE = "api/v1/admin/microsoft-todo";

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  return body?.message ?? body?.error ?? `Request failed (${response.status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as T;
}

const STATE_LABELS: Record<MicrosoftTodoStatus["state"], string> = {
  not_configured: "Microsoft To Do not configured",
  signed_out: "Microsoft To Do signed out",
  pending: "Waiting for Microsoft sign-in",
  signed_in: "Microsoft To Do ready",
  reauth_required: "Microsoft To Do needs sign-in",
};

/**
 * Connects Microsoft To Do with a device-code sign-in and chooses the lists shown by the To
 * Do screen and widget. Tokens stay on the controller.
 */
export function MicrosoftTodoSettings({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<MicrosoftTodoStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("common");
  const [lists, setLists] = useState<AdminTodoListsResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const apply = useCallback((next: MicrosoftTodoStatus) => {
    setStatus(next);
    setSelected(next.selectedListIds);
  }, []);

  // Screens depend on the sign-in state, so reload them when it changes.
  const state = status?.state;
  const [loadedState, setLoadedState] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (state === undefined || state === loadedState) {
      return;
    }
    if (loadedState !== undefined) {
      onChanged();
    }
    setLoadedState(state);
  }, [state, loadedState, onChanged]);

  useEffect(() => {
    void request<MicrosoftTodoStatus>(BASE)
      .then((next) => {
        setClientId(next.clientId ?? "");
        setTenant(next.tenant);
        apply(next);
      })
      .catch((reason: unknown) => {
        setMessage(reason instanceof Error ? reason.message : "Unable to load Microsoft To Do");
      });
  }, [apply]);

  // Checking the status completes a waiting sign-in on the controller.
  const pending = status?.state === "pending";
  useEffect(() => {
    if (!pending) {
      return;
    }
    const timer = window.setInterval(() => {
      void request<MicrosoftTodoStatus>(BASE)
        .then(apply)
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [pending, apply]);

  const signedIn = status?.state === "signed_in";
  useEffect(() => {
    if (!signedIn) {
      setLists(null);
      return;
    }
    void request<AdminTodoListsResponse>(`${BASE}/lists`)
      .then(setLists)
      .catch((reason: unknown) => {
        setMessage(reason instanceof Error ? reason.message : "Unable to list To Do lists");
      });
  }, [signedIn]);

  const run = async (action: () => Promise<MicrosoftTodoStatus>, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      apply(await action());
      if (done !== undefined) {
        setMessage(done);
      }
    } catch (reason: unknown) {
      setMessage(reason instanceof Error ? reason.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  if (status === null) {
    return message ? <p className="error-message">{message}</p> : <p className="hint">Loading…</p>;
  }

  const options = [
    ...(lists?.available ?? []),
    ...status.lists
      .filter((list) => !lists?.available.some((item) => item.id === list.id))
      .map((list) => ({ id: list.id, name: list.name })),
  ];
  const listStatus = new Map(status.lists.map((list) => [list.id, list]));
  const selectionChanged =
    selected.length !== status.selectedListIds.length ||
    selected.some((id) => !status.selectedListIds.includes(id));
  const settingsChanged =
    clientId.trim().toLowerCase() !== (status.clientId ?? "") || tenant.trim() !== status.tenant;

  return (
    <>
      <div>
        <span
          className={`status-dot ${
            status.state === "signed_in"
              ? "ready"
              : status.state === "reauth_required"
                ? "error"
                : ""
          }`}
        />
        <strong>{STATE_LABELS[status.state]}</strong>
        {status.account ? <span className="hint">{status.account}</span> : null}
      </div>
      <div className="rotation-editor">
        {status.state === "signed_in" || status.state === "reauth_required" ? null : (
          <div className="todo-settings">
            <label className="field">
              <span>Application (client) ID</span>
              <input
                value={clientId}
                placeholder="00000000-0000-0000-0000-000000000000"
                spellCheck={false}
                onChange={(event) => setClientId(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Tenant</span>
              <input
                value={tenant}
                spellCheck={false}
                onChange={(event) => setTenant(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || !settingsChanged}
              onClick={() =>
                void run(() =>
                  request<MicrosoftTodoStatus>(
                    `${BASE}/settings`,
                    json("PUT", { clientId, tenant }),
                  ),
                )
              }
            >
              Save app registration
            </button>
          </div>
        )}

        {status.signIn !== null ? (
          <div className="sign-in-code">
            <p>
              Open{" "}
              <a href={status.signIn.verificationUri} target="_blank" rel="noreferrer">
                {status.signIn.verificationUri}
              </a>{" "}
              and enter
            </p>
            <code>{status.signIn.userCode}</code>
            <p className="hint">
              This page finishes the sign-in automatically. The code expires at{" "}
              {new Date(status.signIn.expiresAt).toLocaleTimeString()}.
            </p>
          </div>
        ) : null}

        {status.state === "signed_in" ? (
          <>
            {lists?.error ? (
              <p className="error-message">Could not list To Do lists: {lists.error}</p>
            ) : null}
            {lists === null ? <p className="hint">Loading lists…</p> : null}
            <ul className="calendar-list">
              {options.map((list) => {
                const source = listStatus.get(list.id);
                return (
                  <li key={list.id}>
                    <label className="inline-field">
                      <input
                        type="checkbox"
                        checked={selected.includes(list.id)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, list.id]
                              : selected.filter((id) => id !== list.id),
                          )
                        }
                      />
                      <span className="calendar-name">{list.name}</span>
                    </label>
                    {source !== undefined ? (
                      <span className="hint">
                        {source.lastError ??
                          `${source.taskCount} open task${source.taskCount === 1 ? "" : "s"}`}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        <div className="editor-buttons">
          {status.state === "signed_in" ? (
            <button
              type="button"
              className="primary"
              disabled={busy || !selectionChanged}
              onClick={() =>
                void run(async () => {
                  const next = await request<MicrosoftTodoStatus>(
                    `${BASE}/lists`,
                    json("PUT", { listIds: selected }),
                  );
                  onChanged();
                  return next;
                }, "Lists saved.")
              }
            >
              Save lists
            </button>
          ) : null}
          {status.state === "signed_out" || status.state === "reauth_required" ? (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(() => request<MicrosoftTodoStatus>(`${BASE}/sign-in`, json("POST")))
              }
            >
              Sign in with Microsoft
            </button>
          ) : null}
          {status.state === "pending" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => request<MicrosoftTodoStatus>(`${BASE}/sign-in`, json("DELETE")))
              }
            >
              Cancel sign-in
            </button>
          ) : null}
          {status.state === "signed_in" || status.state === "reauth_required" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Sign out of Microsoft To Do and remove cached tasks?")) {
                  void run(() => request<MicrosoftTodoStatus>(`${BASE}/sign-out`, json("POST")));
                }
              }}
            >
              Sign out
            </button>
          ) : null}
        </div>

        <p className="hint">
          {status.state === "not_configured"
            ? "Register an app in Microsoft Entra with personal accounts and public client flows enabled, then paste its Application (client) ID. See the README for steps."
            : "Selected lists appear on the To Do screen and in the To Do list widget. Add the To Do screen to Automatic rotation to alternate it with the calendar."}
        </p>
        {message ? <p className="hint">{message}</p> : null}
        {status.lastError ? <p className="error-message">{status.lastError}</p> : null}
      </div>
    </>
  );
}
