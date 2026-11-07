/**
 * Joins a Home Assistant base URL and an API path. Unlike `new URL(path, base)`, this keeps
 * a base path such as the Supervisor's `http://supervisor/core`.
 */
export function homeAssistantApiUrl(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}
