type FetchImplementation = typeof fetch;

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 100;

interface CachedResponse {
  value: unknown;
  fetchedAt: number;
}

/**
 * The `fetchJson` service for widget plugins: GET-only JSON with a timeout, size limit,
 * per-URL cache, request de-duplication, and last-good fallback after a failure.
 */
export class JsonFetchCache {
  private readonly cache = new Map<string, CachedResponse>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  public constructor(
    private readonly fetchImplementation: FetchImplementation = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async getJson(url: string, ttlSeconds = 300): Promise<unknown> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("fetchJson needs an absolute URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("fetchJson supports only http and https");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("fetchJson URLs must not contain credentials");
    }

    const key = parsed.toString();
    const ttlMs = Math.min(86_400, Math.max(30, ttlSeconds)) * 1000;
    const cached = this.cache.get(key);
    const now = this.now().getTime();
    if (cached !== undefined && now - cached.fetchedAt < ttlMs) {
      return cached.value;
    }

    let request = this.inFlight.get(key);
    if (request === undefined) {
      request = this.request(key).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, request);
    }
    try {
      const value = await request;
      this.store(key, { value, fetchedAt: now });
      return value;
    } catch (error: unknown) {
      if (cached === undefined) {
        throw error;
      }
      // Keep the last good response and wait a full interval before retrying.
      this.store(key, { value: cached.value, fetchedAt: now });
      return cached.value;
    }
  }

  private async request(url: string): Promise<unknown> {
    const response = await this.fetchImplementation(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Request returned HTTP ${response.status}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) {
      throw new Error("Response is larger than 256 KB");
    }
    return JSON.parse(text) as unknown;
  }

  private store(key: string, entry: CachedResponse): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }
}
