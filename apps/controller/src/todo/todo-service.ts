import type {
  AdminTodoListsResponse,
  MicrosoftTodoListStatus,
  MicrosoftTodoStatus,
  TodoTask,
} from "@inkboard/contracts";

import type { ArtifactService } from "../artifacts/artifact-service.js";
import { todoSvg } from "../artifacts/todo-renderer.js";
import {
  MICROSOFT_CLIENT_ID_PATTERN,
  MICROSOFT_TENANT_PATTERN,
  type ControllerConfig,
} from "../config.js";
import type { ArtifactRecord } from "../db/schema.js";
import type { SettingsStore } from "../db/settings-store.js";
import {
  GraphUnauthorizedError,
  sortTasks,
  type MicrosoftGraphTodoClient,
} from "../integrations/microsoft-graph-todo.js";
import {
  MicrosoftAuthError,
  type DeviceCodeSession,
  type MicrosoftIdentityClient,
  type TokenSet,
} from "../integrations/microsoft-identity.js";
import type { SecretBox } from "../security/secret-box.js";

const SETTINGS_KEY = "microsoftTodo.settings";
const AUTH_KEY = "microsoftTodo.auth";
const SELECTION_KEY = "microsoftTodo.selection";
const SNAPSHOT_PREFIX = "microsoftTodo.snapshot:";
export const TODO_CONTENT_KEY = "todo-v1";
export const MAX_SELECTED_LISTS = 20;
/** Refresh access tokens this long before they expire. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

interface StoredAuth {
  tokens: TokenSet;
}

interface ListSnapshot {
  name: string;
  tasks: TodoTask[];
  fetchedAt: string;
}

interface ListSource {
  snapshot: ListSnapshot | null;
  lastError: string | null;
}

export class InvalidTodoRequestError extends Error {}

/**
 * The tenant Microsoft asks for when an app supports only personal accounts (AADSTS9002346)
 * or only work and school accounts (AADSTS9002331).
 */
function requiredTenant(error: unknown): "consumers" | "organizations" | null {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("AADSTS9002346")) {
    return "consumers";
  }
  if (message.includes("AADSTS9002331")) {
    return "organizations";
  }
  return null;
}

export class TodoService {
  private clientIdSetting: string | null = null;
  private tenantSetting: string | null = null;
  private tokens: TokenSet | null = null;
  private account: string | null = null;
  private reauthRequired = false;
  private pending: (DeviceCodeSession & { nextPollAt: number }) | null = null;
  private selection: string[] = [];
  private readonly names = new Map<string, string>();
  private readonly sources = new Map<string, ListSource>();
  private refreshPromise: Promise<void> | null = null;
  /** Fetch times and in-flight fetches of lists used only by widgets. */
  private readonly extraAttempts = new Map<string, number>();
  private readonly extraRefreshes = new Map<string, Promise<void>>();
  private lastAttemptAt: string | null = null;
  private lastSuccessfulRefreshAt: string | null = null;
  private lastError: string | null = null;

  public constructor(
    private readonly config: ControllerConfig,
    private readonly artifactService: ArtifactService,
    private readonly store: SettingsStore,
    private readonly secretBox: SecretBox,
    private readonly identity: MicrosoftIdentityClient,
    private readonly graph: MicrosoftGraphTodoClient,
    private readonly now: () => Date = () => new Date(),
    private readonly onRefreshError: (error: Error) => void = () => undefined,
  ) {}

  public async initialize(): Promise<void> {
    const settings = this.store.get<{ clientId?: string; tenant?: string }>(SETTINGS_KEY);
    this.clientIdSetting = settings?.clientId ?? null;
    this.tenantSetting = settings?.tenant ?? null;

    const encrypted = this.store.get<string>(AUTH_KEY);
    const auth = encrypted === undefined ? null : this.secretBox.decrypt<StoredAuth>(encrypted);
    this.tokens = auth?.tokens ?? null;
    this.account = this.tokens?.account ?? null;
    if (encrypted !== undefined && auth === null) {
      // The key changed or the value is corrupt; a new sign-in is needed.
      this.reauthRequired = true;
      this.lastError = "Stored Microsoft sign-in could not be read. Sign in again.";
    }

    this.selection = this.store.get<{ listIds: string[] }>(SELECTION_KEY)?.listIds ?? [];
    for (const listId of this.selection) {
      this.sources.set(listId, { snapshot: this.readSnapshot(listId), lastError: null });
    }
    if (this.isAvailable()) {
      await this.refreshIfDue();
    }
  }

