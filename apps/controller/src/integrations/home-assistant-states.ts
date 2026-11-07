import type { HomeAssistantConfig } from "../config.js";
import { homeAssistantApiUrl } from "./home-assistant-url.js";

export interface EntitySummary {
  entityId: string;
  name: string;
  domain: string;
}

export interface EntityState {
  entityId: string;
  state: string;
  unit: string | null;
  friendlyName: string | null;
}

interface CachedEntityState {
  value: EntityState | null;
  fetchedAt: number;
  lastError: string | null;
}

type FetchImplementation = typeof fetch;

export const ENTITY_ID_PATTERN = /^[a-z_]+\.[a-z0-9_]+$/;

function normalizeState(entityId: string, payload: unknown): EntityState {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Home Assistant returned an invalid state for ${entityId}`);
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.state !== "string") {
    throw new Error(`Home Assistant state for ${entityId} is missing`);
  }
  const attributes =
    typeof record.attributes === "object" && record.attributes !== null
      ? (record.attributes as Record<string, unknown>)
      : {};
  return {
    entityId,
    state: record.state,
    unit:
      typeof attributes.unit_of_measurement === "string" ? attributes.unit_of_measurement : null,
    friendlyName: typeof attributes.friendly_name === "string" ? attributes.friendly_name : null,
  };
}

/**
 * Reads Home Assistant entity states with a per-entity cache. A failed refresh keeps
 * serving the last successful state so a Home Assistant outage does not blank screens.
 */
export class HomeAssistantStateClient {
  private readonly cache = new Map<string, CachedEntityState>();
  private readonly inFlight = new Map<string, Promise<void>>();

  public constructor(
    private readonly config: HomeAssistantConfig,
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Lists every entity Home Assistant reports, for pickers in the admin UI. */
  public async listEntities(): Promise<EntitySummary[]> {
    const response = await this.fetchImplementation(
      homeAssistantApiUrl(this.config.baseUrl, "api/states"),
      {
        headers: {
          Accept: "application/json",
          Authorization: ["Bearer", this.config.token].join(" "),
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Home Assistant state list returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("Home Assistant state list must be an array");
    }
    return payload
      .flatMap((item: unknown): EntitySummary[] => {
        if (typeof item !== "object" || item === null) {
          return [];
        }
        const record = item as Record<string, unknown>;
        if (typeof record.entity_id !== "string" || !ENTITY_ID_PATTERN.test(record.entity_id)) {
          return [];
        }
        const attributes =
          typeof record.attributes === "object" && record.attributes !== null
            ? (record.attributes as Record<string, unknown>)
            : {};
        return [
          {
            entityId: record.entity_id,
            name:
              typeof attributes.friendly_name === "string"
                ? attributes.friendly_name
                : record.entity_id,
            domain: record.entity_id.split(".")[0]!,
          },
        ];
      })
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
  }

  public async getState(entityId: string): Promise<EntityState | null> {
    if (!ENTITY_ID_PATTERN.test(entityId)) {
      return null;
    }
    const cached = this.cache.get(entityId);
    const isFresh =
      cached !== undefined &&
      this.now().getTime() - cached.fetchedAt < this.config.refreshIntervalSeconds * 1000;
    if (!isFresh) {
      await this.refresh(entityId);
    }
    return this.cache.get(entityId)?.value ?? null;
  }

  private async refresh(entityId: string): Promise<void> {
    const existing = this.inFlight.get(entityId);
    if (existing !== undefined) {
      return existing;
    }
    const request = this.fetchState(entityId).finally(() => {
      this.inFlight.delete(entityId);
    });
    this.inFlight.set(entityId, request);
    return request;
  }

  private async fetchState(entityId: string): Promise<void> {
    const previous = this.cache.get(entityId)?.value ?? null;
    const fetchedAt = this.now().getTime();
    try {
      const url = homeAssistantApiUrl(
        this.config.baseUrl,
        `api/states/${encodeURIComponent(entityId)}`,
      );
      const response = await this.fetchImplementation(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.token}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`Home Assistant state request returned HTTP ${response.status}`);
      }
      this.cache.set(entityId, {
        value: normalizeState(entityId, await response.json()),
        fetchedAt,
        lastError: null,
      });
    } catch (error: unknown) {
      this.cache.set(entityId, {
        value: previous,
        fetchedAt,
        lastError: error instanceof Error ? error.message : "Unknown Home Assistant error",
      });
    }
  }
}