  private clientId(): string | null {
    return this.clientIdSetting ?? this.config.microsoftTodo.clientId;
  }

  private tenant(): string {
    return this.tenantSetting ?? this.config.microsoftTodo.tenant;
  }

  /** True when the To Do screen and widget have something to show. */
  public isAvailable(): boolean {
    return this.selection.length > 0 && (this.tokens !== null || this.reauthRequired);
  }

  public getStatus(): MicrosoftTodoStatus {
    const lists = this.selection.map((listId): MicrosoftTodoListStatus => {
      const source = this.sources.get(listId);
      return {
        id: listId,
        name: this.nameOf(listId),
        taskCount: source?.snapshot?.tasks.length ?? 0,
        lastSuccessfulRefreshAt: source?.snapshot?.fetchedAt ?? null,
        lastError: source?.lastError ?? null,
      };
    });
    const listErrors = lists.filter((list) => list.lastError !== null);
    return {
      state:
        this.clientId() === null
          ? "not_configured"
          : this.pending !== null
            ? "pending"
            : this.tokens !== null
              ? "signed_in"
              : this.reauthRequired
                ? "reauth_required"
                : "signed_out",
      clientId: this.clientId(),
      tenant: this.tenant(),
      account: this.account,
      signIn:
        this.pending === null
          ? null
          : {
              userCode: this.pending.userCode,
              verificationUri: this.pending.verificationUri,
              expiresAt: new Date(this.pending.expiresAt).toISOString(),
            },
      selectedListIds: [...this.selection],
      lists,
      taskCount: this.mergedTasks().length,
      lastSuccessfulRefreshAt: this.lastSuccessfulRefreshAt,
      lastError:
        this.lastError ??
        (listErrors.length === 0
          ? null
          : listErrors.map((list) => `${list.name}: ${list.lastError}`).join("; ")),
    };
  }

  /** Saves the app registration. Changing it signs out, since tokens belong to one app. */
  public async configure(input: {
    clientId: string;
    tenant: string;
  }): Promise<MicrosoftTodoStatus> {
    const clientId = input.clientId.trim().toLowerCase();
    const tenant = input.tenant.trim() || "common";
    if (!MICROSOFT_CLIENT_ID_PATTERN.test(clientId)) {
      throw new InvalidTodoRequestError("The Application (client) ID must be a GUID");
    }
    if (!MICROSOFT_TENANT_PATTERN.test(tenant)) {
      throw new InvalidTodoRequestError(
        "The tenant must be common, consumers, organizations, or a tenant ID",
      );
    }
    if (clientId !== this.clientId() || tenant !== this.tenant()) {
      await this.signOut();
    }
    this.clientIdSetting = clientId;
    this.tenantSetting = tenant;
    this.store.set(SETTINGS_KEY, { clientId, tenant });
    return this.getStatus();
  }

  /** Starts a device-code sign-in; the user enters the returned code at Microsoft. */
  public async startSignIn(): Promise<MicrosoftTodoStatus> {
    const clientId = this.clientId();
    if (clientId === null) {
      throw new InvalidTodoRequestError("Set the Application (client) ID first");
    }
    try {
      let session;
      try {
        session = await this.identity.startDeviceCode(clientId, this.tenant());
      } catch (error: unknown) {
        // An app registered for one kind of account rejects the `common` endpoint and names
        // the one to use; switch to it so the user does not have to.
        const tenant = this.tenant() === "common" ? requiredTenant(error) : null;
        if (tenant === null) {
          throw error;
        }
        this.tenantSetting = tenant;
        this.store.set(SETTINGS_KEY, { clientId, tenant });
        session = await this.identity.startDeviceCode(clientId, tenant);
      }
      this.pending = {
        ...session,
        nextPollAt: this.now().getTime() + session.intervalSeconds * 1000,
      };
      this.lastError = null;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unable to start sign-in";
      this.lastError = message.includes("AADSTS70002")
        ? "The app registration does not allow device sign-in. In Microsoft Entra, open the app's Authentication page, set Allow public client flows to Yes, save, and try again."
        : message;
      throw new InvalidTodoRequestError(this.lastError);
    }
    return this.getStatus();
  }

  /**
   * Checks a waiting sign-in once its polling interval has passed. The admin page calls this
   * through the status endpoint while it shows the code.
   */
  public async pollSignIn(): Promise<void> {
    const pending = this.pending;
    const clientId = this.clientId();
    if (pending === null || clientId === null) {
      return;
    }
    const now = this.now().getTime();
    if (now >= pending.expiresAt) {
      this.pending = null;
      this.lastError = "The sign-in code expired. Start the sign-in again.";
      return;
    }
    if (now < pending.nextPollAt) {
      return;
    }
    try {
      const result = await this.identity.pollDeviceCode(
        clientId,
        this.tenant(),
        pending.deviceCode,
      );
      if (result.status === "pending") {
        pending.nextPollAt = now + (pending.intervalSeconds + (result.slowDown ? 5 : 0)) * 1000;
        if (result.slowDown) {
          pending.intervalSeconds += 5;
        }
        return;
      }
      this.pending = null;
      this.lastError = null;
      this.reauthRequired = false;
      this.saveTokens(result.tokens);
      if (this.selection.length === 0) {
        await this.selectDefaultList();
      }
      this.lastAttemptAt = null;
      await this.refreshIfDue();
    } catch (error: unknown) {
      if (error instanceof MicrosoftAuthError && error.requiresSignIn) {
        this.pending = null;
        this.lastError =
          error.code === "authorization_declined"
            ? "Sign-in was declined."
            : error.code === "expired_token"
              ? "The sign-in code expired. Start the sign-in again."
              : error.message;
        return;
      }
      pending.nextPollAt = now + pending.intervalSeconds * 1000;
      this.lastError = error instanceof Error ? error.message : "Unable to complete sign-in";
    }
  }

  public cancelSignIn(): MicrosoftTodoStatus {
    this.pending = null;
    return this.getStatus();
  }

  /** Removes the tokens and cached tasks. The list selection is kept for the next sign-in. */
  public async signOut(): Promise<MicrosoftTodoStatus> {
    if (this.refreshPromise !== null) {
      await this.refreshPromise;
    }
    this.tokens = null;
    this.account = null;
    this.reauthRequired = false;
    this.pending = null;
    this.lastError = null;
    this.lastSuccessfulRefreshAt = null;
    this.lastAttemptAt = null;
    this.store.delete(AUTH_KEY);
    this.store.deletePrefix(SNAPSHOT_PREFIX);
    this.sources.clear();
    this.extraAttempts.clear();
    for (const listId of this.selection) {
      this.sources.set(listId, { snapshot: null, lastError: null });
    }
    return this.getStatus();
  }

  public async listLists(): Promise<AdminTodoListsResponse> {
    if (this.tokens === null) {
      return { available: [], selected: [...this.selection], error: "Not signed in to Microsoft" };
    }
    try {
      const lists = await this.withAccessToken((token) => this.graph.listLists(token));
      for (const list of lists) {
        this.names.set(list.id, list.name);
      }
      return { available: lists, selected: [...this.selection], error: null };
    } catch (error: unknown) {
      return {
        available: [],
        selected: [...this.selection],
        error: error instanceof Error ? error.message : "Unable to list To Do lists",
      };
    }
  }

  public async setSelection(listIds: string[]): Promise<MicrosoftTodoStatus> {
    const unique = [...new Set(listIds.map((id) => id.trim()))];
    if (unique.some((id) => id === "" || id.length > 512)) {
      throw new InvalidTodoRequestError("List IDs must be non-empty");
    }
    if (unique.length > MAX_SELECTED_LISTS) {
      throw new InvalidTodoRequestError(`Select at most ${MAX_SELECTED_LISTS} lists`);
    }
    if (this.refreshPromise !== null) {
      await this.refreshPromise;
    }
    this.selection = unique;
    this.store.set(SELECTION_KEY, { listIds: unique });
    for (const listId of unique) {
      if (!this.sources.has(listId)) {
        this.sources.set(listId, { snapshot: this.readSnapshot(listId), lastError: null });
      }
    }
    this.lastAttemptAt = null;
    if (this.isAvailable()) {
      await this.refreshIfDue();
    }
    return this.getStatus();
  }

  /** True when signed in, or when cached tasks remain after the sign-in expired. */
  public isConnected(): boolean {
    return this.tokens !== null || this.reauthRequired;
  }

  /**
   * Incomplete tasks, refreshing first when due. Without `listIds`, tasks come from the lists
   * selected on the admin page; otherwise from the given lists, which widgets may choose.
   */
  public async getTasks(listIds?: string[]): Promise<TodoTask[]> {
    const requested = [...new Set(listIds ?? [])]
      .filter((listId) => listId !== "" && listId.length <= 512)
      .slice(0, MAX_SELECTED_LISTS);
    if (requested.length === 0) {
      if (!this.isAvailable()) {
        return [];
      }
      await this.refreshIfDue();
      return this.mergedTasks();
    }
    if (!this.isConnected()) {
      return [];
    }
    if (this.selection.length > 0 && requested.some((id) => this.selection.includes(id))) {
      await this.refreshIfDue();
    }
    const now = this.now();
    await Promise.all(
      requested
        .filter((listId) => !this.selection.includes(listId))
        .map((listId) => this.refreshExtraIfDue(listId, now)),
    );
    const missing = requested.filter((listId) => !this.sources.get(listId)?.snapshot);
    if (missing.length === requested.length) {
      const errors = missing.map((listId) => this.sources.get(listId)?.lastError);
      throw new Error(errors.find((error) => error) ?? "To Do tasks are unavailable");
    }
    return sortTasks(
      requested.flatMap((listId) => this.sources.get(listId)?.snapshot?.tasks ?? []),
    );
  }

  /** Fetches a list that only widgets use, at most once per refresh interval. */
  private async refreshExtraIfDue(listId: string, now: Date): Promise<void> {
    const pending = this.extraRefreshes.get(listId);
    if (pending !== undefined) {
      return pending;
    }
    const lastAttempt = this.extraAttempts.get(listId);
    if (
      lastAttempt !== undefined &&
      now.getTime() - lastAttempt < this.config.microsoftTodo.refreshIntervalSeconds * 1000
    ) {
      return;
    }
    const run = (async () => {
      this.extraAttempts.set(listId, now.getTime());
      const source = this.sources.get(listId) ?? {
        snapshot: this.readSnapshot(listId),
        lastError: null,
      };
      this.sources.set(listId, source);
      if (this.tokens === null) {
        return;
      }
      try {
        if (!this.names.has(listId)) {
          for (const list of await this.withAccessToken((token) => this.graph.listLists(token))) {
            this.names.set(list.id, list.name);
          }
        }
        const name = this.nameOf(listId);
        const tasks = await this.withAccessToken((token) =>
          this.graph.listTasks(token, { id: listId, name }),
        );
        source.snapshot = { name, tasks, fetchedAt: now.toISOString() };
        source.lastError = null;
        this.store.set(`${SNAPSHOT_PREFIX}${listId}`, source.snapshot);
      } catch (error: unknown) {
        source.lastError = error instanceof Error ? error.message : String(error);
        this.onRefreshError(new Error(`${this.nameOf(listId)}: ${source.lastError}`));
      }
    })().finally(() => {
      this.extraRefreshes.delete(listId);
    });
    this.extraRefreshes.set(listId, run);
    return run;
  }

  public async getCurrentArtifact(): Promise<ArtifactRecord> {
    if (this.isAvailable()) {
      await this.refreshIfDue();
    }
    return (
      (await this.artifactService.getArtifactByKey(TODO_CONTENT_KEY)) ??
      this.artifactService.getOrientationArtifact()
    );
  }

  private mergedTasks(): TodoTask[] {
    return sortTasks(
      this.selection.flatMap((listId) => this.sources.get(listId)?.snapshot?.tasks ?? []),
    );
  }

  private nameOf(listId: string): string {
    return this.names.get(listId) ?? this.sources.get(listId)?.snapshot?.name ?? "To Do list";
  }

  private saveTokens(tokens: TokenSet): void {
    this.tokens = tokens;
    this.account = tokens.account;
    this.store.set(AUTH_KEY, this.secretBox.encrypt({ tokens } satisfies StoredAuth));
  }

  private markReauthRequired(message: string): void {
    this.tokens = null;
    this.reauthRequired = true;
    this.lastError = `${message} Sign in again.`;
    this.store.delete(AUTH_KEY);
  }

  private async selectDefaultList(): Promise<void> {
    try {
      const listId = await this.withAccessToken((token) => this.graph.defaultListId(token));
      if (listId !== null) {
        this.selection = [listId];
        this.sources.set(listId, { snapshot: null, lastError: null });
        this.store.set(SELECTION_KEY, { listIds: this.selection });
      }
    } catch {
      // The user can still choose lists on the admin page.
    }
  }

  /** Runs a Graph call with a valid token, refreshing once if Graph rejects it. */
  private async withAccessToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    if (this.tokens === null) {
      throw new Error("Not signed in to Microsoft");
    }
    if (this.tokens.expiresAt - TOKEN_EXPIRY_MARGIN_MS <= this.now().getTime()) {
      await this.refreshTokens();
    }
    try {
      return await call(this.tokens.accessToken);
    } catch (error: unknown) {
      if (!(error instanceof GraphUnauthorizedError)) {
        throw error;
      }
      await this.refreshTokens();
      return call(this.tokens.accessToken);
    }
  }

  private async refreshTokens(): Promise<void> {
    const clientId = this.clientId();
    if (this.tokens === null || clientId === null) {
      throw new Error("Not signed in to Microsoft");
    }
    try {
      this.saveTokens(await this.identity.refresh(clientId, this.tenant(), this.tokens));
    } catch (error: unknown) {
      if (error instanceof MicrosoftAuthError && error.requiresSignIn) {
        this.markReauthRequired("Microsoft sign-in expired or was revoked.");
      }
      throw error;
    }
  }

  private isRefreshDue(now: Date): boolean {
    return (
      this.lastAttemptAt === null ||
      now.getTime() - Date.parse(this.lastAttemptAt) >=
        this.config.microsoftTodo.refreshIntervalSeconds * 1000
    );
  }

  private async refreshIfDue(): Promise<void> {
    const now = this.now();
    if (!this.isRefreshDue(now)) {
      return;
    }
    if (this.refreshPromise !== null) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.refresh(now).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refresh(now: Date): Promise<void> {
    this.lastAttemptAt = now.toISOString();
    const selection = [...this.selection];
    let allSucceeded = this.tokens !== null;

    if (this.tokens !== null) {
      try {
        if (selection.some((listId) => !this.names.has(listId))) {
          for (const list of await this.withAccessToken((token) => this.graph.listLists(token))) {
            this.names.set(list.id, list.name);
          }
        }
        for (const listId of selection) {
          const source = this.sources.get(listId) ?? { snapshot: null, lastError: null };
          this.sources.set(listId, source);
          try {
            const name = this.nameOf(listId);
            const tasks = await this.withAccessToken((token) =>
              this.graph.listTasks(token, { id: listId, name }),
            );
            source.snapshot = { name, tasks, fetchedAt: now.toISOString() };
            source.lastError = null;
            this.store.set(`${SNAPSHOT_PREFIX}${listId}`, source.snapshot);
          } catch (error: unknown) {
            if (this.tokens === null) {
              throw error;
            }
            allSucceeded = false;
            source.lastError = error instanceof Error ? error.message : String(error);
            this.onRefreshError(new Error(`${this.nameOf(listId)}: ${source.lastError}`));
          }
        }
        if (!this.reauthRequired) {
          this.lastError = null;
        }
      } catch (error: unknown) {
        allSucceeded = false;
        if (!this.reauthRequired) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
        this.onRefreshError(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (allSucceeded) {
      this.lastSuccessfulRefreshAt = now.toISOString();
    }
    // Render the last good tasks of every list so outages keep the screen.
    if (selection.some((listId) => this.sources.get(listId)?.snapshot)) {
      try {
        const svg = todoSvg(this.mergedTasks(), {
          listNames: selection.map((listId) => this.nameOf(listId)),
          timeZone: this.config.timeZone,
          now,
        });
        await this.artifactService.persistScreenArtifact(
          TODO_CONTENT_KEY,
          await this.artifactService.rasterize(svg, "to-do"),
        );
      } catch (error: unknown) {
        this.onRefreshError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private readSnapshot(listId: string): ListSnapshot | null {
    const snapshot = this.store.get<ListSnapshot>(`${SNAPSHOT_PREFIX}${listId}`);
    return snapshot !== undefined &&
      typeof snapshot.name === "string" &&
      Array.isArray(snapshot.tasks) &&
      typeof snapshot.fetchedAt === "string"
      ? snapshot
      : null;
  }
}
